# Merge Worker for SellAudioBooks

A Node.js worker service that merges multiple audio chapters into a single MP3 file with chapter markers, designed to be deployed on Railway.

## Features

- Merges multiple MP3 files into a single audiobook
- Adds configurable gaps between chapters
- Injects ID3 chapter markers for navigation
- Uploads to Cloudflare R2
- Callbacks to notify completion
- Optional authentication (Bearer token or API key)
- Low CPU usage (uses ffmpeg copy codec)

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set environment variables** (see .env.example)

3. **Run:**
   ```bash
   npm start
   ```

## Railway Deployment

1. Connect this GitHub repo to Railway
2. Set environment variables (from .env.example)
3. Deploy - Railway auto-injects PORT

## API Endpoints

### POST /merge
Merges audio chapters into a single file.

**Request:**
```json
{
  "bookId": "book123",
  "chapterAudioUrls": ["url1", "url2"],
  "chapterTitles": ["Chapter 1", "Chapter 2"],
  "callbackUrl": "https://your-app.com/webhook"
}
```

### GET /health
Health check endpoint.

## Environment Variables

See `.env.example` for all required and optional environment variables.

## Testing

```bash
curl -X POST https://your-app.railway.app/merge \
  -H "Content-Type: application/json" \
  --data '{
    "bookId": "test",
    "chapterAudioUrls": ["url1", "url2"],
    "callbackUrl": "https://webhook.site/YOUR-ID"
  }'
```