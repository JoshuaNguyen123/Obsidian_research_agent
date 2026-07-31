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
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(", ") : null;
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
