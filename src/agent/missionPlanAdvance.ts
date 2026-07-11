import type { AgentRunReceipt } from "../AgentRunner";
import type { ToolExecutionResult } from "../tools/types";
import type { MissionAcceptanceResult } from "./missionAcceptance";
import type { MissionEvidence } from "./missionLedger";
import {
  CODE_RUN_FAILURE_EVIDENCE_ID,
  CODE_RUN_SUCCESS_EVIDENCE_ID,
  FINAL_OUTPUT_RELEVANT_EVIDENCE_ID,
  RECEIPT_PROOF_ID_PREFIX,
  getActiveMissionPlanTask,
  getReceiptProofKinds,
  isFinalOutputRelevant,
  isSuccessfulCodeRunOutput,
  refreshMissionPlanProgress,
  taskHasRecordedProof,
  type MissionPlan,
  type MissionPlanProofKind,
  type MissionPlanTask,
} from "./missionPlan";

export interface MissionPlanAdvanceResult {
  plan: MissionPlan;
  changed: boolean;
  meaningfulAction?: string;
}

export function advanceMissionPlanFromToolResult({
  plan,
  toolName,
  result,
  evidence,
  now = new Date(),
}: {
  plan: MissionPlan;
  toolName: string;
  result: ToolExecutionResult;
  evidence?: MissionEvidence | null;
  now?: Date;
}): MissionPlanAdvanceResult {
  const active = getActiveMissionPlanTask(plan);
  if (!active || !active.allowedTools.includes(toolName)) {
    return { plan, changed: false };
  }

  const codeRunEvidenceIds =
    toolName === "run_code_block"
      ? [
          result.ok && isSuccessfulCodeRunOutput(result.output)
            ? CODE_RUN_SUCCESS_EVIDENCE_ID
            : CODE_RUN_FAILURE_EVIDENCE_ID,
        ]
      : [];
  const nextTask: MissionPlanTask = {
    ...active,
    status: active.status,
    evidenceIds: dedupe([
      ...active.evidenceIds,
      `tool:${toolName}`,
      ...codeRunEvidenceIds,
      ...(evidence ? [evidence.id] : []),
    ]),
    blocker: result.ok ? active.blocker : result.error?.message ?? "Tool failed.",
  };
  const next = replaceTask(plan, nextTask, now);
  return {
    plan: markMeaningfulAction(
      maybeCompleteActiveTask(next, now),
      `tool:${toolName}`,
      now,
    ),
    changed: true,
    meaningfulAction: `tool:${toolName}`,
  };
}

export function advanceMissionPlanFromReceipt({
  plan,
  receipt,
  evidenceId,
  now = new Date(),
}: {
  plan: MissionPlan;
  receipt: AgentRunReceipt;
  evidenceId?: string;
  now?: Date;
}): MissionPlanAdvanceResult {
  const active = getActiveMissionPlanTask(plan);
  if (!active || !active.allowedTools.includes(receipt.toolName)) {
    return { plan, changed: false };
  }
  const receiptId = evidenceId ?? getReceiptId(receipt);
  const proofIds = getReceiptProofKinds(receipt).map(
    (proof) => `${RECEIPT_PROOF_ID_PREFIX}${proof}`,
  );
  const nextTask: MissionPlanTask = {
    ...active,
    status: active.status,
    receiptIds: dedupe([...active.receiptIds, receiptId, ...proofIds]),
  };
  const next = replaceTask(plan, nextTask, now);
  return {
    plan: markMeaningfulAction(
      maybeCompleteActiveTask(next, now),
      `receipt:${receipt.operation}`,
      now,
    ),
    changed: true,
    meaningfulAction: `receipt:${receipt.operation}`,
  };
}

export function advanceMissionPlanFromAcceptance({
  plan,
  acceptance,
  now = new Date(),
}: {
  plan: MissionPlan;
  acceptance: MissionAcceptanceResult;
  now?: Date;
}): MissionPlanAdvanceResult {
  const active = getActiveMissionPlanTask(plan);
  if (!active) {
    return { plan, changed: false };
  }
  const status =
    acceptance.status === "pass"
      ? "complete"
      : acceptance.status === "fail"
        ? "blocked"
        : "needs_verification";
  const nextTask: MissionPlanTask = {
    ...active,
    status,
    blocker:
      acceptance.status === "fail"
        ? acceptance.nextAction ?? acceptance.missing.join(", ")
        : active.blocker,
  };
  const next = replaceTask(plan, nextTask, now);
  return {
    plan: markMeaningfulAction(refreshMissionPlanProgress(next), "acceptance", now),
    changed: true,
    meaningfulAction: "acceptance",
  };
}

export function advanceMissionPlanFromBlocker({
  plan,
  blocker,
  now = new Date(),
}: {
  plan: MissionPlan;
  blocker: string;
  now?: Date;
}): MissionPlanAdvanceResult {
  const active = getActiveMissionPlanTask(plan);
  if (!active) {
    return {
      plan: {
        ...plan,
        status: "blocked",
        updatedAt: now.toISOString(),
      },
      changed: true,
      meaningfulAction: "blocker",
    };
  }
  const nextTask: MissionPlanTask = {
    ...active,
    status: "blocked",
    blocker,
  };
  return {
    plan: markMeaningfulAction(
      refreshMissionPlanProgress(replaceTask(plan, nextTask, now)),
      "blocker",
      now,
    ),
    changed: true,
    meaningfulAction: "blocker",
  };
}

export function advanceMissionPlanFromFinalOutput({
  plan,
  finalOutput,
  now = new Date(),
}: {
  plan: MissionPlan;
  finalOutput?: string;
  now?: Date;
}): MissionPlanAdvanceResult {
  if (!finalOutput?.trim()) {
    return { plan, changed: false };
  }
  const active = getActiveMissionPlanTask(plan);
  if (!active) {
    return {
      plan: markMeaningfulAction(plan, "final_output", now),
      changed: true,
      meaningfulAction: "final_output",
    };
  }
  const relevant = isFinalOutputRelevant(plan, finalOutput);
  const nextTask: MissionPlanTask = {
    ...active,
    evidenceIds: relevant
      ? dedupe([...active.evidenceIds, FINAL_OUTPUT_RELEVANT_EVIDENCE_ID])
      : active.evidenceIds,
  };
  const next = replaceTask(plan, nextTask, now);
  return {
    plan: markMeaningfulAction(
      maybeCompleteActiveTask(next, now),
      "final_output",
      now,
    ),
    changed: true,
    meaningfulAction: "final_output",
  };
}

export function scoreMissionPlanProgress(plan: MissionPlan): number {
  const taskScore =
    plan.progress.totalTasks === 0
      ? 1
      : plan.progress.completedTasks / plan.progress.totalTasks;
  const proofScore =
    plan.tasks.length === 0
      ? 1
      : plan.tasks.reduce((sum, task) => sum + scoreTaskProof(task), 0) /
        plan.tasks.length;
  return roundScore(Math.max(taskScore, proofScore));
}

export function detectMissionPlanStall({
  plan,
  lastMeaningfulAction,
}: {
  plan: MissionPlan;
  lastMeaningfulAction?: string;
}): { stalled: boolean; stalledCount: number; reason: string } {
  const stalled =
    Boolean(lastMeaningfulAction) &&
    lastMeaningfulAction === plan.progress.lastMeaningfulAction;
  const stalledCount = stalled ? plan.progress.stalledCount + 1 : 0;
  return {
    stalled,
    stalledCount,
    reason: stalled ? "repeated_plan_action" : "progress_observed",
  };
}

function maybeCompleteActiveTask(plan: MissionPlan, now: Date): MissionPlan {
  const active = getActiveMissionPlanTask(plan);
  if (!active) {
    return refreshMissionPlanProgress(plan);
  }
  const missing = getMissingProof(active);
  if (missing.length > 0) {
    return refreshMissionPlanProgress(plan);
  }
  return refreshMissionPlanProgress(
    replaceTask(plan, { ...active, status: "complete" }, now),
  );
}

function replaceTask(
  plan: MissionPlan,
  task: MissionPlanTask,
  now: Date,
): MissionPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((candidate) =>
      candidate.id === task.id ? task : candidate,
    ),
    updatedAt: now.toISOString(),
  };
}

function markMeaningfulAction(
  plan: MissionPlan,
  action: string,
  now: Date,
): MissionPlan {
  const stalled =
    plan.progress.lastMeaningfulAction === action
      ? plan.progress.stalledCount + 1
      : 0;
  return {
    ...plan,
    progress: {
      ...plan.progress,
      score: scoreMissionPlanProgress(plan),
      stalledCount: stalled,
      lastMeaningfulAction: action,
    },
    updatedAt: now.toISOString(),
  };
}

function getMissingProof(task: MissionPlanTask): MissionPlanProofKind[] {
  return task.completionContract.requiredProof.filter(
    (proof) => !taskHasRecordedProof(task, proof),
  );
}

function scoreTaskProof(task: MissionPlanTask): number {
  const required = task.completionContract.requiredProof.length;
  if (required === 0) {
    return task.status === "complete" ? 1 : 0.5;
  }
  const missing = getMissingProof(task).length;
  return (required - missing) / required;
}

function getReceiptId(receipt: AgentRunReceipt): string {
  return [
    receipt.toolName,
    receipt.operation,
    receipt.path ?? "",
    receipt.toPath ?? "",
    receipt.backupPath ?? "",
  ].join(":");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
