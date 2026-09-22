/**
 * Interactive auto-recovery: continue a mission on its own after a transient
 * provider failure instead of leaving it Idle for a click.
 *
 * `decideAutoContinuation` owns budget pauses and deliberately refuses every
 * non-budget stop ("Continue is operator-driven" for graph blockers). This
 * sibling decides one other thing only: a terminal `error` whose cause the
 * durable/overnight path already treats as transient — the same predicate,
 * `isTransientAgentRunError`, so the two paths cannot disagree about what
 * "transient" means. Everything else (graph blockers, approvals, credentials,
 * repeated tool failures) stays a human decision.
 */

import { isTransientAgentRunError } from "./agentRunnerDurableAdapter";
import {
  fromAgentRunStopReason,
  type AgentRunStopReasonLike,
} from "./missionStopReason";

/** Recoveries per root mission; each one is a whole continuation segment. */
export const MAX_AUTO_RECOVERIES_PER_MISSION = 2;
/**
 * The longest a recovery will wait for the endpoint breaker to admit a probe
 * before continuing. A breaker paused for longer than this means the provider
 * has been failing for minutes, which is a human's call, not a retry.
 */
export const MAX_AUTO_RECOVERY_WAIT_MS = 120_000;
/** First recovery waits this long even with no breaker open; doubles after. */
export const AUTO_RECOVERY_BASE_DELAY_MS = 2_000;
/** Margin past the breaker's own clock so `admit()` sees the cooldown elapsed. */
const BREAKER_PROBE_MARGIN_MS = 250;

export type AutoRecoveryReason =
  | "transient_provider_error"
  | "aborted"
  | "no_run_id"
  | "not_error"
  | "not_provider_error"
  | "not_transient"
  | "provider_paused"
  | "recovery_cap";

export interface AutoRecoveryDecision {
  recommended: boolean;
  reason: AutoRecoveryReason;
}

export interface AutoRecoveryInput {
  stopReason: AgentRunStopReasonLike;
  stopDetail?: string | null;
  /** The last `error`-kind trace the segment emitted, if any. */
  lastError?: { code: string; message: string } | null;
  recoveriesUsed: number;
  maxRecoveries?: number;
  abortRequested: boolean;
  /** The segment's durable run id; a run with none cannot be continued. */
  runId: string | null;
  /**
   * How long the endpoint breaker still refuses calls (0 when closed). A
   * continuation started inside that window fails fast on the breaker and
   * spends a recovery without reaching the provider, so a pause longer than
   * `maxWaitMs` refuses instead.
   */
  providerRetryAfterMs?: number;
  maxWaitMs?: number;
}

export function decideAutoRecovery(input: AutoRecoveryInput): AutoRecoveryDecision {
  if (input.abortRequested) {
    return { recommended: false, reason: "aborted" };
  }
  if (!input.runId) {
    return { recommended: false, reason: "no_run_id" };
  }
  if (input.stopReason !== "error") {
    return { recommended: false, reason: "not_error" };
  }
  // Graph blockers and orchestration deadlocks classify away from
  // provider_error here; they keep their operator-driven Continue.
  if (fromAgentRunStopReason("error", input.stopDetail) !== "provider_error") {
    return { recommended: false, reason: "not_provider_error" };
  }
  if (!isTransientAgentRunError(input.lastError ?? undefined)) {
    return { recommended: false, reason: "not_transient" };
  }
  const cap = Math.max(
    0,
    Math.trunc(input.maxRecoveries ?? MAX_AUTO_RECOVERIES_PER_MISSION),
  );
  if (input.recoveriesUsed >= cap) {
    return { recommended: false, reason: "recovery_cap" };
  }
  const retryAfterMs = Math.max(0, input.providerRetryAfterMs ?? 0);
  const maxWaitMs = Math.max(0, input.maxWaitMs ?? MAX_AUTO_RECOVERY_WAIT_MS);
  if (retryAfterMs + BREAKER_PROBE_MARGIN_MS > maxWaitMs) {
    return { recommended: false, reason: "provider_paused" };
  }
  return { recommended: true, reason: "transient_provider_error" };
}

/**
 * How long to wait before a recovery continuation starts: the breaker's own
 * clock (plus a margin so its `admit()` sees the cooldown elapsed) or a small
 * doubling backoff, whichever is longer. Never above `maxWaitMs`, because
 * `decideAutoRecovery` already refused anything that would need more.
 */
export function planAutoRecoveryWaitMsV1(input: {
  /** 1-based index of the recovery about to start. */
  recovery: number;
  providerRetryAfterMs: number;
  baseDelayMs?: number;
  maxWaitMs?: number;
}): number {
  const recovery = Math.max(1, Math.trunc(input.recovery));
  const baseDelayMs = Math.max(0, input.baseDelayMs ?? AUTO_RECOVERY_BASE_DELAY_MS);
  const maxWaitMs = Math.max(0, input.maxWaitMs ?? MAX_AUTO_RECOVERY_WAIT_MS);
  const backoffMs = baseDelayMs * 2 ** (recovery - 1);
  const retryAfterMs = Math.max(0, input.providerRetryAfterMs);
  const breakerWaitMs = retryAfterMs > 0 ? retryAfterMs + BREAKER_PROBE_MARGIN_MS : 0;
  return Math.min(maxWaitMs, Math.max(backoffMs, breakerWaitMs));
}

/**
 * One plain sentence per outcome for Run Details, so a mission that stopped
 * for a click says why the host did not continue on its own.
 */
export function describeAutoRecoveryReasonV1(reason: AutoRecoveryReason): string {
  switch (reason) {
    case "transient_provider_error":
      return "the provider error was transient; continuing on its own";
    case "aborted":
      return "the run was stopped";
    case "no_run_id":
      return "the run never published an id to continue from";
    case "not_error":
      return "the run did not end on an error";
    case "not_provider_error":
      return "the error was not a provider error; a graph blocker or deadlock keeps its operator-driven Continue";
    case "not_transient":
      return "the provider error was not transient (credentials, permissions, or a rejected request)";
    case "provider_paused":
      return `the provider endpoint is paused for longer than the ${Math.round(MAX_AUTO_RECOVERY_WAIT_MS / 1000)} s a recovery will wait`;
    case "recovery_cap":
      return `the mission already used its ${MAX_AUTO_RECOVERIES_PER_MISSION} automatic recoveries`;
  }
}
