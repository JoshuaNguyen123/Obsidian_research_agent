/**
 * Fault attribution for a failed mission-graph node.
 *
 * The eval CSV has carried a `product:` / `model:` / `external:` vocabulary for
 * months, but only in prose written by a human after the run. Nothing at
 * runtime could tell those apart, so retry policy had exactly one lever for
 * every failure: try the same thing again, then stop. A dead URL, a schema
 * mistake, and an authority refusal all ended the same way.
 *
 * This classifier gives the live loop that axis. It is deliberately NOT the
 * eval taxonomy — that one grades the whole run in hindsight and includes
 * `harness:` and `process:` classes no running plugin can observe about
 * itself. The mapping for anyone reconciling the two:
 *
 *   external       -> external:*
 *   model_transient-> model:*     (shape failures; the call itself completed)
 *   model_content  -> model:*     (arguments or produced content were wrong)
 *   product        -> product:*
 *   unknown        -> (classify by hand; a growing count here means this
 *                      module is behind the code vocabulary)
 *
 * Every rule below reads a signal that already exists. The classifier never
 * throws and never guesses: anything it cannot attribute is `unknown`, which
 * callers must treat as "no special handling earned", never as a licence to
 * relax a guard.
 */

import { isModelRequestTimeoutError, isTransientModelError } from "../model/retry";
import {
  classifySafeFailureRetry,
  codeNamesItsOwnArgumentFaultV1,
} from "./safeFailureRetry";

export type MissionFailureClassV1 =
  | "external"
  | "model_transient"
  | "model_content"
  | "product"
  | "unknown";

export interface MissionFailureSignalsV1 {
  toolName?: string;
  /** `ToolExecutionResult.error.code`, or a thrown `ToolExecutionError.code`. */
  errorCode?: string;
  errorMessage?: string;
  /** `ModelClientErrorCategory` when the failure came from a model call. */
  modelErrorCategory?: string;
  /** Remote status when the caller already parsed one. */
  httpStatus?: number;
  /** The raw error, when the caller still holds it. */
  error?: unknown;
}

/**
 * A remote dependency failed: a web source, an integration API, or the model
 * provider. The work was well-formed; something we do not control refused it.
 * Substitution — a different source, a different provider — is the repair.
 */
const EXTERNAL_TOOL_ERROR_CODES = new Set([
  "source_http_error",
  "source_unusable",
  "extension_unavailable",
  "linear_not_found",
  "github_not_found",
  "provider_unavailable",
]);

/**
 * Our own host contract refused the call. Retrying it unchanged is guaranteed
 * to be refused again; the model must take a materially different route.
 */
const PRODUCT_ERROR_CODES = new Set([
  "tool_not_allowed",
  "mission_graph_authority_blocked",
  "authority_grant_invalid",
  "authorization_mismatch",
  "prepared_action_required",
  "invalid_prepared_action",
  "fingerprint_mismatch",
  "intent_required",
  "unsafe_path",
  "vault_precondition_changed",
  "vault_readback_failed",
  "operation_deadline_exceeded",
  "reconcile_required",
  // The pre-write proof gate refused a write whose evidence debt is unpaid.
  // Repeating the write cannot pay it; only a search/fetch/read can, so the
  // retry policy must treat it as a route change, not an unknown blip.
  "proof_gated_writeback_required",
]);

/**
 * The model's arguments or produced content were wrong. Same conclusion as a
 * product refusal for retry purposes — a different approach, not a repeat —
 * but a different owner, which matters when reading the eval record.
 */
const MODEL_CONTENT_ERROR_CODES = new Set([
  "invalid_arguments",
  "invalid_tool_args",
  "template_verification_failed",
  "research_pack_verification_failed",
  "schema_validation_failed",
  // `create_project_idea_brief` refuses a payload that fails its closed
  // contract — a bad grounding reference, an option list that does not
  // typecheck, a missing acceptance criterion — and nothing was applied. It is
  // an argument fault by definition, but its name does not say so, so no
  // structural rule can reach it: `_invalid` is 106 codes in this repo and
  // most of them are refusals or host state. It is listed here by hand, which
  // is the cost of a code that does not name its own fault. A 504-run cohort
  // ended on this one because all three mechanisms below read it as "cause
  // unknown".
  "project_idea_brief_invalid",
]);

/**
 * The single authority on "the model's arguments or produced content were
 * rejected". Three subsystems needed this answer and each had its own
 * spelling of it — this set, a regex in `safeFailureRetry`, and a private
 * suffix test in `AgentRunner` — so a code could be an argument error to one
 * of them and a mystery to the other two, which is exactly what happened to
 * `project_idea_brief_invalid`. They all read this now, so a new validator
 * opts in once.
 *
 * It is fail-closed on purpose: a code the external or product sets already
 * claim can never also be an argument error, whatever its spelling. A refusal
 * that started claiming to be a correctable argument fault would tell the
 * model to resend the same call with tidier arguments and would exempt a real
 * block from the failed-tool count, which is worse than not recognising the
 * argument fault at all.
 */
export function isModelContentErrorCodeV1(code: string | undefined): boolean {
  const normalized = normalize(code);
  if (!normalized) return false;
  if (EXTERNAL_TOOL_ERROR_CODES.has(normalized)) return false;
  if (PRODUCT_ERROR_CODES.has(normalized)) return false;
  if (
    normalized.startsWith("approval_") ||
    normalized.startsWith("phase_gate")
  ) {
    return false;
  }
  return (
    MODEL_CONTENT_ERROR_CODES.has(normalized) ||
    codeNamesItsOwnArgumentFaultV1(normalized)
  );
}

/** Attribute a node failure to whoever actually failed. Never throws. */
export function classifyMissionFailureV1(
  signals: MissionFailureSignalsV1,
): MissionFailureClassV1 {
  try {
    return classifyUnsafe(signals);
  } catch {
    return "unknown";
  }
}

/**
 * True when the failure is nobody's mistake — the same request may simply
 * succeed next time. Retry variation exists for the failures this excludes.
 */
export function missionFailureRepeatsUsefullyV1(
  failureClass: MissionFailureClassV1,
): boolean {
  return failureClass === "external" || failureClass === "model_transient";
}

function classifyUnsafe(
  signals: MissionFailureSignalsV1,
): MissionFailureClassV1 {
  const code = normalize(signals.errorCode);
  const message = normalize(signals.errorMessage);
  const category = normalize(signals.modelErrorCategory);

  // Explicit codes are the most precise signal available, so they decide
  // before any heuristic gets a vote.
  if (code) {
    if (EXTERNAL_TOOL_ERROR_CODES.has(code)) return "external";
    if (PRODUCT_ERROR_CODES.has(code)) return "product";
    if (code.startsWith("approval_") || code.startsWith("phase_gate")) {
      return "product";
    }
    // Asked after the refusal sets, and fail-closed against them anyway, so
    // the two orderings cannot drift apart.
    if (isModelContentErrorCodeV1(code)) return "model_content";
  }

  if (signals.error !== undefined && signals.error !== null) {
    if (isModelRequestTimeoutError(signals.error)) return "external";
    if (isTransientModelError(signals.error)) return "external";
  }

  // A model-provider category is provider-side by construction, except
  // invalid_response, which means the provider answered with something the
  // client could not use.
  if (category) {
    if (
      category === "network" ||
      category === "rate_limit" ||
      category === "provider_budget_exhausted"
    ) {
      return "external";
    }
    if (category === "api") {
      return (signals.httpStatus ?? 0) >= 500 ? "external" : "product";
    }
    if (category === "auth" || category === "missing_api_key") return "product";
    if (category === "invalid_response") return "model_transient";
  }

  const status = signals.httpStatus ?? readStatusFromMessage(message);
  if (status !== undefined && status >= 400) {
    // 401/403 are our credentials, not the remote's fault.
    return status === 401 || status === 403 ? "product" : "external";
  }

  // Fall through to the retry classifier the model loop already trusts. Its
  // axis is "safe to reissue silently", not fault, so only its two decisive
  // kinds are borrowed and its `other` bucket is left alone.
  const safeFailure = classifySafeFailureRetry({
    source: signals.toolName,
    code: signals.errorCode,
    message: signals.errorMessage,
    category: signals.modelErrorCategory,
  });
  if (safeFailure.kind === "schema" || safeFailure.kind === "invalid_tool_args") {
    return "model_content";
  }
  if (safeFailure.kind === "model_transient") {
    // That kind covers both provider blips and empty/off-track responses;
    // the message decides which, because the repair differs.
    return /timeout|timed out|econnreset|network|unavailable|429|502|503|504/u.test(
      message,
    )
      ? "external"
      : "model_transient";
  }

  return "unknown";
}

function readStatusFromMessage(message: string): number | undefined {
  const match = /\b(?:status|http|code)\D{0,4}([45]\d\d)\b/u.exec(message);
  return match ? Number(match[1]) : undefined;
}

function normalize(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}
