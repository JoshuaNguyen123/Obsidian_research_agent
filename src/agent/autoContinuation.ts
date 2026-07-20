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
 * When completionDriven is on, continue while unpaid proof debt or incomplete
 * reflection remains and the soft segment budget has room. Acceptance gaps
 * (`needs_more_work` / `fail` / non-empty `missing`) still count as unpaid debt
 * even if a stale `ProofDebt.empty` flag says otherwise.
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

  if (
    acceptance?.status === "fail" &&
    (!completionDriven || hasNonRecoverableAcceptanceFailure(acceptance))
  ) {
    return { recommended: false, reason: "acceptance_failed" };
  }

  const reflectionDone = reflection?.done === true;
  const debtEmpty = debt?.empty === true;
  const acceptancePass = acceptance?.status === "pass";
  const unpaidProofDebt = hasUnpaidProofDebt({
    debt,
    acceptance,
    completionDriven,
  });

  if (reflectionDone && !unpaidProofDebt && acceptancePass) {
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
    // Keep looping while proof debt remains or reflection is incomplete.
    if (unpaidProofDebt || !reflectionDone) {
      return { recommended: true, reason: "budget_exhausted" };
    }
    return { recommended: false, reason: "proof_satisfied" };
  }

  if (debtEmpty || !unpaidProofDebt) {
    return { recommended: false, reason: "proof_satisfied" };
  }

  if (acceptancePass) {
    return { recommended: false, reason: "proof_satisfied" };
  }

  return { recommended: true, reason: "budget_exhausted" };
}

/**
 * Unpaid proof for auto-continue.
 * - Non-empty debt always counts.
 * - Non-completion paths: empty debt overrides narrative acceptance (legacy).
 * - Completion-driven paths: acceptance gaps still count when debt is empty/missing
 *   so loops cannot stop early while `missing` / needs_more_work remain.
 */
function hasUnpaidProofDebt(input: {
  debt: ProofDebt | null;
  acceptance: AutoContinuationDecisionInput["acceptance"];
  completionDriven: boolean;
}): boolean {
  const { debt, acceptance, completionDriven } = input;
  if (debt && !debt.empty) {
    return true;
  }
  if (debt?.empty === true && !completionDriven) {
    return false;
  }
  return acceptanceStillOwesProof(acceptance);
}

function acceptanceStillOwesProof(
  acceptance: AutoContinuationDecisionInput["acceptance"],
): boolean {
  if (!acceptance) return false;
  if (acceptance.status === "pass") return false;
  if ((acceptance.missing?.length ?? 0) > 0) return true;
  return (
    acceptance.status === "needs_more_work" || acceptance.status === "fail"
  );
}

function hasNonRecoverableAcceptanceFailure(
  acceptance: NonNullable<AutoContinuationDecisionInput["acceptance"]>,
): boolean {
  const missing = acceptance.missing ?? [];
  const reasons = acceptance.reasons ?? [];
  return (
    missing.some(
      (item) =>
        item.startsWith("failed_goal:") ||
        item.startsWith("mission_plan_blocker:") ||
        item.startsWith("verifier:write_safety:"),
    ) ||
    reasons.includes("broad_unscoped_mutation_blocker_missing")
  );
}
