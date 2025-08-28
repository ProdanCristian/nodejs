const express = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Optional auth via headers:
// - Authorization: Bearer <MERGE_WORKER_TOKEN>
// - X-API-Key: <MERGE_WORKER_API_KEY>
function checkAuth(req, res) {
const bearer = process.env.MERGE_WORKER_TOKEN;
const apiKey = process.env.MERGE_WORKER_API_KEY;
if (bearer) {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ') || hdr.slice(7) !== bearer) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
} else if (apiKey) {
    if ((req.headers['x-api-key'] || '') !== apiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
}
return true;
}

function ffmpegBin() {
let bin = ffmpegPath || '';
if (!bin || /index.js/.test(bin)) bin = process.env.FFMPEG_PATH || 'ffmpeg';
return bin;
}
function ffprobeBin() {
let bin = (ffprobeStatic && ffprobeStatic.path) || '';
if (!bin || /index.js/.test(bin)) bin = process.env.FFPROBE_PATH || 'ffprobe';
return bin;
}
function run(cmd, args, opts = {}) {
return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, opts);
    let out = '', err = '';
    if (cp.stdout) cp.stdout.on('data', d => { out += d.toString(); });
    if (cp.stderr) cp.stderr.on('data', d => { err += d.toString(); });
    cp.on('error', reject);
    cp.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err}`)));
});
}
async function probeAudio(file) {
const args = ['-v', 'error', '-of', 'json', '-show_entries', 'stream=sample_rate,channels,bit_rate', '-select_streams',
'a:0', file];
try {
    const { out } = await run(ffprobeBin(), args);
    const j = JSON.parse(out || '{}');
    const s = (j.streams && j.streams[0]) || {};
    const sr = Number(s.sample_rate) || 44100;
    const ch = Number(s.channels) || 2;
    const br = Math.max(32, Math.min(320, Math.round((Number(s.bit_rate) || 192000) / 1000)));
    return { sample_rate: sr, channels: ch, bit_rate_k: br };
} catch {
    return { sample_rate: 44100, channels: 2, bit_rate_k: 192 };
}
}
async function probeDuration(file) {
const args = ['-v','error','-of','json','-show_entries','format=duration', file];
try {
    const { out } = await run(ffprobeBin(), args);
    const j = JSON.parse(out || '{}');
    const d = Number(j?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : 0;
} catch {
    return 0;
}
}
function buildChaptersFfmeta(durationsSec, gapSec, titles) {
const lines = [';FFMETADATA1'];
let tMs = 0;
for (let i = 0; i < durationsSec.length; i++) {
    const start = Math.round(tMs * 1000);
    const end = Math.round((tMs + durationsSec[i]) * 1000);
    const title = (titles[i] && String(titles[i]).trim()) || `Chapter ${i + 1}`;
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${start}`);
    lines.push(`END=${end}`);
    lines.push(`title=${title}`);
    tMs += durationsSec[i] + (i < durationsSec.length - 1 ? gapSec : 0);
}
return lines.join('\n') + '\n';
}

// Cloudflare R2 client (S3-compatible)
const s3 = new S3Client({
region: 'us-east-1',
endpoint: process.env.R2_ENDPOINT,
credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
},
forcePathStyle: true,
});

async function mergeChapters({ bookId, chapterAudioUrls, chapterTitles }) {
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-'));
const cleanup = [];
try {
    // 1) Download parts
    const partFiles = [];
    for (let i = 0; i < chapterAudioUrls.length; i++) {
      const url = chapterAudioUrls[i];
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const p = path.join(tmpDir, `part_${i + 1}.mp3`);
      await fs.writeFile(p, buf);
      cleanup.push(p);
      partFiles.push(p);
    }

    // 2) Probe first chapter to match gap params
    const first = await probeAudio(partFiles[0]);
    const sr = first.sample_rate, ch = first.channels, br = first.bit_rate_k;

    // 3) Generate matching silent MP3 gap (tiny encode)
    const gapMs = Number(process.env.MERGE_GAP_MS || 350);
    const gapFile = path.join(tmpDir, 'gap.mp3');
    await run(ffmpegBin(), [
      '-f', 'lavfi',
      '-t', String(gapMs / 1000),
      '-i', `anullsrc=channel_layout=${ch === 1 ? 'mono' : 'stereo'}:sample_rate=${sr}`,
      '-ar', String(sr),
      '-ac', String(ch),
      '-b:a', `${br}k`,
      gapFile
    ]);
    cleanup.push(gapFile);

    // 4) Strip metadata from parts (copy-only) to avoid mid-stream ID3 in concat
    const cleaned = [];
    for (const p of partFiles) {
      const c = p.replace(/\.mp3$/i, '.clean.mp3');
      await run(ffmpegBin(), ['-i', p, '-vn', '-map_metadata', '-1', '-c:a', 'copy', '-write_xing', '1', c]);
      cleanup.push(c);
      cleaned.push(c);
    }

    // 5) Build concat list with gaps
    const listPath = path.join(tmpDir, 'list.txt');
    const lines = [];
    cleaned.forEach((p, idx) => {
      lines.push(`file '${p.replace(/'/g, `'\\''`)}'`);
      if (idx !== cleaned.length - 1) lines.push(`file '${gapFile.replace(/'/g, `'\\''`)}'`);
    });
    await fs.writeFile(listPath, lines.join('\n'), 'utf8');
    cleanup.push(listPath);

    // 6) Concat via demuxer with -c copy + XING header
    const outPath = path.join(tmpDir, 'out.mp3');
    await run(ffmpegBin(), ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-write_xing', '1', outPath]);
    cleanup.push(outPath);

    // 7) Chapter markers: probe durations, build ffmetadata, inject (copy-only)
    const durationsSec = [];
    for (const c of cleaned) durationsSec.push(await probeDuration(c));
    const gapSec = gapMs / 1000;
    const titles = Array.isArray(chapterTitles)
      ? cleaned.map((_, i) => (chapterTitles[i] && String(chapterTitles[i]).trim()) || `Chapter ${i + 1}`)
      : cleaned.map((_, i) => `Chapter ${i + 1}`);

    const ffmetaPath = path.join(tmpDir, 'chapters.ffmeta');
    await fs.writeFile(ffmetaPath, buildChaptersFfmeta(durationsSec, gapSec, titles), 'utf8');
    cleanup.push(ffmetaPath);

    const outWithChapters = path.join(tmpDir, 'out_chapters.mp3');
    await run(ffmpegBin(), [
      '-i', outPath,
      '-i', ffmetaPath,
      '-map_metadata', '1',
      '-map_chapters', '1',
      '-codec', 'copy',
      '-write_id3v2', '1',
      '-id3v2_version', '3',
      outWithChapters
    ]);
    cleanup.push(outWithChapters);

    // 8) Upload to R2
    const bucket = process.env.R2_BUCKET || 'sellaudiobooks';
    const publicBase = process.env.R2_PUBLIC_URL;
    if (!publicBase) throw new Error('R2_PUBLIC_URL is not set');
    const fileKey = `audio/book-${bookId}-merged-${Date.now()}.mp3`;
    const body = await fs.readFile(outWithChapters);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: fileKey, Body: body, ContentType: 'audio/mpeg' }));
    const audioUrl = `${publicBase}/${fileKey}`;

    return audioUrl;
} finally {
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch {}
}
}

app.post('/merge', async (req, res) => {
if (!checkAuth(req, res)) return;

const { bookId, chapterAudioUrls, callbackUrl, chapterTitles, mode } = req.body || {};
if (!bookId || !Array.isArray(chapterAudioUrls) || chapterAudioUrls.length === 0) {
    return res.status(400).json({ error: 'bookId and chapterAudioUrls[] required' });
}

const syncMode = (mode === 'sync') || !callbackUrl;

// Sync mode: do the work inline and return { audioUrl }
if (syncMode) {
    try {
      const audioUrl = await mergeChapters({ bookId, chapterAudioUrls, chapterTitles });
      return res.json({ audioUrl });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
}

// Callback mode: respond queued, then do work and POST back
res.json({ queued: true });
(async () => {
    try {
      const audioUrl = await mergeChapters({ bookId, chapterAudioUrls, chapterTitles });
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, audioUrl })
      }).catch(() => {});
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookId, error: msg })
        }).catch(() => {});
      }
    }
})();
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
// Bind to all interfaces for Railway
app.listen(port, '0.0.0.0', () => console.log('merge worker listening on', port));
