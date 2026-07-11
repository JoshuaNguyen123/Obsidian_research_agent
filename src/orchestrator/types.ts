export const ORCHESTRATOR_SNAPSHOT_VERSION = 1 as const;

export type OrchestrationMode = "single" | "research_team" | "code_team";

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

export type AgentRole = "lead" | "researcher" | "code_worker";

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

