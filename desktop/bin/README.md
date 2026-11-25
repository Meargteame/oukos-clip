# External tool binaries

Place these standalone Windows executables here for bundling into the standalone installer:

- `ffmpeg.exe` — download from https://www.gyan.dev/ffmpeg/builds/ (release-essentials build)
- `yt-dlp.exe` — download from https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
(Python is not needed: face tracking runs in the app via onnxruntime-node.)

### How this works:
- **In Development**: When running `npm start` in `desktop/`, the app automatically looks for `ffmpeg`, `yt-dlp`, and `python` on your system `PATH`.
- **In Packaged Distribution**: When built with `npm run build`, electron-builder packages these binaries from `desktop/bin/` into `process.resourcesPath/bin/`, making the app completely standalone without requiring the user to run winget or configure PATH.
