import type { ProofDebt } from "./proofDebt";

export interface CompletionReflectionResult {
  done: boolean;
  confidence: number;
  reason: string;
  remainingActions: string[];
}

/**
 * Pure completion reflection for soft multi-segment loops.
 * done=true only when acceptance passed, proof debt is empty, write goals are
 * clear, WAL reconcile is absent, and no open evidence conflicts remain.
 */
export function reflectMissionCompletion(input: {
  prompt: string;
  acceptance: { status: string; missing?: string[]; reasons?: string[] };
  proofDebt: ProofDebt;
  writeReceiptCount: number;
  pendingGoalIds?: string[];
  missionPlanStatus?: string;
}): CompletionReflectionResult {
  const acceptancePassed = input.acceptance.status === "pass";
  const pendingGoalIds = (input.pendingGoalIds ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const acceptanceMissing = (input.acceptance.missing ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  const hasPendingWriteGoals =
    pendingGoalIds.length > 0 ||
    acceptanceMissing.some(
      (item) =>
        item === "write_receipt" ||
        item.startsWith("pending_goal:") ||
        item.startsWith("failed_goal:"),
    );
  const hasWalReconcile =
    input.proofDebt.resumeBlocked ||
    input.proofDebt.missing.some((item) => item.startsWith("wal_reconcile:"));
  const hasOpenConflicts = input.proofDebt.openConflicts.length > 0;
  const missionPlanBlocked = input.missionPlanStatus === "blocked";

  const remainingActions = collectRemainingActions({
    proofDebt: input.proofDebt,
    acceptanceMissing,
    pendingGoalIds,
    hasPendingWriteGoals,
    writeReceiptCount: input.writeReceiptCount,
    missionPlanBlocked,
  });

  const done =
    acceptancePassed &&
    input.proofDebt.empty &&
    !hasPendingWriteGoals &&
    !hasWalReconcile &&
    !hasOpenConflicts &&
    !missionPlanBlocked &&
    !input.proofDebt.blocked;

  if (done) {
    return {
      done: true,
      confidence: 0.95,
      reason: "acceptance_pass_and_proof_clear",
      remainingActions: [],
    };
  }

  const reason = !acceptancePassed
    ? `acceptance_${input.acceptance.status || "unchecked"}`
    : hasWalReconcile
      ? "wal_reconcile_required"
      : hasOpenConflicts
        ? "open_evidence_conflicts"
        : hasPendingWriteGoals
          ? "pending_write_goals"
          : input.proofDebt.blocked
            ? "proof_debt_blocked"
            : !input.proofDebt.empty
              ? "unpaid_proof_debt"
              : missionPlanBlocked
                ? "mission_plan_blocked"
                : "mission_incomplete";

  return {
    done: false,
    confidence: acceptancePassed && remainingActions.length <= 1 ? 0.55 : 0.35,
    reason,
    remainingActions,
  };
}

function collectRemainingActions(input: {
  proofDebt: ProofDebt;
  acceptanceMissing: string[];
  pendingGoalIds: string[];
  hasPendingWriteGoals: boolean;
  writeReceiptCount: number;
  missionPlanBlocked: boolean;
}): string[] {
  const actions: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !actions.includes(trimmed)) {
      actions.push(trimmed);
    }
  };

  if (input.proofDebt.blocked || input.proofDebt.resumeBlocked) {
    push(input.proofDebt.nextAction.summary || input.proofDebt.nextAction.reason);
  } else if (!input.proofDebt.empty) {
    push(
      input.proofDebt.nextAction.toolName
        ? `${input.proofDebt.nextAction.toolName}: ${input.proofDebt.nextAction.reason}`
        : input.proofDebt.nextAction.summary || input.proofDebt.nextAction.reason,
    );
  }

  for (const conflict of input.proofDebt.openConflicts) {
    push(`Resolve open evidence conflict: ${conflict.summary}`);
  }

  for (const missing of input.proofDebt.missing) {
    push(`Pay proof debt: ${missing}`);
  }

  for (const missing of input.acceptanceMissing) {
    push(`Acceptance missing: ${missing}`);
  }

  for (const goalId of input.pendingGoalIds) {
    push(`Complete pending write goal: ${goalId}`);
  }

  if (input.hasPendingWriteGoals && input.writeReceiptCount === 0) {
    push("Record a write receipt for the required note mutation.");
  }

  if (input.missionPlanBlocked) {
    push("Resolve the blocked mission-plan task before continuing.");
  }

  return actions;
}
