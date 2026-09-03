import { observeHostWorkV1 } from "./hostWork";
import type { TFile } from "obsidian";
import type { LoopBudgetPlan } from "./loopPlanner";
import {
  normalizeClaimLedger,
  type ClaimLedger,
  type ClaimPassageRef,
} from "./claimLedger";
import {
  normalizeEvidenceConflicts,
  type EvidenceConflict,
} from "./evidenceConflicts";
import {
  normalizeResearchPlan,
  researchPlanToTaskStatus,
  type ResearchPlan,
} from "./researchPlan";
import {
  normalizeMissionPlan,
  type MissionPlan,
} from "./missionPlan";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";
import {
  cloneNormalizedMissionRuntimeSnapshot,
  commitMissionRuntimeSnapshotRevision,
  getMissionRuntimeSnapshotPath,
  persistAgentRunMarkdownExact,
  readAgentRunMarkdown,
  readAgentRunMarkdownForUpdate,
  rememberAgentRunMarkdownWrite,
  replaceRuntimeSnapshotBlock,
  stageMissionRuntimeSnapshotRevision,
  withSerializedRunWrite,
  type MissionRuntimeSnapshotV2,
  type MissionRuntimeSnapshotWriteResult,
} from "./runStore";
import type { OrchestratorSnapshotV1 } from "../orchestrator/types";
import type { ModelUsageAggregateV1 } from "../model/modelCallEvidence";
import { normalizeOrchestratorSnapshot } from "../orchestrator/orchestratorStore";
import {
  parseContinuationHandoffV1,
  type ContinuationHandoffV1,
} from "./continuationMemory";
import type { ReflexCheckpointReceiptV1 } from "./reflex/types";
import {
  applyPluginVersionStampIfMissing,
  normalizePluginVersionStamp,
  readPluginVersionStampFromHost,
} from "./pluginVersionStamp";

const MAX_CLAIM_PASSAGES = 64;

const AGENT_RUNS_FOLDER = "Agent Runs";
export const MISSION_LEDGER_SCHEMA_VERSION = 2 as const;
const LEDGER_HEADING = "## Mission Ledger";
const LEDGER_BLOCK_PATTERN =
  /## Mission Ledger\r?\n```json\r?\n[\s\S]*?\r?\n```/;
const GENERATED_MISSION_SUMMARY_PATTERN =
  /^(?:\r?\n){1,2}### Mission Summary\r?\n(?:- [^\r\n]*(?:\r?\n|$))+/;
const MAX_PASSAGE_IDS_PER_EVIDENCE = 24;

export type MissionLedgerStatus =
  | "running"
  | "complete"
  | "blocked"
  | "stopped"
  | "budget";

export type MissionTaskStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "blocked";

export type MissionEvidenceKind =
  | "vault_note"
  | "web_source"
  | "tool_result"
  | "artifact"
  | "receipt";

export type MissionStage =
  | "plan"
  | "gather"
  | "browser_observe"
  | "browser_act"
  | "synthesize"
  | "verify"
  | "write_save"
  | "memory_reflection"
  | "next_action";

export type MissionBlockerCategory =
  | "provider_auth"
  | "model_timeout"
  | "web_fetch"
  | "semantic_retrieval"
  | "companion_browser"
  | "obsidian_vault"
  | "safety_policy"
  | "tool_unavailable"
  | "provider_budget"
  | "unknown";

export interface MissionDependencyStatus {
  category: MissionBlockerCategory;
  status: "ok" | "degraded" | "blocked" | "unknown";
  capability: string;
  summary: string;
  nextAction: string;
  checkedAt?: string;
}

export interface MissionApprovalRecord {
  id: string;
  toolName: string;
  action: string;
  decision: "approved" | "denied" | "expired" | "aborted";
  decidedAt: string;
}

export interface MissionTask {
  id: string;
  title: string;
  status: MissionTaskStatus;
  toolNames: string[];
  evidenceIds: string[];
  notes: string;
}

export interface MissionEvidence {
  id: string;
  kind: MissionEvidenceKind;
  title: string;
  path?: string;
  url?: string;
  /** Strong source-content proof retained for exact downstream research binding. */
  contentHash?: string;
  sourceId?: string;
  passageId?: string;
  passageIds?: string[];
  /** True only when fetched content produced persistable evidence passages. */
  usableSource?: boolean;
  parserStatus?: "parsed" | "empty" | "missing_content" | "legacy_unknown";
  summary: string;
  confidence: "low" | "medium" | "high";
}

export interface MissionMilestone {
  id: string;
  missionId: string;
  step: number;
  stage: MissionStage;
  summary: string;
  decision?: string;
  toolCalls?: string[];
  evidenceIds?: string[];
  artifacts?: string[];
  error?: string;
  nextAction?: string;
  createdAt: string;
}

export interface MissionLedger {
  schemaVersion: typeof MISSION_LEDGER_SCHEMA_VERSION;
  revision: number;
  runId: string;
  mission: string;
  route: string;
  createdAt: string;
  updatedAt: string;
  status: MissionLedgerStatus;
  acceptance?: {
    status: string;
    confidence: number;
    missing: string[];
    reasons: string[];
    nextAction?: string;
    checkedAt: string;
  };
  loopBudget: {
    hardCap: number;
    toolStepBudget: number;
    finalizationReserve: number;
    expectedTools: string[];
  };
  /** Aggregate-only provider accounting. Missing legacy values normalize to zero. */
  providerUsage?: ModelUsageAggregateV1;
  tasks: MissionTask[];
  milestones: MissionMilestone[];
  evidence: MissionEvidence[];
  receipts: string[];
  blockers: string[];
  blockerCategory?: MissionBlockerCategory;
  dependencyStatus: MissionDependencyStatus[];
  approvals: MissionApprovalRecord[];
  wallClockExpired?: boolean;
  nextActions: string[];
  remainingActions: string[];
  researchPlan?: ResearchPlan;
  missionPlan?: MissionPlan;
  /** Operational two-agent projection; excluded from conversation history. */
  orchestrator?: OrchestratorSnapshotV1;
  /** Latest claim-grounding ledger for deep/cited research acceptance. */
  claimLedger?: ClaimLedger;
  /** Dossier passage texts used for claim binding (preferred over evidence summaries). */
  claimPassages?: ClaimPassageRef[];
  /** First-class evidence conflicts (open / resolved / acknowledged_limitation). */
  evidenceConflicts?: EvidenceConflict[];
  iterationCount: number;
  progressScore: number;
  stalledCount: number;
  activeTaskId?: string;
  lastMeaningfulAction?: string;
  resumeCount: number;
  lastSafeStep: number;
  continuationCommand: string;
  continuationPrompt?: string;
  /** Fingerprinted state required before compacting or resuming a run. */
  continuationHandoff?: ContinuationHandoffV1;
  /** Transient fail-closed marker when persisted handoff parsing failed. */
  continuationHandoffInvalid?: true;
  /** Redacted reflex metadata only; prompts and model text are never persisted. */
  reflexCheckpoints?: ReflexCheckpointReceiptV1[];
  /**
   * User dismissed the unfinished-run banner. Persisted so the banner does not
   * return after reload; the run remains in Agent Runs for inspection.
   */
  userDismissedAt?: string;
  /**
   * Additive current-note write kind for resume splicing. Absent on ledgers
   * written before this field; recover from expectedTools / route instead.
   */
  currentNoteWriteKind?: CurrentNoteWriteKindV1;
  /**
   * Secret-free plugin build id from `manifest.version`. Optional so ledgers
   * written before this field still parse (`pluginVersion` omitted / null).
   */
  pluginVersion?: string;
  /** Secret-free Obsidian minimum from `manifest.minAppVersion`. */
  minAppVersion?: string;
}

export const CURRENT_NOTE_WRITE_KINDS_V1 = [
  "append",
  "replace",
  "edit",
] as const;
export type CurrentNoteWriteKindV1 = (typeof CURRENT_NOTE_WRITE_KINDS_V1)[number];

export function isCurrentNoteWriteKindV1(
  value: unknown,
): value is CurrentNoteWriteKindV1 {
  return (
    value === "append" || value === "replace" || value === "edit"
  );
}

export function currentNoteWriteToolNameV1(
  kind: CurrentNoteWriteKindV1,
): string {
  if (kind === "replace") {
    return "replace_current_file";
  }
  if (kind === "edit") {
    return "edit_current_section";
  }
  return "append_to_current_file";
}

/**
 * Recover the current-note write kind from an explicit field, then expected
 * tools, then a streaming/direct writeback route suffix. Defaults to append
 * so older ledgers keep their historical heal.
 */
export function resolveCurrentNoteWriteKindV1(input: {
  writeKind?: unknown;
  expectedTools?: readonly string[];
  route?: string;
}): CurrentNoteWriteKindV1 {
  if (isCurrentNoteWriteKindV1(input.writeKind)) {
    return input.writeKind;
  }
  const tools = input.expectedTools ?? [];
  if (tools.includes("replace_current_file")) {
    return "replace";
  }
  if (tools.includes("edit_current_section")) {
    return "edit";
  }
  if (tools.includes("append_to_current_file")) {
    return "append";
  }
  const routed =
    /(?:streaming_writeback|direct_current_note_writeback):(append|replace|edit)/.exec(
      input.route ?? "",
    )?.[1];
  return isCurrentNoteWriteKindV1(routed) ? routed : "append";
}

export function resolveLedgerCurrentNoteWriteKind(
  ledger: Pick<MissionLedger, "currentNoteWriteKind" | "route" | "loopBudget">,
): CurrentNoteWriteKindV1 {
  return resolveCurrentNoteWriteKindV1({
    writeKind: ledger.currentNoteWriteKind,
    expectedTools: ledger.loopBudget.expectedTools,
    route: ledger.route,
  });
}

export interface MissionLedgerWriteResult {
  path: string;
  bytesWritten: number;
  revision: number;
}

export interface MissionLedgerSummary {
  runId: string;
  status: MissionLedgerStatus;
  acceptance?: {
    status: string;
    confidence: number;
    missing: string[];
    reasons: string[];
    nextAction?: string;
    checkedAt: string;
  };
  evidenceCount: number;
  receiptCount: number;
  /** Redacted per-segment provider aggregate; never includes prompts or responses. */
  providerUsage: ModelUsageAggregateV1;
  expectedTools: string[];
  nextAction: string;
  remainingActions: string[];
  continuationCommand: string;
  canResume: boolean;
  blockerCategory?: MissionBlockerCategory;
  dependencyStatus: MissionDependencyStatus[];
  missionPlan?: {
    status: string;
    activeTaskId: string | null;
    progressScore: number;
    stalledCount: number;
    remainingTasks: number;
    nextAction: string;
  };
  /** Operational projection retained for Run Details/live attestation. */
  orchestrator?: OrchestratorSnapshotV1;
  /** Secret-free plugin build id when the host stamped this run. */
  pluginVersion?: string;
  minAppVersion?: string;
  iterationCount: number;
  progressScore: number;
  stalledCount: number;
  activeTaskId?: string;
  lastMeaningfulAction?: string;
}

export function createMissionLedger({
  runId,
  mission,
  route,
  loopBudget,
  researchPlan,
  currentNoteWriteKind,
  pluginVersion,
  minAppVersion,
  now = new Date(),
}: {
  runId: string;
  mission: string;
  route: string;
  loopBudget: LoopBudgetPlan;
  researchPlan?: ResearchPlan | null;
  currentNoteWriteKind?: CurrentNoteWriteKindV1;
  pluginVersion?: string;
  minAppVersion?: string;
  now?: Date;
}): MissionLedger {
  const timestamp = now.toISOString();
  const tasks = researchPlan
    ? researchPlan.subquestions.map((item) => ({
        id: item.id,
        title: item.question,
        status: researchPlanToTaskStatus(item.status),
        toolNames: [],
        evidenceIds: [...item.evidenceIds],
        notes: item.unansweredReason ?? "",
      }))
    : [
        {
          id: "task-1",
          title: "Complete requested mission",
          status: "in_progress" as const,
          toolNames: [],
          evidenceIds: [],
          notes: "",
        },
      ];
  return {
    schemaVersion: MISSION_LEDGER_SCHEMA_VERSION,
    revision: 0,
    runId,
    mission,
    route,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
    loopBudget: {
      hardCap: loopBudget.hardCap,
      toolStepBudget: loopBudget.toolStepBudget,
      finalizationReserve: loopBudget.finalizationReserve,
      expectedTools: [...loopBudget.expectedTools],
    },
    providerUsage: {
      schemaVersion: 1,
      modelCallCount: 0,
      successfulCallCount: 0,
      failedCallCount: 0,
      reportedTokens: 0,
      estimatedTokens: 0,
      retries: 0,
      wallClockMs: 0,
    },
    tasks,
    milestones: [
      {
        id: "milestone-1",
        missionId: runId,
        step: 0,
        stage: "plan",
        summary: "Mission ledger created and route budget selected.",
        decision: route,
        toolCalls: [],
        evidenceIds: [],
        artifacts: [],
        nextAction: "Begin bounded agent loop.",
        createdAt: timestamp,
      },
    ],
    evidence: [],
    receipts: [],
    blockers: [],
    dependencyStatus: [],
    approvals: [],
    nextActions: [],
    remainingActions: researchPlan?.nextAction?.reason
      ? [researchPlan.nextAction.reason]
      : [],
    ...(researchPlan ? { researchPlan } : {}),
    iterationCount: 0,
    progressScore: 0,
    stalledCount: 0,
    resumeCount: 0,
    lastSafeStep: 0,
    continuationCommand: getContinuationCommand(runId),
    reflexCheckpoints: [],
    ...(isCurrentNoteWriteKindV1(currentNoteWriteKind)
      ? { currentNoteWriteKind }
      : {}),
    ...normalizePluginVersionStamp({ pluginVersion, minAppVersion }),
  };
}

/**
 * Route marker for a durable run anchor persisted at run start, BEFORE the
 * structured router, reflex pass, planner, or mission-graph open produced any
 * plan state. It is deliberately NOT a member of RunRoute: every
 * resume-inheritance seat is gated on isRunRouteValue, so an anchor-only run
 * inherits nothing and replans from its recorded mission prompt.
 *
 * This literal must exist in exactly one module. Both the writer (AgentRunner
 * decides "what makes a run resumable from its first moment") and the resume
 * path (missionResume decides "what do I accept, and how do I continue it")
 * consume it through isPrePlanningAnchorLedger below; a second private copy is
 * a second authority that will drift (guarded at source level by
 * tests/runnerDurabilityIntegration.test.ts).
 */
export const PRE_PLANNING_ANCHOR_ROUTE = "accepted_pre_planning" as const;

const PRE_PLANNING_ANCHOR_NEXT_ACTION =
  "Planning had not begun when this run last persisted; continue by restarting the mission from its recorded prompt.";

/**
 * The one shared predicate for anchor-only runs. True only for a ledger whose
 * durable state honestly records that planning never began: there is nothing
 * to preserve besides the mission prompt, so `continue run <id>` restarts the
 * mission from that prompt instead of refusing.
 */
export function isPrePlanningAnchorLedger(ledger: MissionLedger): boolean {
  return ledger.route === PRE_PLANNING_ANCHOR_ROUTE;
}

/**
 * Minimal durable anchor persisted the moment a run's identity is minted.
 * Everything a resume gate needs is honest and knowable at run start: the run
 * id, the verbatim mission prompt, the target note binding when already known,
 * and an explicit marker (the anchor route + next action) that planning had
 * not begun. Nothing is faked: the loop budget is all zeros because no budget
 * was planned, and there are no tasks/evidence/receipts beyond the default
 * placeholder task. The full mission ledger later evolves this SAME record in
 * place (same runId, same Agent Runs file, monotonic revision) so the run's
 * durable identity stays singular.
 */
export function createPrePlanningAnchorLedger({
  runId,
  mission,
  targetNotePath,
  pluginVersion,
  minAppVersion,
  now = new Date(),
}: {
  runId: string;
  mission: string;
  targetNotePath?: string | null;
  pluginVersion?: string;
  minAppVersion?: string;
  now?: Date;
}): MissionLedger {
  const ledger = createMissionLedger({
    runId,
    mission,
    route: PRE_PLANNING_ANCHOR_ROUTE,
    loopBudget: {
      hardCap: 0,
      toolStepBudget: 0,
      finalizationReserve: 0,
      expectedTools: [],
      stopWhenSatisfied: false,
    },
    pluginVersion,
    minAppVersion,
    now,
  });
  ledger.milestones = [
    {
      id: "milestone-1",
      missionId: runId,
      step: 0,
      stage: "plan",
      summary:
        "Mission accepted; durable run anchor persisted before planning began.",
      decision: PRE_PLANNING_ANCHOR_ROUTE,
      toolCalls: [],
      evidenceIds: [],
      artifacts: targetNotePath ? [targetNotePath] : [],
      nextAction: PRE_PLANNING_ANCHOR_NEXT_ACTION,
      createdAt: now.toISOString(),
    },
  ];
  ledger.nextActions = [PRE_PLANNING_ANCHOR_NEXT_ACTION];
  return ledger;
}

/**
 * Best-effort removal of an anchor artifact for the one run shape whose
 * terminal ledger persist deliberately writes nothing: a mission that the
 * router downgraded to direct chat after the anchor was written. Direct-chat
 * runs create no Agent Runs note today, and the anchor must not change that.
 * Every other termination keeps the anchor, mirroring how a post-planning
 * ledger stays resumable through stops, errors, and shutdown aborts.
 * Deletion is double-guarded: it only ever touches a file whose persisted
 * ledger both matches the exact runId and satisfies
 * isPrePlanningAnchorLedger, so an evolved ledger can never be removed even
 * if the caller's supersession tracking is wrong.
 */
export async function removePrePlanningAnchorArtifact(
  context: ToolExecutionContext,
  runId: string,
): Promise<boolean> {
  if (!hasLedgerVaultApi(context)) {
    return false;
  }
  const vault = context.app.vault;
  return withSerializedRunWrite(vault, runId, async () => {
    const path = getMissionLedgerPath(runId);
    const file = vault.getFileByPath(path);
    if (!file) {
      return false;
    }
    let ledger: MissionLedger | null = null;
    try {
      ledger = parseMissionLedgerFromMarkdown(await vault.read(file as TFile));
    } catch {
      return false;
    }
    if (
      !ledger ||
      ledger.runId !== runId ||
      !isPrePlanningAnchorLedger(ledger)
    ) {
      return false;
    }
    const deletableVault = vault as unknown as {
      delete?: (file: TFile, force?: boolean) => Promise<void>;
      adapter?: { remove?: (path: string) => Promise<void> };
    };
    try {
      if (typeof deletableVault.delete === "function") {
        await deletableVault.delete(file as TFile, true);
        return true;
      }
      if (typeof deletableVault.adapter?.remove === "function") {
        await deletableVault.adapter.remove(path);
        return true;
      }
    } catch {
      // Best-effort: a stale anchor is preferable to a thrown completion.
    }
    return false;
  });
}

export function addMissionMilestone(
  ledger: MissionLedger,
  input: Omit<MissionMilestone, "id" | "missionId" | "createdAt">,
  now = new Date(),
): MissionMilestone {
  const timestamp = now.toISOString();
  const milestone: MissionMilestone = {
    id: `milestone-${ledger.milestones.length + 1}`,
    missionId: ledger.runId,
    step: input.step,
    stage: input.stage,
    summary: input.summary,
    decision: input.decision,
    toolCalls: input.toolCalls ? [...input.toolCalls] : [],
    evidenceIds: input.evidenceIds ? [...input.evidenceIds] : [],
    artifacts: input.artifacts ? [...input.artifacts] : [],
    error: input.error,
    nextAction: input.nextAction,
    createdAt: timestamp,
  };
  ledger.milestones.push(milestone);
  ledger.updatedAt = timestamp;
  return milestone;
}

export function updateMissionLedgerStatus(
  ledger: MissionLedger,
  status: MissionLedgerStatus,
  now = new Date(),
) {
  ledger.status = status;
  ledger.updatedAt = now.toISOString();
  const activeTask = getActiveTask(ledger);
  if (activeTask) {
    activeTask.status =
      status === "complete"
        ? "complete"
        : status === "blocked" || status === "budget"
          ? "blocked"
          : activeTask.status;
  }
}

export function upsertLedgerEvidence(
  ledger: MissionLedger,
  evidence: MissionEvidence,
  now = new Date(),
) {
  upsertMissionEvidenceRecord(ledger.evidence, evidence);
  ledger.updatedAt = now.toISOString();
}

/**
 * Upserts evidence while retaining all passage ranges gathered from repeated
 * reads of the same web source. This is shared by the durable ledger and the
 * runner's in-memory evidence list so research binding sees the same record.
 */
export function upsertMissionEvidenceRecord<T extends MissionEvidence>(
  records: T[],
  evidence: T,
): T {
  const index = records.findIndex((item) => item.id === evidence.id);
  if (index < 0) {
    records.push(evidence);
    return evidence;
  }
  const merged = mergeMissionEvidence(records[index], evidence);
  records[index] = merged;
  return merged;
}

export function mergeMissionEvidence<T extends MissionEvidence>(
  existing: T,
  incoming: T,
): T {
  if (!isSameWebSourceEvidence(existing, incoming)) {
    return incoming;
  }
  const passageIds = [...new Set([
    ...(existing.passageId ? [existing.passageId] : []),
    ...(existing.passageIds ?? []),
    ...(incoming.passageId ? [incoming.passageId] : []),
    ...(incoming.passageIds ?? []),
  ])].slice(-MAX_PASSAGE_IDS_PER_EVIDENCE);
  const merged = {
    ...existing,
    ...incoming,
    ...(existing.url || incoming.url
      ? { url: existing.url ?? incoming.url }
      : {}),
    ...(existing.sourceId || incoming.sourceId
      ? { sourceId: existing.sourceId ?? incoming.sourceId }
      : {}),
    ...(existing.passageId || incoming.passageId || passageIds[0]
      ? { passageId: existing.passageId ?? incoming.passageId ?? passageIds[0] }
      : {}),
    ...(passageIds.length > 0 ? { passageIds } : {}),
  };
  return merged as T;
}

function isSameWebSourceEvidence(
  existing: MissionEvidence,
  incoming: MissionEvidence,
): boolean {
  if (existing.kind !== "web_source" || incoming.kind !== "web_source") {
    return false;
  }
  if (
    existing.sourceId &&
    incoming.sourceId &&
    existing.sourceId !== incoming.sourceId
  ) {
    return false;
  }
  if (existing.url && incoming.url && existing.url !== incoming.url) {
    return false;
  }
  return existing.id === incoming.id;
}

export function markLedgerToolUsed(
  ledger: MissionLedger,
  toolName: string,
  evidenceId?: string,
  now = new Date(),
) {
  const task = getActiveTask(ledger);
  if (!task) {
    return;
  }
  if (!task.toolNames.includes(toolName)) {
    task.toolNames.push(toolName);
  }
  if (evidenceId && !task.evidenceIds.includes(evidenceId)) {
    task.evidenceIds.push(evidenceId);
  }
  ledger.updatedAt = now.toISOString();
}

export function addLedgerReceipt(
  ledger: MissionLedger,
  receiptId: string,
  now = new Date(),
) {
  if (!ledger.receipts.includes(receiptId)) {
    ledger.receipts.push(receiptId);
  }
  ledger.updatedAt = now.toISOString();
}

export function addLedgerBlocker(
  ledger: MissionLedger,
  blocker: string,
  category: MissionBlockerCategory = "unknown",
  now = new Date(),
) {
  if (blocker.trim() && !ledger.blockers.includes(blocker.trim())) {
    ledger.blockers.push(blocker.trim());
  }
  ledger.blockerCategory = category;
  ledger.updatedAt = now.toISOString();
}

export function setLedgerDependencyStatus(
  ledger: MissionLedger,
  dependencyStatus: MissionDependencyStatus[],
  now = new Date(),
) {
  ledger.dependencyStatus = dependencyStatus.map((item) => ({ ...item }));
  const blocked = dependencyStatus.find((item) => item.status === "blocked");
  if (blocked) {
    ledger.blockerCategory = blocked.category;
  }
  ledger.updatedAt = now.toISOString();
}

export function addLedgerApproval(
  ledger: MissionLedger,
  approval: Omit<MissionApprovalRecord, "decidedAt">,
  now = new Date(),
) {
  const decidedAt = now.toISOString();
  ledger.approvals.push({
    ...approval,
    decidedAt,
  });
  ledger.updatedAt = decidedAt;
}

export function setLedgerWallClockExpired(
  ledger: MissionLedger,
  now = new Date(),
) {
  ledger.wallClockExpired = true;
  ledger.updatedAt = now.toISOString();
}

export function setLedgerNextAction(
  ledger: MissionLedger,
  action: string,
  now = new Date(),
) {
  ledger.nextActions = action.trim() ? [action.trim()] : [];
  ledger.updatedAt = now.toISOString();
}

export function setLedgerResearchPlan(
  ledger: MissionLedger,
  researchPlan: ResearchPlan | null | undefined,
  now = new Date(),
) {
  if (!researchPlan) {
    delete ledger.researchPlan;
    return;
  }

  ledger.researchPlan = researchPlan;
  for (const subquestion of researchPlan.subquestions) {
    let task = ledger.tasks.find((candidate) => candidate.id === subquestion.id);
    if (!task) {
      task = {
        id: subquestion.id,
        title: subquestion.question,
        status: researchPlanToTaskStatus(subquestion.status),
        toolNames: [],
        evidenceIds: [],
        notes: "",
      };
      ledger.tasks.push(task);
    }
    task.title = subquestion.question;
    task.status = researchPlanToTaskStatus(subquestion.status);
    task.evidenceIds = [...subquestion.evidenceIds];
    task.notes = subquestion.unansweredReason ?? task.notes ?? "";
  }
  ledger.remainingActions = researchPlan.nextAction?.reason
    ? [researchPlan.nextAction.reason]
    : [];
  ledger.updatedAt = now.toISOString();
}

export function setLedgerAcceptance(
  ledger: MissionLedger,
  acceptance: {
    status: string;
    confidence: number;
    missing: string[];
    reasons: string[];
    nextAction?: string;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  ledger.acceptance = {
    ...acceptance,
    missing: [...acceptance.missing],
    reasons: [...acceptance.reasons],
    checkedAt: timestamp,
  };
  ledger.remainingActions = acceptance.nextAction ? [acceptance.nextAction] : [];
  ledger.updatedAt = timestamp;
}

export function setLedgerClaimLedger(
  ledger: MissionLedger,
  claimLedger: ClaimLedger | null | undefined,
  now = new Date(),
) {
  if (!claimLedger) {
    delete ledger.claimLedger;
    ledger.updatedAt = now.toISOString();
    return;
  }
  const normalized = normalizeClaimLedger(claimLedger);
  if (!normalized) {
    delete ledger.claimLedger;
    ledger.updatedAt = now.toISOString();
    return;
  }
  ledger.claimLedger = normalized;
  ledger.updatedAt = now.toISOString();
}

export function setLedgerClaimPassages(
  ledger: MissionLedger,
  passages: ClaimPassageRef[] | null | undefined,
  now = new Date(),
) {
  if (!passages || passages.length === 0) {
    delete ledger.claimPassages;
    ledger.updatedAt = now.toISOString();
    return;
  }
  ledger.claimPassages = normalizeClaimPassages(passages);
  ledger.updatedAt = now.toISOString();
}

export function setLedgerEvidenceConflicts(
  ledger: MissionLedger,
  conflicts: EvidenceConflict[] | null | undefined,
  now = new Date(),
) {
  const normalized = normalizeEvidenceConflicts(conflicts);
  if (normalized.length === 0) {
    delete ledger.evidenceConflicts;
    ledger.updatedAt = now.toISOString();
    return;
  }
  ledger.evidenceConflicts = normalized;
  ledger.updatedAt = now.toISOString();
}

export function setLedgerMissionPlan(
  ledger: MissionLedger,
  missionPlan: MissionPlan | null | undefined,
  now = new Date(),
) {
  if (!missionPlan) {
    delete ledger.missionPlan;
    delete ledger.activeTaskId;
    delete ledger.lastMeaningfulAction;
    ledger.progressScore = 0;
    ledger.stalledCount = 0;
    ledger.updatedAt = now.toISOString();
    return;
  }

  ledger.missionPlan = missionPlan;
  ledger.activeTaskId = missionPlan.activeTaskId ?? undefined;
  ledger.progressScore = missionPlan.progress.score;
  ledger.stalledCount = missionPlan.progress.stalledCount;
  ledger.lastMeaningfulAction = missionPlan.progress.lastMeaningfulAction;
  ledger.remainingActions = missionPlan.nextAction?.summary
    ? [missionPlan.nextAction.summary]
    : ledger.remainingActions;
  ledger.updatedAt = now.toISOString();
}

export function markLedgerResumeLoaded(
  ledger: MissionLedger,
  continuationPrompt: string,
  now = new Date(),
) {
  ledger.resumeCount += 1;
  ledger.continuationPrompt = continuationPrompt;
  ledger.continuationCommand = getContinuationCommand(ledger.runId);
  ledger.updatedAt = now.toISOString();
}

export function setLedgerLastSafeStep(
  ledger: MissionLedger,
  step: number,
  now = new Date(),
) {
  ledger.lastSafeStep = Math.max(ledger.lastSafeStep, step);
  ledger.iterationCount = Math.max(ledger.iterationCount ?? 0, step);
  ledger.updatedAt = now.toISOString();
}

export function isUserDismissedMissionLedger(ledger: MissionLedger): boolean {
  return (
    typeof ledger.userDismissedAt === "string" &&
    Number.isFinite(Date.parse(ledger.userDismissedAt))
  );
}

/** Persist a user dismiss so the unfinished-run banner does not keep returning. */
export function markMissionLedgerUserDismissed(
  ledger: MissionLedger,
  now = new Date(),
): MissionLedger {
  const timestamp = now.toISOString();
  ledger.userDismissedAt = timestamp;
  ledger.status = ledger.status === "complete" ? ledger.status : "stopped";
  ledger.updatedAt = timestamp;
  ledger.nextActions = [
    "User dismissed this unfinished run. Start a new mission or ask to continue explicitly.",
  ];
  return ledger;
}

export function summarizeMissionLedger(
  ledger: MissionLedger,
): MissionLedgerSummary {
  const canResume =
    !isTerminalCompleteLedger(ledger) && !isUserDismissedMissionLedger(ledger);
  const summary: MissionLedgerSummary = {
    runId: ledger.runId,
    status: ledger.status,
    acceptance: ledger.acceptance
      ? {
          ...ledger.acceptance,
          missing: [...ledger.acceptance.missing],
          reasons: [...ledger.acceptance.reasons],
        }
      : undefined,
    evidenceCount: ledger.evidence.length,
    receiptCount: ledger.receipts.length,
    providerUsage: normalizeProviderUsage(ledger.providerUsage),
    expectedTools: [...ledger.loopBudget.expectedTools],
    nextAction: ledger.nextActions[0] ?? "none",
    remainingActions: [...ledger.remainingActions],
    continuationCommand: ledger.continuationCommand || getContinuationCommand(ledger.runId),
    canResume,
    blockerCategory: ledger.blockerCategory,
    dependencyStatus: ledger.dependencyStatus.map((item) => ({ ...item })),
    iterationCount: ledger.iterationCount ?? 0,
    progressScore: ledger.progressScore ?? ledger.missionPlan?.progress.score ?? 0,
    stalledCount: ledger.stalledCount ?? ledger.missionPlan?.progress.stalledCount ?? 0,
  };
  if (ledger.missionPlan) {
    summary.missionPlan = {
      status: ledger.missionPlan.status,
      activeTaskId: ledger.missionPlan.activeTaskId,
      progressScore: ledger.missionPlan.progress.score,
      stalledCount: ledger.missionPlan.progress.stalledCount,
      remainingTasks: ledger.missionPlan.progress.remainingTasks,
      nextAction: ledger.missionPlan.nextAction?.summary ?? "none",
    };
  }
  const orchestrator = normalizeOrchestratorSnapshot(ledger.orchestrator, {
    fallbackRunId: ledger.runId,
    now: new Date(ledger.updatedAt),
  });
  if (orchestrator) {
    summary.orchestrator = orchestrator;
  }
  if (ledger.activeTaskId) {
    summary.activeTaskId = ledger.activeTaskId;
  }
  if (ledger.lastMeaningfulAction) {
    summary.lastMeaningfulAction = ledger.lastMeaningfulAction;
  }
  const versionStamp = normalizePluginVersionStamp(ledger);
  if (versionStamp.pluginVersion) {
    summary.pluginVersion = versionStamp.pluginVersion;
  }
  if (versionStamp.minAppVersion) {
    summary.minAppVersion = versionStamp.minAppVersion;
  }
  return summary;
}

export async function writeMissionLedger(
  context: ToolExecutionContext,
  ledger: MissionLedger,
): Promise<MissionLedgerWriteResult | null> {
  if (!hasLedgerVaultApi(context)) {
    return null;
  }

  const vault = context.app.vault;
  const requestedLedger = cloneMissionLedger(ledger);
  applyPluginVersionStampIfMissing(
    requestedLedger,
    readPluginVersionStampFromHost(context),
  );
  return observeHostWorkV1(context, "persist_run_note", () =>
    withSerializedRunWrite(vault, ledger.runId, async () => {
    const folderPath = normalizeVaultPath(AGENT_RUNS_FOLDER);
    const path = getMissionLedgerPath(requestedLedger.runId);

    if (!vault.getFolderByPath(folderPath)) {
      try {
        await vault.createFolder(folderPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    }

    const file = vault.getFileByPath(path);
    let current = "";
    let persistedRevision = 0;
    if (file) {
      current = await readAgentRunMarkdownForUpdate({
        path,
        adapter: vault.adapter,
        vaultRead: () => vault.read(file as TFile),
      });
      persistedRevision = parseMissionLedgerFromMarkdown(current)?.revision ?? 0;
    }

    requestedLedger.schemaVersion = MISSION_LEDGER_SCHEMA_VERSION;
    requestedLedger.revision =
      Math.max(requestedLedger.revision, persistedRevision) + 1;
    const block = formatMissionLedgerBlock(requestedLedger);

    if (!file) {
      const content = `# Agent Run ${sanitizeRunId(requestedLedger.runId)}\n\n${block}`;
      await vault.create(path, content);
      ledger.schemaVersion = MISSION_LEDGER_SCHEMA_VERSION;
      ledger.revision = Math.max(ledger.revision, requestedLedger.revision);
      applyPluginVersionStampIfMissing(ledger, requestedLedger);
      return {
        path,
        bytesWritten: getByteLength(content),
        revision: requestedLedger.revision,
      };
    }

    const next = replaceMissionLedgerBlock(current, block);
    await persistAgentRunMarkdownExact({
      path,
      expectedMarkdown: next,
      adapterWrite:
        typeof vault.adapter?.write === "function"
          ? () => vault.adapter.write(path, next)
          : undefined,
      adapterRead:
        typeof vault.adapter?.read === "function"
          ? () => vault.adapter.read(path)
          : undefined,
      modify: () => vault.modify(file as TFile, next),
      readback: () => vault.read(file as TFile),
    });
    await rememberAgentRunMarkdownWrite({
      path,
      adapter: vault.adapter,
      markdown: next,
    });
    ledger.schemaVersion = MISSION_LEDGER_SCHEMA_VERSION;
    ledger.revision = Math.max(ledger.revision, requestedLedger.revision);
    applyPluginVersionStampIfMissing(ledger, requestedLedger);
    return {
      path,
      bytesWritten: getByteLength(block),
      revision: requestedLedger.revision,
    };
    }),
  );
}

export interface MissionLedgerAndSnapshotWriteResult {
  ledger: MissionLedgerWriteResult;
  snapshot: MissionRuntimeSnapshotWriteResult;
}

/**
 * Persist the mission ledger and the runtime snapshot in ONE rewrite of the
 * shared Agent Runs note.
 *
 * Every ledger persist used to be followed by a "duplicate" snapshot write of
 * the same note: two read-modify-write cycles and two exact readbacks per
 * persist, several persists per tool call. Both blocks now land in a single
 * exact write, which also removes the window in which a crash left the
 * ledger one write ahead of the snapshot. Revision bumps, plugin-version
 * stamps, block placement, and the readback proof are exactly those of the
 * two single-block writers, whose staging helpers this shares.
 */
export async function writeMissionLedgerWithRuntimeSnapshot(
  context: ToolExecutionContext,
  ledger: MissionLedger,
  snapshot: MissionRuntimeSnapshotV2,
): Promise<MissionLedgerAndSnapshotWriteResult | null> {
  if (!hasLedgerVaultApi(context)) {
    return null;
  }
  const path = getMissionLedgerPath(ledger.runId);
  if (getMissionRuntimeSnapshotPath(snapshot.runId) !== path) {
    throw new Error(
      "The mission ledger and runtime snapshot resolve to different run notes.",
    );
  }
  const vault = context.app.vault;
  const requestedLedger = cloneMissionLedger(ledger);
  applyPluginVersionStampIfMissing(
    requestedLedger,
    readPluginVersionStampFromHost(context),
  );
  const requestedSnapshot = cloneNormalizedMissionRuntimeSnapshot(snapshot);
  return observeHostWorkV1(context, "persist_run_note", () =>
    withSerializedRunWrite(vault, ledger.runId, async () => {
    const folderPath = normalizeVaultPath(AGENT_RUNS_FOLDER);
    if (!vault.getFolderByPath(folderPath)) {
      try {
        await vault.createFolder(folderPath);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
    }

    const file = vault.getFileByPath(path);
    let current = "";
    if (file) {
      current = await readAgentRunMarkdownForUpdate({
        path,
        adapter: vault.adapter,
        vaultRead: () => vault.read(file as TFile),
      });
    }
    const persistedLedgerRevision = current
      ? parseMissionLedgerFromMarkdown(current)?.revision ?? 0
      : 0;
    requestedLedger.schemaVersion = MISSION_LEDGER_SCHEMA_VERSION;
    requestedLedger.revision =
      Math.max(requestedLedger.revision, persistedLedgerRevision) + 1;
    const ledgerBlock = formatMissionLedgerBlock(requestedLedger);
    const snapshotBlock = stageMissionRuntimeSnapshotRevision(
      context,
      requestedSnapshot,
      snapshot,
      current,
    );
    const commitBoth = () => {
      ledger.schemaVersion = MISSION_LEDGER_SCHEMA_VERSION;
      ledger.revision = Math.max(ledger.revision, requestedLedger.revision);
      applyPluginVersionStampIfMissing(ledger, requestedLedger);
      commitMissionRuntimeSnapshotRevision(requestedSnapshot, snapshot);
    };

    if (!file) {
      const content = replaceRuntimeSnapshotBlock(
        `# Agent Run ${sanitizeRunId(requestedLedger.runId)}\n\n${ledgerBlock}`,
        snapshotBlock,
      );
      await vault.create(path, content);
      commitBoth();
      const bytesWritten = getByteLength(content);
      return {
        ledger: { path, bytesWritten, revision: requestedLedger.revision },
        snapshot: {
          path,
          bytesWritten,
          revision: requestedSnapshot.revision,
          commitProof: "vault_acknowledged",
        },
      };
    }

    const next = replaceRuntimeSnapshotBlock(
      replaceMissionLedgerBlock(current, ledgerBlock),
      snapshotBlock,
    );
    const commitProof = await persistAgentRunMarkdownExact({
      path,
      expectedMarkdown: next,
      adapterWrite:
        typeof vault.adapter?.write === "function"
          ? () => vault.adapter.write(path, next)
          : undefined,
      adapterRead:
        typeof vault.adapter?.read === "function"
          ? () => vault.adapter.read(path)
          : undefined,
      modify: () => vault.modify(file as TFile, next),
      readback: () => vault.read(file as TFile),
    });
    await rememberAgentRunMarkdownWrite({
      path,
      adapter: vault.adapter,
      markdown: next,
    });
    commitBoth();
    return {
      ledger: {
        path,
        bytesWritten: getByteLength(ledgerBlock),
        revision: requestedLedger.revision,
      },
      snapshot: {
        path,
        bytesWritten: getByteLength(snapshotBlock),
        revision: requestedSnapshot.revision,
        commitProof,
      },
    };
    }),
  );
}

export async function readMissionLedgerByRunId(
  context: ToolExecutionContext,
  runId: string,
): Promise<{ path: string; ledger: MissionLedger } | null> {
  if (!hasLedgerVaultApi(context)) {
    return null;
  }

  const path = getMissionLedgerPath(runId);
  const file = context.app.vault.getFileByPath(path);
  if (file) {
    const content = await context.app.vault.read(file as TFile);
    const ledger = parseMissionLedgerFromMarkdown(content);
    if (ledger?.runId === runId) {
      return { path, ledger };
    }
  }

  // Obsidian's metadata index can briefly lag a completed vault create or a
  // plugin restart. Read the exact adapter path as a bounded fallback, but
  // accept it only when the embedded ledger identity matches the requested
  // run. This also fails closed on sanitized filename collisions.
  const adapter = context.app.vault.adapter as unknown as
    | {
        exists?: (path: string) => Promise<boolean>;
        read?: (path: string) => Promise<string>;
      }
    | undefined;
  if (typeof adapter?.read === "function") {
    try {
      if (
        typeof adapter.exists !== "function" ||
        (await adapter.exists(path))
      ) {
        const content = await adapter.read(path);
        const ledger = parseMissionLedgerFromMarkdown(content);
        if (ledger?.runId === runId) {
          return { path, ledger };
        }
      }
    } catch {
      // Fall through to the exact-identity vault scan below.
    }
  }

  if (typeof context.app.vault.getFiles === "function") {
    const candidates = context.app.vault
      .getFiles()
      .filter((candidate) => /^Agent Runs\/[^/]+\.md$/iu.test(candidate.path))
      .slice(0, 256);
    for (const candidate of candidates) {
      if (candidate.path === path && file) continue;
      const content = await context.app.vault.read(candidate);
      const ledger = parseMissionLedgerFromMarkdown(content);
      if (ledger?.runId === runId) {
        return { path: candidate.path, ledger };
      }
    }
  }

  return null;
}

export async function readLatestMissionLedger(
  context: ToolExecutionContext,
): Promise<{ path: string; ledger: MissionLedger; mtime: number } | null> {
  if (!hasLedgerVaultApi(context) || typeof context.app.vault.getFiles !== "function") {
    return null;
  }

  const candidates = context.app.vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/[^/]+\.md$/i.test(file.path))
    .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));

  let terminalFallback: { path: string; ledger: MissionLedger; mtime: number } | null = null;

  for (const file of candidates) {
    const content = await context.app.vault.read(file);
    const ledger = parseMissionLedgerFromMarkdown(content);
    if (ledger) {
      const loaded = {
        path: file.path,
        ledger,
        mtime: file.stat?.mtime ?? 0,
      };
      if (
        !isTerminalCompleteLedger(ledger) &&
        !isUserDismissedMissionLedger(ledger)
      ) {
        return loaded;
      }
      if (!isUserDismissedMissionLedger(ledger)) {
        terminalFallback ??= loaded;
      }
    }
  }

  return terminalFallback;
}

export function parseMissionLedgerFromMarkdown(
  markdown: string,
): MissionLedger | null {
  const match = LEDGER_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return null;
  }

  const json = /```json\r?\n([\s\S]*?)\r?\n```/.exec(match[0])?.[1];
  if (!json) {
    return null;
  }

  try {
    return normalizeMissionLedger(JSON.parse(json));
  } catch {
    return null;
  }
}

export function formatMissionLedgerBlock(ledger: MissionLedger): string {
  return [
    LEDGER_HEADING,
    "```json",
    JSON.stringify(ledger, null, 2),
    "```",
    "",
    "### Mission Summary",
    `- Status: ${ledger.status}`,
    `- Plugin version: ${ledger.pluginVersion ?? "unspecified"}`,
    `- Min app version: ${ledger.minAppVersion ?? "unspecified"}`,
    `- Route: ${ledger.route}`,
    `- Expected tools: ${ledger.loopBudget.expectedTools.join(", ") || "none"}`,
    `- Evidence: ${ledger.evidence.length}`,
    `- Receipts: ${ledger.receipts.length}`,
    `- Milestones: ${ledger.milestones.length}`,
    `- Acceptance: ${ledger.acceptance?.status ?? "unchecked"}`,
    `- Next action: ${ledger.nextActions[0] ?? "none"}`,
    `- Remaining actions: ${ledger.remainingActions.join("; ") || "none"}`,
    `- Continuation command: ${ledger.continuationCommand || getContinuationCommand(ledger.runId)}`,
    `- Blocker category: ${ledger.blockerCategory ?? "none"}`,
    `- Dependency status: ${formatDependencyStatusSummary(ledger.dependencyStatus)}`,
    `- Approvals: ${ledger.approvals.length}`,
    `- Wall clock expired: ${ledger.wallClockExpired ? "yes" : "no"}`,
    `- Mission plan: ${ledger.missionPlan?.status ?? "none"}`,
    `- Active task: ${ledger.activeTaskId ?? ledger.missionPlan?.activeTaskId ?? "none"}`,
    `- Progress score: ${ledger.progressScore ?? ledger.missionPlan?.progress.score ?? 0}`,
    `- Stalled count: ${ledger.stalledCount ?? ledger.missionPlan?.progress.stalledCount ?? 0}`,
    `- Iterations: ${ledger.iterationCount ?? 0}`,
    "",
  ].join("\n");
}

export function getMissionLedgerPath(runId: string): string {
  return normalizeVaultPath(`${AGENT_RUNS_FOLDER}/${sanitizeRunId(runId)}.md`, {
    requireMarkdown: true,
  });
}

function replaceMissionLedgerBlock(current: string, block: string): string {
  const existingBlock = LEDGER_BLOCK_PATTERN.exec(current);
  if (existingBlock) {
    const before = current.slice(0, existingBlock.index);
    let after = current.slice(existingBlock.index + existingBlock[0].length);

    // Older writes replaced only the JSON fence even though `block` also
    // contains the rendered summary. Each checkpoint consequently retained
    // the previous generated summary and inserted another one ahead of it.
    // Remove only the exact adjacent bullet-only summaries that this writer
    // owns; preserve checkpoints and any hand-authored trailing sections.
    while (GENERATED_MISSION_SUMMARY_PATTERN.test(after)) {
      after = after.replace(GENERATED_MISSION_SUMMARY_PATTERN, "");
    }

    const trailingContent = after.replace(/^(?:\r?\n)+/, "");
    return trailingContent
      ? `${before}${block.trimEnd()}\n\n${trailingContent}`
      : `${before}${block}`;
  }

  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${block}`;
}

function getActiveTask(ledger: MissionLedger): MissionTask | null {
  return (
    ledger.tasks.find((task) => task.status === "in_progress") ??
    ledger.tasks[0] ??
    null
  );
}

function normalizeMissionLedger(value: unknown): MissionLedger | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = getString(value.runId);
  const mission = getString(value.mission);
  const route = getString(value.route);
  const createdAt = getString(value.createdAt);
  const updatedAt = getString(value.updatedAt);
  const status = getLedgerStatus(value.status);
  const loopBudget = isRecord(value.loopBudget) ? value.loopBudget : {};

  if (!runId || !mission || !route || !createdAt || !updatedAt || !status) {
    return null;
  }

  const missionPlan = normalizeMissionPlan(value.missionPlan);
  return {
    schemaVersion: MISSION_LEDGER_SCHEMA_VERSION,
    revision: Math.max(0, Math.floor(getNumber(value.revision) ?? 0)),
    runId,
    mission,
    route,
    createdAt,
    updatedAt,
    status,
    acceptance: normalizeLedgerAcceptance(value.acceptance),
    loopBudget: {
      hardCap: getNumber(loopBudget.hardCap) ?? 0,
      toolStepBudget: getNumber(loopBudget.toolStepBudget) ?? 0,
      finalizationReserve: getNumber(loopBudget.finalizationReserve) ?? 0,
      expectedTools: getStringArray(loopBudget.expectedTools),
    },
    providerUsage: normalizeProviderUsage(value.providerUsage),
    tasks: Array.isArray(value.tasks)
      ? value.tasks.map(normalizeMissionTask).filter(isMissionTask)
      : [],
    milestones: Array.isArray(value.milestones)
      ? value.milestones
          .map(normalizeMissionMilestone)
          .filter(isMissionMilestone)
      : [],
    evidence: Array.isArray(value.evidence)
      ? value.evidence.map(normalizeMissionEvidence).filter(isMissionEvidence)
      : [],
    receipts: getStringArray(value.receipts),
    blockers: getStringArray(value.blockers),
    blockerCategory: getBlockerCategory(value.blockerCategory),
    dependencyStatus: Array.isArray(value.dependencyStatus)
      ? value.dependencyStatus
          .map(normalizeDependencyStatus)
          .filter(isDependencyStatus)
      : [],
    approvals: Array.isArray(value.approvals)
      ? value.approvals
          .map(normalizeApprovalRecord)
          .filter(isApprovalRecord)
      : [],
    wallClockExpired: value.wallClockExpired === true,
    nextActions: getStringArray(value.nextActions),
    remainingActions: getStringArray(value.remainingActions),
    researchPlan: normalizeResearchPlan(value.researchPlan),
    missionPlan,
    ...(() => {
      const orchestrator = normalizeOrchestratorSnapshot(value.orchestrator, {
        fallbackRunId: runId,
      });
      return orchestrator ? { orchestrator } : {};
    })(),
    ...(() => {
      const claimLedger = normalizeClaimLedger(value.claimLedger);
      const claimPassages = normalizeClaimPassages(value.claimPassages);
      const evidenceConflicts = normalizeEvidenceConflicts(value.evidenceConflicts);
      return {
        ...(claimLedger ? { claimLedger } : {}),
        ...(claimPassages ? { claimPassages } : {}),
        ...(evidenceConflicts.length > 0 ? { evidenceConflicts } : {}),
      };
    })(),
    iterationCount: getNumber(value.iterationCount) ?? getNumber(value.lastSafeStep) ?? 0,
    progressScore:
      getNumber(value.progressScore) ?? missionPlan?.progress.score ?? 0,
    stalledCount:
      getNumber(value.stalledCount) ?? missionPlan?.progress.stalledCount ?? 0,
    activeTaskId: getString(value.activeTaskId) ?? missionPlan?.activeTaskId ?? undefined,
    lastMeaningfulAction:
      getString(value.lastMeaningfulAction) ??
      missionPlan?.progress.lastMeaningfulAction,
    resumeCount: getNumber(value.resumeCount) ?? 0,
    lastSafeStep: getNumber(value.lastSafeStep) ?? 0,
    continuationCommand:
      getString(value.continuationCommand) ?? getContinuationCommand(runId),
    continuationPrompt: getString(value.continuationPrompt),
    ...(() => {
      try {
        return value.continuationHandoff
          ? { continuationHandoff: parseContinuationHandoffV1(value.continuationHandoff) }
          : {};
      } catch {
        return { continuationHandoffInvalid: true as const };
      }
    })(),
    reflexCheckpoints: Array.isArray(value.reflexCheckpoints)
      ? value.reflexCheckpoints
          .map(normalizeReflexCheckpointReceipt)
          .filter((item): item is ReflexCheckpointReceiptV1 => item !== null)
          .slice(-64)
      : [],
    ...(typeof value.userDismissedAt === "string" &&
    Number.isFinite(Date.parse(value.userDismissedAt))
      ? { userDismissedAt: value.userDismissedAt }
      : {}),
    ...(isCurrentNoteWriteKindV1(value.currentNoteWriteKind)
      ? { currentNoteWriteKind: value.currentNoteWriteKind }
      : {}),
    ...normalizePluginVersionStamp(value),
  };
}

function normalizeReflexCheckpointReceipt(
  value: unknown,
): ReflexCheckpointReceiptV1 | null {
  if (!isRecord(value)) return null;
  const checkpoint = value.checkpoint;
  const label = value.label;
  const confidenceBand = value.confidenceBand;
  const reasonCode = value.reasonCode;
  if (
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    ![
      "initial_routing",
      "material_context_change",
      "terminal_attempt",
      "retryable_recovery",
    ].includes(String(checkpoint)) ||
    typeof label !== "string" ||
    !["low", "medium", "high"].includes(String(confidenceBand)) ||
    typeof reasonCode !== "string" ||
    typeof value.applied !== "boolean" ||
    typeof value.actionCount !== "number" ||
    typeof value.evidenceCount !== "number" ||
    typeof value.receiptCount !== "number" ||
    (value.frontierFingerprint !== null && typeof value.frontierFingerprint !== "string") ||
    typeof value.observedAt !== "string" ||
    typeof value.fingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.fingerprint) ||
    !hasValidOptionalReflexScore(value, "confidence") ||
    !hasValidOptionalReflexScore(value, "winningMargin") ||
    !hasValidOptionalReflexAction(value, "suggestedAction") ||
    !hasValidOptionalReflexAction(value, "allowedAction") ||
    !hasValidOptionalReflexReadinessSummary(value.readinessSummary) ||
    !hasValidOptionalReflexScore(value, "progressScore") ||
    !hasValidOptionalReflexScore(value, "loopRiskScore") ||
    !hasValidOptionalReflexDiagnosticCodes(value.completionMissing) ||
    !hasValidOptionalReflexDiagnosticCodes(value.proofDebt) ||
    !hasValidOptionalReflexRecoveryOutcome(value.recoveryOutcome)
  ) {
    return null;
  }
  return value as unknown as ReflexCheckpointReceiptV1;
}

function hasValidOptionalReflexScore(
  value: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return true;
  const score = value[key];
  return typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 1;
}

function hasValidOptionalReflexAction(
  value: Record<string, unknown>,
  key: string,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return true;
  const action = value[key];
  return action === null ||
    (typeof action === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(action));
}

function hasValidOptionalReflexReadinessSummary(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const keys = ["total", "ok", "degraded", "blocked", "unknown"] as const;
  if (
    !keys.every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isInteger(value[key]) &&
        (value[key] as number) >= 0,
    )
  ) {
    return false;
  }
  return value.total ===
    (value.ok as number) +
      (value.degraded as number) +
      (value.blocked as number) +
      (value.unknown as number);
}

function hasValidOptionalReflexDiagnosticCodes(value: unknown): boolean {
  return value === undefined ||
    (Array.isArray(value) &&
      value.length <= 32 &&
      value.every(
        (item) =>
          typeof item === "string" &&
          /^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(item),
      ));
}

function hasValidOptionalReflexRecoveryOutcome(value: unknown): boolean {
  return value === undefined ||
    value === "not_applicable" ||
    value === "retry_scheduled" ||
    value === "replan_scheduled" ||
    value === "recovered" ||
    value === "blocked";
}

function normalizeApprovalRecord(value: unknown): MissionApprovalRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const toolName = getString(value.toolName);
  const action = getString(value.action);
  const decision = getApprovalDecision(value.decision);
  const decidedAt = getString(value.decidedAt);
  if (!id || !toolName || !action || !decision || !decidedAt) {
    return null;
  }
  return { id, toolName, action, decision, decidedAt };
}

function isApprovalRecord(
  value: MissionApprovalRecord | null,
): value is MissionApprovalRecord {
  return value !== null;
}

function getApprovalDecision(
  value: unknown,
): MissionApprovalRecord["decision"] | null {
  return value === "approved" ||
    value === "denied" ||
    value === "expired" ||
    value === "aborted"
    ? value
    : null;
}

function normalizeDependencyStatus(value: unknown): MissionDependencyStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  const category = getBlockerCategory(value.category);
  const status = getDependencyHealthStatus(value.status);
  const capability = getString(value.capability);
  const summary = getString(value.summary);
  const nextAction = getString(value.nextAction);
  if (!category || !status || !capability || !summary || !nextAction) {
    return null;
  }
  return {
    category,
    status,
    capability,
    summary,
    nextAction,
    checkedAt: getString(value.checkedAt),
  };
}

function normalizeLedgerAcceptance(value: unknown):
  | MissionLedger["acceptance"]
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = getString(value.status);
  const confidence = getNumber(value.confidence);
  const checkedAt = getString(value.checkedAt);
  if (!status || confidence === undefined || !checkedAt) {
    return undefined;
  }

  return {
    status,
    confidence,
    missing: getStringArray(value.missing),
    reasons: getStringArray(value.reasons),
    nextAction: getString(value.nextAction),
    checkedAt,
  };
}

function normalizeMissionMilestone(value: unknown): MissionMilestone | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = getString(value.id);
  const missionId = getString(value.missionId);
  const step = getNumber(value.step);
  const stage = getMissionStage(value.stage);
  const summary = getString(value.summary);
  const createdAt = getString(value.createdAt);
  if (!id || !missionId || step === undefined || !stage || !summary || !createdAt) {
    return null;
  }

  return {
    id,
    missionId,
    step,
    stage,
    summary,
    decision: getString(value.decision),
    toolCalls: getStringArray(value.toolCalls),
    evidenceIds: getStringArray(value.evidenceIds),
    artifacts: getStringArray(value.artifacts),
    error: getString(value.error),
    nextAction: getString(value.nextAction),
    createdAt,
  };
}

function normalizeMissionTask(value: unknown): MissionTask | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const title = getString(value.title);
  const status = getTaskStatus(value.status);
  const notes = getString(value.notes) ?? "";
  if (!id || !title || !status) {
    return null;
  }
  return {
    id,
    title,
    status,
    toolNames: getStringArray(value.toolNames),
    evidenceIds: getStringArray(value.evidenceIds),
    notes,
  };
}

function normalizeMissionEvidence(value: unknown): MissionEvidence | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const kind = getEvidenceKind(value.kind);
  const title = getString(value.title);
  const summary = getString(value.summary);
  const confidence = getConfidence(value.confidence);
  if (!id || !kind || !title || !summary || !confidence) {
    return null;
  }
  const sourceId = getString(value.sourceId);
  const passageId = getString(value.passageId);
  const passageIds = [...new Set(getStringArray(value.passageIds))].slice(
    -MAX_PASSAGE_IDS_PER_EVIDENCE,
  );
  const parserStatus =
    value.parserStatus === "parsed" ||
    value.parserStatus === "empty" ||
    value.parserStatus === "missing_content" ||
    value.parserStatus === "legacy_unknown"
      ? value.parserStatus
      : undefined;
  const contentHash = getString(value.contentHash);
  return {
    id,
    kind,
    title,
    ...(getString(value.path) ? { path: getString(value.path) } : {}),
    ...(getString(value.url) ? { url: getString(value.url) } : {}),
    ...(contentHash && /^sha256:[a-f0-9]{64}$/u.test(contentHash)
      ? { contentHash }
      : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(passageId ? { passageId } : {}),
    ...(passageIds.length > 0 ? { passageIds } : {}),
    ...(typeof value.usableSource === "boolean"
      ? { usableSource: value.usableSource }
      : {}),
    ...(parserStatus ? { parserStatus } : {}),
    summary,
    confidence,
  };
}

function isMissionTask(value: MissionTask | null): value is MissionTask {
  return value !== null;
}

function isMissionEvidence(value: MissionEvidence | null): value is MissionEvidence {
  return value !== null;
}

function isMissionMilestone(value: MissionMilestone | null): value is MissionMilestone {
  return value !== null;
}

function isDependencyStatus(
  value: MissionDependencyStatus | null,
): value is MissionDependencyStatus {
  return value !== null;
}

function getLedgerStatus(value: unknown): MissionLedgerStatus | null {
  return value === "running" ||
    value === "complete" ||
    value === "blocked" ||
    value === "stopped" ||
    value === "budget"
    ? value
    : null;
}

function getTaskStatus(value: unknown): MissionTaskStatus | null {
  return value === "pending" ||
    value === "in_progress" ||
    value === "complete" ||
    value === "blocked"
    ? value
    : null;
}

function getEvidenceKind(value: unknown): MissionEvidenceKind | null {
  return value === "vault_note" ||
    value === "web_source" ||
    value === "tool_result" ||
    value === "artifact" ||
    value === "receipt"
    ? value
    : null;
}

function getMissionStage(value: unknown): MissionStage | null {
  return value === "plan" ||
    value === "gather" ||
    value === "browser_observe" ||
    value === "browser_act" ||
    value === "synthesize" ||
    value === "verify" ||
    value === "write_save" ||
    value === "memory_reflection" ||
    value === "next_action"
    ? value
    : null;
}

function getBlockerCategory(value: unknown): MissionBlockerCategory | undefined {
  return value === "provider_auth" ||
    value === "model_timeout" ||
    value === "web_fetch" ||
    value === "semantic_retrieval" ||
    value === "companion_browser" ||
    value === "obsidian_vault" ||
    value === "safety_policy" ||
    value === "tool_unavailable" ||
    value === "provider_budget" ||
    value === "unknown"
    ? value
    : undefined;
}

function normalizeProviderUsage(value: unknown): ModelUsageAggregateV1 {
  const record = isRecord(value) ? value : {};
  return {
    schemaVersion: 1,
    modelCallCount: Math.max(0, Math.floor(getNumber(record.modelCallCount) ?? 0)),
    successfulCallCount: Math.max(0, Math.floor(getNumber(record.successfulCallCount) ?? 0)),
    failedCallCount: Math.max(0, Math.floor(getNumber(record.failedCallCount) ?? 0)),
    reportedTokens: Math.max(0, Math.floor(getNumber(record.reportedTokens) ?? 0)),
    estimatedTokens: Math.max(0, Math.floor(getNumber(record.estimatedTokens) ?? 0)),
    retries: Math.max(0, Math.floor(getNumber(record.retries) ?? 0)),
    wallClockMs: Math.max(0, Math.floor(getNumber(record.wallClockMs) ?? 0)),
    ...(getNumber(record.cachedPromptTokens) !== undefined
      ? {
          cachedPromptTokens: Math.max(
            0,
            Math.floor(getNumber(record.cachedPromptTokens) ?? 0),
          ),
        }
      : {}),
    // Prefix-reuse totals travel as a pair; one without the other is
    // unreadable and normalizes to absent (unknown), never to a zero average.
    ...(getNumber(record.promptPrefixReuseSamples) !== undefined &&
    getNumber(record.promptPrefixReuseRatioTotal) !== undefined
      ? {
          promptPrefixReuseSamples: Math.max(
            0,
            Math.floor(getNumber(record.promptPrefixReuseSamples) ?? 0),
          ),
          promptPrefixReuseRatioTotal: Math.max(
            0,
            getNumber(record.promptPrefixReuseRatioTotal) ?? 0,
          ),
        }
      : {}),
  };
}

function getDependencyHealthStatus(
  value: unknown,
): MissionDependencyStatus["status"] | null {
  return value === "ok" ||
    value === "degraded" ||
    value === "blocked" ||
    value === "unknown"
    ? value
    : null;
}

function getConfidence(value: unknown): MissionEvidence["confidence"] | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function normalizeClaimPassages(value: unknown): ClaimPassageRef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const passages: ClaimPassageRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = getString(item.id);
    const text = getString(item.text);
    if (!id || text === undefined) {
      continue;
    }
    passages.push({
      id,
      text,
      ...(getString(item.evidenceId)
        ? { evidenceId: getString(item.evidenceId) }
        : {}),
      ...(getString(item.subquestionId)
        ? { subquestionId: getString(item.subquestionId) }
        : {}),
    });
    if (passages.length >= MAX_CLAIM_PASSAGES) {
      break;
    }
  }
  return passages.length > 0 ? passages : undefined;
}

function hasLedgerVaultApi(context: ToolExecutionContext): boolean {
  const vault = context.app?.vault;
  return Boolean(
    vault &&
      typeof vault.getFileByPath === "function" &&
      typeof vault.create === "function" &&
      typeof vault.modify === "function" &&
      typeof vault.read === "function" &&
      typeof vault.getFolderByPath === "function" &&
      typeof vault.createFolder === "function",
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists/i.test(error instanceof Error ? error.message : String(error));
}

function sanitizeRunId(runId: string): string {
  return (
    runId
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "run"
  );
}

function getContinuationCommand(runId: string): string {
  return `continue run ${runId}`;
}

export function isTerminalCompleteLedger(ledger: MissionLedger): boolean {
  return ledger.status === "complete" && ledger.acceptance?.status === "pass";
}

function formatDependencyStatusSummary(statuses: MissionDependencyStatus[]): string {
  if (statuses.length === 0) {
    return "none";
  }
  return statuses
    .map((item) => `${item.category}:${item.status}`)
    .join("; ");
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function cloneMissionLedger(ledger: MissionLedger): MissionLedger {
  const cloned = normalizeMissionLedger(JSON.parse(JSON.stringify(ledger)));
  if (!cloned) {
    throw new Error("Cannot serialize invalid mission ledger state.");
  }
  return cloned;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
