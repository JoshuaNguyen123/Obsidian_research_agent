import type { AgentTraceEvent } from "../AgentRunner";
import type { MissionLedger } from "./missionLedger";
import {
  countRemainingMissionPlanTasks,
  flattenMissionPlanTasks,
  getActiveMissionPlanTask,
  getNextMissionPlanActionCompat,
  getNextMissionPlanAction,
  type MissionPlanLike,
} from "./missionPlan";
import type { MissionAcceptanceResult } from "./missionAcceptance";
import type { RecoveryState } from "./recoveryEngine";
import type { VaultTransaction } from "./vaultTransactions";
import {
  computeProofDebt,
  formatProofDebtForPrompt,
  proofDebtSnapshotFromLedger,
} from "./proofDebt";
import {
  buildHypothesisSystemHint,
  type ResearchHypothesis,
} from "./researchHypotheses";

export interface ContinuationMemoryBundle {
  runId: string;
  ledgerPath?: string;
  checkpointPath?: string;
  researchMemoryPaths: string[];
  activeNodeId?: string;
  activePath: string[];
  remainingActions: string[];
  evidenceSummaries: string[];
  loadedAt: string;
}

export interface ContinuationMemoryInput {
  ledger?: MissionLedger | null;
  ledgerPath?: string;
  checkpointPath?: string;
  researchMemoryPaths?: string[];
  now?: Date;
}

export function buildContinuationMemoryBundle({
  ledger,
  ledgerPath,
  checkpointPath,
  researchMemoryPaths = [],
  now = new Date(),
}: ContinuationMemoryInput): ContinuationMemoryBundle {
  const activeTask = getActiveMissionPlanTask(ledger?.missionPlan);
  const nextAction = getNextMissionPlanAction(ledger?.missionPlan);
  const remainingActions = [
    ...(activeTask ? [`Continue ${activeTask.id}: ${activeTask.title}`] : []),
    ...(nextAction ? [nextAction.summary] : []),
    ...(ledger?.remainingActions ?? []),
    ...(ledger?.nextActions ?? []),
  ].filter((item, index, all) => item.trim() && all.indexOf(item) === index);
  return {
    runId: ledger?.runId ?? "unknown",
    ledgerPath,
    checkpointPath,
    researchMemoryPaths: [...researchMemoryPaths],
    activeNodeId: activeTask?.id,
    activePath: activeTask ? [activeTask.id] : [],
    remainingActions,
    evidenceSummaries: (ledger?.evidence ?? []).slice(0, 12).map((item) => {
      const locator = item.path ?? item.url ?? item.id;
      return `${item.title} (${locator}): ${item.summary}`;
    }),
    loadedAt: now.toISOString(),
  };
}

export function formatContinuationBundleForPrompt(
  bundle: ContinuationMemoryBundle,
  extras?: {
    hypotheses?: ResearchHypothesis[];
    includeProofDebt?: boolean;
    ledger?: MissionLedger | null;
  },
): string {
  const proofDebtSection =
    extras?.includeProofDebt !== false && extras?.ledger
      ? formatProofDebtForPrompt(
          computeProofDebt(proofDebtSnapshotFromLedger(extras.ledger)),
        )
      : null;
  const hypothesisHint = extras?.hypotheses
    ? buildHypothesisSystemHint(extras.hypotheses)
    : null;
  return [
    "Continuation memory bundle.",
    "Use this state to continue work, but verify against current tool results before claiming completion.",
    `Run id: ${bundle.runId}`,
    `Ledger path: ${bundle.ledgerPath ?? "none"}`,
    `Checkpoint path: ${bundle.checkpointPath ?? "none"}`,
    `Active node: ${bundle.activeNodeId ?? "none"}`,
    `Active path: ${bundle.activePath.join(" > ") || "none"}`,
    `Remaining actions: ${bundle.remainingActions.join("; ") || "none"}`,
    `Evidence summaries: ${bundle.evidenceSummaries.join(" | ") || "none"}`,
    proofDebtSection,
    hypothesisHint,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function recordContinuationLoad(
  bundle: ContinuationMemoryBundle,
): AgentTraceEvent {
  return {
    id: `continuation-memory-${bundle.runId}`,
    kind: "status",
    message: "Loaded continuation memory bundle.",
    path: bundle.ledgerPath,
    outputPreview: {
      runId: bundle.runId,
      activeNodeId: bundle.activeNodeId,
      activePath: bundle.activePath,
      remainingActions: bundle.remainingActions,
      evidenceCount: bundle.evidenceSummaries.length,
      remainingTasks: bundle.activeNodeId ? undefined : 0,
    },
  };
}

export function getContinuationRemainingTaskCount(
  ledger: MissionLedger | null | undefined,
): number {
  return countRemainingMissionPlanTasks(ledger?.missionPlan);
}

export interface RuntimeContinuationMemoryBundle {
  version: 1;
  runId: string;
  prompt: string;
  createdAt: string;
  plan?: {
    status: string;
    activeTaskId: string | null;
    remainingTaskIds: string[];
    nextAction?: string;
  };
  acceptance?: {
    status: string;
    missing: string[];
    nextAction?: string;
  };
  recovery?: {
    attempts: number;
    lastAction?: string;
    lastReason?: string;
  };
  vaultTransactions?: {
    id: string;
    status: string;
    mutationCount: number;
  }[];
  notes: string[];
}

export function buildRuntimeContinuationMemoryBundle({
  runId,
  prompt,
  plan,
  acceptance,
  recovery,
  vaultTransactions = [],
  notes = [],
  now = new Date(),
  maxNotes = 8,
}: {
  runId: string;
  prompt: string;
  plan?: MissionPlanLike | null;
  acceptance?: MissionAcceptanceResult | null;
  recovery?: RecoveryState | null;
  vaultTransactions?: VaultTransaction[];
  notes?: string[];
  now?: Date;
  maxNotes?: number;
}): RuntimeContinuationMemoryBundle {
  const taskList = plan ? flattenMissionPlanTasks(plan) : [];
  const next = plan ? getNextMissionPlanActionCompat(plan) : undefined;
  const lastRecovery = recovery?.attempts.at(-1);
  return {
    version: 1,
    runId,
    prompt: truncateContinuationText(prompt, 500),
    createdAt: now.toISOString(),
    plan: plan
      ? {
          status: plan.status,
          activeTaskId: plan.version === 1 ? plan.activeTaskId : plan.activeNodeId,
          remainingTaskIds: taskList
            .filter((task) => task.status !== "complete" && task.status !== "blocked")
            .map((task) => task.id),
          nextAction: next?.summary,
        }
      : undefined,
    acceptance: acceptance
      ? {
          status: acceptance.status,
          missing: [...acceptance.missing],
          nextAction: acceptance.nextAction,
        }
      : undefined,
    recovery: recovery
      ? {
          attempts: recovery.attempts.length,
          lastAction: lastRecovery?.action,
          lastReason: lastRecovery?.reason,
        }
      : undefined,
    vaultTransactions: vaultTransactions.map((transaction) => ({
      id: transaction.id,
      status: transaction.status,
      mutationCount: transaction.mutations.length,
    })),
    notes: notes.slice(0, maxNotes).map((note) => truncateContinuationText(note, 240)),
  };
}

export function formatRuntimeContinuationMemoryBundle(
  bundle: RuntimeContinuationMemoryBundle,
  maxChars = 3000,
): string {
  return truncateContinuationText(JSON.stringify(bundle, null, 2), maxChars);
}

function truncateContinuationText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 15))}\n[truncated]`;
}
