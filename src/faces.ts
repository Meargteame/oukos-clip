/**
 * Face + speaking-motion analysis in Node using ONNX Runtime and the YuNet model.
 * Same output as tools/faces.py, but needs no Python (used by the desktop app).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { config } from "./config.ts";
import type { Face, Sample } from "./reframe.ts";

const SIZE = 640; // the YuNet model has a fixed 640x640 input
const SCORE_THRESHOLD = 0.6;
const NMS_THRESHOLD = 0.3;
const CUT_RESET = 35;

/** A raw detection in frame pixels. kps = 5 landmarks (x,y): right eye, left eye, nose, right mouth, left mouth. */
export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  kps: number[];
}

interface OrtTensor {
  readonly data: Float32Array;
}
interface OrtSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface Ort {
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(path: string, options?: unknown): Promise<OrtSession> };
}

let ortModule: Ort | null | undefined;
function loadOrt(): Ort | null {
  if (ortModule !== undefined) return ortModule;
  try {
    const require = createRequire(import.meta.url);
    ortModule = require(config.ortPath || "onnxruntime-node") as Ort;
  } catch {
    ortModule = null;
  }
  return ortModule;
}

/** True when onnxruntime-node can be loaded (bundled with the desktop app). */
export function onnxAvailable(): boolean {
  return loadOrt() !== null;
}

let sessionPromise: Promise<OrtSession> | undefined;
function getSession(): Promise<OrtSession> {
  const ort = loadOrt();
  if (!ort) return Promise.reject(new Error("onnxruntime-node is not available."));
  sessionPromise ??= ort.InferenceSession.create(config.faceModel);
  return sessionPromise;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Decode YuNet's per-stride outputs into boxes (same maths as OpenCV's FaceDetectorYN), then NMS. */
export function decodeYuNet(outputs: Record<string, { data: ArrayLike<number> }>, inputSize = SIZE): Detection[] {
  const found: Detection[] = [];
  for (const stride of [8, 16, 32]) {
    const cols = inputSize / stride;
    const cls = outputs[`cls_${stride}`].data;
    const obj = outputs[`obj_${stride}`].data;
    const bbox = outputs[`bbox_${stride}`].data;
    const kps = outputs[`kps_${stride}`].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < SCORE_THRESHOLD) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = (col + bbox[i * 4]) * stride;
      const cy = (row + bbox[i * 4 + 1]) * stride;
      const w = Math.exp(bbox[i * 4 + 2]) * stride;
      const h = Math.exp(bbox[i * 4 + 3]) * stride;
      const points: number[] = [];
      for (let n = 0; n < 5; n++) {
        points.push((kps[i * 10 + 2 * n] + col) * stride, (kps[i * 10 + 2 * n + 1] + row) * stride);
      }
      found.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, kps: points });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const det of found) {
    if (kept.every((k) => iou(k, det) <= NMS_THRESHOLD)) kept.push(det);
    if (kept.length >= 20) break;
  }
  return kept;
}

/** BGR24 frame -> planar float32 BGR tensor data, padded with zeros to SIZE x SIZE. */
function toTensorData(frame: Buffer, width: number, height: number): Float32Array {
  const data = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let y = 0; y < Math.min(height, SIZE); y++) {
    for (let x = 0; x < Math.min(width, SIZE); x++) {
      const src = (y * width + x) * 3;
      const dst = y * SIZE + x;
      data[dst] = frame[src];
      data[plane + dst] = frame[src + 1];
      data[2 * plane + dst] = frame[src + 2];
    }
  }
  return data;
}

function toGray(frame: Buffer, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.114 * frame[i * 3] + 0.587 * frame[i * 3 + 1] + 0.299 * frame[i * 3 + 2];
  }
  return gray;
}

/** Area-average a region of a gray image into outW x outH. Returns undefined if the region is too small. */
export function resizeRegion(
  gray: Float32Array,
  width: number,
  height: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  outW: number,
  outH: number,
): Float32Array | undefined {
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(width, Math.floor(rx + rw));
  const y1 = Math.min(height, Math.floor(ry + rh));
  if (x1 - x0 < 4 || y1 - y0 < 4) return undefined;
  const out = new Float32Array(outW * outH);
  const sx = (x1 - x0) / outW;
  const sy = (y1 - y0) / outH;
  for (let oy = 0; oy < outH; oy++) {
    const ya = y0 + Math.floor(oy * sy);
    const yb = Math.max(ya + 1, y0 + Math.floor((oy + 1) * sy));
    for (let ox = 0; ox < outW; ox++) {
      const xa = x0 + Math.floor(ox * sx);
      const xb = Math.max(xa + 1, x0 + Math.floor((ox + 1) * sx));
      let sum = 0;
      let n = 0;
      for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) {
          sum += gray[y * width + x];
          n++;
        }
      }
      out[oy * outW + ox] = sum / n;
    }
  }
  return out;
}

function meanAbsDiff(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

interface Tracked {
  box: { x: number; y: number; w: number; h: number };
  mouth?: Float32Array;
  face?: Float32Array;
}

/**
 * Turns a stream of BGR24 frames into Samples. Stateful (mouth motion and cuts are
 * measured against the previous frame), so feed frames in order.
 */
export class FaceAnalyzer {
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;
  private index = 0;
  private prevSmall: Float32Array | undefined;
  private prevFaces: Tracked[] = [];

  constructor(width: number, height: number, fps: number) {
    this.width = width;
    this.height = height;
    this.fps = fps;
  }

  async analyze(frame: Buffer, session: OrtSession, ort: Ort): Promise<Sample> {
    const { width: w, height: h } = this;
    const gray = toGray(frame, w, h);
    const small = resizeRegion(gray, w, h, 0, 0, w, h, 64, 36)!;
    const cut = this.prevSmall ? meanAbsDiff(small, this.prevSmall) : 0;
    this.prevSmall = small;
    if (cut > CUT_RESET) this.prevFaces = [];

    const tensor = new ort.Tensor("float32", toTensorData(frame, w, h), [1, 3, SIZE, SIZE]);
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    const detections = decodeYuNet(outputs);

    const faces: Face[] = [];
    const current: Tracked[] = [];
    for (const det of detections) {
      const [, , , , , , mrx, mry, mlx, mly] = det.kps;
      const mouthCx = (mrx + mlx) / 2;
      const mouthCy = (mry + mly) / 2;
      const mouthW = Math.max(Math.abs(mlx - mrx) * 1.6, det.w * 0.35);
      const mouth = resizeRegion(gray, w, h, mouthCx - mouthW / 2, mouthCy - det.h * 0.12, mouthW, det.h * 0.32, 32, 20);
      const face = resizeRegion(gray, w, h, det.x, det.y, det.w, det.h, 32, 32);

      let motion = 0;
      let best: Tracked | undefined;
      for (const prev of this.prevFaces) if (!best || iou(prev.box, det) > iou(best.box, det)) best = prev;
      if (best && iou(best.box, det) > 0.3 && mouth && best.mouth) {
        const mouthDiff = meanAbsDiff(mouth, best.mouth);
        const faceDiff = face && best.face ? meanAbsDiff(face, best.face) : 0;
        // Subtract whole-face change so head turns / lighting don't count as talking.
        motion = Math.max(0, mouthDiff - 0.6 * faceDiff);
      }
      current.push({ box: { x: det.x, y: det.y, w: det.w, h: det.h }, mouth, face });
      faces.push({
        x: round(det.x / w, 4),
        y: round(det.y / h, 4),
        w: round(det.w / w, 4),
        h: round(det.h / h, 4),
        s: round(det.score, 3),
        m: round(motion, 2),
      });
    }
    this.prevFaces = current;
    return { t: round(this.index++ / this.fps, 3), cut: round(cut, 2), faces };
  }
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Run ffmpeg (args must output bgr24 rawvideo of width x height to stdout) and analyse every frame.
 * Frames are processed as they arrive; the stream is paused while inference runs.
 */
export async function analyzeFramesFromFfmpeg(
  ffmpegArgs: readonly string[],
  width: number,
  height: number,
  fps: number,
  signal?: AbortSignal,
): Promise<Sample[]> {
  const ort = loadOrt();
  if (!ort) throw new Error("onnxruntime-node is not available.");
  const session = await getSession();
  const analyzer = new FaceAnalyzer(width, height, fps);
  const frameSize = width * height * 3;

  const ffmpeg = spawn(config.ffmpeg, ffmpegArgs, { windowsHide: true });
  const onAbort = () => ffmpeg.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  ffmpeg.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const exited = new Promise<number | null>((resolve, reject) => {
    ffmpeg.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Error(`"${config.ffmpeg}" is not installed or not on PATH.`) : error),
    );
    ffmpeg.on("close", resolve);
  });

  const samples: Sample[] = [];
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of ffmpeg.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameSize) {
        const frame = pending.subarray(0, frameSize);
        pending = pending.subarray(frameSize);
        samples.push(await analyzer.analyze(Buffer.from(frame), session, ort));
      }
    }
    const code = await exited;
    if (signal?.aborted) throw new Error("Cancelled.");
    if (code !== 0) throw new Error(`ffmpeg (face analysis) failed: ${stderr.trim().slice(-400)}`);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ffmpeg.kill();
  }
  return samples;
}
