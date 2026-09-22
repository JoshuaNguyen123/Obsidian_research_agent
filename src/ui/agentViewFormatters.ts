import type {
  AgentRunMetricEvent,
  AgentRunReceipt,
  AgentStreamLifecycleEvent,
} from "../AgentRunner";
import { MAX_AGENT_STEPS } from "../tools/constants";

export function formatStreamLifecycleLabel(
  kind: AgentStreamLifecycleEvent["kind"],
): string {
  if (kind === "first_visible_content") {
    return "chat_stream";
  }
  if (kind === "first_note_write") {
    return "note_stream";
  }
  return kind;
}

export function formatReceiptOperationLabel(
  operation: AgentRunReceipt["operation"],
): string {
  if (operation === "append") {
    return "note_append";
  }
  if (
    operation === "replace" ||
    operation === "edit" ||
    operation === "retitle"
  ) {
    return "note_replace";
  }
  if (operation === "trash" || operation === "delete") {
    return "note_delete";
  }
  return `note_${operation}`;
}

export function formatAgentMetric(event: AgentRunMetricEvent): string {
  if (event.kind === "run" && event.name === PROMPT_PREFIX_REUSE_METRIC_NAME) {
    return formatPromptPrefixReuseMetric(event);
  }
  if (event.kind === "host_work") {
    const label =
      event.name === "persist_run_note"
        ? "run-note write"
        : event.name === "persist_graph"
          ? "graph write"
          : event.name;
    return `Host work: ${label} ${event.durationMs}ms`;
  }
  if (event.kind === "model_chat") {
    return [
      `Timing: model step ${event.step ?? "?"}`,
      formatDuration(event.durationMs),
      event.requestChars !== undefined
        ? `request ${formatChars(event.requestChars)}`
        : null,
      event.responseChars !== undefined
        ? `response ${formatChars(event.responseChars)}`
        : null,
      formatTokenParts(event),
    ]
      .filter((part): part is string => Boolean(part))
      .join(", ");
  }

  if (event.kind === "model_stream") {
    return [
      "Timing: final stream",
      formatDuration(event.durationMs),
      event.requestChars !== undefined
        ? `request ${formatChars(event.requestChars)}`
        : null,
      event.responseChars !== undefined
        ? `response ${formatChars(event.responseChars)}`
        : null,
      formatTokenParts(event),
    ]
      .filter((part): part is string => Boolean(part))
      .join(", ");
  }

  if (event.kind === "tool") {
    return [
      event.cached ? `Cache hit: ${event.name}` : `Timing: ${event.name}`,
      formatDuration(event.durationMs),
      event.inputChars !== undefined
        ? `input ${formatChars(event.inputChars)}`
        : null,
      event.outputChars !== undefined
        ? `output ${formatChars(event.outputChars)}`
        : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(", ");
  }

  return `Timing: run ${formatDuration(event.durationMs)}`;
}

export function formatScopeList(values: readonly string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

/** How many items a diagnostic list shows before it summarizes the rest. */
export const BOUNDED_LIST_PREVIEW = 6;

/**
 * A readable projection of a potentially huge diagnostic list.
 *
 * An unbounded `join` turned a run with fifty open evidence conflicts into a
 * wall of `conflict:<hash>` text that buried the two lines a human actually
 * reads (what is missing, what to do next). The count still tells the whole
 * truth — only the enumeration is bounded.
 */
export function formatBoundedList(
  values: readonly string[],
  limit: number = BOUNDED_LIST_PREVIEW,
): string {
  if (values.length === 0) return "none";
  const capped = Math.max(1, limit);
  if (values.length <= capped) return values.join(", ");
  return `${values.slice(0, capped).join(", ")} +${values.length - capped} more`;
}

export function formatTokenParts(event: AgentRunMetricEvent): string | null {
  const parts = [
    event.promptTokens !== undefined ? `prompt tokens ${event.promptTokens}` : null,
    event.completionTokens !== undefined
      ? `completion tokens ${event.completionTokens}`
      : null,
    event.totalTokens !== undefined ? `total tokens ${event.totalTokens}` : null,
    // Reported only when the provider says so; a silent provider stays silent
    // here too, so "0" is always a measured cache miss, never an assumption.
    event.cachedPromptTokens !== undefined
      ? `cached prompt tokens ${event.cachedPromptTokens}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(", ") : null;
}

/** Metric name the runner uses for the per-step prompt-prefix reuse event. */
export const PROMPT_PREFIX_REUSE_METRIC_NAME = "prompt_prefix_reuse";

export function formatPromptPrefixReuseMetric(
  event: AgentRunMetricEvent,
): string {
  const ratio = event.prefixReuseRatio;
  const percent =
    typeof ratio === "number" && Number.isFinite(ratio)
      ? `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
      : "unknown";
  const divergence =
    event.prefixFirstDivergentIndex === null
      ? "pure append"
      : typeof event.prefixFirstDivergentIndex === "number"
        ? `first change at message ${event.prefixFirstDivergentIndex}`
        : "divergence unknown";
  return `Prefix reuse: step ${event.step ?? "?"} reuses ${percent} of the previous prompt (${divergence})`;
}

export function formatOptionalNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "default";
}

export function formatDuration(durationMs: number): string {
  return `${Math.max(0, Math.round(durationMs))}ms`;
}

export function formatChars(chars: number): string {
  if (chars >= 1024) {
    return `${(chars / 1024).toFixed(1)} KB`;
  }

  return `${chars} B`;
}

export function formatStepMetric(
  step: number,
  maxSteps = MAX_AGENT_STEPS,
): string {
  return `${step} used (max ${maxSteps})`;
}

/** Longest tool target the live-run card shows; longer values are clipped. */
export const MAX_TOOL_TARGET_CHARS = 40;

/**
 * A bounded, human-sized "what is this tool pointed at" for the live-run
 * card: the note basename, the source hostname, or the first words of a
 * query. Derived from the redacted `tool_start` trace only, so nothing the
 * runner already refused to show can leak through here.
 */
export function formatToolTargetV1(trace: {
  path?: string;
  toPath?: string;
  inputPreview?: unknown;
}): string {
  const preview =
    trace.inputPreview && typeof trace.inputPreview === "object"
      ? (trace.inputPreview as Record<string, unknown>)
      : null;
  const pathValue =
    firstString(trace.path, trace.toPath) ??
    firstString(preview?.path, preview?.targetPath, preview?.cachedPath);
  if (pathValue) {
    return clipTarget(basename(pathValue));
  }
  const urlValue = firstString(preview?.url);
  if (urlValue) {
    try {
      return clipTarget(new URL(urlValue).hostname);
    } catch {
      return clipTarget(urlValue);
    }
  }
  const textValue = firstString(
    preview?.query,
    preview?.title,
    preview?.heading,
    preview?.section,
    preview?.id,
  );
  return textValue ? clipTarget(textValue) : "";
}

export function formatLiveRunToolLabel(name: string, target: string): string {
  const trimmedName = name.trim();
  if (!trimmedName) return "—";
  const trimmedTarget = target.trim();
  return trimmedTarget ? `${trimmedName} · ${trimmedTarget}` : trimmedName;
}

export function formatLiveRunProofLabel(
  receipts: number,
  sources: number,
): string {
  const receiptCount = Math.max(0, Math.trunc(receipts));
  const sourceCount = Math.max(0, Math.trunc(sources));
  return `${receiptCount} ${receiptCount === 1 ? "receipt" : "receipts"} · ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function basename(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : value;
}

function clipTarget(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_TOOL_TARGET_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TOOL_TARGET_CHARS - 1)}…`;
}
