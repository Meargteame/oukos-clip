import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAss, groupCaptionWords } from "../src/render.ts";

const words = [
  { text: "Most", start: 100, end: 100.3 },
  { text: "people", start: 100.3, end: 100.7 },
  { text: "never", start: 100.7, end: 101 },
  { text: "try.", start: 101, end: 101.4 },
  { text: "[Music]", start: 101.4, end: 102 },
  { text: "(Laughter)", start: 102, end: 103 },
  { text: "But{x}", start: 103, end: 103.5 },
];

test("groups up to 3 words and breaks at sentence ends", () => {
  const groups = groupCaptionWords(words.slice(0, 4));
  assert.deepEqual(groups.map((g) => g.map((w) => w.text)), [["Most", "people", "never"], ["try."]]);
});

test("ASS events are relative to the clip start and highlight one word at a time", () => {
  const ass = buildAss(words, 100, 104, 720, 1280);
  const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(events[0].slice(0, 32), "Dialogue: 0,0:00:00.00,0:00:00.3");
  assert.match(events[0], /\{\\1c&H0000E5FF&\}MOST\{\\1c&H00FFFFFF&\} PEOPLE NEVER$/);
  assert.ok(!ass.includes("MUSIC") && !ass.includes("LAUGHTER"), "sound tags are dropped");
  assert.ok(!ass.includes("TRY."), "sentence punctuation is dropped");
  assert.ok(ass.includes("BUTX"), "braces are stripped so they can't inject ASS tags");
  assert.match(ass, /PlayResY: 1280/);
});
