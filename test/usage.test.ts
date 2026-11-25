import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, costOf, dayKey, emptyUsage } from "../src/usage.ts";

test("cost uses per-million prices (defaults $0.30 in / $2.50 out)", () => {
  assert.equal(costOf(1_000_000, 0), 0.3);
  assert.equal(costOf(10_000, 2_000), 0.003 + 0.005);
});

test("usage adds up across calls", () => {
  const total = emptyUsage();
  addUsage(total, { calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.001 });
  addUsage(total, { calls: 1, inputTokens: 200, outputTokens: 25, costUsd: 0.0025 });
  assert.deepEqual(total, { calls: 2, inputTokens: 300, outputTokens: 75, costUsd: 0.0035 });
});

test("day keys are local yyyy-mm-dd", () => {
  assert.match(dayKey(new Date(2026, 10, 19, 23, 30)), /^2026-11-19$/);
});
