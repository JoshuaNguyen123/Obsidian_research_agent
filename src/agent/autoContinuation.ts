import {
  computeProofDebt,
  type ProofDebt,
  type ProofDebtSnapshot,
} from "./proofDebt";
import type { CompletionReflectionResult } from "./completionReflection";

import {
  effectClassForTool,
  effectClassForTools,
  mayAutoExecute,
  type AutonomyEffectClass,
  type AutonomyProfile,
} from "./autonomyEffectClass";
import { pendingToolsAllowSetLooseWithoutGrant } from "./setLooseCompoundAutonomy";

const MAX_FOREGROUND_COMPLETION_SEGMENTS = 48;
const ADAPTIVE_LEAD_SEGMENT_STEPS = 10;

/**
 * Resolve the host's foreground segment ceiling without silently shrinking the
 * configured completion budget. Proof debt, no-progress detection, approvals,
 * and the run wall-clock remain the actual continuation gates.
 */
export function resolveForegroundSegmentLimit(input: {
  autoContinue: boolean;
  completionDriven: boolean;
  configuredCompletionSegments?: number;
  configuredLongRunSegments?: number;
  explicitLongRunningResearch: boolean;
}): number {
  if (!input.autoContinue) return 1;
  if (input.completionDriven) {
    return clampSegmentLimit(
      input.configuredCompletionSegments,
      24,
      MAX_FOREGROUND_COMPLETION_SEGMENTS,
    );
  }
  return Math.min(
    input.explicitLongRunningResearch ? 3 : 1,
    clampSegmentLimit(input.configuredLongRunSegments, 2, 24),
  );
}

/**
 * Give the adaptive-team Lead enough bounded slices to spend its existing
 * model-step budget. This does not raise autonomy: the configured completion
 * ceiling, shared tool budget, no-progress detector, approvals, and wall-clock
 * deadline still gate every continuation.
 */
export function resolveAdaptiveLeadSegmentLimitV1(input: {
  leadModelSteps: number;
  configuredCompletionSegments?: number;
}): number {
  const modelSteps =
    Number.isFinite(input.leadModelSteps) && input.leadModelSteps > 0
      ? Math.trunc(input.leadModelSteps)
      : 1;
  const slicesRequired = Math.max(
    1,
    Math.ceil(modelSteps / ADAPTIVE_LEAD_SEGMENT_STEPS),
  );
  const configuredLimit = resolveForegroundSegmentLimit({
    autoContinue: true,
    completionDriven: true,
    configuredCompletionSegments: input.configuredCompletionSegments,
    explicitLongRunningResearch: false,
  });
  return Math.min(slicesRequired, configuredLimit);
}

function clampSegmentLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : fallback;
  return Math.max(1, Math.min(maximum, candidate));
}

/**
 * Prefer Bound required writes over Soft proof-debt next tools.
 * Soft research often leaves write_receipt debt mapped to append; when the
 * mission still owes replace_current_file (or another Bound write), auto-
 * continue must gate on that Bound tool + grant instead.
 */
export function resolvePendingToolsForAutoContinuation(input: {
  debtPendingToolNames?: readonly string[] | null;
  pendingRequiredWrites?: readonly string[] | null;
}): string[] {
  const required = (input.pendingRequiredWrites ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const boundRequired = required.filter(
    (toolName) => effectClassForTool(toolName) === "bound",
  );
  if (boundRequired.length > 0) {
    return boundRequired;
  }
  return (input.debtPendingToolNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
}

export type AutoContinuationReason =
  | "not_budget"
  | "budget_exhausted"
  | "proof_satisfied"
  | "blocked"
  | "acceptance_failed"
  | "required_tool_failure"
  | "segment_cap"
  | "effect_class_blocked"
  | "no_progress";

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
  /** Host segment index (0-based); required with maxSegments for segment_cap. */
  segmentsUsed?: number;
  /** Host soft segment budget from main.ts multi-segment loops. */
  maxSegments?: number;
  /** Soft/Bound/Hard gate for unpaid pending tools (Integrator wires). */
  pendingToolNames?: readonly string[];
  pendingEffectClass?: AutonomyEffectClass;
  autonomyProfile?: AutonomyProfile;
  /**
   * True when Bound pending tools have an unused exact prepared grant/approval.
   * Soft under automatic does not require this; Hard never auto-continues.
   */
  hasMatchingGrant?: boolean;
  /**
   * When true with automatic profile, Bound set-loose tools continue without a
   * Chat grant (compound lifecycle detected by the host).
   */
  compoundLifecycleDetected?: boolean;
  /**
   * Host-computed durable comparison: this resumed segment completed no
   * effectful successful tool and did not change frontier, proof debt, or
   * durable proof surfaces. Successful reads do not defeat this circuit.
   */
  unchangedReadOnlySegment?: boolean;
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
  pendingToolNames,
  pendingEffectClass,
  autonomyProfile = "automatic",
  hasMatchingGrant = false,
  compoundLifecycleDetected = false,
  unchangedReadOnlySegment = false,
}: AutoContinuationDecisionInput): AutoContinuationDecision {
  if (stopReason !== "budget") {
    return { recommended: false, reason: "not_budget" };
  }

  // Set-loose compound budget segments must stay Continue-able while acceptance
  // still needs work. Stale narrative blockerCategory values (often misclassified
  // "blocked" tool deferrals → safety_policy) and soft idempotent failures
  // (e.g. code_workspace_create workspace_exists) must not suppress auto-continue.
  const setLooseUnfinished =
    compoundLifecycleDetected === true &&
    acceptance?.status === "needs_more_work";

  const failedRequiredTool =
    acceptance?.status !== "pass" &&
    acceptance?.reasons?.some((reason) => /^failed_tools=/i.test(reason)) === true;
  if (failedRequiredTool && !setLooseUnfinished) {
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

  if (debt?.blocked && !setLooseUnfinished) {
    return { recommended: false, reason: "blocked" };
  }

  if (
    !setLooseUnfinished &&
    (Boolean(blockerCategory) ||
      blockerCount > 0 ||
      missionPlanStatus === "blocked")
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

  const pendingClass: AutonomyEffectClass | null =
    pendingEffectClass ??
    (pendingToolNames && pendingToolNames.length > 0
      ? effectClassForTools(pendingToolNames)
      : null);
  const setLooseBoundWithoutGrant =
    compoundLifecycleDetected === true &&
    pendingToolsAllowSetLooseWithoutGrant({
      pendingToolNames: pendingToolNames ?? [],
      autonomyProfile,
      compoundLifecycleDetected,
    });
  const allowEffectContinue =
    pendingClass === null ||
    mayAutoExecute({
      effectClass: pendingClass,
      autonomyProfile,
      hasMatchingGrant,
      setLooseBoundWithoutGrant,
    });

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
      if (!allowEffectContinue) {
        return { recommended: false, reason: "effect_class_blocked" };
      }
      if (unchangedReadOnlySegment) {
        return { recommended: false, reason: "no_progress" };
      }
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

  if (!allowEffectContinue) {
    return { recommended: false, reason: "effect_class_blocked" };
  }

  if (unchangedReadOnlySegment) {
    return { recommended: false, reason: "no_progress" };
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
