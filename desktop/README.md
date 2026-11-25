# oukos clip — Windows Desktop App

A standalone Windows desktop application wrapping the **oukos-clip** AI video clipping pipeline in an Electron shell.

Paste YouTube links → get vertical 9:16 short clips with burned-in word-level captions ready for TikTok, YouTube Shorts, and Instagram Reels.

---

## Features of the Desktop Version

- **Native Windows Window**: Clean frameless window with a dark custom title bar matching the app theme.
- **GUI Settings Dialog**: Replace manual `.env` file editing with an in-app Settings modal (Gemini API key, model selection, clip durations, resolution, reframing mode).
- **System Tray Integration**: Minimize to the Windows notification area; keeps rendering in the background and can be restored anytime.
- **Native Notifications**: Windows toast notifications notify you when clips are rendered and ready for review.
- **Folder Picker & Explorer Integration**: Choose your output directory via Windows folder selector dialog; one-click "Open folder in File Explorer" button.
- **External Browser Integration**: YouTube links and documentation open in your default Windows browser (not stuck inside the app window).

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Electron Main Process                │
│ (desktop/main.js - Window, Tray, Notifications, IPC)  │
└─────────────────────────┬──────────────────────────────┘
                          │
       ┌──────────────────┴──────────────────┐
       ▼                                     ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│       Renderer Process       │   │    Backend Node Process      │
│  (public/index.html & UI)    │   │ (Electron's Node / backend/) │
│  Communicates via preload.js │   │ Spawned on random local port │
│  and REST API on localhost   │   │ Runs yt-dlp, ffmpeg, Gemini  │
└──────────────────────────────┘   └──────────────────────────────┘
```

- **Nothing to install for users**: no Node.js, Python, FFmpeg or yt-dlp needed. The backend runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`), FFmpeg and yt-dlp are bundled, and face tracking uses `onnxruntime-node` instead of Python.
- **Generated backend**: `scripts/build-backend.mjs` strips the TypeScript types from `../src/*.ts` into `backend/` (Electron's Node 20 can't run `.ts`). Edit `../src`, never `backend/`.
- **Self-updating yt-dlp**: on launch the bundled yt-dlp is copied to `%APPDATA%\oukos-clip-desktop\bin\` and updated there in the background (YouTube changes often).
- **Zero Port Collisions**: Electron picks a free ephemeral port on startup and binds the backend dynamically.
- **Persistent User Data**: User settings and jobs state are stored safely in `%APPDATA%\oukos-clip-desktop\`, ensuring updates don't wipe data.

---

## Quick Start (Development)

### Prerequisites

Developer machine only (end users need none of this):

1. **Node.js 22.13+** - used once per build to generate `backend/`.
2. `desktop/bin/ffmpeg.exe` and `desktop/bin/yt-dlp.exe` (see `bin/README.md`). If they're missing, the app falls back to `ffmpeg` / `yt-dlp` on PATH.

### Running in Dev Mode

```sh
cd desktop
npm install
npm start
```

The Electron desktop window will open, launch the local backend runner, connect, and display the interface.

---

## Building a Standalone Windows Installer

To build an installer (`.exe`) that end users can install without configuring anything:

### 1. (Optional) Bundle Standalone Binaries
For a completely standalone installer where users do not need to install `ffmpeg` or `yt-dlp`:
1. Download `ffmpeg.exe` and place it in `desktop/bin/ffmpeg.exe`.
2. Download `yt-dlp.exe` and place it in `desktop/bin/yt-dlp.exe`.

### 2. Run the Build Command

```sh
cd desktop
npm run build
```

This will run `electron-builder` and produce:
- A setup installer in `desktop/dist/oukos clip Setup 0.1.0.exe`
- Standalone unpacked files in `desktop/dist/win-unpacked/`

### Before selling it

- **Code signing**: without a Windows code-signing certificate, users get an "Unknown publisher" SmartScreen warning.
- **FFmpeg licence**: the bundled FFmpeg is a GPL build (it includes x264). Shipping it in a commercial app carries GPL obligations - get legal advice, or switch to an LGPL build with a different H.264 encoder.
- **Icon**: `assets/icon.ico` is a placeholder.

---

## Configuration & Settings

Settings can be changed anytime via the **⚙ Settings** button in the top-right header:

| Setting | Default | Description |
|---|---|---|
| `Gemini API Key` | *(Empty)* | Your Google Gemini API Key from Google AI Studio |
| `Gemini Model` | `gemini-flash-latest` | Model to use for highlight detection |
| `Clips per video` | `5` | Maximum number of clips to produce |
| `Min / Max seconds` | `20 / 75` | Target clip duration boundaries |
| `Output resolution` | `720×1280` | `1280` = 720×1280 (Fast), `1920` = 1080×1920 |
| `Burn Captions` | `true` | Burn word-by-word animated ASS captions |
| `Reframe Mode` | `auto` | `auto` (face tracking), `center` (center crop), `fit` (blurred background) |
| `Output Folder` | Default (`%APPDATA%` or `./output`) | Where kept clips are exported |

Saving settings automatically restarts the backend with the new configuration.
