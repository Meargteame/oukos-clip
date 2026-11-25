import { spawn } from "node:child_process";
import path from "node:path";
import { config } from "./config.ts";
import { analyzeFramesFromFfmpeg, onnxAvailable } from "./faces.ts";
import type { StreamInput } from "./youtube.ts";

/* ------------------------------------------------------------------ *
 * Face analysis (ffmpeg -> tools/faces.py)
 * ------------------------------------------------------------------ */

export interface Face {
  /** Normalised 0..1 box (left, top, width, height) and detector score. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly s: number;
  /** Mouth motion vs the previous sample; higher = more likely talking. */
  readonly m: number;
}

export interface Sample {
  readonly t: number;
  /** Mean frame difference vs previous sample (0-255); large = scene cut. */
  readonly cut: number;
  readonly faces: readonly Face[];
}

export const ANALYSIS_FPS = 5;
const ANALYSIS_WIDTH = 640;

/**
 * Stream a low-res copy of [start, end] through the face detector.
 * Only video is read, at ~360p, so this costs a few MB per clip.
 */
export function analyzeFaces(
  input: StreamInput,
  aspect: number,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Sample[]> {
  const width = ANALYSIS_WIDTH;
  // Never taller than the 640x640 detector input (portrait sources get letterboxed by scale).
  const height = Math.min(ANALYSIS_WIDTH, Math.max(2, Math.round(width / (aspect || 16 / 9) / 2) * 2));
  const headers = Object.entries(input.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  const ffmpegArgs = [
    "-hide_banner", "-loglevel", "error",
    ...(headers ? ["-headers", headers] : []),
    "-ss", start.toFixed(3), "-i", input.url,
    "-t", (end - start).toFixed(3),
    "-an", "-vf", `fps=${ANALYSIS_FPS},scale=${width}:${height}`,
    "-pix_fmt", "bgr24", "-f", "rawvideo", "-",
  ];

  // Prefer the in-process ONNX detector (bundled with the desktop app); fall back to Python + OpenCV.
  if (onnxAvailable()) return analyzeFramesFromFfmpeg(ffmpegArgs, width, height, ANALYSIS_FPS, signal);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(config.ffmpeg, ffmpegArgs, { windowsHide: true });
    const python = spawn(
      config.python,
      [
        path.join(config.root, "tools", "faces.py"),
        "--width", String(width),
        "--height", String(height),
        "--fps", String(ANALYSIS_FPS),
        "--model", config.faceModel,
      ],
      { windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      ffmpeg.kill();
      python.kill();
      reject(error);
    };
    const onAbort = () => fail(new Error("Cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });

    ffmpeg.stdout.pipe(python.stdin);
    python.stdin.on("error", () => undefined); // python exiting early closes the pipe
    ffmpeg.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    python.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    python.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));

    const notFound = (name: string) => (error: NodeJS.ErrnoException) =>
      fail(error.code === "ENOENT" ? new Error(`"${name}" is not installed or not on PATH.`) : error);
    ffmpeg.on("error", notFound(config.ffmpeg));
    python.on("error", notFound(config.python));
    ffmpeg.on("close", (code) => {
      if (code !== 0 && !failed) fail(new Error(`ffmpeg (face analysis) failed: ${stderr.trim().slice(-400)}`));
    });
    python.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (failed) return;
      if (code !== 0) return fail(new Error(`Face analysis failed: ${stderr.trim().slice(-400)}`));
      try {
        resolve((JSON.parse(stdout) as { samples: Sample[] }).samples);
      } catch {
        fail(new Error("Face analysis returned invalid output."));
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Camera planning (pure, unit-tested)
 * ------------------------------------------------------------------ */

export interface CameraKey {
  readonly t: number;
  /** Horizontal centre of the crop, 0..1 of source width. */
  readonly cx: number;
  /** True when the camera should cut here instead of panning from the previous key. */
  readonly jump: boolean;
}

export type CameraPlan =
  | { readonly mode: "track"; readonly keys: readonly CameraKey[] }
  | { readonly mode: "fit" }
  | { readonly mode: "center" };

const CUT_THRESHOLD = 35;
const MIN_SCORE = 0.6;
// Faces narrower than this (game characters, crowds, people in the background) aren't worth following.
const MIN_FACE_WIDTH = 0.045;
const MIN_FACE_COVERAGE = 0.3;
const SPEAKER_WINDOW = 3; // samples either side (~0.6s at 5fps)
const SWITCH_SAMPLES = 5; // a new speaker must win for ~1s before we cut to them
const LOCK_FRACTION = 0.3; // movement under 30% of crop width -> locked-off shot
const SMOOTH_WINDOW = 7;

interface Tracked {
  readonly track: number;
  readonly cx: number;
  readonly left: number;
  readonly right: number;
  readonly area: number;
  readonly m: number;
}

function usable(faces: readonly Face[]): Face[] {
  return faces.filter((f) => f.s >= MIN_SCORE && f.w >= MIN_FACE_WIDTH);
}

/** Split sample indices into shots at scene cuts. */
export function splitShots(samples: readonly Sample[]): number[][] {
  const shots: number[][] = [];
  samples.forEach((sample, i) => {
    if (i === 0 || sample.cut > CUT_THRESHOLD) shots.push([]);
    shots.at(-1)!.push(i);
  });
  return shots;
}

/** Give faces stable track ids within a shot by nearest-position matching. */
function trackFaces(samples: readonly Sample[], shot: readonly number[]): Map<number, Tracked[]> {
  const result = new Map<number, Tracked[]>();
  const tracks: { id: number; cx: number; cy: number; lastSeen: number }[] = [];
  let nextId = 0;
  for (const i of shot) {
    const taken = new Set<number>();
    const tracked: Tracked[] = [];
    for (const face of usable(samples[i].faces).sort((a, b) => b.w * b.h - a.w * a.h)) {
      const cx = face.x + face.w / 2;
      const cy = face.y + face.h / 2;
      let best: (typeof tracks)[number] | undefined;
      for (const t of tracks) {
        if (taken.has(t.id) || Math.abs(t.cx - cx) > 0.1 || Math.abs(t.cy - cy) > 0.15) continue;
        if (!best || Math.abs(t.cx - cx) < Math.abs(best.cx - cx)) best = t;
      }
      if (!best) {
        best = { id: nextId++, cx, cy, lastSeen: i };
        tracks.push(best);
      }
      Object.assign(best, { cx, cy, lastSeen: i });
      taken.add(best.id);
      tracked.push({ track: best.id, cx, left: face.x, right: face.x + face.w, area: face.w * face.h, m: face.m });
    }
    result.set(i, tracked);
  }
  return result;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Decide what the camera looks at in each sample of one shot. Returns centre x per sample (or undefined). */
function chooseTargets(samples: readonly Sample[], shot: readonly number[], cropWidth: number): (number | undefined)[] {
  const tracked = trackFaces(samples, shot);
  const talk = (track: number, pos: number): number => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, pos - SPEAKER_WINDOW); k <= Math.min(shot.length - 1, pos + SPEAKER_WINDOW); k++) {
      const face = tracked.get(shot[k])!.find((f) => f.track === track);
      if (face) {
        sum += face.m;
        n++;
      }
    }
    return n ? sum / n : 0;
  };

  let current: number | undefined;
  let challenger: number | undefined;
  let challengerRun = 0;
  return shot.map((i, pos) => {
    const faces = tracked.get(i)!;
    if (!faces.length) return undefined;

    // Everyone fits in the vertical frame together: frame the group.
    const left = Math.min(...faces.map((f) => f.left));
    const right = Math.max(...faces.map((f) => f.right));
    if (right - left <= cropWidth * 0.85) {
      current = undefined;
      return (left + right) / 2;
    }

    // Otherwise follow whoever is talking, with hysteresis so we don't flicker.
    const scored = faces.map((f) => ({ face: f, talk: talk(f.track, pos) }));
    const loudest = scored.reduce((a, b) => (b.talk > a.talk ? b : a));
    const quiet = loudest.talk < 0.8;
    const best = quiet ? scored.reduce((a, b) => (b.face.area > a.face.area ? b : a)) : loudest;
    const currentFace = scored.find((s) => s.face.track === current);

    if (!currentFace) {
      current = best.face.track;
      challengerRun = 0;
    } else if (best.face.track !== current && !quiet && best.talk > currentFace.talk * 1.4 + 0.3) {
      challengerRun = challenger === best.face.track ? challengerRun + 1 : 1;
      challenger = best.face.track;
      if (challengerRun >= SWITCH_SAMPLES) {
        current = best.face.track;
        challengerRun = 0;
      }
    } else {
      challengerRun = 0;
    }
    return scored.find((s) => s.face.track === current)!.face.cx;
  });
}

function fillGaps(values: readonly (number | undefined)[]): number[] | undefined {
  const firstKnown = values.find((v) => v !== undefined);
  if (firstKnown === undefined) return undefined;
  let last = firstKnown;
  return values.map((v) => (last = v ?? last));
}

/** Smooth a run of positions like a camera operator: lock off if it barely moves, else glide. */
function smoothRun(values: readonly number[], cropWidth: number): number[] {
  if (Math.max(...values) - Math.min(...values) <= cropWidth * LOCK_FRACTION) {
    const m = median(values);
    return values.map(() => m);
  }
  const half = Math.floor(SMOOTH_WINDOW / 2);
  const medianed = values.map((_, i) => median(values.slice(Math.max(0, i - 2), i + 3)));
  return medianed.map((_, i) => {
    const window = medianed.slice(Math.max(0, i - half), i + half + 1);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
}

/**
 * Plan the virtual camera for a clip.
 * @param cropWidth width of the 9:16 crop as a fraction of source width (0.316 for 16:9).
 */
export function planCamera(samples: readonly Sample[], cropWidth: number): CameraPlan {
  if (cropWidth >= 0.98 || !samples.length) return { mode: "center" };
  const withFaces = samples.filter((s) => usable(s.faces).length).length;
  if (withFaces / samples.length < MIN_FACE_COVERAGE) return { mode: "fit" };

  const keys: CameraKey[] = [];
  let previousShotCenter = 0.5;
  for (const shot of splitShots(samples)) {
    const targets = chooseTargets(samples, shot, cropWidth);
    const filled = fillGaps(targets) ?? shot.map(() => previousShotCenter);

    // Split the shot into runs wherever the subject jumps (speaker switch) and smooth each run.
    const runs: number[][] = [[]];
    filled.forEach((value, k) => {
      if (k > 0 && Math.abs(value - filled[k - 1]) > cropWidth * 0.5) runs.push([]);
      runs.at(-1)!.push(value);
    });
    let k = 0;
    for (const run of runs) {
      smoothRun(run, cropWidth).forEach((cx, r) => {
        keys.push({ t: samples[shot[k]].t, cx: round(cx), jump: r === 0 });
        k++;
      });
    }
    previousShotCenter = keys.at(-1)!.cx;
  }
  return { mode: "track", keys };
}

/* ------------------------------------------------------------------ *
 * ffmpeg crop commands
 * ------------------------------------------------------------------ */

/** Crop centre at time t: linear between keys, but cuts (not pans) into jump keys. */
export function cameraAt(keys: readonly CameraKey[], t: number): number {
  if (t <= keys[0].t) return keys[0].cx;
  for (let i = 1; i < keys.length; i++) {
    const next = keys[i];
    if (t < next.t) {
      const prev = keys[i - 1];
      if (next.jump) return prev.cx;
      return prev.cx + ((next.cx - prev.cx) * (t - prev.t)) / (next.t - prev.t);
    }
  }
  return keys.at(-1)!.cx;
}

/**
 * Build an ffmpeg `sendcmd` script that moves `crop@rf` to follow the plan.
 * x is in source pixels; one command per output frame where the value changes.
 */
export function buildCropCommands(
  keys: readonly CameraKey[],
  duration: number,
  fps: number,
  sourceWidth: number,
  cropPixels: number,
): { initialX: number; script: string } {
  const toX = (cx: number) => Math.round(Math.min(Math.max(cx * sourceWidth - cropPixels / 2, 0), sourceWidth - cropPixels));
  const initialX = toX(cameraAt(keys, 0));
  const lines: string[] = [];
  let last = initialX;
  const frames = Math.ceil(duration * fps);
  for (let f = 1; f <= frames; f++) {
    const t = f / fps;
    const x = toX(cameraAt(keys, t));
    if (x !== last) {
      lines.push(`${t.toFixed(3)} crop@rf x ${x};`);
      last = x;
    }
  }
  return { initialX, script: lines.join("\n") + "\n" };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
