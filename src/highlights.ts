import type { Word } from "./captions.ts";
import { isSoundTag } from "./captions.ts";

export interface ClipSettings {
  readonly count: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

/** What Gemini proposes. Timestamps are hints; word matches win when available. */
export interface ClipIdea {
  readonly title: string;
  readonly reason: string;
  readonly score: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly firstWords: string;
  readonly lastWords: string;
}

export interface PickedClip {
  readonly title: string;
  readonly reason: string;
  readonly score: number;
  readonly start: number;
  readonly end: number;
}

const START_PAD = 0.15;
const END_PAD = 0.4;

export const CLIP_SCHEMA = {
  type: "OBJECT",
  properties: {
    clips: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Catchy title for the short, max 60 characters." },
          reason: { type: "STRING", description: "One sentence: why this works as a short." },
          score: { type: "NUMBER", description: "Viral potential from 1 to 10." },
          start_seconds: { type: "NUMBER" },
          end_seconds: { type: "NUMBER" },
          first_words: { type: "STRING", description: "The first 6-8 words of the clip, copied exactly." },
          last_words: { type: "STRING", description: "The last 6-8 words of the clip, copied exactly." },
        },
        required: ["title", "reason", "score", "start_seconds", "end_seconds", "first_words", "last_words"],
      },
    },
  },
  required: ["clips"],
} as const;

export const SYSTEM_INSTRUCTION =
  "You are an expert short-form video editor for TikTok, YouTube Shorts and Instagram Reels. " +
  "You find the moments in long videos that make people stop scrolling and watch to the end.";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** Group words into timestamped lines (~8s each) so Gemini can see timing without per-word noise. */
export function formatTranscript(words: readonly Word[], lineSeconds = 8): string {
  const lines: string[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (!current.length) return;
    lines.push(`[${current[0].start.toFixed(1)}s ${clock(current[0].start)}] ${current.map((w) => w.text).join(" ")}`);
    current = [];
  };
  for (const word of words) {
    if (isSoundTag(word.text)) continue;
    if (current.length && word.start - current[0].start >= lineSeconds) flush();
    current.push(word);
  }
  flush();
  return lines.join("\n");
}

function rules(settings: ClipSettings): string[] {
  return [
    `Pick the ${settings.count} best moments to turn into vertical short videos.`,
    `Each clip must be between ${settings.minSeconds} and ${settings.maxSeconds} seconds long.`,
    "Each clip must:",
    "- open with a strong hook in the first 3 seconds (a bold claim, a question, a surprising fact, conflict or emotion);",
    "- make sense on its own to someone who has not seen the rest of the video;",
    "- start at the beginning of a sentence and end after a complete thought or punchline, never mid-sentence;",
    "- not overlap with another clip.",
    "Prefer: insights, stories with a payoff, strong opinions, funny moments, emotional peaks, practical tips.",
    "Avoid: intros, outros, sponsor reads, 'like and subscribe', small talk, and moments that depend on visuals you cannot see.",
    "Score each clip 1-10 for how likely it is to perform well, and order clips best first.",
  ];
}

export function buildTranscriptPrompt(
  words: readonly Word[],
  meta: { title: string; channel: string },
  settings: ClipSettings,
): string {
  return [
    `Video title: ${meta.title}`,
    meta.channel ? `Channel: ${meta.channel}` : "",
    "",
    "Transcript (each line starts with its time in seconds):",
    formatTranscript(words),
    "",
    ...rules(settings),
    "For start_seconds/end_seconds use the transcript times.",
    "first_words and last_words must be copied exactly from the transcript (same words, same order).",
  ].join("\n");
}

export function buildVideoPrompt(meta: { title: string; duration: number }, settings: ClipSettings): string {
  return [
    `Video title: ${meta.title}`,
    `Video length: ${Math.round(meta.duration)} seconds.`,
    "Watch and listen to the whole video.",
    "",
    ...rules(settings),
    "start_seconds/end_seconds are times in the video in seconds.",
    "first_words and last_words are the first and last words spoken in the clip.",
  ].join("\n");
}

export function parseClipIdeas(json: unknown): ClipIdea[] {
  const clips = (json as { clips?: unknown })?.clips;
  if (!Array.isArray(clips)) throw new Error("Gemini's answer has no clips list.");
  return clips.flatMap((raw): ClipIdea[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const c = raw as Record<string, unknown>;
    const startSeconds = Number(c.start_seconds);
    const endSeconds = Number(c.end_seconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return [];
    return [
      {
        title: String(c.title ?? "").trim() || "Untitled clip",
        reason: String(c.reason ?? "").trim(),
        score: Number.isFinite(Number(c.score)) ? Number(c.score) : 5,
        startSeconds,
        endSeconds,
        firstWords: String(c.first_words ?? ""),
        lastWords: String(c.last_words ?? ""),
      },
    ];
  });
}

function token(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function tokens(value: string): string[] {
  return value.split(/\s+/).map(token).filter(Boolean);
}

/**
 * Find where `phrase` occurs in `wordTokens`, trying shorter sub-phrases if the full one
 * doesn't match. Returns the index of the first (or last, if `fromEnd`) matched word,
 * choosing the occurrence closest to `hintSeconds`.
 */
function findPhrase(
  words: readonly Word[],
  wordTokens: readonly string[],
  phrase: string,
  hintSeconds: number,
  fromEnd: boolean,
  minIndex = 0,
): number | undefined {
  const target = tokens(phrase);
  const sizes = [...new Set([8, 6, 4, 3, 2].map((size) => Math.min(size, target.length)))];
  for (const n of sizes) {
    if (n < 2 && target.length > 1) continue;
    if (n < 1) break;
    const needle = fromEnd ? target.slice(-n) : target.slice(0, n);
    let best: { index: number; distance: number } | undefined;
    for (let i = minIndex; i <= wordTokens.length - n; i++) {
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (wordTokens[i + k] !== needle[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const index = fromEnd ? i + n - 1 : i;
      const distance = Math.abs(words[index].start - hintSeconds);
      if (!best || distance < best.distance) best = { index, distance };
    }
    // Only trust a match reasonably near Gemini's timestamp hint.
    if (best && best.distance < 120) return best.index;
  }
  return undefined;
}

function nearestIndex(words: readonly Word[], seconds: number, minIndex = 0): number {
  let best = minIndex;
  for (let i = minIndex; i < words.length; i++) {
    if (Math.abs(words[i].start - seconds) < Math.abs(words[best].start - seconds)) best = i;
  }
  return best;
}

/** Turn a clip idea into exact start/end times snapped to spoken words. */
export function resolveClip(
  idea: ClipIdea,
  words: readonly Word[],
  settings: ClipSettings,
  videoDuration: number,
): PickedClip | undefined {
  const speech = words.filter((w) => !isSoundTag(w.text));
  if (!speech.length) return undefined;
  const wordTokens = speech.map((w) => token(w.text));

  const startIndex =
    findPhrase(speech, wordTokens, idea.firstWords, idea.startSeconds, false) ??
    nearestIndex(speech, idea.startSeconds);
  let endIndex =
    findPhrase(speech, wordTokens, idea.lastWords, idea.endSeconds, true, startIndex) ??
    nearestIndex(speech, idea.endSeconds, startIndex);

  // Too long: cut back to the last word that fits.
  while (endIndex > startIndex && speech[endIndex].end - speech[startIndex].start > settings.maxSeconds) {
    endIndex--;
  }
  const start = Math.max(0, speech[startIndex].start - START_PAD);
  const end = Math.min(videoDuration || Infinity, speech[endIndex].end + END_PAD);
  if (end - start < settings.minSeconds * 0.75) return undefined;
  return { title: idea.title, reason: idea.reason, score: idea.score, start: round(start), end: round(end) };
}

/** Use Gemini's timestamps directly (no transcript available). */
export function clipFromTimestamps(
  idea: ClipIdea,
  settings: ClipSettings,
  videoDuration: number,
): PickedClip | undefined {
  const start = Math.max(0, idea.startSeconds);
  let end = Math.min(videoDuration || Infinity, idea.endSeconds);
  if (end - start > settings.maxSeconds) end = start + settings.maxSeconds;
  if (end - start < settings.minSeconds * 0.75) return undefined;
  return { title: idea.title, reason: idea.reason, score: idea.score, start: round(start), end: round(end) };
}

/** Keep the best-scored clips, dropping any that overlap a better one. */
export function selectClips(clips: readonly PickedClip[], count: number): PickedClip[] {
  const chosen: PickedClip[] = [];
  for (const clip of [...clips].sort((a, b) => b.score - a.score)) {
    const overlaps = chosen.some((c) => Math.min(c.end, clip.end) - Math.max(c.start, clip.start) > 1);
    if (!overlaps) chosen.push(clip);
    if (chosen.length >= count) break;
  }
  return chosen;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
