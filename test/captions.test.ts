import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJson3 } from "../src/captions.ts";
import { pickSubtitleTrack, parseVideoInfo } from "../src/youtube.ts";

test("parses auto-caption words with per-word offsets", () => {
  const words = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 5000 }, // window event without segs
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [{ utf8: "the" }, { utf8: " secret", tOffsetMs: 400 }, { utf8: " is", tOffsetMs: 900 }],
      },
      { tStartMs: 2900, segs: [{ utf8: "\n" }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "simple" }] },
    ],
  });
  assert.deepEqual(
    words.map((w) => [w.text, w.start, w.end]),
    [
      ["the", 1, 1.4],
      ["secret", 1.4, 1.9],
      ["is", 1.9, 3],
      ["simple", 3, 4],
    ],
  );
});

test("drops '>>' speaker-change markers", () => {
  const words = parseJson3({
    events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: ">> I" }, { utf8: " see", tOffsetMs: 500 }, { utf8: " >>", tOffsetMs: 900 }] }],
  });
  assert.deepEqual(words.map((w) => w.text), ["I", "see"]);
});

test("spreads manual caption lines across their duration", () => {
  const words = parseJson3({ events: [{ tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: "hi there friend" }] }] });
  assert.equal(words.length, 3);
  assert.equal(words[0].start, 10);
  assert.ok(words[1].start > 10 && words[2].start < 12);
  assert.equal(words[2].end, 12);
  for (const w of words) assert.ok(w.end > w.start);
});

test("prefers manual subs, then the spoken-language auto captions", () => {
  assert.deepEqual(pickSubtitleTrack({ en: [] }, { "en-orig": [], fr: [] }, "en"), { lang: "en", auto: false });
  assert.deepEqual(pickSubtitleTrack({ live_chat: [] }, { "en-orig": [], en: [], fr: [] }, "en"), { lang: "en-orig", auto: true });
  assert.deepEqual(pickSubtitleTrack({}, { en: [], fr: [] }, "en-US"), { lang: "en", auto: true });
  assert.deepEqual(pickSubtitleTrack({}, { "am-orig": [], en: [] }, "fr"), { lang: "am-orig", auto: true });
  assert.equal(pickSubtitleTrack({}, {}, "en"), undefined);
});

test("reads separate video and audio streams from yt-dlp JSON", () => {
  const info = parseVideoInfo({
    id: "abc",
    title: "A talk",
    channel: "Chan",
    duration: 3600,
    language: "en",
    requested_formats: [
      { url: "https://v", vcodec: "avc1", acodec: "none", width: 1920, height: 1080, http_headers: { "User-Agent": "x" } },
      { url: "https://a", vcodec: "none", acodec: "mp4a" },
    ],
    automatic_captions: { "en-orig": [] },
  });
  assert.equal(info.video.url, "https://v");
  assert.equal(info.audio?.url, "https://a");
  assert.equal(info.height, 1080);
  assert.deepEqual(info.subtitleTrack, { lang: "en-orig", auto: true });
});
