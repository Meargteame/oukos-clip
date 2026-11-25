import path from "node:path";
import { encoderSetting } from "./encoder-setting.ts";

// APP_ROOT is set by the desktop app (folder holding public/, models/, tools/).
const root = (process.env.APP_ROOT ?? "").trim() || path.resolve(import.meta.dirname, "..");

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}").`);
  }
  return value;
}

function even(value: number): number {
  return Math.round(value / 2) * 2;
}

const outputHeight = even(num("OUTPUT_HEIGHT", 1280));

export const config = {
  root,
  port: num("PORT", 4321),
  geminiApiKey: (process.env.GEMINI_API_KEY ?? "").trim(),
  geminiModel: (process.env.GEMINI_MODEL ?? "").trim() || "gemini-flash-latest",
  /** Tried when the main model is overloaded. Comma-separated; models the key can't use are skipped. */
  geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.7-flash,gemini-3.6-flash")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean),
  /** Gemini "thinking" level: low (default: fast, cheap), high, or "default" to let the model decide. */
  geminiThinking: ((t) => (t === "default" ? "" : t || "low"))((process.env.GEMINI_THINKING ?? "").trim().toLowerCase()),
  /** USD per million tokens. Defaults are placeholders - set your model's real prices in .env. */
  geminiInputPricePerM: num("GEMINI_INPUT_PRICE_PER_M", 0.3),
  geminiOutputPricePerM: num("GEMINI_OUTPUT_PRICE_PER_M", 2.5),
  clipsPerVideo: Math.round(num("CLIPS_PER_VIDEO", 5)),
  minClipSeconds: num("MIN_CLIP_SECONDS", 20),
  maxClipSeconds: num("MAX_CLIP_SECONDS", 75),
  outputHeight,
  outputWidth: even((outputHeight * 9) / 16),
  maxSourceHeight: Math.round(num("MAX_SOURCE_HEIGHT", 1080)),
  captionLanguage: (process.env.CAPTION_LANGUAGE ?? "").trim(),
  burnCaptions: (process.env.BURN_CAPTIONS ?? "true").trim().toLowerCase() !== "false",
  /** auto = follow faces/speaker (falls back to fit when there are no faces); center; fit. */
  reframe: (["auto", "center", "fit"] as const).find((m) => m === (process.env.REFRAME ?? "").trim().toLowerCase()) ?? "auto",
  python: (process.env.PYTHON_PATH ?? "").trim() || "python",
  /** Path to the onnxruntime-node package. When it loads, face detection runs in Node (no Python needed). */
  ortPath: (process.env.ORT_PATH ?? "").trim(),
  faceModel: path.join(root, "models", "face_detection_yunet_2023mar.onnx"),
  ytDlp: (process.env.YTDLP_PATH ?? "").trim() || "yt-dlp",
  ffmpeg: (process.env.FFMPEG_PATH ?? "").trim() || "ffmpeg",
  /** auto = first working hardware encoder (NVENC, QuickSync, AMF), else x264. Or force: x264, qsv, nvenc, amf. */
  encoder: encoderSetting(process.env.ENCODER ?? ""),
  dataDir: (process.env.DATA_DIR ?? "").trim() || path.join(root, "data"),
  outputDir: (process.env.OUTPUT_DIR ?? "").trim() || path.join(root, "output"),
  publicDir: (process.env.PUBLIC_DIR ?? "").trim() || path.join(root, "public"),
};

export type Config = typeof config;
