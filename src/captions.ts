/** A single spoken word with timings in seconds from the start of the video. */
export interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface Json3Seg {
  readonly utf8?: string;
  readonly tOffsetMs?: number;
}

interface Json3Event {
  readonly tStartMs?: number;
  readonly dDurationMs?: number;
  readonly segs?: readonly Json3Seg[];
}

interface RawWord {
  text: string;
  start: number;
  eventEnd: number;
}

const MIN_WORD_SECONDS = 0.05;

function splitWords(text: string): string[] {
  return text
    .replace(/&gt;&gt;|>>|^-\s/g, " ") // ">>" / "- " mark a change of speaker in YouTube captions
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Spread words across a time range, weighting by word length. */
function spreadWords(text: string, start: number, end: number): RawWord[] {
  const parts = splitWords(text);
  if (!parts.length) return [];
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const span = Math.max(end - start, MIN_WORD_SECONDS * parts.length);
  const words: RawWord[] = [];
  let cursor = start;
  for (const part of parts) {
    words.push({ text: part, start: cursor, eventEnd: end });
    cursor += (span * (part.length + 1)) / total;
  }
  return words;
}

/**
 * Parse YouTube's json3 caption format into timed words.
 * Auto-generated captions carry a time offset per word; manual captions only
 * have one timing per line, so their words are spread across the line.
 */
export function parseJson3(json: unknown): Word[] {
  const events = (json as { events?: unknown })?.events;
  if (!Array.isArray(events)) throw new Error("Caption file has no events.");

  const raw: RawWord[] = [];
  for (const event of events as Json3Event[]) {
    if (!event?.segs?.length) continue;
    const eventStart = (event.tStartMs ?? 0) / 1000;
    const eventEnd = eventStart + (event.dDurationMs ?? 0) / 1000;
    const segs = event.segs.filter((seg) => seg.utf8 && seg.utf8.trim());
    if (!segs.length) continue;

    const hasWordOffsets = segs.some((seg) => seg.tOffsetMs !== undefined) || segs.length > 1;
    if (!hasWordOffsets) {
      raw.push(...spreadWords(segs[0].utf8 ?? "", eventStart, eventEnd));
      continue;
    }
    segs.forEach((seg, index) => {
      const segStart = eventStart + (seg.tOffsetMs ?? 0) / 1000;
      const next = segs[index + 1];
      const segEnd = next ? eventStart + (next.tOffsetMs ?? 0) / 1000 : eventEnd;
      raw.push(...spreadWords(seg.utf8 ?? "", segStart, Math.max(segEnd, segStart)));
    });
  }

  raw.sort((a, b) => a.start - b.start);
  return raw.map((word, index) => {
    const next = raw[index + 1];
    let end = Math.min(word.eventEnd, next ? next.start : word.eventEnd);
    if (!(end > word.start)) end = word.start + MIN_WORD_SECONDS;
    return { text: word.text, start: round(word.start), end: round(end) };
  });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Words like "[Music]" or "(Laughter)" are sound tags, not speech. */
export function isSoundTag(text: string): boolean {
  return /^(\[.*\]|\(.*\))[.,!?]*$/.test(text.trim());
}
