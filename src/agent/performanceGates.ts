import type { AgentRunMetricEvent } from "../AgentRunner";

export interface PerformanceGate {
  name: string;
  metric:
    | "route_ms"
    | "tool_ms"
    | "model_ms"
    | "semantic_decode_ms"
    | "payload_chars"
    | "source_cache_lookup_ms";
  warnAt: number;
  failAt?: number;
}

export interface PerformanceGateResult {
  name: string;
  status: "pass" | "warn" | "fail";
  observed: number;
  threshold: number;
  message: string;
}

export const DEFAULT_PERFORMANCE_GATES: PerformanceGate[] = [
  { name: "model_call_latency", metric: "model_ms", warnAt: 120000 },
  { name: "tool_latency", metric: "tool_ms", warnAt: 15000 },
  { name: "tool_payload_size", metric: "payload_chars", warnAt: 24000 },
];

export function evaluatePerformanceGates(
  metrics: AgentRunMetricEvent[],
  gates: PerformanceGate[] = DEFAULT_PERFORMANCE_GATES,
): PerformanceGateResult[] {
  return gates.map((gate) => {
    const observed = Math.max(0, ...metrics.map((metric) => metricValue(metric, gate.metric)));
    const failed = gate.failAt !== undefined && observed >= gate.failAt;
    const warned = observed >= gate.warnAt;
    const threshold = failed ? gate.failAt ?? gate.warnAt : gate.warnAt;
    return {
      name: gate.name,
      status: failed ? "fail" : warned ? "warn" : "pass",
      observed,
      threshold,
      message: `${gate.metric}=${observed} threshold=${threshold}`,
    };
  });
}

function metricValue(event: AgentRunMetricEvent, metric: PerformanceGate["metric"]): number {
  if (metric === "model_ms") {
    return event.kind === "model_chat" || event.kind === "model_stream" ? event.durationMs : 0;
  }
  if (metric === "tool_ms") {
    return event.kind === "tool" ? event.durationMs : 0;
  }
  if (metric === "payload_chars") {
    return event.outputChars ?? event.responseChars ?? 0;
  }
  return 0;
}

/**
 * Host-versus-model wall clock for one run.
 *
 * Mission latency splits into a half nobody controls -- how long a cloud
 * provider takes to answer -- and a half that is entirely ours. Both halves
 * were already being measured per event (`model_chat`/`model_stream` and
 * `tool`), but nothing ever added them up, so there was no way to say whether a
 * slow mission was a slow provider or slow code. Optimising the controllable
 * half without that split is guesswork, and this repo has already paid for
 * guesswork: of three "obvious" optimisations benchmarked earlier, only one was
 * real.
 *
 * Counted from events the runner already emits. `otherMs` is deliberately not
 * inferred by subtracting from a total: unattributed time is unattributed, and
 * inventing a number for it would be the same mistake as a fabricated progress
 * bar.
 */
export interface RunWallClockSummaryV1 {
  schemaVersion: 1;
  modelMs: number;
  toolMs: number;
  /** Wall clock a cache hit avoided. Not included in toolMs -- it never ran. */
  toolCacheSavedMs: number;
  modelCallCount: number;
  toolCallCount: number;
  toolCacheHitCount: number;
  /** Slowest tools first, so the expensive host path is named, not guessed. */
  slowestTools: Array<{ name: string; totalMs: number; calls: number }>;
}

export function summarizeRunWallClockV1(
  metrics: AgentRunMetricEvent[],
  { topTools = 5 }: { topTools?: number } = {},
): RunWallClockSummaryV1 {
  let modelMs = 0;
  let toolMs = 0;
  let toolCacheSavedMs = 0;
  let modelCallCount = 0;
  let toolCallCount = 0;
  let toolCacheHitCount = 0;
  const byTool = new Map<string, { totalMs: number; calls: number }>();

  for (const event of metrics) {
    const durationMs = Number.isFinite(event.durationMs)
      ? Math.max(0, event.durationMs)
      : 0;
    if (event.kind === "model_chat" || event.kind === "model_stream") {
      modelMs += durationMs;
      modelCallCount += 1;
      continue;
    }
    if (event.kind !== "tool") continue;

    toolCallCount += 1;
    if (event.cached) {
      toolCacheHitCount += 1;
      toolCacheSavedMs += Math.max(0, event.savedDurationMs ?? 0);
      continue;
    }
    toolMs += durationMs;
    const entry = byTool.get(event.name) ?? { totalMs: 0, calls: 0 };
    entry.totalMs += durationMs;
    entry.calls += 1;
    byTool.set(event.name, entry);
  }

  const slowestTools = [...byTool.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((left, right) => right.totalMs - left.totalMs || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, topTools));

  return {
    schemaVersion: 1,
    modelMs,
    toolMs,
    toolCacheSavedMs,
    modelCallCount,
    toolCallCount,
    toolCacheHitCount,
    slowestTools,
  };
}

/** One line for Run Details. Reports both halves; never implies a total. */
export function formatRunWallClockSummaryV1(
  summary: RunWallClockSummaryV1,
): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const parts = [
    `model ${seconds(summary.modelMs)} over ${summary.modelCallCount} calls`,
    `host ${seconds(summary.toolMs)} over ${summary.toolCallCount} tool calls`,
  ];
  if (summary.toolCacheHitCount > 0) {
    parts.push(
      `${summary.toolCacheHitCount} cached (${seconds(summary.toolCacheSavedMs)} avoided)`,
    );
  }
  if (summary.slowestTools.length > 0) {
    const slowest = summary.slowestTools[0];
    parts.push(`slowest ${slowest.name} ${seconds(slowest.totalMs)}`);
  }
  return parts.join(" · ");
}
