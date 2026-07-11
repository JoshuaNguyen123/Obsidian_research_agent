import {
  readLatestMissionLedger,
  readMissionLedgerByRunId,
  type MissionLedger,
} from "./missionLedger";
import {
  countRemainingMissionPlanTasks,
  getActiveMissionPlanTask,
  getNextMissionPlanAction,
} from "./missionPlan";
import { formatMissionPlanResumePrompt } from "./missionPlanPrompts";
import {
  computeProofDebt,
  formatProofDebtForPrompt,
  proofDebtSnapshotFromLedger,
  type ProofDebt,
} from "./proofDebt";
import type { ToolExecutionContext } from "../tools/types";

export interface MissionResumeContext {
  path: string;
  ledger: MissionLedger;
  plan: MissionResumePlan;
  promptContext: string;
}

export interface MissionResumePlan {
  runId: string;
  canResume: boolean;
  reason: string;
  remainingActions: string[];
  continuationCommand: string;
  restoredEvidenceCount: number;
  proofDebt: ProofDebt;
}

export function hasMissionResumeIntent(prompt: string): boolean {
  if (extractRequestedRunId(prompt) !== null) {
    return true;
  }

  if (hasResearchMemoryContinuationIntent(prompt)) {
    return false;
  }

  const text = prompt.trim();
  return (
    /^(?:continue|resume|keep\s+going|carry\s+on|pick\s+up)\b/i.test(text) ||
    /\b(?:resume|continue|keep\s+going|carry\s+on|pick\s+up)\s+(?:(?:the|this|that|our|my)\s+)?(?:agent\s+run|mission|checkpoint)\b/i.test(
      text,
    ) ||
    /\b(?:resume|continue|keep\s+going|carry\s+on|pick\s+up)\b[\s\S]{0,60}\b(?:previous|prior|last|saved|unfinished)\s+(?:agent\s+run|run|mission|checkpoint|research|work)\b/i.test(
      text,
    ) ||
    /\b(?:previous|prior|last|saved|unfinished)\s+(?:agent\s+run|run|mission|checkpoint|research|work)\b[\s\S]{0,60}\b(?:resume|continue|keep\s+going|carry\s+on|pick\s+up)\b/i.test(
      text,
    )
  );
}

export function extractRequestedRunId(prompt: string): string | null {
  return (
    /\b(?:continue|resume|keep going|carry on)\s+run\s+([A-Za-z0-9._:-]+)/i.exec(
      prompt,
    )?.[1] ?? null
  );
}

function hasResearchMemoryContinuationIntent(prompt: string): boolean {
  return /\b(research\s+memory|topic\s+memory|from\s+memory|memory|remember|recall|long[-\s]?term)\b/i.test(
    prompt,
  );
}

export async function buildMissionResumeContext({
  prompt,
  activeIntentPrompt,
  toolContext,
}: {
  prompt: string;
  activeIntentPrompt: string;
  toolContext: ToolExecutionContext;
}): Promise<MissionResumeContext | null> {
  if (!hasMissionResumeIntent(prompt) && !hasMissionResumeIntent(activeIntentPrompt)) {
    return null;
  }

  const requestedRunId =
    extractRequestedRunId(prompt) ?? extractRequestedRunId(activeIntentPrompt);
  const loaded =
    requestedRunId !== null
      ? await readMissionLedgerByRunId(toolContext, requestedRunId)
      : await readLatestMissionLedger(toolContext);

  if (!loaded) {
    return null;
  }

  return {
    path: loaded.path,
    ledger: loaded.ledger,
    plan: buildMissionResumePlan(loaded.ledger),
    promptContext: formatLedgerForModel(loaded.ledger, loaded.path),
  };
}

export function buildMissionResumePlan(ledger: MissionLedger): MissionResumePlan {
  const proofDebt = computeProofDebt(proofDebtSnapshotFromLedger(ledger));
  const remainingActions = buildUnpaidResumeActions(ledger, proofDebt);
  const terminalComplete =
    ledger.status === "complete" && ledger.acceptance?.status === "pass";
  return {
    runId: ledger.runId,
    canResume: !terminalComplete && !proofDebt.resumeBlocked,
    reason: terminalComplete
      ? "ledger_already_complete"
      : proofDebt.resumeBlocked
        ? "proof_debt_blocked"
      : ledger.missionPlan && countRemainingMissionPlanTasks(ledger.missionPlan) > 0
        ? "mission_plan_has_remaining_work"
      : ledger.blockers.length > 0
        ? "ledger_has_blockers"
        : "ledger_has_remaining_work",
    remainingActions,
    continuationCommand: ledger.continuationCommand || `continue run ${ledger.runId}`,
    restoredEvidenceCount: ledger.evidence.length,
    proofDebt,
  };
}

/**
 * Resume next actions come from recomputed proof debt. Completed research
 * subquestions are never reopened; stale ledger next/remaining strings that
 * name completed ids are filtered out.
 */
export function buildUnpaidResumeActions(
  ledger: MissionLedger,
  proofDebt: ProofDebt = computeProofDebt(proofDebtSnapshotFromLedger(ledger)),
): string[] {
  const actions: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !actions.includes(trimmed)) {
      actions.push(trimmed);
    }
  };

  if (!proofDebt.empty) {
    push(
      proofDebt.nextAction.toolName != null
        ? `${proofDebt.nextAction.toolName}: ${proofDebt.nextAction.reason}`
        : proofDebt.nextAction.summary,
    );
  }

  for (const conflict of proofDebt.openConflicts) {
    push(`Resolve open evidence conflict: ${conflict.summary}`);
  }

  const activeMissionTask = getActiveMissionPlanTask(ledger.missionPlan);
  if (activeMissionTask && activeMissionTask.status !== "complete") {
    push(
      `Continue mission-plan task ${activeMissionTask.id}: ${activeMissionTask.title}`,
    );
  }

  const missionPlanAction = getNextMissionPlanAction(ledger.missionPlan);
  if (missionPlanAction && missionPlanAction.kind !== "final") {
    push(missionPlanAction.summary);
  }

  const incompleteResearchItem = ledger.researchPlan?.subquestions.find(
    (item) => item.status !== "complete" && item.status !== "blocked",
  );
  if (incompleteResearchItem) {
    push(
      `Continue research item ${incompleteResearchItem.id}: ${incompleteResearchItem.question}`,
    );
  }

  const completedSubquestionIds = new Set(
    (ledger.researchPlan?.subquestions ?? [])
      .filter((item) => item.status === "complete")
      .map((item) => item.id),
  );
  for (const action of [...ledger.remainingActions, ...ledger.nextActions]) {
    if (referencesCompletedSubquestion(action, completedSubquestionIds)) {
      continue;
    }
    push(action);
  }

  return actions;
}

function referencesCompletedSubquestion(
  action: string,
  completedIds: Set<string>,
): boolean {
  if (completedIds.size === 0) {
    return false;
  }
  const text = action.toLowerCase();
  for (const id of completedIds) {
    const needle = id.toLowerCase();
    if (
      text.includes(needle) &&
      (new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i").test(action) ||
        text.includes(`research item ${needle}`) ||
        text.includes(`subquestion ${needle}`))
    ) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatLedgerForModel(
  ledger: MissionLedger,
  path = `Agent Runs/${ledger.runId}.md`,
): string {
  const incomplete = ledger.tasks.filter((task) => task.status !== "complete");
  const missionPlanPrompt = formatMissionPlanResumePrompt(
    ledger.missionPlan,
    path,
  );
  const proofDebt = computeProofDebt(proofDebtSnapshotFromLedger(ledger));
  const incompleteResearchItem = ledger.researchPlan?.subquestions.find(
    (item) => item.status !== "complete" && item.status !== "blocked",
  );
  const unpaidActions = buildUnpaidResumeActions(ledger, proofDebt);
  const debtNextAction =
    proofDebt.nextAction.toolName != null
      ? `${proofDebt.nextAction.toolName}: ${proofDebt.nextAction.reason}`
      : proofDebt.nextAction.summary;
  const evidence = ledger.evidence.slice(0, 12).map((item) => {
    const locator = item.path ?? item.url ?? item.id;
    return `${item.title} (${item.kind}; ${locator}): ${item.summary}`;
  });

  return [
    "Structured Agent Runs mission ledger for resume context.",
    "Use this ledger only if it matches the user's requested continuation.",
    "Do not persist this ledger text into chat history.",
    "Resume only unpaid proof debt; do not reopen completed research subquestions.",
    `Ledger path: ${path}`,
    `Run id: ${ledger.runId}`,
    `Mission: ${ledger.mission}`,
    missionPlanPrompt,
    formatProofDebtForPrompt(proofDebt),
    `Resume next action (from proof debt): ${
      proofDebt.empty ? "none" : debtNextAction
    }`,
    proofDebt.openConflicts.length > 0
      ? `Open evidence conflicts: ${proofDebt.openConflicts
          .map((item) => item.summary)
          .join("; ")}`
      : "Open evidence conflicts: none",
    incompleteResearchItem
      ? `Resume first incomplete research item: ${incompleteResearchItem.id} - ${incompleteResearchItem.question}`
      : "Resume first incomplete research item: none",
    ledger.researchPlan
      ? `Research mode: ${ledger.researchPlan.mode}; source requirements: ${ledger.researchPlan.sourceRequirements.minFetchedSources} fetched sources, ${ledger.researchPlan.sourceRequirements.minDistinctDomains} distinct domains.`
      : "Research mode: none",
    `Status: ${ledger.status}`,
    `Route: ${ledger.route}`,
    `Expected tools: ${ledger.loopBudget.expectedTools.join(", ") || "none"}`,
    `Incomplete tasks: ${incomplete.map((task) => task.title).join("; ") || "none"}`,
    `Blockers: ${ledger.blockers.join("; ") || "none"}`,
    `Blocker category: ${ledger.blockerCategory ?? "none"}`,
    `Dependency status: ${formatDependencyStatusForModel(ledger.dependencyStatus)}`,
    `Continuation command: ${ledger.continuationCommand || `continue run ${ledger.runId}`}`,
    `Unpaid resume actions: ${unpaidActions.join("; ") || "none"}`,
    `Acceptance: ${ledger.acceptance?.status ?? "unchecked"}`,
    `Acceptance missing: ${ledger.acceptance?.missing.join(", ") || "none"}`,
    `Resume count: ${ledger.resumeCount}`,
    `Last safe step: ${ledger.lastSafeStep}`,
    "Evidence:",
    evidence.length > 0 ? evidence.join("\n") : "none",
  ].join("\n");
}

function formatDependencyStatusForModel(
  statuses: MissionLedger["dependencyStatus"],
): string {
  if (statuses.length === 0) {
    return "none";
  }
  return statuses
    .map(
      (item) =>
        `${item.category}:${item.status} capability=${item.capability} next=${item.nextAction}`,
    )
    .join("; ");
}
