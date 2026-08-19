import type { ProofDebt } from "./proofDebt";
import type { ReflectionContextV1 } from "./pipelineLineage";
import {
  buildInitiatingNoteReflectionV1,
  type InitiatingNoteReflectionInputV1,
  type InitiatingNoteReflectionPlanV1,
} from "./initiatingNoteReflection";

export interface CompletionReflectionResult {
  done: boolean;
  confidence: number;
  reason: string;
  remainingActions: string[];
  /** Host-synthesized evidence context; never reconstructed from model prose. */
  context?: ReflectionContextV1;
}

/**
 * Coordinator-facing compound completion bundle.
 *
 * Call after acceptance/proof reflection when a compound mission finishes:
 * - `completion` drives auto-continue / Idle
 * - `initiatingNote` is the ledger-cited note (or Chat-only) write plan
 * - receipts stay on `completion.context.receiptIds` for Run Details
 */
export interface CompoundCompletionReflectionV1 {
  version: 1;
  completion: CompletionReflectionResult;
  initiatingNote: InitiatingNoteReflectionPlanV1;
}

export type ReflectMissionCompletionInput = {
  prompt: string;
  acceptance: { status: string; missing?: string[]; reasons?: string[] };
  proofDebt: ProofDebt;
  writeReceiptCount: number;
  pendingGoalIds?: string[];
  missionPlanStatus?: string;
  reflectionContext?: ReflectionContextV1;
};

/**
 * Pure completion reflection for soft multi-segment loops.
 * done=true only when acceptance passed, proof debt is empty, write goals are
 * clear, WAL reconcile is absent, and no open evidence conflicts remain.
 */
export function reflectMissionCompletion(
  input: ReflectMissionCompletionInput,
): CompletionReflectionResult {
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
      ...(input.reflectionContext
        ? { context: input.reflectionContext }
        : {}),
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
    ...(input.reflectionContext ? { context: input.reflectionContext } : {}),
  };
}

/**
 * Public coordinator API for compound completion.
 *
 * 1. Build lineage + ReflectionContextV1 (Run Details).
 * 2. Call this with the same reflectionContext.
 * 3. If `initiatingNote.shouldWriteNote`, append `initiatingNote.markdown`
 *    to the initiating note (marker-idempotent helpers in initiatingNoteReflection).
 * 4. Otherwise surface `initiatingNote.chatSummary` in Chat only.
 * 5. Never copy `completion.context.receiptIds` into the note.
 */
export function planCompoundCompletionReflection(
  input: ReflectMissionCompletionInput &
    Omit<InitiatingNoteReflectionInputV1, "runId" | "context" | "pipeline"> & {
      runId?: string;
      initiatingNotePath?: string | null;
    },
): CompoundCompletionReflectionV1 {
  const completion = reflectMissionCompletion(input);
  const context = input.reflectionContext ?? completion.context;
  const runId =
    input.runId?.trim() ||
    context?.runId?.trim() ||
    context?.pipeline?.runId?.trim() ||
    "unknown-run";
  const preparedInitiatingNote = buildInitiatingNoteReflectionV1({
    runId,
    context: context ?? null,
    pipeline: context?.pipeline ?? null,
    initiatingNotePath: input.initiatingNotePath,
    linearIssueUrls: input.linearIssueUrls,
    markerId: input.markerId,
    prompt: input.prompt,
    forceChatOnly: input.forceChatOnly,
    chatOnlyOverride: input.chatOnlyOverride,
    workingMode: input.workingMode,
    explicitChatOnly: input.explicitChatOnly,
    persistence: input.persistence ?? context?.persistence,
    codeExamples: input.codeExamples,
  });
  const initiatingNote: InitiatingNoteReflectionPlanV1 = completion.done
    ? preparedInitiatingNote
    : {
        ...preparedInitiatingNote,
        shouldWriteNote: false,
        destination: {
          kind: "chat_only",
          reason: "completion_incomplete",
        },
        markdown: "",
        chatSummary: "",
      };
  return {
    version: 1,
    completion,
    initiatingNote,
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
