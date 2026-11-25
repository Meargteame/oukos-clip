import assert from "node:assert/strict";
import { test } from "node:test";
import { encoderArgs, encoderSetting } from "../src/encoder-setting.ts";
import { renderArgs } from "../src/render.ts";

test("ENCODER accepts friendly names and falls back to auto", () => {
  assert.equal(encoderSetting(""), "auto");
  assert.equal(encoderSetting("AUTO"), "auto");
  assert.equal(encoderSetting("x264"), "libx264");
  assert.equal(encoderSetting("cpu"), "libx264");
  assert.equal(encoderSetting("qsv"), "h264_qsv");
  assert.equal(encoderSetting("QuickSync"), "h264_qsv");
  assert.equal(encoderSetting("nvidia"), "h264_nvenc");
  assert.equal(encoderSetting("h264_amf"), "h264_amf");
  assert.equal(encoderSetting("something-else"), "auto");
});

test("every encoder produces a pixel format players accept", () => {
  for (const name of ["libx264", "h264_qsv", "h264_nvenc", "h264_amf"] as const) {
    const args = encoderArgs(name);
    assert.equal(args[args.indexOf("-c:v") + 1], name);
    assert.ok(["yuv420p", "nv12"].includes(args[args.indexOf("-pix_fmt") + 1]), name);
  }
});

test("render args use the chosen encoder and keep audio, seek and faststart", () => {
  const job = {
    video: { url: "https://v.example/video", headers: {} },
    audio: { url: "https://v.example/audio", headers: {} },
    start: 10,
    end: 40,
    framing: { mode: "center" as const },
    dir: ".",
    fileName: "clip-1.mp4",
  };
  const args = renderArgs(job, "[0:v]null[v]", "h264_qsv");
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_qsv");
  assert.ok(!args.includes("libx264"));
  assert.equal(args[args.indexOf("-t") + 1], "30.000");
  assert.equal(args.filter((a) => a === "-ss").length, 2, "both video and audio inputs seek");
  assert.ok(args.includes("+faststart"));
  assert.equal(args.at(-1), "clip-1.mp4");
});
