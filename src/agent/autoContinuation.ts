import {
  computeProofDebt,
  type ProofDebt,
  type ProofDebtSnapshot,
} from "./proofDebt";
import type { CompletionReflectionResult } from "./completionReflection";

export type AutoContinuationReason =
  | "not_budget"
  | "budget_exhausted"
  | "proof_satisfied"
  | "blocked"
  | "acceptance_failed"
  | "required_tool_failure"
  | "segment_cap";

export interface AutoContinuationDecision {
  recommended: boolean;
  reason: AutoContinuationReason;
}

export interface AutoContinuationDecisionInput {
  stopReason: string;
  acceptance?: {
    status: string;
    reasons?: string[];
    missing?: string[];
    nextAction?: string;
  };
  blockerCategory?: string;
  blockerCount?: number;
  missionPlanStatus?: string;
  /**
   * Optional durable snapshot. When provided, proof debt is recomputed and
   * overrides narrative acceptance/nextAction for empty/blocked decisions.
   */
  proofDebtSnapshot?: ProofDebtSnapshot | null;
  /** Precomputed debt; still preferred over stored nextAction strings alone. */
  proofDebt?: ProofDebt | null;
  /** Soft multi-segment loops driven by unpaid completion reflection. */
  completionDriven?: boolean;
  reflection?: CompletionReflectionResult | null;
  segmentsUsed?: number;
  maxSegments?: number;
}

/**
 * Automatic child segments are only for unfinished work that exhausted a
 * normal step or wall-clock budget. A blocker or failed required tool needs a
 * visible user/recovery decision instead of replaying the same failure through
 * every configured segment. Empty or blocked proof debt also refuses continue.
 *
 * When completionDriven is on, continue while unpaid debt or incomplete
 * reflection remains and the soft segment budget has room.
 */
export function decideAutoContinuation({
  stopReason,
  acceptance,
  blockerCategory,
  blockerCount = 0,
  missionPlanStatus,
  proofDebtSnapshot,
  proofDebt,
  completionDriven = false,
  reflection = null,
  segmentsUsed,
  maxSegments,
}: AutoContinuationDecisionInput): AutoContinuationDecision {
  if (stopReason !== "budget") {
    return { recommended: false, reason: "not_budget" };
  }

  const failedRequiredTool =
    acceptance?.status !== "pass" &&
    acceptance?.reasons?.some((reason) => /^failed_tools=/i.test(reason)) === true;
  if (failedRequiredTool) {
    return { recommended: false, reason: "required_tool_failure" };
  }

  const debt =
    proofDebt ??
    (proofDebtSnapshot
      ? computeProofDebt({
          ...proofDebtSnapshot,
          acceptance: proofDebtSnapshot.acceptance ?? acceptance,
          blockerCategory:
            proofDebtSnapshot.blockerCategory ?? blockerCategory,
          blockers:
            proofDebtSnapshot.blockers ??
            (blockerCount > 0 ? [`blocker_count:${blockerCount}`] : undefined),
        })
      : null);

  if (debt?.blocked) {
    return { recommended: false, reason: "blocked" };
  }

  if (
    Boolean(blockerCategory) ||
    blockerCount > 0 ||
    missionPlanStatus === "blocked"
  ) {
    return { recommended: false, reason: "blocked" };
  }

  if (acceptance?.status === "fail") {
    return { recommended: false, reason: "acceptance_failed" };
  }

  const reflectionDone = reflection?.done === true;
  const debtEmpty = debt?.empty === true;
  const acceptancePass = acceptance?.status === "pass";

  if (reflectionDone && debtEmpty && acceptancePass) {
    return { recommended: false, reason: "proof_satisfied" };
  }

  if (completionDriven) {
    const withinSegmentBudget =
      typeof segmentsUsed !== "number" ||
      typeof maxSegments !== "number" ||
      segmentsUsed < maxSegments;
    if (!withinSegmentBudget) {
      return { recommended: false, reason: "segment_cap" };
    }
    if (!debtEmpty || !reflectionDone) {
      return { recommended: true, reason: "budget_exhausted" };
    }
    return { recommended: false, reason: "proof_satisfied" };
  }

  if (debtEmpty) {
    return { recommended: false, reason: "proof_satisfied" };
  }

  if (acceptancePass) {
    return { recommended: false, reason: "proof_satisfied" };
  }

  return { recommended: true, reason: "budget_exhausted" };
}
