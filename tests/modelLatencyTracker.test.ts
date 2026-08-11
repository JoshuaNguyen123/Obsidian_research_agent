import assert from "node:assert/strict";
import test from "node:test";
import {
  clampLatencyScale,
  createModelLatencyTracker,
  DEFAULT_EXPECTED_CALL_MS,
  LATENCY_FAILURE_FLOOR_MS,
  LATENCY_MIN_SAMPLES,
  MAX_LATENCY_SCALE,
} from "../src/model/modelLatencyTracker";

test("scale stays 1 until the minimum sample count is reached", () => {
  const tracker = createModelLatencyTracker();
  for (let index = 0; index < LATENCY_MIN_SAMPLES - 1; index += 1) {
    tracker.observe(60_000);
    assert.equal(tracker.getScale(), 1);
  }
  tracker.observe(60_000);
  assert.equal(tracker.getScale(), MAX_LATENCY_SCALE);
});

test("a fast model never shrinks a budget", () => {
  const tracker = createModelLatencyTracker();
  for (let index = 0; index < 5; index += 1) {
    tracker.observe(1_000);
  }
  assert.equal(tracker.getScale(), 1);
});

test("scale tracks the observed-to-expected ratio between the clamps", () => {
  const tracker = createModelLatencyTracker({ expectedCallMs: 10_000 });
  for (let index = 0; index < 5; index += 1) {
    tracker.observe(15_000);
  }
  assert.equal(tracker.getScale(), 1.5);
  assert.equal(tracker.snapshot().ewmaMs, 15_000);
});

test("scale never exceeds the maximum multiplier", () => {
  const tracker = createModelLatencyTracker({ expectedCallMs: 1_000 });
  for (let index = 0; index < 5; index += 1) {
    tracker.observe(600_000);
  }
  assert.equal(tracker.getScale(), MAX_LATENCY_SCALE);
});

test("one outlier cannot swing the average", () => {
  const tracker = createModelLatencyTracker();
  for (let index = 0; index < 10; index += 1) {
    tracker.observe(5_000);
  }
  tracker.observe(120_000);
  const after = tracker.snapshot().ewmaMs;
  assert.ok(after !== null && after < 60_000);
});

test("fast failures, empty successes, and degenerate calls are rejected as evidence", () => {
  const tracker = createModelLatencyTracker();
  tracker.observeEvidence({
    durationMs: LATENCY_FAILURE_FLOOR_MS - 1,
    outcome: "error",
    responseChars: 0,
  });
  tracker.observeEvidence({
    durationMs: 30_000,
    outcome: "budget_exhausted",
    responseChars: 100,
  });
  tracker.observeEvidence({
    durationMs: 30_000,
    outcome: "success",
    responseChars: 0,
  });
  tracker.observe(Number.NaN);
  tracker.observe(-5);
  assert.equal(tracker.snapshot().samples, 0);
  tracker.observeEvidence({
    durationMs: 30_000,
    outcome: "success",
    responseChars: 512,
  });
  assert.equal(tracker.snapshot().samples, 1);
});

test("a long-running failed call counts as latency evidence", () => {
  // Timeout-censoring: the slowest calls never succeed. A 90s transport
  // timeout must still move the average or a slow model never scales.
  const tracker = createModelLatencyTracker();
  for (let index = 0; index < LATENCY_MIN_SAMPLES; index += 1) {
    tracker.observeEvidence({
      durationMs: 90_000,
      outcome: "error",
      responseChars: 0,
    });
  }
  assert.equal(tracker.snapshot().samples, LATENCY_MIN_SAMPLES);
  assert.equal(tracker.getScale(), MAX_LATENCY_SCALE);
});

test("clampLatencyScale sanitizes host-supplied values", () => {
  assert.equal(clampLatencyScale(undefined), 1);
  assert.equal(clampLatencyScale(Number.NaN), 1);
  assert.equal(clampLatencyScale(0.25), 1);
  assert.equal(clampLatencyScale(1.4), 1.4);
  assert.equal(clampLatencyScale(9), MAX_LATENCY_SCALE);
});

test("default expectation matches the documented budget sizing", () => {
  assert.equal(DEFAULT_EXPECTED_CALL_MS, 15_000);
});
