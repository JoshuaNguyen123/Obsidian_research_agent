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
import {
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  type ActionReceipt,
  type AuthorizedActionContext,
  type PreparedAction,
  type ResourceRef,
  type ToolDescriptor,
} from "./actions";
import {
  linearIssueStateUpdateAttemptIdV1,
  parsePreparedExternalActionHandoffV1,
  type PreparedExternalActionHandoffV1,
} from "../../packages/core-api/src/preparedExternalActionHandoffV1";
import {
  backgroundCodeContinuationAttemptIdV1,
  parsePreparedBackgroundCodeActionV1,
  type PreparedBackgroundCodeActionV1,
} from "../../packages/core-api/src/preparedBackgroundCodeActionV1";
import {
  parsePreparedBackgroundCodePackageIdentityV1,
  type PreparedBackgroundCodePackageIdentityV1,
} from "../../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import {
  backgroundGitHubActionAttemptIdV1,
  parsePreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubOperationV1,
} from "../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import {
  parsePreparedBackgroundGitHubPackageIdentityV1,
  type PreparedBackgroundGitHubPackageIdentityV1,
} from "../../packages/core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import {
  parseBackgroundGitHubVerifiedResultV1,
  type BackgroundGitHubVerifiedResultV1,
} from "../../packages/core-api/src/backgroundGitHubVerifiedResultV1";

export const MISSION_RUNTIME_SNAPSHOT_VERSION = 2 as const;
export const ACTION_JOURNAL_RECORD_VERSION = 2 as const;
export const MAX_RUNTIME_RECEIPTS = 256;
export const MAX_OPERATION_JOURNAL_RECORDS = 256;
export const MAX_EXTERNAL_ACTION_RUNTIME_LOOKUP_FILES = 256;
export const RUNTIME_SNAPSHOT_MODIFY_TIMEOUT_MS = 15_000;
export const RUNTIME_SNAPSHOT_READBACK_TIMEOUT_MS = 5_000;
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

export interface MissionGraphStoreReferenceV1 {
  version: 1;
  missionId: string;
  path: string;
  storeRevision: number;
  graphRevision: number;
  recordFingerprint: string;
  journalHeadFingerprint: string | null;
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
  | "dispatched"
  | "ambiguous"
  | "readback_verified"
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

export interface ExternalActionDispatchAttemptV1 {
  version: 1;
  provider: "linear";
  operation: "linear_issue_state_update_v1";
  jobId: string;
  attemptId: string;
  handoffFingerprint: string;
  status:
    | "prepared"
    | "job_submitted"
    | "dispatched"
    | "ambiguous"
    | "readback_verified";
  preparedAt: string;
  submittedAt: string | null;
  dispatchedReceiptFingerprint: string | null;
  ambiguousReceiptFingerprint: string | null;
  verifiedReceiptFingerprint: string | null;
  updatedAt: string;
}

export interface BackgroundCodeDispatchAttemptV1 {
  version: 1;
  provider: "code";
  operation: "prepared_code_validation_commit_v1";
  jobId: string;
  attemptId: string;
  handoffFingerprint: string;
  packageFingerprint: string;
  packageIdentityFingerprint: string;
  status:
    | "prepared"
    | "job_submitted"
    | "dispatched"
    | "ambiguous"
    | "readback_verified";
  preparedAt: string;
  submittedAt: string | null;
  dispatchedReceiptFingerprint: string | null;
  ambiguousReceiptFingerprint: string | null;
  verifiedReceiptFingerprint: string | null;
  verifiedCommitReceiptFingerprint: string | null;
  commitSha: string | null;
  updatedAt: string;
}

export interface BackgroundGitHubDispatchAttemptV1 {
  version: 1;
  provider: "github";
  operation: PreparedBackgroundGitHubOperationV1;
  jobId: string;
  attemptId: string;
  actionFingerprint: string;
  packageFingerprint: string;
  packageIdentityFingerprint: string;
  status:
    | "prepared"
    | "job_submitted"
    | "dispatched"
    | "ambiguous"
    | "readback_verified";
  preparedAt: string;
  submittedAt: string | null;
  dispatchedReceiptFingerprint: string | null;
  ambiguousReceiptFingerprint: string | null;
  verifiedReceiptFingerprint: string | null;
  verifiedResultFingerprint: string | null;
  updatedAt: string;
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
  preparedExternalActionHandoff?: PreparedExternalActionHandoffV1;
  externalActionDispatchAttempt?: ExternalActionDispatchAttemptV1;
  preparedBackgroundCodeAction?: PreparedBackgroundCodeActionV1;
  preparedBackgroundCodePackage?: PreparedBackgroundCodePackageIdentityV1;
  backgroundCodeDispatchAttempt?: BackgroundCodeDispatchAttemptV1;
  preparedBackgroundGitHubAction?: PreparedBackgroundGitHubActionV1;
  preparedBackgroundGitHubPackage?: PreparedBackgroundGitHubPackageIdentityV1;
  backgroundGitHubDispatchAttempt?: BackgroundGitHubDispatchAttemptV1;
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
  preparedExternalActionHandoff?: PreparedExternalActionHandoffV1;
  externalActionDispatchAttempt?: ExternalActionDispatchAttemptV1;
  preparedBackgroundCodeAction?: PreparedBackgroundCodeActionV1;
  preparedBackgroundCodePackage?: PreparedBackgroundCodePackageIdentityV1;
  backgroundCodeDispatchAttempt?: BackgroundCodeDispatchAttemptV1;
  preparedBackgroundGitHubAction?: PreparedBackgroundGitHubActionV1;
  preparedBackgroundGitHubPackage?: PreparedBackgroundGitHubPackageIdentityV1;
  backgroundGitHubDispatchAttempt?: BackgroundGitHubDispatchAttemptV1;
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
  /** Canonical graph state lives in the CAS/WAL graph store; this is a verified link. */
  missionGraphRef?: MissionGraphStoreReferenceV1;
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
  commitProof: "vault_acknowledged" | "exact_readback";
}

export class RuntimeSnapshotWriteAmbiguousError extends Error {
  readonly code = "runtime_snapshot_write_ambiguous";
  readonly path: string;
  readonly writeOutcome: "rejected" | "timed_out";

  constructor({
    path,
    writeOutcome,
    cause,
  }: {
    path: string;
    writeOutcome: "rejected" | "timed_out";
    cause?: unknown;
  }) {
    super(
      `Mission runtime snapshot write is ambiguous for ${path}: the vault write ${
        writeOutcome === "timed_out" ? "did not settle in time" : "was rejected"
      } and exact readback did not match. Reconcile the run artifact before resuming.`,
    );
    this.name = "RuntimeSnapshotWriteAmbiguousError";
    this.path = path;
    this.writeOutcome = writeOutcome;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function isRuntimeSnapshotWriteAmbiguousError(
  value: unknown,
): value is RuntimeSnapshotWriteAmbiguousError {
  return (
    value instanceof RuntimeSnapshotWriteAmbiguousError ||
    (isRecord(value) && value.code === "runtime_snapshot_write_ambiguous")
  );
}

export async function settleRuntimeSnapshotModify({
  path,
  expectedMarkdown,
  modify,
  readback,
  modifyTimeoutMs = RUNTIME_SNAPSHOT_MODIFY_TIMEOUT_MS,
  readbackTimeoutMs = RUNTIME_SNAPSHOT_READBACK_TIMEOUT_MS,
}: {
  path: string;
  expectedMarkdown: string;
  modify: () => Promise<unknown>;
  readback: () => Promise<string>;
  modifyTimeoutMs?: number;
  readbackTimeoutMs?: number;
}): Promise<"vault_acknowledged" | "exact_readback"> {
  const modifyOutcome = await settleBounded(
    Promise.resolve().then(modify),
    modifyTimeoutMs,
  );
  if (modifyOutcome.kind === "resolved") {
    return "vault_acknowledged";
  }

  const readbackOutcome = await settleBounded(
    Promise.resolve().then(readback),
    readbackTimeoutMs,
  );
  if (
    readbackOutcome.kind === "resolved" &&
    readbackOutcome.value === expectedMarkdown
  ) {
    return "exact_readback";
  }

  throw new RuntimeSnapshotWriteAmbiguousError({
    path,
    writeOutcome:
      modifyOutcome.kind === "timed_out" ? "timed_out" : "rejected",
    cause:
      modifyOutcome.kind === "rejected"
        ? modifyOutcome.value
        : readbackOutcome.kind === "rejected"
          ? readbackOutcome.value
          : undefined,
  });
}

export interface StoredMissionRuntimeSnapshot {
  path: string;
  snapshot: MissionRuntimeSnapshotV2;
}

export interface MissionRuntimeSnapshotUpdateResult
  extends StoredMissionRuntimeSnapshot {
  updated: boolean;
  writeResult: MissionRuntimeSnapshotWriteResult | null;
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
  missionGraphRef?: MissionGraphStoreReferenceV1 | null;
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
  missionGraphRef,
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
  const normalizedMissionGraphRef = normalizeMissionGraphStoreReference(
    missionGraphRef,
  );
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
    ...(normalizedMissionGraphRef
      ? { missionGraphRef: normalizedMissionGraphRef }
      : {}),
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
  const missionGraphRef = normalizeMissionGraphStoreReference(
    value.missionGraphRef,
  );
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
    ...(missionGraphRef ? { missionGraphRef } : {}),
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
  return withSerializedRunWrite(vault, requested.runId, () =>
    persistMissionRuntimeSnapshotUnlocked(context, requested, snapshot),
  );
}

/**
 * Atomically patches the latest durable runtime snapshot under the same
 * per-vault/run serialization boundary used by ordinary writes. The updater
 * never receives a stale pre-lock object, so a companion reconciliation cannot
 * overwrite a newer continuation or journal update with an older snapshot.
 */
export async function updateMissionRuntimeSnapshotByRunId(
  context: ToolExecutionContext,
  runId: string,
  updater: (draft: MissionRuntimeSnapshotV2) => boolean,
): Promise<MissionRuntimeSnapshotUpdateResult | null> {
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
    const current = parseMissionRuntimeSnapshotFromMarkdown(
      await vault.read(file as TFile),
    );
    if (!current || current.runId !== runId) {
      throw new Error(
        "The runtime snapshot changed identity before its atomic update.",
      );
    }
    const draft = normalizeMissionRuntimeSnapshot(
      JSON.parse(JSON.stringify(current)),
    );
    if (!draft) {
      throw new Error("The current runtime snapshot cannot be updated safely.");
    }
    if (!updater(draft)) {
      return {
        path,
        snapshot: current,
        updated: false,
        writeResult: null,
      };
    }
    const requested = normalizeMissionRuntimeSnapshot(
      JSON.parse(JSON.stringify(draft)),
    );
    if (!requested || requested.runId !== runId) {
      throw new Error("The runtime snapshot updater produced invalid state.");
    }
    const writeResult = await persistMissionRuntimeSnapshotUnlocked(
      context,
      requested,
      requested,
    );
    return {
      path: writeResult.path,
      snapshot: requested,
      updated: true,
      writeResult,
    };
  });
}

async function persistMissionRuntimeSnapshotUnlocked(
  context: ToolExecutionContext,
  requested: MissionRuntimeSnapshotV2,
  revisionTarget: MissionRuntimeSnapshotV2,
): Promise<MissionRuntimeSnapshotWriteResult> {
  const vault = context.app.vault;
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
    revisionTarget.revision = Math.max(
      revisionTarget.revision,
      requested.revision,
    );
    revisionTarget.updatedAt = requested.updatedAt;
    return {
      path,
      bytesWritten: getByteLength(content),
      revision: requested.revision,
      commitProof: "vault_acknowledged",
    };
  }

  const next = replaceRuntimeSnapshotBlock(current, block);
  const commitProof = await settleRuntimeSnapshotModify({
    path,
    expectedMarkdown: next,
    modify: () => vault.modify(file as TFile, next),
    readback: () => vault.read(file as TFile),
  });
  revisionTarget.revision = Math.max(
    revisionTarget.revision,
    requested.revision,
  );
  revisionTarget.updatedAt = requested.updatedAt;
  return {
    path,
    bytesWritten: getByteLength(block),
    revision: requested.revision,
    commitProof,
  };
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

/**
 * Resolves the core WAL for one effectful companion lineage without deriving a
 * runtime-note path from the canonical MissionGraph id. Every identity must
 * match exactly and zero or multiple matches fail closed.
 */
export async function readMissionRuntimeSnapshotByExternalActionLineageV1(
  context: ToolExecutionContext,
  input: {
    missionId: string;
    jobId: string;
    handoffFingerprint: string;
    hostRuntimeRunId?: string | null;
  },
): Promise<StoredMissionRuntimeSnapshot> {
  return readMissionRuntimeSnapshotByCompanionLineageV1(context, {
    ...input,
    kind: "linear",
  });
}

export async function readMissionRuntimeSnapshotByCompanionLineageV1(
  context: ToolExecutionContext,
  input: {
    kind: "linear" | "code" | "github";
    missionId: string;
    jobId: string;
    handoffFingerprint: string;
    hostRuntimeRunId?: string | null;
  },
): Promise<StoredMissionRuntimeSnapshot> {
  if (!hasRuntimeSnapshotVaultApi(context)) {
    throw new Error(
      "Exact external-action runtime lookup requires the vault runtime API.",
    );
  }
  if (
    !input.missionId.trim() ||
    !input.jobId.trim() ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.handoffFingerprint)
  ) {
    throw new Error("External-action runtime lookup identity is invalid.");
  }
  const vault = context.app.vault;
  const exactMatch = (snapshot: MissionRuntimeSnapshotV2 | null): boolean =>
    Boolean(
      snapshot?.missionGraphRef?.missionId === input.missionId &&
        snapshot.operationJournal.some(
          (record) => {
            if (input.kind === "linear") {
              return (
                record.externalActionDispatchAttempt?.jobId === input.jobId &&
                record.preparedExternalActionHandoff?.fingerprint ===
                  input.handoffFingerprint
              );
            }
            if (input.kind === "code") {
              return (
                record.backgroundCodeDispatchAttempt?.jobId === input.jobId &&
                record.preparedBackgroundCodeAction?.fingerprint ===
                  input.handoffFingerprint
              );
            }
            return (
              record.backgroundGitHubDispatchAttempt?.jobId === input.jobId &&
              record.preparedBackgroundGitHubAction?.fingerprint ===
                input.handoffFingerprint
            );
          },
        ),
    );
  if (input.hostRuntimeRunId) {
    const direct = await readMissionRuntimeSnapshotByRunId(
      context,
      input.hostRuntimeRunId,
    );
    if (!direct || !exactMatch(direct.snapshot)) {
      throw new Error(
        "The persisted host runtime does not match the exact companion mission, job, and handoff lineage.",
      );
    }
    return direct;
  }
  if (typeof vault.getFiles !== "function") {
    throw new Error(
      "Legacy external-action runtime lookup requires bounded vault file enumeration.",
    );
  }
  // Legacy lineage written before hostRuntimeRunId existed may use only this
  // bounded scan. New effectful dispatch always takes the direct path above.
  const candidates = vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/[^/]+\.md$/u.test(file.path))
    .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0))
    .slice(0, MAX_EXTERNAL_ACTION_RUNTIME_LOOKUP_FILES);
  const matches: StoredMissionRuntimeSnapshot[] = [];
  for (const file of candidates) {
    const snapshot = await withSerializedRunWrite(
      vault,
      file.basename || file.path,
      async () =>
        parseMissionRuntimeSnapshotFromMarkdown(await vault.read(file as TFile)),
    );
    if (!snapshot || !exactMatch(snapshot)) {
      continue;
    }
    matches.push({ path: file.path, snapshot });
    if (matches.length > 1) break;
  }
  if (matches.length === 0) {
    throw new Error(
      "No core ActionJournal matches the exact companion mission, job, and handoff lineage.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      "Multiple core ActionJournals match the exact companion lineage; reconciliation is ambiguous.",
    );
  }
  return matches[0];
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
        state === "dispatched" ||
        state === "ambiguous" ||
        state === "readback_verified" ||
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

const EXACT_LIFECYCLE_RECONCILIATION_TOOLS = new Set([
  "publish_research_to_linear",
  "publish_research_project_to_linear",
  "code_commit_verified",
  "github_create_private_repository",
  "publish_verified_code_to_github",
  "github_delete_private_repository",
]);

/**
 * A resumable composite may first return an ambiguous provider outcome and
 * later finish by independently adopting that exact operation. Its verified,
 * idempotency-bound receipt resolves older outer-runner WAL rows for the same
 * graph node; otherwise startup would keep blocking on ambiguity that the
 * nested workflow has already reconciled. This is deliberately unavailable to
 * ordinary mutations and to receipts without exact readback proof.
 */
export function reconcilePriorExactLifecycleJournalRecords(
  records: readonly OperationJournalRecord[],
  current: OperationJournalRecord,
  receipt: ActionReceipt | MissionRuntimeReceipt,
  now = new Date(),
): OperationJournalRecord[] {
  const eligible =
    current.state === "committed" &&
    typeof current.nodeId === "string" &&
    current.nodeId.length > 0 &&
    EXACT_LIFECYCLE_RECONCILIATION_TOOLS.has(current.toolName) &&
    exactLifecycleReceiptMatches(current.toolName, receipt) &&
    receipt.commitKind === "committed" &&
    receipt.readback?.status === "verified" &&
    typeof receipt.idempotencyKey === "string" &&
    receipt.idempotencyKey.length > 0;
  if (!eligible) return records.map((record) => ({ ...record }));

  return records.map((record) => {
    if (
      record.operationId === current.operationId ||
      record.state !== "reconcile_required" ||
      record.rootRunId !== current.rootRunId ||
      record.nodeId !== current.nodeId ||
      record.toolName !== current.toolName
    ) {
      return { ...record };
    }
    return transitionOperationJournalRecord(record, "committed", {
      message:
        "A later exact lifecycle retry independently reconciled this operation and committed its verified receipt.",
      receipt,
      mutationMayHaveApplied: true,
      now,
    });
  });
}

/**
 * Replays the same exact-lifecycle reconciliation after restart. A crash or
 * stage restart may persist the later committed row and its verified receipt
 * before the older ambiguous row is collapsed. Only the closed composite set,
 * same root run/node/tool, and canonical verified receipt remain eligible.
 */
export function reconcilePersistedExactLifecycleJournalRecords(
  records: readonly OperationJournalRecord[],
  now = new Date(),
): OperationJournalRecord[] {
  let reconciled = records.map((record) => ({ ...record }));
  for (const current of records) {
    if (current.state !== "committed" || !current.receipt) continue;
    reconciled = reconcilePriorExactLifecycleJournalRecords(
      reconciled,
      current,
      current.receipt,
      now,
    );
  }
  return reconciled;
}

function exactLifecycleReceiptMatches(
  compositeToolName: string,
  receipt: ActionReceipt | MissionRuntimeReceipt,
): boolean {
  const expected: Record<string, { system: ResourceRef["system"]; prefix: string }> = {
    publish_research_to_linear: {
      system: "linear",
      prefix: "research-publication:",
    },
    publish_research_project_to_linear: {
      system: "linear",
      prefix: "linear-research-project:",
    },
    github_create_private_repository: {
      system: "github",
      prefix: "github-private-repository:",
    },
    publish_verified_code_to_github: {
      system: "github",
      prefix: "github-publication:",
    },
    github_delete_private_repository: {
      system: "github",
      prefix: "github-private-repository-cleanup:",
    },
  };
  const binding = expected[compositeToolName];
  return Boolean(
    binding &&
    receipt.resource?.system === binding.system &&
    receipt.idempotencyKey?.startsWith(binding.prefix),
  );
}

/**
 * Binds a validated prepared external action to the existing write-ahead
 * record. Callers must persist the returned record before any remote dispatch.
 * This function intentionally does not introduce a dispatch transition: until
 * that state has readback reconciliation semantics, the action remains local.
 */
export async function attachPreparedExternalActionHandoff(
  record: OperationJournalRecord,
  value: PreparedExternalActionHandoffV1,
  now = new Date(),
): Promise<OperationJournalRecord> {
  const handoff = clonePreparedExternalActionHandoff(value);
  const descriptorFingerprint = record.descriptor
    ? await sha256Fingerprint(record.descriptor)
    : null;
  const preparedActionFingerprintValid = record.preparedAction
    ? await verifyPreparedActionFingerprint(record.preparedAction)
    : false;
  if (
    (record.state !== "intent_recorded" && record.state !== "applying") ||
    record.mutationMayHaveApplied ||
    !record.preparedAction ||
    !record.descriptor ||
    !record.authorization ||
    !preparedActionFingerprintValid ||
    descriptorFingerprint !== handoff.descriptorFingerprint ||
    record.nodeId !== handoff.nodeId ||
    record.toolName !== handoff.toolName ||
    record.preparedAction.id !== handoff.preparedActionId ||
    record.preparedAction.payloadFingerprint !==
      handoff.preparedActionFingerprint ||
    record.authorization.grantId !== handoff.authority.id ||
    record.authorization.payloadFingerprint !==
      handoff.preparedActionFingerprint
  ) {
    throw new Error(
      "Prepared external action handoff does not match the pending operation journal record.",
    );
  }
  if (
    record.preparedExternalActionHandoff &&
    record.preparedExternalActionHandoff.fingerprint !== handoff.fingerprint
  ) {
    throw new Error(
      "Operation journal already contains a different prepared external action handoff.",
    );
  }
  return {
    ...record,
    preparedExternalActionHandoff: handoff,
    updatedAt: now.toISOString(),
  };
}

/**
 * Binds one closed Code continuation action and its local-only package identity
 * to the core WAL. The executable package body remains in application data;
 * only its exact readback identity is persisted in the vault runtime record.
 */
export async function attachPreparedBackgroundCodeHandoffV1(
  record: OperationJournalRecord,
  value: PreparedBackgroundCodeActionV1,
  packageIdentityValue: PreparedBackgroundCodePackageIdentityV1,
  now = new Date(),
): Promise<OperationJournalRecord> {
  const handoff = parsePreparedBackgroundCodeActionV1(value);
  const packageIdentity = parsePreparedBackgroundCodePackageIdentityV1(
    packageIdentityValue,
  );
  const descriptorFingerprint = record.descriptor
    ? await sha256Fingerprint(record.descriptor)
    : null;
  const preparedActionFingerprintValid = record.preparedAction
    ? await verifyPreparedActionFingerprint(record.preparedAction)
    : false;
  if (
    (record.state !== "intent_recorded" && record.state !== "applying") ||
    record.mutationMayHaveApplied ||
    !record.preparedAction ||
    !record.descriptor ||
    !record.authorization ||
    !preparedActionFingerprintValid ||
    descriptorFingerprint !== handoff.descriptorFingerprint ||
    record.nodeId !== handoff.nodeId ||
    record.toolName !== handoff.toolName ||
    record.preparedAction.id !== handoff.preparedActionId ||
    record.preparedAction.payloadFingerprint !==
      handoff.preparedActionFingerprint ||
    record.authorization.grantId !== handoff.authority.id ||
    record.authorization.payloadFingerprint !==
      handoff.preparedActionFingerprint ||
    packageIdentity.handoffFingerprint !== handoff.fingerprint ||
    packageIdentity.workspaceId !== handoff.binding.workspaceId ||
    packageIdentity.workspaceBindingFingerprint !==
      handoff.payload.workspaceBindingFingerprint ||
    packageIdentity.repositoryProfileKey !==
      handoff.binding.repositoryProfileKey ||
    packageIdentity.repositoryProfileFingerprint !==
      handoff.payload.repositoryProfileFingerprint ||
    packageIdentity.consumedActionAuthorityFingerprint !==
      handoff.authority.authorityFingerprint ||
    packageIdentity.preparedAt !== handoff.preparedAt ||
    packageIdentity.expiresAt !== handoff.expiresAt
  ) {
    throw new Error(
      "Prepared background Code handoff does not match the pending operation journal record and package identity.",
    );
  }
  if (
    (record.preparedBackgroundCodeAction &&
      record.preparedBackgroundCodeAction.fingerprint !== handoff.fingerprint) ||
    (record.preparedBackgroundCodePackage &&
      record.preparedBackgroundCodePackage.fingerprint !==
        packageIdentity.fingerprint)
  ) {
    throw new Error(
      "Operation journal already contains a different prepared background Code package.",
    );
  }
  return {
    ...record,
    preparedBackgroundCodeAction: handoff,
    preparedBackgroundCodePackage: packageIdentity,
    updatedAt: now.toISOString(),
  };
}

/**
 * Binds one integrations-sealed GitHub action and its readback-verified local
 * package identity to the core WAL. The executable package body and credential
 * reference remain outside the vault runtime snapshot.
 */
export async function attachPreparedBackgroundGitHubActionV1(
  record: OperationJournalRecord,
  actionValue: PreparedBackgroundGitHubActionV1,
  packageIdentityValue: PreparedBackgroundGitHubPackageIdentityV1,
  now = new Date(),
): Promise<OperationJournalRecord> {
  const action = parsePreparedBackgroundGitHubActionV1(actionValue);
  const packageIdentity = parsePreparedBackgroundGitHubPackageIdentityV1(
    packageIdentityValue,
  );
  const descriptorFingerprint = record.descriptor
    ? await sha256Fingerprint(record.descriptor)
    : null;
  const preparedActionFingerprintValid = record.preparedAction
    ? await verifyPreparedActionFingerprint(record.preparedAction)
    : false;
  if (
    (record.state !== "intent_recorded" && record.state !== "applying") ||
    record.mutationMayHaveApplied ||
    !record.preparedAction ||
    !record.descriptor ||
    !record.authorization ||
    !preparedActionFingerprintValid ||
    descriptorFingerprint !== action.descriptorFingerprint ||
    record.nodeId !== action.nodeId ||
    record.toolName !== action.toolName ||
    record.preparedAction.id !== action.preparedActionId ||
    record.preparedAction.payloadFingerprint !==
      action.preparedActionFingerprint ||
    record.authorization.grantId !== action.authority.id ||
    record.authorization.payloadFingerprint !==
      action.preparedActionFingerprint ||
    action.authority.actionFingerprint !==
      action.preparedActionFingerprint ||
    packageIdentity.actionFingerprint !== action.fingerprint ||
    packageIdentity.preparedActionFingerprint !==
      action.preparedActionFingerprint ||
    packageIdentity.operation !== action.operation ||
    packageIdentity.publicationId !== action.payload.publicationId ||
    packageIdentity.repositoryBindingFingerprint !==
      action.binding.repositoryBindingFingerprint ||
    packageIdentity.repositoryProfileFingerprint !==
      action.binding.repositoryProfileFingerprint ||
    packageIdentity.verifiedAccountId !== action.binding.verifiedAccountId ||
    packageIdentity.preparedAt !== action.preparedAt ||
    packageIdentity.expiresAt !== action.expiresAt
  ) {
    throw new Error(
      "Prepared background GitHub action does not match the pending operation journal record and package identity.",
    );
  }
  if (
    (record.preparedBackgroundGitHubAction &&
      record.preparedBackgroundGitHubAction.fingerprint !== action.fingerprint) ||
    (record.preparedBackgroundGitHubPackage &&
      record.preparedBackgroundGitHubPackage.fingerprint !==
        packageIdentity.fingerprint)
  ) {
    throw new Error(
      "Operation journal already contains a different prepared background GitHub package.",
    );
  }
  return {
    ...record,
    preparedBackgroundGitHubAction: action,
    preparedBackgroundGitHubPackage: packageIdentity,
    updatedAt: now.toISOString(),
  };
}

export interface ExternalActionCompanionReceiptV1 {
  id: string;
  provider: string;
  operation: string;
  status: "prepared" | "dispatched" | "verified" | "ambiguous" | "failed";
  fingerprint: string;
  payload: Record<string, unknown>;
  committedAt: string;
}

export type BackgroundCodeCompanionReceiptV1 =
  ExternalActionCompanionReceiptV1;
export type BackgroundGitHubCompanionReceiptV1 =
  ExternalActionCompanionReceiptV1;

/** Persist deterministic Code job and package identity before remote submit. */
export function attachBackgroundCodeDispatchAttemptV1(
  record: OperationJournalRecord,
  jobId: string,
  now = new Date(),
): OperationJournalRecord {
  const handoff = record.preparedBackgroundCodeAction;
  const packageIdentity = record.preparedBackgroundCodePackage;
  if (
    !handoff ||
    !packageIdentity ||
    (record.state !== "intent_recorded" && record.state !== "applying") ||
    record.mutationMayHaveApplied ||
    !jobId.trim()
  ) {
    throw new Error(
      "Background Code dispatch requires a non-applied journaled package.",
    );
  }
  const attemptId = backgroundCodeContinuationAttemptIdV1(jobId, handoff);
  const existing = record.backgroundCodeDispatchAttempt;
  if (
    existing &&
    (existing.jobId !== jobId ||
      existing.attemptId !== attemptId ||
      existing.handoffFingerprint !== handoff.fingerprint ||
      existing.packageFingerprint !== packageIdentity.packageFingerprint ||
      existing.packageIdentityFingerprint !== packageIdentity.fingerprint)
  ) {
    throw new Error(
      "Operation journal is already bound to another background Code attempt.",
    );
  }
  const timestamp = now.toISOString();
  return {
    ...record,
    backgroundCodeDispatchAttempt:
      existing ?? {
        version: 1,
        provider: "code",
        operation: "prepared_code_validation_commit_v1",
        jobId,
        attemptId,
        handoffFingerprint: handoff.fingerprint,
        packageFingerprint: packageIdentity.packageFingerprint,
        packageIdentityFingerprint: packageIdentity.fingerprint,
        status: "prepared",
        preparedAt: timestamp,
        submittedAt: null,
        dispatchedReceiptFingerprint: null,
        ambiguousReceiptFingerprint: null,
        verifiedReceiptFingerprint: null,
        verifiedCommitReceiptFingerprint: null,
        commitSha: null,
        updatedAt: timestamp,
      },
    updatedAt: timestamp,
  };
}

/** Remote submission is uncertain until the companion receipt WAL is read. */
export function markBackgroundCodeJobSubmittedV1(
  record: OperationJournalRecord,
  now = new Date(),
): OperationJournalRecord {
  const attempt = record.backgroundCodeDispatchAttempt;
  if (!attempt || !["applying", "dispatched", "ambiguous"].includes(record.state)) {
    throw new Error("Background Code job submission is not bound to a prepared attempt.");
  }
  if (attempt.status !== "prepared" && attempt.status !== "job_submitted") {
    return record;
  }
  const timestamp = now.toISOString();
  return {
    ...record,
    mutationMayHaveApplied: true,
    backgroundCodeDispatchAttempt: {
      ...attempt,
      status: "job_submitted",
      submittedAt: attempt.submittedAt ?? timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

/** Persist deterministic GitHub job, action, and package identity before submit. */
export function attachBackgroundGitHubDispatchAttemptV1(
  record: OperationJournalRecord,
  jobId: string,
  now = new Date(),
): OperationJournalRecord {
  const action = record.preparedBackgroundGitHubAction;
  const packageIdentity = record.preparedBackgroundGitHubPackage;
  if (
    !action ||
    !packageIdentity ||
    (record.state !== "intent_recorded" && record.state !== "applying") ||
    record.mutationMayHaveApplied ||
    !jobId.trim()
  ) {
    throw new Error(
      "Background GitHub dispatch requires a non-applied journaled package.",
    );
  }
  const attemptId = backgroundGitHubActionAttemptIdV1(jobId, action);
  const existing = record.backgroundGitHubDispatchAttempt;
  if (
    existing &&
    (existing.jobId !== jobId ||
      existing.attemptId !== attemptId ||
      existing.operation !== action.operation ||
      existing.actionFingerprint !== action.fingerprint ||
      existing.packageFingerprint !== packageIdentity.packageFingerprint ||
      existing.packageIdentityFingerprint !== packageIdentity.fingerprint)
  ) {
    throw new Error(
      "Operation journal is already bound to another background GitHub attempt.",
    );
  }
  const timestamp = now.toISOString();
  return {
    ...record,
    backgroundGitHubDispatchAttempt:
      existing ?? {
        version: 1,
        provider: "github",
        operation: action.operation,
        jobId,
        attemptId,
        actionFingerprint: action.fingerprint,
        packageFingerprint: packageIdentity.packageFingerprint,
        packageIdentityFingerprint: packageIdentity.fingerprint,
        status: "prepared",
        preparedAt: timestamp,
        submittedAt: null,
        dispatchedReceiptFingerprint: null,
        ambiguousReceiptFingerprint: null,
        verifiedReceiptFingerprint: null,
        verifiedResultFingerprint: null,
        updatedAt: timestamp,
      },
    updatedAt: timestamp,
  };
}

/** Remote submission is uncertain until the exact companion proof is replayed. */
export function markBackgroundGitHubJobSubmittedV1(
  record: OperationJournalRecord,
  now = new Date(),
): OperationJournalRecord {
  const attempt = record.backgroundGitHubDispatchAttempt;
  if (!attempt || !["applying", "dispatched", "ambiguous"].includes(record.state)) {
    throw new Error(
      "Background GitHub job submission is not bound to a prepared attempt.",
    );
  }
  if (attempt.status !== "prepared" && attempt.status !== "job_submitted") {
    return record;
  }
  const timestamp = now.toISOString();
  return {
    ...record,
    mutationMayHaveApplied: true,
    backgroundGitHubDispatchAttempt: {
      ...attempt,
      status: "job_submitted",
      submittedAt: attempt.submittedAt ?? timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

/**
 * Persist the deterministic companion job and provider-attempt identity before
 * the job is submitted. Retrying this function with the same identity is
 * idempotent; a different identity is rejected.
 */
export function attachExternalActionDispatchAttemptV1(
  record: OperationJournalRecord,
  jobId: string,
  now = new Date(),
): OperationJournalRecord {
  const handoff = record.preparedExternalActionHandoff;
  if (
    !handoff ||
    (record.state !== "intent_recorded" && record.state !== "applying") ||
    record.mutationMayHaveApplied ||
    !jobId.trim()
  ) {
    throw new Error(
      "External dispatch attempt requires a non-applied journaled handoff.",
    );
  }
  const attemptId = linearIssueStateUpdateAttemptIdV1(jobId, handoff);
  const existing = record.externalActionDispatchAttempt;
  if (
    existing &&
    (existing.jobId !== jobId ||
      existing.attemptId !== attemptId ||
      existing.handoffFingerprint !== handoff.fingerprint)
  ) {
    throw new Error(
      "Operation journal is already bound to another remote dispatch attempt.",
    );
  }
  const timestamp = now.toISOString();
  return {
    ...record,
    externalActionDispatchAttempt:
      existing ?? {
        version: 1,
        provider: "linear",
        operation: "linear_issue_state_update_v1",
        jobId,
        attemptId,
        handoffFingerprint: handoff.fingerprint,
        status: "prepared",
        preparedAt: timestamp,
        submittedAt: null,
        dispatchedReceiptFingerprint: null,
        ambiguousReceiptFingerprint: null,
        verifiedReceiptFingerprint: null,
        updatedAt: timestamp,
      },
    updatedAt: timestamp,
  };
}

/** Marks only companion job submission; it does not claim provider dispatch. */
export function markExternalActionJobSubmittedV1(
  record: OperationJournalRecord,
  now = new Date(),
): OperationJournalRecord {
  const attempt = record.externalActionDispatchAttempt;
  if (!attempt || !["applying", "dispatched", "ambiguous"].includes(record.state)) {
    throw new Error("External job submission is not bound to a prepared attempt.");
  }
  if (attempt.status !== "prepared" && attempt.status !== "job_submitted") {
    return record;
  }
  const timestamp = now.toISOString();
  return {
    ...record,
    // The provider call has not been proven yet, but the independently leased
    // remote worker may execute it after this process stops. Restart must
    // reconcile the exact job and can never classify this record as retryable.
    mutationMayHaveApplied: true,
    externalActionDispatchAttempt: {
      ...attempt,
      status: "job_submitted",
      submittedAt: attempt.submittedAt ?? timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

/**
 * Project the companion's provider-specific receipt WAL into the core action
 * journal. A dispatched/ambiguous receipt can never become retryable; only a
 * verified readback receipt can advance the action toward commit.
 */
export function reconcileExternalActionDispatchAttemptV1(
  record: OperationJournalRecord,
  receipts: ExternalActionCompanionReceiptV1[],
  now = new Date(),
): OperationJournalRecord {
  const attempt = record.externalActionDispatchAttempt;
  const handoff = record.preparedExternalActionHandoff;
  if (!attempt || !handoff) {
    throw new Error("External action reconciliation lacks its persisted attempt.");
  }
  assertExternalActionAttemptIdentity(attempt, handoff);
  const relevant = receipts
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => {
      if (
        receipt.provider !== "linear" ||
        receipt.operation !== "linear_issue_state_update_v1"
      ) {
        return false;
      }
      const sameAttempt = receipt.payload.attemptId === attempt.attemptId;
      const sameHandoff =
        receipt.payload.handoffFingerprint === handoff.fingerprint;
      if (sameAttempt !== sameHandoff) {
        throw new Error(
          "External action receipt identity partially matches the persisted attempt.",
        );
      }
      if (!sameAttempt) return false;
      assertLinearStateUpdateReceiptSemantics(receipt, handoff);
      return true;
    });
  const dispatchedEntries = relevant.filter(
    ({ receipt }) => receipt.status === "dispatched",
  );
  const verifiedEntries = relevant.filter(
    ({ receipt }) => receipt.status === "verified",
  );
  if (dispatchedEntries.length > 1 || verifiedEntries.length > 1) {
    throw new Error(
      "External action receipt sequence contains duplicate dispatch or verification markers.",
    );
  }
  const dispatchedEntry = dispatchedEntries[0];
  const ambiguousEntry = [...relevant]
    .reverse()
    .find(({ receipt }) => receipt.status === "ambiguous");
  const verifiedEntry = verifiedEntries[0];
  const dispatched = dispatchedEntry?.receipt;
  const ambiguous = ambiguousEntry?.receipt;
  const verified = verifiedEntry?.receipt;
  if ((ambiguous || verified) && !dispatched) {
    throw new Error(
      "External readback receipt is missing the durable pre-dispatch marker.",
    );
  }
  if (
    dispatchedEntry &&
    relevant.some(
      ({ receipt, index }) =>
        receipt.status !== "dispatched" && index <= dispatchedEntry.index,
    )
  ) {
    throw new Error(
      "External readback receipt precedes its durable pre-dispatch marker.",
    );
  }
  if (
    verifiedEntry &&
    relevant.some(
      ({ receipt, index }) =>
        receipt.status === "ambiguous" && index >= verifiedEntry.index,
    )
  ) {
    throw new Error(
      "External action receipt sequence continued ambiguously after verified readback.",
    );
  }
  assertMonotonicExternalReceiptTimes(relevant.map(({ receipt }) => receipt));
  let next = record;
  if (dispatched && next.state === "applying") {
    next = transitionOperationJournalRecord(next, "dispatched", {
      message:
        "Companion receipt proves the provider dispatch marker was durable before the Linear call.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  if (
    ambiguous &&
    (next.state === "dispatched" || next.state === "reconcile_required")
  ) {
    next = transitionOperationJournalRecord(next, "ambiguous", {
      message:
        "Linear dispatch is ambiguous; only independent issue readback may continue.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  if (
    verified &&
    (next.state === "dispatched" ||
      next.state === "ambiguous" ||
      next.state === "reconcile_required")
  ) {
    next = transitionOperationJournalRecord(next, "readback_verified", {
      message:
        "Independent Linear issue readback verified the exact approved target state.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  const timestamp = now.toISOString();
  return {
    ...next,
    externalActionDispatchAttempt: {
      ...attempt,
      status: verified
        ? "readback_verified"
        : ambiguous
          ? "ambiguous"
          : dispatched
            ? "dispatched"
            : attempt.status,
      dispatchedReceiptFingerprint:
        dispatched?.fingerprint ?? attempt.dispatchedReceiptFingerprint,
      ambiguousReceiptFingerprint:
        ambiguous?.fingerprint ?? attempt.ambiguousReceiptFingerprint,
      verifiedReceiptFingerprint:
        verified?.fingerprint ?? attempt.verifiedReceiptFingerprint,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

/**
 * Projects the companion Code receipt WAL into the core ActionJournal. A
 * commit ambiguity is terminally readback-only; only a verified local-commit
 * receipt bound to the exact handoff can advance to readback_verified.
 */
export function reconcileBackgroundCodeDispatchAttemptV1(
  record: OperationJournalRecord,
  receipts: BackgroundCodeCompanionReceiptV1[],
  now = new Date(),
): OperationJournalRecord {
  const attempt = record.backgroundCodeDispatchAttempt;
  const handoff = record.preparedBackgroundCodeAction;
  const packageIdentity = record.preparedBackgroundCodePackage;
  if (!attempt || !handoff || !packageIdentity) {
    throw new Error("Background Code reconciliation lacks its persisted package attempt.");
  }
  assertBackgroundCodeAttemptIdentity(attempt, handoff, packageIdentity);
  const relevant = receipts
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => {
      if (
        receipt.provider !== "code" ||
        receipt.operation !== "prepared_code_validation_commit_v1"
      ) {
        return false;
      }
      const sameAttempt = receipt.payload.attemptId === attempt.attemptId;
      const sameHandoff =
        receipt.payload.handoffFingerprint === handoff.fingerprint;
      const sameCheckpoint =
        receipt.payload.repairCheckpointId ===
        handoff.payload.repairCheckpointId;
      if (
        [sameAttempt, sameHandoff, sameCheckpoint].some(Boolean) &&
        !(sameAttempt && sameHandoff && sameCheckpoint)
      ) {
        throw new Error(
          "Background Code receipt identity partially matches the persisted attempt.",
        );
      }
      if (!sameAttempt) return false;
      assertBackgroundCodeReceiptSemantics(receipt, handoff);
      return true;
    });
  const dispatchedEntries = relevant.filter(
    ({ receipt }) => receipt.status === "dispatched",
  );
  const ambiguousEntries = relevant.filter(
    ({ receipt }) => receipt.status === "ambiguous",
  );
  const verifiedEntries = relevant.filter(
    ({ receipt }) => receipt.status === "verified",
  );
  if (
    dispatchedEntries.length > 1 ||
    ambiguousEntries.length > 1 ||
    verifiedEntries.length > 1
  ) {
    throw new Error(
      "Background Code receipt sequence contains duplicate durable markers.",
    );
  }
  const dispatchedEntry = dispatchedEntries[0];
  const ambiguousEntry = ambiguousEntries[0];
  const verifiedEntry = verifiedEntries[0];
  if (
    verifiedEntry &&
    !dispatchedEntry &&
    !ambiguousEntry &&
    attempt.status !== "dispatched" &&
    attempt.status !== "ambiguous" &&
    attempt.status !== "readback_verified"
  ) {
    throw new Error(
      "Verified Code commit receipt is missing a durable dispatch or ambiguity marker.",
    );
  }
  if (
    verifiedEntry &&
    relevant.some(
      ({ receipt, index }) =>
        receipt.status === "ambiguous" && index >= verifiedEntry.index,
    )
  ) {
    throw new Error(
      "Background Code receipt sequence continued ambiguously after commit verification.",
    );
  }
  assertMonotonicExternalReceiptTimes(relevant.map(({ receipt }) => receipt));
  const dispatched = dispatchedEntry?.receipt;
  const ambiguous = ambiguousEntry?.receipt;
  const verified = verifiedEntry?.receipt;
  if (
    verified &&
    attempt.status === "readback_verified" &&
    (attempt.verifiedReceiptFingerprint !== verified.fingerprint ||
      attempt.verifiedCommitReceiptFingerprint !==
        verified.payload.verifiedCommitReceiptFingerprint ||
      attempt.commitSha !== verified.payload.commitSha)
  ) {
    throw new Error(
      "Verified background Code receipt drifted from the already-applied commit proof.",
    );
  }
  let next = record;
  if (dispatched && next.state === "applying") {
    next = transitionOperationJournalRecord(next, "dispatched", {
      message:
        "Companion receipt proves the Code continuation marker was durable before validation or commit.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  if (
    ambiguous &&
    (next.state === "applying" ||
      next.state === "dispatched" ||
      next.state === "reconcile_required")
  ) {
    next = transitionOperationJournalRecord(next, "ambiguous", {
      message:
        "The local commit outcome is ambiguous; every later attempt is readback-only.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  if (
    verified &&
    (next.state === "dispatched" ||
      next.state === "ambiguous" ||
      next.state === "reconcile_required")
  ) {
    next = transitionOperationJournalRecord(next, "readback_verified", {
      message:
        "Independent Git object readback verified the exact prepared local commit.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  const timestamp = now.toISOString();
  return {
    ...next,
    backgroundCodeDispatchAttempt: {
      ...attempt,
      status: verified
        ? "readback_verified"
        : ambiguous
          ? "ambiguous"
          : dispatched
            ? "dispatched"
            : attempt.status,
      dispatchedReceiptFingerprint:
        dispatched?.fingerprint ?? attempt.dispatchedReceiptFingerprint,
      ambiguousReceiptFingerprint:
        ambiguous?.fingerprint ?? attempt.ambiguousReceiptFingerprint,
      verifiedReceiptFingerprint:
        verified?.fingerprint ?? attempt.verifiedReceiptFingerprint,
      verifiedCommitReceiptFingerprint:
        (typeof verified?.payload.verifiedCommitReceiptFingerprint === "string"
          ? verified.payload.verifiedCommitReceiptFingerprint
          : null) ?? attempt.verifiedCommitReceiptFingerprint,
      commitSha:
        (typeof verified?.payload.commitSha === "string"
          ? verified.payload.commitSha
          : null) ?? attempt.commitSha,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

/**
 * Projects one closed GitHub companion proof into the core WAL. A result hash
 * alone is never sufficient: the complete verified result is re-parsed and
 * checked against the exact action, package, account, repository, operation,
 * and provider target before the record reaches readback_verified.
 */
export function reconcileBackgroundGitHubDispatchAttemptV1(
  record: OperationJournalRecord,
  receipts: BackgroundGitHubCompanionReceiptV1[],
  now = new Date(),
): OperationJournalRecord {
  const attempt = record.backgroundGitHubDispatchAttempt;
  const action = record.preparedBackgroundGitHubAction;
  const packageIdentity = record.preparedBackgroundGitHubPackage;
  if (!attempt || !action || !packageIdentity) {
    throw new Error(
      "Background GitHub reconciliation lacks its persisted package attempt.",
    );
  }
  assertBackgroundGitHubAttemptIdentity(attempt, action, packageIdentity);
  const relevant = receipts
    .map((receipt, index) => ({ receipt, index }))
    .filter(({ receipt }) => {
      if (
        receipt.provider !== "github" ||
        receipt.operation !== action.operation
      ) {
        return false;
      }
      const sameAttempt = receipt.payload.attemptId === attempt.attemptId;
      const sameAction =
        receipt.payload.actionFingerprint === action.fingerprint;
      const samePackage =
        receipt.payload.packageFingerprint ===
        packageIdentity.packageFingerprint;
      if (
        [sameAttempt, sameAction, samePackage].some(Boolean) &&
        !(sameAttempt && sameAction && samePackage)
      ) {
        throw new Error(
          "Background GitHub receipt identity partially matches the persisted attempt.",
        );
      }
      if (!sameAttempt) return false;
      assertBackgroundGitHubReceiptSemantics(receipt, action);
      return receipt.status === "ambiguous" || receipt.status === "verified";
    });
  const ambiguousEntries = relevant.filter(
    ({ receipt }) => receipt.status === "ambiguous",
  );
  const verifiedEntries = relevant.filter(
    ({ receipt }) => receipt.status === "verified",
  );
  if (ambiguousEntries.length > 1 || verifiedEntries.length > 1) {
    throw new Error(
      "Background GitHub receipt sequence contains duplicate durable outcomes.",
    );
  }
  const ambiguousEntry = ambiguousEntries[0];
  const verifiedEntry = verifiedEntries[0];
  if (
    verifiedEntry &&
    ambiguousEntry &&
    ambiguousEntry.index >= verifiedEntry.index
  ) {
    throw new Error(
      "Background GitHub receipt sequence continued ambiguously after verified readback.",
    );
  }
  assertMonotonicExternalReceiptTimes(relevant.map(({ receipt }) => receipt));
  const ambiguous = ambiguousEntry?.receipt;
  const verified = verifiedEntry?.receipt;
  const result = verified
    ? parseBackgroundGitHubVerifiedResultV1(verified.payload.verifiedResult)
    : null;
  if (verified && result) {
    if (verified.payload.resultFingerprint !== result.fingerprint) {
      throw new Error(
        "Background GitHub receipt result fingerprint does not match its complete proof.",
      );
    }
    assertBackgroundGitHubVerifiedResultSemantics(result, action);
  }
  if (
    result &&
    attempt.status === "readback_verified" &&
    (attempt.verifiedReceiptFingerprint !== verified!.fingerprint ||
      attempt.verifiedResultFingerprint !== result.fingerprint)
  ) {
    throw new Error(
      "Verified background GitHub proof drifted from the already-applied result.",
    );
  }
  let next = record;
  const outcomeReceipt = verified ?? ambiguous;
  if (outcomeReceipt && next.state === "applying") {
    next = transitionOperationJournalRecord(next, "dispatched", {
      message:
        "The authenticated companion persisted a GitHub provider outcome for the exact sealed package.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  if (
    ambiguous &&
    (next.state === "dispatched" || next.state === "reconcile_required")
  ) {
    next = transitionOperationJournalRecord(next, "ambiguous", {
      message:
        "The GitHub mutation outcome is ambiguous; the same provider WAL must reconcile by independent readback.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  if (
    verified &&
    result &&
    (next.state === "dispatched" ||
      next.state === "ambiguous" ||
      next.state === "reconcile_required")
  ) {
    next = transitionOperationJournalRecord(next, "readback_verified", {
      message:
        "Independent GitHub readback verified the exact prepared action, repository, account, and target state.",
      mutationMayHaveApplied: true,
      now,
    });
  }
  const timestamp = now.toISOString();
  return {
    ...next,
    backgroundGitHubDispatchAttempt: {
      ...attempt,
      status: verified
        ? "readback_verified"
        : ambiguous
          ? "ambiguous"
          : attempt.status,
      dispatchedReceiptFingerprint:
        outcomeReceipt?.fingerprint ?? attempt.dispatchedReceiptFingerprint,
      ambiguousReceiptFingerprint:
        ambiguous?.fingerprint ?? attempt.ambiguousReceiptFingerprint,
      verifiedReceiptFingerprint:
        verified?.fingerprint ?? attempt.verifiedReceiptFingerprint,
      verifiedResultFingerprint:
        result?.fingerprint ?? attempt.verifiedResultFingerprint,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  };
}

export function isBackgroundGitHubProofVerifiedV1(
  record: OperationJournalRecord,
  input: {
    jobId: string;
    actionFingerprint: string;
    packageIdentityFingerprint: string;
    verifiedReceiptFingerprint: string;
    verifiedResultFingerprint: string;
  },
): boolean {
  const action = record.preparedBackgroundGitHubAction;
  const packageIdentity = record.preparedBackgroundGitHubPackage;
  const attempt = record.backgroundGitHubDispatchAttempt;
  if (!action || !packageIdentity || !attempt) return false;
  try {
    assertBackgroundGitHubAttemptIdentity(attempt, action, packageIdentity);
  } catch {
    return false;
  }
  return (
    attempt.jobId === input.jobId &&
    action.fingerprint === input.actionFingerprint &&
    packageIdentity.fingerprint === input.packageIdentityFingerprint &&
    attempt.status === "readback_verified" &&
    attempt.verifiedReceiptFingerprint === input.verifiedReceiptFingerprint &&
    attempt.verifiedResultFingerprint === input.verifiedResultFingerprint &&
    (record.state === "readback_verified" ||
      (record.state === "committed" &&
        record.transitions.some(
          (transition) => transition.state === "readback_verified",
        )))
  );
}

export function isBackgroundCodeCommitProofVerifiedV1(
  record: OperationJournalRecord,
  input: {
    jobId: string;
    handoffFingerprint: string;
    packageIdentityFingerprint: string;
    verifiedReceiptFingerprint: string;
    verifiedCommitReceiptFingerprint: string;
    commitSha: string;
  },
): boolean {
  const handoff = record.preparedBackgroundCodeAction;
  const packageIdentity = record.preparedBackgroundCodePackage;
  const attempt = record.backgroundCodeDispatchAttempt;
  if (!handoff || !packageIdentity || !attempt) return false;
  try {
    assertBackgroundCodeAttemptIdentity(attempt, handoff, packageIdentity);
  } catch {
    return false;
  }
  return (
    attempt.jobId === input.jobId &&
    handoff.fingerprint === input.handoffFingerprint &&
    packageIdentity.fingerprint === input.packageIdentityFingerprint &&
    attempt.status === "readback_verified" &&
    attempt.verifiedReceiptFingerprint === input.verifiedReceiptFingerprint &&
    attempt.verifiedCommitReceiptFingerprint ===
      input.verifiedCommitReceiptFingerprint &&
    attempt.commitSha === input.commitSha &&
    (record.state === "readback_verified" ||
      (record.state === "committed" &&
        record.transitions.some(
          (transition) => transition.state === "readback_verified",
        )))
  );
}

/**
 * A companion completion may enter the MissionGraph only after the core WAL
 * proves the exact deterministic attempt reached independent readback. The
 * committed state is accepted for idempotent replay only when its transition
 * history proves it passed through readback_verified first.
 */
export function isExternalActionReadbackVerifiedV1(
  record: OperationJournalRecord,
  input: {
    jobId: string;
    handoffFingerprint: string;
    verifiedReceiptFingerprint: string;
  },
): boolean {
  const handoff = record.preparedExternalActionHandoff;
  const attempt = record.externalActionDispatchAttempt;
  if (!handoff || !attempt) return false;
  try {
    assertExternalActionAttemptIdentity(attempt, handoff);
  } catch {
    return false;
  }
  return (
    attempt.jobId === input.jobId &&
    handoff.fingerprint === input.handoffFingerprint &&
    attempt.handoffFingerprint === input.handoffFingerprint &&
    attempt.status === "readback_verified" &&
    attempt.verifiedReceiptFingerprint === input.verifiedReceiptFingerprint &&
    (record.state === "readback_verified" || record.state === "committed") &&
    record.transitions.some(
      (transition) => transition.state === "readback_verified",
    )
  );
}

function assertExternalActionAttemptIdentity(
  attempt: ExternalActionDispatchAttemptV1,
  handoff: PreparedExternalActionHandoffV1,
): void {
  if (
    attempt.provider !== "linear" ||
    attempt.operation !== "linear_issue_state_update_v1" ||
    attempt.handoffFingerprint !== handoff.fingerprint ||
    attempt.attemptId !==
      linearIssueStateUpdateAttemptIdV1(attempt.jobId, handoff)
  ) {
    throw new Error(
      "External action attempt identity drifted from its prepared handoff.",
    );
  }
}

function assertLinearStateUpdateReceiptSemantics(
  receipt: ExternalActionCompanionReceiptV1,
  handoff: PreparedExternalActionHandoffV1,
): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.fingerprint)) {
    throw new Error("External action receipt fingerprint is invalid.");
  }
  const dispatchedKeys = [
    "attemptId",
    "handoffFingerprint",
    "issueId",
    "preconditionFingerprint",
    "preparedActionFingerprint",
    "targetStateId",
  ].sort();
  const transitionKeys = [
    ...dispatchedKeys,
    "observedStateId",
    "observedUpdatedAt",
    "readbackFingerprint",
    "reconciliationMode",
  ].sort();
  const expectedKeys =
    receipt.status === "dispatched" ? dispatchedKeys : transitionKeys;
  if (
    !["dispatched", "ambiguous", "verified"].includes(receipt.status) ||
    Object.keys(receipt.payload).sort().join("\0") !== expectedKeys.join("\0")
  ) {
    throw new Error(
      "External action receipt does not match the closed Linear state-update contract.",
    );
  }
  if (
    receipt.payload.handoffFingerprint !== handoff.fingerprint ||
    receipt.payload.preparedActionFingerprint !==
      handoff.preparedActionFingerprint ||
    receipt.payload.issueId !== handoff.payload.issueId ||
    receipt.payload.targetStateId !== handoff.payload.stateId ||
    receipt.payload.preconditionFingerprint !==
      handoff.payload.preconditionFingerprint
  ) {
    throw new Error(
      "External action receipt payload drifted from the exact prepared action.",
    );
  }
  if (receipt.status === "dispatched") return;
  if (
    (receipt.payload.reconciliationMode !== "dispatch" &&
      receipt.payload.reconciliationMode !== "readback_only") ||
    (receipt.payload.observedStateId !== null &&
      typeof receipt.payload.observedStateId !== "string") ||
    (receipt.payload.observedUpdatedAt !== null &&
      (typeof receipt.payload.observedUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(receipt.payload.observedUpdatedAt)))) ||
    (receipt.payload.readbackFingerprint !== null &&
      (typeof receipt.payload.readbackFingerprint !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(receipt.payload.readbackFingerprint)))
  ) {
    throw new Error("External action readback receipt is malformed.");
  }
  if (
    receipt.status === "verified" &&
    (receipt.payload.observedStateId !== handoff.payload.stateId ||
      typeof receipt.payload.observedUpdatedAt !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(
        String(receipt.payload.readbackFingerprint),
      ))
  ) {
    throw new Error(
      "External action verification receipt does not prove the approved target state.",
    );
  }
}

function assertBackgroundCodeAttemptIdentity(
  attempt: BackgroundCodeDispatchAttemptV1,
  handoff: PreparedBackgroundCodeActionV1,
  packageIdentity: PreparedBackgroundCodePackageIdentityV1,
): void {
  if (
    attempt.provider !== "code" ||
    attempt.operation !== "prepared_code_validation_commit_v1" ||
    attempt.handoffFingerprint !== handoff.fingerprint ||
    attempt.packageFingerprint !== packageIdentity.packageFingerprint ||
    attempt.packageIdentityFingerprint !== packageIdentity.fingerprint ||
    packageIdentity.handoffFingerprint !== handoff.fingerprint ||
    attempt.attemptId !==
      backgroundCodeContinuationAttemptIdV1(attempt.jobId, handoff)
  ) {
    throw new Error(
      "Background Code attempt identity drifted from its prepared package.",
    );
  }
}

function assertBackgroundCodeReceiptSemantics(
  receipt: BackgroundCodeCompanionReceiptV1,
  handoff: PreparedBackgroundCodeActionV1,
): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.fingerprint)) {
    throw new Error("Background Code receipt fingerprint is invalid.");
  }
  const prefix = [
    "attemptId",
    "handoffFingerprint",
    "repairCheckpointId",
  ];
  const dispatchKeys = [
    ...prefix,
    "checkpointSequence",
    "repairRequestFingerprint",
  ].sort();
  const ambiguousFailureKeys = [
    ...prefix,
    "checkpointSequence",
    "failureFingerprint",
  ].sort();
  const verifiedKeys = [
    ...prefix,
    "checkpointSequence",
    "verifiedCommitReceiptFingerprint",
    "commitSha",
    "workspaceBindingFingerprint",
    "repositoryProfileFingerprint",
    "sandboxCapabilityFingerprint",
  ].sort();
  const keys = Object.keys(receipt.payload).sort();
  const exact = (expected: string[]) => keys.join("\0") === expected.join("\0");
  const shapeMatches =
    receipt.status === "dispatched"
      ? exact(dispatchKeys)
      : receipt.status === "ambiguous"
        ? exact(dispatchKeys) || exact(ambiguousFailureKeys)
        : receipt.status === "verified"
          ? exact(verifiedKeys)
          : false;
  if (!shapeMatches) {
    throw new Error(
      "Background Code receipt does not match the closed validation-commit contract.",
    );
  }
  if (
    receipt.payload.handoffFingerprint !== handoff.fingerprint ||
    receipt.payload.repairCheckpointId !==
      handoff.payload.repairCheckpointId ||
    !Number.isSafeInteger(receipt.payload.checkpointSequence) ||
    Number(receipt.payload.checkpointSequence) <
      handoff.payload.preparedCheckpointSequence
  ) {
    throw new Error(
      "Background Code receipt payload drifted from the exact repair checkpoint.",
    );
  }
  if ("repairRequestFingerprint" in receipt.payload) {
    if (
      receipt.payload.repairRequestFingerprint !==
      handoff.payload.repairRequestFingerprint
    ) {
      throw new Error(
        "Background Code receipt request fingerprint drifted.",
      );
    }
  }
  if (
    "failureFingerprint" in receipt.payload &&
    !/^sha256:[a-f0-9]{64}$/u.test(String(receipt.payload.failureFingerprint))
  ) {
    throw new Error("Background Code ambiguity fingerprint is invalid.");
  }
  if (receipt.status !== "verified") return;
  if (
    !/^[a-f0-9]{40}$/u.test(String(receipt.payload.commitSha)) ||
    !/^sha256:[a-f0-9]{64}$/u.test(
      String(receipt.payload.verifiedCommitReceiptFingerprint),
    ) ||
    receipt.payload.workspaceBindingFingerprint !==
      handoff.payload.workspaceBindingFingerprint ||
    receipt.payload.repositoryProfileFingerprint !==
      handoff.payload.repositoryProfileFingerprint ||
    receipt.payload.sandboxCapabilityFingerprint !==
      handoff.payload.sandboxCapabilityFingerprint
  ) {
    throw new Error(
      "Background Code verification receipt does not prove the exact prepared commit.",
    );
  }
}

function assertBackgroundGitHubAttemptIdentity(
  attempt: BackgroundGitHubDispatchAttemptV1,
  action: PreparedBackgroundGitHubActionV1,
  packageIdentity: PreparedBackgroundGitHubPackageIdentityV1,
): void {
  if (
    attempt.provider !== "github" ||
    attempt.operation !== action.operation ||
    attempt.actionFingerprint !== action.fingerprint ||
    attempt.packageFingerprint !== packageIdentity.packageFingerprint ||
    attempt.packageIdentityFingerprint !== packageIdentity.fingerprint ||
    packageIdentity.actionFingerprint !== action.fingerprint ||
    packageIdentity.preparedActionFingerprint !==
      action.preparedActionFingerprint ||
    packageIdentity.operation !== action.operation ||
    packageIdentity.publicationId !== action.payload.publicationId ||
    packageIdentity.repositoryBindingFingerprint !==
      action.binding.repositoryBindingFingerprint ||
    packageIdentity.repositoryProfileFingerprint !==
      action.binding.repositoryProfileFingerprint ||
    packageIdentity.verifiedAccountId !== action.binding.verifiedAccountId ||
    attempt.attemptId !==
      backgroundGitHubActionAttemptIdV1(attempt.jobId, action)
  ) {
    throw new Error(
      "Background GitHub attempt identity drifted from its prepared package.",
    );
  }
}

function assertBackgroundGitHubReceiptSemantics(
  receipt: BackgroundGitHubCompanionReceiptV1,
  action: PreparedBackgroundGitHubActionV1,
): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(receipt.fingerprint)) {
    throw new Error("Background GitHub receipt fingerprint is invalid.");
  }
  const baseKeys = [
    "attemptId",
    "actionFingerprint",
    "packageFingerprint",
  ].sort();
  const verifiedKeys = [
    ...baseKeys,
    "resultFingerprint",
    "verifiedResult",
  ].sort();
  const expectedKeys = receipt.status === "verified" ? verifiedKeys : baseKeys;
  if (
    !["ambiguous", "failed", "verified"].includes(receipt.status) ||
    Object.keys(receipt.payload).sort().join("\0") !== expectedKeys.join("\0")
  ) {
    throw new Error(
      "Background GitHub receipt does not match the closed provider-result contract.",
    );
  }
  if (receipt.payload.actionFingerprint !== action.fingerprint) {
    throw new Error(
      "Background GitHub receipt action fingerprint drifted from the sealed action.",
    );
  }
  if (receipt.status !== "verified") return;
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(
      String(receipt.payload.resultFingerprint),
    ) ||
    !receipt.payload.verifiedResult ||
    typeof receipt.payload.verifiedResult !== "object" ||
    Array.isArray(receipt.payload.verifiedResult)
  ) {
    throw new Error(
      "Background GitHub verified receipt is missing its complete result proof.",
    );
  }
}

function assertBackgroundGitHubVerifiedResultSemantics(
  result: BackgroundGitHubVerifiedResultV1,
  action: PreparedBackgroundGitHubActionV1,
): void {
  if (
    result.operation !== action.operation ||
    result.publicationId !== action.payload.publicationId ||
    result.repositoryBindingFingerprint !==
      action.binding.repositoryBindingFingerprint ||
    result.verifiedAccountId !== action.binding.verifiedAccountId
  ) {
    throw new Error(
      "Background GitHub verified result drifted from its exact operation, publication, repository, or account.",
    );
  }
  switch (action.operation) {
    case "github_verified_branch_push_v1":
      if (
        result.headSha !== action.payload.headSha ||
        result.pullRequestNumber !== null ||
        result.mergeSha !== null ||
        result.autoMergeEnabled
      ) {
        throw new Error(
          "Background GitHub push proof does not prove the exact approved branch head.",
        );
      }
      break;
    case "github_draft_pull_request_v1":
      if (
        result.headSha !== action.payload.headSha ||
        result.pullRequestNumber === null ||
        result.mergeSha !== null ||
        result.autoMergeEnabled
      ) {
        throw new Error(
          "Background GitHub draft-PR proof does not prove the exact approved head.",
        );
      }
      break;
    case "github_review_repair_fast_forward_v1":
      if (
        result.headSha !== action.payload.newHeadSha ||
        result.pullRequestNumber !== action.payload.pullRequestNumber ||
        result.mergeSha !== null ||
        result.autoMergeEnabled
      ) {
        throw new Error(
          "Background GitHub review-repair proof does not prove the exact fast-forward head.",
        );
      }
      break;
    case "github_pull_request_merge_v1":
      if (
        result.headSha !== action.payload.headSha ||
        result.pullRequestNumber !== action.payload.pullRequestNumber ||
        result.mergeSha === null ||
        result.autoMergeEnabled
      ) {
        throw new Error(
          "Background GitHub merge proof does not prove the exact approved pull request.",
        );
      }
      break;
    case "github_pull_request_auto_merge_v1":
      if (
        result.headSha !== action.payload.headSha ||
        result.pullRequestNumber !== action.payload.pullRequestNumber ||
        result.mergeSha !== null ||
        !result.autoMergeEnabled
      ) {
        throw new Error(
          "Background GitHub auto-merge proof does not prove enablement for the exact approved pull request.",
        );
      }
      break;
  }
}

function assertMonotonicExternalReceiptTimes(
  receipts: ExternalActionCompanionReceiptV1[],
): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const receipt of receipts) {
    const committedAt = Date.parse(receipt.committedAt);
    if (!Number.isFinite(committedAt) || committedAt < previous) {
      throw new Error(
        "External action receipts are not in durable commit order.",
      );
    }
    previous = committedAt;
  }
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
      preparedExternalActionHandoff: record.preparedExternalActionHandoff
        ? clonePreparedExternalActionHandoff(
            record.preparedExternalActionHandoff,
          )
        : undefined,
      externalActionDispatchAttempt: record.externalActionDispatchAttempt
        ? { ...record.externalActionDispatchAttempt }
        : undefined,
      preparedBackgroundCodeAction: record.preparedBackgroundCodeAction
        ? parsePreparedBackgroundCodeActionV1(
            record.preparedBackgroundCodeAction,
          )
        : undefined,
      preparedBackgroundCodePackage: record.preparedBackgroundCodePackage
        ? parsePreparedBackgroundCodePackageIdentityV1(
            record.preparedBackgroundCodePackage,
          )
        : undefined,
      backgroundCodeDispatchAttempt: record.backgroundCodeDispatchAttempt
        ? { ...record.backgroundCodeDispatchAttempt }
        : undefined,
      preparedBackgroundGitHubAction: record.preparedBackgroundGitHubAction
        ? parsePreparedBackgroundGitHubActionV1(
            record.preparedBackgroundGitHubAction,
          )
        : undefined,
      preparedBackgroundGitHubPackage: record.preparedBackgroundGitHubPackage
        ? parsePreparedBackgroundGitHubPackageIdentityV1(
            record.preparedBackgroundGitHubPackage,
          )
        : undefined,
      backgroundGitHubDispatchAttempt: record.backgroundGitHubDispatchAttempt
        ? { ...record.backgroundGitHubDispatchAttempt }
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
  const contentHash = getNonEmptyString(value.contentHash);
  const parserStatus =
    value.parserStatus === "parsed" ||
    value.parserStatus === "empty" ||
    value.parserStatus === "missing_content" ||
    value.parserStatus === "legacy_unknown"
      ? value.parserStatus
      : undefined;
  return {
    id,
    kind,
    title,
    path: getNonEmptyString(value.path),
    url: getNonEmptyString(value.url),
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
    preparedExternalActionHandoff:
      normalizePreparedExternalActionHandoff(
        value.preparedExternalActionHandoff,
      ) ?? undefined,
    externalActionDispatchAttempt:
      normalizeExternalActionDispatchAttempt(
        value.externalActionDispatchAttempt,
      ) ?? undefined,
    preparedBackgroundCodeAction:
      normalizePreparedBackgroundCodeAction(
        value.preparedBackgroundCodeAction,
      ) ?? undefined,
    preparedBackgroundCodePackage:
      normalizePreparedBackgroundCodePackage(
        value.preparedBackgroundCodePackage,
      ) ?? undefined,
    backgroundCodeDispatchAttempt:
      normalizeBackgroundCodeDispatchAttempt(
        value.backgroundCodeDispatchAttempt,
      ) ?? undefined,
    preparedBackgroundGitHubAction:
      normalizePreparedBackgroundGitHubAction(
        value.preparedBackgroundGitHubAction,
      ) ?? undefined,
    preparedBackgroundGitHubPackage:
      normalizePreparedBackgroundGitHubPackage(
        value.preparedBackgroundGitHubPackage,
      ) ?? undefined,
    backgroundGitHubDispatchAttempt:
      normalizeBackgroundGitHubDispatchAttempt(
        value.backgroundGitHubDispatchAttempt,
      ) ?? undefined,
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

function normalizePreparedExternalActionHandoff(
  value: unknown,
): PreparedExternalActionHandoffV1 | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return parsePreparedExternalActionHandoffV1(value);
  } catch {
    return null;
  }
}

function normalizeExternalActionDispatchAttempt(
  value: unknown,
): ExternalActionDispatchAttemptV1 | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const jobId = getNonEmptyString(value.jobId);
  const attemptId = getNonEmptyString(value.attemptId);
  const handoffFingerprint = getNonEmptyString(value.handoffFingerprint);
  const preparedAt = getNonEmptyString(value.preparedAt);
  const updatedAt = getNonEmptyString(value.updatedAt);
  if (
    value.version !== 1 ||
    value.provider !== "linear" ||
    value.operation !== "linear_issue_state_update_v1" ||
    ![
      "prepared",
      "job_submitted",
      "dispatched",
      "ambiguous",
      "readback_verified",
    ].includes(String(status)) ||
    !jobId ||
    !attemptId ||
    !handoffFingerprint ||
    !preparedAt ||
    !updatedAt ||
    !/^sha256:[0-9a-f]{64}$/u.test(attemptId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(handoffFingerprint)
  ) {
    return null;
  }
  const nullableFingerprint = (candidate: unknown) => {
    if (candidate === null) return null;
    const text = getNonEmptyString(candidate);
    return text && /^sha256:[0-9a-f]{64}$/u.test(text) ? text : undefined;
  };
  const dispatchedReceiptFingerprint = nullableFingerprint(
    value.dispatchedReceiptFingerprint,
  );
  const ambiguousReceiptFingerprint = nullableFingerprint(
    value.ambiguousReceiptFingerprint,
  );
  const verifiedReceiptFingerprint = nullableFingerprint(
    value.verifiedReceiptFingerprint,
  );
  if (
    dispatchedReceiptFingerprint === undefined ||
    ambiguousReceiptFingerprint === undefined ||
    verifiedReceiptFingerprint === undefined
  ) {
    return null;
  }
  const submittedAt =
    value.submittedAt === null ? null : getNonEmptyString(value.submittedAt);
  if (value.submittedAt !== null && !submittedAt) return null;
  return {
    version: 1,
    provider: "linear",
    operation: "linear_issue_state_update_v1",
    jobId,
    attemptId,
    handoffFingerprint,
    status: status as ExternalActionDispatchAttemptV1["status"],
    preparedAt,
    submittedAt: submittedAt ?? null,
    dispatchedReceiptFingerprint,
    ambiguousReceiptFingerprint,
    verifiedReceiptFingerprint,
    updatedAt,
  };
}

function normalizePreparedBackgroundCodeAction(
  value: unknown,
): PreparedBackgroundCodeActionV1 | null {
  if (value === undefined || value === null) return null;
  try {
    return parsePreparedBackgroundCodeActionV1(value);
  } catch {
    return null;
  }
}

function normalizePreparedBackgroundCodePackage(
  value: unknown,
): PreparedBackgroundCodePackageIdentityV1 | null {
  if (value === undefined || value === null) return null;
  try {
    return parsePreparedBackgroundCodePackageIdentityV1(value);
  } catch {
    return null;
  }
}

function normalizeBackgroundCodeDispatchAttempt(
  value: unknown,
): BackgroundCodeDispatchAttemptV1 | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const jobId = getNonEmptyString(value.jobId);
  const attemptId = getNonEmptyString(value.attemptId);
  const handoffFingerprint = getNonEmptyString(value.handoffFingerprint);
  const packageFingerprint = getNonEmptyString(value.packageFingerprint);
  const packageIdentityFingerprint = getNonEmptyString(
    value.packageIdentityFingerprint,
  );
  const preparedAt = getNonEmptyString(value.preparedAt);
  const updatedAt = getNonEmptyString(value.updatedAt);
  const sha = (candidate: string | undefined) =>
    Boolean(candidate && /^sha256:[0-9a-f]{64}$/u.test(candidate));
  if (
    value.version !== 1 ||
    value.provider !== "code" ||
    value.operation !== "prepared_code_validation_commit_v1" ||
    ![
      "prepared",
      "job_submitted",
      "dispatched",
      "ambiguous",
      "readback_verified",
    ].includes(String(status)) ||
    !jobId ||
    !sha(attemptId) ||
    !sha(handoffFingerprint) ||
    !sha(packageFingerprint) ||
    !sha(packageIdentityFingerprint) ||
    !preparedAt ||
    !updatedAt
  ) {
    return null;
  }
  const nullableSha = (candidate: unknown): string | null | undefined => {
    if (candidate === null) return null;
    const text = getNonEmptyString(candidate);
    return text && /^sha256:[0-9a-f]{64}$/u.test(text) ? text : undefined;
  };
  const dispatchedReceiptFingerprint = nullableSha(
    value.dispatchedReceiptFingerprint,
  );
  const ambiguousReceiptFingerprint = nullableSha(
    value.ambiguousReceiptFingerprint,
  );
  const verifiedReceiptFingerprint = nullableSha(
    value.verifiedReceiptFingerprint,
  );
  const verifiedCommitReceiptFingerprint = nullableSha(
    value.verifiedCommitReceiptFingerprint,
  );
  if (
    dispatchedReceiptFingerprint === undefined ||
    ambiguousReceiptFingerprint === undefined ||
    verifiedReceiptFingerprint === undefined ||
    verifiedCommitReceiptFingerprint === undefined
  ) {
    return null;
  }
  const submittedAt =
    value.submittedAt === null ? null : getNonEmptyString(value.submittedAt);
  const commitSha =
    value.commitSha === null ? null : getNonEmptyString(value.commitSha);
  if (
    (value.submittedAt !== null && !submittedAt) ||
    (value.commitSha !== null && !/^[a-f0-9]{40}$/u.test(commitSha ?? ""))
  ) {
    return null;
  }
  return {
    version: 1,
    provider: "code",
    operation: "prepared_code_validation_commit_v1",
    jobId,
    attemptId: attemptId!,
    handoffFingerprint: handoffFingerprint!,
    packageFingerprint: packageFingerprint!,
    packageIdentityFingerprint: packageIdentityFingerprint!,
    status: status as BackgroundCodeDispatchAttemptV1["status"],
    preparedAt,
    submittedAt: submittedAt ?? null,
    dispatchedReceiptFingerprint,
    ambiguousReceiptFingerprint,
    verifiedReceiptFingerprint,
    verifiedCommitReceiptFingerprint,
    commitSha: commitSha ?? null,
    updatedAt,
  };
}

function normalizePreparedBackgroundGitHubAction(
  value: unknown,
): PreparedBackgroundGitHubActionV1 | null {
  if (value === undefined || value === null) return null;
  try {
    return parsePreparedBackgroundGitHubActionV1(value);
  } catch {
    return null;
  }
}

function normalizePreparedBackgroundGitHubPackage(
  value: unknown,
): PreparedBackgroundGitHubPackageIdentityV1 | null {
  if (value === undefined || value === null) return null;
  try {
    return parsePreparedBackgroundGitHubPackageIdentityV1(value);
  } catch {
    return null;
  }
}

function normalizeBackgroundGitHubDispatchAttempt(
  value: unknown,
): BackgroundGitHubDispatchAttemptV1 | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  const jobId = getNonEmptyString(value.jobId);
  const attemptId = getNonEmptyString(value.attemptId);
  const actionFingerprint = getNonEmptyString(value.actionFingerprint);
  const packageFingerprint = getNonEmptyString(value.packageFingerprint);
  const packageIdentityFingerprint = getNonEmptyString(
    value.packageIdentityFingerprint,
  );
  const preparedAt = getNonEmptyString(value.preparedAt);
  const updatedAt = getNonEmptyString(value.updatedAt);
  const sha = (candidate: string | undefined) =>
    Boolean(candidate && /^sha256:[0-9a-f]{64}$/u.test(candidate));
  const operations: PreparedBackgroundGitHubOperationV1[] = [
    "github_verified_branch_push_v1",
    "github_draft_pull_request_v1",
    "github_review_repair_fast_forward_v1",
    "github_pull_request_merge_v1",
    "github_pull_request_auto_merge_v1",
  ];
  if (
    value.version !== 1 ||
    value.provider !== "github" ||
    !operations.includes(value.operation as PreparedBackgroundGitHubOperationV1) ||
    ![
      "prepared",
      "job_submitted",
      "dispatched",
      "ambiguous",
      "readback_verified",
    ].includes(String(status)) ||
    !jobId ||
    !sha(attemptId) ||
    !sha(actionFingerprint) ||
    !sha(packageFingerprint) ||
    !sha(packageIdentityFingerprint) ||
    !preparedAt ||
    !updatedAt
  ) {
    return null;
  }
  const nullableSha = (candidate: unknown): string | null | undefined => {
    if (candidate === null) return null;
    const text = getNonEmptyString(candidate);
    return text && /^sha256:[0-9a-f]{64}$/u.test(text) ? text : undefined;
  };
  const dispatchedReceiptFingerprint = nullableSha(
    value.dispatchedReceiptFingerprint,
  );
  const ambiguousReceiptFingerprint = nullableSha(
    value.ambiguousReceiptFingerprint,
  );
  const verifiedReceiptFingerprint = nullableSha(
    value.verifiedReceiptFingerprint,
  );
  const verifiedResultFingerprint = nullableSha(
    value.verifiedResultFingerprint,
  );
  if (
    dispatchedReceiptFingerprint === undefined ||
    ambiguousReceiptFingerprint === undefined ||
    verifiedReceiptFingerprint === undefined ||
    verifiedResultFingerprint === undefined
  ) {
    return null;
  }
  const submittedAt =
    value.submittedAt === null ? null : getNonEmptyString(value.submittedAt);
  if (value.submittedAt !== null && !submittedAt) return null;
  return {
    version: 1,
    provider: "github",
    operation: value.operation as PreparedBackgroundGitHubOperationV1,
    jobId,
    attemptId: attemptId!,
    actionFingerprint: actionFingerprint!,
    packageFingerprint: packageFingerprint!,
    packageIdentityFingerprint: packageIdentityFingerprint!,
    status: status as BackgroundGitHubDispatchAttemptV1["status"],
    preparedAt,
    submittedAt: submittedAt ?? null,
    dispatchedReceiptFingerprint,
    ambiguousReceiptFingerprint,
    verifiedReceiptFingerprint,
    verifiedResultFingerprint,
    updatedAt,
  };
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

function clonePreparedExternalActionHandoff(
  handoff: PreparedExternalActionHandoffV1,
): PreparedExternalActionHandoffV1 {
  return parsePreparedExternalActionHandoffV1(
    JSON.parse(JSON.stringify(handoff)),
  );
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
    applying: ["applied", "dispatched", "failed", "reconcile_required"],
    dispatched: [
      "ambiguous",
      "readback_verified",
      "failed",
      "reconcile_required",
    ],
    ambiguous: ["readback_verified", "failed", "reconcile_required"],
    readback_verified: ["committed", "failed", "reconcile_required"],
    applied: ["verified", "failed", "reconcile_required"],
    verified: ["committed", "failed", "reconcile_required"],
    committed: [],
    failed: ["reconcile_required"],
    reconcile_required: [
      "ambiguous",
      "readback_verified",
      "verified",
      "committed",
      "failed",
    ],
  };
  return allowed[from].includes(to);
}

function getReconciliationAction(
  record: OperationJournalRecord,
): OperationReconciliationAction {
  if (record.state === "intent_recorded" && !record.mutationMayHaveApplied) {
    return "safe_to_retry";
  }
  if (isExactLifecycleCompositeRetry(record)) {
    return "safe_to_retry";
  }
  if (record.state === "readback_verified") {
    return "verify_receipt";
  }
  if (record.receipt && record.state !== "committed") {
    return "verify_receipt";
  }
  if (
    (record.preparedAction ||
      record.externalActionDispatchAttempt ||
      record.backgroundCodeDispatchAttempt ||
      record.backgroundGitHubDispatchAttempt) &&
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

/**
 * These host-owned composites persist their own provider-specific checkpoint
 * before returning `reconcile_required`. Re-entering the same graph node does
 * readback reconciliation from that checkpoint; it does not blindly replay
 * the nested mutation. The outer WAL remains honest that an effect may have
 * occurred, while its recovery recommendation permits only this exact,
 * fingerprinted composite continuation.
 */
function isExactLifecycleCompositeRetry(
  record: OperationJournalRecord,
): boolean {
  return (
    record.state === "reconcile_required" &&
    record.mutationMayHaveApplied &&
    EXACT_LIFECYCLE_RECONCILIATION_TOOLS.has(record.toolName) &&
    typeof record.nodeId === "string" &&
    record.nodeId.length > 0 &&
    typeof record.inputHash === "string" &&
    record.inputHash.length > 0 &&
    record.preparedAction === undefined &&
    record.descriptor?.durability.journal === true &&
    record.descriptor.durability.receipt === true &&
    record.descriptor.durability.readback === "required" &&
    record.descriptor.durability.reconciliation === "required"
  );
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
    value === "dispatched" ||
    value === "ambiguous" ||
    value === "readback_verified" ||
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

export function normalizeMissionGraphStoreReference(
  value: unknown,
): MissionGraphStoreReferenceV1 | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const missionId = getNonEmptyString(value.missionId);
  const path = getNonEmptyString(value.path);
  const recordFingerprint = getNonEmptyString(value.recordFingerprint);
  const journalHeadFingerprint = value.journalHeadFingerprint === null
    ? null
    : getNonEmptyString(value.journalHeadFingerprint);
  if (
    !missionId ||
    !path ||
    !recordFingerprint ||
    !/^sha256:[a-f0-9]{64}$/.test(recordFingerprint) ||
    journalHeadFingerprint === undefined ||
    (journalHeadFingerprint !== null &&
      !/^sha256:[a-f0-9]{64}$/.test(journalHeadFingerprint))
  ) {
    return null;
  }
  let normalizedPath: string;
  try {
    normalizedPath = normalizeVaultPath(path, { requireMarkdown: true });
  } catch {
    return null;
  }
  if (!/^Agent Runs\/Mission Graphs\/[^/]+\.md$/i.test(normalizedPath)) {
    return null;
  }
  const storeRevision = normalizeNonNegativeInteger(value.storeRevision);
  const graphRevision = normalizeNonNegativeInteger(value.graphRevision);
  if (storeRevision < 1) {
    return null;
  }
  return {
    version: 1,
    missionId,
    path: normalizedPath,
    storeRevision,
    graphRevision,
    recordFingerprint,
    journalHeadFingerprint,
  };
}

function parseDateOrNow(value: string): Date {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

type BoundedSettlement<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; value: unknown }
  | { kind: "timed_out" };

async function settleBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<BoundedSettlement<T>> {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<BoundedSettlement<T>>((resolve) => {
    timeout = setTimeout(
      () => resolve({ kind: "timed_out" }),
      boundedTimeoutMs,
    );
  });
  const settled = promise
    .then<BoundedSettlement<T>>((value) => ({ kind: "resolved", value }))
    .catch<BoundedSettlement<T>>((value: unknown) => ({
      kind: "rejected",
      value,
    }));
  try {
    return await Promise.race([settled, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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
