import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCropCommands, cameraAt, planCamera, splitShots, type Face, type Sample } from "../src/reframe.ts";

const CROP = 0.316; // 9:16 crop of a 16:9 frame

const face = (cx: number, m = 0, w = 0.1): Face => ({ x: cx - w / 2, y: 0.2, w, h: w * 1.6, s: 0.9, m });

function samples(count: number, facesAt: (i: number) => Face[], cutAt: number[] = []): Sample[] {
  return Array.from({ length: count }, (_, i) => ({ t: i / 5, cut: cutAt.includes(i) ? 60 : 2, faces: facesAt(i) }));
}

function keysOf(plan: ReturnType<typeof planCamera>) {
  assert.equal(plan.mode, "track");
  return plan.keys;
}

test("a speaker who sways a little gets a locked-off shot, not a jittery one", () => {
  const plan = planCamera(samples(50, (i) => [face(0.3 + Math.sin(i) * 0.03)]), CROP);
  const xs = new Set(keysOf(plan).map((k) => k.cx));
  assert.equal(xs.size, 1);
  assert.ok(Math.abs([...xs][0] - 0.3) < 0.02);
});

test("a speaker walking across the stage is followed smoothly", () => {
  const keys = keysOf(planCamera(samples(50, (i) => [face(0.2 + i * 0.012)]), CROP));
  assert.ok(keys.at(-1)!.cx - keys[0].cx > 0.4, "camera moved with them");
  for (let i = 1; i < keys.length; i++) {
    assert.ok(Math.abs(keys[i].cx - keys[i - 1].cx) < 0.03, "no sudden jumps");
  }
});

test("two people far apart: follows whoever is talking, switching after they talk for a while", () => {
  // Left person talks for 4s, then right person talks for 4s.
  const plan = planCamera(
    samples(40, (i) => [face(0.2, i < 20 ? 3 : 0), face(0.8, i < 20 ? 0 : 3)]),
    CROP,
  );
  const keys = keysOf(plan);
  assert.ok(Math.abs(keys[5].cx - 0.2) < 0.01);
  assert.ok(Math.abs(keys[39].cx - 0.8) < 0.01);
  const switchKey = keys.findIndex((k) => k.cx > 0.5);
  assert.ok(keys[switchKey].jump, "switching speaker is a cut, not a pan");
  assert.ok(switchKey >= 20 && switchKey <= 28, `switched near the change (${switchKey})`);
});

test("a single blip of mouth motion from the other person does not steal the camera", () => {
  const keys = keysOf(planCamera(samples(40, (i) => [face(0.2, 2), face(0.8, i === 15 ? 9 : 0)]), CROP));
  assert.ok(keys.every((k) => k.cx < 0.5));
});

test("two people close together are framed as a pair", () => {
  const keys = keysOf(planCamera(samples(20, () => [face(0.42, 3, 0.08), face(0.58, 0, 0.08)]), CROP));
  assert.ok(Math.abs(keys[10].cx - 0.5) < 0.02);
});

test("scene cuts reset the camera instantly", () => {
  const data = samples(30, (i) => [face(i < 15 ? 0.25 : 0.75)], [15]);
  assert.equal(splitShots(data).length, 2);
  const keys = keysOf(planCamera(data, CROP));
  assert.ok(keys[15].jump);
  assert.ok(Math.abs(keys[14].cx - 0.25) < 0.01 && Math.abs(keys[15].cx - 0.75) < 0.01);
});

test("short face dropouts hold the last position", () => {
  const keys = keysOf(planCamera(samples(30, (i) => (i >= 10 && i < 14 ? [] : [face(0.7)])), CROP));
  assert.ok(keys.every((k) => Math.abs(k.cx - 0.7) < 0.01));
});

test("no faces (slides, b-roll) -> full frame on blurred background", () => {
  assert.equal(planCamera(samples(30, (i) => (i < 3 ? [face(0.5)] : [])), CROP).mode, "fit");
  assert.equal(planCamera(samples(30, () => [face(0.5)]), 1).mode, "center");
});

test("crop commands pan between keys, cut on jumps, and stay inside the frame", () => {
  const keys = [
    { t: 0, cx: 0.2, jump: true },
    { t: 1, cx: 0.4, jump: false },
    { t: 2, cx: 0.98, jump: true },
  ];
  assert.equal(cameraAt(keys, 0.5), 0.30000000000000004);
  assert.equal(cameraAt(keys, 1.9), 0.4, "holds until the cut");
  const { initialX, script } = buildCropCommands(keys, 3, 30, 1920, 606);
  assert.equal(initialX, Math.round(0.2 * 1920 - 303));
  const xs = script.trim().split("\n").map((l) => Number(/x (\d+);$/.exec(l)![1]));
  assert.ok(xs.every((x) => x >= 0 && x <= 1920 - 606));
  assert.equal(xs.at(-1), 1920 - 606, "clamped at the right edge");
  assert.match(script, /^0\.033 crop@rf x \d+;$/m);
});
