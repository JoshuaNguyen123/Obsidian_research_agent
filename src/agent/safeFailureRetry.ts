/**
 * Bounded auto-retry for safe schema/model-only failures.
 *
 * INTEGRATOR (AgentRunner / runCoordinator): before surfacing a tool/model
 * failure to the user, call decideSafeFailureRetry. When action is
 * "auto_retry", re-issue the model step without a Continue click and emit
 * decision.progressLine via onStatus. Never auto-retry vault mutations that
 * may have applied, approvals, credentials, or policy blocks.
 */

import {
  modelRetryProgressCopy,
  schemaRetryProgressCopy,
  type FailureCopy,
  conversationalBlockerCopy,
} from "./failureCopy";

export type SafeFailureKind =
  | "schema"
  | "invalid_tool_args"
  | "model_transient"
  | "other";

export type SafeFailureRetryAction = "auto_retry" | "block" | "escalate";

export interface SafeFailureRetryState {
  version: 1;
  attemptsBySignature: Record<string, number>;
  maxAttempts: number;
  updatedAt: string;
}

export interface SafeFailureInput {
  source?: string;
  message?: string;
  code?: string;
  category?: string;
}

export interface SafeFailureClassification {
  kind: SafeFailureKind;
  safeToAutoRetry: boolean;
  reason: string;
}

export interface SafeFailureRetryDecision {
  action: SafeFailureRetryAction;
  kind: SafeFailureKind;
  signature: string;
  attemptsUsed: number;
  attemptsRemaining: number;
  progressLine: string;
  state: SafeFailureRetryState;
  copy?: FailureCopy;
}

export const DEFAULT_SAFE_FAILURE_MAX_ATTEMPTS = 2;

export function createSafeFailureRetryState(
  maxAttempts: number = DEFAULT_SAFE_FAILURE_MAX_ATTEMPTS,
  now: Date = new Date(),
): SafeFailureRetryState {
  return {
    version: 1,
    attemptsBySignature: {},
    maxAttempts: normalizeMaxAttempts(maxAttempts),
    updatedAt: now.toISOString(),
  };
}

export function normalizeSafeFailureRetryState(
  value: unknown,
  defaults: { maxAttempts?: number; now?: Date } = {},
): SafeFailureRetryState {
  const now = defaults.now ?? new Date();
  if (!isRecord(value) || value.version !== 1) {
    return createSafeFailureRetryState(defaults.maxAttempts, now);
  }
  const maxAttempts = normalizeMaxAttempts(
    getFiniteNumber(value.maxAttempts) ??
      defaults.maxAttempts ??
      DEFAULT_SAFE_FAILURE_MAX_ATTEMPTS,
  );
  const raw = isRecord(value.attemptsBySignature)
    ? value.attemptsBySignature
    : {};
  const attemptsBySignature = Object.entries(raw).reduce<Record<string, number>>(
    (output, [signature, count]) => {
      const normalized = getFiniteNumber(count);
      if (signature.trim() && normalized !== undefined && normalized >= 0) {
        output[signature] = Math.floor(normalized);
      }
      return output;
    },
    {},
  );
  return {
    version: 1,
    attemptsBySignature,
    maxAttempts,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : now.toISOString(),
  };
}

export function classifySafeFailureRetry(
  failure: SafeFailureInput,
): SafeFailureClassification {
  const source = String(failure.source ?? "").toLowerCase();
  const message = String(failure.message ?? "").toLowerCase();
  const code = String(failure.code ?? "").toLowerCase();
  const category = String(failure.category ?? "").toLowerCase();
  const blob = `${source} ${message} ${code} ${category}`;

  if (isUnsafeToAutoRetry(blob)) {
    return {
      kind: "other",
      safeToAutoRetry: false,
      reason: "Failure may have side effects or needs credentials/approval.",
    };
  }

  if (
    /invalid_arguments|invalid_argument|schema correction|schema validation|json schema|tool schema|malformed tool|invalid tool call|parse.?fail|failed to parse/i.test(
      blob,
    )
  ) {
    return {
      kind: /schema/i.test(blob) ? "schema" : "invalid_tool_args",
      safeToAutoRetry: true,
      reason: "Schema or tool-argument failure with no vault mutation applied.",
    };
  }

  const modelScoped =
    /^(model|chat|provider|ollama|openai)/i.test(source) ||
    category === "network" ||
    category === "timeout" ||
    category === "rate_limit" ||
    category === "provider_budget_exhausted";

  if (
    modelScoped &&
    (category === "network" ||
      category === "timeout" ||
      category === "rate_limit" ||
      category === "provider_budget_exhausted" ||
      /timeout|timed out|econnreset|temporarily unavailable|transient|503|502|429|rate.?limit/i.test(
        blob,
      ))
  ) {
    return {
      kind: "model_transient",
      safeToAutoRetry: true,
      reason: "Transient model/provider failure safe to retry in-process.",
    };
  }

  if (
    /model_offtrack|empty.?response|no tool calls|invalid response|finish_reason/i.test(
      blob,
    )
  ) {
    return {
      kind: "model_transient",
      safeToAutoRetry: true,
      reason: "Model response shape failure with no side effects.",
    };
  }

  return {
    kind: "other",
    safeToAutoRetry: false,
    reason: "Failure class is not eligible for silent auto-retry.",
  };
}

export function decideSafeFailureRetry(input: {
  failure: SafeFailureInput;
  state?: SafeFailureRetryState;
  maxAttempts?: number;
  now?: Date;
}): SafeFailureRetryDecision {
  const now = input.now ?? new Date();
  const previous = normalizeSafeFailureRetryState(input.state, {
    maxAttempts: input.maxAttempts ?? input.state?.maxAttempts,
    now,
  });
  const maxAttempts = normalizeMaxAttempts(
    input.maxAttempts ?? previous.maxAttempts,
  );
  const classification = classifySafeFailureRetry(input.failure);
  const signature = getSafeFailureSignature(input.failure, classification.kind);
  const attemptsUsed = previous.attemptsBySignature[signature] ?? 0;
  const nextAttempts = attemptsUsed + 1;
  const state: SafeFailureRetryState = {
    version: 1,
    maxAttempts,
    attemptsBySignature: {
      ...previous.attemptsBySignature,
      [signature]: nextAttempts,
    },
    updatedAt: now.toISOString(),
  };

  if (!classification.safeToAutoRetry) {
    return {
      action: "escalate",
      kind: classification.kind,
      signature,
      attemptsUsed: nextAttempts,
      attemptsRemaining: Math.max(0, maxAttempts - nextAttempts),
      progressLine: classification.reason,
      state,
      copy: conversationalBlockerCopy({
        kind: "generic",
        why: input.failure.message,
      }),
    };
  }

  if (attemptsUsed >= maxAttempts) {
    const copy = conversationalBlockerCopy({
      kind: "generic",
      what: "Automatic retries did not clear this model/schema failure.",
      why: input.failure.message?.trim() || classification.reason,
    });
    return {
      action: "block",
      kind: classification.kind,
      signature,
      attemptsUsed: nextAttempts,
      attemptsRemaining: 0,
      progressLine: `What: ${copy.what} Why: ${copy.why} Next: ${copy.next}`,
      state,
      copy,
    };
  }

  const attemptNumber = nextAttempts;
  const progressLine =
    classification.kind === "model_transient"
      ? modelRetryProgressCopy(attemptNumber, maxAttempts)
      : schemaRetryProgressCopy(attemptNumber, maxAttempts);

  return {
    action: "auto_retry",
    kind: classification.kind,
    signature,
    attemptsUsed: nextAttempts,
    attemptsRemaining: Math.max(0, maxAttempts - nextAttempts),
    progressLine,
    state,
  };
}

export function shouldAutoRetrySafeFailure(
  decision: SafeFailureRetryDecision,
): boolean {
  return decision.action === "auto_retry";
}

function isUnsafeToAutoRetry(blob: string): boolean {
  return (
    /partial_write|note apply|bytes.?written|receipt|approval|denied|missing_api_key|api key|credential|unauthorized|policy|phase_gate|reconcile_required|destructive|delete_|trash_/i.test(
      blob,
    )
  );
}

function getSafeFailureSignature(
  failure: SafeFailureInput,
  kind: SafeFailureKind,
): string {
  const source = String(failure.source ?? "model").trim() || "model";
  const code = String(failure.code ?? failure.category ?? kind)
    .toLowerCase()
    .trim();
  const message = String(failure.message ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${source}:${code}:${message}`;
}

function normalizeMaxAttempts(value: number): number {
  return Math.min(5, Math.max(1, Math.floor(value)));
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
