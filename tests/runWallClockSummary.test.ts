import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePerformanceGates,
  formatRunWallClockSummaryV1,
  summarizeRunWallClockV1,
} from "../src/agent/performanceGates";
import type { AgentRunMetricEvent } from "../src/AgentRunner";

const modelCall = (durationMs: number): AgentRunMetricEvent => ({
  kind: "model_chat",
  name: "agent_step",
  durationMs,
});

const toolCall = (name: string, durationMs: number): AgentRunMetricEvent => ({
  kind: "tool",
  name,
  durationMs,
});

const cachedToolCall = (
  name: string,
  savedDurationMs: number,
): AgentRunMetricEvent => ({
  kind: "tool",
  name,
  durationMs: 0,
  cached: true,
  savedDurationMs,
});

test("separates the latency we control from the latency we do not", () => {
  const summary = summarizeRunWallClockV1([
    modelCall(15_000),
    toolCall("semantic_search_notes", 400),
    modelCall(12_000),
    toolCall("read_file", 30),
    toolCall("semantic_search_notes", 350),
  ]);

  assert.equal(summary.modelMs, 27_000);
  assert.equal(summary.modelCallCount, 2);
  assert.equal(summary.toolMs, 780);
  assert.equal(summary.toolCallCount, 3);
  // The point of the split: a 27.8s mission was 97% provider time, so no amount
  // of local optimisation would have moved it.
  assert.ok(summary.modelMs / (summary.modelMs + summary.toolMs) > 0.9);
});

test("names the slowest host path instead of leaving it to be guessed", () => {
  const summary = summarizeRunWallClockV1([
    toolCall("read_file", 10),
    toolCall("semantic_search_notes", 900),
    toolCall("semantic_search_notes", 700),
    toolCall("web_fetch", 200),
  ]);

  assert.deepEqual(summary.slowestTools[0], {
    name: "semantic_search_notes",
    totalMs: 1600,
    calls: 2,
  });
  assert.equal(summary.slowestTools[1]?.name, "web_fetch");
});

test("a cache hit counts as time avoided, never as time spent", () => {
  const summary = summarizeRunWallClockV1([
    toolCall("read_file", 50),
    cachedToolCall("read_file", 300),
  ]);

  // Charging saved time to toolMs would make the cache look like a cost and
  // could argue for removing the thing that is helping.
  assert.equal(summary.toolMs, 50);
  assert.equal(summary.toolCacheSavedMs, 300);
  assert.equal(summary.toolCacheHitCount, 1);
  assert.equal(summary.slowestTools[0]?.calls, 1);
});

test("malformed durations never corrupt the split", () => {
  const summary = summarizeRunWallClockV1([
    { kind: "tool", name: "x", durationMs: Number.NaN },
    { kind: "tool", name: "x", durationMs: -50 },
    { kind: "model_chat", name: "agent_step", durationMs: Number.POSITIVE_INFINITY },
  ]);

  assert.equal(summary.toolMs, 0);
  assert.equal(summary.modelMs, 0);
});

test("the formatted line reports both halves and never a fabricated total", () => {
  const line = formatRunWallClockSummaryV1(
    summarizeRunWallClockV1([modelCall(20_000), toolCall("semantic_search_notes", 1_500)]),
  );

  assert.match(line, /model 20\.0s over 1 calls/u);
  assert.match(line, /host 1\.5s over 1 tool calls/u);
  assert.match(line, /slowest semantic_search_notes/u);
});

test("the declared sub-tool gate metrics are still unwired", () => {
  // semantic_decode_ms and source_cache_lookup_ms are declared in the
  // PerformanceGate metric union but metricValue has no branch for them, so a
  // gate on either always observes 0 and always passes. Pinning it so the dead
  // vocabulary is a known gap rather than a silent green light: decomposing
  // tool time into sub-phases needs an emitter first.
  const results = evaluatePerformanceGates(
    [toolCall("semantic_search_notes", 5_000)],
    [{ name: "semantic_decode", metric: "semantic_decode_ms", warnAt: 1 }],
  );

  assert.equal(results[0]?.observed, 0);
  assert.equal(results[0]?.status, "pass");
});
