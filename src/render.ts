import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isSoundTag, type Word } from "./captions.ts";
import { config } from "./config.ts";
import { disableEncoder, pickEncoder } from "./encoder.ts";
import { encoderArgs, type EncoderName } from "./encoder-setting.ts";
import { run } from "./exec.ts";
import { buildCropCommands, type CameraKey } from "./reframe.ts";
import type { StreamInput } from "./youtube.ts";

const MAX_WORDS_PER_LINE = 3;
const MAX_GAP_SECONDS = 0.6;
const HIGHLIGHT = "&H0000E5FF&"; // ASS colours are &HBBGGRR -> warm yellow
const WHITE = "&H00FFFFFF&";

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

function clean(text: string): string {
  return text
    .replace(/[{}\\]/g, "")
    .replace(/[.,;:"“”]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/** Split words into short caption groups, breaking on pauses and sentence ends. */
export function groupCaptionWords(words: readonly Word[]): Word[][] {
  const groups: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    const previous = current.at(-1);
    const pause = previous ? word.start - previous.end > MAX_GAP_SECONDS : false;
    if (current.length && (current.length >= MAX_WORDS_PER_LINE || pause)) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    if (/[.!?]$/.test(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Build an ASS subtitle file for one clip: big centred words, current word highlighted.
 * Word times are shifted so the clip starts at 0.
 */
export function buildAss(words: readonly Word[], clipStart: number, clipEnd: number, width: number, height: number): string {
  const inClip = words
    .filter((w) => w.end > clipStart && w.start < clipEnd && !isSoundTag(w.text) && clean(w.text))
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipEnd, w.end) - clipStart,
    }));
  const fontSize = Math.round(height * 0.058);
  const outline = Math.max(2, Math.round(height * 0.004));
  const marginV = Math.round(height * 0.28);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial Black,${fontSize},${WHITE},${WHITE},&H00000000&,&H80000000&,-1,0,0,0,100,100,0,0,1,${outline},1,2,${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];
  const groups = groupCaptionWords(inClip);
  groups.forEach((group, groupIndex) => {
    const nextGroup = groups[groupIndex + 1];
    // Keep the line on screen until the next one starts if the gap is short.
    const groupEnd =
      nextGroup && nextGroup[0].start - group.at(-1)!.end < 0.4 ? nextGroup[0].start : group.at(-1)!.end;
    group.forEach((word, wordIndex) => {
      const start = word.start;
      const end = wordIndex + 1 < group.length ? group[wordIndex + 1].start : groupEnd;
      if (end <= start) return;
      const text = group
        .map((w, i) => (i === wordIndex ? `{\\1c${HIGHLIGHT}}${clean(w.text)}{\\1c${WHITE}}` : clean(w.text)))
        .join(" ");
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
    });
  });
  return [...header, ...events, ""].join("\n");
}

function headerArgs(input: StreamInput): string[] {
  const headers = Object.entries(input.headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("");
  return [
    ...(headers ? ["-headers", headers] : []),
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
  ];
}

export type Framing =
  | { readonly mode: "center" }
  | { readonly mode: "fit" }
  | {
      readonly mode: "track";
      readonly keys: readonly CameraKey[];
      readonly sourceWidth: number;
      readonly sourceHeight: number;
    };

export interface RenderJob {
  readonly video: StreamInput;
  readonly audio?: StreamInput;
  readonly start: number;
  readonly end: number;
  readonly words?: readonly Word[];
  readonly framing: Framing;
  /** Directory to write into; file names are relative to it. */
  readonly dir: string;
  readonly fileName: string;
  readonly signal?: AbortSignal;
}

const FPS = 30;
const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/** Build the video filter graph ([0:v] -> [v]) for the chosen framing. Writes helper files into dir. */
async function buildVideoFilter(job: RenderJob): Promise<string> {
  const { outputWidth: w, outputHeight: h } = config;
  const duration = job.end - job.start;
  const base = job.fileName.replace(/\.mp4$/, "");
  let graph: string;

  if (job.framing.mode === "track") {
    const { sourceWidth: sw, sourceHeight: sh, keys } = job.framing;
    const cropW = even(Math.min(sw, (sh * 9) / 16));
    const cropH = even(Math.min(sh, (sw * 16) / 9));
    const { initialX, script } = buildCropCommands(keys, duration, FPS, sw, cropW);
    await writeFile(path.join(job.dir, `${base}.cmd`), script, "utf8");
    // fps first so sendcmd timing matches output frames; sendcmd moves the crop window.
    graph =
      `[0:v]fps=${FPS},sendcmd=f=${base}.cmd,` +
      `crop@rf=w=${cropW}:h=${cropH}:x=${initialX}:y=${Math.floor((sh - cropH) / 2)},` +
      `scale=${w}:${h}:flags=lanczos,setsar=1`;
  } else if (job.framing.mode === "fit") {
    // Whole frame in the middle, blurred zoomed copy behind it (blur done small = cheap).
    const bw = even(w / 8);
    const bh = even(h / 8);
    graph =
      `[0:v]fps=${FPS},split=2[bg][fg];` +
      `[bg]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4:2,` +
      `scale=${w}:${h},eq=brightness=-0.12[bgb];` +
      `[fg]scale=${w}:-2:flags=lanczos[fgs];` +
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  } else {
    graph = `[0:v]fps=${FPS},crop=w=min(iw\\,ih*9/16):h=min(ih\\,iw*16/9),scale=${w}:${h}:flags=lanczos,setsar=1`;
  }

  if (config.burnCaptions && job.words?.length) {
    const assName = `${base}.ass`;
    await writeFile(path.join(job.dir, assName), buildAss(job.words, job.start, job.end, w, h), "utf8");
    // Relative path (ffmpeg runs in job.dir) avoids Windows drive-letter escaping in the filter.
    graph += `,subtitles=${assName}`;
  }
  return `${graph}[v]`;
}

/**
 * Cut, reframe to 9:16, add captions and encode one clip. Streams only the needed part
 * of the YouTube video (ffmpeg seeks with HTTP range requests), so a 60s clip from a
 * 1-hour video downloads ~60s of data.
 */
export async function renderClip(job: RenderJob): Promise<void> {
  const filterGraph = await buildVideoFilter(job);
  const encoder = await pickEncoder();
  try {
    await run(config.ffmpeg, renderArgs(job, filterGraph, encoder), { cwd: job.dir, signal: job.signal });
  } catch (error) {
    if (job.signal?.aborted || encoder === "libx264") throw error;
    // Hardware encoder failed: try the CPU encoder once. If that works, the hardware path was the problem.
    await run(config.ffmpeg, renderArgs(job, filterGraph, "libx264"), { cwd: job.dir, signal: job.signal });
    disableEncoder(encoder);
  }
}

export function renderArgs(job: RenderJob, filterGraph: string, encoder: EncoderName): string[] {
  const duration = job.end - job.start;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    ...headerArgs(job.video), "-ss", job.start.toFixed(3), "-i", job.video.url,
  ];
  if (job.audio) {
    args.push(...headerArgs(job.audio), "-ss", job.start.toFixed(3), "-i", job.audio.url);
  }
  args.push(
    "-t", duration.toFixed(3),
    "-filter_complex", filterGraph,
    "-map", "[v]",
    "-map", job.audio ? "1:a:0" : "0:a:0?",
    ...encoderArgs(encoder),
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-movflags", "+faststart",
    job.fileName,
  );
  return args;
}
