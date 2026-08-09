import type { App, TFile } from "obsidian";
import type { AgentSettings } from "../settings";
import type {
  HttpTransport,
  JsonSchemaObject,
  ModelToolCall,
  ModelToolDefinition,
} from "../model/types";
import type { AutonomyScope } from "../agent/missionScope";
import type { SemanticEmbeddingProvider } from "../embeddings/types";
import type { SemanticIndexService } from "../embeddings/semanticIndexTypes";
import type {
  ActionReceipt,
  ActionReconciliationResult,
  AuthorizedActionContext,
  PreparedAction,
  PreparedActionResult,
  ToolDescriptor,
} from "../agent/actions";
import type { ClarificationOutcome } from "../agent/clarificationBroker";
import type { ProjectLineageV1 } from "../agent/projectLifecycle";
import type { ToolOutcomeMemoryV1 } from "../agent/outcomeMemory";
import type { CapabilityReadinessV2 } from "../agent/capabilityReadiness";

export type AgentMissionMode =
  | "chat_only"
  | "vault_context_answer"
  | "note_output"
  | "explicit_file_mutation"
  | "explicit_delete";

export interface MissionIntent {
  mode: AgentMissionMode;
  vaultContext: boolean;
  noteOutput: boolean;
  explicitPersistence: boolean;
  explicitMutation: boolean;
  explicitDelete: boolean;
  allowAutonomousWrite: boolean;
  requireWriteCompletion: boolean;
  autonomyScope: AutonomyScope;
}

export interface ResearchMemoryIndexEntry {
  /** V2 metadata is additive so existing vault-local indexes remain readable. */
  version?: 2;
  id?: string;
  vaultScopeId?: string;
  origin?: "vault_local";
  sourceLabels?: ResearchMemorySourceLabelV2[];
  createdAt?: string;
  fingerprint?: string;
  topic: string;
  path: string;
  keywords: string[];
  lastUpdated: string;
  confidence?: "low" | "medium" | "high";
  sourcePaths?: string[];
  sourceUrls?: string[];
  contentHash?: string;
  updateCount?: number;
  targetId?: string;
  verificationState?: "unverified" | "verified" | "stale" | "superseded";
  verifiedAt?: string;
  staleAt?: string;
  supersededAt?: string;
  supersededById?: string;
  sourceHashes?: Record<string, string>;
}

export interface ResearchMemorySourceLabelV2 {
  kind: "note" | "public_url" | "receipt";
  reference: string;
  label?: string;
}

export interface ResearchMemoryRecordV2 extends ResearchMemoryIndexEntry {
  version: 2;
  id: string;
  vaultScopeId: string;
  origin: "vault_local";
  sourceLabels: ResearchMemorySourceLabelV2[];
  createdAt: string;
  fingerprint: string;
  verificationState: "unverified" | "verified" | "stale" | "superseded";
}

export interface VerifiedLinearCodeRepositoryBindingV1 {
  version: 1;
  repositoryProfileKey: string;
  issueId: string;
  issueIdentifier: string;
  publicationId: string;
  workItemFingerprint: string;
  acceptedResearchArtifactFingerprint: string;
  originRunId: string;
}

export type VerifiedLinearCodeRepositoryBindingResolutionV1 =
  | {
      status: "verified";
      binding: VerifiedLinearCodeRepositoryBindingV1;
    }
  | {
      status: "not_applicable" | "rejected";
      code: string;
      reason: string;
    };

export interface ToolExecutionContext {
  app: App;
  settings: AgentSettings;
  originalPrompt: string;
  /**
   * Set by the runner when a research plan is active and its fetched-source
   * floor has been met, certifying that `create_research_pack` may run without
   * the user having named a "research pack" in their prompt. Never set from a
   * model argument — it is a host judgment about the run, not a tool input.
   */
  researchPackEligible?: boolean;
  runId?: string;
  /** Host-verified durable root shared by continuation segments. */
  rootMissionId?: string;
  operationId?: string;
  abortSignal?: AbortSignal;
  /** Absolute Unix timestamp in milliseconds after which the operation should stop. */
  deadlineAt?: number;
  httpTransport: HttpTransport;
  runtimeCache?: AgentRuntimeCache;
  reportProgress?: (message: string) => void;
  reportCodeOutput?: (event: {
    runId: string;
    stream: "stdout" | "stderr";
    chunk: string;
  }) => void;
  /**
   * A tool-owned multi-stage workflow may request a fingerprint-bound approval
   * only through this host callback. AgentRunner wires it to the same broker,
   * UI events, ledger, and abort signal as ordinary tool approvals.
   */
  requestNestedApproval?: (
    request: NestedToolApprovalRequest,
  ) => Promise<NestedToolApprovalDecision>;
  /**
   * Ask the user one clarifying question and wait for an answer. Absent on
   * non-interactive hosts (headless, e2e), where `ask_user` proceeds on its
   * stated assumption instead of hanging. An answer is intent, never authority:
   * it can never substitute for an approval.
   */
  requestUserClarification?: (request: {
    question: string;
    options: string[];
    context?: string;
  }) => Promise<ClarificationOutcome>;
  userApprovalGranted?: boolean;
  /** Exact grant binding for descriptor-aware prepared action execution. */
  authorizedAction?: AuthorizedActionContext;
  writeAutonomy?: boolean;
  /** When true, rename_current_file may run without explicit title-intent language. */
  autoTitleAuthorized?: boolean;
  missionIntent?: MissionIntent;
  /**
   * Exact host-allocated destination for automatic new-note output. This is
   * run authority, never a model-selected path, and may only be consumed by a
   * matching no-overwrite create_file call.
   */
  plannedNoteOutputPath?: string;
  now?: () => Date;
  getCurrentMarkdownFile?: () => TFile | null;
  getCurrentMarkdownContent?: (file: TFile) => string | null;
  setCurrentMarkdownContent?: (
    file: TFile,
    content: string,
    options?: { followStreamingEnd?: boolean },
  ) => boolean;
  getResearchMemoryIndex?: () => ResearchMemoryIndexEntry[];
  setResearchMemoryIndex?: (
    entries: ResearchMemoryIndexEntry[],
  ) => Promise<void> | void;
  /**
   * Cross-run tool outcome ledger. Absent on hosts that do not persist it, in
   * which case the runner keeps a run-local ledger and simply learns nothing
   * across runs — the pre-existing behavior.
   */
  getToolOutcomeMemory?: () => ToolOutcomeMemoryV1 | null;
  setToolOutcomeMemory?: (
    memory: ToolOutcomeMemoryV1,
  ) => Promise<void> | void;
  /** Host-validated project lineage used to bind downstream provider reads. */
  getProjectLineages?: () => ProjectLineageV1[];
  /**
   * Trusted repository profile keys from the plugin registry. Used to host-bind
   * `code_workspace_create` when the mission names exactly one of them.
   */
  getRepositoryProfileKeys?: () => readonly string[];
  /**
   * Resolve a provider-read Linear issue into repository authority only when
   * its signed WorkItemSpecV2 agrees with the host's completed publication
   * checkpoint, accepted-note lineage, external binding, and trusted registry.
   */
  resolveVerifiedLinearCodeRepositoryBinding?: (
    issueRecord: Record<string, unknown>,
  ) => Promise<VerifiedLinearCodeRepositoryBindingResolutionV1>;
  /**
   * Current run's host-verified Linear-to-repository authority. Publication
   * code may read this binding, but model tool arguments can never supply it.
   */
  getVerifiedLinearCodeRepositoryBinding?: () =>
    VerifiedLinearCodeRepositoryBindingV1 | null;
  /** Fresh host-owned readiness evidence for pre-model capability blockers. */
  getCapabilityReadiness?: () => readonly CapabilityReadinessV2[];
  semanticEmbeddingProvider?: SemanticEmbeddingProvider;
  semanticIndexService?: SemanticIndexService;
  /** Optional run-scoped flags for set-loose compound autonomy. */
  runFlags?: {
    compoundLifecycleDetected?: boolean;
  };
}

export interface ToolExecutionResult {
  ok: boolean;
  toolName: string;
  output?: unknown;
  receipt?: ActionReceipt;
  mutationState?:
    | "not_applied"
    | "applied"
    | "may_have_applied"
    | "unknown";
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface NestedToolApprovalRequest {
  toolName: string;
  action: string;
  reason: string;
  policyTags: string[];
  /**
   * Approval-display carrier only. AgentRunner sends it to ApprovalBroker/UI
   * and never to ToolRegistry.prepare/executePrepared.
   */
  preparedAction?: PreparedAction;
  timeoutMs?: number;
  confirmationIndex?: number;
  requiredConfirmations?: 1 | 2;
}

export type NestedToolApprovalDecision =
  | {
      approved: true;
      approvalId: string;
      approvalFingerprint: string;
    }
  | {
      approved: false;
      reason: "denied" | "expired" | "aborted";
    };

export interface AgentRuntimeCache {
  toolResults: Map<string, ToolExecutionResult>;
  /** Successful strong-hash web reads retained for proof-bound downstream tools. */
  trustedWebFetchResults?: Map<string, ToolExecutionResult>;
  /**
   * Latest exact Mermaid block read retained for the immediately dependent
   * hash-bound upsert. The observation survives transcript compaction and is
   * cleared after a successful mutation.
   */
  verifiedMermaidRead?: VerifiedMermaidReadObservation;
  /**
   * Bounded, run-local workspace reads used to bind a later exact-path write to
   * the host-observed SHA even when model-visible tool messages are compacted.
   * These observations are never used to skip a fresh tool execution.
   */
  verifiedWorkspaceReads?: Map<string, VerifiedWorkspaceReadObservation>;
  /**
   * Latest already-redacted fast-validation excerpt for the active segment.
   * The cache itself is never serialized; a continuation may rehydrate it only
   * from a canonical committed receipt with verified readback so compaction or
   * restart cannot remove the evidence needed by the next bounded repair turn.
   */
  latestFastValidationDiagnostic?: CodeValidationDiagnosticObservation;
  /**
   * Set when code_repair_record_cycle records outcome "passed" for a fast
   * validation. Set-loose Soft-union uses this to withhold code_commit_verified
   * until a durable passing fast cycle exists.
   */
  passedFastRepairCycle?: boolean;
  /** First validated accepted-research request for a run/path; retries cannot rewrite it. */
  acceptedResearchPublicationRequests?: Map<string, unknown>;
  semanticProfiles?: Map<string, unknown>;
  graphProfiles?: Map<string, unknown>;
}

export interface VerifiedWorkspaceReadObservation {
  workspaceId: string;
  path: string;
  sha256: string;
  content: string;
}

export interface VerifiedMermaidReadObservation {
  path: string;
  sha256: string;
  selector: Record<string, unknown>;
}

export interface CodeValidationDiagnosticObservation {
  stdout: string;
  stderr: string;
  truncated: boolean;
  redactedLines: number;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  descriptor?: ToolDescriptor;
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown>;
  /** Optional direct result path for composite tools that own a verified receipt. */
  executeResult?(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  prepare?(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<PreparedActionResult>;
  executePrepared?(
    action: PreparedAction,
    context: ToolExecutionContext,
  ): Promise<AgentToolActionExecution>;
  reconcile?(
    action: PreparedAction,
    context: ToolExecutionContext,
  ): Promise<ActionReconciliationResult>;
}

export interface AgentToolActionExecution {
  output?: unknown;
  receipt: ActionReceipt;
  mutationState: "applied";
}

export class ToolExecutionError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly mutationState?: ToolExecutionResult["mutationState"];

  constructor(
    code: string,
    message: string,
    options: {
      details?: Record<string, unknown>;
      mutationState?: ToolExecutionResult["mutationState"];
    } = {},
  ) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.details = options.details;
    this.mutationState = options.mutationState;
  }
}

export interface ToolRegistry {
  getDefinitions(): ModelToolDefinition[];
  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  /** Phase-0 additive API: optional so legacy registry mocks stay valid. */
  getDescriptor?(toolName: string): ToolDescriptor | null;
  prepare?(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<PreparedActionResult>;
  executePrepared?(
    action: PreparedAction,
    context: ToolExecutionContext,
    authorization?: AuthorizedActionContext,
  ): Promise<ToolExecutionResult>;
  reconcile?(
    action: PreparedAction,
    context: ToolExecutionContext,
  ): Promise<ActionReconciliationResult>;
}
