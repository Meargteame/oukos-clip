# oukos clip

Local batch clipper. Paste YouTube links → get vertical 9:16 shorts with captions for TikTok, YouTube Shorts and Instagram Reels.

## How it works

For each link:

1. **Info** – `yt-dlp` reads the title, length, stream URLs and available captions (no download).
2. **Transcript** – downloads YouTube's own captions (a few KB). No Whisper, no GPU needed.
   If a video has no captions, Gemini watches the YouTube video directly instead (clips then have no burned-in captions).
3. **Pick** – Gemini reads the transcript and picks the best moments; times are snapped to the exact spoken words.
4. **Render** – `ffmpeg` streams *only those seconds* of the video, crops to 9:16, burns in word-by-word captions, and encodes an MP4.
5. **Review** – watch each clip in the browser, **Keep** or **Reject**. Kept clips are copied to `output/`.

Videos are processed one at a time in the background; the queue survives restarts.

## Setup (once)

```sh
winget install Gyan.FFmpeg
winget install yt-dlp.yt-dlp
```

Close and reopen your terminal afterwards so they're on PATH.

Create a `.env` file (copy `.env.example`) and put your Gemini key in it — get one at https://aistudio.google.com/apikey:

```
GEMINI_API_KEY=your-key-here
```

Requires Node.js 23.6+ (runs TypeScript directly, no build step, no npm packages).

## Run

### Option 1: Desktop App (Windows)
```sh
cd desktop
npm install
npm start
```
See [desktop/README.md](desktop/README.md) for details on packaging a standalone Windows installer.

### Option 2: Browser / Local Server
```sh
npm start
```

Open http://localhost:4321.

## Settings

All optional, in `.env` — see `.env.example`. The useful ones:

| Setting | Default | |
|---|---|---|
| `CLIPS_PER_VIDEO` | 5 | |
| `MIN_CLIP_SECONDS` / `MAX_CLIP_SECONDS` | 20 / 75 | |
| `OUTPUT_HEIGHT` | 1280 | 1280 = 720×1280 (fast). 1920 = 1080×1920 (~2× slower to render) |
| `GEMINI_MODEL` | gemini-flash-latest | |
| `BURN_CAPTIONS` | true | |

## Files

- `src/server.ts` – local web server + API
- `src/jobs.ts` – queue and pipeline
- `src/youtube.ts`, `src/captions.ts` – yt-dlp and caption parsing
- `src/highlights.ts`, `src/gemini.ts` – clip picking
- `src/render.ts` – captions (ASS) + ffmpeg
- `public/` – the UI
- `data/` – job state and rendered clips (git-ignored)
- `output/` – clips you kept (git-ignored)

`npm test` runs the tests.
