/**
 * What actually happened when a run stopped — assembled from the run's own
 * artifacts rather than from its narrative.
 *
 * The recurring failure in this repo is not a bad model; it is a run whose
 * diagnostics point at the model. One terminal message reads "Retry with a
 * tool-compliant model" for a bug that was a string comparison, and every
 * investigation so far has found the stop reason misleading. The classifier
 * that produces those strings lives in the runner. The *presentation* is here,
 * and it can put the checkable facts first: the blocker code, the frontier the
 * model was actually offered, the tool call that failed with its arguments,
 * and the durable attestation of a refused repair.
 *
 * Pure and unit-tested on purpose: the words a blocked run shows are the words
 * someone debugs from, so they must not be composed inline in the view.
 */

export interface RunFailureFactV1 {
  /** Stable key; also the DOM data attribute, so e2e can assert on it. */
  key: string;
  label: string;
  value: string;
}

export interface RunFailureToolFailureV1 {
  name: string;
  step?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Tool call arguments, as the trace carried them. */
  args?: unknown;
}

export interface RunFailureDiagnosticV1 {
  /** Trace id, e.g. "…:create-file-collision-replan-failed". */
  id: string;
  code?: string | null;
  message?: string | null;
  detail?: unknown;
}

export interface RunFailureBlockerV1 {
  code?: string | null;
  message?: string | null;
  requiredAction?: string | null;
}

export interface RunFailureEvidenceInputV1 {
  stopDetail?: string | null;
  blocker?: RunFailureBlockerV1 | null;
  activeNodeId?: string | null;
  lastToolFailure?: RunFailureToolFailureV1 | null;
  diagnostics?: readonly RunFailureDiagnosticV1[];
}

const MAX_FACT_VALUE_CHARS = 220;
const MAX_ARG_VALUE_CHARS = 60;
const MAX_ARG_KEYS = 6;
const MAX_DIAGNOSTIC_FACTS = 3;

/**
 * Narrative that reads as "the model is bad" or "the provider is flaky". Those
 * are the two explanations that have been wrong every time so far, so when a
 * run offers one we lead with the artifacts instead.
 */
const MODEL_BLAMING_NARRATIVE =
  /\btool[-\s]compliant\s+model\b|\buse\s+a\s+(?:different|better|stronger|tool[-\s]\w+)\s+model\b|\bretry\s+with\s+(?:a\s+)?\w*\s*model\b|\bmodel_tool_noncompliance\b|\bthe\s+model\s+(?:twice\s+)?(?:returned|stalled|refused|failed|stopped)\b|\bmodel\s+(?:is\s+)?(?:not|non)[-\s]?compliant\b|\bprovider\s+(?:is\s+)?(?:flaky|unreliable)\b/i;

export function narrativeBlamesTheModelV1(detail?: string | null): boolean {
  return MODEL_BLAMING_NARRATIVE.test(detail ?? "");
}

function clip(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compact one-line rendering of tool arguments.
 *
 * Long strings are reported by length, never by content: a `content` argument
 * is frequently a whole note, and a blocker banner is the wrong place to spill
 * it. What matters for diagnosis is which argument was passed, and what its
 * shape was.
 */
export function formatToolArgumentsPreviewV1(args: unknown): string {
  if (args === undefined || args === null) {
    return "";
  }
  if (!isRecord(args)) {
    return clip(String(args), MAX_ARG_VALUE_CHARS);
  }
  const keys = Object.keys(args);
  const shown = keys.slice(0, MAX_ARG_KEYS);
  const parts = shown.map((key) => {
    const value = args[key];
    if (typeof value === "string") {
      return value.length > MAX_ARG_VALUE_CHARS
        ? `${key}=<${value.length} chars>`
        : `${key}=${JSON.stringify(value)}`;
    }
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return `${key}=${String(value)}`;
    }
    if (Array.isArray(value)) {
      return `${key}=[${value.length}]`;
    }
    return `${key}={…}`;
  });
  if (keys.length > shown.length) {
    parts.push(`+${keys.length - shown.length} more`);
  }
  return parts.join(", ");
}

/**
 * A frontier of one tool is the single most useful fact in this whole set: it
 * turns "the model stopped calling tools" into "the model had exactly one
 * legal call and it was refused", which is a different bug entirely.
 */
function frontierFact(detail: unknown): RunFailureFactV1 | null {
  if (!isRecord(detail)) return null;
  const frontier = detail.rejectedFrontier ?? detail.allowedTools ?? detail.frontier;
  if (!Array.isArray(frontier) || frontier.length === 0) return null;
  const names = frontier.filter(
    (entry): entry is string => typeof entry === "string",
  );
  if (names.length === 0) return null;
  return {
    key: "offered_frontier",
    label:
      names.length === 1
        ? "Only legal tool call"
        : `Tools the model was allowed (${names.length})`,
    value: clip(names.join(", "), MAX_FACT_VALUE_CHARS),
  };
}

function diagnosticCode(diagnostic: RunFailureDiagnosticV1): string | null {
  const explicit = diagnostic.code?.trim();
  if (explicit) return explicit;
  if (isRecord(diagnostic.detail) && typeof diagnostic.detail.code === "string") {
    return diagnostic.detail.code.trim() || null;
  }
  // Attested refusal ids are suffixed with what refused, e.g.
  // "<node>:create-file-collision-replan-failed". The suffix is the reason.
  const suffix = diagnostic.id.includes(":")
    ? diagnostic.id.slice(diagnostic.id.lastIndexOf(":") + 1)
    : diagnostic.id;
  return suffix.trim() || null;
}

/**
 * Ordered facts, most load-bearing first. Empty when the run left no artifacts
 * behind — in which case the caller keeps the narrative it already had, rather
 * than showing an empty "what actually happened" block.
 */
export function buildRunFailureEvidenceV1(
  input: RunFailureEvidenceInputV1,
): RunFailureFactV1[] {
  const facts: RunFailureFactV1[] = [];

  const blockerCode = input.blocker?.code?.trim();
  if (blockerCode && blockerCode !== "none") {
    facts.push({
      key: "blocker_code",
      label: "Blocker",
      value: clip(blockerCode, MAX_FACT_VALUE_CHARS),
    });
  }

  const failure = input.lastToolFailure;
  if (failure?.name) {
    const argsPreview = formatToolArgumentsPreviewV1(failure.args);
    const stepSuffix =
      typeof failure.step === "number" ? ` (step ${failure.step})` : "";
    facts.push({
      key: "failed_tool",
      label: "Failed tool call",
      value: clip(
        argsPreview
          ? `${failure.name}(${argsPreview})${stepSuffix}`
          : `${failure.name}${stepSuffix}`,
        MAX_FACT_VALUE_CHARS,
      ),
    });
    const toolError =
      failure.errorCode?.trim() || failure.errorMessage?.trim() || "";
    if (toolError) {
      facts.push({
        key: "failed_tool_error",
        label: "Tool reported",
        value: clip(
          failure.errorCode?.trim() && failure.errorMessage?.trim()
            ? `${failure.errorCode.trim()} — ${failure.errorMessage.trim()}`
            : toolError,
          MAX_FACT_VALUE_CHARS,
        ),
      });
    }
  }

  const seen = new Set(facts.map((fact) => fact.key));
  let diagnosticCount = 0;
  for (const diagnostic of input.diagnostics ?? []) {
    if (diagnosticCount >= MAX_DIAGNOSTIC_FACTS) break;
    const frontier = frontierFact(diagnostic.detail);
    if (frontier && !seen.has(frontier.key)) {
      facts.push(frontier);
      seen.add(frontier.key);
    }
    const code = diagnosticCode(diagnostic);
    if (!code) continue;
    const key = `refusal:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnosticCount += 1;
    const message = diagnostic.message?.trim();
    facts.push({
      key,
      label: "Refused",
      value: clip(message ? `${code} — ${message}` : code, MAX_FACT_VALUE_CHARS),
    });
  }

  const requiredAction = input.blocker?.requiredAction?.trim();
  if (requiredAction && requiredAction !== "none") {
    facts.push({
      key: "required_action",
      label: "Required action",
      value: clip(requiredAction, MAX_FACT_VALUE_CHARS),
    });
  }

  const nodeId = input.activeNodeId?.trim();
  if (nodeId && nodeId !== "none") {
    facts.push({
      key: "stalled_node",
      label: "Stalled at",
      value: clip(nodeId, MAX_FACT_VALUE_CHARS),
    });
  }

  return facts;
}

export function runFailureEvidenceHeadingV1(): string {
  return "What actually happened";
}

/**
 * Trace ids the runner attests specifically so a refusal is readable after the
 * fact. `cc9f06e` added `:create-file-collision-replan-failed` for exactly this
 * reason: without it a refused repair looked only like a model that stopped
 * calling tools. Suffix matching keeps new attestations readable here without
 * a second allowlist to maintain in lockstep.
 */
const REFUSAL_TRACE_ID = /(?:rejected|refused|blocked|failed|denied|unavailable|noncompliance|deadlock|mismatch)$/i;

export function isRunFailureDiagnosticTraceV1(event: {
  id?: string | null;
  kind?: string | null;
  error?: { code?: string | null } | null;
}): boolean {
  if (event.error?.code) return true;
  if (event.kind === "error" || event.kind === "tool_rejected") return true;
  const id = event.id ?? "";
  const suffix = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
  return REFUSAL_TRACE_ID.test(suffix);
}

/**
 * The narrative keeps its place only when it is not the misdirection. When it
 * blames the model or the provider and we hold checkable artifacts, say so
 * explicitly rather than repeating the claim above the evidence that
 * contradicts it.
 */
export function reframeBlockedWhyV1(input: {
  why: string;
  facts: readonly RunFailureFactV1[];
}): string {
  const why = input.why.trim();
  if (input.facts.length === 0 || !narrativeBlamesTheModelV1(why)) {
    return why;
  }
  return `${why} (The run reported this itself; the facts above are what it actually recorded, and they usually name the real cause.)`;
}

/**
 * One-line blocked summary for surfaces that have room for a sentence and no
 * room for a table — the developer-mission completion card, the Orchestrator
 * strip. When the narrative misdirects, the leading fact goes first so the
 * reader sees a checkable thing before an explanation.
 */
export function blockedSummaryFromFactsV1(input: {
  summary: string;
  facts: readonly RunFailureFactV1[];
}): string {
  const summary = input.summary.trim();
  const lead = input.facts[0];
  if (!lead || !narrativeBlamesTheModelV1(summary)) {
    return summary;
  }
  return `${lead.label}: ${lead.value} — ${summary}`;
}
