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
import type { ProjectLineageV1 } from "../agent/projectLifecycle";

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

export interface ToolExecutionContext {
  app: App;
  settings: AgentSettings;
  originalPrompt: string;
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
  userApprovalGranted?: boolean;
  /** Exact grant binding for descriptor-aware prepared action execution. */
  authorizedAction?: AuthorizedActionContext;
  writeAutonomy?: boolean;
  /** When true, rename_current_file may run without explicit title-intent language. */
  autoTitleAuthorized?: boolean;
  missionIntent?: MissionIntent;
  now?: () => Date;
  getCurrentMarkdownFile?: () => TFile | null;
  getCurrentMarkdownContent?: (file: TFile) => string | null;
  setCurrentMarkdownContent?: (file: TFile, content: string) => boolean;
  getResearchMemoryIndex?: () => ResearchMemoryIndexEntry[];
  setResearchMemoryIndex?: (
    entries: ResearchMemoryIndexEntry[],
  ) => Promise<void> | void;
  /** Host-validated project lineage used to bind downstream provider reads. */
  getProjectLineages?: () => ProjectLineageV1[];
  semanticEmbeddingProvider?: SemanticEmbeddingProvider;
  semanticIndexService?: SemanticIndexService;
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
   * Bounded, run-local workspace reads used to bind a later exact-path write to
   * the host-observed SHA even when model-visible tool messages are compacted.
   * These observations are never used to skip a fresh tool execution.
   */
  verifiedWorkspaceReads?: Map<string, VerifiedWorkspaceReadObservation>;
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
