import assert from "node:assert/strict";
import { test } from "node:test";
import type { Word } from "../src/captions.ts";
import {
  buildTranscriptPrompt,
  clipFromTimestamps,
  formatTranscript,
  parseClipIdeas,
  resolveClip,
  selectClips,
  type ClipIdea,
} from "../src/highlights.ts";

/** One word per second: "w0 w1 w2 ..." with a few real words planted. */
function makeWords(count: number, planted: Record<number, string> = {}): Word[] {
  return Array.from({ length: count }, (_, i) => ({ text: planted[i] ?? `w${i}`, start: i, end: i + 0.8 }));
}

const settings = { count: 3, minSeconds: 20, maxSeconds: 60 };

const idea = (overrides: Partial<ClipIdea>): ClipIdea => ({
  title: "T",
  reason: "R",
  score: 8,
  startSeconds: 0,
  endSeconds: 30,
  firstWords: "",
  lastWords: "",
  ...overrides,
});

test("snaps a clip to the quoted first and last words, not Gemini's timestamps", () => {
  const words = makeWords(200, { 100: "Here's", 101: "the", 102: "secret", 140: "never", 141: "quit." });
  const clip = resolveClip(
    idea({ startSeconds: 97, endSeconds: 145, firstWords: "here's the secret", lastWords: "never quit" }),
    words,
    settings,
    200,
  );
  assert.ok(clip);
  assert.equal(clip.start, 99.85); // word 100 minus padding
  assert.equal(clip.end, 142.2); // word 141 end (141.8) plus padding
});

test("falls back to the nearest word when quotes don't match", () => {
  const words = makeWords(200);
  const clip = resolveClip(idea({ startSeconds: 50.4, endSeconds: 80.2, firstWords: "nope nope nope" }), words, settings, 200);
  assert.ok(clip);
  assert.equal(clip.start, 49.85);
  assert.equal(clip.end, 81.2); // word 80 ends at 80.8, plus padding
});

test("trims clips longer than the max and drops ones that are too short", () => {
  const words = makeWords(300);
  const long = resolveClip(idea({ startSeconds: 0, endSeconds: 200 }), words, settings, 300);
  assert.ok(long && long.end - long.start <= settings.maxSeconds + 1);
  assert.equal(resolveClip(idea({ startSeconds: 10, endSeconds: 14 }), words, settings, 300), undefined);
});

test("keeps the best non-overlapping clips", () => {
  const picked = selectClips(
    [
      { title: "a", reason: "", score: 6, start: 0, end: 30 },
      { title: "b", reason: "", score: 9, start: 20, end: 50 },
      { title: "c", reason: "", score: 7, start: 60, end: 90 },
    ],
    3,
  );
  assert.deepEqual(picked.map((c) => c.title), ["b", "c"]);
});

test("timestamp-only clips are clamped to the video", () => {
  const clip = clipFromTimestamps(idea({ startSeconds: 580, endSeconds: 700 }), settings, 600);
  assert.ok(clip);
  assert.equal(clip.end, 600);
  assert.equal(clipFromTimestamps(idea({ startSeconds: 595, endSeconds: 700 }), settings, 600), undefined);
});

test("parses Gemini's JSON and skips broken entries", () => {
  const ideas = parseClipIdeas({
    clips: [
      { title: "Good", reason: "r", score: 9, start_seconds: 1, end_seconds: 40, first_words: "a", last_words: "b" },
      { title: "Broken", start_seconds: "x" },
    ],
  });
  assert.equal(ideas.length, 1);
  assert.throws(() => parseClipIdeas({}), /no clips/);
});

test("transcript prompt has timestamped lines and skips sound tags", () => {
  const words = makeWords(20, { 3: "[Music]" });
  const text = formatTranscript(words);
  assert.match(text, /^\[0\.0s 0:00\] w0 w1 w2 w4/);
  assert.match(text, /\n\[8\.0s 0:08\] w8/);
  assert.doesNotMatch(text, /Music/);
  assert.match(buildTranscriptPrompt(words, { title: "My Video", channel: "" }, settings), /Pick the 3 best moments/);
});
