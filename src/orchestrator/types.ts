export const ORCHESTRATOR_SNAPSHOT_VERSION = 1 as const;

/** The active runtime has one Lead and, when needed, one Adaptive Specialist. */
export type OrchestrationModeV2 = "single" | "adaptive_team";

/**
 * Persisted preview snapshots used these names before the Adaptive Specialist
 * contract existed. They remain readable, but new runtimes must use
 * `adaptive_team`.
 */
export type LegacyOrchestrationModeV1 = "research_team" | "code_team";
export type OrchestrationMode =
  | OrchestrationModeV2
  | LegacyOrchestrationModeV1;

export type OrchestratorRunStatus =
  | "running"
  | "complete"
  | "blocked"
  | "cancelled"
  | "failed";

export type WorkNodeStatus =
  | "queued"
  | "ready"
  | "running"
  | "waiting"
  | "blocked"
  | "complete"
  | "cancelled";

export type WorkNodeKind =
  | "mission"
  | "research"
  | "code"
  | "handoff"
  | "merge"
  | "verify";

export type AgentRoleV2 = "lead" | "specialist";
export type LegacyAgentRoleV1 = "researcher" | "code_worker";
export type AgentRole = AgentRoleV2 | LegacyAgentRoleV1;

/** One second participant changes modes; these are not extra agent identities. */
export type SpecialistMode =
  | "researcher"
  | "linear_planner"
  | "code_builder"
  | "code_reviewer"
  | "recovery_verifier";

export type AgentParticipantStatus =
  | "queued"
  | "planning"
  | "researching"
  | "coding"
  | "waiting"
  | "handoff"
  | "merging"
  | "verifying"
  | "complete"
  | "blocked"
  | "cancelled"
  | "failed";

export type AgentHandoffStatus =
  | "none"
  | "preparing"
  | "ready"
  | "accepted"
  | "rejected";

export interface BudgetCounter {
  used: number;
  limit: number;
}

export interface AgentParticipantBudget {
  modelSteps: BudgetCounter;
  toolCalls: BudgetCounter;
  wallClockMs: BudgetCounter;
}

export interface AgentParticipant {
  id: string;
  role: AgentRole;
  displayName: string;
  status: AgentParticipantStatus;
  currentNodeId: string | null;
  budget: AgentParticipantBudget;
  lastAction?: string;
  handoffStatus: AgentHandoffStatus;
  startedAt?: string;
  updatedAt: string;
  blocker?: string;
  /** Present only for the Adaptive Specialist participant. */
  specialistMode?: SpecialistMode;
  /** Durable one-cycle repair accounting; never grants tool authority. */
  repairState?: SpecialistRepairStateV2;
}

export interface OrchestratorProofContract {
  requiredEvidenceKinds: string[];
  minEvidenceCount: number;
  requiredReceiptKinds: string[];
  verifierIds: string[];
}

export interface OrchestratorWorkNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  kind: WorkNodeKind;
  title: string;
  status: WorkNodeStatus;
  ownerId: string | null;
  dependencyIds: string[];
  evidenceIds: string[];
  receiptIds: string[];
  artifactIds: string[];
  proofContract?: OrchestratorProofContract;
  worktreeId?: string;
  lastAction?: string;
  resultSummary?: string;
  blocker?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type GitWorktreeStatus =
  | "planned"
  | "creating"
  | "ready"
  | "editing"
  | "testing"
  | "green"
  | "failed"
  | "integrating"
  | "merged"
  | "promotion_blocked"
  | "retained";

export interface GitWorktreeState {
  id: string;
  taskId: string;
  repositoryRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  status: GitWorktreeStatus;
  changedFiles: number;
  changedFilePaths?: string[];
  validationCommands: string[];
  validationPassed: boolean;
  currentValidationCommand?: string;
  commitSha?: string;
  blocker?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type WorkerHandoffStatus =
  | "preparing"
  | "ready"
  | "accepted"
  | "rejected";

export type HandoffConfidence = "low" | "medium" | "high";

export interface WorkerHandoff {
  id: string;
  fromParticipantId: string;
  toParticipantId: string;
  taskId: string;
  status: WorkerHandoffStatus;
  summary: string;
  sourceIds: string[];
  evidenceIds: string[];
  unresolvedQuestions: string[];
  confidence: HandoffConfidence;
  stopReason?: string;
  commitSha?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpecialistProofReferencesV2 {
  evidenceIds: string[];
  receiptIds: string[];
  artifactIds: string[];
  validationIds: string[];
}

/**
 * Proof-bearing handoff from the one Adaptive Specialist to the Lead.
 * MissionGraph remains authoritative: these references are claims for the host
 * to resolve against the graph and receipt stores, not proof by themselves.
 */
export interface SpecialistHandoffV2 extends WorkerHandoff {
  schemaVersion: 2;
  fromParticipantId: "specialist";
  toParticipantId: "lead";
  missionGraphId: string;
  specialistMode: SpecialistMode;
  inputFingerprint: string;
  progressFingerprint: string;
  acceptanceCriteria: string[];
  proofReferences: SpecialistProofReferencesV2;
  changedFiles: string[];
  conflicts: string[];
  limitations: string[];
  recommendedNextAction: string;
  workspaceLeaseId?: string;
  workspaceDiffFingerprint?: string;
  repairCycle: 0 | 1;
}

export interface SpecialistRepairStateV2 {
  schemaVersion: 2;
  cyclesUsed: 0 | 1;
  status: "idle" | "authorized" | "exhausted";
  failedProgressFingerprint?: string;
  priorApproachFingerprint?: string;
  revisedApproachFingerprint?: string;
}

export type MergeStatus = "idle" | "running" | "complete" | "blocked";

export type VerificationStatus = "pending" | "passed" | "failed" | "blocked";

export type IntegrationStatus =
  | "not_applicable"
  | "pending"
  | "ready"
  | "integrating"
  | "merged"
  | "promotion_blocked"
  | "failed";

export interface MergeSummary {
  status: MergeStatus;
  evidenceReceived: number;
  evidenceAccepted: number;
  evidenceRejected: number;
  evidenceDeduplicated: number;
  conflicts: number;
  commitShas: string[];
  verificationStatus: VerificationStatus;
  integrationStatus: IntegrationStatus;
  blocker?: string;
  updatedAt?: string;
}

/** Compact source-ledger + proof-debt projection for Orchestrator UI. */
export interface SourceLedgerSummary {
  candidateCount: number;
  usableCount: number;
  unusableCount: number;
  rejectedCount: number;
  proofDebtMissing: number;
  proofDebtItems: Array<{
    claimId: string;
    description: string;
    missing: number;
  }>;
  topSources: Array<{
    id: string;
    title: string;
    status: string;
    url?: string;
  }>;
}

export interface OrchestratorSnapshotV1 {
  version: typeof ORCHESTRATOR_SNAPSHOT_VERSION;
  runId: string;
  mode: OrchestrationMode;
  status: OrchestratorRunStatus;
  rootNodeIds: string[];
  nodes: Record<string, OrchestratorWorkNode>;
  participants: Record<string, AgentParticipant>;
  worktrees: Record<string, GitWorktreeState>;
  handoffs: WorkerHandoff[];
  merge: MergeSummary;
  sourceLedgerSummary?: SourceLedgerSummary;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorEventBase {
  runId: string;
  sequence: number;
  occurredAt: string;
}

export interface OrchestratorStartedEvent extends OrchestratorEventBase {
  kind: "orchestrator_started";
  mode: OrchestrationMode;
  participants?: AgentParticipant[];
  rootNodes?: OrchestratorWorkNode[];
}

export interface ParticipantRegisteredEvent extends OrchestratorEventBase {
  kind: "participant_registered";
  participant: AgentParticipant;
}

export interface ParticipantUpdatedEvent extends OrchestratorEventBase {
  kind: "participant_updated";
  participantId: string;
  patch: Partial<Omit<AgentParticipant, "id" | "role">>;
}

export interface NodeCreatedEvent extends OrchestratorEventBase {
  kind: "node_created";
  node: OrchestratorWorkNode;
}

export interface NodeAssignedEvent extends OrchestratorEventBase {
  kind: "node_assigned";
  nodeId: string;
  ownerId: string;
}

export interface NodeProgressedEvent extends OrchestratorEventBase {
  kind: "node_progressed";
  nodeId: string;
  status?: WorkNodeStatus;
  lastAction?: string;
  evidenceIds?: string[];
  receiptIds?: string[];
  artifactIds?: string[];
  resultSummary?: string;
  blocker?: string;
}

export interface NodeCompletedEvent extends OrchestratorEventBase {
  kind: "node_completed";
  nodeId: string;
  resultSummary?: string;
}

export interface NodeBlockedEvent extends OrchestratorEventBase {
  kind: "node_blocked";
  nodeId: string;
  blocker: string;
}

export interface NodeCancelledEvent extends OrchestratorEventBase {
  kind: "node_cancelled";
  nodeId: string;
  reason?: string;
}

export interface EvidenceAddedEvent extends OrchestratorEventBase {
  kind: "evidence_added";
  nodeId: string;
  evidenceId: string;
}

export interface WorktreeUpdatedEvent extends OrchestratorEventBase {
  kind: "worktree_updated";
  worktree: GitWorktreeState;
}

export interface HandoffReadyEvent extends OrchestratorEventBase {
  kind: "handoff_ready";
  handoff: WorkerHandoff;
}

export interface HandoffUpdatedEvent extends OrchestratorEventBase {
  kind: "handoff_updated";
  handoffId: string;
  status: WorkerHandoffStatus;
  summary?: string;
}

export interface MergeStartedEvent extends OrchestratorEventBase {
  kind: "merge_started";
}

export interface MergeUpdatedEvent extends OrchestratorEventBase {
  kind: "merge_updated";
  patch: Partial<MergeSummary>;
}

export interface MergeCompletedEvent extends OrchestratorEventBase {
  kind: "merge_completed";
  summary: MergeSummary;
}

export interface VerificationUpdatedEvent extends OrchestratorEventBase {
  kind: "verification_updated";
  status: VerificationStatus;
  blocker?: string;
}

export interface OrchestratorRunCompletedEvent extends OrchestratorEventBase {
  kind: "run_completed";
  status: Exclude<OrchestratorRunStatus, "running">;
  summary?: string;
}

export type OrchestratorEvent =
  | OrchestratorStartedEvent
  | ParticipantRegisteredEvent
  | ParticipantUpdatedEvent
  | NodeCreatedEvent
  | NodeAssignedEvent
  | NodeProgressedEvent
  | NodeCompletedEvent
  | NodeBlockedEvent
  | NodeCancelledEvent
  | EvidenceAddedEvent
  | WorktreeUpdatedEvent
  | HandoffReadyEvent
  | HandoffUpdatedEvent
  | MergeStartedEvent
  | MergeUpdatedEvent
  | MergeCompletedEvent
  | VerificationUpdatedEvent
  | OrchestratorRunCompletedEvent;
