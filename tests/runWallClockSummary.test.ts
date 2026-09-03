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
import { describeMetricEventValue } from "../src/agent/metricEventRendering";

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
  // source_cache_lookup_ms is declared in the PerformanceGate metric union
  // with no branch in metricValue, so a gate on it observes 0 forever.
  // (semantic_decode_ms was in the same state until it was wired; the tests
  // below now pin that it is measured, which is why it is absent here.) It used to report "pass": a threshold that can
  // only ever be met, presented as a threshold that was met. That is the same
  // dishonesty class as a fabricated zero in a report -- arguably worse, since
  // a clean-looking gate is an invitation to trust it.
  const results = evaluatePerformanceGates(
    [toolCall("semantic_search_notes", 5_000)],
    [{ name: "source_cache", metric: "source_cache_lookup_ms", warnAt: 1 }],
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
    [{ name: "source_cache", metric: "source_cache_lookup_ms", warnAt: 1 }],
  ).filter((item) => item.status !== "pass");

  assert.equal(surfaced.length, 1);
  assert.equal(surfaced[0]?.name, "source_cache");
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

/*
 * semantic_decode_ms, now measured rather than declared.
 *
 * It sat in the PerformanceGate metric union with no branch in metricValue, so
 * a gate on it observed 0 forever and always passed. It is now computed from
 * the decode/score split a semantic search reports, which is the number that
 * decides whether optimising the vector scan is worth building at all: a tool
 * duration says a search took 400ms, and only the split says whether that was
 * base64 decode or cosine scoring.
 */

const decodeToolCall = (
  durationMs: number,
  decodeMs: number,
  rowsScored?: number,
): AgentRunMetricEvent => ({
  kind: "tool",
  name: "semantic_search_notes",
  durationMs,
  decodeMs,
  ...(rowsScored === undefined ? {} : { rowsScored }),
});

test("semantic_decode_ms is measured, not declared-and-dead", () => {
  const results = evaluatePerformanceGates(
    [decodeToolCall(400, 260, 12_000)],
    [{ name: "decode", metric: "semantic_decode_ms", warnAt: 200 }],
  );

  assert.notEqual(results[0]?.status, "unwired");
  assert.equal(results[0]?.observed, 260);
  assert.equal(results[0]?.status, "warn");
});

test("a tool that measured no decode contributes nothing rather than a zero", () => {
  // Math.max over a mix must reflect the searches that actually decoded. A
  // tool with no timings returning 0 is inert; it must never look like a
  // measured fast decode, which would understate the peak.
  const results = evaluatePerformanceGates(
    [toolCall("read_file", 30), decodeToolCall(400, 260), toolCall("web_fetch", 900)],
    [{ name: "decode", metric: "semantic_decode_ms", warnAt: 10_000 }],
  );

  assert.equal(results[0]?.observed, 260);
  assert.equal(results[0]?.status, "pass");
});

test("a run with no semantic search reports zero decode, and still passes", () => {
  const results = evaluatePerformanceGates(
    [toolCall("read_file", 30)],
    [{ name: "decode", metric: "semantic_decode_ms", warnAt: 200 }],
  );

  // Zero here is honest: no search ran, so no decode happened. That is
  // different from the old behaviour, where zero meant nobody was measuring.
  assert.equal(results[0]?.observed, 0);
  assert.equal(results[0]?.status, "pass");
});

test("source_cache_lookup_ms is still declared and still unwired", () => {
  // One metric getting wired must not silently imply the other did.
  const results = evaluatePerformanceGates(
    [decodeToolCall(400, 260)],
    [{ name: "source_cache", metric: "source_cache_lookup_ms", warnAt: 1 }],
  );

  assert.equal(results[0]?.status, "unwired");
});

test("the render derives id and message from the salient value", () => {
  const withRows = describeMetricEventValue(decodeToolCall(400, 260, 12_000));
  const withoutRows = describeMetricEventValue(decodeToolCall(400, 90, 3_000));

  // The old id embedded durationMs alone, so two events differing only in the
  // number they are named for collided within a step.
  assert.notEqual(withRows.token, withoutRows.token);
  assert.match(withRows.rendered, /decode 260ms, 12000 rows/u);

  // A plain duration metric is unchanged.
  const plain = describeMetricEventValue(toolCall("read_file", 30));
  assert.equal(plain.token, "30");
  assert.equal(plain.rendered, "30ms");
});

test("host work is attributed by phase and never charged to tools", () => {
  const summary = summarizeRunWallClockV1([
    toolCall("read_file", 30),
    { kind: "host_work", name: "persist_run_note", durationMs: 40 },
    { kind: "host_work", name: "persist_run_note", durationMs: 60 },
    { kind: "host_work", name: "persist_graph", durationMs: 25 },
    { kind: "host_work", name: "compaction", durationMs: Number.NaN },
  ]);

  assert.equal(summary.toolMs, 30, "host work is not tool time");
  assert.equal(summary.hostWorkMs, 125);
  assert.deepEqual(summary.hostWork, [
    { phase: "persist_run_note", totalMs: 100, count: 2 },
    { phase: "persist_graph", totalMs: 25, count: 1 },
    { phase: "compaction", totalMs: 0, count: 1 },
  ]);
  assert.match(
    formatRunWallClockSummaryV1(summary),
    /host work 0\.1s \(run-note writes 0\.1s\/2, graph writes 0\.0s\/1, compaction 0\.0s\/1\)/,
  );
  assert.doesNotMatch(
    formatRunWallClockSummaryV1(summarizeRunWallClockV1([toolCall("read_file", 5)])),
    /host work/,
    "silent when nothing was attributed",
  );
});
