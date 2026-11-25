import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Word } from "./captions.ts";
import { config } from "./config.ts";
import { addUsage, emptyUsage, loadUsage, type Usage } from "./usage.ts";
import { generateJson, TransientError } from "./gemini.ts";
import {
  CLIP_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildTranscriptPrompt,
  buildVideoPrompt,
  clipFromTimestamps,
  parseClipIdeas,
  resolveClip,
  selectClips,
  type ClipSettings,
  type PickedClip,
} from "./highlights.ts";
import { analyzeFaces, planCamera } from "./reframe.ts";
import { renderClip, type Framing } from "./render.ts";
import { downloadCaptions, fetchVideoInfo, isYouTubeUrl, type VideoInfo } from "./youtube.ts";

export type JobStatus = "queued" | "fetching" | "transcribing" | "picking" | "rendering" | "done" | "error";
export type ClipStatus = "pending" | "rendering" | "ready" | "failed";
export type Review = "unreviewed" | "kept" | "rejected";

export interface Clip extends PickedClip {
  readonly id: string;
  status: ClipStatus;
  review: Review;
  file?: string;
  exportedAs?: string;
  error?: string;
  framing?: Framing["mode"];
  framingNote?: string;
}

export interface Job {
  readonly id: string;
  readonly url: string;
  readonly createdAt: number;
  title?: string;
  channel?: string;
  duration?: number;
  status: JobStatus;
  message: string;
  error?: string;
  transcriptSource?: "captions" | "gemini-video";
  clips: Clip[];
  /** Gemini spend for this video, across all attempts. */
  usage?: Usage;
  /** Automatic retries used after temporary failures, and when the next one is due (ms epoch). */
  autoRetries?: number;
  retryAt?: number;
}

const ACTIVE: readonly JobStatus[] = ["fetching", "transcribing", "picking", "rendering"];

const jobsFile = () => path.join(config.dataDir, "jobs.json");
export const jobDir = (id: string) => path.join(config.dataDir, "jobs", id);

let jobs: Job[] = [];
let saveChain: Promise<void> = Promise.resolve();

function save(): Promise<void> {
  const snapshot = JSON.stringify(jobs, null, 1);
  saveChain = saveChain.then(async () => {
    const file = jobsFile();
    await writeFile(`${file}.tmp`, snapshot, "utf8");
    await rename(`${file}.tmp`, file);
  }).catch((error: unknown) => console.error("Could not save jobs:", error));
  return saveChain;
}

function update(job: Job, changes: Partial<Job>): void {
  Object.assign(job, changes);
  void save();
}

/**
 * Put a job interrupted by a restart back in the queue. Clips Gemini already picked are kept
 * (so the paid AI call isn't repeated); a clip that was mid-render goes back to pending.
 */
export function resetInterrupted(job: Job): void {
  if (!ACTIVE.includes(job.status)) return;
  for (const clip of job.clips) {
    if (clip.status === "rendering") clip.status = "pending";
  }
  Object.assign(job, {
    status: "queued",
    message: job.clips.length ? "Waiting (resuming after restart)" : "Waiting (restarted)",
  });
}

export async function loadJobs(): Promise<void> {
  await mkdir(path.join(config.dataDir, "jobs"), { recursive: true });
  await mkdir(config.outputDir, { recursive: true });
  await loadUsage();
  try {
    jobs = JSON.parse(await readFile(jobsFile(), "utf8")) as Job[];
  } catch {
    jobs = [];
  }
  jobs.forEach(resetInterrupted);
  await save();
  void pump();
}

export function listJobs(): readonly Job[] {
  return jobs;
}

export function addJobs(urls: readonly string[]): Job[] {
  const added = urls.map(
    (url): Job => ({ id: randomUUID().slice(0, 8), url, createdAt: Date.now(), status: "queued", message: "Waiting", clips: [] }),
  );
  jobs.push(...added);
  void save();
  void pump();
  return added;
}

/** "Redo": start over from scratch, including a fresh Gemini pick. */
export function retryJob(id: string): boolean {
  const job = jobs.find((j) => j.id === id);
  if (!job || ACTIVE.includes(job.status)) return false;
  update(job, { status: "queued", message: "Waiting", error: undefined, clips: [], autoRetries: 0, retryAt: undefined });
  void pump();
  return true;
}

export async function deleteJob(id: string): Promise<boolean> {
  const index = jobs.findIndex((j) => j.id === id);
  if (index < 0) return false;
  cancel(id);
  jobs.splice(index, 1);
  await save();
  await rm(jobDir(id), { recursive: true, force: true }).catch(() => undefined);
  return true;
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "clip";
}

/** Keep copies the clip into the output folder; reject removes that copy. */
export async function reviewClip(jobId: string, clipId: string, review: Review): Promise<Clip | undefined> {
  const job = jobs.find((j) => j.id === jobId);
  const clip = job?.clips.find((c) => c.id === clipId);
  if (!job || !clip) return undefined;
  if (review === "kept" && clip.file && !clip.exportedAs) {
    const name = `${safeName(job.title ?? job.id)} - ${safeName(clip.title)} [${job.id}-${clip.id}].mp4`;
    await copyFile(path.join(jobDir(job.id), clip.file), path.join(config.outputDir, name));
    clip.exportedAs = name;
  }
  if (review !== "kept" && clip.exportedAs) {
    await rm(path.join(config.outputDir, clip.exportedAs), { force: true });
    clip.exportedAs = undefined;
  }
  clip.review = review;
  await save();
  return clip;
}

/* ------------------------------------------------------------------ *
 * Scheduler: two stages so the network-bound part of the next video
 * overlaps the CPU-bound rendering of the current one.
 *   prepare: video info, captions, Gemini picks   (one job at a time)
 *   render:  face tracking + ffmpeg per clip      (one job at a time)
 * At most one prepared job waits for the renderer, so picks stay fresh
 * and a cancelled queue doesn't waste many Gemini calls.
 * ------------------------------------------------------------------ */

/** Waits before automatically retrying a job that hit a temporary problem (Gemini busy, network drop). */
export const AUTO_RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000];

interface Prepared {
  readonly job: Job;
  readonly controller: AbortController;
  readonly info: VideoInfo;
  readonly words?: Word[];
}

let preparing: { id: string; controller: AbortController } | undefined;
let rendering: { id: string; controller: AbortController } | undefined;
const waitingToRender: Prepared[] = [];
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

/** The next job to prepare: queued and not waiting for an automatic retry. */
export function nextRunnable(list: readonly Job[], now: number): Job | undefined {
  return list.find((j) => j.status === "queued" && (j.retryAt ?? 0) <= now);
}

function cancel(id: string): void {
  if (preparing?.id === id) preparing.controller.abort();
  if (rendering?.id === id) rendering.controller.abort();
  const index = waitingToRender.findIndex((p) => p.job.id === id);
  if (index >= 0) waitingToRender.splice(index, 1)[0].controller.abort();
}

function pump(): void {
  // Start rendering first so a freed renderer is never idle while a prepared job waits.
  if (!rendering && waitingToRender.length) {
    const next = waitingToRender.shift()!;
    rendering = { id: next.job.id, controller: next.controller };
    void runStage(next.job, next.controller, () => renderStage(next), () => (rendering = undefined));
  }
  if (preparing || waitingToRender.length) return;

  const job = nextRunnable(jobs, Date.now());
  if (!job) {
    // Jobs waiting to retry: wake up when the first one is due.
    const due = jobs.filter((j) => j.status === "queued" && j.retryAt).map((j) => j.retryAt!);
    if (due.length) {
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(pump, Math.max(1000, Math.min(...due) - Date.now()));
    }
    return;
  }
  const controller = new AbortController();
  preparing = { id: job.id, controller };
  void runStage(
    job,
    controller,
    async () => {
      const prepared = await prepareStage(job, controller);
      if (!controller.signal.aborted) waitingToRender.push(prepared);
    },
    () => (preparing = undefined),
  );
}

async function runStage(job: Job, controller: AbortController, work: () => Promise<void>, done: () => void): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (!controller.signal.aborted) fail(job, error);
  } finally {
    done();
    pump();
  }
}

function fail(job: Job, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const tries = job.autoRetries ?? 0;
  if (error instanceof TransientError && tries < AUTO_RETRY_DELAYS_MS.length) {
    const wait = AUTO_RETRY_DELAYS_MS[tries];
    update(job, {
      status: "queued",
      autoRetries: tries + 1,
      retryAt: Date.now() + wait,
      clips: [],
      error: undefined,
      message: `${message} Retrying automatically in ${Math.round(wait / 60_000)} min (${tries + 1}/${AUTO_RETRY_DELAYS_MS.length}).`,
    });
  } else {
    update(job, { status: "error", message: "Failed", error: message, retryAt: undefined });
  }
}

function addJobUsage(job: Job, usage: Usage): void {
  job.usage ??= emptyUsage();
  addUsage(job.usage, usage);
  void save();
}

const exists = (file: string) => access(file).then(() => true, () => false);

/** Video info, transcript and Gemini picks. Reuses picks and transcript when resuming. */
async function prepareStage(job: Job, controller: AbortController): Promise<Prepared> {
  const signal = controller.signal;
  const dir = jobDir(job.id);
  const resuming = job.clips.length > 0;
  if (!resuming) await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  update(job, { status: "fetching", message: "Reading video info" });
  const info = await fetchVideoInfo(job.url, signal);
  update(job, { title: info.title, channel: info.channel, duration: info.duration });

  const transcriptFile = path.join(dir, "transcript.json");
  let words: Word[] | undefined;
  if (resuming && (await exists(transcriptFile))) {
    words = JSON.parse(await readFile(transcriptFile, "utf8")) as Word[];
  } else if (info.subtitleTrack && !(resuming && job.transcriptSource === "gemini-video")) {
    update(job, { status: "transcribing", message: `Downloading captions (${info.subtitleTrack.lang})` });
    try {
      words = await downloadCaptions(job.url, info.subtitleTrack, dir, signal);
      await writeFile(transcriptFile, JSON.stringify(words), "utf8");
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(`[${job.id}] captions failed, falling back to Gemini video:`, error);
    }
  }

  if (!resuming) {
    const picked = await pickClips(job, info, words, signal);
    if (!picked.length) throw new Error("Gemini did not find any usable clips.");
    job.clips = picked.map((clip, index) => ({ ...clip, id: String(index + 1), status: "pending", review: "unreviewed" }));
  }
  const left = job.clips.filter((c) => c.status !== "ready").length;
  update(job, {
    status: "rendering",
    message: rendering ? `${left} clip${left === 1 ? "" : "s"} picked, waiting for the renderer` : "Starting render",
  });
  return { job, controller, info, ...(words ? { words } : {}) };
}

async function pickClips(job: Job, info: VideoInfo, words: Word[] | undefined, signal: AbortSignal): Promise<PickedClip[]> {
  const settings: ClipSettings = {
    count: config.clipsPerVideo,
    minSeconds: config.minClipSeconds,
    maxSeconds: config.maxClipSeconds,
  };
  // Ask for a couple of spare ideas so overlaps/rejects still leave enough clips.
  const askSettings = { ...settings, count: settings.count + 2 };
  if (words && words.length > 30) {
    const transcript = words;
    update(job, { status: "picking", message: "Gemini is reading the transcript", transcriptSource: "captions" });
    const json = await generateJson({
      parts: [{ text: buildTranscriptPrompt(transcript, info, askSettings) }],
      schema: CLIP_SCHEMA,
      systemInstruction: SYSTEM_INSTRUCTION,
      onUsage: (usage) => addJobUsage(job, usage),
      signal,
    });
    return selectClips(
      parseClipIdeas(json).flatMap((idea) => resolveClip(idea, transcript, settings, info.duration) ?? []),
      settings.count,
    );
  }
  if (!isYouTubeUrl(job.url)) throw new Error("This video has no captions, and only YouTube videos can be sent to Gemini directly.");
  update(job, { status: "picking", message: "No captions — Gemini is watching the video", transcriptSource: "gemini-video" });
  const json = await generateJson({
    parts: [{ file_data: { file_uri: job.url } }, { text: buildVideoPrompt(info, askSettings) }],
    schema: CLIP_SCHEMA,
    systemInstruction: SYSTEM_INSTRUCTION,
    onUsage: (usage) => addJobUsage(job, usage),
    lowMediaResolution: true,
    signal,
  });
  return selectClips(
    parseClipIdeas(json).flatMap((idea) => clipFromTimestamps(idea, settings, info.duration) ?? []),
    settings.count,
  );
}

/** Decide how to turn the landscape source into 9:16 for one clip. Never throws (except on cancel). */
async function chooseFraming(
  info: VideoInfo,
  clip: Clip,
  dir: string,
  signal: AbortSignal,
): Promise<{ framing: Framing; note?: string }> {
  if (config.reframe !== "auto") return { framing: { mode: config.reframe } };
  if (!info.width || !info.height) return { framing: { mode: "center" }, note: "Unknown video size" };
  const cropWidth = Math.min(1, (info.height * 9) / 16 / info.width);
  if (cropWidth >= 0.98) return { framing: { mode: "center" } };
  try {
    const samples = await analyzeFaces(info.analysis, info.width / info.height, clip.start, clip.end, signal);
    await writeFile(path.join(dir, `clip-${clip.id}.faces.json`), JSON.stringify(samples), "utf8");
    const plan = planCamera(samples, cropWidth);
    if (plan.mode === "track") {
      return { framing: { mode: "track", keys: plan.keys, sourceWidth: info.width, sourceHeight: info.height } };
    }
    return { framing: { mode: plan.mode }, ...(plan.mode === "fit" ? { note: "No faces found" } : {}) };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[clip ${clip.id}] face tracking failed, using centre crop:`, message);
    return { framing: { mode: "center" }, note: `Face tracking unavailable: ${message.slice(0, 200)}` };
  }
}

/** Render every clip that isn't already done. Finished files from an earlier run are kept. */
async function renderStage(prepared: Prepared): Promise<void> {
  const { job, controller, words } = prepared;
  let { info } = prepared;
  const signal = controller.signal;
  const dir = jobDir(job.id);
  const clips = job.clips;

  for (const [index, clip] of clips.entries()) {
    const fileName = `clip-${clip.id}.mp4`;
    if (clip.status === "ready" && clip.file && (await exists(path.join(dir, clip.file)))) continue;
    clip.status = "rendering";
    update(job, { status: "rendering", message: `Clip ${index + 1} of ${clips.length}: finding faces` });
    const { framing, note } = await chooseFraming(info, clip, dir, signal);
    Object.assign(clip, { framing: framing.mode, framingNote: note });
    update(job, { message: `Clip ${index + 1} of ${clips.length}: rendering` });
    const attempt = () =>
      renderClip({ video: info.video, audio: info.audio, start: clip.start, end: clip.end, words, framing, dir, fileName, signal });
    try {
      try {
        await attempt();
      } catch (error) {
        if (signal.aborted) throw error;
        // Stream URLs expire or get rejected; fetch fresh ones and try once more.
        info = await fetchVideoInfo(job.url, signal);
        await attempt();
      }
      Object.assign(clip, { status: "ready", file: fileName, error: undefined });
    } catch (error) {
      if (signal.aborted) throw error;
      Object.assign(clip, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    await save();
  }

  const ready = clips.filter((c) => c.status === "ready").length;
  if (!ready) throw new Error(`All clips failed to render. First error: ${clips[0]?.error ?? "unknown"}`);
  update(job, { status: "done", message: `${ready} clip${ready === 1 ? "" : "s"} ready`, autoRetries: 0, retryAt: undefined });
}
