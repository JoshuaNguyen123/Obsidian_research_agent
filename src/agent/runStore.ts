import type { TFile } from "obsidian";
import type { MissionAcceptanceResult } from "./missionAcceptance";
import {
  normalizeClaimLedger,
  type ClaimLedger,
  type ClaimPassageRef,
} from "./claimLedger";
import {
  normalizeEvidenceConflicts,
  type EvidenceConflict,
} from "./evidenceConflicts";
import type { MissionEvidence } from "./missionLedger";
import {
  normalizeMissionPlanLike,
  type MissionPlanLike,
} from "./missionPlan";
import {
  normalizeRecoveryState,
  type RecoveryState,
} from "./recoveryEngine";
import {
  normalizeResearchPlan,
  type ResearchPlan,
} from "./researchPlan";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";
import type { OrchestratorSnapshotV1 } from "../orchestrator/types";
import { normalizeOrchestratorSnapshot } from "../orchestrator/orchestratorStore";
import type {
  ActionReceipt,
  AuthorizedActionContext,
  PreparedAction,
  ResourceRef,
  ToolDescriptor,
} from "./actions";

export const MISSION_RUNTIME_SNAPSHOT_VERSION = 2 as const;
export const ACTION_JOURNAL_RECORD_VERSION = 2 as const;
export const MAX_RUNTIME_RECEIPTS = 256;
export const MAX_OPERATION_JOURNAL_RECORDS = 256;
const MAX_CLAIM_PASSAGES = 64;

const AGENT_RUNS_FOLDER = "Agent Runs";
const RUNTIME_SNAPSHOT_HEADING = "## Runtime Snapshot";
const RUNTIME_SNAPSHOT_BLOCK_PATTERN =
  /## Runtime Snapshot\r?\n```json\r?\n[\s\S]*?\r?\n```/;

export type MissionRuntimeStatus =
  | "running"
  | "paused"
  | "blocked"
  | "complete"
  | "stopped"
  | "failed";

export interface MissionRunLineage {
  rootRunId: string;
  segmentId: string;
  segmentIndex: number;
  parentSegmentId?: string;
  priorSegmentIds: string[];
}

export interface MissionRuntimeReceipt {
  /** Canonical action receipts use version 1; absent for migrated legacy receipts. */
  version?: 1;
  id: string;
  toolName: string;
  operation: string;
  message: string;
  createdAt: string;
  actionId?: string;
  resource?: ResourceRef;
  relatedResources?: ResourceRef[];
  payloadFingerprint?: string;
  grantId?: string;
  idempotencyKey?: string;
  providerRequestId?: string;
  startedAt?: string;
  committedAt?: string;
  commitKind?: ActionReceipt["commitKind"];
  readback?: ActionReceipt["readback"];
  effects?: ActionReceipt["effects"];
  path?: string;
  toPath?: string;
  backupPath?: string;
  restoredFromBackupPath?: string;
  bytesWritten?: number;
  bytesDeleted?: number;
  affectedCount?: number;
  output?: unknown;
}

export type OperationJournalState =
  | "intent_recorded"
  | "applying"
  | "applied"
  | "verified"
  | "committed"
  | "failed"
  | "reconcile_required";

export interface OperationJournalTransition {
  state: OperationJournalState;
  at: string;
  message: string;
}

/**
 * A write-ahead record must be persisted in `intent_recorded` before the tool
 * mutation starts. Hashes are deliberately opaque so vault tooling can choose
 * an appropriate digest without coupling the runtime store to a hash library.
 */
export interface ActionJournalRecord {
  version: typeof ACTION_JOURNAL_RECORD_VERSION;
  operationId: string;
  rootRunId: string;
  segmentId: string;
  nodeId?: string;
  toolName: string;
  operation: string;
  targetPath?: string;
  inputHash?: string;
  preWriteHash?: string;
  expectedPostWriteHash?: string;
  observedPostWriteHash?: string;
  preparedAction?: PreparedAction;
  descriptor?: ToolDescriptor;
  authorization?: AuthorizedActionContext;
  state: OperationJournalState;
  mutationMayHaveApplied: boolean;
  receipt?: MissionRuntimeReceipt;
  error?: string;
  createdAt: string;
  updatedAt: string;
  transitions: OperationJournalTransition[];
}

/** Compatibility alias retained for the existing runner and snapshot API. */
export type OperationJournalRecord = ActionJournalRecord;
export type ActionJournalRecordV2 = ActionJournalRecord;

export type OperationReconciliationAction =
  | "safe_to_retry"
  | "inspect_target"
  | "verify_receipt"
  | "provider_reconcile"
  | "manual_review";

export interface OperationReconciliationInput {
  operationId: string;
  rootRunId: string;
  segmentId: string;
  state: OperationJournalState;
  toolName: string;
  operation: string;
  targetPath?: string;
  preWriteHash?: string;
  expectedPostWriteHash?: string;
  observedPostWriteHash?: string;
  preparedAction?: PreparedAction;
  descriptor?: ToolDescriptor;
  authorization?: AuthorizedActionContext;
  receipt?: MissionRuntimeReceipt;
  mutationMayHaveApplied: boolean;
  recommendedAction: OperationReconciliationAction;
}

export interface MissionRuntimeSnapshotV2 {
  version: typeof MISSION_RUNTIME_SNAPSHOT_VERSION;
  revision: number;
  runId: string;
  originalMission: string;
  currentNotePath?: string;
  lineage: MissionRunLineage;
  status: MissionRuntimeStatus;
  createdAt: string;
  updatedAt: string;
  lastSafeStep: number;
  missionPlan?: MissionPlanLike;
  researchPlan?: ResearchPlan;
  /** Operational two-agent projection; never enters conversation history. */
  orchestrator?: OrchestratorSnapshotV1;
  evidence: MissionEvidence[];
  receipts: MissionRuntimeReceipt[];
  operationGoals: Record<string, string>;
  recovery: RecoveryState;
  operationJournal: OperationJournalRecord[];
  acceptance?: MissionAcceptanceResult;
  claimLedger?: ClaimLedger;
  claimPassages?: ClaimPassageRef[];
  evidenceConflicts?: EvidenceConflict[];
  notes: string[];
}

export interface MissionRuntimeSnapshotWriteResult {
  path: string;
  bytesWritten: number;
  revision: number;
}

export interface StoredMissionRuntimeSnapshot {
  path: string;
  snapshot: MissionRuntimeSnapshotV2;
}

export interface LatestIncompleteMissionRuntimeSnapshot
  extends StoredMissionRuntimeSnapshot {
  mtime: number;
}

export interface CreateMissionRuntimeSnapshotInput {
  runId: string;
  originalMission: string;
  currentNotePath?: string | null;
  rootRunId?: string;
  segmentId?: string;
  segmentIndex?: number;
  parentSegmentId?: string;
  priorSegmentIds?: string[];
  status?: MissionRuntimeStatus;
  revision?: number;
  lastSafeStep?: number;
  missionPlan?: MissionPlanLike | null;
  researchPlan?: ResearchPlan | null;
  orchestrator?: OrchestratorSnapshotV1 | null;
  evidence?: MissionEvidence[];
  receipts?: unknown[];
  operationGoals?: Record<string, string>;
  recovery?: RecoveryState | null;
  operationJournal?: OperationJournalRecord[];
  acceptance?: MissionAcceptanceResult | null;
  claimLedger?: ClaimLedger | null;
  claimPassages?: ClaimPassageRef[] | null;
  evidenceConflicts?: EvidenceConflict[] | null;
  notes?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export function createMissionRuntimeSnapshot({
  runId,
  originalMission,
  currentNotePath,
  rootRunId = runId,
  segmentId = runId,
  segmentIndex = 0,
  parentSegmentId,
  priorSegmentIds = [],
  status = "running",
  revision = 0,
  lastSafeStep = 0,
  missionPlan,
  researchPlan,
  orchestrator,
  evidence = [],
  receipts = [],
  operationGoals = {},
  recovery,
  operationJournal = [],
  acceptance,
  claimLedger,
  claimPassages,
  evidenceConflicts,
  notes = [],
  createdAt = new Date(),
  updatedAt = createdAt,
}: CreateMissionRuntimeSnapshotInput): MissionRuntimeSnapshotV2 {
  const created = createdAt.toISOString();
  const updated = updatedAt.toISOString();
  const normalizedClaimLedger = claimLedger
    ? normalizeClaimLedger(claimLedger)
    : null;
  const normalizedClaimPassages = normalizeClaimPassages(claimPassages);
  const normalizedConflicts = normalizeEvidenceConflicts(evidenceConflicts);
  return {
    version: MISSION_RUNTIME_SNAPSHOT_VERSION,
    revision: normalizeNonNegativeInteger(revision),
    runId,
    originalMission,
    currentNotePath: normalizeCurrentNotePath(currentNotePath),
    lineage: {
      rootRunId,
      segmentId,
      segmentIndex: normalizeNonNegativeInteger(segmentIndex),
      parentSegmentId,
      priorSegmentIds: dedupeStrings(priorSegmentIds),
    },
    status,
    createdAt: created,
    updatedAt: updated,
    lastSafeStep: normalizeNonNegativeInteger(lastSafeStep),
    missionPlan: missionPlan ?? undefined,
    researchPlan: researchPlan ?? undefined,
    ...(normalizeOrchestratorSnapshot(orchestrator, { fallbackRunId: runId })
      ? {
          orchestrator: normalizeOrchestratorSnapshot(orchestrator, {
            fallbackRunId: runId,
          })!,
        }
      : {}),
    evidence: evidence.map(cloneEvidence),
    receipts: receipts
      .map((receipt, index) => normalizeRuntimeReceipt(receipt, index, updated))
      .filter(isRuntimeReceipt)
      .slice(-MAX_RUNTIME_RECEIPTS),
    operationGoals: { ...operationGoals },
    recovery: normalizeRecoveryState(recovery, { now: updatedAt }),
    operationJournal: operationJournal
      .map(normalizeOperationJournalRecord)
      .filter(isOperationJournalRecord)
      .slice(-MAX_OPERATION_JOURNAL_RECORDS),
    acceptance: acceptance ? cloneAcceptance(acceptance) : undefined,
    ...(normalizedClaimLedger ? { claimLedger: normalizedClaimLedger } : {}),
    ...(normalizedClaimPassages
      ? { claimPassages: normalizedClaimPassages }
      : {}),
    ...(normalizedConflicts.length > 0
      ? { evidenceConflicts: normalizedConflicts }
      : {}),
    notes: notes.slice(-32).map((note) => note.slice(0, 2000)),
  };
}

/**
 * Accepts the current v2 snapshot and the legacy compact v1 continuation
 * bundle. Legacy bundles migrate without inventing plan/evidence/receipt data
 * that was never persisted in v1.
 */
export function normalizeMissionRuntimeSnapshot(
  value: unknown,
): MissionRuntimeSnapshotV2 | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version === 1) {
    return migrateMissionRuntimeSnapshotV1(value);
  }
  if (value.version !== MISSION_RUNTIME_SNAPSHOT_VERSION) {
    return null;
  }

  const runId = getNonEmptyString(value.runId);
  const originalMission = getNonEmptyString(value.originalMission);
  const createdAt = getNonEmptyString(value.createdAt);
  const updatedAt = getNonEmptyString(value.updatedAt);
  const status = normalizeRuntimeStatus(value.status);
  if (!runId || !originalMission || !createdAt || !updatedAt || !status) {
    return null;
  }
  const lineage = normalizeLineage(value.lineage, runId);
  if (!lineage) {
    return null;
  }

  const missionPlan = normalizeMissionPlanLike(value.missionPlan);
  const researchPlan = normalizeResearchPlan(value.researchPlan);
  const orchestrator = normalizeOrchestratorSnapshot(value.orchestrator, {
    fallbackRunId: runId,
  });
  const evidence = (Array.isArray(value.evidence) ? value.evidence : [])
    .map(normalizeEvidence)
    .filter(isMissionEvidence);
  const receipts = (Array.isArray(value.receipts) ? value.receipts : [])
    .map((receipt, index) => normalizeRuntimeReceipt(receipt, index, updatedAt))
    .filter(isRuntimeReceipt)
    .slice(-MAX_RUNTIME_RECEIPTS);
  const operationJournal = (
    Array.isArray(value.operationJournal) ? value.operationJournal : []
  )
    .map(normalizeOperationJournalRecord)
    .filter(isOperationJournalRecord)
    .slice(-MAX_OPERATION_JOURNAL_RECORDS);

  return {
    version: MISSION_RUNTIME_SNAPSHOT_VERSION,
    revision: normalizeNonNegativeInteger(value.revision),
    runId,
    originalMission,
    currentNotePath: normalizeCurrentNotePath(value.currentNotePath),
    lineage,
    status,
    createdAt,
    updatedAt,
    lastSafeStep: normalizeNonNegativeInteger(value.lastSafeStep),
    missionPlan,
    researchPlan,
    ...(orchestrator ? { orchestrator } : {}),
    evidence,
    receipts,
    operationGoals: normalizeOperationGoals(value.operationGoals),
    recovery: normalizeRecoveryState(value.recovery, {
      now: parseDateOrNow(updatedAt),
    }),
    operationJournal,
    acceptance: normalizeAcceptance(value.acceptance),
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
    notes: getStringArray(value.notes)
      .slice(-32)
      .map((note) => note.slice(0, 2000)),
  };
}

export function getMissionRuntimeSnapshotPath(runId: string): string {
  return normalizeVaultPath(
    `${AGENT_RUNS_FOLDER}/${sanitizeRunId(runId)}.md`,
    { requireMarkdown: true },
  );
}

export function formatMissionRuntimeSnapshotBlock(
  snapshot: MissionRuntimeSnapshotV2,
): string {
  return [
    RUNTIME_SNAPSHOT_HEADING,
    "```json",
    JSON.stringify(snapshot, null, 2),
    "```",
    "",
  ].join("\n");
}

export function parseMissionRuntimeSnapshotFromMarkdown(
  markdown: string,
): MissionRuntimeSnapshotV2 | null {
  const match = RUNTIME_SNAPSHOT_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return null;
  }
  const json = /```json\r?\n([\s\S]*?)\r?\n```/.exec(match[0])?.[1];
  if (!json) {
    return null;
  }
  try {
    return normalizeMissionRuntimeSnapshot(JSON.parse(json));
  } catch {
    return null;
  }
}

export async function writeMissionRuntimeSnapshot(
  context: ToolExecutionContext,
  snapshot: MissionRuntimeSnapshotV2,
): Promise<MissionRuntimeSnapshotWriteResult | null> {
  if (!hasRuntimeSnapshotVaultApi(context)) {
    return null;
  }
  const requested = normalizeMissionRuntimeSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
  );
  if (!requested) {
    throw new Error("Cannot serialize invalid mission runtime snapshot.");
  }

  const vault = context.app.vault;
  return withSerializedRunWrite(vault, requested.runId, async () => {
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

    const path = getMissionRuntimeSnapshotPath(requested.runId);
    const file = vault.getFileByPath(path);
    let current = "";
    let persistedRevision = 0;
    if (file) {
      current = await vault.read(file as TFile);
      persistedRevision =
        parseMissionRuntimeSnapshotFromMarkdown(current)?.revision ?? 0;
    }

    requested.revision = Math.max(requested.revision, persistedRevision) + 1;
    requested.updatedAt = (context.now?.() ?? new Date()).toISOString();
    const block = formatMissionRuntimeSnapshotBlock(requested);

    if (!file) {
      const content = `# Agent Run ${sanitizeRunId(requested.runId)}\n\n${block}`;
      await vault.create(path, content);
      snapshot.revision = Math.max(snapshot.revision, requested.revision);
      snapshot.updatedAt = requested.updatedAt;
      return {
        path,
        bytesWritten: getByteLength(content),
        revision: requested.revision,
      };
    }

    const next = replaceRuntimeSnapshotBlock(current, block);
    await vault.modify(file as TFile, next);
    snapshot.revision = Math.max(snapshot.revision, requested.revision);
    snapshot.updatedAt = requested.updatedAt;
    return {
      path,
      bytesWritten: getByteLength(block),
      revision: requested.revision,
    };
  });
}

export function canPersistMissionRuntimeSnapshot(
  context: ToolExecutionContext,
): boolean {
  return hasRuntimeSnapshotVaultApi(context);
}

export async function readMissionRuntimeSnapshotByRunId(
  context: ToolExecutionContext,
  runId: string,
): Promise<StoredMissionRuntimeSnapshot | null> {
  if (!hasRuntimeSnapshotVaultApi(context)) {
    return null;
  }
  const vault = context.app.vault;
  return withSerializedRunWrite(vault, runId, async () => {
    const path = getMissionRuntimeSnapshotPath(runId);
    const file = vault.getFileByPath(path);
    if (!file) {
      return null;
    }
    const markdown = await vault.read(file as TFile);
    const snapshot = parseMissionRuntimeSnapshotFromMarkdown(markdown);
    return snapshot ? { path, snapshot } : null;
  });
}

export async function readLatestIncompleteMissionRuntimeSnapshot(
  context: ToolExecutionContext,
): Promise<LatestIncompleteMissionRuntimeSnapshot | null> {
  if (
    !hasRuntimeSnapshotVaultApi(context) ||
    typeof context.app.vault.getFiles !== "function"
  ) {
    return null;
  }
  const vault = context.app.vault;
  const candidates = vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/[^/]+\.md$/i.test(file.path))
    .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));

  for (const file of candidates) {
    const runKey = file.basename || file.path;
    const loaded = await withSerializedRunWrite(vault, runKey, async () => {
      const markdown = await vault.read(file);
      return parseMissionRuntimeSnapshotFromMarkdown(markdown);
    });
    if (loaded && isIncompleteRuntimeSnapshot(loaded)) {
      return {
        path: file.path,
        snapshot: loaded,
        mtime: file.stat?.mtime ?? 0,
      };
    }
  }
  return null;
}

export function migrateMissionRuntimeSnapshotV1(
  value: Record<string, unknown>,
): MissionRuntimeSnapshotV2 | null {
  const runId = getNonEmptyString(value.runId);
  const prompt = getNonEmptyString(value.prompt);
  const createdAtText = getNonEmptyString(value.createdAt);
  if (!runId || !prompt || !createdAtText) {
    return null;
  }
  const createdAt = parseDateOrNow(createdAtText);
  const recoverySummary = isRecord(value.recovery) ? value.recovery : {};
  const legacyAttemptCount = normalizeNonNegativeInteger(recoverySummary.attempts);
  const recovery = normalizeRecoveryState(
    {
      version: 1,
      attempts: [],
      maxAttempts: 2,
      maxStoredAttempts: 32,
      totalAttempts: legacyAttemptCount,
      signatureCounts:
        legacyAttemptCount > 0 ? { legacy_continuation: legacyAttemptCount } : {},
      updatedAt: createdAtText,
    },
    { now: createdAt },
  );
  const acceptanceSummary =
    normalizeAcceptance(value.acceptance) ?? normalizeLegacyAcceptance(value.acceptance);
  const status: MissionRuntimeStatus =
    acceptanceSummary?.status === "pass" ? "complete" : "paused";

  return createMissionRuntimeSnapshot({
    runId,
    originalMission: prompt,
    status,
    recovery,
    acceptance: acceptanceSummary,
    notes: getStringArray(value.notes),
    createdAt,
    updatedAt: createdAt,
  });
}

export function createOperationJournalRecord({
  operationId,
  rootRunId,
  segmentId,
  nodeId,
  toolName,
  operation,
  targetPath,
  inputHash,
  preWriteHash,
  expectedPostWriteHash,
  preparedAction,
  descriptor,
  authorization,
  now = new Date(),
}: {
  operationId: string;
  rootRunId: string;
  segmentId: string;
  nodeId?: string;
  toolName: string;
  operation: string;
  targetPath?: string;
  inputHash?: string;
  preWriteHash?: string;
  expectedPostWriteHash?: string;
  preparedAction?: PreparedAction;
  descriptor?: ToolDescriptor;
  authorization?: AuthorizedActionContext;
  now?: Date;
}): OperationJournalRecord {
  const timestamp = now.toISOString();
  return {
    version: ACTION_JOURNAL_RECORD_VERSION,
    operationId,
    rootRunId,
    segmentId,
    nodeId,
    toolName,
    operation,
    targetPath,
    inputHash,
    preWriteHash,
    expectedPostWriteHash,
    preparedAction: preparedAction ? clonePreparedAction(preparedAction) : undefined,
    descriptor: descriptor ? cloneToolDescriptor(descriptor) : undefined,
    authorization: authorization ? { ...authorization } : undefined,
    state: "intent_recorded",
    mutationMayHaveApplied: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: [
      {
        state: "intent_recorded",
        at: timestamp,
        message: "Mutation intent recorded before execution.",
      },
    ],
  };
}

export function transitionOperationJournalRecord(
  record: OperationJournalRecord,
  state: OperationJournalState,
  {
    message,
    receipt,
    observedPostWriteHash,
    error,
    mutationMayHaveApplied,
    now = new Date(),
  }: {
    message: string;
    receipt?: unknown;
    observedPostWriteHash?: string;
    error?: string;
    mutationMayHaveApplied?: boolean;
    now?: Date;
  },
): OperationJournalRecord {
  if (!isAllowedJournalTransition(record.state, state)) {
    throw new Error(`Invalid operation journal transition: ${record.state} -> ${state}`);
  }
  const timestamp = now.toISOString();
  const normalizedReceipt = receipt
    ? normalizeRuntimeReceipt(receipt, 0, timestamp) ?? undefined
    : record.receipt;
  return {
    ...record,
    state,
    receipt: normalizedReceipt,
    observedPostWriteHash:
      observedPostWriteHash ?? record.observedPostWriteHash,
    error: error ?? record.error,
    mutationMayHaveApplied:
      mutationMayHaveApplied ??
      (record.mutationMayHaveApplied ||
        state === "applied" ||
        state === "verified" ||
        state === "committed" ||
        state === "reconcile_required"),
    updatedAt: timestamp,
    transitions: [
      ...record.transitions,
      { state, at: timestamp, message: message.trim() || state },
    ].slice(-32),
  };
}

export function buildOperationReconciliationInputs(
  records: OperationJournalRecord[],
): OperationReconciliationInput[] {
  return records
    .filter((record) => record.state !== "committed")
    .map((record) => ({
      operationId: record.operationId,
      rootRunId: record.rootRunId,
      segmentId: record.segmentId,
      state: record.state,
      toolName: record.toolName,
      operation: record.operation,
      targetPath: record.targetPath,
      preWriteHash: record.preWriteHash,
      expectedPostWriteHash: record.expectedPostWriteHash,
      observedPostWriteHash: record.observedPostWriteHash,
      preparedAction: record.preparedAction
        ? clonePreparedAction(record.preparedAction)
        : undefined,
      descriptor: record.descriptor
        ? cloneToolDescriptor(record.descriptor)
        : undefined,
      authorization: record.authorization
        ? { ...record.authorization }
        : undefined,
      receipt: record.receipt
        ? cloneRuntimeReceipt(record.receipt)
        : undefined,
      mutationMayHaveApplied: record.mutationMayHaveApplied,
      recommendedAction: getReconciliationAction(record),
    }));
}

const runWriteQueues = new WeakMap<object, Map<string, Promise<void>>>();

/** Serializes all Agent Runs file read-modify-write operations per vault/run. */
export async function withSerializedRunWrite<T>(
  vault: object,
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let vaultQueues = runWriteQueues.get(vault);
  if (!vaultQueues) {
    vaultQueues = new Map<string, Promise<void>>();
    runWriteQueues.set(vault, vaultQueues);
  }
  const key = sanitizeRunId(runId);
  const previous = vaultQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  vaultQueues.set(key, tail);

  try {
    return await result;
  } finally {
    if (vaultQueues.get(key) === tail) {
      vaultQueues.delete(key);
    }
  }
}

function normalizeLineage(
  value: unknown,
  fallbackRunId: string,
): MissionRunLineage | null {
  if (!isRecord(value)) {
    return {
      rootRunId: fallbackRunId,
      segmentId: fallbackRunId,
      segmentIndex: 0,
      priorSegmentIds: [],
    };
  }
  const rootRunId = getNonEmptyString(value.rootRunId) ?? fallbackRunId;
  const segmentId = getNonEmptyString(value.segmentId) ?? fallbackRunId;
  return {
    rootRunId,
    segmentId,
    segmentIndex: normalizeNonNegativeInteger(value.segmentIndex),
    parentSegmentId: getNonEmptyString(value.parentSegmentId),
    priorSegmentIds: dedupeStrings(getStringArray(value.priorSegmentIds)),
  };
}

function normalizeEvidence(value: unknown): MissionEvidence | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getNonEmptyString(value.id);
  const kind = value.kind;
  const title = getNonEmptyString(value.title);
  const summary = getNonEmptyString(value.summary);
  const confidence = value.confidence;
  if (
    !id ||
    !title ||
    !summary ||
    (kind !== "vault_note" &&
      kind !== "web_source" &&
      kind !== "tool_result" &&
      kind !== "artifact" &&
      kind !== "receipt") ||
    (confidence !== "low" && confidence !== "medium" && confidence !== "high")
  ) {
    return null;
  }
  const sourceId = getNonEmptyString(value.sourceId);
  const passageId = getNonEmptyString(value.passageId);
  const passageIds = dedupeStrings(getStringArray(value.passageIds)).slice(0, 6);
  return {
    id,
    kind,
    title,
    path: getNonEmptyString(value.path),
    url: getNonEmptyString(value.url),
    ...(sourceId ? { sourceId } : {}),
    ...(passageId ? { passageId } : {}),
    ...(passageIds.length > 0 ? { passageIds } : {}),
    summary,
    confidence,
  };
}

function normalizeRuntimeReceipt(
  value: unknown,
  index: number,
  fallbackCreatedAt: string,
): MissionRuntimeReceipt | null {
  if (!isRecord(value)) {
    return null;
  }
  const toolName = getNonEmptyString(value.toolName);
  const operation = getNonEmptyString(value.operation);
  if (!toolName || !operation) {
    return null;
  }
  const resource = normalizeResourceRef(value.resource);
  const relatedResources = (Array.isArray(value.relatedResources)
    ? value.relatedResources
    : []
  )
    .map(normalizeResourceRef)
    .filter(isResourceRef);
  const effects = isRecord(value.effects) ? value.effects : null;
  const readback = normalizeActionReadback(value.readback);
  const actionId = getNonEmptyString(value.actionId);
  const payloadFingerprint = getNonEmptyString(value.payloadFingerprint);
  const grantId = getNonEmptyString(value.grantId);
  const canonical =
    value.version === 1 &&
    Boolean(actionId && resource && payloadFingerprint && grantId && readback);
  const committedAt = getNonEmptyString(value.committedAt);
  return {
    ...(canonical ? { version: 1 as const } : {}),
    id: getNonEmptyString(value.id) ?? `receipt-${index + 1}`,
    toolName,
    operation,
    message:
      getNonEmptyString(value.message) ?? `${operation} ${getNonEmptyString(value.path) ?? ""}`.trim(),
    createdAt:
      getNonEmptyString(value.createdAt) ?? committedAt ?? fallbackCreatedAt,
    ...(actionId ? { actionId } : {}),
    ...(resource ? { resource } : {}),
    ...(relatedResources.length > 0 ? { relatedResources } : {}),
    ...(payloadFingerprint ? { payloadFingerprint } : {}),
    ...(grantId ? { grantId } : {}),
    idempotencyKey: getNonEmptyString(value.idempotencyKey),
    providerRequestId: getNonEmptyString(value.providerRequestId),
    startedAt: getNonEmptyString(value.startedAt),
    committedAt,
    commitKind:
      value.commitKind === "committed" || value.commitKind === "reconciled"
        ? value.commitKind
        : undefined,
    ...(readback ? { readback } : {}),
    ...(effects
      ? {
          effects: {
            bytesWritten: getFiniteNumber(effects.bytesWritten),
            bytesDeleted: getFiniteNumber(effects.bytesDeleted),
            affectedCount: getFiniteNumber(effects.affectedCount),
            changedFields: getStringArray(effects.changedFields),
          },
        }
      : {}),
    path:
      getNonEmptyString(value.path) ??
      (resource?.system === "vault" ? resource.path : undefined),
    toPath: getNonEmptyString(value.toPath),
    backupPath: getNonEmptyString(value.backupPath),
    restoredFromBackupPath: getNonEmptyString(value.restoredFromBackupPath),
    bytesWritten:
      getFiniteNumber(value.bytesWritten) ??
      getFiniteNumber(effects?.bytesWritten),
    bytesDeleted:
      getFiniteNumber(value.bytesDeleted) ??
      getFiniteNumber(effects?.bytesDeleted),
    affectedCount:
      getFiniteNumber(value.affectedCount) ??
      getFiniteNumber(effects?.affectedCount),
    output: value.output,
  };
}

function normalizeOperationJournalRecord(
  value: unknown,
): OperationJournalRecord | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
    return null;
  }
  const operationId = getNonEmptyString(value.operationId);
  const rootRunId = getNonEmptyString(value.rootRunId);
  const segmentId = getNonEmptyString(value.segmentId);
  const toolName = getNonEmptyString(value.toolName);
  const operation = getNonEmptyString(value.operation);
  const state = normalizeJournalState(value.state);
  const createdAt = getNonEmptyString(value.createdAt);
  const updatedAt = getNonEmptyString(value.updatedAt);
  if (
    !operationId ||
    !rootRunId ||
    !segmentId ||
    !toolName ||
    !operation ||
    !state ||
    !createdAt ||
    !updatedAt
  ) {
    return null;
  }
  const transitions = (Array.isArray(value.transitions) ? value.transitions : [])
    .map(normalizeJournalTransition)
    .filter(isJournalTransition)
    .slice(-32);
  return {
    version: ACTION_JOURNAL_RECORD_VERSION,
    operationId,
    rootRunId,
    segmentId,
    nodeId: getNonEmptyString(value.nodeId),
    toolName,
    operation,
    targetPath: getNonEmptyString(value.targetPath),
    inputHash: getNonEmptyString(value.inputHash),
    preWriteHash: getNonEmptyString(value.preWriteHash),
    expectedPostWriteHash: getNonEmptyString(value.expectedPostWriteHash),
    observedPostWriteHash: getNonEmptyString(value.observedPostWriteHash),
    preparedAction: normalizePreparedAction(value.preparedAction) ?? undefined,
    descriptor: normalizeToolDescriptor(value.descriptor) ?? undefined,
    authorization:
      normalizeAuthorizedActionContext(value.authorization) ?? undefined,
    state,
    mutationMayHaveApplied: value.mutationMayHaveApplied === true,
    receipt: normalizeRuntimeReceipt(value.receipt, 0, updatedAt) ?? undefined,
    error: getNonEmptyString(value.error),
    createdAt,
    updatedAt,
    transitions:
      transitions.length > 0
        ? transitions
        : [{ state, at: updatedAt, message: "Migrated journal state." }],
  };
}

function normalizePreparedAction(value: unknown): PreparedAction | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !getNonEmptyString(value.id) ||
    !getNonEmptyString(value.runId) ||
    !getNonEmptyString(value.toolCallId) ||
    !getNonEmptyString(value.toolName) ||
    !getNonEmptyString(value.payloadFingerprint) ||
    !getNonEmptyString(value.preparedAt) ||
    !getNonEmptyString(value.expiresAt) ||
    !normalizeResourceRef(value.target) ||
    !isRecord(value.normalizedArgs) ||
    !isRecord(value.preview) ||
    !Array.isArray(value.relatedResources)
  ) {
    return null;
  }
  const relatedResources = value.relatedResources
    .map(normalizeResourceRef)
    .filter(isResourceRef);
  if (relatedResources.length !== value.relatedResources.length) {
    return null;
  }
  try {
    return clonePreparedAction(value as unknown as PreparedAction);
  } catch {
    return null;
  }
}

function normalizeToolDescriptor(value: unknown): ToolDescriptor | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !getNonEmptyString(value.name) ||
    !isRecord(value.capability) ||
    !isResourceSystem(value.capability.system) ||
    !getNonEmptyString(value.capability.resourceType) ||
    !getNonEmptyString(value.capability.action) ||
    !getNonEmptyString(value.effect) ||
    !getNonEmptyString(value.risk) ||
    !isRecord(value.approval) ||
    !isRecord(value.execution) ||
    !isRecord(value.durability) ||
    !Array.isArray(value.allowedPrincipals)
  ) {
    return null;
  }
  try {
    return cloneToolDescriptor(value as unknown as ToolDescriptor);
  } catch {
    return null;
  }
}

function normalizeAuthorizedActionContext(
  value: unknown,
): AuthorizedActionContext | null {
  if (!isRecord(value)) {
    return null;
  }
  const preparedActionId = getNonEmptyString(value.preparedActionId);
  const payloadFingerprint = getNonEmptyString(value.payloadFingerprint);
  const grantId = getNonEmptyString(value.grantId);
  return preparedActionId && payloadFingerprint && grantId
    ? { preparedActionId, payloadFingerprint, grantId }
    : null;
}

function normalizeResourceRef(value: unknown): ResourceRef | null {
  if (!isRecord(value) || !isResourceSystem(value.system)) {
    return null;
  }
  const resourceType = getNonEmptyString(value.resourceType);
  const id = getNonEmptyString(value.id);
  if (!resourceType || !id) {
    return null;
  }
  return {
    system: value.system,
    resourceType,
    id,
    identifier: getNonEmptyString(value.identifier),
    url: getNonEmptyString(value.url),
    path: getNonEmptyString(value.path),
    accountId: getNonEmptyString(value.accountId),
    containerId: getNonEmptyString(value.containerId),
    workspaceId: getNonEmptyString(value.workspaceId),
    teamId: getNonEmptyString(value.teamId),
    projectId: getNonEmptyString(value.projectId),
    repositoryId: getNonEmptyString(value.repositoryId),
    repositoryProfileId: getNonEmptyString(value.repositoryProfileId),
    revision: getNonEmptyString(value.revision),
  };
}

function normalizeActionReadback(
  value: unknown,
): ActionReceipt["readback"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = value.status;
  const checkedAt = getNonEmptyString(value.checkedAt);
  if ((status !== "verified" && status !== "not_required") || !checkedAt) {
    return null;
  }
  return {
    status,
    checkedAt,
    observedRevision: getNonEmptyString(value.observedRevision),
    observedFingerprint: getNonEmptyString(value.observedFingerprint),
  };
}

function isResourceSystem(value: unknown): value is ResourceRef["system"] {
  return (
    value === "vault" ||
    value === "web" ||
    value === "browser" ||
    value === "workspace" ||
    value === "git" ||
    value === "linear" ||
    value === "github"
  );
}

function isResourceRef(value: ResourceRef | null): value is ResourceRef {
  return value !== null;
}

function clonePreparedAction(action: PreparedAction): PreparedAction {
  return JSON.parse(JSON.stringify(action)) as PreparedAction;
}

function cloneToolDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  return JSON.parse(JSON.stringify(descriptor)) as ToolDescriptor;
}

function cloneRuntimeReceipt(receipt: MissionRuntimeReceipt): MissionRuntimeReceipt {
  return JSON.parse(JSON.stringify(receipt)) as MissionRuntimeReceipt;
}

function normalizeJournalTransition(
  value: unknown,
): OperationJournalTransition | null {
  if (!isRecord(value)) {
    return null;
  }
  const state = normalizeJournalState(value.state);
  const at = getNonEmptyString(value.at);
  const message = getNonEmptyString(value.message);
  return state && at && message ? { state, at, message } : null;
}

function isAllowedJournalTransition(
  from: OperationJournalState,
  to: OperationJournalState,
): boolean {
  const allowed: Record<OperationJournalState, OperationJournalState[]> = {
    intent_recorded: ["applying", "failed"],
    applying: ["applied", "failed", "reconcile_required"],
    applied: ["verified", "failed", "reconcile_required"],
    verified: ["committed", "failed", "reconcile_required"],
    committed: [],
    failed: ["reconcile_required"],
    reconcile_required: ["verified", "committed", "failed"],
  };
  return allowed[from].includes(to);
}

function getReconciliationAction(
  record: OperationJournalRecord,
): OperationReconciliationAction {
  if (record.state === "intent_recorded" && !record.mutationMayHaveApplied) {
    return "safe_to_retry";
  }
  if (record.receipt && record.state !== "committed") {
    return "verify_receipt";
  }
  if (
    record.preparedAction &&
    record.descriptor?.durability.reconciliation !== "none" &&
    record.mutationMayHaveApplied
  ) {
    return "provider_reconcile";
  }
  if (record.targetPath && record.mutationMayHaveApplied) {
    return "inspect_target";
  }
  return "manual_review";
}

function normalizeAcceptance(value: unknown): MissionAcceptanceResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = value.status;
  const confidence = getFiniteNumber(value.confidence);
  if (
    (status !== "pass" && status !== "fail" && status !== "needs_more_work") ||
    confidence === undefined
  ) {
    return undefined;
  }
  return {
    status,
    confidence,
    missing: getStringArray(value.missing),
    reasons: getStringArray(value.reasons),
    nextAction: getNonEmptyString(value.nextAction),
  };
}

function normalizeLegacyAcceptance(
  value: unknown,
): MissionAcceptanceResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const status = value.status;
  if (status !== "pass" && status !== "fail" && status !== "needs_more_work") {
    return undefined;
  }
  return {
    status,
    confidence: status === "pass" ? 0.5 : 0,
    missing: getStringArray(value.missing),
    reasons: ["migrated_from_compact_v1_continuation"],
    nextAction: getNonEmptyString(value.nextAction),
  };
}

function cloneAcceptance(value: MissionAcceptanceResult): MissionAcceptanceResult {
  return {
    ...value,
    missing: [...value.missing],
    reasons: [...value.reasons],
  };
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
    const id = getNonEmptyString(item.id);
    const text = typeof item.text === "string" ? item.text : undefined;
    if (!id || text === undefined) {
      continue;
    }
    passages.push({
      id,
      text,
      ...(getNonEmptyString(item.evidenceId)
        ? { evidenceId: getNonEmptyString(item.evidenceId) }
        : {}),
      ...(getNonEmptyString(item.subquestionId)
        ? { subquestionId: getNonEmptyString(item.subquestionId) }
        : {}),
    });
    if (passages.length >= MAX_CLAIM_PASSAGES) {
      break;
    }
  }
  return passages.length > 0 ? passages : undefined;
}

function cloneEvidence(value: MissionEvidence): MissionEvidence {
  return { ...value };
}

function normalizeOperationGoals(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, string>>(
    (output, [key, state]) => {
      if (key.trim() && typeof state === "string") {
        output[key] = state;
      }
      return output;
    },
    {},
  );
}

function normalizeCurrentNotePath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return normalizeVaultPath(value, { requireMarkdown: true });
  } catch {
    return undefined;
  }
}

function normalizeRuntimeStatus(value: unknown): MissionRuntimeStatus | null {
  return value === "running" ||
    value === "paused" ||
    value === "blocked" ||
    value === "complete" ||
    value === "stopped" ||
    value === "failed"
    ? value
    : null;
}

function normalizeJournalState(value: unknown): OperationJournalState | null {
  return value === "intent_recorded" ||
    value === "applying" ||
    value === "applied" ||
    value === "verified" ||
    value === "committed" ||
    value === "failed" ||
    value === "reconcile_required"
    ? value
    : null;
}

function isRuntimeReceipt(
  value: MissionRuntimeReceipt | null,
): value is MissionRuntimeReceipt {
  return value !== null;
}

function isOperationJournalRecord(
  value: OperationJournalRecord | null,
): value is OperationJournalRecord {
  return value !== null;
}

function isJournalTransition(
  value: OperationJournalTransition | null,
): value is OperationJournalTransition {
  return value !== null;
}

function isMissionEvidence(
  value: MissionEvidence | null,
): value is MissionEvidence {
  return value !== null;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const number = getFiniteNumber(value) ?? 0;
  return Math.max(0, Math.floor(number));
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function parseDateOrNow(value: string): Date {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

function replaceRuntimeSnapshotBlock(current: string, block: string): string {
  if (RUNTIME_SNAPSHOT_BLOCK_PATTERN.test(current)) {
    return current.replace(
      RUNTIME_SNAPSHOT_BLOCK_PATTERN,
      block.trimEnd(),
    );
  }
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${block}`;
}

function hasRuntimeSnapshotVaultApi(context: ToolExecutionContext): boolean {
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

function isIncompleteRuntimeSnapshot(
  snapshot: MissionRuntimeSnapshotV2,
): boolean {
  return snapshot.status !== "complete";
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
