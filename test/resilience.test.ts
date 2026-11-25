import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs, modelForAttempt } from "../src/gemini.ts";
import { nextRunnable, resetInterrupted, type Clip, type Job } from "../src/jobs.ts";

const clip = (id: string, status: Clip["status"]): Clip => ({
  id, status, review: "unreviewed", title: "t", reason: "r", score: 5, start: 0, end: 30,
  ...(status === "ready" ? { file: `clip-${id}.mp4` } : {}),
});

test("a restart keeps Gemini's picks and finished clips, and re-queues the job", () => {
  const job: Job = {
    id: "a", url: "u", createdAt: 0, status: "rendering", message: "Clip 2 of 3: rendering",
    clips: [clip("1", "ready"), clip("2", "rendering"), clip("3", "pending")],
  };
  resetInterrupted(job);
  assert.equal(job.status, "queued");
  assert.deepEqual(job.clips.map((c) => c.status), ["ready", "pending", "pending"]);
  assert.match(job.message, /resuming/);
});

test("a restart before picking starts the job over; finished jobs are left alone", () => {
  const early: Job = { id: "b", url: "u", createdAt: 0, status: "picking", message: "", clips: [] };
  resetInterrupted(early);
  assert.equal(early.status, "queued");
  assert.equal(early.clips.length, 0);

  const done: Job = { id: "c", url: "u", createdAt: 0, status: "done", message: "3 clips ready", clips: [clip("1", "ready")] };
  resetInterrupted(done);
  assert.equal(done.status, "done");
});
import { parseUrls } from "../src/urls.ts";

test("cleans quotes and punctuation stuck to pasted links", () => {
  assert.deepEqual(
    parseUrls(`https://www.youtube.com/watch?v=sbqR2M6SEx4%27\n'https://youtu.be/abc'  (https://youtu.be/def). not-a-link`),
    ["https://www.youtube.com/watch?v=sbqR2M6SEx4", "https://youtu.be/abc", "https://youtu.be/def"],
  );
  assert.deepEqual(parseUrls("https://youtu.be/abc https://youtu.be/abc"), ["https://youtu.be/abc"], "deduplicated");
});

test("tries the main model twice, then rotates through fallbacks", () => {
  const models = ["main", "fb1", "fb2"];
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((a) => modelForAttempt(models, a)), ["main", "main", "fb1", "fb2", "main", "fb1"]);
  assert.equal(modelForAttempt(["only"], 5), "only");
});

test("backoff grows, is capped, and respects Retry-After", () => {
  assert.ok(backoffMs(1) >= 1500 && backoffMs(1) <= 2500);
  assert.ok(backoffMs(10) <= 75_000);
  assert.equal(backoffMs(1, 30), 30_000);
});

test("jobs waiting for an automatic retry are skipped until due", () => {
  const job = (id: string, retryAt?: number): Job =>
    ({ id, url: "u", createdAt: 0, status: "queued", message: "", clips: [], retryAt }) as Job;
  const list = [job("later", 5000), job("now")];
  assert.equal(nextRunnable(list, 1000)?.id, "now");
  assert.equal(nextRunnable([job("later", 5000)], 1000), undefined);
  assert.equal(nextRunnable([job("later", 5000)], 6000)?.id, "later");
});
