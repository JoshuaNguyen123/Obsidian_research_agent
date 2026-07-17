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
import type { MissionGraphV3 } from "../../packages/headless-runtime/src/missionGraphV3";
import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import { portableSha256Text } from "../../packages/core-api/src/portableSha256";

export interface ContinuationHandoffV1 {
  version: 1;
  runId: string;
  graphFrontier: {
    missionId: string;
    revision: number;
    graphFingerprint: string;
    activeNodeIds: string[];
    readyNodeIds: string[];
  } | null;
  evidence: Array<{ id: string; fingerprint: string }>;
  readbackFingerprints: string[];
  receiptFingerprints: string[];
  approvals: Array<{ id: string; decision: string; fingerprint: string }>;
  bindingFingerprints: string[];
  lineageFingerprints: string[];
  recovery: {
    stalledCount: number;
    lastMeaningfulAction: string | null;
    remainingActions: string[];
  };
  proofDebt: {
    missing: string[];
    blocked: boolean;
    resumeBlocked: boolean;
  };
  createdAt: string;
  fingerprint: string;
}

export function buildContinuationHandoffV1(input: {
  ledger: MissionLedger;
  graph?: MissionGraphV3 | null;
  lineageFingerprints?: string[];
  now?: Date;
}): ContinuationHandoffV1 {
  const graph = input.graph ?? null;
  const debt = computeProofDebt(proofDebtSnapshotFromLedger(input.ledger));
  const graphNodes = graph ? Object.values(graph.nodes) : [];
  const graphFrontier = graph
    ? {
        missionId: graph.missionId,
        revision: graph.revision,
        graphFingerprint: fingerprint({
          missionId: graph.missionId,
          revision: graph.revision,
          journalHeadFingerprint: graph.journalHeadFingerprint,
          nodeStatus: graphNodes
            .map((node) => ({ id: node.id, status: node.status }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
        activeNodeIds: graphNodes
          .filter((node) => node.status === "running" || node.status === "waiting_approval")
          .map((node) => node.id)
          .sort(),
        readyNodeIds: graphNodes
          .filter((node) => node.status === "ready")
          .map((node) => node.id)
          .sort(),
      }
    : null;
  const core = {
    version: 1 as const,
    runId: input.ledger.runId,
    graphFrontier,
    evidence: dedupeBy(
      [
        ...input.ledger.evidence.map((item) => ({
          id: item.id,
          fingerprint: fingerprint({
            id: item.id,
            kind: item.kind,
            path: item.path ?? null,
            url: item.url ?? null,
            sourceId: item.sourceId ?? null,
            passageIds: item.passageIds ?? (item.passageId ? [item.passageId] : []),
            confidence: item.confidence,
          }),
        })),
        ...graphNodes.flatMap((node) => node.evidence.map((item) => ({
          id: item.id,
          fingerprint: item.fingerprint,
        }))),
      ],
      (item) => `${item.id}:${item.fingerprint}`,
    ).slice(-64),
    readbackFingerprints: uniqueSorted(
      graphNodes
        .map((node) => node.verification?.fingerprint)
        .filter((value): value is string => Boolean(value)),
    ),
    receiptFingerprints: uniqueSorted([
      ...input.ledger.receipts.map((id) => fingerprint({ receiptId: id })),
      ...graphNodes.flatMap((node) => node.receipts.map((item) => item.fingerprint)),
    ]),
    approvals: input.ledger.approvals.slice(-32).map((approval) => ({
      id: approval.id,
      decision: approval.decision,
      fingerprint: fingerprint({
        id: approval.id,
        toolName: approval.toolName,
        action: approval.action,
        decision: approval.decision,
      }),
    })),
    bindingFingerprints: uniqueSorted(
      graph
        ? Object.values(graph.capabilityEnvelope.bindings).map(
            (binding) => binding.destinationFingerprint,
          )
        : [],
    ),
    lineageFingerprints: uniqueSorted(input.lineageFingerprints ?? []),
    recovery: {
      stalledCount: Math.max(0, input.ledger.stalledCount),
      lastMeaningfulAction: input.ledger.lastMeaningfulAction ?? null,
      remainingActions: uniqueSorted([
        ...input.ledger.remainingActions,
        ...input.ledger.nextActions,
      ]).slice(0, 32),
    },
    proofDebt: {
      missing: uniqueSorted(debt.missing).slice(0, 64),
      blocked: debt.blocked,
      resumeBlocked: debt.resumeBlocked,
    },
  };
  return {
    ...core,
    createdAt: (input.now ?? new Date()).toISOString(),
    fingerprint: fingerprint(core),
  };
}

export function validateContinuationHandoffV1(
  value: unknown,
): { ok: true; value: ContinuationHandoffV1 } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["handoff_not_an_object"] };
  if (value.version !== 1) errors.push("unsupported_version");
  if (typeof value.runId !== "string" || !value.runId) errors.push("missing_run_id");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    errors.push("invalid_created_at");
  }
  if (!isFingerprint(value.fingerprint)) errors.push("invalid_fingerprint");
  for (const key of [
    "evidence",
    "readbackFingerprints",
    "receiptFingerprints",
    "approvals",
    "bindingFingerprints",
    "lineageFingerprints",
  ] as const) {
    if (!Array.isArray(value[key])) errors.push(`invalid_${key}`);
  }
  if (!isRecord(value.recovery)) errors.push("invalid_recovery");
  if (!isRecord(value.proofDebt)) errors.push("invalid_proof_debt");
  if (value.graphFrontier !== null && !isRecord(value.graphFrontier)) {
    errors.push("invalid_graph_frontier");
  }
  if (errors.length > 0) return { ok: false, errors };
  const { createdAt: _createdAt, fingerprint: stored, ...core } = value;
  if (fingerprint(core) !== stored) {
    return { ok: false, errors: ["fingerprint_mismatch"] };
  }
  return { ok: true, value: value as unknown as ContinuationHandoffV1 };
}

export function parseContinuationHandoffV1(value: unknown): ContinuationHandoffV1 {
  const parsed = validateContinuationHandoffV1(value);
  if (!parsed.ok) {
    throw new TypeError(`Invalid ContinuationHandoffV1: ${parsed.errors.join(", ")}`);
  }
  return parsed.value;
}

export function formatContinuationHandoffForPrompt(
  handoff: ContinuationHandoffV1,
): string {
  return [
    "Canonical continuation handoff (fingerprint validated).",
    `Fingerprint: ${handoff.fingerprint}`,
    `Graph frontier: ${handoff.graphFrontier ? `${handoff.graphFrontier.missionId}@${handoff.graphFrontier.revision}; active=${handoff.graphFrontier.activeNodeIds.join(",") || "none"}; ready=${handoff.graphFrontier.readyNodeIds.join(",") || "none"}` : "none"}`,
    `Evidence: ${handoff.evidence.map((item) => `${item.id}:${item.fingerprint}`).join("; ") || "none"}`,
    `Readbacks: ${handoff.readbackFingerprints.join(", ") || "none"}`,
    `Receipts: ${handoff.receiptFingerprints.join(", ") || "none"}`,
    `Approvals: ${handoff.approvals.map((item) => `${item.id}:${item.decision}:${item.fingerprint}`).join("; ") || "none"}`,
    `Bindings: ${handoff.bindingFingerprints.join(", ") || "none"}`,
    `Lineage: ${handoff.lineageFingerprints.join(", ") || "none"}`,
    `Recovery: stalled=${handoff.recovery.stalledCount}; last=${handoff.recovery.lastMeaningfulAction ?? "none"}; remaining=${handoff.recovery.remainingActions.join("; ") || "none"}`,
    `Proof debt: blocked=${handoff.proofDebt.blocked}; resumeBlocked=${handoff.proofDebt.resumeBlocked}; missing=${handoff.proofDebt.missing.join(", ") || "none"}`,
  ].join("\n");
}

function fingerprint(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

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
