import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PERFORMANCE_GATES,
  UNWIRED_GATE_METRICS,
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

test("a declared-but-unmeasured metric reports unwired, never pass", () => {
  // semantic_decode_ms and source_cache_lookup_ms are declared in the
  // PerformanceGate metric union but metricValue computes neither, so a gate on
  // either observes 0 forever. It used to report "pass": a threshold that can
  // only ever be met, presented as a threshold that was met. That is the same
  // dishonesty class as a fabricated zero in a report -- arguably worse, since
  // a clean-looking gate is an invitation to trust it.
  const results = evaluatePerformanceGates(
    [toolCall("semantic_search_notes", 5_000)],
    [
      { name: "semantic_decode", metric: "semantic_decode_ms", warnAt: 1 },
      { name: "source_cache", metric: "source_cache_lookup_ms", warnAt: 1 },
    ],
  );

  for (const result of results) {
    assert.equal(result.status, "unwired");
    assert.notEqual(result.status, "pass");
    assert.match(result.message, /cannot fail/u);
  }
});

test("wired metrics are unaffected by the unwired path", () => {
  const results = evaluatePerformanceGates(
    [toolCall("semantic_search_notes", 5_000), modelCall(1_000)],
    [
      { name: "tool_latency", metric: "tool_ms", warnAt: 1_000 },
      { name: "model_latency", metric: "model_ms", warnAt: 999_999 },
    ],
  );

  assert.equal(results[0]?.status, "warn");
  assert.equal(results[0]?.observed, 5_000);
  assert.equal(results[1]?.status, "pass");
});

test("an unwired gate reaches the runner's trace instead of being filtered away", () => {
  // The runner traces every gate whose status is not "pass". Reporting unwired
  // as pass is precisely what kept the gap invisible; this pins that it now
  // survives that filter.
  const surfaced = evaluatePerformanceGates(
    [],
    [{ name: "semantic_decode", metric: "semantic_decode_ms", warnAt: 1 }],
  ).filter((item) => item.status !== "pass");

  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0]?.name, "semantic_decode");
});

test("the shipped default gates are all wired", () => {
  // A default gate that cannot fail would ship the dishonesty to every run.
  for (const gate of DEFAULT_PERFORMANCE_GATES) {
    assert.equal(
      UNWIRED_GATE_METRICS.has(gate.metric),
      false,
      `default gate ${gate.name} is on an unmeasured metric`,
    );
  }
});
