import { reduceOrchestratorEvent } from "./orchestratorReducer";
import {
  ORCHESTRATOR_SNAPSHOT_VERSION,
  type AgentHandoffStatus,
  type AgentParticipant,
  type AgentParticipantBudget,
  type AgentParticipantStatus,
  type AgentRole,
  type GitWorktreeState,
  type GitWorktreeStatus,
  type HandoffConfidence,
  type IntegrationStatus,
  type MergeStatus,
  type MergeSummary,
  type OrchestrationMode,
  type OrchestratorEvent,
  type OrchestratorProofContract,
  type OrchestratorRunStatus,
  type OrchestratorSnapshotV1,
  type OrchestratorWorkNode,
  type SourceLedgerSummary,
  type VerificationStatus,
  type WorkerHandoff,
  type WorkerHandoffStatus,
  type WorkNodeKind,
  type WorkNodeStatus,
} from "./types";

export const MAX_ORCHESTRATOR_NODES = 512;
export const MAX_ORCHESTRATOR_PARTICIPANTS = 8;
export const MAX_ORCHESTRATOR_WORKTREES = 64;
export const MAX_ORCHESTRATOR_HANDOFFS = 128;

export interface NormalizeOrchestratorSnapshotOptions {
  fallbackRunId?: string;
  now?: Date;
}

export interface OrchestratorSnapshotRepository {
  read(runId: string): Promise<unknown | null>;
  write(snapshot: OrchestratorSnapshotV1): Promise<void>;
}

/**
 * Accepts v1 and the pre-versioned preview shape. Missing participant data is
 * migrated to a single Lead so old/single-agent runtime snapshots remain UI
 * compatible without fabricating worker activity.
 */
export function normalizeOrchestratorSnapshot(
  value: unknown,
  options: NormalizeOrchestratorSnapshotOptions = {},
): OrchestratorSnapshotV1 | null {
  if (!isRecord(value)) return null;
  if (value.version !== undefined && value.version !== 0 && value.version !== 1) {
    return null;
  }
  const fallbackNow = (options.now ?? new Date(0)).toISOString();
  const runId = safeId(value.runId) ?? safeId(options.fallbackRunId);
  if (!runId) return null;
  const createdAt = timestamp(value.createdAt, fallbackNow);
  const updatedAt = timestamp(value.updatedAt, createdAt);

  const rawParticipants = isRecord(value.participants)
    ? Object.entries(value.participants)
    : Array.isArray(value.participants)
      ? value.participants.map((item, index) => [String(index), item] as const)
      : isRecord(value.agents)
        ? Object.entries(value.agents)
        : [];
  const participants: Record<string, AgentParticipant> = {};
  for (const [key, item] of rawParticipants.slice(0, MAX_ORCHESTRATOR_PARTICIPANTS)) {
    const participant = normalizeParticipant(item, key, updatedAt);
    if (participant) participants[participant.id] = participant;
  }
  if (Object.keys(participants).length === 0) {
    participants.lead = normalizeParticipant(
      { id: "lead", role: "lead", displayName: "Lead", status: "planning" },
      "lead",
      updatedAt,
    )!;
  }

  const rawNodes = isRecord(value.nodes)
    ? Object.entries(value.nodes)
    : Array.isArray(value.nodes)
      ? value.nodes.map((item, index) => [String(index), item] as const)
      : Array.isArray(value.tasks)
        ? value.tasks.map((item, index) => [String(index), item] as const)
        : [];
  const nodes: Record<string, OrchestratorWorkNode> = {};
  for (const [key, item] of rawNodes.slice(0, MAX_ORCHESTRATOR_NODES)) {
    const node = normalizeNode(item, key);
    if (node) nodes[node.id] = node;
  }
  repairNodeReferences(nodes, participants);

  const worktrees: Record<string, GitWorktreeState> = {};
  for (const [key, item] of recordEntries(value.worktrees).slice(
    0,
    MAX_ORCHESTRATOR_WORKTREES,
  )) {
    const worktree = normalizeWorktree(item, key);
    if (worktree && nodes[worktree.taskId]) worktrees[worktree.id] = worktree;
  }
  for (const node of Object.values(nodes)) {
    if (node.worktreeId && !worktrees[node.worktreeId]) delete node.worktreeId;
  }
  for (const participant of Object.values(participants)) {
    if (participant.currentNodeId && !nodes[participant.currentNodeId]) {
      participant.currentNodeId = null;
    }
  }

  const rawHandoffs = Array.isArray(value.handoffs) ? value.handoffs : [];
  const handoffs = rawHandoffs
    .slice(-MAX_ORCHESTRATOR_HANDOFFS)
    .map((item) => normalizeHandoff(item, updatedAt))
    .filter((item): item is WorkerHandoff => Boolean(item))
    .filter(
      (item) =>
        Boolean(nodes[item.taskId]) &&
        Boolean(participants[item.fromParticipantId]) &&
        Boolean(participants[item.toParticipantId]),
    );

  const requestedRoots = strings(value.rootNodeIds, MAX_ORCHESTRATOR_NODES).filter(
    (id) => Boolean(nodes[id]),
  );
  const inferredRoots = Object.values(nodes)
    .filter((node) => node.parentId === null)
    .map((node) => node.id);

  return {
    version: ORCHESTRATOR_SNAPSHOT_VERSION,
    runId,
    mode: enumValue(value.mode, MODES) ?? inferMode(participants),
    status: enumValue(value.status, RUN_STATUSES) ?? "running",
    rootNodeIds: unique([...requestedRoots, ...inferredRoots]),
    nodes,
    participants,
    worktrees,
    handoffs,
    merge: normalizeMerge(value.merge, updatedAt),
    ...(normalizeSourceLedgerSummary(value.sourceLedgerSummary)
      ? {
          sourceLedgerSummary: normalizeSourceLedgerSummary(
            value.sourceLedgerSummary,
          )!,
        }
      : {}),
    sequence: nonNegativeInteger(value.sequence),
    createdAt,
    updatedAt,
  };
}

export function serializeOrchestratorSnapshot(
  snapshot: OrchestratorSnapshotV1,
): string {
  const normalized = normalizeOrchestratorSnapshot(snapshot);
  if (!normalized) throw new Error("Cannot serialize invalid orchestrator snapshot.");
  return JSON.stringify(normalized);
}

export function parseOrchestratorSnapshot(
  json: string,
  options: NormalizeOrchestratorSnapshotOptions = {},
): OrchestratorSnapshotV1 | null {
  try {
    return normalizeOrchestratorSnapshot(JSON.parse(json), options);
  } catch {
    return null;
  }
}

/** Serialized per-run writes keep event projection and persistence ordered. */
export class OrchestratorStore {
  private readonly snapshots = new Map<string, OrchestratorSnapshotV1>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly repository?: OrchestratorSnapshotRepository) {}

  get(runId: string): OrchestratorSnapshotV1 | null {
    const snapshot = this.snapshots.get(runId);
    return snapshot ? normalizeOrchestratorSnapshot(snapshot) : null;
  }

  async restore(runId: string): Promise<OrchestratorSnapshotV1 | null> {
    if (!this.repository) return this.get(runId);
    const restored = normalizeOrchestratorSnapshot(await this.repository.read(runId), {
      fallbackRunId: runId,
    });
    if (restored) this.snapshots.set(runId, restored);
    return restored ? normalizeOrchestratorSnapshot(restored) : null;
  }

  async append(event: OrchestratorEvent): Promise<OrchestratorSnapshotV1> {
    return this.enqueue(event.runId, async () => {
      const current = this.snapshots.get(event.runId) ?? null;
      const next = reduceOrchestratorEvent(current, event);
      const normalized = normalizeOrchestratorSnapshot(next);
      if (!normalized) throw new Error("Reducer produced an invalid snapshot.");
      if (this.repository) await this.repository.write(normalized);
      this.snapshots.set(event.runId, normalized);
      return normalizeOrchestratorSnapshot(normalized)!;
    });
  }

  async patch(
    runId: string,
    patch: Partial<Pick<OrchestratorSnapshotV1, "sourceLedgerSummary">>,
  ): Promise<OrchestratorSnapshotV1> {
    return this.enqueue(runId, async () => {
      const current = this.snapshots.get(runId);
      if (!current) {
        throw new Error(`No orchestrator snapshot for ${runId}.`);
      }
      const next = normalizeOrchestratorSnapshot({
        ...current,
        ...patch,
        sequence: current.sequence + 1,
        updatedAt: new Date().toISOString(),
      });
      if (!next) throw new Error("Patch produced an invalid snapshot.");
      if (this.repository) await this.repository.write(next);
      this.snapshots.set(runId, next);
      return normalizeOrchestratorSnapshot(next)!;
    });
  }

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(runId, settled);
    void settled.finally(() => {
      if (this.queues.get(runId) === settled) this.queues.delete(runId);
    });
    return current;
  }
}

function normalizeParticipant(
  value: unknown,
  fallbackId: string,
  fallbackTime: string,
): AgentParticipant | null {
  if (!isRecord(value)) return null;
  const id = value.id !== undefined ? safeId(value.id) : safeId(fallbackId);
  if (!id) return null;
  const role = enumValue(value.role, AGENT_ROLES) ?? (id === "lead" ? "lead" : "researcher");
  return {
    id,
    role,
    displayName: text(value.displayName, 120) ?? roleLabel(role),
    status: enumValue(value.status, PARTICIPANT_STATUSES) ?? "queued",
    currentNodeId: safeId(value.currentNodeId) ?? null,
    budget: normalizeParticipantBudget(value.budget),
    ...(text(value.lastAction, 1_000) ? { lastAction: text(value.lastAction, 1_000) } : {}),
    handoffStatus: enumValue(value.handoffStatus, HANDOFF_AGENT_STATUSES) ?? "none",
    ...(timestampOptional(value.startedAt) ? { startedAt: timestampOptional(value.startedAt) } : {}),
    updatedAt: timestamp(value.updatedAt, fallbackTime),
    ...(text(value.blocker, 2_000) ? { blocker: text(value.blocker, 2_000) } : {}),
  };
}

function normalizeParticipantBudget(value: unknown): AgentParticipantBudget {
  const record = isRecord(value) ? value : {};
  return {
    modelSteps: normalizeCounter(record.modelSteps),
    toolCalls: normalizeCounter(record.toolCalls),
    wallClockMs: normalizeCounter(record.wallClockMs),
  };
}

function normalizeCounter(value: unknown): { used: number; limit: number } {
  const record = isRecord(value) ? value : {};
  const limit = nonNegativeInteger(record.limit);
  return { used: Math.min(nonNegativeInteger(record.used), limit), limit };
}

function normalizeNode(value: unknown, fallbackId: string): OrchestratorWorkNode | null {
  if (!isRecord(value)) return null;
  const id = value.id !== undefined ? safeId(value.id) : safeId(fallbackId);
  const title = text(value.title, 500);
  if (!id || !title) return null;
  const parentId = safeId(value.parentId) ?? null;
  const legacyDependencies = value.dependencyIds ?? value.dependencies;
  return {
    id,
    parentId: parentId === id ? null : parentId,
    childIds: strings(value.childIds, 128).filter((item) => item !== id),
    kind: enumValue(value.kind, NODE_KINDS) ?? "mission",
    title,
    status: normalizeNodeStatus(value.status),
    ownerId: safeId(value.ownerId) ?? null,
    dependencyIds: strings(legacyDependencies, 128).filter((item) => item !== id),
    evidenceIds: strings(value.evidenceIds, 256),
    receiptIds: strings(value.receiptIds, 256),
    artifactIds: strings(value.artifactIds, 256),
    ...(normalizeProofContract(value.proofContract) ? { proofContract: normalizeProofContract(value.proofContract)! } : {}),
    ...(safeId(value.worktreeId) ? { worktreeId: safeId(value.worktreeId) } : {}),
    ...(text(value.lastAction, 1_000) ? { lastAction: text(value.lastAction, 1_000) } : {}),
    ...(text(value.resultSummary, 4_000) ? { resultSummary: text(value.resultSummary, 4_000) } : {}),
    ...(text(value.blocker, 2_000) ? { blocker: text(value.blocker, 2_000) } : {}),
    ...(timestampOptional(value.createdAt) ? { createdAt: timestampOptional(value.createdAt) } : {}),
    ...(timestampOptional(value.updatedAt) ? { updatedAt: timestampOptional(value.updatedAt) } : {}),
  };
}

function normalizeProofContract(value: unknown): OrchestratorProofContract | null {
  if (!isRecord(value)) return null;
  return {
    requiredEvidenceKinds: strings(value.requiredEvidenceKinds, 32),
    minEvidenceCount: nonNegativeInteger(value.minEvidenceCount),
    requiredReceiptKinds: strings(value.requiredReceiptKinds, 32),
    verifierIds: strings(value.verifierIds, 32),
  };
}

function repairNodeReferences(
  nodes: Record<string, OrchestratorWorkNode>,
  participants: Record<string, AgentParticipant>,
): void {
  for (const node of Object.values(nodes)) {
    if (node.parentId && !nodes[node.parentId]) node.parentId = null;
    if (node.ownerId && !participants[node.ownerId]) node.ownerId = null;
    node.childIds = unique(node.childIds.filter((id) => Boolean(nodes[id]) && id !== node.id));
    node.dependencyIds = unique(node.dependencyIds.filter((id) => Boolean(nodes[id]) && id !== node.id));
  }
  for (const node of Object.values(nodes)) {
    if (!node.parentId) continue;
    const seen = new Set([node.id]);
    let cursor: OrchestratorWorkNode | undefined = node;
    while (cursor?.parentId) {
      if (seen.has(cursor.parentId)) {
        node.parentId = null;
        break;
      }
      seen.add(cursor.parentId);
      cursor = nodes[cursor.parentId];
    }
  }
  for (const node of Object.values(nodes)) {
    if (node.parentId) {
      nodes[node.parentId].childIds = unique([...nodes[node.parentId].childIds, node.id]);
    }
  }
}

function normalizeWorktree(value: unknown, fallbackId: string): GitWorktreeState | null {
  if (!isRecord(value)) return null;
  const id = value.id !== undefined ? safeId(value.id) : safeId(fallbackId);
  const taskId = safeId(value.taskId);
  const repositoryRoot = text(value.repositoryRoot, 2_000);
  const path = text(value.path, 2_000);
  const branch = text(value.branch, 500);
  const baseBranch = text(value.baseBranch, 500);
  const baseSha = text(value.baseSha, 200);
  if (!id || !taskId || !repositoryRoot || !path || !branch || !baseBranch || !baseSha) return null;
  return {
    id,
    taskId,
    repositoryRoot,
    path,
    branch,
    baseBranch,
    baseSha,
    status: enumValue(value.status, WORKTREE_STATUSES) ?? "planned",
    changedFiles: nonNegativeInteger(value.changedFiles),
    ...(Array.isArray(value.changedFilePaths) ? { changedFilePaths: plainStrings(value.changedFilePaths, 256, 2_000) } : {}),
    validationCommands: plainStrings(value.validationCommands, 32, 1_000),
    validationPassed: value.validationPassed === true,
    ...(text(value.currentValidationCommand, 1_000) ? { currentValidationCommand: text(value.currentValidationCommand, 1_000) } : {}),
    ...(text(value.commitSha, 200) ? { commitSha: text(value.commitSha, 200) } : {}),
    ...(text(value.blocker, 2_000) ? { blocker: text(value.blocker, 2_000) } : {}),
    ...(timestampOptional(value.createdAt) ? { createdAt: timestampOptional(value.createdAt) } : {}),
    ...(timestampOptional(value.updatedAt) ? { updatedAt: timestampOptional(value.updatedAt) } : {}),
  };
}

function normalizeHandoff(value: unknown, fallbackTime: string): WorkerHandoff | null {
  if (!isRecord(value)) return null;
  const id = safeId(value.id);
  const fromParticipantId = safeId(value.fromParticipantId);
  const toParticipantId = safeId(value.toParticipantId);
  const taskId = safeId(value.taskId);
  if (!id || !fromParticipantId || !toParticipantId || !taskId) return null;
  return {
    id,
    fromParticipantId,
    toParticipantId,
    taskId,
    status: enumValue(value.status, HANDOFF_STATUSES) ?? "preparing",
    summary: text(value.summary, 8_000) ?? "",
    sourceIds: strings(value.sourceIds, 256),
    evidenceIds: strings(value.evidenceIds, 256),
    unresolvedQuestions: plainStrings(value.unresolvedQuestions, 64, 1_000),
    confidence: enumValue(value.confidence, CONFIDENCES) ?? "low",
    ...(text(value.stopReason, 1_000) ? { stopReason: text(value.stopReason, 1_000) } : {}),
    ...(text(value.commitSha, 200) ? { commitSha: text(value.commitSha, 200) } : {}),
    createdAt: timestamp(value.createdAt, fallbackTime),
    updatedAt: timestamp(value.updatedAt, fallbackTime),
  };
}

function normalizeMerge(value: unknown, fallbackTime: string): MergeSummary {
  const record = isRecord(value) ? value : {};
  return {
    status: enumValue(record.status, MERGE_STATUSES) ?? "idle",
    evidenceReceived: nonNegativeInteger(record.evidenceReceived),
    evidenceAccepted: nonNegativeInteger(record.evidenceAccepted),
    evidenceRejected: nonNegativeInteger(record.evidenceRejected),
    evidenceDeduplicated: nonNegativeInteger(record.evidenceDeduplicated),
    conflicts: nonNegativeInteger(record.conflicts),
    commitShas: plainStrings(record.commitShas, 64, 200),
    verificationStatus: enumValue(record.verificationStatus, VERIFICATION_STATUSES) ?? "pending",
    integrationStatus: enumValue(record.integrationStatus, INTEGRATION_STATUSES) ?? "not_applicable",
    ...(text(record.blocker, 2_000) ? { blocker: text(record.blocker, 2_000) } : {}),
    ...(record.updatedAt !== undefined ? { updatedAt: timestamp(record.updatedAt, fallbackTime) } : {}),
  };
}

function normalizeSourceLedgerSummary(
  value: unknown,
): SourceLedgerSummary | undefined {
  if (!isRecord(value)) return undefined;
  const proofDebtItems = Array.isArray(value.proofDebtItems)
    ? value.proofDebtItems
        .filter(isRecord)
        .slice(0, 8)
        .map((item) => ({
          claimId: text(item.claimId, 200) ?? "",
          description: text(item.description, 500) ?? "",
          missing: nonNegativeInteger(item.missing),
        }))
        .filter((item) => item.claimId || item.description)
    : [];
  const topSources = Array.isArray(value.topSources)
    ? value.topSources
        .filter(isRecord)
        .slice(0, 8)
        .map((item) => ({
          id: text(item.id, 200) ?? "",
          title: text(item.title, 300) ?? "",
          status: text(item.status, 40) ?? "",
          ...(text(item.url, 2_000) ? { url: text(item.url, 2_000) } : {}),
        }))
        .filter((item) => item.id || item.title)
    : [];
  return {
    candidateCount: nonNegativeInteger(value.candidateCount),
    usableCount: nonNegativeInteger(value.usableCount),
    unusableCount: nonNegativeInteger(value.unusableCount),
    rejectedCount: nonNegativeInteger(value.rejectedCount),
    proofDebtMissing: nonNegativeInteger(value.proofDebtMissing),
    proofDebtItems,
    topSources,
  };
}

function recordEntries(value: unknown): [string, unknown][] {
  return isRecord(value) ? Object.entries(value) : [];
}

function inferMode(participants: Record<string, AgentParticipant>): OrchestrationMode {
  const roles = Object.values(participants).map((item) => item.role);
  if (roles.includes("code_worker")) return "code_team";
  if (roles.includes("researcher")) return "research_team";
  return "single";
}

function normalizeNodeStatus(value: unknown): WorkNodeStatus {
  const direct = enumValue(value, NODE_STATUSES);
  if (direct) return direct;
  if (value === "pending") return "queued";
  if (value === "in_progress" || value === "needs_verification") return "running";
  return "queued";
}

function roleLabel(role: AgentRole): string {
  return role === "lead" ? "Lead" : role === "researcher" ? "Researcher" : "Code Worker";
}

function strings(value: unknown, limit: number): string[] {
  return unique(
    (Array.isArray(value) ? value : [])
      .map(safeId)
      .filter((item): item is string => Boolean(item))
      .slice(0, limit),
  );
}

function plainStrings(value: unknown, limit: number, maxLength: number): string[] {
  return unique(
    (Array.isArray(value) ? value : [])
      .map((item) => text(item, maxLength))
      .filter((item): item is string => Boolean(item))
      .slice(0, limit),
  );
}

function safeId(value: unknown): string | undefined {
  const id = text(value, 200);
  if (!id || id === "__proto__" || id === "prototype" || id === "constructor") return undefined;
  return id;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function timestamp(value: unknown, fallback: string): string {
  return timestampOptional(value) ?? fallback;
}

function timestampOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODES = ["single", "research_team", "code_team"] as const satisfies readonly OrchestrationMode[];
const RUN_STATUSES = ["running", "complete", "blocked", "cancelled", "failed"] as const satisfies readonly OrchestratorRunStatus[];
const NODE_KINDS = ["mission", "research", "code", "handoff", "merge", "verify"] as const satisfies readonly WorkNodeKind[];
const NODE_STATUSES = ["queued", "ready", "running", "waiting", "blocked", "complete", "cancelled"] as const satisfies readonly WorkNodeStatus[];
const AGENT_ROLES = ["lead", "researcher", "code_worker"] as const satisfies readonly AgentRole[];
const PARTICIPANT_STATUSES = ["queued", "planning", "researching", "coding", "waiting", "handoff", "merging", "verifying", "complete", "blocked", "cancelled", "failed"] as const satisfies readonly AgentParticipantStatus[];
const HANDOFF_AGENT_STATUSES = ["none", "preparing", "ready", "accepted", "rejected"] as const satisfies readonly AgentHandoffStatus[];
const WORKTREE_STATUSES = ["planned", "creating", "ready", "editing", "testing", "green", "failed", "integrating", "merged", "promotion_blocked", "retained"] as const satisfies readonly GitWorktreeStatus[];
const HANDOFF_STATUSES = ["preparing", "ready", "accepted", "rejected"] as const satisfies readonly WorkerHandoffStatus[];
const CONFIDENCES = ["low", "medium", "high"] as const satisfies readonly HandoffConfidence[];
const MERGE_STATUSES = ["idle", "running", "complete", "blocked"] as const satisfies readonly MergeStatus[];
const VERIFICATION_STATUSES = ["pending", "passed", "failed", "blocked"] as const satisfies readonly VerificationStatus[];
const INTEGRATION_STATUSES = ["not_applicable", "pending", "ready", "integrating", "merged", "promotion_blocked", "failed"] as const satisfies readonly IntegrationStatus[];
