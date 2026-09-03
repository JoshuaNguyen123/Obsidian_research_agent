/**
 * Chat / Run Details presenter for why Continue is off.
 *
 * WS-3 owns the decision (`AutoContinuationDecision.suppressionReason`).
 * This module only turns a decision the view already received into a
 * user-readable sentence. It does not invent runner wiring.
 *
 * INTEGRATION REQUEST (WS-1 / AgentRunner):
 * `completeRun` currently flattens `{ autoContinueRecommended, autoContinueReason }`
 * and drops `autoContinuation` / `suppressionReason`. On
 * `suppressAutoContinuation` it still emits `{ recommended: false, reason: "not_budget" }`
 * instead of `suppressedBudgetContinuationDecisionV1(...)`. Thread the full
 * decision (or at least `suppressionReason`) on `AgentRunCompleteEvent` so Chat
 * can render the official sentence instead of the generic not-budget fallback.
 */

import {
  formatAutoContinuationSuppressionReason,
  type AutoContinuationReason,
} from "../agent/autoContinuation";

/** View-local complete payload. Runner fields beyond the flattened pair are optional. */
export type AgentRunCompleteEventView = {
  stopReason?: string;
  autoContinueRecommended?: boolean;
  autoContinueReason?: string;
  suppressionReason?: string | null;
  autoContinuation?: {
    recommended?: boolean;
    reason?: string;
    suppressionReason?: string | null;
  };
};

export type ContinuationSuppressionDecision = {
  recommended?: boolean;
  reason?: string;
  suppressionReason?: string | null;
};

/**
 * Given a continuation decision, return the user-readable why-Continue-is-off
 * sentence, or null when Continue is recommended or no sentence is available.
 */
export function continuationSuppressionSentence(
  decision: ContinuationSuppressionDecision | null | undefined,
): string | null {
  if (!decision || decision.recommended !== false) {
    return null;
  }
  const explicit = decision.suppressionReason?.trim();
  return explicit || null;
}

/**
 * Lift flattened complete-event fields into a decision the presenter can read.
 *
 * When the runner omitted `suppressionReason` on a budget refusal, attach the
 * exported format-helper copy so Chat still has a sentence. Non-budget stops
 * stay silent — "Continue is off because this stop is not a budget pause" must
 * not appear after a successful finish or a provider error.
 */
export function continuationDecisionFromCompleteEvent(
  event: AgentRunCompleteEventView | null | undefined,
): ContinuationSuppressionDecision | null {
  if (!event) {
    return null;
  }
  const nested = event.autoContinuation;
  const recommended = nested?.recommended ?? event.autoContinueRecommended;
  const reason = nested?.reason ?? event.autoContinueReason;
  const explicit =
    nested?.suppressionReason?.trim() ||
    event.suppressionReason?.trim() ||
    "";
  if (
    recommended === undefined &&
    (reason === undefined || reason === "") &&
    !explicit
  ) {
    return null;
  }
  const formatted =
    !explicit &&
    event.stopReason === "budget" &&
    recommended === false &&
    reason &&
    isAutoContinuationReason(reason)
      ? formatAutoContinuationSuppressionReason(reason)
      : "";
  return {
    recommended,
    reason,
    suppressionReason: explicit || formatted || undefined,
  };
}

export function continuationSuppressionSentenceFromCompleteEvent(
  event: AgentRunCompleteEventView | null | undefined,
): string | null {
  return continuationSuppressionSentence(
    continuationDecisionFromCompleteEvent(event),
  );
}

function isAutoContinuationReason(
  value: string,
): value is AutoContinuationReason {
  switch (value) {
    case "not_budget":
    case "budget_exhausted":
    case "proof_satisfied":
    case "blocked":
    case "acceptance_failed":
    case "required_tool_failure":
    case "segment_cap":
    case "effect_class_blocked":
    case "no_progress":
      return true;
    default:
      return false;
  }
}
