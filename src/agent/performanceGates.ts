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
