import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatMessage,
  ModelClient,
  ModelChatStreamEvents,
  ModelToolCall,
  ModelToolDefinition,
  ModelRequestOptions,
  ModelThink,
} from "./model/types";
import { ModelClientError } from "./model/types";
import { appendToolTranscript } from "./model/toolTranscript";
import { serializeToolResultForModel } from "./model/toolResultPayload";
import { isTransientModelError, withModelRetry } from "./model/retry";
import {
  approvalDeniedFailureCopy,
  formatAcceptanceFailureCopy,
  formatFailureCopy,
  formatModelFailureCopy,
  formatWebFetchToolFailureCopy,
  modelTimeoutFailureCopy,
  phaseGateFailureCopy,
  policyBlockFailureCopy,
  providerAuthFailureCopy,
  semanticCoverageSecondPassCopy,
  walReconcileFailureCopy,
} from "./agent/failureCopy";
import type {
  AgentMissionMode,
  AgentRuntimeCache,
  MissionIntent,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./tools/types";
import {
  BACKUP_FOLDER,
  CHECKPOINT_EVERY_STEPS,
  LONG_RUN_STEP_WARN_AT,
  MISSION_MILESTONE_STEPS,
  MAX_AGENT_STEPS,
  MAX_INITIAL_CURRENT_NOTE_CHARS,
  PROGRESS_REVIEW_EVERY_STEPS,
  MAX_PARALLEL_TOOL_CALLS,
  READ_ONLY_TOOL_NAMES,
} from "./tools/constants";
import {
  getErrorMessage,
  normalizeVaultPath,
  serializeToolResult,
} from "./tools/validation";
import {
  type AgentConversationMessage,
} from "./conversationHistory";
import { countMarkdownVisibleText } from "./tools/wordCount";
import {
  assertEnglishOnlyOutput,
  buildEnglishOnlyRepairPrompt,
  inspectEnglishOnlyOutput,
} from "./languageGuard";
import {
  estimateLoopBudget,
  resolveConfiguredMaxAgentSteps,
} from "./agent/runBudget";
import { planReadOnlyFollowups } from "./agent/autoFollowups";
import {
  detectLinearIntent,
  hasExplicitPermanentLinearDeleteIntent,
} from "./agent/linearIntent";
import {
  decideAutoContinuation,
  type AutoContinuationDecision,
  type AutoContinuationReason,
} from "./agent/autoContinuation";
import { reflectMissionCompletion } from "./agent/completionReflection";
import { runDependencyPreflight } from "./agent/dependencyPreflight";
import { evaluatePerformanceGates, type PerformanceGateResult } from "./agent/performanceGates";
import {
  analyzeGeneratedOutputPrompt,
} from "./agent/generatedOutputPolicy";
import {
  analyzeCurrentNoteResetPrompt,
  isCurrentNoteReplaceResetPrompt,
} from "./agent/currentNoteResetPolicy";
import { planLoopBudget } from "./agent/loopPlanner";
import {
  applyResearchPhaseToLoopDecision,
  decideNextLoopAction,
  type LoopLedger,
} from "./agent/loopDecision";
import {
  createRunPlan,
  resolveThinkingMode,
  type RunPlan,
  type RunPlanDecision,
  type RunRoute,
  type SlowPathReason,
  type StreamingWritebackKind,
} from "./agent/runPlan";
import {
  deriveAutonomyScope,
  isBroadUnscopedVaultMutation,
  type AutonomyScope,
} from "./agent/missionScope";
import {
  addLedgerBlocker,
  addLedgerReceipt,
  addMissionMilestone,
  createMissionLedger,
  markLedgerResumeLoaded,
  markLedgerToolUsed,
  addLedgerApproval,
  setLedgerDependencyStatus,
  setLedgerMissionPlan,
  setLedgerResearchPlan,
  setLedgerNextAction,
  setLedgerAcceptance,
  setLedgerClaimLedger,
  setLedgerClaimPassages,
  setLedgerEvidenceConflicts,
  setLedgerLastSafeStep,
  setLedgerWallClockExpired,
  summarizeMissionLedger,
  updateMissionLedgerStatus,
  upsertLedgerEvidence,
  upsertMissionEvidenceRecord,
  writeMissionLedger,
  type MissionLedger,
  type MissionLedgerStatus,
  type MissionLedgerSummary,
  type MissionBlockerCategory,
  type MissionDependencyStatus,
} from "./agent/missionLedger";
import {
  ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
} from "./agent/approvalBroker";
import {
  createRunContextBudget,
  estimatePromptChars,
  shouldCompactLoopMessages,
  compactLoopMessages,
} from "./agent/runContext";
import {
  evidenceFromReceipt,
  evidenceFromToolResult,
  claimPassagesFromToolResult,
  upsertClaimPassageRefs,
} from "./agent/missionEvidence";
import { retitleNoteMarkdown } from "./tools/noteTitles";
import {
  buildMissionResumeContext,
  extractRequestedRunId,
  hasMissionResumeIntent,
  type MissionResumeContext,
} from "./agent/missionResume";
import {
  formatMissionAcceptanceCorrection,
  mergeClaimGroundingIntoAcceptance,
  type MissionAcceptanceResult,
} from "./agent/missionAcceptance";
import {
  isCurrentNoteEditOrganizeIntent,
  isNamedSectionEditIntent,
  isVaultWideOrganizeIntent,
  isWholeNoteEditIntent,
  missingIncludesWriteReceipt,
  prefersStreamedReplaceForEditOrganize,
} from "./agent/editOrganizeIntent";
import {
  evaluateMissionPlanAcceptance,
} from "./agent/missionPlanAcceptance";
import {
  mergeVerificationIntoAcceptance,
  runMissionVerifiers,
  type VerificationCheck,
} from "./agent/verifiers";
import {
  type ClaimLedger,
  type ClaimPassageRef,
  shouldRequireClaimGrounding,
} from "./agent/claimLedger";
import {
  detectEvidenceConflicts,
  evidenceConflictsToProofDebtRows,
  listOpenEvidenceConflicts,
  mergeEvidenceConflicts,
  type EvidenceConflict,
} from "./agent/evidenceConflicts";
import {
  buildResearchPhaseTransition,
  deriveResearchPhase,
  gateAcceptanceByResearchPhase,
  type ResearchPhaseDescriptor,
  type ResearchRunPhase,
} from "./agent/researchPhaseController";
import {
  countRemainingMissionPlanTasks,
  createMissionPlan,
  getActiveMissionPlanTask,
  getNextMissionPlanAction,
  isToolAllowedForActiveMissionTask,
  isMissionPlanComplete,
  type MissionPlan,
  type MissionPlanProofKind,
} from "./agent/missionPlan";
import {
  advanceMissionPlanFromAcceptance,
  advanceMissionPlanFromBlocker,
  advanceMissionPlanFromFinalOutput,
  advanceMissionPlanFromReceipt,
  advanceMissionPlanFromToolResult,
} from "./agent/missionPlanAdvance";
import {
  applyRecoveryToPlan,
  createRecoveryState,
  decideRecoveryAction,
  planRecovery,
  type RecoveryAttempt,
  type RecoveryState,
} from "./agent/recoveryEngine";
import {
  beginVaultTransaction,
  commitVaultTransaction,
  recordTransactionStage,
  type VaultMutationTransaction,
} from "./agent/vaultTransactions";
import {
  buildContinuationMemoryBundle,
  formatContinuationBundleForPrompt,
  recordContinuationLoad,
} from "./agent/continuationMemory";
import {
  formatMissionPlanForPrompt,
  formatMissionPlanNextActionPrompt,
} from "./agent/missionPlanPrompts";
import {
  applyResearchEvidence,
  createResearchPlan,
  formatResearchPlanForPrompt,
  type ResearchPlan,
} from "./agent/researchPlan";
import {
  isExplicitVisibleFileRenameIntent,
  isMarkdownTitleContentIntent,
  isPlaceholderNoteBasename,
  isTitleOnlyIntent,
  isVisibleTitleRenameIntent,
} from "./agent/titleIntent";
import { maybeAutoTitleAfterWrite } from "./agent/autoTitleOnWrite";
import type { PlaceholderRenameReceipt } from "./agent/placeholderNoteTitle";
import {
  createAutonomousNoteTarget,
  resolveAutonomousNoteTarget,
} from "./agent/autonomousNoteTarget";
import {
  noteOutputPlanAllowsVaultWrite,
  resolveNoteOutputPlan,
  type NoteOutputPlan,
  type OutputProfile,
} from "./agent/noteOutputPolicy";
import { hasReviseDesignIntent } from "./agent/codeDesignIntent";
import {
  classifyMissionWithModel,
  resolveModelRouterMode,
  type RoutedMissionIntent,
} from "./agent/missionRouter";
import {
  deriveRoutedIntentFallback,
  evaluateToolPolicy,
  resolvePolicyRoutedIntent,
  type PolicyDecision,
} from "./agent/policyEngine";
import type {
  ActionReceipt,
  AuthorizedActionContext,
  PreparedAction,
  ResourceAction,
  ResourceRef,
  ToolDescriptor,
} from "./agent/actions";
import {
  consumeAuthorityGrant,
  createOneShotGrant,
  evaluateAuthorityGrant,
  type AuthorityGrantV1,
} from "./agent/authority";
import { isCodeToolsDesktopRuntime } from "./tools/codeTools";
import { buildResearchMemoryExtraction } from "./agent/researchMemoryExtract";
import { buildHypothesisSystemHintFromIndex } from "./agent/researchHypotheses";
import {
  computeProofDebt,
  proofDebtSnapshotFromLedger,
  proofDebtSnapshotFromRuntime,
} from "./agent/proofDebt";
import {
  classifyStructuredIntent,
  formatStructuredIntentForPrompt,
} from "./agent/intent/structuredIntent";
import {
  appendAgentRunCheckpoint,
  createAgentRunId,
  type LatestAgentRunCheckpoint,
  readAgentRunCheckpointByRunId,
  readLatestAgentRunCheckpoint,
} from "./agent/checkpoints";
import {
  createMissionRuntimeSnapshot,
  buildOperationReconciliationInputs,
  canPersistMissionRuntimeSnapshot,
  createOperationJournalRecord,
  readMissionRuntimeSnapshotByRunId,
  transitionOperationJournalRecord,
  writeMissionRuntimeSnapshot,
  type MissionRuntimeReceipt,
  type MissionRuntimeStatus,
  type MissionRuntimeSnapshotV2,
  type OperationJournalRecord,
} from "./agent/runStore";
import {
  compactConversationForPrompt,
  toCompactedConversationModelMessages,
} from "./memory/contextCompaction";
import { AgenticReflexController } from "./agent/reflex/AgenticReflexController";
import type {
  AgenticReflexOutput,
  AgentTrajectoryEvent,
  ReflexDecision,
} from "./agent/reflex/types";
import type { MissionEvidence } from "./agent/missionLedger";
import type {
  OrchestratorEvent,
  OrchestratorSnapshotV1,
} from "./orchestrator/types";

export { MAX_AGENT_STEPS } from "./tools/constants";
export { resolveThinkingMode } from "./agent/runPlan";
export type { RunPlan, RunRoute, SlowPathReason } from "./agent/runPlan";
export type { AgentConversationMessage } from "./conversationHistory";
export type { AgentMissionMode, MissionIntent } from "./tools/types";

export type AgentRunPhase =
  | "idle"
  | "reading_current_note"
  | "planning"
  | "running_tool"
  | "final_answer"
  | "done"
  | "stopped"
  | "error";

export interface AgentToolRunEvent {
  id: string;
  name: string;
  step: number;
  ok?: boolean;
  message?: string;
  output?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface AgentRunReceipt {
  version?: 1;
  id?: string;
  toolName: string;
  operation:
    | "create"
    | "create_folder"
    | "append"
    | "replace"
    | "edit"
    | "highlight"
    | "restore"
    | "retitle"
    | "rename_current_file"
    | "link_related_notes"
    | "move"
    | "trash"
    | "delete"
    | ResourceAction;
  message: string;
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

export interface AgentRunMetricEvent {
  kind: "model_chat" | "model_stream" | "tool" | "run";
  name: string;
  step?: number;
  durationMs: number;
  cached?: boolean;
  cacheKey?: string;
  savedDurationMs?: number;
  requestChars?: number;
  responseChars?: number;
  inputChars?: number;
  outputChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentRunConfigEvent {
  runId: string;
  model: string;
  base: string;
  streaming: boolean;
  thinkingMode: string;
  resolvedThink: string;
  writebackMode: RunWritebackMode;
  chatOnlyOverride: boolean;
  noteOutputPlan?: NoteOutputPlan;
  route: RunRoute;
  expectedTimeClass: RunPlan["expectedTimeClass"];
  maxStepsForRun: number;
  slowPathReason: SlowPathReason;
  allowedToolNames: string[];
  routeTraceReasons: string[];
  budgetProfile?: RunPlanDecision["budgetProfile"];
  englishGuard: boolean;
  temperature?: number;
  topK?: number;
  topP?: number;
  numCtx?: number;
  estimatedPromptChars?: number;
  contextBudgetChars?: number;
  writeAutonomy: boolean;
  missionMode: AgentMissionMode;
  contextScope: AgentRunContextScope;
  currentNoteContext: boolean;
  vaultContext: boolean;
  maxSteps: number;
  autonomyScope: AutonomyScope;
  missionLedger?: MissionLedgerSummary;
  dependencyStatus: MissionDependencyStatus[];
  performanceGates?: PerformanceGateResult[];
  modelProvider?: string;
  reflexLabel?: string;
  reflexConfidence?: number;
  reflexTopAction?: string;
  reflexProgressScore?: number;
  reflexLoopRisk?: number;
  reflexCompletionMissing?: string[];
  reflexAppliedReason?: string;
}

export interface CodeOutputEvent {
  runId: string;
  stream: "stdout" | "stderr";
  chunk: string;
}

export type StreamLifecycleKind =
  | "stream_started"
  | "stream_connected"
  | "first_raw_chunk"
  | "first_thinking_delta"
  | "first_content_delta"
  | "buffering_safety"
  | "buffering_language"
  | "first_visible_content"
  | "first_note_write";

export interface AgentStreamLifecycleEvent {
  kind: StreamLifecycleKind;
  elapsedMs: number;
  bufferedChars?: number;
  releasedChars?: number;
  message: string;
}

export type RunWritebackMode =
  | "off"
  | "tool_write"
  | "streaming_current_note"
  | "streaming_after_tools";

export type AgentRunContextScope =
  | "none"
  | "current_note"
  | "vault"
  | "vault_and_current_note";

export type AgentTraceKind =
  | "status"
  | "acceptance"
  | "mission_intent"
  | "allowed_tools"
  | "model_call"
  | "tool_start"
  | "tool_result"
  | "tool_rejected"
  | "receipt"
  | "verification"
  | "metric"
  | "final"
  | "phase"
  | "planning"
  | "tool"
  | "error"
  | "complete"
  | "config";

export interface AgentTraceEvent {
  id: string;
  kind: AgentTraceKind;
  step?: number;
  message: string;
  chatId?: string;
  toolName?: string;
  path?: string;
  toPath?: string;
  backupPath?: string;
  operation?: AgentRunReceipt["operation"];
  inputPreview?: unknown;
  outputPreview?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export type AgentRunStopReason =
  | "final"
  | "write_completed"
  | "clarifying_question"
  | "user_stopped"
  | "budget"
  | "error";

export interface AgentRunCompleteEvent {
  step: number;
  maxSteps: number;
  stopReason: AgentRunStopReason;
  autoContinueRecommended?: boolean;
  autoContinueReason?: AutoContinuationReason;
}

export interface AgentRunEvents {
  onStatus?: (message: string) => void;
  onPhaseChange?: (phase: AgentRunPhase, message: string) => void;
  onPlanningStart?: (step: number) => void;
  onPlanningDelta?: (delta: string) => void;
  onPlanningDone?: (step: number) => void;
  onToolStart?: (event: AgentToolRunEvent) => void;
  onToolDone?: (event: AgentToolRunEvent) => void;
  onFinalStart?: () => void;
  onFinalDelta?: (delta: string) => void;
  onFinalReplace?: (content: string) => void;
  onFinalDone?: () => void;
  onReceipt?: (receipt: AgentRunReceipt) => void;
  onAssistantMessageStart?: () => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantReplace?: (content: string) => void;
  onAssistantMessageDone?: () => void;
  onThinkingMessageStart?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onThinkingMessageDone?: () => void;
  onStreamLifecycle?: (event: AgentStreamLifecycleEvent) => void;
  onMetric?: (event: AgentRunMetricEvent) => void;
  onRunConfig?: (event: AgentRunConfigEvent) => void;
  onRunComplete?: (event: AgentRunCompleteEvent) => void;
  onApprovalRequest?: (request: ApprovalRequest) => void | Promise<void>;
  onApprovalResolved?: (event: {
    request: ApprovalRequest;
    decision: ApprovalDecision;
  }) => void | Promise<void>;
  onCodeOutput?: (event: CodeOutputEvent) => void;
  onTrace?: (event: AgentTraceEvent) => void;
  /** Structured operational state only; never model reasoning or hidden prompts. */
  onOrchestratorEvent?: (
    event: OrchestratorEvent,
    snapshot: OrchestratorSnapshotV1,
  ) => void;
}

interface RunAgentMissionOptions {
  prompt: string;
  runId?: string;
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  conversationHistory?: AgentConversationMessage[];
  events?: AgentRunEvents;
  abortSignal?: AbortSignal;
  approvalBroker?: ApprovalBroker;
  /** Per-run UI override that keeps output in chat and suppresses note writes. */
  forceChatOnly?: boolean;
  /** Hard per-invocation cap used by the durable root budget. */
  maxToolCalls?: number;
  /** Optional participant cap used by the orchestrator shared root budget. */
  maxSteps?: number;
  /** Verified worker observations made available to the Lead. */
  seedMissionEvidence?: MissionEvidence[];
  seedClaimPassages?: ClaimPassageRef[];
  orchestratorContext?: string;
  orchestratorSnapshot?: OrchestratorSnapshotV1;
  getOrchestratorSnapshot?: () => OrchestratorSnapshotV1 | null;
}

interface CheckpointResumeState {
  promptContext: string;
  missionResume?: MissionResumeContext;
  runtimeSnapshot?: MissionRuntimeSnapshotV2;
  missingRequestedRunId?: string;
}

const SYSTEM_PROMPT = `You are an agentic research assistant running inside Obsidian.

You may request tools from the provided tool list. The plugin validates and executes tools.

Core loop:
Observe -> Plan -> Act -> Observe -> Write -> Stop.

Operating rules:
1. The plugin may provide current-note context when the mission involves Obsidian notes, vault files, or writeback. Use it before requesting more vault tools.
2. Use web_search only when the user asks for web search, current/recent/latest information, verification, or sources/citations.
3. When citations, sources, verification, or current facts matter, use web_search first, then web_fetch 1-3 strong source URLs before synthesizing. Include source URLs in the final answer.
4. For static writing tasks such as "write/generate a 300 word essay", answer directly without tools unless the user explicitly asks for current information or citations.
5. Treat the active note as structured markdown, not an append-only buffer.
6. Visible Obsidian tab/explorer title equals the markdown filename.
   - Explicit user request to rename/retitle/change the page title: call rename_current_file (visible file rename). Use retitle_current_file only for explicit frontmatter/H1/heading content edits. Never append a second H1 for a title-only request.
   - Ordinary note writeback onto Untitled / Untitled N: do NOT call rename_current_file. Start the written markdown with one leading H1; the plugin renames the file after writeback.
7. For generated note content (append/replace writeback), first line MUST be a single H1 title ("# Short Title"), then a blank line, then the body. Do not duplicate that H1 later. Do not use "# Untitled".
8. Prefer append_to_current_file only for explicit append/add/insert requests that do not replace an existing title or section.
9. For find-and-highlight or mark-where-this-phrase-is requests, use highlight_current_file_phrase. Persistent highlighting means wrapping the matched text in Obsidian markdown ==like this==.
10. Use edit_current_section when the user asks to edit, revise, update, rewrite, or replace a heading section.
11. Use append_to_current_section when the user asks to write, add, append, or insert content below, under, after, or inside a named heading section.
12. Only request replace_current_file when the user explicitly asks to rewrite, replace, clean up, reset, start fresh, overwrite the whole current note, or clear/delete page content and then write new content.
13. Treat whole-note/essay/body/paragraph revision and current-note edit/organize requests as current-note replacement with backup. Use edit_current_section only when the user names a heading or section.
14. Only request delete_current_file when the user explicitly asks to delete, remove, or trash the current note. Treat "delete all notes on the page and write..." as replacing current page content, not trashing the note.
15. Use list_current_folder before broad vault traversal when the mission depends on where the active note lives.
16. Use list_folder and get_path_info to inspect vault folder structure before making path-based file changes.
17. Use path-based CRUD tools only for explicit file or folder create, append, replace, move, rename, delete, remove, or trash requests.
18. For vault context questions, including "what do you know about me", inspect note contents before answering. Do not rely on filenames or note titles because notes may be untitled. Start with list_current_folder when the active note's location may matter, then use list_markdown_files, search_markdown_files, read_markdown_files, read_file, list_folder, or get_path_info as needed. Cite vault-relative source paths in the final answer.
19. For durable research memory, use search_research_memory/read_research_memory before continuing a remembered topic, and append_research_memory when the user asks to save, remember, persist, or build durable topic memory.
20. For graph, backlink, related-note, or note-connection questions, use graph/search tools before answering. Separate explicit Obsidian links/backlinks from inferred semantic relationships and cite vault-relative note paths.
21. For note/file word-count or length-check questions, call count_words and answer from the tool result.
22. When an active markdown note is available and chat-only mode is not requested, gather the needed read/web/vault context first, then let the plugin stream the final answer markdown into the active note. Use chat-only output only when the user explicitly asks for chat-only or the plugin reports no note writeback is required.
23. When you need tools, request tools without writing user-facing prose or preambles.
24. When the mission is expected to produce note output, choose the safest useful write tool instead of only answering in chat.
25. If a date calculation is missing a year or reference date, ask one concise clarifying question instead of guessing.
26. Ask one concise clarifying question when the mission is impossible, dangerous, destructive, missing required credentials, or lacks a required target/value that tools cannot discover. Do not ask when you can proceed safely from vault context, defaults, or available tools.
27. When you have enough context and no note write is required, stop requesting tools and write the final answer.
28. If a web tool fails, explain that web access failed and include the tool error instead of inventing sourced facts.
29. Default to English for English user missions. Use another language only when the current user mission is written primarily in that language or explicitly requests it.
30. Use template tools only when the user asks to create, list, read, use, apply, or fill templates. Saved templates live in the configured template folder and use {{field}} placeholders.
31. When filling a template, prefer fill_template over generic file creation. Use templateText for ad hoc templates supplied in the mission, or templatePath for saved templates. For an explicit multi-note research pack, use create_research_pack so Brief, Sources, Synthesis, and Index are created and verified transactionally.
32. For conceptual vault questions, first inspect the semantic index when available, then call semantic_search_notes for ranked evidence before broad file reads. Use exact path/title/heading tools for exact requests. Never use semantic index tools for delete, move, replace, or direct write-only requests. Treat index summaries as navigation aids; cite and rely on source note paths.
33. Stay on the user's requested topic and task. Do not substitute unrelated coding problems, examples, translations, or template answers.`;

const ENGLISH_ONLY_POLICY = [
  "You are an English-only research assistant for an Obsidian vault.",
  "All visible output must be in English.",
  "Do not write Chinese characters in the final answer.",
  "Translate and summarize non-English sources into English before using them.",
  "Use English headings, bullets, source notes, and citation labels.",
  "Final output must be English-only Markdown suitable for Obsidian.",
].join("\n");

const FINAL_ENGLISH_ONLY_RULE =
  "Final output must be English-only Markdown. Do not include Chinese characters. Translate any non-English source material into English before writing the answer.";

const FINAL_ANSWER_PROMPT = [
  "Provide the final answer for the user now.",
  "Use the current conversation, current-note context, and any tool results.",
  "Use English unless the current user mission explicitly asks for another language.",
  "Stay on the exact user-requested topic.",
  "Do not request tools.",
  "Do not mention hidden planning unless it is directly useful to the user.",
].join(" ");

function buildFinalAnswerPrompt(prompt: string): string {
  return [
    FINAL_ANSWER_PROMPT,
    `Current user mission: ${JSON.stringify(truncateForPromptAnchor(prompt))}.`,
    "Answer only that mission. If any prior model content is empty, unrelated, or off topic, ignore it and produce the requested answer from the current mission.",
    ...(isLikelyEnglishPrompt(prompt) ? [FINAL_ENGLISH_ONLY_RULE] : []),
  ].join(" ");
}

function buildCurrentNoteFinalAnswerPrompt(prompt: string): string {
  return [
    FINAL_ANSWER_PROMPT,
    "The active markdown note has already been read and is available as Current note context.",
    "Do not say you will read the note; use the provided Current note context now.",
    isPromptOnCurrentPageIntent(prompt)
      ? "The user wants the prompt written on the active note/page to be extracted and executed."
      : `Current user mission: ${JSON.stringify(truncateForPromptAnchor(prompt))}.`,
    ...(isLikelyEnglishPrompt(prompt) ? [FINAL_ENGLISH_ONLY_RULE] : []),
  ].join(" ");
}

function getFinalAnswerRelevancePrompt(
  prompt: string,
  currentNoteContext: unknown,
  conversationHistory: AgentConversationMessage[] = [],
): string {
  const contextParts = [prompt];

  if (
    isContextDependentFollowupPrompt(prompt) ||
    isPromptOnCurrentPageIntent(prompt)
  ) {
    const assistantMessage = getRecentSubstantiveAssistantMessage(
      conversationHistory,
    );
    if (assistantMessage) {
      contextParts.push(truncateForPromptAnchor(assistantMessage.content));
    }
  }

  if (
    isPromptOnCurrentPageIntent(prompt) ||
    hasCurrentNoteSectionTarget(prompt) ||
    isContextDependentFollowupPrompt(prompt)
  ) {
    const noteContent = getCurrentNoteContextContent(currentNoteContext);
    if (noteContent) {
      contextParts.push(truncateForPromptAnchor(noteContent));
    }
  }

  return contextParts.join("\n\n");
}

function getCurrentNoteContextContent(currentNoteContext: unknown): string | null {
  if (!isRecord(currentNoteContext)) {
    return null;
  }

  return getString(currentNoteContext.content) ?? null;
}

function isPromptOnCurrentPageIntent(prompt: string): boolean {
  return (
    /\b(read|check|extract|use|answer|run|execute|follow|refer)\b[\s\S]{0,100}\b(prompt|instruction|question|task|request)\b[\s\S]{0,100}\b(?:on|from|in|as)\s+(?:the\s+)?(?:page|note|document|notepage)\b/i.test(
      prompt,
    ) ||
    /\b(prompt|instruction|question|task|request)\b[\s\S]{0,100}\b(?:on|from|in)\s+(?:the\s+)?(?:page|note|document|notepage)\b/i.test(
      prompt,
    ) ||
    /\b(read|check|extract|use|answer|run|execute|follow|refer)\b[\s\S]{0,120}\bnotes?\b[\s\S]{0,120}\b(?:notepage|page|note|document)\b[\s\S]{0,80}\bas\s+(?:the\s+)?prompt\b/i.test(
      prompt,
    )
  );
}

const EMPTY_STREAMING_WRITEBACK_MESSAGE =
  "The model returned no writable content. Nothing was written.";
const OFF_TOPIC_MODEL_OUTPUT_MESSAGE =
  "Stopped model output because it drifted off topic from the current mission.";

function resolvePromptForIntent(
  prompt: string,
  conversationHistory: AgentConversationMessage[],
): string {
  if (
    isRevisionApprovalFollowup(prompt) &&
    hasRecentAssistantRevisionCommitment(conversationHistory)
  ) {
    return "Revise this essay by replacing the active note with an expanded draft.";
  }

  if (
    isRecentAssistantWritebackFollowup(prompt) &&
    getRecentSubstantiveAssistantMessage(conversationHistory) !== null
  ) {
    return "Append the most recent assistant response from this chat to the current Obsidian note.";
  }

  if (!isVagueContinuationFollowup(prompt)) {
    return prompt;
  }

  if (hasRecentCurrentNoteReadContext(conversationHistory)) {
    return "Read the current note.";
  }

  if (hasRecentVaultToolContinuationContext(conversationHistory)) {
    return "Continue the prior vault exploration. Use available vault tools to inspect folders and files, then answer with the findings.";
  }

  return prompt;
}

function isRecentAssistantWritebackFollowup(prompt: string): boolean {
  return /\b(write|copy|save|append|add|insert|paste|put)\b[\s\S]{0,100}\b(this|that|the|your|previous|prior|last|above)\s+(essay|answer|response|reply|summary|analysis|content|text|draft|paragraph|article|report)\b[\s\S]{0,100}\b(?:on|onto|to|into|in)\s+(?:the\s+)?(?:page|note|document|file|markdown)\b|\b(?:on|onto|to|into|in)\s+(?:the\s+)?(?:page|note|document|file|markdown)\b[\s\S]{0,100}\b(write|copy|save|append|add|insert|paste|put)\b[\s\S]{0,100}\b(this|that|the|your|previous|prior|last|above)\s+(essay|answer|response|reply|summary|analysis|content|text|draft|paragraph|article|report)\b/i.test(
    prompt,
  );
}

function hasPriorAssistantResponseWritebackIntent(prompt: string): boolean {
  return /\bmost recent assistant response\b[\s\S]{0,120}\bcurrent Obsidian note\b/i.test(
    prompt,
  ) || isRecentAssistantWritebackFollowup(prompt);
}

function getRecentSubstantiveAssistantMessage(
  conversationHistory: AgentConversationMessage[],
): AgentConversationMessage | null {
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const message = conversationHistory[index];
    if (message.role !== "assistant") {
      continue;
    }

    if (message.content.trim()) {
      return message;
    }
  }

  return null;
}

function isVagueContinuationFollowup(prompt: string): boolean {
  return /^\s*(continue|go on|go ahead|keep going|keep exploring|keep searching|read it|check it|do that|do it|please do|please|yes|ok|okay)\.?\s*$/i.test(
    prompt,
  );
}

function isRevisionApprovalFollowup(prompt: string): boolean {
  const normalized = prompt.trim();
  return (
    /^(go ahead|do it|do that|please do|please|yes|ok|okay)\b[\s\S]{0,80}\b(revise|edit|update|rewrite|expand|improve|iterate|change|make)\b/i.test(
      normalized,
    ) ||
    /^(go ahead|do it|do that|please do|please|yes|ok|okay)\.?\s*$/i.test(
      normalized,
    ) ||
    /^(revise|edit|update|rewrite|expand|improve|iterate)\s+(it|that|this|the\s+(?:essay|note|page|draft|article|paragraphs?))\.?\s*$/i.test(
      normalized,
    )
  );
}

function hasRecentAssistantRevisionCommitment(
  conversationHistory: AgentConversationMessage[],
): boolean {
  return conversationHistory.slice(-8).some((message) => {
    if (message.role !== "assistant") {
      return false;
    }

    return /\b(i(?:'ll| will| am going to)?|let me|ready to)\b[\s\S]{0,120}\b(revise|edit|update|rewrite|expand|improve|iterate)\b[\s\S]{0,160}\b(essay|note|page|draft|article|paragraphs?|section|content|version)\b|\b(revise|edit|update|rewrite|expand|improve|iterate)\b[\s\S]{0,160}\b(essay|note|page|draft|article|paragraphs?|section|content|version)\b/i.test(
      message.content,
    );
  });
}

function isContextDependentFollowupPrompt(prompt: string): boolean {
  return (
    isVagueContinuationFollowup(prompt) ||
    /\b(my|your|the|those|these|that|it|them|above|previous|prior|last|same|favorite\s+things?)\b/i.test(
      prompt,
    ) ||
    /\b(continue|expand|extend|build\s+on|follow\s+up|below|under|after)\b/i.test(
      prompt,
    )
  );
}

function hasRecentCurrentNoteReadContext(
  conversationHistory: AgentConversationMessage[],
): boolean {
  return conversationHistory.slice(-8).some((message) =>
    /\b(read|check|inspect|look at|open)\b[\s\S]{0,80}\b(current|active|this)\s+(note|file|markdown|document)\b|\b(current|active|this)\s+(note|file|markdown|document)\b[\s\S]{0,80}\b(read|check|inspect|look at|open)\b|\bactive markdown file\b/i.test(
      message.content,
    ),
  );
}

function hasRecentVaultToolContinuationContext(
  conversationHistory: AgentConversationMessage[],
): boolean {
  return conversationHistory.slice(-10).some((message) => {
    const content = message.content;
    return (
      /\b(list_folder|list_current_folder|list_markdown_files|read_markdown_files|search_markdown_files|read_file|get_path_info)\b/i.test(
        content,
      ) ||
      /\bvault\b[\s\S]{0,140}\b(folder|folders|file|files|structure|explor|personal details)\b/i.test(
        content,
      ) ||
      /\b(folder|folders|file|files|structure|explor|personal details)\b[\s\S]{0,140}\bvault\b/i.test(
        content,
      ) ||
      /\b(tool usage|tool request|use tools|using tools)\b/i.test(content)
    );
  });
}

export async function runAgentMission({
  prompt,
  runId: providedRunId,
  modelClient,
  toolRegistry,
  toolContext,
  enableStreaming,
  conversationHistory = [],
  events = {},
  abortSignal,
  approvalBroker: providedApprovalBroker,
  forceChatOnly = false,
  maxToolCalls: providedMaxToolCalls,
  maxSteps: providedMaxSteps,
  seedMissionEvidence = [],
  seedClaimPassages = [],
  orchestratorContext,
  orchestratorSnapshot,
  getOrchestratorSnapshot,
}: RunAgentMissionOptions): Promise<void> {
  const runStartedAt = nowMs();
  const configuredMaxRunMs =
    typeof toolContext.settings?.maxRunMinutes === "number" &&
    toolContext.settings.maxRunMinutes > 0
      ? toolContext.settings.maxRunMinutes * 60_000
      : null;
  const runDeadlineAt =
    configuredMaxRunMs === null ? undefined : Date.now() + configuredMaxRunMs;
  const runId =
    providedRunId?.trim() ||
    createAgentRunId(toolContext.now?.() ?? new Date());
  const metricEvents: AgentRunMetricEvent[] = [];
  const callerEvents = events;
  events = new Proxy(callerEvents, {
    get: (target, property, receiver) => {
      if (property === "onMetric") {
        return (event: AgentRunMetricEvent) => {
          metricEvents.push(event);
          callerEvents.onMetric?.(event);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const approvalBroker = providedApprovalBroker ?? new ApprovalBroker();
  const maxToolCalls = normalizeInvocationToolCallLimit(providedMaxToolCalls);
  let observedToolCallCount = 0;
  let toolCallBudgetExhausted = false;
  let toolCallBudgetNoticeEmitted = false;
  const runtimeCache = createRuntimeCache();
  let activeThink = resolveThinkingMode(toolContext.settings);
  const intentPrompt = resolvePromptForIntent(prompt, conversationHistory);
  let activeIntentPrompt = intentPrompt;
  let missionIntent = classifyMissionIntent(activeIntentPrompt);
  if (forceChatOnly) {
    missionIntent = suppressNoteWritebackForChatOnly(activeIntentPrompt, missionIntent);
  }
  const modelRouterMode = resolveModelRouterMode(toolContext.settings);
  let routedModelIntent: RoutedMissionIntent | null = null;
  let routedMissionIntent: RoutedMissionIntent | null = null;
  if (modelRouterMode !== "off") {
    events.onStatus?.("Classifying mission with structured router...");
    routedModelIntent = await classifyMissionWithModel({
      client: modelClient,
      prompt: activeIntentPrompt,
      recentAssistant: conversationHistory
        .filter((message) => message.role === "assistant")
        .slice(-1)[0]?.content,
    });
    const earlyRegexIntent = deriveRoutedIntentFallback({
      missionIntent,
      writeAutonomy: missionIntent.allowAutonomousWrite,
      writeToolExposed: false,
    });
    const earlyResolved = resolvePolicyRoutedIntent({
      mode: modelRouterMode,
      modelIntent: routedModelIntent,
      missionIntent,
      writeAutonomy: missionIntent.allowAutonomousWrite,
      writeToolExposed: false,
    });
    routedMissionIntent =
      modelRouterMode === "authority" ? earlyResolved.intent : null;
    events.onTrace?.({
      id:
        modelRouterMode === "authority"
          ? "structured-router-authority"
          : "structured-router-shadow",
      kind: "mission_intent",
      message:
        modelRouterMode === "authority"
          ? earlyResolved.source === "model"
            ? `Structured router authority decision: ${earlyResolved.intent.mode} (${earlyResolved.intent.confidence}).`
            : `Structured router authority fell back to regex (${earlyResolved.fallbackReason ?? "unknown"}).`
          : routedModelIntent
            ? `Structured router shadow decision: ${routedModelIntent.mode} (${routedModelIntent.confidence}).`
            : "Structured router shadow decision unavailable; regex fallback remains authoritative.",
      outputPreview: {
        mode: modelRouterMode,
        source: earlyResolved.source,
        fallbackReason: earlyResolved.fallbackReason,
        modelIntent: routedModelIntent,
        resolvedIntent: earlyResolved.intent,
        regexIntent: earlyRegexIntent,
        regexMode: missionIntent.mode,
        agreement: routedModelIntent
          ? compareRouterWithRegex(routedModelIntent, missionIntent)
          : "fallback",
      },
    });
  }
  let writeAutonomy = missionIntent.allowAutonomousWrite;
  let runToolContext: ToolExecutionContext = {
    ...toolContext,
    originalPrompt: activeIntentPrompt,
    runtimeCache,
    reportProgress: (message) => events.onStatus?.(message),
    reportCodeOutput: (event) => events.onCodeOutput?.(event),
    runId,
    abortSignal,
    deadlineAt: runDeadlineAt,
    userApprovalGranted: false,
    writeAutonomy,
    missionIntent,
  };
  if (
    shouldFallbackGeneratedNoteOutputToChat(
      activeIntentPrompt,
      missionIntent,
      runToolContext,
      enableStreaming,
    )
  ) {
    missionIntent = buildMissionIntent(activeIntentPrompt, {
      mode: "chat_only",
      vaultContext: missionIntent.vaultContext,
      noteOutput: false,
      explicitPersistence: missionIntent.explicitPersistence,
      explicitMutation: missionIntent.explicitMutation,
      explicitDelete: missionIntent.explicitDelete,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
    });
    writeAutonomy = false;
    runToolContext = {
      ...runToolContext,
      writeAutonomy,
      missionIntent,
    };
  }
  const reflexController = new AgenticReflexController();
  const recentActions: AgentTrajectoryEvent[] = [];
  const missionEvidenceRecords: MissionEvidence[] = seedMissionEvidence.map(
    (item) => ({
      ...item,
      passageIds: item.passageIds ? [...item.passageIds] : undefined,
    }),
  );
  let reflexOutput = await reflexController.evaluate({
    prompt: activeIntentPrompt,
    missionIntent,
    allowedToolNames: new Set(),
    recentActions,
    evidence: missionEvidenceRecords,
    receipts: [],
    settings: runToolContext.settings,
    embeddingProvider: runToolContext.semanticEmbeddingProvider,
  });
  const reflexIntentApplication = applySafeReflexIntent({
    prompt: activeIntentPrompt,
    missionIntent,
    reflex: reflexOutput.intent,
  });
  if (reflexIntentApplication.applied) {
    missionIntent = reflexIntentApplication.missionIntent;
    reflexOutput = {
      ...reflexOutput,
      intent: {
        ...reflexOutput.intent,
        applied: true,
        reason: reflexIntentApplication.reason,
      },
    };
    writeAutonomy = missionIntent.allowAutonomousWrite;
    runToolContext = {
      ...runToolContext,
      writeAutonomy,
      missionIntent,
    };
  }
  missionIntent = applyDefaultActiveNoteWriteback({
    prompt: activeIntentPrompt,
    missionIntent,
    toolContext: runToolContext,
    enableStreaming,
    forceChatOnly,
  });
  writeAutonomy = missionIntent.allowAutonomousWrite;
  runToolContext = {
    ...runToolContext,
    writeAutonomy,
    missionIntent,
  };
  let noteOutputPlan = buildMissionNoteOutputPlan({
    prompt: activeIntentPrompt,
    missionIntent,
    toolContext: runToolContext,
    enableStreaming,
    forceChatOnly,
  });
  if (
    noteOutputPlan.destination === "chat" &&
    missionIntent.noteOutput &&
    !forceChatOnly &&
    !hasChatOnlyResponseIntent(activeIntentPrompt) &&
    (noteOutputPlan.reason === "explicit_chat_only" ||
      noteOutputPlan.reason === "force_chat_only" ||
      noteOutputPlan.reason === "no_active_note_chat_first" ||
      noteOutputPlan.reason === "active_note_only_no_file" ||
      noteOutputPlan.reason === "trivial_chat")
  ) {
    // Plan says chat (e.g. chat_first profile): suppress note write.
    // Do not use this path for specialized_route — those keep their own tools.
    missionIntent = suppressNoteWritebackForChatOnly(
      activeIntentPrompt,
      missionIntent,
    );
    writeAutonomy = false;
    runToolContext = {
      ...runToolContext,
      writeAutonomy,
      missionIntent,
    };
  } else if (
    noteOutputPlan.destination === "new_note" &&
    !missionIntent.noteOutput &&
    enableStreaming &&
    resolveOutputProfile(runToolContext.settings) === "active_or_new_note" &&
    runToolContext.settings?.streamWritebackMode ===
      "all_current_note_content_writes" &&
    !(
      hasWebSearchIntent(activeIntentPrompt) ||
      hasBrowserAutomationIntent(activeIntentPrompt) ||
      hasCodeExecutionIntent(activeIntentPrompt)
    )
  ) {
    // Promote only for host-owned lazy create when streaming delivery is available.
    missionIntent = buildMissionIntent(activeIntentPrompt, {
      ...missionIntent,
      mode: missionIntent.vaultContext ? "vault_context_answer" : "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    });
    writeAutonomy = true;
    runToolContext = {
      ...runToolContext,
      writeAutonomy,
      missionIntent,
    };
  }
  events.onTrace?.({
    id: "note-output-plan",
    kind: "mission_intent",
    message: `Note output plan: ${noteOutputPlan.destination}/${noteOutputPlan.mutation}/${noteOutputPlan.delivery} (${noteOutputPlan.reason})`,
    outputPreview: noteOutputPlan,
  });
  let structuredIntent = classifyStructuredIntent(activeIntentPrompt, missionIntent);
  const modelOptions = buildModelRequestOptions(runToolContext.settings);
  const runContextBudget = createRunContextBudget(modelOptions?.num_ctx ?? null);
  let estimatedPromptCharsForRun = 0;
  let followupIntentContext =
    intentPrompt === prompt ? null : formatFollowupIntentContext(intentPrompt);
  const disableThinkingForRun = () => {
    if (activeThink !== undefined) {
      activeThink = undefined;
      events.onStatus?.("Thinking unsupported; using standard loop.");
    }
  };
  let streamingWritebackKind = getStreamingWritebackKind(
    activeIntentPrompt,
    runToolContext,
    enableStreaming,
  );
  let tools = getAllowedToolDefinitions(
    toolRegistry,
    activeIntentPrompt,
    missionIntent,
    runToolContext.settings,
    streamingWritebackKind,
    reflexOutput.intent,
  );
  let directCurrentNoteWritebackKind = getDirectCurrentNoteWritebackKind({
    prompt: activeIntentPrompt,
    missionIntent,
    streamingWritebackKind,
    toolContext: runToolContext,
  });
  if (
    shouldOmitCurrentNoteReadForTargetOnlyWrite(activeIntentPrompt, missionIntent) &&
    !hasParallelVaultReadIntent(activeIntentPrompt)
  ) {
    tools = removeToolDefinition(tools, "read_current_file");
  }
  const knownToolNames = new Set(
    toolRegistry.getDefinitions().map((tool) => tool.function.name),
  );
  let allowedToolNames = new Set(tools.map((tool) => tool.function.name));
  let requiredWriteTools = getRequiredWriteToolNames(
    activeIntentPrompt,
    allowedToolNames,
    missionIntent,
    streamingWritebackKind,
  );
  let writeRequired =
    missionIntent.requireWriteCompletion && requiredWriteTools.length > 0;
  let requireToolBeforeStreamingWriteback = false;
  let promptOnPageCurrentNoteReadSatisfied = false;
  let shouldReadCurrentNote = shouldObserveCurrentNote(
    activeIntentPrompt,
    allowedToolNames,
    missionIntent,
  );
  let executedModelTool = false;
  let wroteToNote = false;
  let unavailableToolCorrectionUsed = false;
  let proofGatedWriteToolCorrectionUsed = false;
  let vaultTraversalCorrectionUsed = false;
  let vaultCoverageExpansionUsed = false;
  let webResearchCorrectionUsed = false;
  let toolBeforeWriteCorrectionUsed = false;
  let finalOutputCorrectionUsed = false;
  let consecutiveNoProgressSteps = 0;
  let lastProgressSignature = "";
  let lastStep = 0;
  let lastFinalOutput = "";
  let lastVerificationChecks: VerificationCheck[] = [];
  let lastClaimLedger: ClaimLedger | null = null;
  let lastEvidenceConflicts: EvidenceConflict[] = [];
  const claimPassageRefs: ClaimPassageRef[] = seedClaimPassages.map((item) => ({
    ...item,
  }));
  let recoveryAttemptSignatures: string[] = [];
  let recoveryState: RecoveryState = createRecoveryState({
    now: runToolContext.now?.() ?? new Date(),
  });
  const vaultTransactionRecords: VaultMutationTransaction[] = [];
  let executedWebSearchTool = false;
  let executedWebFetchTool = false;
  let executedCodeRunCount = 0;
  const successfulToolNames: string[] = [];
  const currentSegmentSuccessfulToolNames: string[] = [];
  const failedToolNames: string[] = [];
  const writeReceipts: AgentRunReceipt[] = [];
  // Live receipt array: streamed writer.buildReceipt and tool writes push here
  // before any reflexController.evaluate / acceptance check on the same turn.
  let preparedStreamingSectionEdit: PreparedStreamingSectionEdit | null = null;
  let missionLedger: MissionLedger | null = null;
  let missionPlan: MissionPlan | null = null;
  let researchPlan: ResearchPlan | null = null;
  let researchPhaseDescriptor: ResearchPhaseDescriptor | null = null;
  let lastResearchPhase: ResearchRunPhase | null = null;
  let runtimeSnapshot: MissionRuntimeSnapshotV2 | null = null;
  let runPlan = createRunPlan({
    prompt: activeIntentPrompt,
    missionIntent,
    tools,
    settings: runToolContext.settings,
    streamingWritebackKind,
    directCurrentNoteWritebackKind,
    reflex: reflexOutput.intent,
  });
  activeThink = runPlan.thinking;
  tools = runPlan.allowedTools;
  allowedToolNames = new Set(tools.map((tool) => tool.function.name));
  reflexOutput = await reflexController.evaluate({
    prompt: activeIntentPrompt,
    missionIntent,
    allowedToolNames,
    recentActions,
    evidence: missionEvidenceRecords,
    receipts: writeReceipts,
    settings: runToolContext.settings,
    embeddingProvider: runToolContext.semanticEmbeddingProvider,
  });
  const stopIfRequested = (step = Math.max(lastStep, 0)) => {
    if (!isRunStopRequested(abortSignal)) {
      return false;
    }

    if (missionLedger) {
      updateMissionLedgerStatus(
        missionLedger,
        "stopped",
        runToolContext.now?.() ?? new Date(),
      );
      setLedgerNextAction(
        missionLedger,
        "User stopped the run.",
        runToolContext.now?.() ?? new Date(),
      );
      void writeMissionLedger(runToolContext, missionLedger);
      if (runtimeSnapshot) {
        runtimeSnapshot.status = "stopped";
        runtimeSnapshot.lastSafeStep = missionLedger.lastSafeStep;
        runtimeSnapshot.updatedAt = (
          runToolContext.now?.() ?? new Date()
        ).toISOString();
        void writeMissionRuntimeSnapshot(runToolContext, runtimeSnapshot);
      }
    }
    completeRun(
      events,
      "user_stopped",
      step,
      runStartedAt,
      runPlan.maxStepsForRun,
    );
    return true;
  };

  if (stopIfRequested(0)) {
    return;
  }

  events.onRunConfig?.(
    buildRunConfigEvent({
      runId,
      toolContext: runToolContext,
      enableStreaming,
      activeThink,
      modelOptions,
      writeAutonomy,
      chatOnlyOverride: forceChatOnly,
      missionIntent,
      currentNoteContext: shouldReadCurrentNote,
      runPlan,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
      missionLedger: undefined,
      reflexOutput,
      estimatedPromptChars: estimatedPromptCharsForRun,
      contextBudgetChars: runContextBudget.maxPromptChars,
      performanceGates: evaluatePerformanceGates(metricEvents),
      noteOutputPlan,
    }),
  );
  events.onTrace?.({
    id: "mission-intent",
    kind: "mission_intent",
    message: `Mission mode: ${missionIntent.mode}`,
    outputPreview: missionIntent,
  });
  events.onTrace?.({
    id: "allowed-tools",
    kind: "allowed_tools",
    message: `Allowed tools: ${
      tools.map((tool) => tool.function.name).join(", ") || "none"
    }`,
    outputPreview: tools.map((tool) => tool.function.name),
  });

  const currentNoteContext = shouldReadCurrentNote
    ? await readInitialCurrentNote(toolRegistry, runToolContext, events)
    : null;
  if (stopIfRequested(0)) {
    return;
  }

  const promptOnPageRoutingPrompt = getPromptOnCurrentPageRoutingPrompt(
    prompt,
    currentNoteContext,
  );
  if (promptOnPageRoutingPrompt !== null) {
    activeIntentPrompt = promptOnPageRoutingPrompt;
    missionIntent = classifyPromptOnCurrentPageMissionIntent(activeIntentPrompt);
    if (forceChatOnly) {
      missionIntent = suppressNoteWritebackForChatOnly(activeIntentPrompt, missionIntent);
    }
    reflexOutput = await reflexController.evaluate({
      prompt: activeIntentPrompt,
      missionIntent,
      allowedToolNames: new Set(),
      recentActions,
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      settings: runToolContext.settings,
      embeddingProvider: runToolContext.semanticEmbeddingProvider,
    });
    const promptPageReflexIntentApplication = applySafeReflexIntent({
      prompt: activeIntentPrompt,
      missionIntent,
      reflex: reflexOutput.intent,
    });
    if (promptPageReflexIntentApplication.applied) {
      missionIntent = promptPageReflexIntentApplication.missionIntent;
      reflexOutput = {
        ...reflexOutput,
        intent: {
          ...reflexOutput.intent,
          applied: true,
          reason: promptPageReflexIntentApplication.reason,
        },
      };
    }
    missionIntent = applyDefaultActiveNoteWriteback({
      prompt: activeIntentPrompt,
      missionIntent,
      toolContext: runToolContext,
      enableStreaming,
      forceChatOnly,
    });
    writeAutonomy = missionIntent.allowAutonomousWrite;
    runToolContext = {
      ...runToolContext,
      originalPrompt: activeIntentPrompt,
      writeAutonomy,
      missionIntent,
    };
    structuredIntent = classifyStructuredIntent(activeIntentPrompt, missionIntent);
    streamingWritebackKind = getStreamingWritebackKind(
      activeIntentPrompt,
      runToolContext,
      enableStreaming,
    );
    directCurrentNoteWritebackKind = null;
    tools = getAllowedToolDefinitions(
      toolRegistry,
      activeIntentPrompt,
      missionIntent,
      runToolContext.settings,
      streamingWritebackKind,
      reflexOutput.intent,
    );
    if (currentNoteContext !== null) {
      const filteredTools = tools.filter(
        (tool) => tool.function.name !== "read_current_file",
      );
      promptOnPageCurrentNoteReadSatisfied =
        filteredTools.length !== tools.length;
      tools = filteredTools;
    }
    allowedToolNames = new Set(tools.map((tool) => tool.function.name));
    requiredWriteTools = getRequiredWriteToolNames(
      activeIntentPrompt,
      allowedToolNames,
      missionIntent,
      streamingWritebackKind,
    );
    writeRequired =
      missionIntent.requireWriteCompletion && requiredWriteTools.length > 0;
    requireToolBeforeStreamingWriteback = promptRequiresToolLoop(
      activeIntentPrompt,
    );
    runPlan = createRunPlan({
      prompt: activeIntentPrompt,
      missionIntent,
      tools,
      settings: runToolContext.settings,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
      reflex: reflexOutput.intent,
    });
    activeThink = runPlan.thinking;
    tools = runPlan.allowedTools;
    allowedToolNames = new Set(tools.map((tool) => tool.function.name));
    reflexOutput = await reflexController.evaluate({
      prompt: activeIntentPrompt,
      missionIntent,
      allowedToolNames,
      recentActions,
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      settings: runToolContext.settings,
      embeddingProvider: runToolContext.semanticEmbeddingProvider,
    });
    requiredWriteTools = getRequiredWriteToolNames(
      activeIntentPrompt,
      allowedToolNames,
      missionIntent,
      streamingWritebackKind,
    );
    writeRequired =
      missionIntent.requireWriteCompletion && requiredWriteTools.length > 0;
    if (
      runPlan.route === "prefetched_vault_answer" ||
      runPlan.route === "prefetched_vault_writeback"
    ) {
      requireToolBeforeStreamingWriteback = false;
    }
    followupIntentContext = null;

    events.onStatus?.("Using prompt from current note for tool routing...");
    events.onRunConfig?.(
      buildRunConfigEvent({
        runId,
        toolContext: runToolContext,
        enableStreaming,
        activeThink,
        modelOptions,
        writeAutonomy,
        chatOnlyOverride: forceChatOnly,
        missionIntent,
        currentNoteContext: true,
        runPlan,
        streamingWritebackKind,
        directCurrentNoteWritebackKind,
        missionLedger: undefined,
        reflexOutput,
        performanceGates: evaluatePerformanceGates(metricEvents),
      }),
    );
    events.onTrace?.({
      id: "prompt-on-page-routing",
      kind: "mission_intent",
      message: `Using current-note prompt as mission: ${missionIntent.mode}`,
      outputPreview: {
        missionIntent,
        requiresToolLoop: requireToolBeforeStreamingWriteback,
        prompt: truncateForPromptAnchor(activeIntentPrompt),
      },
    });
    events.onTrace?.({
      id: "prompt-on-page-allowed-tools",
      kind: "allowed_tools",
      message: `Allowed tools: ${
        tools.map((tool) => tool.function.name).join(", ") || "none"
      }`,
      outputPreview: tools.map((tool) => tool.function.name),
    });
  }

  if (
    streamingWritebackKind !== null &&
    promptRequiresToolLoop(activeIntentPrompt) &&
    runPlan.route !== "prefetched_vault_writeback"
  ) {
    requireToolBeforeStreamingWriteback = true;
  }

  let finalAnswerRelevancePrompt = getFinalAnswerRelevancePrompt(
    activeIntentPrompt,
    currentNoteContext,
    conversationHistory,
  );
  const promptOnPageWritebackKind = getPromptOnPageWritebackKind({
    prompt,
    currentNoteContext,
    toolContext: runToolContext,
    enableStreaming,
  });
  const checkpointResumeContext = await buildCheckpointResumeContext({
    prompt,
    activeIntentPrompt,
    toolContext: runToolContext,
    events,
  });
  if (checkpointResumeContext?.missingRequestedRunId) {
    const missingRunId = checkpointResumeContext.missingRequestedRunId;
    const message =
      `Run ${missingRunId} was requested explicitly, but its exact durable ` +
      "checkpoint is unavailable. Refusing to continue from a different run.";
    events.onStatus?.(message);
    emitDirectAssistantAnswer(message, events, true);
    completeRun(events, "error", 0, runStartedAt, runPlan.maxStepsForRun);
    return;
  }
  const resumeLedger = checkpointResumeContext?.missionResume?.ledger;
  const resumeSnapshot = checkpointResumeContext?.runtimeSnapshot;
  if (resumeLedger && checkpointResumeContext?.missionResume?.plan.canResume === false) {
    const resumeReason = checkpointResumeContext.missionResume.plan.reason;
    const message =
      resumeReason === "proof_debt_blocked"
        ? `Run ${resumeLedger.runId} has blocking proof debt (approvals, policy, or unresolved mutations). ` +
          "Resolve the blocker before continuing this run."
        : `Run ${resumeLedger.runId} is already complete and accepted. ` +
          "Start a new mission explicitly if you want to repeat or revise that work.";
    events.onTrace?.({
      id: resumeReason === "proof_debt_blocked"
        ? "resume-proof-debt-blocked"
        : "resume-already-complete",
      kind: "status",
      message,
      outputPreview: {
        runId: resumeLedger.runId,
        status: resumeLedger.status,
        acceptance: resumeLedger.acceptance?.status ?? "unchecked",
      },
    });
    emitDirectAssistantAnswer(message, events, true);
    completeRun(events, "final", 0, runStartedAt, runPlan.maxStepsForRun);
    return;
  }
  const ambiguousResumeOperations = resumeSnapshot
    ? buildOperationReconciliationInputs(resumeSnapshot.operationJournal).filter(
        (item) => item.recommendedAction !== "safe_to_retry",
      )
    : [];
  if (resumeLedger && ambiguousResumeOperations.length > 0) {
    const targets = ambiguousResumeOperations
      .map((item) => item.targetPath ?? item.toolName)
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 4);
    const message =
      `Run ${resumeLedger.runId} has ${ambiguousResumeOperations.length} unresolved mutation ` +
      `operation(s) that may already have applied${targets.length > 0 ? ` (${targets.join(", ")})` : ""}. ` +
      "Automatic replay is blocked. Inspect the target and start a new explicit repair mission.";
    events.onTrace?.({
      id: "resume-mutation-reconciliation-required",
      kind: "error",
      message,
      outputPreview: ambiguousResumeOperations,
      error: {
        code: "mutation_reconciliation_required",
        message,
      },
    });
    emitDirectAssistantAnswer(message, events, true);
    completeRun(events, "error", 0, runStartedAt, runPlan.maxStepsForRun);
    return;
  }
  const pendingCurrentNoteResumeGoals = resumeSnapshot
    ? CURRENT_NOTE_RESUME_GOALS.filter((goal) => {
        const state = resumeSnapshot.operationGoals[goal];
        return state === "pending" || state === "failed";
      })
    : [];
  const activeResumeNotePath = runToolContext.getCurrentMarkdownFile?.()?.path;
  if (
    resumeLedger &&
    resumeSnapshot?.currentNotePath &&
    pendingCurrentNoteResumeGoals.length > 0 &&
    activeResumeNotePath !== resumeSnapshot.currentNotePath
  ) {
    const message =
      `Run ${resumeLedger.runId} was started on ${resumeSnapshot.currentNotePath}, ` +
      `but the active note is ${activeResumeNotePath ?? "unavailable"}. ` +
      "Open the original note and continue the run again so current-note work cannot target the wrong file.";
    events.onTrace?.({
      id: "resume-current-note-target-mismatch",
      kind: "status",
      message,
      outputPreview: {
        expectedPath: resumeSnapshot.currentNotePath,
        activePath: activeResumeNotePath ?? null,
        pendingGoals: pendingCurrentNoteResumeGoals,
      },
    });
    emitDirectAssistantAnswer(message, events, true);
    completeRun(
      events,
      "clarifying_question",
      0,
      runStartedAt,
      runPlan.maxStepsForRun,
    );
    return;
  }
  const resumedOriginalMission =
    resumeSnapshot?.originalMission ?? resumeLedger?.mission;
  if (resumedOriginalMission) {
    activeIntentPrompt = resumedOriginalMission;
    missionIntent = classifyMissionIntent(activeIntentPrompt);
    if (forceChatOnly) {
      missionIntent = suppressNoteWritebackForChatOnly(activeIntentPrompt, missionIntent);
    }
    writeAutonomy = missionIntent.allowAutonomousWrite;
    runToolContext = {
      ...runToolContext,
      originalPrompt: activeIntentPrompt,
      writeAutonomy,
      missionIntent,
    };
    routedMissionIntent = null;
    reflexOutput = await reflexController.evaluate({
      prompt: activeIntentPrompt,
      missionIntent,
      allowedToolNames: new Set(),
      recentActions,
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      settings: runToolContext.settings,
      embeddingProvider: runToolContext.semanticEmbeddingProvider,
    });
    missionIntent = applyDefaultActiveNoteWriteback({
      prompt: activeIntentPrompt,
      missionIntent,
      toolContext: runToolContext,
      enableStreaming,
      forceChatOnly,
    });
    writeAutonomy = missionIntent.allowAutonomousWrite;
    runToolContext = {
      ...runToolContext,
      writeAutonomy,
      missionIntent,
    };
    structuredIntent = classifyStructuredIntent(activeIntentPrompt, missionIntent);
    streamingWritebackKind = getStreamingWritebackKind(
      activeIntentPrompt,
      runToolContext,
      enableStreaming,
    );
    tools = getAllowedToolDefinitions(
      toolRegistry,
      activeIntentPrompt,
      missionIntent,
      runToolContext.settings,
      streamingWritebackKind,
      reflexOutput.intent,
    );
    directCurrentNoteWritebackKind = getDirectCurrentNoteWritebackKind({
      prompt: activeIntentPrompt,
      missionIntent,
      streamingWritebackKind,
      toolContext: runToolContext,
    });
    if (shouldOmitCurrentNoteReadForTargetOnlyWrite(activeIntentPrompt, missionIntent)) {
      tools = removeToolDefinition(tools, "read_current_file");
    }
    allowedToolNames = new Set(tools.map((tool) => tool.function.name));
    requiredWriteTools = getRequiredWriteToolNames(
      activeIntentPrompt,
      allowedToolNames,
      missionIntent,
      streamingWritebackKind,
    );
    writeRequired =
      missionIntent.requireWriteCompletion && requiredWriteTools.length > 0;
    requireToolBeforeStreamingWriteback = promptRequiresToolLoop(activeIntentPrompt);
    shouldReadCurrentNote = shouldObserveCurrentNote(
      activeIntentPrompt,
      allowedToolNames,
      missionIntent,
    );
    runPlan = createRunPlan({
      prompt: activeIntentPrompt,
      missionIntent,
      tools,
      settings: runToolContext.settings,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
      reflex: reflexOutput.intent,
    });
    runPlan.traceReasons = [
      ...new Set([
        ...runPlan.traceReasons,
        `resume_original_route:${resumeLedger?.route ?? runPlan.route}`,
      ]),
    ];
    activeThink = runPlan.thinking;
    finalAnswerRelevancePrompt = getFinalAnswerRelevancePrompt(
      activeIntentPrompt,
      currentNoteContext,
      conversationHistory,
    );
    followupIntentContext = null;
    events.onTrace?.({
      id: "resume-original-mission-routing",
      kind: "mission_intent",
      message: `Restored original mission routing for continuation: ${runPlan.route}.`,
      outputPreview: {
        priorRunId: resumeLedger?.runId ?? null,
        route: runPlan.route,
        maxStepsForRun: runPlan.maxStepsForRun,
        toolBudgetPrompt: activeIntentPrompt,
      },
    });
  }
  const generatedOutputPolicy = analyzeGeneratedOutputPrompt(activeIntentPrompt);
  let loopBudgetPlan = planLoopBudget({
    prompt: activeIntentPrompt,
    route: runPlan.route,
    generated: generatedOutputPolicy,
    configuredMaxSteps: getConfiguredMaxAgentSteps(runToolContext.settings),
    requestedSteps: parseExplicitModelStepTarget(activeIntentPrompt),
  });
  if (resumeLedger) {
    const configuredCap = getConfiguredMaxAgentSteps(runToolContext.settings);
    const inheritedHardCap = Math.max(
      1,
      Math.min(configuredCap, resumeLedger.loopBudget.hardCap),
    );
    const inheritedFinalizationReserve = Math.min(
      inheritedHardCap,
      Math.max(0, resumeLedger.loopBudget.finalizationReserve),
    );
    const inheritedToolStepBudget = Math.min(
      Math.max(0, inheritedHardCap - inheritedFinalizationReserve),
      Math.max(0, resumeLedger.loopBudget.toolStepBudget),
    );
    const inheritedExpectedTools = [
      ...new Set([
        ...resumeLedger.loopBudget.expectedTools,
        ...loopBudgetPlan.expectedTools,
      ]),
    ];
    loopBudgetPlan = {
      ...loopBudgetPlan,
      hardCap: inheritedHardCap,
      toolStepBudget: inheritedToolStepBudget,
      finalizationReserve: inheritedFinalizationReserve,
      expectedTools: inheritedExpectedTools,
    };
    runPlan = {
      ...runPlan,
      maxStepsForRun: inheritedHardCap,
      expectedTimeClass:
        inheritedHardCap > 12 ? "long" : runPlan.expectedTimeClass,
      traceReasons: [
        ...new Set([...runPlan.traceReasons, "resume_inherited_segment_budget"]),
      ],
      budgetProfile: {
        ...runPlan.budgetProfile,
        maxSteps: inheritedHardCap,
        toolSteps: inheritedToolStepBudget,
        finalizationReserve: inheritedFinalizationReserve,
        reason: "resume_inherited_segment_budget",
        expectedTools: inheritedExpectedTools,
      },
    };
  }
  researchPlan = createResearchPlan({
    prompt: activeIntentPrompt,
    missionIntent,
    runPlan,
  });
  const restoredResearchPlan =
    resumeSnapshot?.researchPlan ?? resumeLedger?.researchPlan;
  if (restoredResearchPlan) {
    researchPlan = JSON.parse(JSON.stringify(restoredResearchPlan)) as ResearchPlan;
  }
  if (
    researchPlan &&
    researchPlan.sourceRequirements.minFetchedSources > 0
  ) {
    tools = addToolDefinitions(tools, toolRegistry, [
      "web_search",
      "web_fetch",
      "read_source_section",
    ]);
    allowedToolNames = new Set(tools.map((tool) => tool.function.name));
    runPlan = {
      ...runPlan,
      allowedTools: tools,
      allowedToolNames: [...allowedToolNames],
      slowPathReason:
        runPlan.slowPathReason === "none"
          ? "needs_web_sources"
          : runPlan.slowPathReason,
      traceReasons: [
        ...new Set([
          ...runPlan.traceReasons,
          "resume_research_source_tools",
        ]),
      ],
      budgetProfile: {
        ...runPlan.budgetProfile,
        expectedTools: [
          ...new Set([
            ...runPlan.budgetProfile.expectedTools,
            "web_search",
            "web_fetch",
          ]),
        ],
      },
    };
  }
  const operationGoals = createMissionOperationGoals({
    prompt: activeIntentPrompt,
    allowedToolNames,
    requiredWriteTools,
    researchPlan,
    streamingWritebackKind,
  });
  if (currentNoteContext !== null) {
    markOperationGoalDone(operationGoals, "read_current_note");
  }
  const resolveOrchestratorSnapshot = () =>
    getOrchestratorSnapshot?.() ?? orchestratorSnapshot ?? null;
  missionLedger = createMissionLedger({
    runId,
    mission: activeIntentPrompt,
    route: runPlan.route,
    loopBudget: loopBudgetPlan,
    researchPlan,
    now: runToolContext.now?.() ?? new Date(),
  });
  const initialOrchestratorSnapshot = resolveOrchestratorSnapshot();
  if (initialOrchestratorSnapshot) {
    missionLedger.orchestrator = initialOrchestratorSnapshot;
  }
  missionPlan = createMissionPlan({
    runId,
    prompt: activeIntentPrompt,
    missionIntent,
    runPlan,
    requiredTools: [
      ...new Set([
        ...loopBudgetPlan.expectedTools,
        ...requiredWriteTools,
        ...[
          streamingWritebackKind,
          promptOnPageWritebackKind,
          directCurrentNoteWritebackKind,
        ]
          .filter((kind): kind is StreamingWritebackKind => kind !== null)
          .map(getStreamingWritebackToolName),
      ]),
    ],
    now: runToolContext.now?.() ?? new Date(),
  });
  const restoredMissionPlan =
    resumeSnapshot?.missionPlan?.version === 1
      ? resumeSnapshot.missionPlan
      : resumeLedger?.missionPlan;
  if (restoredMissionPlan) {
    missionPlan = {
      ...JSON.parse(JSON.stringify(restoredMissionPlan)),
      runId,
      updatedAt: (runToolContext.now?.() ?? new Date()).toISOString(),
    } as MissionPlan;
  }
  const restoredEvidence =
    resumeSnapshot?.evidence ?? resumeLedger?.evidence ?? [];
  for (const evidence of restoredEvidence) {
    upsertMissionEvidenceRecord(missionEvidenceRecords, { ...evidence });
  }
  const restoredClaimPassages =
    resumeSnapshot?.claimPassages ?? resumeLedger?.claimPassages ?? [];
  if (restoredClaimPassages.length > 0) {
    upsertClaimPassageRefs(claimPassageRefs, restoredClaimPassages);
  }
  if (resumeSnapshot?.claimLedger || resumeLedger?.claimLedger) {
    lastClaimLedger =
      resumeSnapshot?.claimLedger ?? resumeLedger?.claimLedger ?? null;
  }
  const restoredConflicts =
    resumeSnapshot?.evidenceConflicts ?? resumeLedger?.evidenceConflicts ?? [];
  if (restoredConflicts.length > 0) {
    lastEvidenceConflicts = restoredConflicts.map((item) => ({ ...item }));
  }
  if (resumeSnapshot?.receipts.length) {
    for (const receipt of resumeSnapshot.receipts) {
      const restoredReceipt = runtimeReceiptToAgentRunReceipt(receipt);
      if (!restoredReceipt) {
        continue;
      }
      const alreadyRestored = writeReceipts.some(
        (existing) => sameAgentRunReceiptIdentity(existing, restoredReceipt),
      );
      if (!alreadyRestored) {
        writeReceipts.push(restoredReceipt);
      }
    }
  }
  const refreshEvidenceConflicts = () => {
    if (claimPassageRefs.length < 2) {
      return;
    }
    const detected = detectEvidenceConflicts(
      claimPassageRefs.map((passage) => ({
        id: passage.id,
        text: passage.text,
      })),
    );
    lastEvidenceConflicts = mergeEvidenceConflicts(
      lastEvidenceConflicts,
      detected,
    );
  };
  const buildClaimConflictState = () => {
    const openConflictCount = listOpenEvidenceConflicts(lastEvidenceConflicts)
      .length;
    if (!lastClaimLedger && openConflictCount === 0) {
      // Omit claimConflict so analyze stays vacuously complete until ledger/conflicts exist.
      return null;
    }
    const unboundClaimCount = lastClaimLedger
      ? lastClaimLedger.claims.filter(
          (claim) =>
            claim.status === "ungrounded" || claim.status === "invalid_citation",
        ).length
      : 0;
    return {
      openConflictCount,
      unboundClaimCount,
      claimsGrounded:
        lastClaimLedger == null
          ? null
          : lastClaimLedger.status === "pass" ||
            lastClaimLedger.status === "skipped",
      analyzeComplete:
        openConflictCount === 0 &&
        unboundClaimCount === 0 &&
        (lastClaimLedger == null ||
          lastClaimLedger.status === "pass" ||
          lastClaimLedger.status === "skipped"),
    };
  };
  const refreshResearchPhase = (verifyComplete = false) => {
    researchPhaseDescriptor = deriveResearchPhase({
      researchPlan,
      missionPlan,
      claimConflict: buildClaimConflictState(),
      writeReceiptPresent: hasVaultWriteReceipt(writeReceipts),
      externalActionReceiptPresent:
        hasExternalActionReceipt(writeReceipts),
      verifyComplete,
    });
    return researchPhaseDescriptor;
  };
  refreshEvidenceConflicts();
  researchPhaseDescriptor = refreshResearchPhase(false);
  {
    const phaseTransition = buildResearchPhaseTransition(
      lastResearchPhase,
      researchPhaseDescriptor,
    );
    if (phaseTransition) {
      lastResearchPhase = phaseTransition.to;
      events.onTrace?.({
        id: `research-phase:${phaseTransition.to}:init`,
        kind: "status",
        message: `Research phase → ${phaseTransition.to}: ${phaseTransition.reason}`,
        outputPreview: {
          from: phaseTransition.from,
          to: phaseTransition.to,
          reason: phaseTransition.reason,
          writeToolsAllowed: researchPhaseDescriptor.writeToolsAllowed,
        },
      });
    }
  }
  if (resumeSnapshot) {
    recoveryState = resumeSnapshot.recovery;
    for (const goal of Object.keys(operationGoals.goals) as OperationGoal[]) {
      const restoredState = resumeSnapshot.operationGoals[goal];
      if (
        restoredState === "not_requested" ||
        restoredState === "pending" ||
        restoredState === "done" ||
        restoredState === "failed"
      ) {
        const currentState = operationGoals.goals[goal];
        if (
          (currentState === "pending" && restoredState === "not_requested") ||
          (currentState === "done" && restoredState !== "done")
        ) {
          continue;
        }
        operationGoals.goals[goal] = restoredState;
      }
    }
    operationGoals.completedTools.push(
      ...successfulToolNames.filter(
        (toolName) => !operationGoals.completedTools.includes(toolName),
      ),
    );
  }
  if (resumeLedger) {
    missionLedger.mission =
      resumeSnapshot?.originalMission ?? resumeLedger.mission;
    missionLedger.evidence = missionEvidenceRecords.map((item) => ({ ...item }));
    missionLedger.receipts = [...resumeLedger.receipts];
    missionLedger.resumeCount = resumeLedger.resumeCount;
    missionLedger.lastSafeStep = Math.max(
      resumeLedger.lastSafeStep,
      resumeSnapshot?.lastSafeStep ?? 0,
    );
  }
  const previousLineage = resumeSnapshot?.lineage;
  runtimeSnapshot = createMissionRuntimeSnapshot({
    runId,
    originalMission:
      resumeSnapshot?.originalMission ?? resumeLedger?.mission ?? activeIntentPrompt,
    currentNotePath:
      resumeSnapshot?.currentNotePath ??
      runToolContext.getCurrentMarkdownFile?.()?.path,
    rootRunId: previousLineage?.rootRunId ?? resumeLedger?.runId ?? runId,
    segmentId: runId,
    segmentIndex: previousLineage ? previousLineage.segmentIndex + 1 : resumeLedger ? 1 : 0,
    parentSegmentId: previousLineage?.segmentId ?? resumeLedger?.runId,
    priorSegmentIds: previousLineage
      ? [...previousLineage.priorSegmentIds, previousLineage.segmentId]
      : resumeLedger
        ? [resumeLedger.runId]
        : [],
    missionPlan,
    researchPlan,
    orchestrator: resolveOrchestratorSnapshot(),
    evidence: missionEvidenceRecords,
    receipts: writeReceipts,
    operationGoals: operationGoals.goals,
    recovery: recoveryState,
    operationJournal: resumeSnapshot?.operationJournal ?? [],
    claimLedger: lastClaimLedger,
    claimPassages: claimPassageRefs,
    evidenceConflicts: lastEvidenceConflicts,
    lastSafeStep: missionLedger.lastSafeStep,
    createdAt: runToolContext.now?.() ?? new Date(),
  });
  setLedgerMissionPlan(
    missionLedger,
    missionPlan,
    runToolContext.now?.() ?? new Date(),
  );
  const dependencyStatus = buildDependencyStatus({
    toolContext: runToolContext,
    runPlan,
    missionIntent,
  });
  setLedgerDependencyStatus(
    missionLedger,
    dependencyStatus,
    runToolContext.now?.() ?? new Date(),
  );
  if (checkpointResumeContext !== null) {
    markLedgerResumeLoaded(
      missionLedger,
      activeIntentPrompt,
      runToolContext.now?.() ?? new Date(),
    );
  }
  addMissionMilestone(
    missionLedger,
    {
      step: 0,
      stage: "plan",
      summary: `Route ${runPlan.route} selected with ${runPlan.maxStepsForRun} maximum steps.`,
      decision: runPlan.slowPathReason,
      toolCalls: tools.map((tool) => tool.function.name),
      nextAction: "Start bounded tool/model loop.",
    },
    runToolContext.now?.() ?? new Date(),
  );
  events.onTrace?.({
    id: "structured-intent",
    kind: "mission_intent",
    message: `Structured intent: ${structuredIntent.primary}`,
    outputPreview: structuredIntent,
  });
  const emitLedgerRunConfig = () => {
    if (!missionLedger) {
      return;
    }
    events.onRunConfig?.(
      buildRunConfigEvent({
        runId,
        toolContext: runToolContext,
        enableStreaming,
        activeThink,
        modelOptions,
        writeAutonomy,
        chatOnlyOverride: forceChatOnly,
        missionIntent,
        currentNoteContext: shouldReadCurrentNote || currentNoteContext !== null,
        runPlan,
        streamingWritebackKind,
        directCurrentNoteWritebackKind,
        missionLedger: summarizeMissionLedger(missionLedger),
        reflexOutput,
        performanceGates: evaluatePerformanceGates(metricEvents),
      }),
    );
  };
  const runtimeSnapshotPersistenceAvailable =
    canPersistMissionRuntimeSnapshot(runToolContext);
  const syncRuntimeSnapshotFromRunState = () => {
    if (!runtimeSnapshot || !missionLedger) {
      return;
    }
    const now = runToolContext.now?.() ?? new Date();
    runtimeSnapshot = createMissionRuntimeSnapshot({
      runId,
      originalMission: runtimeSnapshot.originalMission,
      currentNotePath: runtimeSnapshot.currentNotePath,
      rootRunId: runtimeSnapshot.lineage.rootRunId,
      segmentId: runtimeSnapshot.lineage.segmentId,
      segmentIndex: runtimeSnapshot.lineage.segmentIndex,
      parentSegmentId: runtimeSnapshot.lineage.parentSegmentId,
      priorSegmentIds: runtimeSnapshot.lineage.priorSegmentIds,
      status: missionLedgerStatusToRuntimeStatus(missionLedger.status),
      revision: runtimeSnapshot.revision,
      lastSafeStep: missionLedger.lastSafeStep,
      missionPlan,
      researchPlan,
      orchestrator: resolveOrchestratorSnapshot(),
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      operationGoals: operationGoals.goals,
      recovery: recoveryState,
      operationJournal: runtimeSnapshot.operationJournal,
      acceptance: normalizeRuntimeAcceptance(missionLedger.acceptance),
      claimLedger: lastClaimLedger,
      claimPassages: claimPassageRefs,
      evidenceConflicts: lastEvidenceConflicts,
      notes: runtimeSnapshot.notes,
      createdAt: new Date(runtimeSnapshot.createdAt),
      updatedAt: now,
    });
  };
  const persistRuntimeSnapshot = async (
    traceId: string,
    { required = false }: { required?: boolean } = {},
  ): Promise<boolean> => {
    if (!runtimeSnapshot) {
      return false;
    }
    syncRuntimeSnapshotFromRunState();
    try {
      const result = await writeMissionRuntimeSnapshot(
        runToolContext,
        runtimeSnapshot,
      );
      if (result) {
        events.onTrace?.({
          id: `${traceId}:runtime`,
          kind: "status",
          path: result.path,
          message: `Saved resumable runtime snapshot revision ${result.revision}.`,
          outputPreview: {
            version: runtimeSnapshot.version,
            revision: result.revision,
            rootRunId: runtimeSnapshot.lineage.rootRunId,
            segmentIndex: runtimeSnapshot.lineage.segmentIndex,
            lastSafeStep: runtimeSnapshot.lastSafeStep,
          },
        });
        return true;
      }
      if (required) {
        throw new Error(
          "Required runtime snapshot could not be persisted before a vault mutation.",
        );
      }
      return false;
    } catch (error) {
      events.onTrace?.({
        id: `${traceId}:runtime:error`,
        kind: "error",
        message: `Could not save runtime snapshot: ${getUnknownErrorMessage(error)}`,
        error: {
          code: "runtime_snapshot_save_failed",
          message: getUnknownErrorMessage(error),
        },
      });
      if (required) {
        throw error;
      }
      return false;
    }
  };
  const runStreamedWritebackWithJournal = async (
    input: Parameters<typeof streamCurrentNoteWriteback>[0],
    step: number,
  ): Promise<AgentRunReceipt> => {
    const toolName =
      input.kind === "append"
        ? "append_to_current_file"
        : input.kind === "replace"
          ? "replace_current_file"
          : "edit_current_section";
    const operationId = `${runId}:${step}:stream:${input.kind}`;
    let activeRecord: OperationJournalRecord | null = null;
    let durableRecord: OperationJournalRecord | null = null;
    let partialReceipt: AgentRunReceipt | null = null;
    let reconciliationAttempted = false;
    const saveRecord = (record: OperationJournalRecord) => {
      if (!runtimeSnapshot) {
        return;
      }
      activeRecord = record;
      runtimeSnapshot.operationJournal = [
        ...runtimeSnapshot.operationJournal.filter(
          (item) => item.operationId !== record.operationId,
        ),
        record,
      ];
    };
    // Async callbacks update these records. Accessors keep the later
    // reconciliation narrowing honest instead of letting TypeScript assume
    // the closure-owned values are still null.
    const getActiveRecord = (): OperationJournalRecord | null => activeRecord;
    const getDurableRecord = (): OperationJournalRecord | null => durableRecord;
    const persistRecord = async (traceId: string, required: boolean) => {
      const persisted = await persistRuntimeSnapshot(traceId, { required });
      if (persisted && activeRecord) {
        durableRecord = activeRecord;
      }
      return persisted;
    };

    if (runtimeSnapshot) {
      const targetPath =
        runtimeSnapshot.currentNotePath ??
        runToolContext.getCurrentMarkdownFile?.()?.path;
      const intentRecord = createOperationJournalRecord({
        operationId,
        rootRunId: runtimeSnapshot.lineage.rootRunId,
        segmentId: runtimeSnapshot.lineage.segmentId,
        nodeId: missionPlan?.activeTaskId ?? undefined,
        toolName,
        operation: input.kind,
        targetPath,
        inputHash: hashOperationInput({
          kind: input.kind,
          targetPath,
          heading: input.preparedSectionEdit?.heading,
        }),
        now: runToolContext.now?.() ?? new Date(),
      });
      saveRecord(intentRecord);
      await persistRecord(`${operationId}:wal-intent`, true);
      const applyingRecord = transitionOperationJournalRecord(
        intentRecord,
        "applying",
        {
          message: "Streamed note mutation started after durable intent.",
          now: runToolContext.now?.() ?? new Date(),
        },
      );
      saveRecord(applyingRecord);
      await persistRecord(`${operationId}:wal-applying`, true);
    }

    try {
      let lazyCreatePath: string | null = null;
      let pinnedCreatedFile: ReturnType<
        NonNullable<ToolExecutionContext["getCurrentMarkdownFile"]>
      > = null;
      if (
        noteOutputPlan.destination === "new_note" &&
        !hasActiveCurrentMarkdownFile(runToolContext)
      ) {
        const existingPinned = runtimeSnapshot?.currentNotePath
          ? runToolContext.app.vault.getFileByPath(runtimeSnapshot.currentNotePath)
          : null;
        if (existingPinned) {
          pinnedCreatedFile = existingPinned;
        } else if (runtimeSnapshot?.currentNotePath) {
          lazyCreatePath = runtimeSnapshot.currentNotePath;
        } else {
          const target = resolveAutonomousNoteTarget({
            app: runToolContext.app,
            preferredBasename: "Untitled",
          });
          lazyCreatePath = target.path;
          if (runtimeSnapshot) {
            runtimeSnapshot.currentNotePath = target.path;
          }
        }
      }
      const writebackToolContext: ToolExecutionContext = {
        ...runToolContext,
        getCurrentMarkdownFile: () =>
          pinnedCreatedFile ?? runToolContext.getCurrentMarkdownFile?.() ?? null,
      };
      const receipt = await streamCurrentNoteWriteback({
        ...input,
        toolContext: writebackToolContext,
        lazyCreatePath,
        onNoteCreated: (created) => {
          pinnedCreatedFile =
            writebackToolContext.app.vault.getFileByPath(created.path) ??
            pinnedCreatedFile;
          if (runtimeSnapshot) {
            runtimeSnapshot.currentNotePath = created.path;
          }
          events.onTrace?.({
            id: `${operationId}:autonomous-note-created`,
            kind: "status",
            path: created.path,
            message: `Created note target ${created.path} after first safe content.`,
          });
        },
        missionPrompt: activeIntentPrompt,
        onPartialReceipt: (value) => {
          partialReceipt = value;
        },
      });
      if (activeRecord) {
        const appliedRecord = transitionOperationJournalRecord(
          activeRecord,
          "applied",
          {
            message: "Streamed note mutation finished; receipt verification pending.",
            mutationMayHaveApplied: true,
            now: runToolContext.now?.() ?? new Date(),
          },
        );
        const verifiedRecord = transitionOperationJournalRecord(
          appliedRecord,
          "verified",
          {
            message: "Streamed note mutation produced an observable receipt.",
            receipt,
            now: runToolContext.now?.() ?? new Date(),
          },
        );
        const committedRecord = transitionOperationJournalRecord(
          verifiedRecord,
          "committed",
          {
            message: "Streamed mutation and receipt committed to durable run state.",
            receipt,
            now: runToolContext.now?.() ?? new Date(),
          },
        );
        saveRecord(committedRecord);
        try {
          await persistRecord(`${operationId}:wal-committed`, true);
        } catch (error) {
          const durableAtCommitFailure = getDurableRecord();
          if (durableAtCommitFailure?.state === "applying") {
            reconciliationAttempted = true;
            saveRecord(
              transitionOperationJournalRecord(
                durableAtCommitFailure,
                "reconcile_required",
                {
                  message:
                    "Streamed mutation completed but its committed receipt could not be persisted; inspect before retry.",
                  receipt,
                  error: getUnknownErrorMessage(error),
                  mutationMayHaveApplied: true,
                  now: runToolContext.now?.() ?? new Date(),
                },
              ),
            );
            events.onStatus?.(
              formatFailureCopy(
                walReconcileFailureCopy(
                  "Streamed mutation completed but its committed receipt could not be persisted.",
                ),
              ),
            );
            await persistRecord(`${operationId}:wal-reconcile`, false);
          }
          throw error;
        }
      }
      await publishPlaceholderAutoRename(input.kind, step);
      return receipt;
    } catch (error) {
      const activeAtFailure = getActiveRecord();
      const durableAtFailure = getDurableRecord();
      if (
        !reconciliationAttempted &&
        activeAtFailure &&
        activeAtFailure.state !== "committed"
      ) {
        const baseRecord =
          durableAtFailure?.state === "applying"
            ? durableAtFailure
            : activeAtFailure;
        const mutationMayHaveApplied = partialReceipt !== null;
        const failedRecord = transitionOperationJournalRecord(
          baseRecord,
          mutationMayHaveApplied ? "reconcile_required" : "failed",
          {
            message: mutationMayHaveApplied
              ? "Streamed writeback was interrupted after note content may have changed."
              : "Streamed writeback failed before any note content was written.",
            receipt: partialReceipt ?? undefined,
            error: getUnknownErrorMessage(error),
            mutationMayHaveApplied,
            now: runToolContext.now?.() ?? new Date(),
          },
        );
        saveRecord(failedRecord);
        await persistRecord(`${operationId}:wal-failed`, false);
      }
      throw error;
    }
  };
  const updatePinnedCurrentNotePathFromReceipt = (
    receipt: AgentRunReceipt,
    traceId: string,
  ) => {
    if (!runtimeSnapshot || !receipt.toPath) {
      return;
    }
    const renamedCurrentNote = receipt.toolName === "rename_current_file";
    const movedPinnedCurrentNote =
      receipt.toolName === "move_path" &&
      runtimeSnapshot.currentNotePath !== undefined &&
      receipt.path === runtimeSnapshot.currentNotePath;
    if (!renamedCurrentNote && !movedPinnedCurrentNote) {
      return;
    }
    let nextPath: string;
    try {
      nextPath = normalizeVaultPath(receipt.toPath, { requireMarkdown: true });
    } catch {
      events.onTrace?.({
        id: `${traceId}:current-note-path-invalid`,
        kind: "error",
        toolName: receipt.toolName,
        operation: receipt.operation,
        path: receipt.path,
        toPath: receipt.toPath,
        message:
          "The successful mutation returned an unsafe current-note destination, so the durable note pin was not changed.",
      });
      return;
    }
    const previousPath = runtimeSnapshot.currentNotePath;
    runtimeSnapshot.currentNotePath = nextPath;
    if (previousPath !== nextPath) {
      events.onTrace?.({
        id: `${traceId}:current-note-path`,
        kind: "status",
        toolName: receipt.toolName,
        operation: receipt.operation,
        path: previousPath,
        toPath: nextPath,
        message: `Updated the durable current-note target to ${nextPath}.`,
      });
    }
  };
  const placeholderRenameToAgentReceipt = (
    rename: PlaceholderRenameReceipt,
  ): AgentRunReceipt => ({
    toolName: rename.toolName,
    operation: rename.operation,
    message: rename.message,
    path: rename.path,
    toPath: rename.toPath,
    bytesWritten: 0,
    output: rename.output,
  });
  const publishPlaceholderAutoRename = async (
    kind: StreamingWritebackKind | "append" | "replace" | "edit",
    step: number,
    writtenMarkdown?: string | null,
  ): Promise<AgentRunReceipt | null> => {
    if (kind === "edit") {
      return null;
    }
    try {
      const file = runToolContext.getCurrentMarkdownFile?.() ??
        runToolContext.app.workspace.getActiveFile();
      const noteMarkdown =
        writtenMarkdown ??
        (file
          ? runToolContext.getCurrentMarkdownContent?.(file) ??
            (await runToolContext.app.vault.read(file))
          : null);
      const rename = await maybeAutoTitleAfterWrite({
        toolContext: {
          ...runToolContext,
          autoTitleAuthorized: true,
        },
        prompt: activeIntentPrompt,
        writtenMarkdown: noteMarkdown,
        kind,
      });
      if (!rename) {
        return null;
      }
      const receipt = placeholderRenameToAgentReceipt(rename);
      const statusLabel = /renamed placeholder/i.test(rename.message)
        ? `Renamed placeholder note to ${rename.title}`
        : `Auto-titled note to ${rename.title}`;
      events.onStatus?.(`${statusLabel}...`);
      updatePinnedCurrentNotePathFromReceipt(
        receipt,
        `auto-title-${step}`,
      );
      writeReceipts.push(receipt);
      events.onReceipt?.(receipt);
      await recordLedgerReceipt(receipt, step);
      return receipt;
    } catch (error) {
      events.onStatus?.(
        `Placeholder note rename skipped: ${getUnknownErrorMessage(error)}`,
      );
      events.onTrace?.({
        id: `placeholder-auto-rename-${step}:error`,
        kind: "error",
        message: getUnknownErrorMessage(error),
      });
      return null;
    }
  };
  const persistMissionLedger = async (traceId: string) => {
    if (!missionLedger) {
      return;
    }
    const latestOrchestrator = resolveOrchestratorSnapshot();
    if (latestOrchestrator) {
      missionLedger.orchestrator = latestOrchestrator;
    }
    try {
      const result = await writeMissionLedger(runToolContext, missionLedger);
      emitLedgerRunConfig();
      if (result) {
        events.onTrace?.({
          id: traceId,
          kind: "status",
          path: result.path,
          message: `Saved mission ledger to ${result.path}`,
          outputPreview: summarizeMissionLedger(missionLedger),
        });
      }
    } catch (error) {
      events.onTrace?.({
        id: `${traceId}:error`,
        kind: "error",
        message: `Could not save mission ledger: ${getUnknownErrorMessage(error)}`,
        error: {
          code: "mission_ledger_save_failed",
          message: getUnknownErrorMessage(error),
        },
      });
    }
    await persistRuntimeSnapshot(traceId);
  };
  const preflight = runDependencyPreflight(
    getFatalDependencyRowsForPreflight({
      rows: dependencyStatus,
      missionIntent,
      runPlan,
      shouldReadCurrentNote,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
    }),
  );
  events.onTrace?.({
    id: "dependency-preflight",
    kind: "status",
    message: `Dependency preflight: ${preflight.status}`,
    outputPreview: {
      status: preflight.status,
      rows: dependencyStatus,
    },
  });
  if (!preflight.canStartModelLoop) {
    const blocked = preflight.rows.find((row) => row.status === "blocked");
    const message = blocked
      ? `Blocked before model loop: ${blocked.summary} ${blocked.nextAction}`
      : "Blocked before model loop by dependency preflight.";
    if (missionLedger) {
      addLedgerBlocker(
        missionLedger,
        message,
        blocked?.category ?? "unknown",
        runToolContext.now?.() ?? new Date(),
      );
      setLedgerNextAction(
        missionLedger,
        blocked?.nextAction ?? "Resolve the dependency blocker and retry.",
        runToolContext.now?.() ?? new Date(),
      );
      updateMissionLedgerStatus(
        missionLedger,
        "blocked",
        runToolContext.now?.() ?? new Date(),
      );
      await persistMissionLedger("mission-ledger-preflight-blocked");
    }
    events.onStatus?.(message);
    emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
    completeRun(events, "error", 0, runStartedAt, runPlan.maxStepsForRun);
    return;
  }
  const applyMissionPlanAdvance = (
    advance: {
      plan: MissionPlan;
      changed: boolean;
      meaningfulAction?: string;
    },
    step: number,
    summary: string,
  ) => {
    missionPlan = advance.plan;
    if (!missionLedger || !advance.changed) {
      return;
    }
    setLedgerMissionPlan(
      missionLedger,
      missionPlan,
      runToolContext.now?.() ?? new Date(),
    );
    const activeTask = getActiveMissionPlanTask(missionPlan);
    const nextAction = getNextMissionPlanAction(missionPlan);
    addMissionMilestone(
      missionLedger,
      {
        step,
        stage: missionPlan.status === "complete" ? "verify" : "plan",
        summary,
        decision: advance.meaningfulAction ?? "mission_plan_update",
        evidenceIds: activeTask?.evidenceIds ?? [],
        artifacts: activeTask?.receiptIds ?? [],
        nextAction: nextAction?.summary,
      },
      runToolContext.now?.() ?? new Date(),
    );
  };
  const recordMissionPlanReview = async (step: number, reason: string) => {
    if (!missionLedger || !missionPlan) {
      return;
    }
    setLedgerMissionPlan(
      missionLedger,
      missionPlan,
      runToolContext.now?.() ?? new Date(),
    );
    const activeTask = getActiveMissionPlanTask(missionPlan);
    const nextAction = getNextMissionPlanAction(missionPlan);
    const remainingTasks = countRemainingMissionPlanTasks(missionPlan);
    addMissionMilestone(
      missionLedger,
      {
        step,
        stage: "plan",
        summary: `Mission plan review (${reason}): ${missionPlan.status}; ${remainingTasks} task(s) remaining.`,
        decision: activeTask
          ? `Active task ${activeTask.id}: ${activeTask.status}`
          : "No active task.",
        evidenceIds: activeTask?.evidenceIds ?? [],
        artifacts: activeTask?.receiptIds ?? [],
        nextAction: nextAction?.summary ?? "Prepare final answer.",
      },
      runToolContext.now?.() ?? new Date(),
    );
    events.onTrace?.({
      id: `mission-plan-review-${step}-${reason}`,
      kind: "status",
      step,
      message: "Mission plan reviewed.",
      outputPreview: missionPlan,
    });
    await persistMissionLedger(`mission-ledger-plan-review-${step}`);
  };
  const evaluateCurrentAcceptance = (
    finalOutput?: string,
  ): MissionAcceptanceResult => {
    refreshEvidenceConflicts();
    const baseAcceptance = evaluateMissionPlanAcceptance({
      prompt: activeIntentPrompt,
      missionIntent,
      requiredTools: [...new Set(requiredWriteTools)],
      successfulTools: successfulToolNames,
      failedTools: failedToolNames.filter(
        (toolName) => !successfulToolNames.includes(toolName),
      ),
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      finalOutput,
      operationGoals: operationGoals.goals,
      researchPlan,
      plan: missionPlan,
      conflicts: lastEvidenceConflicts,
    });
    // Claim → passage grounding is prompt-driven (cite / passage / deep research /
    // verify). Auto deep_web from "current/latest" market language alone must not
    // block ordinary sourced writeback when the model uses URL citations instead
    // of passage ids; research acceptance still enforces fetched-source coverage.
    const requireClaimGrounding = shouldRequireClaimGrounding(activeIntentPrompt);
    const verification = runMissionVerifiers({
      plan: missionPlan,
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      finalOutput,
      baseAcceptance,
      prompt: activeIntentPrompt,
      researchMode: researchPlan?.mode,
      passages: claimPassageRefs,
      conflicts: lastEvidenceConflicts,
      requireClaimGrounding,
      now: runToolContext.now?.() ?? new Date(),
    });
    lastVerificationChecks = verification.checks;
    if (verification.claimLedger) {
      lastClaimLedger = verification.claimLedger;
    }
    let acceptance = mergeVerificationIntoAcceptance(
      baseAcceptance,
      verification,
    );
    if (verification.claimLedger) {
      acceptance = mergeClaimGroundingIntoAcceptance(
        acceptance,
        verification.claimLedger,
      );
    }
    // Final acceptance only after verify-complete for research-bearing missions.
    const phase = refreshResearchPhase(
      hasRequiredActionReceipt(missionPlan, writeReceipts) &&
        (buildClaimConflictState()?.analyzeComplete !== false),
    );
    return gateAcceptanceByResearchPhase(acceptance, phase);
  };
  const hasSatisfiedDurablePreWriteProof = (): boolean => {
    const requiresPreWriteProof = Boolean(
      missionPlan?.tasks.some((task) =>
        task.completionContract.requiredProof.some(isBlockingPreWriteProof),
      ),
    );
    return (
      requiresPreWriteProof &&
      !evaluateCurrentAcceptance().missing.some(isBlockingPreWriteProof)
    );
  };
  const shouldContinueForMissionAcceptance = (
    acceptance: MissionAcceptanceResult,
    step: number,
    stepLimit: number,
  ): boolean => {
    if (step >= stepLimit || acceptance.status === "pass") {
      return false;
    }

    const missing = new Set(acceptance.missing);
    if (
      missing.has("write_receipt") ||
      missing.has("visible_title_rename") ||
      missing.has("highlight_receipt") ||
      acceptance.missing.some(
        (item) => item.startsWith("pending_goal:") || item.startsWith("failed_goal:"),
      )
    ) {
      return requiredWriteTools.some((toolName) => allowedToolNames.has(toolName));
    }

    if (missing.has("web_evidence")) {
      return allowedToolNames.has("web_search") || allowedToolNames.has("web_fetch");
    }

    if (
      acceptance.missing.some(
        (item) =>
          item.startsWith("fetched_sources") ||
          item.startsWith("distinct_domains") ||
          item === "research_plan_items",
      )
    ) {
      return (
        allowedToolNames.has("web_search") ||
        allowedToolNames.has("web_fetch") ||
        allowedToolNames.has("semantic_search_notes") ||
        allowedToolNames.has("inspect_vault_context") ||
        allowedToolNames.has("read_markdown_files") ||
        allowedToolNames.has("read_file")
      );
    }

    if (missing.has("word_count")) {
      return allowedToolNames.has("count_words");
    }

    if (missing.has("vault_evidence")) {
      return (
        /\b(before answering|must|need to|have to|verify)\b/i.test(activeIntentPrompt) &&
        [
          "inspect_vault_context",
          "semantic_search_notes",
          "search_markdown_files",
          "read_markdown_files",
          "read_file",
        ].some((toolName) => allowedToolNames.has(toolName))
      );
    }

    return false;
  };
  const isPendingRequiredWriteReady = (
    toolName: string,
    pendingRequiredWrites: string[],
  ): boolean => {
    const outstandingDistinctWrite =
      requiredWriteTools.includes(toolName) &&
      !successfulToolNames.includes(toolName);
    if (!pendingRequiredWrites.includes(toolName) && !outstandingDistinctWrite) {
      return false;
    }
    if (!isContentWriteToolThatNeedsEvidence(toolName)) {
      return true;
    }
    return !evaluateCurrentAcceptance().missing.some(isBlockingPreWriteProof);
  };
  const recordMissionAcceptance = async (
    acceptance: MissionAcceptanceResult,
    step: number,
    { advancePlan = true }: { advancePlan?: boolean } = {},
  ) => {
    events.onTrace?.({
      id: `mission-acceptance-${step}`,
      kind: "acceptance",
      step,
      message: `Mission acceptance: ${acceptance.status}`,
      outputPreview: acceptance,
    });
    for (const check of lastVerificationChecks) {
      events.onTrace?.({
        id: `${check.id}-${step}`,
        kind: "verification",
        step,
        message: `${check.kind}: ${check.status}`,
        outputPreview:
          check.kind === "claim_grounding" && lastClaimLedger
            ? {
                ...check,
                claimLedger: {
                  status: lastClaimLedger.status,
                  claimCount: lastClaimLedger.claims.length,
                  grounded: lastClaimLedger.claims.filter(
                    (claim) => claim.status === "grounded",
                  ).length,
                  ungrounded: lastClaimLedger.claims.filter(
                    (claim) =>
                      claim.status === "ungrounded" ||
                      claim.status === "invalid_citation",
                  ).length,
                  missing: lastClaimLedger.missing,
                  nextAction: lastClaimLedger.nextAction,
                },
              }
            : check.kind === "evidence_conflicts"
              ? {
                  ...check,
                  openConflicts: evidenceConflictsToProofDebtRows(
                    lastEvidenceConflicts,
                  ),
                  conflictCount: lastEvidenceConflicts.length,
                  openConflictCount: listOpenEvidenceConflicts(
                    lastEvidenceConflicts,
                  ).length,
                }
              : check,
      });
    }
    if (
      listOpenEvidenceConflicts(lastEvidenceConflicts).length > 0 &&
      !lastVerificationChecks.some((check) => check.kind === "evidence_conflicts")
    ) {
      const openConflicts = evidenceConflictsToProofDebtRows(lastEvidenceConflicts);
      events.onTrace?.({
        id: `evidence-conflicts-${step}`,
        kind: "verification",
        step,
        message: `evidence_conflicts: open=${openConflicts.length}`,
        outputPreview: {
          kind: "evidence_conflicts",
          status: "needs_more_work",
          openConflicts,
          conflictCount: lastEvidenceConflicts.length,
          openConflictCount: openConflicts.length,
        },
      });
    }
    if (!missionLedger) {
      return;
    }
    if (missionPlan && advancePlan) {
      applyMissionPlanAdvance(
        advanceMissionPlanFromAcceptance({
          plan: missionPlan,
          acceptance,
          now: runToolContext.now?.() ?? new Date(),
        }),
        step,
        `Mission plan checked against acceptance: ${acceptance.status}.`,
      );
    }
    setLedgerAcceptance(
      missionLedger,
      acceptance,
      runToolContext.now?.() ?? new Date(),
    );
    if (lastClaimLedger) {
      setLedgerClaimLedger(
        missionLedger,
        lastClaimLedger,
        runToolContext.now?.() ?? new Date(),
      );
    }
    if (claimPassageRefs.length > 0) {
      setLedgerClaimPassages(
        missionLedger,
        claimPassageRefs,
        runToolContext.now?.() ?? new Date(),
      );
    }
    setLedgerEvidenceConflicts(
      missionLedger,
      lastEvidenceConflicts,
      runToolContext.now?.() ?? new Date(),
    );
    addMissionMilestone(
      missionLedger,
      {
        step,
        stage: "verify",
        summary: `Mission acceptance ${acceptance.status}.`,
        decision: acceptance.reasons.join("; "),
        nextAction: acceptance.nextAction,
      },
      runToolContext.now?.() ?? new Date(),
    );
  };
  const maybeExtractResearchMemory = async (
    acceptance: MissionAcceptanceResult,
    stopReason: AgentRunStopReason,
    step: number,
  ) => {
    if (
      acceptance.status !== "pass" ||
      stopReason !== "final" ||
      runToolContext.settings?.researchMemoryEnabled !== true ||
      !runtimeSnapshotPersistenceAvailable ||
      !missionLedger ||
      successfulToolNames.includes("append_research_memory")
    ) {
      return;
    }
    const extraction = buildResearchMemoryExtraction({
      mission: activeIntentPrompt,
      finalOutput: lastFinalOutput,
      evidence: missionLedger.evidence,
    });
    if (!extraction) {
      return;
    }
    try {
      const result = await runObservedModelToolCall({
        origin: "runner",
        toolCall: {
          name: "append_research_memory",
          arguments: {
            topic: extraction.topic,
            text: extraction.text,
            keywords: extraction.keywords,
            ...(extraction.sourcePaths.length
              ? { sourcePaths: extraction.sourcePaths }
              : {}),
            ...(extraction.sourceUrls.length
              ? { sourceUrls: extraction.sourceUrls }
              : {}),
          },
        },
        step,
        toolIndex: "auto-research-memory",
        recordTranscript: false,
      });
      if (!result.ok || !isRecord(result.output)) {
        return;
      }
      const path = getString(result.output.path);
      const operation = result.output.operation;
      if (!path || result.output.duplicate === true) {
        return;
      }
      events.onStatus?.(`Saved research memory: ${extraction.topic}`);
      events.onTrace?.({
        id: `research-memory-auto-${step}`,
        kind: "status",
        step,
        toolName: "append_research_memory",
        message: `Auto-saved research memory for topic: ${extraction.topic}`,
        outputPreview: {
          path,
          operation,
          sourceUrls: extraction.sourceUrls,
        },
      });
    } catch (error) {
      events.onTrace?.({
        id: `research-memory-auto-${step}-failed`,
        kind: "status",
        step,
        toolName: "append_research_memory",
        message: `Research memory auto-save skipped: ${getErrorMessage(error)}`,
      });
    }
  };
  const finishRun = async (
    stopReason: AgentRunStopReason,
    step: number,
    maxSteps = runPlan.maxStepsForRun,
    nextAction?: string,
  ) => {
    if (missionPlan && lastFinalOutput.trim()) {
      applyMissionPlanAdvance(
        advanceMissionPlanFromFinalOutput({
          plan: missionPlan,
          finalOutput: lastFinalOutput,
          now: runToolContext.now?.() ?? new Date(),
        }),
        step,
        "Mission plan observed final output.",
      );
    }
    const acceptance = evaluateCurrentAcceptance(lastFinalOutput || undefined);
    const effectiveStopReason =
      (stopReason === "final" || stopReason === "write_completed") &&
        acceptance.status !== "pass"
        ? "budget"
        : stopReason;
    await recordMissionAcceptance(acceptance, step, {
      // A budget/user stop is resumable. Persist the acceptance diagnosis but
      // do not turn a repairable, unfinished active task into a blocked task.
      advancePlan:
        effectiveStopReason !== "budget" &&
        effectiveStopReason !== "user_stopped",
    });
    if (effectiveStopReason !== stopReason) {
      events.onStatus?.(
        `Completion held for verification: ${acceptance.missing.join(", ")}.`,
      );
      events.onTrace?.({
        id: `terminal-acceptance-gate-${step}`,
        kind: "acceptance",
        step,
        message: "Terminal completion was downgraded to a resumable stop.",
        outputPreview: {
          requestedStopReason: stopReason,
          effectiveStopReason,
          acceptance,
        },
      });
    }
    await maybeExtractResearchMemory(acceptance, effectiveStopReason, step);
    if (missionLedger) {
      updateMissionLedgerStatus(
        missionLedger,
        getMissionLedgerStatusForStopReason(effectiveStopReason),
        runToolContext.now?.() ?? new Date(),
      );
      setLedgerNextAction(
        missionLedger,
        nextAction ??
          acceptance.nextAction ??
          getStopReasonMessage(effectiveStopReason),
        runToolContext.now?.() ?? new Date(),
      );
      await persistMissionLedger(`mission-ledger-complete-${effectiveStopReason}`);
    }
    // Agent B: thin completion-reflection hook before auto-continue decision.
    const proofDebtSnapshot = runtimeSnapshot
      ? proofDebtSnapshotFromRuntime(runtimeSnapshot, {
          blockers: missionLedger?.blockers,
          blockerCategory: missionLedger?.blockerCategory,
          acceptance,
        })
      : missionLedger
        ? proofDebtSnapshotFromLedger(missionLedger, { acceptance })
        : {
            acceptance,
            missionPlan,
            researchPlan,
          };
    const proofDebtForFinish = computeProofDebt(proofDebtSnapshot);
    const pendingGoalIds = Object.entries(operationGoals.goals)
      .filter(([, state]) => state === "pending" || state === "failed")
      .map(([goalId]) => goalId);
    const completionReflection = reflectMissionCompletion({
      prompt: activeIntentPrompt,
      acceptance,
      proofDebt: proofDebtForFinish,
      writeReceiptCount: writeReceipts.length,
      pendingGoalIds,
      missionPlanStatus: missionPlan?.status,
    });
    if (!completionReflection.done && effectiveStopReason === "budget") {
      events.onTrace?.({
        id: `completion-reflection-${step}`,
        kind: "status",
        step,
        message: `Completion reflection: ${completionReflection.reason}`,
        outputPreview: completionReflection,
      });
    }
    const autoContinuation = decideAutoContinuation({
      stopReason: effectiveStopReason,
      acceptance,
      blockerCategory: missionLedger?.blockerCategory,
      blockerCount: missionLedger?.blockers.length ?? 0,
      missionPlanStatus: missionPlan?.status,
      proofDebt: proofDebtForFinish,
      completionDriven: runToolContext.settings?.completionDrivenLoops !== false,
      reflection: completionReflection,
    });
    for (const gate of evaluatePerformanceGates(metricEvents).filter(
      (item) => item.status !== "pass",
    )) {
      events.onTrace?.({
        id: `performance-gate-${gate.name}-${step}`,
        kind: "metric",
        step,
        message: `Performance gate ${gate.status}: ${gate.name}`,
        outputPreview: gate,
      });
    }
    completeRun(
      events,
      effectiveStopReason,
      step,
      runStartedAt,
      maxSteps,
      autoContinuation,
    );
  };
  const recordLedgerToolResult = async (
    toolName: string,
    result: ToolExecutionResult,
    step: number,
  ) => {
    if (!missionLedger) {
      return;
    }
    const evidence = result.ok ? evidenceFromToolResult(toolName, result) : null;
    if (missionPlan) {
      applyMissionPlanAdvance(
        advanceMissionPlanFromToolResult({
          plan: missionPlan,
          toolName,
          result,
          evidence,
          now: runToolContext.now?.() ?? new Date(),
        }),
        step,
        `Mission plan advanced after tool ${toolName}.`,
      );
    }
    if (!result.ok) {
      addMissionMilestone(
        missionLedger,
        {
          step,
          stage: "next_action",
          summary: `Tool failed: ${toolName}.`,
          decision: result.error?.code,
          toolCalls: [toolName],
          error: result.error?.message,
          nextAction: getNextMissionPlanAction(missionPlan)?.summary,
        },
        runToolContext.now?.() ?? new Date(),
      );
      await persistMissionLedger(`mission-ledger-tool-${toolName}-failed`);
      return;
    }
    markLedgerToolUsed(
      missionLedger,
      toolName,
      evidence?.id,
      runToolContext.now?.() ?? new Date(),
    );
    if (evidence) {
      upsertMissionEvidenceRecord(missionEvidenceRecords, evidence);
      upsertLedgerEvidence(
        missionLedger,
        evidence,
        runToolContext.now?.() ?? new Date(),
      );
      if (researchPlan) {
        researchPlan = applyResearchEvidence(researchPlan, missionEvidenceRecords);
        setLedgerResearchPlan(
          missionLedger,
          researchPlan,
          runToolContext.now?.() ?? new Date(),
        );
      }
    }
    if (result.ok) {
      const passages = claimPassagesFromToolResult(toolName, result);
      if (passages.length > 0) {
        upsertClaimPassageRefs(claimPassageRefs, passages);
        setLedgerClaimPassages(
          missionLedger,
          claimPassageRefs,
          runToolContext.now?.() ?? new Date(),
        );
        refreshEvidenceConflicts();
        setLedgerEvidenceConflicts(
          missionLedger,
          lastEvidenceConflicts,
          runToolContext.now?.() ?? new Date(),
        );
        refreshResearchPhase(false);
      }
    }
    addMissionMilestone(
      missionLedger,
      {
        step,
        stage: getMilestoneStageForTool(toolName),
        summary: `Tool completed: ${toolName}.`,
        decision: "Recorded observable tool result.",
        toolCalls: [toolName],
        evidenceIds: evidence ? [evidence.id] : [],
        artifacts: evidence?.path ? [evidence.path] : [],
      },
      runToolContext.now?.() ?? new Date(),
    );
    await persistMissionLedger(`mission-ledger-tool-${toolName}`);
  };
  const recordLedgerReceipt = async (receipt: AgentRunReceipt, step = lastStep) => {
    if (!missionLedger) {
      return;
    }
    const evidence = evidenceFromReceipt(receipt);
    upsertLedgerEvidence(
      missionLedger,
      evidence,
      runToolContext.now?.() ?? new Date(),
    );
    if (researchPlan) {
      upsertMissionEvidenceRecord(missionEvidenceRecords, evidence);
      researchPlan = applyResearchEvidence(researchPlan, missionEvidenceRecords);
      setLedgerResearchPlan(
        missionLedger,
        researchPlan,
        runToolContext.now?.() ?? new Date(),
      );
    }
    addLedgerReceipt(
      missionLedger,
      evidence.id,
      runToolContext.now?.() ?? new Date(),
    );
    if (missionPlan) {
      applyMissionPlanAdvance(
        advanceMissionPlanFromReceipt({
          plan: missionPlan,
          receipt,
          evidenceId: evidence.id,
          now: runToolContext.now?.() ?? new Date(),
        }),
        step,
        `Mission plan advanced after receipt ${receipt.operation}.`,
      );
    }
    markLedgerToolUsed(
      missionLedger,
      receipt.toolName,
      evidence.id,
      runToolContext.now?.() ?? new Date(),
    );
    addMissionMilestone(
      missionLedger,
      {
        step,
        stage: "write_save",
        summary: receipt.message,
        decision: receipt.operation,
        toolCalls: [receipt.toolName],
        evidenceIds: [evidence.id],
        artifacts: receipt.path ? [receipt.path] : [],
      },
      runToolContext.now?.() ?? new Date(),
    );
    await persistMissionLedger(`mission-ledger-receipt-${receipt.operation}`);
  };
  const recordLedgerBlocker = (blocker: string) => {
    if (!missionLedger) {
      return;
    }
    if (missionPlan) {
      applyMissionPlanAdvance(
        advanceMissionPlanFromBlocker({
          plan: missionPlan,
          blocker,
          now: runToolContext.now?.() ?? new Date(),
        }),
        lastStep,
        "Mission plan recorded blocker.",
      );
    }
    addLedgerBlocker(
      missionLedger,
      blocker,
      classifyBlockerCategory(blocker),
      runToolContext.now?.() ?? new Date(),
    );
  };
  const finishErroredRunFromException = async (
    error: unknown,
    step: number,
    maxSteps: number,
    source: "model" | "tool",
  ) => {
    const errorMessage =
      source === "model"
        ? formatModelFailureCopy(
            error instanceof ModelClientError
              ? { category: error.category, message: error.message }
              : { message: getUnknownErrorMessage(error) },
          )
        : getUnknownErrorMessage(error);
    const message =
      source === "model"
        ? `Model step failed: ${errorMessage}`
        : `Tool execution failed: ${errorMessage}`;
    const continuationCommand = missionLedger?.continuationCommand ?? "continue";
    const nextAction = `${message} Resolve the blocker, then run "${continuationCommand}".`;
    events.onStatus?.(message);
    events.onPhaseChange?.("error", message);
    events.onTrace?.({
      id: `${source}-error-${step}`,
      kind: "error",
      step,
      message,
      error: {
        code: `${source}_step_failed`,
        message: errorMessage,
      },
    });
    lastFinalOutput = nextAction;
    emitDirectAssistantAnswer(nextAction, events, runPlan.requiresEnglishGuard);
    recordLedgerBlocker(message);
    await finishRun("error", step, maxSteps, nextAction);
  };
  const runProofGatedCurrentNoteWriteback = async (
    input: Parameters<typeof streamCurrentNoteWriteback>[0],
    step: number,
    maxSteps = runPlan.maxStepsForRun,
  ): Promise<AgentRunReceipt | null> => {
    const plannedToolName =
      input.kind === "append"
        ? "append_to_current_file"
        : input.kind === "replace"
          ? "replace_current_file"
          : "edit_current_section";
    const activeTaskForWrite = getActiveMissionPlanTask(missionPlan);
    const pendingRequiredWrites = getPendingRequiredWriteToolNames(
      operationGoals,
      requiredWriteTools,
    );
    if (
      missionPlan &&
      !isToolAllowedForActiveMissionTask(missionPlan, plannedToolName) &&
      !isPendingRequiredWriteReady(plannedToolName, pendingRequiredWrites)
    ) {
      const activeTask = activeTaskForWrite;
      const nextAction = getNextMissionPlanAction(missionPlan)?.summary;
      const message = activeTask
        ? `Note writeback was deferred until active task ${activeTask.id} is complete. The existing note is unchanged.`
        : "Note writeback was deferred because the mission plan has no ready mutation task. The existing note is unchanged.";
      events.onStatus?.(message);
      events.onTrace?.({
        id: `proof-gated-writeback-${step}:plan-dependency-rejected`,
        kind: "tool_rejected",
        step,
        toolName: plannedToolName,
        message,
        outputPreview: {
          activeTaskId: activeTask?.id,
          allowedTools: activeTask?.allowedTools ?? [],
          nextAction,
        },
        error: {
          code: "plan_dependency_violation",
          message,
        },
      });
      await finishRun("budget", step, maxSteps, nextAction ?? message);
      return null;
    }

    if (!requiresVerifiedFinalOutput(missionPlan, researchPlan)) {
      return runStreamedWritebackWithJournal(input, step);
    }

    // Tool result payloads are deliberately compact and provider adapters may
    // normalize them further. Re-bind the canonical, persisted evidence to the
    // staged writeback request so both the first draft and its single repair
    // pass can cite the exact source and passage ids that acceptance verifies.
    const verifiedEvidenceContext = formatDurableEvidenceForWriteback(
      missionEvidenceRecords,
    );
    if (
      missionEvidenceRecords.length > 0 &&
      !input.messages.some(
        (message) =>
          message.role === "system" &&
          message.content === verifiedEvidenceContext,
      )
    ) {
      input.messages.push({
        role: "system" as const,
        content: verifiedEvidenceContext,
      });
    }

    const stageCandidate = async (retry: boolean): Promise<string> => {
      const response = await emitFinalAnswer({
        modelClient: input.modelClient,
        messages: input.messages,
        events: input.events,
        enableStreaming: true,
        fallbackContent: "",
        finalInstruction: buildStreamingWritebackPrompt(
          input.kind,
          input.preparedSectionEdit,
          retry,
          {
            missionPrompt: input.missionPrompt ?? activeIntentPrompt,
            activeBasename:
              runToolContext.getCurrentMarkdownFile?.()?.basename ??
              runToolContext.app.workspace.getActiveFile()?.basename ??
              undefined,
          },
        ),
        metricName: retry
          ? "verified_writeback_candidate_correction"
          : "verified_writeback_candidate",
        relevancePrompt: input.relevancePrompt,
        think: input.think,
        options: input.options,
        abortSignal: input.abortSignal,
        onThinkingUnsupported: input.onThinkingUnsupported,
        deferVisibleOutput: true,
      });
      return response?.message.content ?? "";
    };

    let candidate = await stageCandidate(false);
    let candidateAcceptance = getProofGatedWritebackCandidateAcceptance(
      evaluateCurrentAcceptance(candidate),
      requiredWriteTools,
    );
    events.onTrace?.({
      id: `proof-gated-writeback-${step}:candidate-1`,
      kind: "verification",
      step,
      message: `Held writeback candidate verification: ${candidateAcceptance.status}.`,
      outputPreview: candidateAcceptance,
    });

    if (
      candidateAcceptance.status !== "pass" &&
      !finalOutputCorrectionUsed &&
      candidateAcceptance.missing.length > 0 &&
      candidateAcceptance.missing.every(isRepairableFinalOutputProof)
    ) {
      finalOutputCorrectionUsed = true;
      events.onStatus?.(
        `Writeback draft held for verification: ${candidateAcceptance.missing.join(", ")}. Requesting one correction...`,
      );
      input.messages.push({
        role: "system" as const,
        content: buildFinalOutputVerificationCorrectionPrompt(
          candidateAcceptance,
          candidate,
          activeIntentPrompt,
        ),
      });
      candidate = await stageCandidate(true);
      candidateAcceptance = getProofGatedWritebackCandidateAcceptance(
        evaluateCurrentAcceptance(candidate),
        requiredWriteTools,
      );
      events.onTrace?.({
        id: `proof-gated-writeback-${step}:candidate-2`,
        kind: "verification",
        step,
        message: `Corrected writeback candidate verification: ${candidateAcceptance.status}.`,
        outputPreview: candidateAcceptance,
      });
    }

    if (candidateAcceptance.status !== "pass") {
      lastFinalOutput = "";
      const message =
        `Note writeback was not applied because proof verification is incomplete: ${
          candidateAcceptance.missing.join(", ") || "unknown proof"
        }. The existing note is unchanged and the run remains resumable.`;
      events.onStatus?.(message);
      emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
      await finishRun(
        "budget",
        step,
        maxSteps,
        candidateAcceptance.nextAction ?? message,
      );
      return null;
    }

    lastFinalOutput = candidate;
    return runStreamedWritebackWithJournal(
      {
        ...input,
        stagedContent: candidate,
      },
      step,
    );
  };
  const hasExposedWriteTool = (): boolean => {
    for (const name of allowedToolNames) {
      if (WRITE_TOOL_NAMES.has(name) || DELETE_TOOL_NAMES.has(name)) {
        return true;
      }
    }
    return false;
  };
  const requestRunnerToolApproval = async ({
    toolCall,
    step,
    action,
    reason,
    policyTags,
    timeoutMs,
    preparedAction,
    confirmationIndex,
    requiredConfirmations,
  }: {
    toolCall: ModelToolCall;
    step: number;
    action: string;
    reason: string;
    policyTags: string[];
    timeoutMs?: number;
    preparedAction?: PreparedAction;
    confirmationIndex?: number;
    requiredConfirmations?: 1 | 2;
  }): Promise<{ decision: ApprovalDecision; request: ApprovalRequest }> => {
    let emittedRequest: ApprovalRequest | null = null;
    const decision = await approvalBroker.request(
      {
        runId,
        toolName: toolCall.name,
        action,
        reason,
        policyTags,
        ...(preparedAction
          ? {
              preparedAction,
              payloadFingerprint: preparedAction.payloadFingerprint,
              confirmationIndex: confirmationIndex ?? 1,
              requiredConfirmations: requiredConfirmations ?? 1,
            }
          : {}),
      },
      {
        timeoutMs,
        abortSignal,
        onRequest: async (request) => {
          emittedRequest = request;
          await events.onApprovalRequest?.(request);
          events.onTrace?.({
            id: `${request.id}:requested`,
            kind: "status",
            step,
            toolName: toolCall.name,
            message: `Approval required for ${toolCall.name}: ${request.reason}`,
            outputPreview: {
              action: request.action,
              policyTags: request.policyTags,
              expiresAtMs: request.expiresAtMs,
              payloadFingerprint: request.payloadFingerprint,
              confirmationIndex: request.confirmationIndex,
              requiredConfirmations: request.requiredConfirmations,
            },
          });
        },
      },
    );
    const request =
      emittedRequest ??
      approvalBroker.getPending().find((item) => item.toolName === toolCall.name) ??
      {
        id: `approval-${runId}-unknown`,
        runId,
        toolName: toolCall.name,
        action,
        reason,
        policyTags,
        expiresAtMs: Date.now(),
        ...(preparedAction
          ? {
              preparedAction,
              payloadFingerprint: preparedAction.payloadFingerprint,
              confirmationIndex: confirmationIndex ?? 1,
              requiredConfirmations: requiredConfirmations ?? 1,
            }
          : {}),
      };
    await events.onApprovalResolved?.({ request, decision });
    if (missionLedger) {
      addLedgerApproval(
        missionLedger,
        {
          id: request.id,
          toolName: toolCall.name,
          action: request.action,
          decision,
        },
        runToolContext.now?.() ?? new Date(),
      );
    }
    events.onTrace?.({
      id: `${request.id}:resolved`,
      kind: "status",
      step,
      toolName: toolCall.name,
      message: `Approval ${decision} for ${toolCall.name}.`,
      outputPreview: {
        action: request.action,
        decision,
      },
    });
    return { decision, request };
  };
  const buildApprovalDeniedResult = (
    toolCall: ModelToolCall,
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): ToolExecutionResult => ({
    ok: false,
    toolName: toolCall.name,
    mutationState: "not_applied",
    output: {
      status: "blocked",
      toolName: toolCall.name,
      approval: {
        id: request.id,
        decision,
      },
      reason: `Approval ${decision}.`,
    },
    error: {
      code: `approval_${decision}`,
      message: `Tool ${toolCall.name} was not run because approval was ${decision}.`,
    },
  });
  const executeToolWithRunnerApproval = async ({
    toolCall,
    step,
    operationId,
    beforeExecute,
  }: {
    toolCall: ModelToolCall;
    step: number;
    operationId?: string;
    beforeExecute?: (
      preparedAction?: PreparedAction,
      descriptor?: ToolDescriptor,
      authorization?: AuthorizedActionContext,
    ) => Promise<void>;
  }): Promise<ToolExecutionResult> => {
    const runToolNow = async (toolContext: ToolExecutionContext) => {
      await beforeExecute?.(
        undefined,
        toolRegistry.getDescriptor?.(toolCall.name) ?? undefined,
      );
      if (toolCall.name === "run_code_block") {
        executedCodeRunCount += 1;
      }
      return executeToolWithMetrics({
        toolRegistry,
        toolCall,
        toolContext: operationId
          ? { ...toolContext, operationId }
          : toolContext,
        events,
        step,
      });
    };
    const policyRouted = resolvePolicyRoutedIntent({
      mode: modelRouterMode,
      modelIntent: routedModelIntent,
      missionIntent,
      writeAutonomy,
      writeToolExposed: hasExposedWriteTool(),
    });
    if (modelRouterMode === "authority") {
      routedMissionIntent = policyRouted.intent;
      if (policyRouted.source === "regex" && policyRouted.fallbackReason) {
        events.onTrace?.({
          id: `${step}:${toolCall.name}:router-authority-fallback`,
          kind: "status",
          step,
          toolName: toolCall.name,
          message: `Router authority fallback to regex: ${policyRouted.fallbackReason}`,
          outputPreview: {
            fallbackReason: policyRouted.fallbackReason,
            modelIntent: routedModelIntent,
            resolvedIntent: policyRouted.intent,
          },
        });
      }
    }
    researchPhaseDescriptor = refreshResearchPhase(
      hasRequiredActionReceipt(missionPlan, writeReceipts) &&
        (buildClaimConflictState()?.analyzeComplete !== false),
    );
    const phaseTransition = buildResearchPhaseTransition(
      lastResearchPhase,
      researchPhaseDescriptor,
    );
    if (phaseTransition) {
      lastResearchPhase = phaseTransition.to;
      events.onTrace?.({
        id: `research-phase:${phaseTransition.to}:${step}`,
        kind: "status",
        step,
        message: `Research phase → ${phaseTransition.to}: ${phaseTransition.reason}`,
        outputPreview: {
          from: phaseTransition.from,
          to: phaseTransition.to,
          reason: phaseTransition.reason,
          writeToolsAllowed: researchPhaseDescriptor.writeToolsAllowed,
          acceptanceAllowed: researchPhaseDescriptor.acceptanceAllowed,
        },
      });
    }
    const buildPolicyBlockedResult = (
      policyDecision: PolicyDecision,
    ): ToolExecutionResult => {
      const phaseTag = policyDecision.tags.find((tag) =>
        tag.startsWith("research_phase_gate"),
      );
      const blockedCopy = phaseTag
        ? formatFailureCopy(
            phaseGateFailureCopy(
              policyDecision.tags.find(
                (tag) =>
                  tag === "gather" ||
                  tag === "analyze" ||
                  tag === "write" ||
                  tag === "verify",
              ) ?? researchPhaseDescriptor?.phase,
              policyDecision.reason,
            ),
          )
        : formatFailureCopy(
            policyBlockFailureCopy(toolCall.name, policyDecision.reason),
          );
      events.onTrace?.({
        id: `${step}:${toolCall.name}:policy-blocked`,
        kind: "status",
        step,
        toolName: toolCall.name,
        message: blockedCopy,
        outputPreview: {
          policyTags: policyDecision.tags,
          payloadFingerprint: policyDecision.payloadFingerprint,
        },
      });
      return {
        ok: false,
        toolName: toolCall.name,
        mutationState: "not_applied",
        output: {
          status: "blocked",
          toolName: toolCall.name,
          reason: policyDecision.reason,
          policyTags: policyDecision.tags,
          failureCopy: blockedCopy,
        },
        error: {
          code: "policy_blocked",
          message: blockedCopy,
        },
      };
    };

    const descriptor = toolRegistry.getDescriptor?.(toolCall.name) ?? null;
    if (descriptor?.execution.preparation === "required") {
      if (!toolRegistry.prepare || !toolRegistry.executePrepared) {
        return {
          ok: false,
          toolName: toolCall.name,
          mutationState: "not_applied",
          error: {
            code: "prepared_execution_unavailable",
            message:
              `Tool ${toolCall.name} requires preparation, but the registry ` +
              "does not expose the prepared-action execution contract.",
          },
        };
      }
      const preparedResult = await toolRegistry.prepare(
        toolCall,
        operationId
          ? { ...runToolContext, operationId }
          : runToolContext,
      );
      if (!preparedResult.ok) {
        return {
          ok: false,
          toolName: toolCall.name,
          mutationState: "not_applied",
          error: { ...preparedResult.error },
        };
      }
      const preparedAction = preparedResult.action;
      const actionPolicyContext = {
        toolName: toolCall.name,
        args: toolCall.arguments,
        intent: policyRouted.intent,
        approvalGranted: false,
        isDesktop: isCodeToolsDesktopRuntime(),
        writeAutonomy,
        codeRunCount: executedCodeRunCount,
        maxCodeRunsPerMission: runToolContext.settings?.maxCodeRunsPerMission,
        researchPhase: researchPhaseDescriptor,
        descriptor,
        preparedAction,
        principal: "single_agent" as const,
        scopeAllowed: isPreparedActionWithinRunnerScope({
          toolName: toolCall.name,
          descriptor,
          action: preparedAction,
          allowedToolNames,
          policyRouted: policyRouted.intent,
          missionIntent,
          writeAutonomy,
        }),
        now: runToolContext.now?.() ?? new Date(),
      };
      let preparedPolicyDecision = evaluateToolPolicy(actionPolicyContext);
      if (preparedPolicyDecision.action === "block") {
        return buildPolicyBlockedResult(preparedPolicyDecision);
      }

      let matchingGrant: AuthorityGrantV1 | null = null;
      if (preparedPolicyDecision.action === "require_approval") {
        const requiredConfirmations =
          preparedPolicyDecision.requiredConfirmations ?? 1;
        let finalApprovalRequest: ApprovalRequest | null = null;
        for (
          let confirmationIndex = 1;
          confirmationIndex <= requiredConfirmations;
          confirmationIndex += 1
        ) {
          const approval = await requestRunnerToolApproval({
            toolCall,
            step,
            action: preparedAction.preview.summary,
            reason: preparedPolicyDecision.reason,
            policyTags: preparedPolicyDecision.tags,
            timeoutMs: 120000,
            preparedAction,
            confirmationIndex,
            requiredConfirmations,
          });
          finalApprovalRequest = approval.request;
          if (approval.decision !== "approved") {
            return buildApprovalDeniedResult(
              toolCall,
              approval.request,
              approval.decision,
            );
          }
        }

        try {
          const grant = await createOneShotGrant({
            id: `grant:${finalApprovalRequest?.id ?? preparedAction.id}`,
            action: preparedAction,
            descriptor,
            issuedAt: runToolContext.now?.() ?? new Date(),
          });
          const evaluated = await evaluateAuthorityGrant({
            grant,
            action: preparedAction,
            descriptor,
            now: runToolContext.now?.() ?? new Date(),
          });
          if (!evaluated.allowed) {
            return {
              ok: false,
              toolName: toolCall.name,
              mutationState: "not_applied",
              error: {
                code: "authority_grant_invalid",
                message: evaluated.reason,
              },
            };
          }
          matchingGrant = evaluated.grant;
          preparedPolicyDecision = evaluateToolPolicy({
            ...actionPolicyContext,
            matchingGrant,
          });
          if (preparedPolicyDecision.action !== "allow") {
            return buildPolicyBlockedResult(preparedPolicyDecision);
          }
        } catch (error) {
          return {
            ok: false,
            toolName: toolCall.name,
            mutationState: "not_applied",
            error: {
              code: "authority_grant_invalid",
              message: getUnknownErrorMessage(error),
            },
          };
        }
      }

      const authorization: AuthorizedActionContext = matchingGrant
        ? {
            preparedActionId: preparedAction.id,
            payloadFingerprint: preparedAction.payloadFingerprint,
            grantId: matchingGrant.id,
          }
        : {
            preparedActionId: preparedAction.id,
            payloadFingerprint: preparedAction.payloadFingerprint,
            grantId: "policy:scoped-read",
          };
      if (matchingGrant) {
        const consumed = await consumeAuthorityGrant({
          grant: matchingGrant,
          action: preparedAction,
          descriptor,
          now: runToolContext.now?.() ?? new Date(),
        });
        if (!consumed.allowed) {
          return {
            ok: false,
            toolName: toolCall.name,
            mutationState: "not_applied",
            error: {
              code: "authority_grant_consumption_failed",
              message: consumed.reason,
            },
          };
        }
      }

      await beforeExecute?.(preparedAction, descriptor, authorization);
      if (toolCall.name === "run_code_block") {
        executedCodeRunCount += 1;
      }
      events.onStatus?.(
        matchingGrant
          ? `Exact payload approved; running tool: ${toolCall.name}`
          : `Running scoped prepared tool: ${toolCall.name}`,
      );
      return executePreparedToolWithMetrics({
        toolRegistry,
        preparedAction,
        authorization,
        toolContext: {
          ...runToolContext,
          ...(operationId ? { operationId } : {}),
          authorizedAction: authorization,
        },
        events,
        step,
      });
    }

    const policyDecision = evaluateToolPolicy({
      toolName: toolCall.name,
      args: toolCall.arguments,
      intent: policyRouted.intent,
      approvalGranted: runToolContext.userApprovalGranted === true,
      isDesktop: isCodeToolsDesktopRuntime(),
      writeAutonomy,
      codeRunCount: executedCodeRunCount,
      maxCodeRunsPerMission: runToolContext.settings?.maxCodeRunsPerMission,
      researchPhase: researchPhaseDescriptor,
    });
    if (policyDecision.action === "block") {
      return buildPolicyBlockedResult(policyDecision);
    }
    if (
      policyDecision.action === "require_approval" &&
      runToolContext.userApprovalGranted !== true
    ) {
      const { decision, request } = await requestRunnerToolApproval({
        toolCall,
        step,
        action: `${toolCall.name} (${policyDecision.tags.join(", ") || "policy"})`,
        reason: policyDecision.reason,
        policyTags: policyDecision.tags,
        timeoutMs: 120000,
      });
      if (decision !== "approved") {
        return buildApprovalDeniedResult(toolCall, request, decision);
      }
      events.onStatus?.(`Approval granted; running tool: ${toolCall.name}`);
      return runToolNow({
        ...runToolContext,
        userApprovalGranted: true,
      });
    }

    const initialResult = await runToolNow(runToolContext);
    const approvalInfo = getToolApprovalRequestInfo(toolCall, initialResult);
    if (!approvalInfo || runToolContext.userApprovalGranted === true) {
      return initialResult;
    }

    const { decision, request } = await requestRunnerToolApproval({
      toolCall,
      step,
      action: approvalInfo.action,
      reason: approvalInfo.reason,
      policyTags: approvalInfo.policyTags,
      timeoutMs: approvalInfo.timeoutMs,
    });
    if (decision !== "approved") {
      return buildApprovalDeniedResult(toolCall, request, decision);
    }

    events.onStatus?.(`Approval granted; running tool: ${toolCall.name}`);
    return runToolNow({
      ...runToolContext,
      userApprovalGranted: true,
    });
  };
  const runAutoFollowupsAfterTool = async ({
    toolName,
    result,
    step,
    toolIndex,
  }: {
    toolName: string;
    result: ToolExecutionResult;
    step: number;
    toolIndex: number | string;
  }) => {
    if (!result.ok) {
      return;
    }
    const acceptanceNeeds = evaluateCurrentAcceptance().missing;
    const maxReadOnlyFollowups = Math.min(
      3,
      Math.max(2, researchPlan?.sourceRequirements.minFetchedSources ?? 2),
    );
    const followups = planReadOnlyFollowups({
      mission: activeIntentPrompt,
      lastToolName: toolName,
      lastToolResult: result,
      acceptanceNeeds,
      alreadyFetchedUrls: missionEvidenceRecords
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url)),
      alreadyReadPaths: missionEvidenceRecords
        .map((item) => item.path)
        .filter((path): path is string => Boolean(path)),
      maxFollowups: maxReadOnlyFollowups,
    }).filter((request) => allowedToolNames.has(request.toolName));

    for (let index = 0; index < followups.length; index += 1) {
      const request = followups[index];
      events.onTrace?.({
        id: `${step}:${toolIndex}:auto-followup-${index}:${request.toolName}`,
        kind: "status",
        step,
        toolName: request.toolName,
        message: `Auto follow-up scheduled: ${request.toolName}`,
        inputPreview: {
          reason: request.reason,
          arguments: redactToolArguments(request.toolName, request.args),
        },
      });
      await runObservedModelToolCall({
        origin: "runner",
        toolCall: {
          name: request.toolName,
          arguments: request.args,
        },
        step,
        toolIndex: `auto-${toolIndex}-${index}`,
      });
    }
  };
  const runObservedModelToolCall = async ({
    origin,
    toolCall,
    step,
    toolIndex,
    recordTranscript = true,
  }: {
    origin: "model" | "runner";
    toolCall: ModelToolCall;
    step: number;
    toolIndex: number | string;
    recordTranscript?: boolean;
  }): Promise<ToolExecutionResult> => {
    if (observedToolCallCount >= maxToolCalls) {
      toolCallBudgetExhausted = true;
      if (!toolCallBudgetNoticeEmitted) {
        toolCallBudgetNoticeEmitted = true;
        events.onStatus?.(
          `Tool-call budget reached (${maxToolCalls}); saving the segment for continuation.`,
        );
        events.onTrace?.({
          id: `tool-call-budget-${step}`,
          kind: "status",
          step,
          toolName: toolCall.name,
          message: "Tool-call budget reached before another tool could start.",
          outputPreview: { maxToolCalls, observedToolCallCount },
        });
      }
      return {
        ok: false,
        toolName: toolCall.name,
        output: {
          status: "blocked",
          reason: "Per-segment tool-call budget exhausted.",
        },
        error: {
          code: "tool_call_budget_exhausted",
          message: "Per-segment tool-call budget exhausted.",
        },
      };
    }
    observedToolCallCount += 1;
    const toolEventBase: AgentToolRunEvent = {
      id: `${step}:${toolIndex}:${toolCall.name}`,
      name: toolCall.name,
      step,
    };

    events.onToolStart?.({
      ...toolEventBase,
      message: `Running tool: ${toolCall.name}`,
    });
    events.onTrace?.({
      id: `${toolEventBase.id}:start`,
      kind: "tool_start",
      step,
      toolName: toolCall.name,
      message: `Running ${toolCall.name}`,
      inputPreview: redactToolArguments(toolCall.name, toolCall.arguments),
    });
    events.onPhaseChange?.("running_tool", `Running tool: ${toolCall.name}`);
    emitToolPreparationStatus(toolCall.name, events);
    events.onStatus?.(`Running tool: ${toolCall.name}`);

    const toolDescriptor = toolRegistry.getDescriptor?.(toolCall.name) ?? null;
    const descriptorMutation =
      toolDescriptor !== null && toolDescriptor.effect !== "read";
    const journalMutation = toolDescriptor
      ? descriptorMutation && toolDescriptor.durability.journal
      : isWriteToolName(toolCall.name);
    const vaultMutation = toolDescriptor
      ? descriptorMutation && toolDescriptor.capability.system === "vault"
      : isWriteToolName(toolCall.name);
    let vaultTransaction: VaultMutationTransaction | null = null;
    const operationId = journalMutation
      ? `${runId}:${step}:${String(toolIndex)}:${toolCall.name}`
      : undefined;
    let operationJournalRecord: OperationJournalRecord | null = null;
    let operationJournalStarted = false;
    const saveOperationJournalRecord = (record: OperationJournalRecord) => {
      if (!runtimeSnapshot) {
        return;
      }
      operationJournalRecord = record;
      runtimeSnapshot.operationJournal = [
        ...runtimeSnapshot.operationJournal.filter(
          (item) => item.operationId !== record.operationId,
        ),
        record,
      ];
    };
    const getOperationJournalRecord = (): OperationJournalRecord | null =>
      operationJournalRecord;
    const beginOperationJournal = async (
      preparedAction?: PreparedAction,
      descriptor?: ToolDescriptor,
      authorization?: AuthorizedActionContext,
    ) => {
      if (
        !operationId ||
        operationJournalStarted ||
        !runtimeSnapshot ||
        !canPersistMissionRuntimeSnapshot(runToolContext)
      ) {
        return;
      }
      operationJournalStarted = true;
      const now = runToolContext.now?.() ?? new Date();
      const intentRecord = createOperationJournalRecord({
        operationId,
        rootRunId: runtimeSnapshot.lineage.rootRunId,
        segmentId: runtimeSnapshot.lineage.segmentId,
        nodeId: missionPlan?.activeTaskId ?? undefined,
        toolName: toolCall.name,
        operation: descriptor?.capability.action ?? toolCall.name,
        targetPath:
          preparedAction?.target.path ??
          getString(toolCall.arguments.path) ??
          getString(toolCall.arguments.toPath),
        inputHash:
          preparedAction?.payloadFingerprint ??
          hashOperationInput(toolCall.arguments),
        preparedAction,
        descriptor,
        authorization,
        now,
      });
      saveOperationJournalRecord(intentRecord);
      await persistRuntimeSnapshot(`${toolEventBase.id}:wal-intent`, {
        required: runtimeSnapshotPersistenceAvailable,
      });
      const applyingRecord = transitionOperationJournalRecord(
        intentRecord,
        "applying",
        {
          message: "Tool execution started after durable mutation intent.",
          now: runToolContext.now?.() ?? new Date(),
        },
      );
      saveOperationJournalRecord(applyingRecord);
      await persistRuntimeSnapshot(`${toolEventBase.id}:wal-applying`, {
        required: runtimeSnapshotPersistenceAvailable,
      });
    };
    if (vaultMutation) {
      vaultTransaction = recordTransactionStage(
        beginVaultTransaction({
          runId,
          nodeId: missionPlan?.activeTaskId ?? undefined,
          toolName: toolCall.name,
          targetPath: getString(toolCall.arguments.path) ?? getString(toolCall.arguments.toPath),
          now: runToolContext.now?.() ?? new Date(),
        }),
        "validated",
        "Tool arguments accepted by runner policy; tool-level validation will run next.",
        runToolContext.now?.() ?? new Date(),
      );
      events.onTrace?.({
        id: `${toolEventBase.id}:transaction:validated`,
        kind: "status",
        step,
        toolName: toolCall.name,
        message: "Vault transaction validated.",
        outputPreview: vaultTransaction,
      });
    }

    const result = await executeToolWithRunnerApproval({
      toolCall,
      step,
      operationId,
      beforeExecute: beginOperationJournal,
    });
    if (operationJournalRecord) {
      if (result.ok) {
        saveOperationJournalRecord(
          transitionOperationJournalRecord(operationJournalRecord, "applied", {
            message: "Mutation tool returned successfully; receipt verification pending.",
            mutationMayHaveApplied: true,
            now: runToolContext.now?.() ?? new Date(),
          }),
        );
      } else {
        const approvalBlocked = result.error?.code.startsWith("approval_") === true;
        const definitelyNotApplied =
          approvalBlocked || result.mutationState === "not_applied";
        const reconcileMessage = definitelyNotApplied
          ? "Mutation was not applied."
          : "Mutation tool failed after execution started; reconcile before retry.";
        saveOperationJournalRecord(
          transitionOperationJournalRecord(
            operationJournalRecord,
            definitelyNotApplied ? "failed" : "reconcile_required",
            {
              message: reconcileMessage,
              error: result.error?.message,
              mutationMayHaveApplied: !definitelyNotApplied,
              now: runToolContext.now?.() ?? new Date(),
            },
          ),
        );
        if (!definitelyNotApplied) {
          events.onStatus?.(
            formatFailureCopy(walReconcileFailureCopy(reconcileMessage)),
          );
        }
        await persistRuntimeSnapshot(`${toolEventBase.id}:wal-failed`);
      }
    }
    if (vaultTransaction && result.ok) {
      vaultTransaction = recordTransactionStage(
        vaultTransaction,
        "applied",
        "Vault mutation tool returned successfully.",
        runToolContext.now?.() ?? new Date(),
      );
      events.onTrace?.({
        id: `${toolEventBase.id}:transaction:applied`,
        kind: "status",
        step,
        toolName: toolCall.name,
        message: "Vault transaction applied.",
        outputPreview: vaultTransaction,
      });
    }

    executedModelTool = true;
    const recordedToolCall = recordTranscript
      ? appendToolTranscript({
          messages,
          toolCall,
          resultContent: serializeToolResultForModel(result),
          origin,
          fallbackId: buildToolCallFallbackId(runId, step, toolIndex, toolCall.name),
        })
      : toolCall;
    markOperationGoalsForTool({
      operationGoals,
      toolName: recordedToolCall.name,
      ok: result.ok,
      streamingWritebackKind,
    });
    recentActions.push({
      kind: "tool",
      name: recordedToolCall.name,
      ok: result.ok,
      signature: `${recordedToolCall.name}:${stableStringify(recordedToolCall.arguments)}`,
    });

    if (result.ok) {
      successfulToolNames.push(toolCall.name);
      currentSegmentSuccessfulToolNames.push(toolCall.name);
      if (missionLedger) {
        setLedgerLastSafeStep(
          missionLedger,
          step,
          runToolContext.now?.() ?? new Date(),
        );
      }
      await recordLedgerToolResult(toolCall.name, result, step);
      const successMessage = emitToolSuccessStatus(
        toolCall.name,
        result.output,
        events,
      );
      events.onToolDone?.({
        ...toolEventBase,
        ok: true,
        message: successMessage,
        output: result.output,
      });
      events.onTrace?.({
        id: `${toolEventBase.id}:result`,
        kind: "tool_result",
        step,
        toolName: toolCall.name,
        message: successMessage,
        outputPreview: truncateTracePayload(result.output),
      });

      const receipt = buildReceiptFromToolExecution(
        toolCall.name,
        result,
        toolDescriptor,
      );
      if (receipt) {
        updatePinnedCurrentNotePathFromReceipt(receipt, toolEventBase.id);
        writeReceipts.push(receipt);
        events.onReceipt?.(receipt);
        await recordLedgerReceipt(receipt, step);
        if (
          toolCall.name === "append_to_current_file" ||
          toolCall.name === "replace_current_file"
        ) {
          const writtenText =
            typeof toolCall.arguments.text === "string"
              ? toolCall.arguments.text
              : typeof toolCall.arguments.content === "string"
                ? toolCall.arguments.content
                : null;
          await publishPlaceholderAutoRename(
            toolCall.name === "replace_current_file" ? "replace" : "append",
            step,
            writtenText,
          );
        }
        if (vaultTransaction) {
          if (receipt.backupPath) {
            vaultTransaction = recordTransactionStage(
              vaultTransaction,
              "backed_up",
              `Backup recorded at ${receipt.backupPath}.`,
              runToolContext.now?.() ?? new Date(),
            );
          }
          vaultTransaction = commitVaultTransaction(
            vaultTransaction,
            receipt,
            runToolContext.now?.() ?? new Date(),
          );
          vaultTransactionRecords.push(vaultTransaction);
          events.onTrace?.({
            id: `${toolEventBase.id}:transaction:committed`,
            kind: "receipt",
            step,
            toolName: toolCall.name,
            operation: receipt.operation,
            path: receipt.path,
            backupPath: receipt.backupPath,
            message: "Vault transaction committed.",
            outputPreview: vaultTransaction,
          });
        }
        events.onTrace?.({
          id: `${toolEventBase.id}:receipt`,
          kind: "receipt",
          step,
          toolName: toolCall.name,
          operation: receipt.operation,
          path: receipt.path,
          toPath: receipt.toPath,
          backupPath: receipt.backupPath,
          message: receipt.message,
          outputPreview: truncateTracePayload(receipt.output ?? receipt),
        });
        const receiptJournalRecord = getOperationJournalRecord();
        if (receiptJournalRecord?.state === "applied") {
          const verifiedRecord = transitionOperationJournalRecord(
            receiptJournalRecord,
            "verified",
            {
              message: "Mutation receipt matched the completed tool operation.",
              receipt,
              now: runToolContext.now?.() ?? new Date(),
            },
          );
          const committedRecord = transitionOperationJournalRecord(
            verifiedRecord,
            "committed",
            {
              message: "Mutation and receipt committed to durable run state.",
              receipt,
              now: runToolContext.now?.() ?? new Date(),
            },
          );
          saveOperationJournalRecord(committedRecord);
          await persistRuntimeSnapshot(`${toolEventBase.id}:wal-committed`);
        }
      }
      const unresolvedJournalRecord = getOperationJournalRecord();
      if (unresolvedJournalRecord?.state === "applied") {
        const reconcileMessage =
          "Mutation reported success without a durable receipt; inspect before retry.";
        saveOperationJournalRecord(
          transitionOperationJournalRecord(
            unresolvedJournalRecord,
            "reconcile_required",
            {
              message: reconcileMessage,
              mutationMayHaveApplied: true,
              now: runToolContext.now?.() ?? new Date(),
            },
          ),
        );
        events.onStatus?.(
          formatFailureCopy(walReconcileFailureCopy(reconcileMessage)),
        );
        await persistRuntimeSnapshot(`${toolEventBase.id}:wal-reconcile`);
      }

      if (toolCall.name === "prepare_edit_current_section") {
        preparedStreamingSectionEdit = parsePreparedStreamingSectionEdit(
          result.output,
        );
      }

      if (toolCall.name === "web_search") {
        executedWebSearchTool = true;
      }

      if (toolCall.name === "web_fetch") {
        executedWebFetchTool = true;
      }

      if (
        toolCall.name === "semantic_search_notes" &&
        !vaultCoverageExpansionUsed &&
        shouldExpandVaultRetrievalCoverage(result.output, researchPlan)
      ) {
        vaultCoverageExpansionUsed = true;
        events.onStatus?.(
          formatFailureCopy(
            semanticCoverageSecondPassCopy(
              "Vault retrieval coverage was sampled, truncated, fallback, or low confidence.",
            ),
          ),
        );
        messages.push({
          role: "system" as const,
          content:
            "The semantic vault retrieval coverage is not strong enough for deep vault research. Expand retrieval before synthesis: call semantic_search_notes again with mode='deep' and a higher candidateLimit when available, then read selected high-signal notes with read_markdown_files or read_file. Do not give the final answer yet.",
        });
      }

      if (vaultMutation) {
        wroteToNote = true;
      }
      if (origin === "model") {
        await runAutoFollowupsAfterTool({
          toolName: toolCall.name,
          result,
          step,
          toolIndex,
        });
      }
    } else {
      failedToolNames.push(toolCall.name);
      const failureStatus = formatObservedToolFailureStatus(
        toolCall.name,
        result,
      );
      events.onStatus?.(failureStatus);
      events.onToolDone?.({
        ...toolEventBase,
        ok: false,
        message: failureStatus,
        error: result.error,
      });
      events.onTrace?.({
        id: `${toolEventBase.id}:result`,
        kind: "tool_result",
        step,
        toolName: toolCall.name,
        message: failureStatus,
        error: result.error,
        outputPreview: truncateTracePayload(result),
      });
      await recordLedgerToolResult(toolCall.name, result, step);
    }

    if (origin === "runner") {
      events.onTrace?.({
        id: `${toolEventBase.id}:origin`,
        kind: "status",
        step,
        toolName: toolCall.name,
        message: `Runner-owned tool fallback executed: ${toolCall.name}`,
      });
    }

    reflexOutput = await reflexController.evaluate({
      prompt: activeIntentPrompt,
      missionIntent,
      allowedToolNames,
      recentActions,
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      settings: runToolContext.settings,
      embeddingProvider: runToolContext.semanticEmbeddingProvider,
    });

    return result;
  };
  const runRequiredWebToolFallback = async (
    missingToolNames: string[],
    step: number,
  ): Promise<boolean> => {
    events.onStatus?.(
      "Model did not request required web tools; running read-only web fallback...",
    );
    let searchOutput: unknown = getLatestToolOutput(messages, "web_search");

    if (
      missingToolNames.includes("web_search") &&
      allowedToolNames.has("web_search") &&
      !executedWebSearchTool
    ) {
      const result = await runObservedModelToolCall({
        origin: "runner",
        toolCall: {
          name: "web_search",
          arguments: {
            query: buildFallbackWebSearchQuery(activeIntentPrompt),
            max_results: Math.min(
              10,
              Math.max(3, (researchPlan?.sourceRequirements.minFetchedSources ?? 1) * 3),
            ),
          },
        },
        step,
        toolIndex: "runner",
      });
      searchOutput = result.output;
    }

    if (
      missingToolNames.includes("web_fetch") &&
      allowedToolNames.has("web_fetch")
    ) {
      const fetchedUrls = getFetchedWebSourceUrls(missionEvidenceRecords);
      const requiredFetches = researchPlan?.sourceRequirements.minFetchedSources ?? 1;
      const neededFetches = Math.max(
        executedWebFetchTool ? 0 : 1,
        requiredFetches - fetchedUrls.length,
      );
      const candidateUrls = rankWebSearchResultUrls(
        searchOutput ?? getLatestToolOutput(messages, "web_search"),
        activeIntentPrompt,
      );
      const urls = selectDomainDiverseUrls(candidateUrls, fetchedUrls, neededFetches);
      if (urls.length === 0) {
        events.onStatus?.(
          "Web fallback could not find a safe result URL to fetch.",
        );
        return false;
      }

      for (let index = 0; index < urls.length; index += 1) {
        await runObservedModelToolCall({
          origin: "runner",
          toolCall: {
            name: "web_fetch",
            arguments: { url: urls[index] },
          },
          step,
          toolIndex: `runner-fetch-${index}`,
        });
      }
    }

    return getMissingRequiredWebToolNames({
      prompt: activeIntentPrompt,
      allowedToolNames,
      executedWebSearchTool,
      executedWebFetchTool,
      researchPlan,
      missionEvidence: missionEvidenceRecords,
    }).length === 0;
  };
  await persistMissionLedger("mission-ledger-start");

  const compactedConversation =
    compactConversationForPrompt(conversationHistory);
  const conversationMessages =
    toCompactedConversationModelMessages(compactedConversation);
  const researchHypothesisHint =
    researchPlan !== null &&
    runToolContext.settings?.researchMemoryEnabled === true
      ? buildHypothesisSystemHintFromIndex(
          runToolContext.getResearchMemoryIndex?.() ?? [],
          activeIntentPrompt,
        )
      : null;

  const messages: ModelChatMessage[] = [
    {
      role: "system" as const,
      content: SYSTEM_PROMPT,
    },
    {
      role: "system" as const,
      content: formatRuntimeContext(runToolContext, activeIntentPrompt),
    },
    {
      role: "system" as const,
      content: formatResponseLanguageContext(activeIntentPrompt),
    },
    ...(runPlan.requiresEnglishGuard
      ? [
          {
            role: "system" as const,
            content: ENGLISH_ONLY_POLICY,
          },
        ]
      : []),
    {
      role: "system" as const,
      content: formatMissionIntentContext(missionIntent),
    },
    {
      role: "system" as const,
      content: formatStructuredIntentForPrompt(structuredIntent),
    },
    ...(shouldEmitPlaceholderTitleWriteHint({
      missionIntent,
      streamingWritebackKind,
      allowedToolNames,
      activeBasename:
        runToolContext.getCurrentMarkdownFile?.()?.basename ??
        runToolContext.app?.workspace?.getActiveFile?.()?.basename,
    })
      ? [
          {
            role: "system" as const,
            content: [
              "When writing titled content to the current note, put `# Title` as the first line of the text argument.",
              "If the note is Untitled / Untitled N, the plugin will rename the file after a successful write.",
              "Do not also call rename_current_file unless the user explicitly asked to rename/retitle the page.",
            ].join(" "),
          },
        ]
      : []),
    ...(missionPlan === null
      ? []
      : [
          {
            role: "system" as const,
            content: [
              formatMissionPlanForPrompt(missionPlan),
              formatMissionPlanNextActionPrompt(missionPlan),
            ].join("\n\n"),
          },
        ]),
    ...(researchPlan === null
      ? []
      : [
          {
            role: "system" as const,
            content: formatResearchPlanForPrompt(researchPlan),
          },
        ]),
    ...(researchHypothesisHint
      ? [
          {
            role: "system" as const,
            content: researchHypothesisHint,
          },
        ]
      : []),
    ...(generatedOutputPolicy.wordTarget
      ? [
          {
            role: "system" as const,
            content: formatGeneratedWordTargetContext(generatedOutputPolicy.wordTarget),
          },
        ]
      : []),
    ...(isPromptOnCurrentPageIntent(prompt)
      ? [
          {
            role: "system" as const,
            content: formatPromptOnCurrentPageContext(),
          },
        ]
      : []),
    ...(followupIntentContext === null
      ? []
      : [
          {
            role: "system" as const,
            content: followupIntentContext,
          },
        ]),
    ...(orchestratorContext?.trim()
      ? [
          {
            role: "system" as const,
            content: orchestratorContext.trim(),
          },
        ]
      : []),
    ...(checkpointResumeContext === null
      ? []
      : [
          {
            role: "system" as const,
            content: checkpointResumeContext.promptContext,
          },
        ]),
    ...(resumeLedger &&
      streamingWritebackKind !== null &&
      missionEvidenceRecords.length > 0
      ? [
          {
            role: "system" as const,
            content: formatDurableEvidenceForWriteback(missionEvidenceRecords),
          },
        ]
      : []),
    ...(currentNoteContext === null
      ? []
      : [
          {
            role: "system" as const,
            content: formatCurrentNoteContext(currentNoteContext),
          },
        ]),
    ...(promptOnPageCurrentNoteReadSatisfied
      ? [
          {
            role: "system" as const,
            content: formatCurrentNoteReadSatisfiedContext(),
          },
        ]
      : []),
    {
      role: "system" as const,
      content: formatAllowedToolsContext(tools),
    },
    {
      role: "system" as const,
      content: formatToolAuthorityContext(tools),
    },
    ...(streamingWritebackKind === null
      ? []
      : [
          {
            role: "system" as const,
            content: formatStreamingWritebackContext(streamingWritebackKind),
          },
        ]),
    ...(requireToolBeforeStreamingWriteback
      ? [
          {
            role: "system" as const,
            content: buildToolBeforeStreamingWritebackPrompt(tools),
          },
        ]
      : []),
    ...(conversationMessages.length === 0 &&
      compactedConversation.summary === null
      ? []
      : [
          {
            role: "system" as const,
            content: formatConversationHistoryContext(),
          },
          ...(compactedConversation.summary === null
            ? []
            : [
                {
                  role: "system" as const,
                  content: compactedConversation.summary,
                },
              ]),
          ...conversationMessages,
        ]),
    {
      role: "user" as const,
      content: activeIntentPrompt,
    },
  ];
  estimatedPromptCharsForRun = estimatePromptChars(messages);
  events.onRunConfig?.(
    buildRunConfigEvent({
      runId,
      toolContext: runToolContext,
      enableStreaming,
      activeThink,
      modelOptions,
      writeAutonomy,
      chatOnlyOverride: forceChatOnly,
      missionIntent,
      currentNoteContext: shouldReadCurrentNote,
      runPlan,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
      missionLedger: missionLedger ? summarizeMissionLedger(missionLedger) : undefined,
      reflexOutput,
      estimatedPromptChars: estimatedPromptCharsForRun,
      contextBudgetChars: runContextBudget.maxPromptChars,
      performanceGates: evaluatePerformanceGates(metricEvents),
    }),
  );

  if (runPlan.route === "instant_local") {
    if (stopIfRequested(0)) {
      return;
    }
    emitRunDiagnostics({
      events,
      toolContext: runToolContext,
      tools,
      enableStreaming,
      finalMode: "direct",
      runPlan,
    });
    lastFinalOutput = buildInstantLocalAnswer(activeIntentPrompt, runToolContext);
    emitDirectAssistantAnswer(
      lastFinalOutput,
      events,
      runPlan.requiresEnglishGuard,
    );
    await finishRun("final", 0, runPlan.maxStepsForRun);
    return;
  }

  if (runPlan.route === "prefetched_vault_answer") {
    if (stopIfRequested(0)) {
      return;
    }

    try {
      events.onStatus?.("Inspecting vault context locally...");
      const vaultContext = await runObservedTool({
        name: "inspect_vault_context",
        arguments: buildVaultPrefetchArgs(activeIntentPrompt),
        toolRegistry,
        toolContext: runToolContext,
        events,
        step: 0,
      });
      successfulToolNames.push("inspect_vault_context");
      currentSegmentSuccessfulToolNames.push("inspect_vault_context");
      await recordLedgerToolResult(
        "inspect_vault_context",
        {
          ok: true,
          toolName: "inspect_vault_context",
          output: vaultContext,
        },
        0,
      );
      if (stopIfRequested(0)) {
        return;
      }

      emitRunDiagnostics({
        events,
        toolContext: runToolContext,
        tools,
        enableStreaming,
        finalMode: enableStreaming ? "streaming_direct" : "direct",
        runPlan,
      });
      const messagesWithContext = [
        ...messages,
        {
          role: "system" as const,
          content: `Prefetched vault context: ${JSON.stringify(vaultContext)}`,
        },
        {
          role: "system" as const,
          content:
            "Answer from the prefetched vault context. Cite vault-relative paths. If the context is sampled or truncated, say so briefly. Do not request tools.",
        },
      ];
      const relevancePromptWithVaultContext = appendRelevancePromptContext(
        finalAnswerRelevancePrompt,
        "Prefetched vault context",
        vaultContext,
      );
      const response = enableStreaming
        ? await emitFinalAnswer({
            modelClient,
            messages: messagesWithContext,
            events,
            enableStreaming,
            fallbackContent: "",
            finalInstruction: null,
            metricName: "prefetched_vault_answer",
            relevancePrompt: relevancePromptWithVaultContext,
            think: undefined,
            options: modelOptions,
            abortSignal,
            onThinkingUnsupported: disableThinkingForRun,
          })
        : await emitNonStreamingFinalModelAnswer({
            modelClient,
            messages: messagesWithContext,
            events,
            metricName: "prefetched_vault_answer",
            options: modelOptions,
            abortSignal,
          });
      if (stopIfRequested(1)) {
        return;
      }
      lastFinalOutput = response?.message.content ?? "";
      await finishRun(
        isClarifyingQuestionResponse(activeIntentPrompt, response?.message.content ?? "")
          ? "clarifying_question"
          : "final",
        1,
        runPlan.maxStepsForRun,
      );
      return;
    } catch (error) {
      if (stopIfRequested(0)) {
        return;
      }

      events.onStatus?.(
        `Local vault prefetch failed; falling back to tool planning: ${getUnknownErrorMessage(error)}`,
      );
      tools = getAllowedToolDefinitions(
        toolRegistry,
        activeIntentPrompt,
        missionIntent,
        runToolContext.settings,
        streamingWritebackKind,
        reflexOutput.intent,
      );
      runPlan = {
        ...runPlan,
        route: "grounded_workflow",
        maxStepsForRun: estimateLoopBudget({
          route: "grounded_workflow",
          configuredMaxSteps: getConfiguredMaxAgentSteps(runToolContext.settings),
          requestedSteps: 2,
        }),
        thinking: resolveThinkingMode(runToolContext.settings),
        allowedTools: tools,
        allowedToolNames: tools.map((tool) => tool.function.name),
        expectedTimeClass: "normal",
        traceReasons: ["prefetch_failed_fallback"],
      };
      activeThink = runPlan.thinking;
      allowedToolNames = new Set(tools.map((tool) => tool.function.name));
      messages.push({
        role: "system" as const,
        content: [
          "Local vault prefetch failed, so normal vault tools are available.",
          formatAllowedToolsContext(tools),
          formatToolAuthorityContext(tools),
        ].join(" "),
      });
    }
  }

  if (runPlan.route === "prefetched_vault_writeback") {
    if (stopIfRequested(0)) {
      return;
    }

    events.onStatus?.("Inspecting named vault folders locally...");
    const vaultContext = await runObservedTool({
      name: "inspect_vault_context",
      arguments: buildVaultPrefetchArgs(activeIntentPrompt),
      toolRegistry,
      toolContext: runToolContext,
      events,
      step: 0,
    });
    successfulToolNames.push("inspect_vault_context");
    currentSegmentSuccessfulToolNames.push("inspect_vault_context");
    await recordLedgerToolResult(
      "inspect_vault_context",
      {
        ok: true,
        toolName: "inspect_vault_context",
        output: vaultContext,
      },
      0,
    );
    if (stopIfRequested(0)) {
      return;
    }

    emitRunDiagnostics({
      events,
      toolContext: {
        ...runToolContext,
        writeAutonomy: true,
      },
      tools,
      enableStreaming,
      finalMode: "streaming_writeback",
      runPlan,
    });
    const messagesWithContext = [
      ...messages,
      {
        role: "system" as const,
        content: `Prefetched vault context: ${JSON.stringify(vaultContext)}`,
      },
      {
        role: "system" as const,
        content:
          "Write findings from the prefetched vault context. Cite vault-relative paths when useful. Do not request tools.",
      },
    ];
    const relevancePromptWithVaultContext = appendRelevancePromptContext(
      finalAnswerRelevancePrompt,
      "Prefetched vault context",
      vaultContext,
    );
    let receipt: AgentRunReceipt;
    try {
      const committedReceipt = await runProofGatedCurrentNoteWriteback({
        kind: "append",
        preparedSectionEdit: null,
        modelClient,
        messages: messagesWithContext,
        events,
        toolContext: runToolContext,
        knownToolNames,
        relevancePrompt: relevancePromptWithVaultContext,
        think: undefined,
        options: modelOptions,
        abortSignal,
        onThinkingUnsupported: disableThinkingForRun,
      }, 1);
      if (!committedReceipt) {
        return;
      }
      receipt = committedReceipt;
    } catch (error) {
      if (stopIfRequested(1)) {
        return;
      }
      throw error;
    }
    if (stopIfRequested(1)) {
      return;
    }
    markStreamingWritebackGoalDone(operationGoals, "append");
    writeReceipts.push(receipt);
    events.onReceipt?.(receipt);
    await recordLedgerReceipt(receipt);
    await finishRun("write_completed", 1, runPlan.maxStepsForRun);
    return;
  }

  if (promptOnPageWritebackKind !== null) {
    if (stopIfRequested(1)) {
      return;
    }
    emitRunDiagnostics({
      events,
      toolContext: {
        ...runToolContext,
        writeAutonomy: true,
      },
      tools,
      enableStreaming,
      finalMode: "streaming_writeback",
      runPlan,
    });
    let receipt: AgentRunReceipt;
    try {
      const committedReceipt = await runProofGatedCurrentNoteWriteback({
        kind: promptOnPageWritebackKind,
        preparedSectionEdit: null,
        modelClient,
        messages: [
          ...messages,
          {
            role: "system" as const,
            content: formatPromptOnCurrentPageWritebackContext(),
          },
        ],
        events,
        toolContext: runToolContext,
        knownToolNames,
        relevancePrompt: finalAnswerRelevancePrompt,
        think: activeThink,
        options: modelOptions,
        abortSignal,
        onThinkingUnsupported: disableThinkingForRun,
      }, 1);
      if (!committedReceipt) {
        return;
      }
      receipt = committedReceipt;
    } catch (error) {
      if (stopIfRequested(1)) {
        return;
      }
      throw error;
    }
    if (stopIfRequested(1)) {
      return;
    }
    markStreamingWritebackGoalDone(operationGoals, promptOnPageWritebackKind);
    writeReceipts.push(receipt);
    events.onReceipt?.(receipt);
    await recordLedgerReceipt(receipt);
    await finishRun("write_completed", 1, runPlan.maxStepsForRun);
    return;
  }

  if (directCurrentNoteWritebackKind !== null) {
    if (stopIfRequested(1)) {
      return;
    }
    events.onStatus?.("Using direct note writeback; no tool loop needed...");
    emitRunDiagnostics({
      events,
      toolContext: runToolContext,
      tools,
      enableStreaming,
      finalMode: "streaming_writeback",
      runPlan,
    });
    let receipt: AgentRunReceipt;
    try {
      const committedReceipt = await runProofGatedCurrentNoteWriteback({
        kind: directCurrentNoteWritebackKind,
        preparedSectionEdit: null,
        modelClient,
        messages: [
          ...messages,
          {
            role: "system" as const,
            content: formatDirectCurrentNoteWritebackContext(),
          },
        ],
        events,
        toolContext: runToolContext,
        knownToolNames,
        relevancePrompt: finalAnswerRelevancePrompt,
        think: activeThink,
        options: modelOptions,
        abortSignal,
        onThinkingUnsupported: disableThinkingForRun,
      }, 1);
      if (!committedReceipt) {
        return;
      }
      receipt = committedReceipt;
    } catch (error) {
      if (stopIfRequested(1)) {
        return;
      }
      throw error;
    }
    if (stopIfRequested(1)) {
      return;
    }
    markStreamingWritebackGoalDone(operationGoals, directCurrentNoteWritebackKind);
    writeReceipts.push(receipt);
    events.onReceipt?.(receipt);
    await recordLedgerReceipt(receipt);
    await finishRun("write_completed", 1, runPlan.maxStepsForRun);
    return;
  }

  if (
    enableStreaming &&
    currentNoteContext !== null &&
    !writeRequired &&
    streamingWritebackKind === null &&
    canStreamAnswerFromInitialCurrentNoteContext(tools)
  ) {
    if (stopIfRequested(1)) {
      return;
    }
    emitRunDiagnostics({
      events,
      toolContext: runToolContext,
      tools,
      enableStreaming,
      finalMode: "streaming_direct",
      runPlan,
    });
    let response: ModelChatResponse | null;
    try {
      response = await emitFinalAnswer({
        modelClient,
        messages,
        events,
        enableStreaming,
        fallbackContent: "",
        finalInstruction: buildCurrentNoteFinalAnswerPrompt(activeIntentPrompt),
        metricName: "current_note_answer",
        relevancePrompt: finalAnswerRelevancePrompt,
        think: activeThink,
        options: modelOptions,
        abortSignal,
        onThinkingUnsupported: disableThinkingForRun,
      });
    } catch (error) {
      if (stopIfRequested(1)) {
        return;
      }
      throw error;
    }
    if (stopIfRequested(1)) {
      return;
    }
    lastFinalOutput = response?.message.content ?? "";
    await finishRun(
      isClarifyingQuestionResponse(activeIntentPrompt, response?.message.content ?? "")
        ? "clarifying_question"
        : "final",
      1,
      runPlan.maxStepsForRun,
    );
    return;
  }

  if (enableStreaming && tools.length === 0 && !writeRequired) {
    if (stopIfRequested(1)) {
      return;
    }
    emitRunDiagnostics({
        events,
        toolContext: runToolContext,
        tools,
        enableStreaming,
        finalMode: "streaming_direct",
        runPlan,
    });
    let response: ModelChatResponse | null;
    try {
      response = await emitFinalAnswer({
        modelClient,
        messages,
        events,
        enableStreaming,
      fallbackContent: "",
      finalInstruction: null,
      metricName: "direct_answer",
      relevancePrompt: finalAnswerRelevancePrompt,
      think: activeThink,
      options: modelOptions,
      abortSignal,
        onThinkingUnsupported: disableThinkingForRun,
      });
    } catch (error) {
      if (stopIfRequested(1)) {
        return;
      }
      throw error;
    }
    if (stopIfRequested(1)) {
      return;
    }
    lastFinalOutput = response?.message.content ?? "";
    await finishRun(
      isClarifyingQuestionResponse(activeIntentPrompt, response?.message.content ?? "")
        ? "clarifying_question"
        : "final",
      1,
      runPlan.maxStepsForRun,
    );
    return;
  }

  emitStatus(events, "Planning...", "planning");
  const stepLimit = Math.min(
    runPlan.maxStepsForRun,
    MAX_AGENT_STEPS,
    normalizeInvocationStepLimit(providedMaxSteps),
  );
  const maxRunMs = configuredMaxRunMs;
  const isRepeatedToolBudgetSpent = () => {
    const lastActionName = recentActions.at(-1)?.name;
    const previousActionName = recentActions.at(-2)?.name;
    return (
      loopBudgetPlan.toolStepBudget > 0 &&
      currentSegmentSuccessfulToolNames.length >= loopBudgetPlan.toolStepBudget &&
      recoveryAttemptSignatures.length >= 2 &&
      lastActionName !== undefined &&
      lastActionName === previousActionName
    );
  };
  const stopRepeatedToolBudget = async () => {
    const message = "Repeated tool loop stopped before full safety limit.";
    events.onStatus?.(
      "Stopped repeated tool loop before burning the full safety limit.",
    );
    // Do not record a ledger blocker here: this is a productive budget stop so
    // overnight/auto-continue can still schedule the next segment.
    await finishRun("budget", lastStep, stepLimit, message);
  };

  for (let step = 1; step <= stepLimit; step += 1) {
    if (stopIfRequested(step)) {
      return;
    }

    if (maxRunMs !== null && nowMs() - runStartedAt >= maxRunMs) {
      const message =
        "Wall-clock run budget expired. The ledger was saved and this run can be continued.";
      if (missionLedger) {
        setLedgerWallClockExpired(
          missionLedger,
          runToolContext.now?.() ?? new Date(),
        );
        setLedgerNextAction(
          missionLedger,
          `${message} Run "${missionLedger.continuationCommand}" to continue.`,
          runToolContext.now?.() ?? new Date(),
        );
      }
      events.onStatus?.(message);
      events.onTrace?.({
        id: `wall-clock-budget:${step}`,
        kind: "status",
        step,
        message,
        outputPreview: {
          elapsedMs: Math.round(nowMs() - runStartedAt),
          maxRunMs,
        },
      });
      emitDirectAssistantAnswer(
        `${message} Run "continue" when ready.`,
        events,
        runPlan.requiresEnglishGuard,
      );
      await finishRun("budget", Math.max(lastStep, step), stepLimit, message);
      return;
    }

    lastStep = step;
    events.onStatus?.(`Agent step ${step} of max ${stepLimit}...`);
    events.onPhaseChange?.(
      "planning",
      `Planning step ${step} of max ${stepLimit}...`,
    );
    if (step === LONG_RUN_STEP_WARN_AT && stepLimit >= LONG_RUN_STEP_WARN_AT) {
      events.onStatus?.(
        `Long run continuing past step ${LONG_RUN_STEP_WARN_AT}; checkpoints save every ${CHECKPOINT_EVERY_STEPS} steps when vault access is available.`,
      );
    }
    events.onPlanningStart?.(step);
    estimatedPromptCharsForRun = estimatePromptChars(messages);
    if (
      missionLedger &&
      shouldCompactLoopMessages(messages, runContextBudget)
    ) {
      const compacted = compactLoopMessages({
        messages,
        ledger: missionLedger,
      });
      messages.splice(0, messages.length, ...compacted.messages);
      estimatedPromptCharsForRun = compacted.estimatedCharsAfter;
      events.onStatus?.(
        `Compacted loop context from ${compacted.estimatedCharsBefore} to ${compacted.estimatedCharsAfter} estimated chars before model call.`,
      );
      events.onTrace?.({
        id: `context-compaction:${step}`,
        kind: "status",
        step,
        message: "Compacted loop context before model call.",
        outputPreview: {
          estimated_prompt_chars_before: compacted.estimatedCharsBefore,
          estimated_prompt_chars_after: compacted.estimatedCharsAfter,
          compacted_tool_messages: compacted.compactedToolMessages,
          num_ctx: modelOptions?.num_ctx ?? null,
        },
      });
      events.onRunConfig?.(
        buildRunConfigEvent({
          runId,
          toolContext: runToolContext,
          enableStreaming,
          activeThink,
          modelOptions,
          writeAutonomy,
          chatOnlyOverride: forceChatOnly,
          missionIntent,
          currentNoteContext: shouldReadCurrentNote,
          runPlan,
          streamingWritebackKind,
          directCurrentNoteWritebackKind,
          missionLedger: summarizeMissionLedger(missionLedger),
          reflexOutput,
          estimatedPromptChars: estimatedPromptCharsForRun,
          contextBudgetChars: runContextBudget.maxPromptChars,
          performanceGates: evaluatePerformanceGates(metricEvents),
        }),
      );
    }
    events.onPlanningDelta?.(
      [
        `Step ${step}/${stepLimit}`,
        `route=${runPlan.route}`,
        `reason=${runPlan.slowPathReason}`,
        `estimated_prompt_chars=${estimatedPromptCharsForRun}`,
        `num_ctx=${modelOptions?.num_ctx ?? "default"}`,
        `tool_budget=${loopBudgetPlan.toolStepBudget}`,
        `finalization_reserved=${loopBudgetPlan.finalizationReserve}`,
        `tools=${Array.from(allowedToolNames).join(", ") || "none"}`,
      ].join("; "),
    );
    if (
      missionPlan &&
      (step % PROGRESS_REVIEW_EVERY_STEPS === 0 ||
        (MISSION_MILESTONE_STEPS as readonly number[]).includes(step))
    ) {
      events.onStatus?.(
        `Mission plan review at step ${step}: ${missionPlan.progress.completedTasks}/${missionPlan.progress.totalTasks} task(s) complete.`,
      );
      await recordMissionPlanReview(
        step,
        (MISSION_MILESTONE_STEPS as readonly number[]).includes(step)
          ? "milestone"
          : "periodic",
      );
    }

    let response: ModelChatResponse;
    try {
      response = await chatForAgentStep(
        modelClient,
        buildChatRequest(messages, tools, activeThink, modelOptions, abortSignal),
        events,
        step,
        disableThinkingForRun,
      );
    } catch (error) {
      if (stopIfRequested(step)) {
        return;
      }
      await finishErroredRunFromException(error, step, stepLimit, "model");
      return;
    }
    events.onPlanningDone?.(step);

    if (stopIfRequested(step)) {
      return;
    }

    const responseToolCalls = getResponseToolCallsFromModelOutput(
      response,
      knownToolNames,
      events,
      step,
    );
    const progressSignature =
      responseToolCalls.length > 0
        ? responseToolCalls
            .map((call) => `${call.name}:${stableStringify(call.arguments)}`)
            .join("|")
        : "no-tool-call";
    consecutiveNoProgressSteps =
      progressSignature === lastProgressSignature
        ? consecutiveNoProgressSteps + 1
        : 0;
    lastProgressSignature = progressSignature;
    const recoveredTextToolCalls =
      response.toolCalls.length === 0 && responseToolCalls.length > 0;

    const missingRequiredWebToolsBeforeToolUse = getMissingRequiredWebToolNames({
      prompt: activeIntentPrompt,
      allowedToolNames,
      executedWebSearchTool,
      executedWebFetchTool,
      researchPlan,
      missionEvidence: missionEvidenceRecords,
    });
    const responseOnlyRequestsMissingRequiredWebTools =
      responseToolCalls.length > 0 &&
      responseToolCalls.every((toolCall) =>
        missingRequiredWebToolsBeforeToolUse.includes(toolCall.name),
      );
    const pendingRequiredWritesBeforeToolUse = getPendingRequiredWriteToolNames(
      operationGoals,
      requiredWriteTools,
    );
    const responseRequestsPendingRequiredWrite = responseToolCalls.some(
      (toolCall) =>
        pendingRequiredWritesBeforeToolUse.includes(toolCall.name) ||
        (requiredWriteTools.includes(toolCall.name) &&
          !successfulToolNames.includes(toolCall.name)),
    );
    const shouldReserveFinalizationBeforeTool =
      responseToolCalls.length > 0 &&
      !responseRequestsPendingRequiredWrite &&
      loopBudgetPlan.finalizationReserve > 0 &&
      step < stepLimit &&
      ((loopBudgetPlan.toolStepBudget > 0 &&
        currentSegmentSuccessfulToolNames.length >= loopBudgetPlan.toolStepBudget &&
        !responseOnlyRequestsMissingRequiredWebTools) ||
        (loopBudgetPlan.toolStepBudget === 0 &&
          currentSegmentSuccessfulToolNames.length > 0 &&
          !responseOnlyRequestsMissingRequiredWebTools));

    if (shouldReserveFinalizationBeforeTool) {
      events.onStatus?.(
        "Tool budget is spent; reserving remaining steps for verification and final output...",
      );
      tools = [];
      allowedToolNames = new Set();
      messages.push({
        role: "system" as const,
        content:
          "The tool budget is spent. Do not request more tools. Verify the gathered context and draft the final answer or concise blocker.",
      });
      continue;
    }

    messages.push(
      withoutThinking(
        recoveredTextToolCalls
          ? {
              ...response.message,
              content: "",
              toolCalls: responseToolCalls,
            }
          : response.message,
      ),
    );

    if (responseToolCalls.length === 0) {
      if (
        streamingWritebackKind &&
        (streamingWritebackKind !== "edit" || preparedStreamingSectionEdit)
      ) {
        const webFallbackSatisfiedForWriteback =
          executedWebSearchTool ||
          executedWebFetchTool ||
          countFetchedWebSources(missionEvidenceRecords) > 0;
        const durablePreWriteProofSatisfied =
          requireToolBeforeStreamingWriteback &&
          !executedModelTool &&
          !webFallbackSatisfiedForWriteback &&
          hasSatisfiedDurablePreWriteProof();
        if (
          requireToolBeforeStreamingWriteback &&
          !executedModelTool &&
          !webFallbackSatisfiedForWriteback &&
          !durablePreWriteProofSatisfied
        ) {
          if (!toolBeforeWriteCorrectionUsed && step < stepLimit) {
            toolBeforeWriteCorrectionUsed = true;
            events.onStatus?.(
              "Sources or vault tools are required; asking model to use tools before writing...",
            );
            messages.push({
              role: "system" as const,
              content: buildToolBeforeStreamingWritebackPrompt(tools),
            });
            continue;
          }

          const missingWebToolsBeforeWriteback = getMissingRequiredWebToolNames({
            prompt: activeIntentPrompt,
            allowedToolNames,
            executedWebSearchTool,
            executedWebFetchTool,
            researchPlan,
            missionEvidence: missionEvidenceRecords,
          });
          if (missingWebToolsBeforeWriteback.length > 0) {
            try {
              if (
                await runRequiredWebToolFallback(
                  missingWebToolsBeforeWriteback,
                  step,
                )
              ) {
                events.onStatus?.(
                  "Required web context gathered; drafting final output...",
                );
                messages.push({
                  role: "system" as const,
                  content:
                    "Required web research tools have now run. Do not request more tools. Draft the final note writeback from the gathered source results.",
                });
                continue;
              }
            } catch (error) {
              events.onStatus?.(
                `Read-only web fallback failed: ${getUnknownErrorMessage(error)}`,
              );
            }
          }

          if (
            step < stepLimit &&
            hasCurrentWebFactIntent(activeIntentPrompt) &&
            executedWebSearchTool &&
            countFetchedWebSources(missionEvidenceRecords) > 0
          ) {
            events.onStatus?.(
              "Current web context gathered; drafting final note output with available sources...",
            );
            messages.push({
              role: "system" as const,
              content:
                "Current web research has fetched available source context, though the full source target may not be complete. Do not request more tools. Draft the requested note writeback from the gathered source results, include source URLs when available, and state limitations where source coverage is thin.",
            });
            continue;
          }

          const message =
            "I could not get the model to request the required read tools before writing. No vault files were changed.";
          emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
          recordLedgerBlocker(
            "Required read tools were not requested before writeback.",
          );
          await finishRun("error", lastStep, stepLimit);
          return;
        }
        if (stopIfRequested(step)) {
          return;
        }
        emitRunDiagnostics({
          events,
          toolContext: runToolContext,
          tools,
          enableStreaming,
          finalMode: "streaming_writeback",
          runPlan,
        });
        let receipt: AgentRunReceipt;
        try {
          const committedReceipt = await runProofGatedCurrentNoteWriteback({
            kind: streamingWritebackKind,
            preparedSectionEdit: preparedStreamingSectionEdit,
            modelClient,
            messages,
            events,
            toolContext: runToolContext,
            knownToolNames,
            relevancePrompt: finalAnswerRelevancePrompt,
            think: activeThink,
            options: modelOptions,
            abortSignal,
            onThinkingUnsupported: disableThinkingForRun,
          }, step, stepLimit);
          if (!committedReceipt) {
            return;
          }
          receipt = committedReceipt;
        } catch (error) {
          if (stopIfRequested(step)) {
            return;
          }
          await finishErroredRunFromException(error, step, stepLimit, "model");
          throw error;
        }
        if (stopIfRequested(step)) {
          return;
        }
        markStreamingWritebackGoalDone(operationGoals, streamingWritebackKind);
        writeReceipts.push(receipt);
        events.onReceipt?.(receipt);
        await recordLedgerReceipt(receipt);
        // Item 16: do not finish while other operation goals remain pending.
        if (hasPendingOperationGoals(operationGoals)) {
          events.onStatus?.(
            "Streamed write complete; remaining operation goals still pending...",
          );
          if (step < stepLimit) {
            messages.push({
              role: "system" as const,
              content:
                "The note write completed with a receipt. Continue with any remaining pending goals (such as title rename) before finishing.",
            });
            continue;
          }
        } else {
          await finishRun("write_completed", lastStep, stepLimit);
          return;
        }
      }

      const pendingRequiredWriteTools = getPendingRequiredWriteToolNames(
        operationGoals,
        requiredWriteTools,
      );
      if (writeRequired && pendingRequiredWriteTools.length > 0) {
        if (step < stepLimit) {
          events.onStatus?.("Write required; asking model to use a write tool...");
          messages.push({
            role: "system" as const,
            content: buildWriteCorrectionPrompt(pendingRequiredWriteTools),
          });
          continue;
        }

        break;
      }

      const missingWebTools = getMissingRequiredWebToolNames({
        prompt: activeIntentPrompt,
        allowedToolNames,
        executedWebSearchTool,
        executedWebFetchTool,
        researchPlan,
        missionEvidence: missionEvidenceRecords,
      });
      if (missingWebTools.length > 0) {
        if (!webResearchCorrectionUsed && step < stepLimit) {
          webResearchCorrectionUsed = true;
          events.onStatus?.(
            "Web research required; asking model to use web tools before answering...",
          );
          messages.push({
            role: "system" as const,
            content: buildWebResearchBeforeFinalAnswerPrompt(
              missingWebTools,
              tools,
            ),
          });
          continue;
        }

        try {
          if (await runRequiredWebToolFallback(missingWebTools, step)) {
            const pendingRequiredWriteToolsAfterFallback =
              getPendingRequiredWriteToolNames(
                operationGoals,
                requiredWriteTools,
              );
            const pendingStreamingWritebackAfterFallback =
              hasPendingStreamingWritebackGoal(
                operationGoals,
                streamingWritebackKind,
              );
            events.onStatus?.(
              pendingRequiredWriteToolsAfterFallback.length > 0 ||
                pendingStreamingWritebackAfterFallback
                ? "Required web context gathered; continuing to requested write..."
                : "Required web context gathered; drafting final output...",
            );
            if (
              pendingRequiredWriteToolsAfterFallback.length === 0 &&
              !pendingStreamingWritebackAfterFallback
            ) {
              tools = [];
              allowedToolNames = new Set();
            }
            messages.push({
              role: "system" as const,
              content:
                pendingRequiredWriteToolsAfterFallback.length > 0 ||
                pendingStreamingWritebackAfterFallback
                  ? "Required web research tools have now run. Continue with the requested note write. Use an available write tool if one is provided, otherwise draft only the final markdown for note writeback from the gathered source results."
                  : "Required web research tools have now run. Do not request more tools. Draft the final answer from the gathered source results.",
            });
            continue;
          }
        } catch (error) {
          events.onStatus?.(
            `Read-only web fallback failed: ${getUnknownErrorMessage(error)}`,
          );
        }

        const message =
          "I could not get the model to request the required web research tools before answering. No vault files were changed.";
        emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
        recordLedgerBlocker(
          "Required web research tools were not requested before final answer.",
        );
        await finishRun("error", lastStep, stepLimit);
        return;
      }

      if (
        requiresVaultTraversalBeforeFinalAnswer(
          activeIntentPrompt,
          runPlan,
          allowedToolNames,
        ) &&
        !executedModelTool
      ) {
        if (!vaultTraversalCorrectionUsed && step < stepLimit) {
          vaultTraversalCorrectionUsed = true;
          events.onStatus?.(
            "Vault traversal required; asking model to inspect folders and notes before answering...",
          );
          messages.push({
            role: "system" as const,
            content: buildVaultTraversalBeforeFinalAnswerPrompt(tools),
          });
          continue;
        }

        const message =
          consecutiveNoProgressSteps > 0
            ? "I could not get the model to request vault tools after a corrective retry. No vault files were changed."
            : "I could not get the model to request vault tools. No vault files were changed.";
        emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
        recordLedgerBlocker(
          "Vault traversal tools were not requested before final answer.",
        );
        await finishRun("error", lastStep, stepLimit);
        return;
      }

      reflexOutput = await reflexController.evaluate({
        prompt: activeIntentPrompt,
        missionIntent,
        allowedToolNames,
        recentActions,
        evidence: missionEvidenceRecords,
        // Live array: streamed writer.buildReceipt / tool writes push here
        // before this evaluate so write_receipt proof stays current.
        receipts: writeReceipts,
        settings: runToolContext.settings,
        embeddingProvider: runToolContext.semanticEmbeddingProvider,
      });
      if (
        runToolContext.settings?.agenticReflexEnabled === true &&
        !reflexOutput.completion.complete
      ) {
        const missingWriteReceipt = missingIncludesWriteReceipt(
          reflexOutput.completion.missing,
        );
        const writeRecoveryAvailable =
          missingWriteReceipt &&
          (streamingWritebackKind !== null ||
            reflexOutput.completion.recommendedNextTool !== undefined ||
            [...allowedToolNames].some((name) =>
              /^(append_to_current_file|replace_current_file|edit_current_section|create_file|append_file|replace_file)$/.test(
                name,
              ),
            ));

        if (step < stepLimit) {
          events.onStatus?.(
            `Reflex completion gate missing: ${reflexOutput.completion.missing.join(", ")}.`,
          );
          messages.push({
            role: "system" as const,
            content: buildReflexCompletionCorrectionPrompt(
              reflexOutput.completion.missing,
              tools,
            ),
          });
          continue;
        }

        // Item 1/15: at last step, attempt runner-owned streamed replace when
        // write_receipt is missing and current-note write/stream is allowed.
        if (
          missingWriteReceipt &&
          writeAutonomy &&
          hasActiveCurrentMarkdownFile(runToolContext) &&
          (streamingWritebackKind !== null ||
            prefersStreamedReplaceForEditOrganize(activeIntentPrompt) ||
            missionIntent.noteOutput ||
            missionIntent.requireWriteCompletion)
        ) {
          events.onStatus?.(
            "Write receipt missing; applying runner-owned current-note rewrite...",
          );
          try {
            const fallbackKind: StreamingWritebackKind =
              streamingWritebackKind === "edit" && preparedStreamingSectionEdit
                ? "edit"
                : "replace";
            const fallbackMessages: ModelChatMessage[] = [
              ...messages,
              {
                role: "system" as const,
                content:
                  "Reorganize and improve the current note. Replace the full note body with a clearer, better-structured markdown draft that preserves the user's topic and intent. Output only the note markdown.",
              },
            ];
            emitRunDiagnostics({
              events,
              toolContext: runToolContext,
              tools,
              enableStreaming,
              finalMode: "streaming_writeback",
              runPlan,
            });
            const committedReceipt = await runProofGatedCurrentNoteWriteback(
              {
                kind: fallbackKind,
                preparedSectionEdit:
                  fallbackKind === "edit" ? preparedStreamingSectionEdit : null,
                modelClient,
                messages: fallbackMessages,
                events,
                toolContext: runToolContext,
                knownToolNames,
                relevancePrompt: finalAnswerRelevancePrompt,
                think: activeThink,
                options: modelOptions,
                abortSignal,
                onThinkingUnsupported: disableThinkingForRun,
              },
              lastStep,
              stepLimit,
            );
            if (committedReceipt) {
              markStreamingWritebackGoalDone(operationGoals, fallbackKind);
              writeReceipts.push(committedReceipt);
              events.onReceipt?.(committedReceipt);
              await recordLedgerReceipt(committedReceipt);
              if (hasPendingOperationGoals(operationGoals)) {
                events.onStatus?.(
                  "Write completed; continuing for remaining operation goals...",
                );
                if (step < stepLimit) {
                  messages.push({
                    role: "system" as const,
                    content:
                      "A write receipt is now present. Complete any remaining pending operation goals (for example title rename) before finishing.",
                  });
                  continue;
                }
                // Last step: do not finish as write_completed while goals remain.
              } else {
                await finishRun("write_completed", lastStep, stepLimit);
                return;
              }
            }
          } catch (error) {
            events.onStatus?.(
              `Runner-owned write fallback failed: ${getUnknownErrorMessage(error)}`,
            );
          }
        }

        // Item 15: do not terminal-fail reflex when write recovery is still
        // available; let mission acceptance decide the hard stop.
        if (writeRecoveryAvailable) {
          events.onStatus?.(
            `Reflex still missing ${reflexOutput.completion.missing.join(", ")}; deferring to acceptance.`,
          );
        } else {
          const message = `I could not complete the mission because required evidence is missing: ${reflexOutput.completion.missing.join(", ")}. No additional vault files were changed.`;
          emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
          recordLedgerBlocker(message);
          await finishRun("error", lastStep, stepLimit);
          return;
        }
      }

      const acceptanceBeforeFinal = evaluateCurrentAcceptance();
      await recordMissionAcceptance(acceptanceBeforeFinal, step);
      if (acceptanceBeforeFinal.status !== "pass" && isRepeatedToolBudgetSpent()) {
        await stopRepeatedToolBudget();
        return;
      }
      if (
        shouldContinueForMissionAcceptance(
          acceptanceBeforeFinal,
          step,
          stepLimit,
        )
      ) {
        if (step < stepLimit) {
          events.onStatus?.(
            formatAcceptanceFailureCopy(acceptanceBeforeFinal.missing),
          );
          messages.push({
            role: "system" as const,
            content: formatMissionAcceptanceCorrection(
              acceptanceBeforeFinal,
              tools.map((tool) => tool.function.name),
            ),
          });
          continue;
        }

        if (acceptanceBeforeFinal.status === "fail") {
          const message = `I could not complete the mission because acceptance checks failed: ${acceptanceBeforeFinal.missing.join(", ")}.`;
          emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
          recordLedgerBlocker(message);
          await finishRun("error", lastStep, stepLimit, acceptanceBeforeFinal.nextAction);
          return;
        }
      }

      const hasDirectFinalContent = hasRenderableAssistantContent(
        response.message.content,
      );
      const requiresPreEmissionVerification = requiresVerifiedFinalOutput(
        missionPlan,
        researchPlan,
      );

      if (enableStreaming && !hasDirectFinalContent) {
        if (stopIfRequested(step)) {
          return;
        }
        emitRunDiagnostics({
          events,
          toolContext: runToolContext,
          tools,
          enableStreaming,
          finalMode: executedModelTool ? "streaming_final" : "streaming_direct",
          runPlan,
        });
        try {
          const streamedResponse = await emitFinalAnswer({
            modelClient,
            messages,
            events,
            enableStreaming,
            fallbackContent: response.message.content,
            finalInstruction: buildFinalAnswerPrompt(activeIntentPrompt),
            relevancePrompt: finalAnswerRelevancePrompt,
            think: activeThink,
            options: modelOptions,
            abortSignal,
            onThinkingUnsupported: disableThinkingForRun,
            deferVisibleOutput: requiresPreEmissionVerification,
          });
          lastFinalOutput =
            streamedResponse?.message.content ?? response.message.content ?? "";
        } catch (error) {
          if (stopIfRequested(step)) {
            return;
          }
          throw error;
        }
        if (stopIfRequested(step)) {
          return;
        }
      } else {
        if (stopIfRequested(step)) {
          return;
        }
        let directContent = response.message.content;
        const wordTarget = parseGeneratedWordCountTargetFromMessages(messages);
        if (wordTarget) {
          const initialCount = countMarkdownVisibleText(directContent).wordCount;
          let correctionUsed = false;
          if (!isWordCountWithinTarget(initialCount, wordTarget)) {
            events.onStatus?.(
              `Word count ${initialCount}/${wordTarget.target} outside target; requesting one correction pass...`,
            );
            const corrected = await requestWordCountCorrection({
              modelClient,
              messages,
              draft: directContent,
              wordTarget,
              events,
              think: activeThink,
              options: modelOptions,
              abortSignal,
              onThinkingUnsupported: disableThinkingForRun,
              metricName: "direct_answer_word_count_correction",
            });
            if (corrected.trim()) {
              directContent = corrected;
              correctionUsed = true;
            }
          }
          const finalCount = countMarkdownVisibleText(directContent).wordCount;
          events.onStatus?.(
            `Word count: ${finalCount}/${wordTarget.target} (${isWordCountWithinTarget(finalCount, wordTarget) ? "within target" : "outside target"}; correction=${correctionUsed ? "used" : "not used"}).`,
          );
        }
        emitRunDiagnostics({
          events,
          toolContext: runToolContext,
          tools,
          enableStreaming,
          finalMode: executedModelTool ? "buffered_final" : "direct",
          runPlan,
        });
        if (runPlan.requiresEnglishGuard) {
          directContent = await repairEnglishOnlyOutput({
            modelClient,
            messages,
            draft: directContent,
            events,
            think: activeThink,
            options: modelOptions,
            abortSignal,
            onThinkingUnsupported: disableThinkingForRun,
            metricName: "direct_answer_english_repair",
          });
        }
        if (!requiresPreEmissionVerification) {
          emitDirectAssistantAnswer(
            directContent,
            events,
            runPlan.requiresEnglishGuard,
          );
        }
        lastFinalOutput = directContent;
      }
      if (requiresPreEmissionVerification) {
        const candidateAcceptance = evaluateCurrentAcceptance(lastFinalOutput);
        await recordMissionAcceptance(candidateAcceptance, step);
        if (candidateAcceptance.status !== "pass") {
          const rejectedCandidate = lastFinalOutput;
          lastFinalOutput = "";
          if (
            step < stepLimit &&
            !finalOutputCorrectionUsed &&
            candidateAcceptance.missing.length > 0 &&
            candidateAcceptance.missing.every(isRepairableFinalOutputProof)
          ) {
            finalOutputCorrectionUsed = true;
            events.onStatus?.(
              `Draft held for verification: ${candidateAcceptance.missing.join(", ")}.`,
            );
            messages.push({
              role: "system" as const,
              content: buildFinalOutputVerificationCorrectionPrompt(
                candidateAcceptance,
                rejectedCandidate,
                activeIntentPrompt,
              ),
            });
            continue;
          }

          const message =
            `Final output was not shown because verification is incomplete: ${
              candidateAcceptance.missing.join(", ") || "unknown proof"
            }. The run remains resumable.`;
          events.onStatus?.(message);
          emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
          recordLedgerBlocker(message);
          await finishRun(
            "budget",
            lastStep,
            stepLimit,
            candidateAcceptance.nextAction ?? message,
          );
          return;
        }

        emitDirectAssistantAnswer(
          lastFinalOutput,
          events,
          runPlan.requiresEnglishGuard,
        );
      }
      if (
        missionIntent.explicitMutation &&
        isBroadUnscopedVaultMutation(missionIntent.autonomyScope) &&
        lastFinalOutput.trim()
      ) {
        recordLedgerBlocker(lastFinalOutput.trim());
      }
      await checkpointRunIfDue({
        toolContext: runToolContext,
        events,
        runId,
        step,
        stepLimit,
        runPlan,
        toolNames: responseToolCalls.map((toolCall) => toolCall.name),
      });
      await finishRun(
        isClarifyingQuestionResponse(activeIntentPrompt, response.message.content)
          ? "clarifying_question"
          : "final",
        lastStep,
        stepLimit,
      );
      return;
    }

    let shouldReplanAfterUnavailableTool = false;
    let shouldReplanAfterProofGatedWriteTool = false;

    for (let toolIndex = 0; toolIndex < responseToolCalls.length;) {
      if (stopIfRequested(step)) {
        return;
      }
      if (toolCallBudgetExhausted || observedToolCallCount >= maxToolCalls) {
        toolCallBudgetExhausted = true;
        await finishRun(
          "budget",
          lastStep,
          stepLimit,
          "Per-segment tool-call budget exhausted; continue from the saved ledger.",
        );
        return;
      }

      const toolCall = responseToolCalls[toolIndex];
      const toolEventBase: AgentToolRunEvent = {
        id: `${step}:${toolIndex}:${toolCall.name}`,
        name: toolCall.name,
        step,
      };

      if (!allowedToolNames.has(toolCall.name)) {
        events.onStatus?.(`Rejected unavailable tool: ${toolCall.name}`);
        events.onTrace?.({
          id: `${toolEventBase.id}:rejected`,
          kind: "tool_rejected",
          step,
          toolName: toolCall.name,
          message: `Rejected unavailable tool: ${toolCall.name}`,
          inputPreview: redactToolArguments(toolCall.name, toolCall.arguments),
          error: {
            code: "tool_not_allowed",
            message: `Tool is not available for this prompt: ${toolCall.name}`,
          },
        });
        events.onToolDone?.({
          ...toolEventBase,
          ok: false,
          message: `Rejected unavailable tool: ${toolCall.name}`,
          error: {
            code: "tool_not_allowed",
            message: `Tool is not available for this prompt: ${toolCall.name}`,
          },
        });
        messages.push({
          role: "tool" as const,
          toolName: toolCall.name,
          content: serializeToolResultForModel({
            ok: false,
            toolName: toolCall.name,
            error: {
              code: "tool_not_allowed",
              message: `Tool is not available for this prompt: ${toolCall.name}`,
            },
          }),
        });
        if (isWriteToolName(toolCall.name)) {
          shouldReplanAfterUnavailableTool = true;
        }
        toolIndex += 1;
        continue;
      }

      if (
        isWriteToolName(toolCall.name) &&
        !(
          hasParallelVaultReadIntent(activeIntentPrompt) &&
          toolCall.name === "append_to_current_file" &&
          requiredWriteTools.includes("append_to_current_file") &&
          currentSegmentSuccessfulToolNames.filter((name) =>
            READ_ONLY_TOOL_NAMES.has(name),
          ).length >= 2
        ) &&
        !isToolAllowedForActiveMissionTask(missionPlan, toolCall.name) &&
        !isPendingRequiredWriteReady(
          toolCall.name,
          getPendingRequiredWriteToolNames(
            operationGoals,
            requiredWriteTools,
          ),
        )
      ) {
        const activeTask = getActiveMissionPlanTask(missionPlan);
        const nextAction = getNextMissionPlanAction(missionPlan)?.summary;
        const message = activeTask
          ? `Deferred ${toolCall.name}: active task ${activeTask.id} must complete first.`
          : `Deferred ${toolCall.name}: the mission plan has no ready task for this mutation.`;
        events.onStatus?.(message);
        events.onTrace?.({
          id: `${toolEventBase.id}:plan-dependency-rejected`,
          kind: "tool_rejected",
          step,
          toolName: toolCall.name,
          message,
          inputPreview: redactToolArguments(toolCall.name, toolCall.arguments),
          outputPreview: {
            activeTaskId: activeTask?.id,
            allowedTools: activeTask?.allowedTools ?? [],
            nextAction,
          },
          error: {
            code: "plan_dependency_violation",
            message,
          },
        });
        events.onToolDone?.({
          ...toolEventBase,
          ok: false,
          message,
          error: {
            code: "plan_dependency_violation",
            message,
          },
        });
        messages.push({
          role: "tool" as const,
          toolName: toolCall.name,
          content: serializeToolResultForModel({
            ok: false,
            toolName: toolCall.name,
            error: {
              code: "plan_dependency_violation",
              message: [
                message,
                nextAction ? `Next: ${nextAction}` : "",
              ].filter(Boolean).join(" "),
            },
          }),
        });
        messages.push({
          role: "system" as const,
          content: [
            "Follow the persisted mission-plan dependency order.",
            nextAction ? `Next: ${nextAction}` : "Complete the current ready task first.",
            `Do not request ${toolCall.name} again until it is allowed by the active task.`,
          ].join(" "),
        });
        shouldReplanAfterUnavailableTool = true;
        toolIndex += 1;
        continue;
      }

      if (
        streamingWritebackKind !== null &&
        toolCall.name === getStreamingWritebackToolName(streamingWritebackKind) &&
        requiresVerifiedFinalOutput(missionPlan, researchPlan)
      ) {
        const message =
          `Held ${toolCall.name} before mutation because this sourced writeback requires final passage verification. Return the complete proposed note content as the final answer without a tool call; the runner will verify and commit it exactly once.`;
        events.onStatus?.(message);
        events.onTrace?.({
          id: `${toolEventBase.id}:proof-gated-writeback-rejected`,
          kind: "tool_rejected",
          step,
          toolName: toolCall.name,
          message,
          inputPreview: redactToolArguments(toolCall.name, toolCall.arguments),
          error: {
            code: "proof_gated_writeback_required",
            message,
          },
        });
        events.onToolDone?.({
          ...toolEventBase,
          ok: false,
          message,
          error: {
            code: "proof_gated_writeback_required",
            message,
          },
        });
        messages.push({
          role: "tool" as const,
          toolName: toolCall.name,
          content: serializeToolResultForModel({
            ok: false,
            toolName: toolCall.name,
            error: {
              code: "proof_gated_writeback_required",
              message,
            },
          }),
        });
        messages.push({
          role: "system" as const,
          content:
            "Do not request a current-note write tool again. Return the complete sourced markdown as your final answer. The runner will hold it, verify passage ids and quotation spans, and perform the single authorized note mutation only after verification passes.",
        });
        shouldReplanAfterProofGatedWriteTool = true;
        toolIndex += 1;
        continue;
      }

      if (READ_ONLY_TOOL_NAMES.has(toolCall.name)) {
        const batch: Array<{ call: ModelToolCall; index: number }> = [];
        for (
          let batchIndex = toolIndex;
          batchIndex < responseToolCalls.length &&
          batch.length < MAX_PARALLEL_TOOL_CALLS &&
          batch.length < maxToolCalls - observedToolCallCount;
          batchIndex += 1
        ) {
          const candidate = responseToolCalls[batchIndex];
          if (
            !allowedToolNames.has(candidate.name) ||
            !READ_ONLY_TOOL_NAMES.has(candidate.name)
          ) {
            break;
          }
          batch.push({ call: candidate, index: batchIndex });
        }

        if (batch.length > 1) {
          events.onStatus?.(
            `Running ${batch.length} read-only tools in parallel...`,
          );
          try {
            const results = await Promise.all(
              batch.map(({ call, index }) =>
                runObservedModelToolCall({
                  origin: "model",
                  toolCall: call,
                  step,
                  toolIndex: index,
                  recordTranscript: false,
                }),
              ),
            );
            for (let resultIndex = 0; resultIndex < batch.length; resultIndex += 1) {
              const item = batch[resultIndex];
              appendToolTranscript({
                messages,
                toolCall: item.call,
                resultContent: serializeToolResultForModel(results[resultIndex]),
                origin: "model",
                fallbackId: buildToolCallFallbackId(
                  runId,
                  step,
                  item.index,
                  item.call.name,
                ),
              });
            }
          } catch (error) {
            if (stopIfRequested(step)) {
              return;
            }
            await finishErroredRunFromException(error, step, stepLimit, "tool");
            return;
          }
          toolIndex += batch.length;
          continue;
        }
      }

      try {
        await runObservedModelToolCall({
          origin: "model",
          toolCall,
          step,
          toolIndex,
        });
      } catch (error) {
        if (stopIfRequested(step)) {
          return;
        }
        await finishErroredRunFromException(error, step, stepLimit, "tool");
        return;
      }
      toolIndex += 1;
    }

    if (stopIfRequested(step)) {
      return;
    }

    if (
      shouldReplanAfterProofGatedWriteTool &&
      !proofGatedWriteToolCorrectionUsed &&
      step < stepLimit
    ) {
      proofGatedWriteToolCorrectionUsed = true;
      continue;
    }

    if (
      shouldReplanAfterUnavailableTool &&
      !unavailableToolCorrectionUsed &&
      step < stepLimit
    ) {
      unavailableToolCorrectionUsed = true;
      events.onStatus?.("Unavailable write tool requested; asking model to choose an allowed path...");
      messages.push({
        role: "system" as const,
        content: buildUnavailableToolCorrectionPrompt(tools),
      });
      continue;
    }

    await checkpointRunIfDue({
      toolContext: runToolContext,
      events,
      runId,
      step,
      stepLimit,
      runPlan,
      toolNames: responseToolCalls.map((toolCall) => toolCall.name),
    });

    const missionComplete = isMissionComplete(operationGoals);
    const completedAnyWrite = operationGoals.completedTools.some((toolName) =>
      isWriteToolName(toolName),
    );
    const pendingRequiredWriteToolsAfterToolUse = getPendingRequiredWriteToolNames(
      operationGoals,
      requiredWriteTools,
    );
    const missingRequiredWebToolsAfterToolUse = getMissingRequiredWebToolNames({
      prompt: activeIntentPrompt,
      allowedToolNames,
      executedWebSearchTool,
      executedWebFetchTool,
      researchPlan,
      missionEvidence: missionEvidenceRecords,
    });
    const pendingStreamingWriteback =
      hasPendingStreamingWritebackGoal(operationGoals, streamingWritebackKind);
    const operationWriteComplete =
      completedAnyWrite &&
      pendingRequiredWriteToolsAfterToolUse.length === 0 &&
      missingRequiredWebToolsAfterToolUse.length === 0 &&
      !pendingStreamingWriteback;
    const requiresPostWriteAcceptance = researchPlan !== null;
    const postToolAcceptance =
      operationWriteComplete && requiresPostWriteAcceptance
      ? evaluateCurrentAcceptance()
      : null;
    const writeMissionComplete =
      operationWriteComplete &&
      (!requiresPostWriteAcceptance || postToolAcceptance?.status === "pass");
    events.onTrace?.({
      id: `operation-goals:${step}`,
      kind: "status",
      step,
      message: "Operation goals checked.",
      outputPreview: {
        goals: operationGoals.goals,
        completedTools: operationGoals.completedTools,
        completedAnyWrite,
        pendingRequiredWriteTools: pendingRequiredWriteToolsAfterToolUse,
        missingRequiredWebTools: missingRequiredWebToolsAfterToolUse,
        pendingStreamingWriteback,
        missionComplete,
        operationWriteComplete,
        requiresPostWriteAcceptance,
        postToolAcceptanceStatus: postToolAcceptance?.status,
        postToolAcceptanceMissing: postToolAcceptance?.missing,
        writeMissionComplete,
      },
    });

    if (
      consecutiveNoProgressSteps === 1 &&
      !missionComplete &&
      !writeMissionComplete &&
      step < stepLimit
    ) {
      events.onStatus?.(
        "Repeated tool call detected; asking model to synthesize or choose a different tool...",
      );
      messages.push({
        role: "system" as const,
        content:
          "You repeated the same tool call without making progress. Do not repeat that same call again. Either use a different useful tool or draft the final answer/writeback from the context already gathered.",
      });
      continue;
    }

    if (writeMissionComplete && !hasPendingOperationGoals(operationGoals)) {
      emitRunDiagnostics({
        events,
        toolContext: runToolContext,
        tools,
        enableStreaming,
        finalMode: "none",
        runPlan,
      });
      emitLocalWriteSummary(events, writeReceipts);
      await finishRun("write_completed", lastStep, stepLimit);
      return;
    }

    if (writeMissionComplete && hasPendingOperationGoals(operationGoals)) {
      events.onStatus?.(
        "Write tools finished; remaining operation goals still pending...",
      );
      if (step < stepLimit) {
        messages.push({
          role: "system" as const,
          content:
            "A write completed, but other requested operation goals are still pending. Continue with the remaining goals before finishing.",
        });
        continue;
      }
    }

    const requiredLoopToolsSatisfied = areLoopRequiredToolsSatisfied(
      loopBudgetPlan.expectedTools,
      successfulToolNames,
    );
    const loopLedger: LoopLedger = {
      successfulTools: [...successfulToolNames],
      failedTools: [...failedToolNames],
      repeatedToolCalls: consecutiveNoProgressSteps,
      requiredToolsSatisfied: requiredLoopToolsSatisfied,
      finalizationReserved: loopBudgetPlan.finalizationReserve > 0,
      writeCompleted: writeMissionComplete,
      wallClockExpired: missionLedger?.wallClockExpired === true,
      planComplete: missionPlan
        ? isMissionPlanComplete(missionPlan) &&
          missionComplete &&
          loopBudgetPlan.expectedTools.length > 0 &&
          requiredLoopToolsSatisfied
        : undefined,
      planNeedsVerification:
        getActiveMissionPlanTask(missionPlan)?.status === "needs_verification",
      planHasBlocker:
        missionPlan?.status === "blocked" ||
        getActiveMissionPlanTask(missionPlan)?.status === "blocked",
      shouldReplan: missionPlan ? missionPlan.progress.stalledCount >= 2 : false,
      researchPhase: researchPhaseDescriptor?.phase,
      researchWriteToolsBlocked:
        researchPhaseDescriptor?.researchBearing === true &&
        researchPhaseDescriptor.writeToolsAllowed !== true,
    };
    const loopDecision = applyResearchPhaseToLoopDecision(
      decideNextLoopAction(loopLedger, loopBudgetPlan),
      researchPhaseDescriptor,
    );
    if (
      loopDecision.action === "stop_budget" &&
      loopDecision.reason === "required_tools_failed"
    ) {
      const unresolvedFailures = [
        ...new Set(
          failedToolNames.filter(
            (toolName) => !successfulToolNames.includes(toolName),
          ),
        ),
      ];
      const message =
        `Required tool execution failed without producing usable proof: ${
          unresolvedFailures.join(", ") || "unknown tool"
        }.`;
      events.onStatus?.(message);
      recordLedgerBlocker(message);
      await finishRun("budget", lastStep, stepLimit, message);
      return;
    }
    if (loopDecision.action === "verify_active_task" && step < stepLimit) {
      const acceptanceAfterToolUse = evaluateCurrentAcceptance();
      await recordMissionAcceptance(acceptanceAfterToolUse, step);
      if (
        shouldContinueForMissionAcceptance(
          acceptanceAfterToolUse,
          step,
          stepLimit,
        )
      ) {
        events.onStatus?.(
          formatAcceptanceFailureCopy(acceptanceAfterToolUse.missing),
        );
        messages.push({
          role: "system" as const,
          content: formatMissionAcceptanceCorrection(
            acceptanceAfterToolUse,
            tools.map((tool) => tool.function.name),
          ),
        });
        continue;
      }

      events.onStatus?.("Mission plan proof is ready; drafting final output...");
      messages.push({
        role: "system" as const,
        content:
          "The active mission-plan proof is ready for final synthesis. Do not request more tools unless one is strictly required by the latest acceptance check. Draft the final answer or complete the requested writeback from the gathered evidence.",
      });
      continue;
    }
    if (loopDecision.action === "reflect_and_replan" && missionPlan && step < stepLimit) {
      const failedAction = recentActions.at(-1)?.name;
      const boundedRecovery = decideRecoveryAction({
        plan: missionPlan,
        failure: {
          source: missionPlan.activeTaskId ?? "mission",
          message: `stalled:${failedAction ?? "model_step"}`,
          retryable: true,
          requiresReplan: true,
        },
        state: recoveryState,
        now: runToolContext.now?.() ?? new Date(),
      });
      recoveryState = boundedRecovery.state;
      events.onTrace?.({
        id: `bounded-recovery-${step}`,
        kind: "status",
        step,
        toolName: failedAction,
        message: boundedRecovery.reason,
        outputPreview: {
          action: boundedRecovery.action,
          signature: boundedRecovery.signature,
          attemptsUsed: boundedRecovery.attemptsUsed,
          attemptsRemaining: boundedRecovery.attemptsRemaining,
        },
      });
      if (boundedRecovery.action === "block") {
        if (boundedRecovery.planAdvance) {
          applyMissionPlanAdvance(
            boundedRecovery.planAdvance,
            step,
            boundedRecovery.reason,
          );
        }
        recordLedgerBlocker(boundedRecovery.reason);
        await persistMissionLedger(`mission-ledger-bounded-recovery-${step}`);
        await finishRun(
          "budget",
          lastStep,
          stepLimit,
          boundedRecovery.reason,
        );
        return;
      }
      const recoveryDecision = planRecovery({
        plan: missionPlan,
        reason: "stalled",
        failedAction,
        allowedToolNames: [...allowedToolNames],
        attemptedActions: recoveryAttemptSignatures,
      });
      for (const attempt of recoveryDecision.attempts) {
        recoveryAttemptSignatures.push(`${attempt.nodeId ?? "run"}:${attempt.selectedAction.toolName ?? attempt.selectedAction.kind}`);
        events.onTrace?.({
          id: `${attempt.id}-${step}`,
          kind: "status",
          step,
          toolName: attempt.selectedAction.toolName,
          message: `Recovery planned: ${attempt.message}`,
          outputPreview: attempt,
        });
      }
      if (recoveryDecision.status === "block") {
        missionPlan = applyRecoveryToPlan(missionPlan, recoveryDecision);
        recordLedgerBlocker(recoveryDecision.blocker ?? "Recovery blocked.");
        await persistMissionLedger(`mission-ledger-recovery-blocked-${step}`);
        if (isRepeatedToolBudgetSpent()) {
          await stopRepeatedToolBudget();
          return;
        }
        const message = recoveryDecision.blocker ?? "Recovery blocked.";
        emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
        await finishRun("error", lastStep, stepLimit, message);
        return;
      }
      if (recoveryDecision.updatedAction) {
        missionPlan = applyRecoveryToPlan(missionPlan, recoveryDecision);
        if (missionLedger) {
          setLedgerMissionPlan(
            missionLedger,
            missionPlan,
            runToolContext.now?.() ?? new Date(),
          );
        }
      }
      events.onStatus?.(
        "Mission plan appears stalled; asking model to choose a different next action...",
      );
      messages.push({
        role: "system" as const,
        content: [
          "The current plan action appears stalled. Do not repeat the same tool call or model-only step.",
          recoveryDecision.updatedAction
            ? `Runner recovery selected: ${recoveryDecision.updatedAction.summary}`
            : "",
          formatMissionPlanNextActionPrompt(missionPlan),
          "Choose a different available tool, summarize the blocker, or synthesize from gathered evidence if the proof contract is satisfied.",
        ].filter(Boolean).join("\n\n"),
      });
      consecutiveNoProgressSteps = 0;
      continue;
    }
    if (loopDecision.action === "stop_resumable_blocker") {
      const message =
        missionPlan?.nextAction?.summary ??
        "Mission plan is blocked and can be resumed from the saved ledger.";
      emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
      recordLedgerBlocker(message);
      await finishRun("budget", lastStep, stepLimit, message);
      return;
    }
    if (
      loopDecision.action === "stop_budget" &&
      loopDecision.reason === "wall_clock_budget"
    ) {
      const message =
        "Wall-clock run budget expired. The ledger was saved and this run can be continued.";
      emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
      await finishRun("budget", lastStep, stepLimit, message);
      return;
    }
    if (loopDecision.action === "stop_verified_complete" && step < stepLimit) {
      events.onStatus?.("Mission plan complete; asking model for final synthesis...");
      tools = [];
      allowedToolNames = new Set();
      messages.push({
        role: "system" as const,
        content:
          "The mission plan is complete. Do not request more tools. Provide the final answer now using the gathered evidence and receipts.",
      });
      continue;
    }
    if (
      loopDecision.action === "force_final_no_tools" &&
      pendingRequiredWriteToolsAfterToolUse.length === 0 &&
      (!completedAnyWrite || !missionComplete) &&
      step < stepLimit
    ) {
      if (isRepeatedToolBudgetSpent()) {
        await stopRepeatedToolBudget();
        return;
      }
      const preserveToolsForStreamingWriteback =
        pendingStreamingWriteback && streamingWritebackKind !== null;
      events.onStatus?.(
        `Tool context is sufficient; drafting final output (${loopDecision.reason})...`,
      );
      if (!preserveToolsForStreamingWriteback) {
        tools = [];
        allowedToolNames = new Set();
      }
      messages.push({
        role: "system" as const,
        content:
          preserveToolsForStreamingWriteback
            ? "Required context has been gathered. Continue to the requested note writeback now from the gathered tool results. Prefer final markdown content for streaming; if you request a tool, use only an available current-note write tool."
            : "Required context has been gathered. Do not request more tools. Draft the final answer now from the gathered tool results.",
      });
      continue;
    }
    if (
      loopDecision.action === "stop_budget" &&
      loopDecision.reason === "repeated_tool_call_without_progress" &&
      !missionComplete &&
      !writeMissionComplete
    ) {
      events.onStatus?.(
        "Stopped repeated tool loop before burning the full safety limit.",
      );
      recordLedgerBlocker(
        "Repeated tool call loop stopped before full safety limit.",
      );
        await finishRun("budget", lastStep, stepLimit);
        return;
      }
  }

  await checkpointRunIfDue({
    toolContext: runToolContext,
    events,
    runId,
    step: Math.max(lastStep, stepLimit),
    stepLimit,
    runPlan,
    toolNames: [],
    status: "budget",
    message: "Stopped at safety limit. Review partial results.",
    force: true,
  });
  await finishRun("budget", Math.max(lastStep, stepLimit), stepLimit);
}

export type FinalEmissionMode =
  | "direct"
  | "buffered_final"
  | "streaming_direct"
  | "streaming_final"
  | "streaming_writeback"
  | "none";

const LIVE_FLUSH_CHAR_THRESHOLD = 120;
const LIVE_FLUSH_MS = 150;
const LIVE_FLUSH_TIMER_MS = 75;

type OperationGoal =
  | "read_current_note"
  | "web_search"
  | "web_fetch"
  | "current_note_title"
  | "current_note_highlight"
  | "current_note_restore"
  | "current_note_content"
  | "current_note_replace"
  | "current_section_edit"
  | "path_create"
  | "path_append"
  | "path_replace"
  | "path_move"
  | "path_delete"
  | "current_note_delete";

type OperationGoalState = "not_requested" | "pending" | "done" | "failed";

interface MissionOperationGoals {
  goals: Record<OperationGoal, OperationGoalState>;
  completedTools: string[];
}

type LeadingTitleResult =
  | { status: "pending" }
  | { status: "no_title"; body: string }
  | { status: "title"; title: string; body: string };

interface PreparedStreamingSectionEdit {
  path: string;
  backupPath: string;
  heading: string;
  level: number;
  prefix: string;
  suffix: string;
  replacedChars: number;
}

async function readInitialCurrentNote(
  toolRegistry: ToolRegistry,
  toolContext: ToolExecutionContext,
  events: AgentRunEvents,
): Promise<unknown> {
  emitStatus(events, "Reading current note...", "reading_current_note");
  return observeCurrentNote(toolRegistry, toolContext, events);
}

async function observeCurrentNote(
  toolRegistry: ToolRegistry,
  toolContext: ToolExecutionContext,
  events: AgentRunEvents,
): Promise<unknown> {
  const result = await executeToolWithMetrics({
    toolRegistry,
    toolCall: {
      name: "read_current_file",
      arguments: { maxChars: MAX_INITIAL_CURRENT_NOTE_CHARS },
    },
    toolContext,
    events,
  });

  if (!result.ok) {
    throw new Error(result.error?.message ?? "Unable to read current note.");
  }

  return result.output;
}

async function runObservedTool({
  name,
  arguments: toolArguments,
  toolRegistry,
  toolContext,
  events,
  step,
}: {
  name: string;
  arguments: Record<string, unknown>;
  toolRegistry: ToolRegistry;
  toolContext: ToolExecutionContext;
  events: AgentRunEvents;
  step: number;
}): Promise<unknown> {
  const toolCall = { name, arguments: toolArguments };
  const toolEventBase: AgentToolRunEvent = {
    id: `${step}:local:${name}`,
    name,
    step,
  };

  events.onToolStart?.({
    ...toolEventBase,
    message: `Running tool: ${name}`,
  });
  events.onTrace?.({
    id: `${toolEventBase.id}:start`,
    kind: "tool_start",
    step,
    toolName: name,
    message: `Running ${name}`,
    inputPreview: redactToolArguments(name, toolArguments),
  });
  events.onPhaseChange?.("running_tool", `Running tool: ${name}`);
  emitToolPreparationStatus(name, events);
  events.onStatus?.(`Running tool: ${name}`);

  const result = await executeToolWithMetrics({
    toolRegistry,
    toolCall,
    toolContext,
    events,
    step,
  });

  if (!result.ok) {
    const failureStatus = formatObservedToolFailureStatus(name, result);
    events.onStatus?.(failureStatus);
    events.onToolDone?.({
      ...toolEventBase,
      ok: false,
      message: failureStatus,
      error: result.error,
    });
    events.onTrace?.({
      id: `${toolEventBase.id}:result`,
      kind: "tool_result",
      step,
      toolName: name,
      message: failureStatus,
      error: result.error,
      outputPreview: truncateTracePayload(result),
    });
    throw new Error(result.error?.message ?? failureStatus);
  }

  const successMessage = emitToolSuccessStatus(name, result.output, events);
  events.onToolDone?.({
    ...toolEventBase,
    ok: true,
    message: successMessage,
    output: result.output,
  });
  events.onTrace?.({
    id: `${toolEventBase.id}:result`,
    kind: "tool_result",
    step,
    toolName: name,
    message: successMessage,
    outputPreview: truncateTracePayload(result.output),
  });

  return result.output;
}

function formatCurrentNoteContext(currentNoteContext: unknown): string {
  return `Current note context: ${JSON.stringify(currentNoteContext)}`;
}

function formatCurrentNoteReadSatisfiedContext(): string {
  return [
    "The active current note has already been read for this run.",
    "Use the included Current note context instead of requesting read_current_file again.",
    "If sources, verification, graph, vault search, or word-count tools are available and relevant, request those tools directly.",
  ].join(" ");
}

function formatRuntimeContext(
  toolContext: ToolExecutionContext,
  prompt: string,
): string {
  const now = toolContext.now?.() ?? new Date();
  const parts = [
    `Current date/time: ${now.toDateString()} (${now.toISOString()}).`,
  ];

  if (hasAmbiguousDatePrompt(prompt)) {
    parts.push(
      "The user appears to ask date math without a needed year or reference date. Ask one concise clarifying question before calculating.",
    );
  }

  if (toolContext.writeAutonomy) {
    parts.push(
      "This mission is expected to produce note output. Use the available safe write tool that best fits the mission instead of leaving the result only in chat.",
    );
  }

  return parts.join(" ");
}

function formatResponseLanguageContext(prompt: string): string {
  const languageHint = isLikelyEnglishPrompt(prompt)
    ? "The current user mission appears to be English."
    : "Infer the response language from the current user mission.";

  return [
    "Response language policy:",
    languageHint,
    "Default to English for English missions.",
    "Use another language only when the current user mission is primarily in that language or explicitly requests it.",
    "Do not switch to Chinese, translated programming problems, or unrelated templates unless the user asks for them.",
    "Answer the exact requested topic; if grounded support is requested but no source tool is available, avoid fabricated sources and use careful, qualified prose.",
  ].join(" ");
}

function isLikelyEnglishPrompt(prompt: string): boolean {
  const englishLetters = prompt.match(/[A-Za-z]/g)?.length ?? 0;
  const nonAsciiChars = prompt.match(/[^\x00-\x7F]/g)?.length ?? 0;

  return englishLetters > 0 && englishLetters >= nonAsciiChars;
}

function formatMissionIntentContext(intent: MissionIntent): string {
  const scope = intent.autonomyScope;
  return [
    `Mission mode: ${intent.mode}.`,
    `Vault context answer: ${intent.vaultContext ? "yes" : "no"}.`,
    `Autonomous write allowed: ${intent.allowAutonomousWrite ? "yes" : "no"}.`,
    `Write required: ${intent.requireWriteCompletion ? "yes" : "no"}.`,
    `Delete allowed: ${
      intent.explicitDelete ? "yes, explicit delete intent detected" : "no"
    }.`,
    `Autonomy scope: read_current_note=${scope.read.currentNote ? "yes" : "no"}, read_vault=${scope.read.vault ? "yes" : "no"}, read_web=${scope.read.web ? "yes" : "no"}, read_files=${formatScopeList(scope.read.files)}, read_folders=${formatScopeList(scope.read.folders)}, write_current_note=${scope.write.currentNote ? "yes" : "no"}, write_files=${formatScopeList(scope.write.files)}, write_folders=${formatScopeList(scope.write.folders)}, write_artifacts=${scope.write.artifacts ? "yes" : "no"}, write_research_memory=${scope.write.researchMemory ? "yes" : "no"}, replace_current_note=${scope.destructive.replaceCurrentNote ? "yes" : "no"}, delete_current_note=${scope.destructive.deleteCurrentNote ? "yes" : "no"}, delete_paths=${scope.destructive.deletePaths ? "yes" : "no"}.`,
    isBroadUnscopedVaultMutation(scope) && intent.explicitMutation
      ? "Broad vault mutation is not in scope because no current note, file, or folder target was explicit; provide a plan or ask for a target instead of writing."
      : "",
  ].filter(Boolean).join(" ");
}

function formatScopeList(values: string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

function formatGeneratedWordTargetContext(wordTarget: {
  target: number;
  exact: boolean;
  tolerancePct: number;
}): string {
  return [
    `Generated output word target: ${wordTarget.target} words.`,
    `Exact word target: ${wordTarget.exact ? "yes" : "no"}.`,
    `Word target tolerance percent: ${wordTarget.tolerancePct}.`,
  ].join(" ");
}

function formatFollowupIntentContext(intentPrompt: string): string {
  return [
    "The current user message is a follow-up to recent chat.",
    `Resolve this turn's tool routing as: ${JSON.stringify(intentPrompt)}.`,
    "Use the actual latest user message for conversational wording, but execute the resolved tool intent.",
  ].join(" ");
}

function formatPromptOnCurrentPageContext(): string {
  return [
    "The user is referring to the active Obsidian note/page.",
    "Extract the prompt, instructions, question, or task from the Current note context.",
    "Then answer or execute that extracted prompt.",
    "Do not merely describe the note or say you will read it.",
  ].join(" ");
}

function formatPromptOnCurrentPageWritebackContext(): string {
  return [
    "Prompt-on-page writeback is active.",
    "Execute the prompt, instructions, question, or task from the Current note context.",
    "Write only the generated answer or requested markdown that belongs below the existing prompt on the same note.",
    "Do not repeat the prompt unless the prompt explicitly asks you to.",
    "Do not describe that you read the note.",
  ].join(" ");
}

function formatDirectCurrentNoteWritebackContext(): string {
  return [
    "Direct current-note writeback is active.",
    "The mission asks for generated content to be written into the current note and does not require reading current note content or using tools first.",
    "Draft the requested markdown directly for the current note.",
  ].join(" ");
}

function formatAllowedToolsContext(
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];

  return [
    `Tools: ${toolNames.join(", ") || "none"}.`,
    "Only request these exact tool names.",
    "If a needed write tool is absent, explain the limitation instead of requesting it.",
  ].join(" ");
}

function formatToolAuthorityContext(
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];
  const authority = toolNames
    .map((name) => `${name}:${TOOL_AUTHORITY[name] ?? "read"}`)
    .join(", ");

  return [
    `Available tool authority: ${authority || "none"}.`,
    "Read tools can be used autonomously for vault and note questions.",
    "Write, edit, delete, and web tools require matching user intent.",
    "Use the smallest valid tool sequence.",
  ].join(" ");
}

function formatStreamingWritebackContext(kind: StreamingWritebackKind): string {
  if (kind === "edit") {
    return [
      "Streaming writeback is active for a current-note section edit.",
      "First request prepare_edit_current_section for the target heading.",
      "After that tool succeeds, do not request edit_current_section; provide only the markdown body that should replace the section.",
      "Thinking traces are never written to the note.",
    ].join(" ");
  }

  return [
    `Streaming writeback is active for ${kind} on the current note.`,
    "When ready to write, prefer providing only the markdown content so the plugin can stream it into the note.",
    "If a current-note write tool is available in this planning step and the operation needs tool execution, request that tool instead of inventing an unavailable tool name.",
    "Thinking traces are never written to the note.",
  ].join(" ");
}

function formatConversationHistoryContext(): string {
  return [
    "Recent chat history is included before the current user mission.",
    "Use it to resolve references such as the essay, answer, or plan you previously gave.",
    "Status logs, hidden thinking, tool traces, and receipts are intentionally excluded.",
  ].join(" ");
}

async function buildCheckpointResumeContext({
  prompt,
  activeIntentPrompt,
  toolContext,
  events,
}: {
  prompt: string;
  activeIntentPrompt: string;
  toolContext: ToolExecutionContext;
  events: AgentRunEvents;
}): Promise<CheckpointResumeState | null> {
  if (
    !hasCheckpointResumeIntent(prompt) &&
    !hasCheckpointResumeIntent(activeIntentPrompt)
  ) {
    return null;
  }

  try {
    const missionResume = await buildMissionResumeContext({
      prompt,
      activeIntentPrompt,
      toolContext,
    });
    if (missionResume) {
      const storedRuntime = await readMissionRuntimeSnapshotByRunId(
        toolContext,
        missionResume.ledger.runId,
      );
      const continuationBundle = buildContinuationMemoryBundle({
        ledger: missionResume.ledger,
        ledgerPath: missionResume.path,
        now: toolContext.now?.() ?? new Date(),
      });
      const hypothesisHint =
        toolContext.settings.researchMemoryEnabled === true
          ? buildHypothesisSystemHintFromIndex(
              toolContext.getResearchMemoryIndex?.() ?? [],
              missionResume.ledger.mission,
            )
          : null;
      const resumeItemSummary = getResumeItemSummary(missionResume.promptContext);
      events.onStatus?.(`Loaded mission ledger ${missionResume.path} for resume context...`);
      if (resumeItemSummary) {
        events.onStatus?.(resumeItemSummary);
      }
      events.onTrace?.(recordContinuationLoad(continuationBundle));
      events.onTrace?.({
        id: "mission-ledger-resume",
        kind: "status",
        path: missionResume.path,
        message: resumeItemSummary
          ? `Loaded mission ledger ${missionResume.path} for resume context. ${resumeItemSummary}`
          : `Loaded mission ledger ${missionResume.path} for resume context.`,
        outputPreview: {
          runId: missionResume.ledger.runId,
          status: missionResume.ledger.status,
          evidenceCount: missionResume.ledger.evidence.length,
          nextActions: missionResume.ledger.nextActions,
          plan: missionResume.plan,
          proofDebt: missionResume.plan.proofDebt,
        },
      });
      return {
        promptContext: [
          missionResume.promptContext,
          formatContinuationBundleForPrompt(continuationBundle, {
            ledger: missionResume.ledger,
            includeProofDebt: true,
          }),
          hypothesisHint,
          storedRuntime
            ? `Runtime snapshot v${storedRuntime.snapshot.version} revision ${storedRuntime.snapshot.revision} loaded from ${storedRuntime.path}.`
            : "No runtime snapshot was available; resuming from the mission ledger.",
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n\n"),
        missionResume,
        runtimeSnapshot: storedRuntime?.snapshot,
      };
    }

    const requestedRunId =
      extractRequestedRunId(prompt) ?? extractRequestedRunId(activeIntentPrompt);
    if (requestedRunId) {
      const checkpoint = await readAgentRunCheckpointByRunId(
        toolContext,
        requestedRunId,
      );
      if (checkpoint) {
        events.onStatus?.(
          `Loaded exact checkpoint ${checkpoint.path} for resume context...`,
        );
        return { promptContext: formatCheckpointResumeContext(checkpoint) };
      }
      events.onTrace?.({
        id: "checkpoint-resume:requested-missing",
        kind: "error",
        message: `Requested run ${requestedRunId} has no exact durable checkpoint.`,
        error: {
          code: "requested_run_checkpoint_missing",
          message: `Requested run ${requestedRunId} has no exact durable checkpoint.`,
        },
      });
      return { promptContext: "", missingRequestedRunId: requestedRunId };
    }

    const checkpoint = await readLatestAgentRunCheckpoint(toolContext);
    if (checkpoint === null) {
      events.onTrace?.({
        id: "checkpoint-resume:none",
        kind: "status",
        message: "No Agent Runs checkpoint was available for resume context.",
      });
      return null;
    }

    events.onStatus?.(`Loaded checkpoint ${checkpoint.path} for resume context...`);
    return { promptContext: formatCheckpointResumeContext(checkpoint) };
  } catch (error) {
    const requestedRunId =
      extractRequestedRunId(prompt) ?? extractRequestedRunId(activeIntentPrompt);
    events.onTrace?.({
      id: "checkpoint-resume:error",
      kind: "error",
      message: `Could not load checkpoint resume context: ${getUnknownErrorMessage(error)}`,
      error: {
        code: "checkpoint_resume_failed",
        message: getUnknownErrorMessage(error),
      },
    });
    return requestedRunId
      ? { promptContext: "", missingRequestedRunId: requestedRunId }
      : null;
  }
}

function getResumeItemSummary(promptContext: string): string | null {
  return (
    promptContext
      .split(/\r?\n/u)
      .find((line) => line.startsWith("Resume first incomplete research item:")) ??
    null
  );
}

function formatCheckpointResumeContext(
  checkpoint: LatestAgentRunCheckpoint,
): string {
  return [
    "Latest Agent Runs checkpoint for resume context.",
    "Use this checkpoint only if it clearly matches the user's requested continuation.",
    "Do not claim completed work from the checkpoint unless it appears in the content below.",
    `Checkpoint path: ${checkpoint.path}`,
    `Checkpoint modified: ${new Date(checkpoint.mtime).toISOString()}`,
    "",
    checkpoint.content,
  ].join("\n");
}

function buildChatRequest(
  messages: ModelChatMessage[],
  tools: ModelChatRequest["tools"],
  think?: ModelThink,
  options?: ModelRequestOptions,
  abortSignal?: AbortSignal,
): ModelChatRequest {
  return {
    messages,
    tools: tools && tools.length > 0 ? tools : undefined,
    think,
    options,
    abortSignal,
  };
}

function buildModelRequestOptions(
  settings: ToolExecutionContext["settings"] | undefined,
): ModelRequestOptions | undefined {
  const options: ModelRequestOptions = {};

  if (isFiniteNumber(settings?.temperature)) {
    options.temperature = settings.temperature;
  }

  if (isFiniteNumber(settings?.topK)) {
    options.top_k = settings.topK;
  }

  if (isFiniteNumber(settings?.topP)) {
    options.top_p = settings.topP;
  }

  if (isFiniteNumber(settings?.numCtx)) {
    options.num_ctx = settings.numCtx;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function buildRunConfigEvent({
  runId,
  toolContext,
  enableStreaming,
  activeThink,
  modelOptions,
  writeAutonomy,
  chatOnlyOverride,
  missionIntent,
  currentNoteContext,
  runPlan,
  streamingWritebackKind,
  directCurrentNoteWritebackKind,
  missionLedger,
  reflexOutput,
  estimatedPromptChars,
  contextBudgetChars,
  performanceGates,
  noteOutputPlan,
}: {
  runId: string;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  activeThink: ModelThink | undefined;
  modelOptions: ModelRequestOptions | undefined;
  writeAutonomy: boolean;
  chatOnlyOverride: boolean;
  missionIntent: MissionIntent;
  currentNoteContext: boolean;
  runPlan: RunPlanDecision;
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
  missionLedger?: MissionLedgerSummary;
  reflexOutput?: AgenticReflexOutput;
  estimatedPromptChars?: number;
  contextBudgetChars?: number;
  performanceGates?: PerformanceGateResult[];
  noteOutputPlan?: NoteOutputPlan;
}): AgentRunConfigEvent {
  const settings = toolContext.settings;
  const vaultContext =
    missionIntent.vaultContext || runPlan.slowPathReason === "needs_vault_context";
  const missionMode =
    missionIntent.mode === "chat_only" && vaultContext
      ? "vault_context_answer"
      : missionIntent.mode;

  return {
    runId,
    model: settings?.model?.trim() || "unknown",
    base: formatBaseUrlCategory(getProviderBaseUrl(settings)),
    modelProvider: settings?.modelProvider ?? "ollama",
    streaming: enableStreaming,
    thinkingMode: settings?.thinkingMode ?? "auto",
    resolvedThink: formatResolvedThink(activeThink),
    writebackMode: getRunWritebackMode({
      enableStreaming,
      settings,
      writeAutonomy,
      missionIntent,
      runPlan,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
    }),
    chatOnlyOverride,
    ...(noteOutputPlan ? { noteOutputPlan } : {}),
    route: runPlan.route,
    expectedTimeClass: runPlan.expectedTimeClass,
    maxStepsForRun: runPlan.maxStepsForRun,
    slowPathReason: runPlan.slowPathReason,
    allowedToolNames: runPlan.allowedToolNames,
    routeTraceReasons: runPlan.traceReasons,
    budgetProfile: runPlan.budgetProfile,
    englishGuard: runPlan.requiresEnglishGuard,
    temperature: modelOptions?.temperature,
    topK: modelOptions?.top_k,
    topP: modelOptions?.top_p,
    numCtx: modelOptions?.num_ctx,
    estimatedPromptChars,
    contextBudgetChars,
    writeAutonomy,
    missionMode,
    contextScope: getRunContextScope({
      vaultContext,
      currentNoteContext,
    }),
    currentNoteContext,
    vaultContext,
    maxSteps: getConfiguredMaxAgentSteps(settings),
    autonomyScope: missionIntent.autonomyScope,
    dependencyStatus: buildDependencyStatus({
      toolContext,
      runPlan,
      missionIntent,
    }),
    performanceGates,
    ...(missionLedger ? { missionLedger } : {}),
    ...(settings?.agenticReflexDiagnosticsEnabled !== false && reflexOutput
      ? {
          reflexLabel: reflexOutput.intent.label,
          reflexConfidence: reflexOutput.intent.confidence,
          reflexTopAction: reflexOutput.diagnostics.topAction,
          reflexProgressScore: reflexOutput.progress.progressScore,
          reflexLoopRisk: reflexOutput.progress.loopRiskScore,
          reflexCompletionMissing: reflexOutput.completion.missing,
          reflexAppliedReason: reflexOutput.intent.reason,
        }
      : {}),
  };
}

function buildDependencyStatus({
  toolContext,
  runPlan,
  missionIntent,
}: {
  toolContext: ToolExecutionContext;
  runPlan: RunPlanDecision;
  missionIntent: MissionIntent;
}): MissionDependencyStatus[] {
  const settings = toolContext.settings;
  const allowedTools = new Set(runPlan.allowedToolNames);
  const checkedAt = toolContext.now?.().toISOString();
  const webNeeded = allowedTools.has("web_search") || allowedTools.has("web_fetch");
  const semanticNeeded =
    allowedTools.has("semantic_search_notes") ||
    allowedTools.has("inspect_semantic_index") ||
    missionIntent.vaultContext;
  const browserNeeded = [...allowedTools].some((name) => name.startsWith("browser_"));
  const provider = settings?.modelProvider ?? "ollama";
  const baseUrl = getProviderBaseUrl(settings);
  const providerMissingKey =
    provider === "openai_compatible"
      ? !settings?.openAiCompatibleApiKey?.trim()
      : isOllamaCloudApiBaseUrl(baseUrl) && !settings?.ollamaApiKey?.trim();
  const hasVaultApi = hasObsidianVaultApi(toolContext);
  const timeoutMs = settings?.requestTimeoutMs;

  return [
    {
      category: "provider_auth",
      status: providerMissingKey ? "blocked" : "ok",
      capability: "model requests",
      summary: providerMissingKey
        ? formatFailureCopy(
            providerAuthFailureCopy(
              `${provider} model auth is missing required API credentials.`,
            ),
          )
        : `${provider} model auth is configured for this run.`,
      nextAction: providerMissingKey
        ? "Add the provider API key in plugin settings before retrying."
        : "No user action needed.",
      checkedAt,
    },
    {
      category: "model_timeout",
      status:
        timeoutMs === undefined
          ? "ok"
          : timeoutMs <= 0
            ? "blocked"
            : timeoutMs < 60_000
              ? "degraded"
              : "ok",
      capability: "long model calls",
      summary:
        timeoutMs === undefined
          ? "Model request timeout is using the provider default."
          : timeoutMs <= 0
          ? formatFailureCopy(
              modelTimeoutFailureCopy(
                "A non-positive timeout blocks long model calls before the loop starts.",
              ),
            )
          : `Model request timeout is ${timeoutMs}ms.`,
      nextAction:
        timeoutMs === undefined
          ? "No user action needed."
          : timeoutMs <= 0
          ? "Set a positive request timeout in plugin settings."
          : timeoutMs < 60_000
            ? "Use at least 60000ms for long research or writeback runs."
            : "No user action needed.",
      checkedAt,
    },
    {
      category: "web_fetch",
      status:
        webNeeded && toolContext.app && typeof toolContext.httpTransport !== "function"
          ? "blocked"
          : webNeeded && typeof toolContext.httpTransport !== "function"
            ? "unknown"
          : "ok",
      capability: "web search and fetch",
      summary: webNeeded
        ? typeof toolContext.httpTransport === "function"
          ? "Web tools are available for this mission."
          : "Web transport availability is unknown in this runtime."
        : "Web tools are not requested for this mission.",
      nextAction:
        webNeeded && toolContext.app && typeof toolContext.httpTransport !== "function"
          ? "Retry with the plugin web transport available."
          : "No user action needed.",
      checkedAt,
    },
    {
      category: "semantic_retrieval",
      status:
        settings?.semanticSearchEnabled === false && semanticNeeded
          ? "blocked"
          : !toolContext.semanticEmbeddingProvider && !toolContext.semanticIndexService
            ? "degraded"
            : settings?.semanticIndexEnabled === false || !toolContext.semanticIndexService
              ? "degraded"
              : "ok",
      capability: "semantic vault retrieval",
      summary:
        settings?.semanticSearchEnabled === false
          ? "Semantic search is disabled; exact vault tools remain available."
          : !toolContext.semanticEmbeddingProvider && !toolContext.semanticIndexService
            ? "Semantic embeddings and persisted index are unavailable; lexical fallback may be used."
            : settings?.semanticIndexEnabled === false || !toolContext.semanticIndexService
              ? "Persisted semantic index is unavailable; live retrieval or fallback may be used."
              : "Semantic vault retrieval has an embedding provider or fresh index path.",
      nextAction:
        settings?.semanticSearchEnabled === false && semanticNeeded
          ? "Enable semantic search in settings or ask for exact path/text retrieval."
          : !toolContext.semanticEmbeddingProvider && !toolContext.semanticIndexService
            ? "Install/enable the embedding provider or rebuild the semantic index for stronger vault synthesis."
            : settings?.semanticIndexEnabled === false || !toolContext.semanticIndexService
              ? "Rebuild or enable the semantic index when large-vault coverage matters."
              : "No user action needed.",
      checkedAt,
    },
    {
      category: "companion_browser",
      status:
        browserNeeded && settings?.browserToolsEnabled !== true
          ? "blocked"
          : browserNeeded
            ? "unknown"
            : "ok",
      capability: "companion browser automation",
      summary: browserNeeded
        ? settings?.browserToolsEnabled === true
          ? "Browser tools are enabled; companion health is checked when browser tools run."
          : "Browser tools are disabled in settings."
        : "Browser tools are not requested for this mission.",
      nextAction:
        browserNeeded && settings?.browserToolsEnabled !== true
          ? "Enable browser tools and start the companion service, or choose a non-browser alternative."
          : browserNeeded
            ? "Start the companion service if a browser tool reports unavailable."
            : "No user action needed.",
      checkedAt,
    },
    {
      category: "obsidian_vault",
      status: hasVaultApi ? "ok" : toolContext.app ? "blocked" : "unknown",
      capability: "Obsidian vault API",
      summary: hasVaultApi
        ? "Obsidian vault APIs are available."
        : toolContext.app
          ? "Obsidian vault APIs are unavailable."
          : "Obsidian vault API availability is unknown in this runtime.",
      nextAction: hasVaultApi
        ? "No user action needed."
        : toolContext.app
          ? "Run inside Obsidian with an active vault before retrying."
          : "No user action needed.",
      checkedAt,
    },
  ];
}

function normalizeInvocationToolCallLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(value));
}

function getFatalDependencyRowsForPreflight({
  rows,
  missionIntent,
  runPlan,
  shouldReadCurrentNote,
  streamingWritebackKind,
  directCurrentNoteWritebackKind,
}: {
  rows: MissionDependencyStatus[];
  missionIntent: MissionIntent;
  runPlan: RunPlanDecision;
  shouldReadCurrentNote: boolean;
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
}): MissionDependencyStatus[] {
  const needsVault =
    shouldReadCurrentNote ||
    missionIntent.vaultContext ||
    missionIntent.explicitMutation ||
    missionIntent.requireWriteCompletion ||
    streamingWritebackKind !== null ||
    directCurrentNoteWritebackKind !== null ||
    runPlan.slowPathReason === "needs_current_note" ||
    runPlan.slowPathReason === "needs_vault_context" ||
    runPlan.slowPathReason === "needs_graph_context" ||
    runPlan.allowedToolNames.some((name) =>
      /current_file|read_file|markdown|vault|semantic|graph|append|replace|rename|highlight|delete|trash|restore|template|design|memory/.test(name),
    );
  return rows.filter((row) => {
    if (row.status !== "blocked") {
      return true;
    }
    if (row.category === "obsidian_vault") {
      return needsVault;
    }
    if (row.category === "web_fetch") {
      return runPlan.allowedToolNames.includes("web_search") ||
        runPlan.allowedToolNames.includes("web_fetch");
    }
    if (row.category === "semantic_retrieval") {
      return missionIntent.vaultContext ||
        runPlan.allowedToolNames.includes("semantic_search_notes") ||
        runPlan.allowedToolNames.includes("inspect_semantic_index");
    }
    if (row.category === "companion_browser") {
      return runPlan.allowedToolNames.some((name) => name.startsWith("browser_"));
    }
    return true;
  });
}

function classifyBlockerCategory(blocker: string): MissionBlockerCategory {
  const text = blocker.toLowerCase();
  if (/\b(auth|api key|credential|401|403)\b/.test(text)) {
    return "provider_auth";
  }
  if (/\b(timeout|timed out|aborted)\b/.test(text)) {
    return "model_timeout";
  }
  if (/\b(web|fetch|source|url|http)\b/.test(text)) {
    return "web_fetch";
  }
  if (/\bsemantic|embedding|index|retrieval\b/.test(text)) {
    return "semantic_retrieval";
  }
  if (/\bbrowser|companion\b/.test(text)) {
    return "companion_browser";
  }
  if (/\bvault|obsidian|file|folder|note\b/.test(text)) {
    return "obsidian_vault";
  }
  if (/\bsafety|approval|blocked|destructive|credential|payment|upload|download\b/.test(text)) {
    return "safety_policy";
  }
  if (/\bunavailable tool|unknown tool|tool unavailable|was not available|is not available|not available for\b/.test(text)) {
    return "tool_unavailable";
  }
  return "unknown";
}

function hasObsidianVaultApi(toolContext: ToolExecutionContext): boolean {
  const vault = toolContext.app?.vault;
  return Boolean(
    vault &&
      typeof vault.read === "function" &&
      typeof vault.modify === "function" &&
      typeof vault.getFileByPath === "function",
  );
}

function isOllamaCloudApiBaseUrl(baseUrl: string): boolean {
  return /(^|\.)ollama\.com\b/i.test(baseUrl);
}

function getProviderBaseUrl(settings: ToolExecutionContext["settings"]): string {
  if (!settings) {
    return "";
  }
  if (settings.modelProvider === "openai_compatible") {
    return settings.openAiCompatibleBaseUrl?.trim() || "";
  }
  return settings.ollamaBaseUrl?.trim() || "";
}

function getRunWritebackMode({
  enableStreaming,
  settings,
  writeAutonomy,
  missionIntent,
  runPlan,
  streamingWritebackKind,
  directCurrentNoteWritebackKind,
}: {
  enableStreaming: boolean;
  settings: ToolExecutionContext["settings"];
  writeAutonomy: boolean;
  missionIntent: MissionIntent;
  runPlan: RunPlan;
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
}): RunWritebackMode {
  const streamWritebackEnabled =
    enableStreaming &&
    settings?.streamWritebackMode === "all_current_note_content_writes";

  if (
    streamWritebackEnabled &&
    writeAutonomy &&
    (streamingWritebackKind !== null ||
      directCurrentNoteWritebackKind !== null ||
      runPlan.route === "direct_writeback" ||
      runPlan.route === "single_model_writeback")
  ) {
    return runPlan.route === "grounded_workflow"
      ? "streaming_after_tools"
      : "streaming_current_note";
  }

  if (missionIntent.requireWriteCompletion) {
    return "tool_write";
  }

  return "off";
}

function getRunContextScope({
  vaultContext,
  currentNoteContext,
}: {
  vaultContext: boolean;
  currentNoteContext: boolean;
}): AgentRunContextScope {
  if (vaultContext && currentNoteContext) {
    return "vault_and_current_note";
  }

  if (vaultContext) {
    return "vault";
  }

  if (currentNoteContext) {
    return "current_note";
  }

  return "none";
}

function formatResolvedThink(think: ModelThink | undefined): string {
  return think === undefined ? "off" : String(think);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function withoutThinking(message: ModelChatMessage): ModelChatMessage {
  const { thinking: _thinking, ...messageWithoutThinking } = message;
  return messageWithoutThinking;
}

const MAX_RECOVERED_TEXT_TOOL_CALLS = 4;

function getResponseToolCallsFromModelOutput(
  response: ModelChatResponse,
  knownToolNames: Set<string>,
  events: AgentRunEvents,
  step: number,
): ModelToolCall[] {
  if (response.toolCalls.length > 0) {
    return response.toolCalls;
  }

  const recoveredToolCalls = extractToolCallsFromAssistantText(
    response.message.content,
    knownToolNames,
  );

  if (recoveredToolCalls.length > 0) {
    const names = recoveredToolCalls.map((toolCall) => toolCall.name).join(", ");
    events.onStatus?.(`Recovered text tool request: ${names}`);
    events.onTrace?.({
      id: `recovered-text-tool-call-${step}`,
      kind: "tool",
      step,
      message: `Recovered assistant JSON tool request: ${names}`,
      outputPreview: recoveredToolCalls.map((toolCall) => ({
        name: toolCall.name,
        arguments: redactToolArguments(toolCall.name, toolCall.arguments),
      })),
    });
  }

  return recoveredToolCalls;
}

function extractToolCallsFromAssistantText(
  content: string,
  knownToolNames: Set<string>,
): ModelToolCall[] {
  if (!content.trim() || knownToolNames.size === 0) {
    return [];
  }

  const toolCalls: ModelToolCall[] = [];

  for (const toolCall of extractXmlToolCallCandidates(content, knownToolNames)) {
    toolCalls.push(toolCall);

    if (toolCalls.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
      return toolCalls.slice(0, MAX_RECOVERED_TEXT_TOOL_CALLS);
    }
  }

  const parsedCandidates = extractJsonCandidates(content);

  for (const candidate of parsedCandidates) {
    collectToolCallsFromJson(candidate, knownToolNames, toolCalls);

    if (toolCalls.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
      break;
    }
  }

  return toolCalls.slice(0, MAX_RECOVERED_TEXT_TOOL_CALLS);
}

function extractXmlToolCallCandidates(
  content: string,
  knownToolNames: Set<string>,
): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];
  const pattern =
    /<requested_tool_call\b[^>]*>([\s\S]*?)<\/requested_tool_call>/gi;
  let match: RegExpExecArray | null;

  while (
    (match = pattern.exec(content)) !== null &&
    toolCalls.length < MAX_RECOVERED_TEXT_TOOL_CALLS
  ) {
    const body = match[1];
    const name = readXmlTag(body, "name");
    if (!name || !knownToolNames.has(name)) {
      continue;
    }

    const rawArgs =
      readXmlTag(body, "arguments") ??
      readXmlTag(body, "args") ??
      readXmlTag(body, "parameters");
    const parsedArgs = rawArgs ? parseJsonCandidate(rawArgs) : undefined;
    const args = isRecord(parsedArgs) ? parsedArgs : {};

    toolCalls.push({
      name,
      arguments: normalizeRecoveredToolArguments(name, args),
      index: toolCalls.length,
      raw: match[0],
    });
  }

  return toolCalls;
}

function readXmlTag(content: string, tagName: string): string | null {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i",
  );
  const match = pattern.exec(content);
  return match ? decodeBasicXmlEntities(match[1].trim()) : null;
}

function decodeBasicXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractJsonCandidates(content: string): unknown[] {
  const candidates: unknown[] = [];
  const fencedJsonPattern =
    /\\?`\\?`\\?`(?:json|tool_call|tool|function)?\s*([\s\S]*?)\\?`\\?`\\?`/gi;
  let match: RegExpExecArray | null;

  while ((match = fencedJsonPattern.exec(content)) !== null) {
    const parsed = parseJsonCandidate(match[1]);
    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJsonCandidate(trimmed);
    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  if (candidates.length === 0) {
    for (const snippet of extractInlineJsonObjectSnippets(content)) {
      const parsed = parseJsonCandidate(snippet);
      if (parsed !== undefined) {
        candidates.push(parsed);
      }
    }
  }

  return candidates;
}

function extractInlineJsonObjectSnippets(content: string): string[] {
  const snippets: string[] = [];
  let searchStart = 0;

  while (
    snippets.length < MAX_RECOVERED_TEXT_TOOL_CALLS &&
    searchStart < content.length
  ) {
    const start = content.indexOf("{", searchStart);
    if (start < 0) {
      break;
    }

    const end = findBalancedJsonObjectEnd(content, start);
    if (end < 0) {
      break;
    }

    const snippet = content.slice(start, end + 1);
    if (/"(?:name|tool|tool_name)"\s*:/.test(snippet)) {
      snippets.push(snippet);
    }
    searchStart = end + 1;
  }

  return snippets;
}

function findBalancedJsonObjectEnd(content: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function parseJsonCandidate(value: string): unknown | undefined {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function collectToolCallsFromJson(
  value: unknown,
  knownToolNames: Set<string>,
  output: ModelToolCall[],
) {
  if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCallsFromJson(item, knownToolNames, output);

      if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const directToolCall = parseToolCallRecord(value, knownToolNames, output.length);
  if (directToolCall) {
    output.push(directToolCall);
    return;
  }

  for (const nestedKey of ["tool_calls", "toolCalls", "tools", "calls"]) {
    collectToolCallsFromJson(value[nestedKey], knownToolNames, output);

    if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
      return;
    }
  }

  collectToolCallsFromJson(value.function, knownToolNames, output);
}

function parseToolCallRecord(
  value: Record<string, unknown>,
  knownToolNames: Set<string>,
  index: number,
): ModelToolCall | null {
  const name = getRecoveredToolName(value);
  if (!name || !knownToolNames.has(name)) {
    return null;
  }

  return {
    name,
    arguments: normalizeRecoveredToolArguments(
      name,
      parseRecoveredToolArguments(value),
    ),
    index,
    raw: value,
  };
}

function parseRecoveredToolArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const args =
    value.arguments ??
    value.args ??
    value.parameters ??
    value.input;

  if (isRecord(args)) {
    return args;
  }

  if (typeof args === "string" && args.trim()) {
    const parsedArgs = parseJsonCandidate(args);
    if (isRecord(parsedArgs)) {
      return parsedArgs;
    }
  }

  return extractTopLevelRecoveredToolArguments(value);
}

function getRecoveredToolName(value: Record<string, unknown>): string | undefined {
  const direct =
    getString(value.name) ??
    getString(value.tool) ??
    getString(value.tool_name);
  if (direct) {
    return direct;
  }

  if (isRecord(value.function)) {
    return getString(value.function.name);
  }

  return undefined;
}

function extractTopLevelRecoveredToolArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const reservedKeys = new Set([
    "name",
    "tool",
    "tool_name",
    "arguments",
    "args",
    "parameters",
    "input",
    "function",
    "id",
    "index",
    "type",
  ]);
  const args: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!reservedKeys.has(key)) {
      args[key] = item;
    }
  }
  return args;
}

function normalizeRecoveredToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (
    (toolName === "list_folder" || toolName === "get_path_info") &&
    args.path === "/"
  ) {
    return {
      ...args,
      path: "",
    };
  }

  return args;
}

function emitRunDiagnostics({
  events,
  toolContext,
  tools,
  enableStreaming,
  finalMode,
  runPlan,
}: {
  events: AgentRunEvents;
  toolContext: ToolExecutionContext;
  tools: ModelChatRequest["tools"];
  enableStreaming: boolean;
  finalMode: FinalEmissionMode;
  runPlan: RunPlan;
}) {
  events.onStatus?.(
    formatRunDiagnostics({
      toolContext,
      toolCount: tools?.length ?? 0,
      enableStreaming,
      finalMode,
      runPlan,
    }),
  );
}

export function formatRunDiagnostics({
  toolContext,
  toolCount,
  enableStreaming,
  finalMode,
  runPlan,
}: {
  toolContext: ToolExecutionContext;
  toolCount: number;
  enableStreaming: boolean;
  finalMode: FinalEmissionMode;
  runPlan: RunPlan;
}): string {
  const settings = toolContext.settings;
  const model = settings?.model?.trim() || "unknown";
  const baseUrl = getProviderBaseUrl(settings);
  const modelOptions = buildModelRequestOptions(settings);

  return [
    "Run diagnostics:",
    `provider=${settings?.modelProvider ?? "ollama"};`,
    `model=${model};`,
    `base=${formatBaseUrlCategory(baseUrl)};`,
    `streaming=${enableStreaming ? "on" : "off"};`,
    `missionMode=${toolContext.missionIntent?.mode ?? "unknown"};`,
    `writeAutonomy=${toolContext.writeAutonomy ? "on" : "off"};`,
    `route=${runPlan.route};`,
    `expected=${runPlan.expectedTimeClass};`,
    `step_cap=${runPlan.maxStepsForRun};`,
    `slow_path=${runPlan.slowPathReason};`,
    `english_guard=${runPlan.requiresEnglishGuard ? "on" : "off"};`,
    `temperature=${formatOptionalDiagnostic(modelOptions?.temperature)};`,
    `top_k=${formatOptionalDiagnostic(modelOptions?.top_k)};`,
    `top_p=${formatOptionalDiagnostic(modelOptions?.top_p)};`,
    `num_ctx=${formatOptionalDiagnostic(modelOptions?.num_ctx)};`,
    `tools=${toolCount};`,
    `final=${finalMode}.`,
  ].join(" ");
}

function formatOptionalDiagnostic(value: number | undefined): string {
  return value === undefined ? "default" : String(value);
}

function formatBaseUrlCategory(baseUrl: string): string {
  if (!baseUrl) {
    return "unknown";
  }

  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();

    if (hostname === "ollama.com" || hostname.endsWith(".ollama.com")) {
      return "ollama-cloud";
    }

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return "local";
    }

    return "custom";
  } catch {
    return "invalid";
  }
}

function emitModelCallTrace(
  events: AgentRunEvents,
  {
    id,
    step,
    message,
    request,
  }: {
    id: string;
    step?: number;
    message: string;
    request: ModelChatRequest;
  },
) {
  events.onTrace?.({
    id,
    kind: "model_call",
    step,
    message,
    inputPreview: summarizeModelRequest(request),
  });
}

function summarizeModelRequest(request: ModelChatRequest) {
  return {
    messageCount: request.messages.length,
    tools: request.tools?.map((tool) => tool.function.name) ?? [],
    think: request.think,
    options: request.options,
  };
}

function emitMetricEvent(
  events: AgentRunEvents,
  event: AgentRunMetricEvent,
) {
  events.onMetric?.(event);
  events.onTrace?.({
    id: `metric-${event.kind}-${event.name}-${event.step ?? "run"}-${event.durationMs}`,
    kind: "metric",
    step: event.step,
    message: `Metric: ${event.name} ${event.durationMs}ms`,
    outputPreview: event,
  });
}

function createStreamLifecycleTracker(
  events: AgentRunEvents,
  startedAt = nowMs(),
) {
  const emittedOnce = new Set<StreamLifecycleKind>();

  return {
    mark(
      kind: StreamLifecycleKind,
      message: string,
      extra: Omit<
        Partial<AgentStreamLifecycleEvent>,
        "kind" | "elapsedMs" | "message"
      > = {},
    ) {
      if (
        (kind.startsWith("first_") || kind === "stream_connected") &&
        emittedOnce.has(kind)
      ) {
        return;
      }

      emittedOnce.add(kind);
      events.onStreamLifecycle?.({
        kind,
        elapsedMs: elapsedMs(startedAt),
        message,
        ...extra,
      });
    },
  };
}

async function withModelWaitStatus<T>(
  operation: () => Promise<T>,
  events: AgentRunEvents,
  label: string,
): Promise<T> {
  const startedAt = nowMs();
  const interval = setInterval(() => {
    const elapsedSeconds = Math.max(30, Math.round(elapsedMs(startedAt) / 1000));
    events.onStatus?.(
      `Still waiting for ${label} (${elapsedSeconds}s elapsed)...`,
    );
  }, 30_000);

  try {
    return await operation();
  } finally {
    clearInterval(interval);
  }
}

async function chatForAgentStep(
  modelClient: ModelClient,
  request: ModelChatRequest,
  events: AgentRunEvents,
  step: number,
  onThinkingUnsupported: () => void,
): Promise<ModelChatResponse> {
  const startedAt = nowMs();
  const requestChars = measureSerializedChars(request);
  emitModelCallTrace(events, {
    id: `model-call-agent-step-${step}`,
    step,
    message: `Model call: agent step ${step}`,
    request,
  });

  try {
    const response = await withModelRetry(
      () =>
        withModelWaitStatus(
          () => modelClient.chat(request),
          events,
          "model API response",
        ),
      {
        policy: request.think !== undefined ? { maxAttempts: 2 } : undefined,
        abortSignal: request.abortSignal,
        onRetry: (attempt, error, delayMs) => {
          events.onStatus?.(
            "Transient model provider error; retrying model step...",
          );
          events.onStatus?.(
            `Transient model provider error; retrying model step ${step} (attempt ${attempt}) after ${delayMs}ms: ${getUnknownErrorMessage(error)}`,
          );
        },
      },
    );
    emitMetricEvent(events, {
      kind: "model_chat",
      name: "agent_step",
      step,
      durationMs: elapsedMs(startedAt),
      requestChars,
      responseChars: measureSerializedChars(response.raw ?? response.message),
      ...extractTokenUsageFields(response.raw),
    });
    emitThinking(response.message.thinking, events);
    return response;
  } catch (error) {
    if (request.think !== undefined && isThinkingUnsupportedError(error)) {
      onThinkingUnsupported();
      const retryRequest = { ...request, think: undefined };
      const retryResponse = await withModelRetry(
        () =>
          withModelWaitStatus(
            () => modelClient.chat(retryRequest),
            events,
            "model API retry",
          ),
        {
          abortSignal: retryRequest.abortSignal,
          onRetry: (attempt, retryError, delayMs) => {
            events.onStatus?.(
              `Transient model provider error; retrying model step ${step} without thinking (attempt ${attempt}) after ${delayMs}ms: ${getUnknownErrorMessage(retryError)}`,
            );
          },
        },
      );
      emitMetricEvent(events, {
        kind: "model_chat",
        name: "agent_step",
        step,
        durationMs: elapsedMs(startedAt),
        requestChars: measureSerializedChars(retryRequest),
        responseChars: measureSerializedChars(
          retryResponse.raw ?? retryResponse.message,
        ),
        ...extractTokenUsageFields(retryResponse.raw),
      });
      emitThinking(retryResponse.message.thinking, events);
      return retryResponse;
    }

    if (request.think !== undefined && isTransientModelError(error)) {
      events.onStatus?.(
        "Transient model provider error persisted; retrying without thinking mode...",
      );
      onThinkingUnsupported();
      const noThinkRequest = { ...request, think: undefined };
      const noThinkResponse = await withModelRetry(
        () =>
          withModelWaitStatus(
            () => modelClient.chat(noThinkRequest),
            events,
            "model API retry without thinking",
          ),
        {
          abortSignal: noThinkRequest.abortSignal,
          onRetry: (attempt, retryError, delayMs) => {
            events.onStatus?.(
              "Transient model provider error; retrying model step...",
            );
            events.onStatus?.(
              `Transient model provider error; retrying model step ${step} without thinking (attempt ${attempt}) after ${delayMs}ms: ${getUnknownErrorMessage(retryError)}`,
            );
          },
        },
      );
      emitMetricEvent(events, {
        kind: "model_chat",
        name: "agent_step",
        step,
        durationMs: elapsedMs(startedAt),
        requestChars: measureSerializedChars(noThinkRequest),
        responseChars: measureSerializedChars(
          noThinkResponse.raw ?? noThinkResponse.message,
        ),
        ...extractTokenUsageFields(noThinkResponse.raw),
      });
      emitThinking(noThinkResponse.message.thinking, events);
      return noThinkResponse;
    }

    emitMetricEvent(events, {
      kind: "model_chat",
      name: "agent_step",
      step,
      durationMs: elapsedMs(startedAt),
      requestChars,
    });
    throw error;
  }
}

async function emitNonStreamingFinalModelAnswer({
  modelClient,
  messages,
  events,
  metricName,
  options,
  abortSignal,
}: {
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  events: AgentRunEvents;
  metricName: string;
  options?: ModelRequestOptions;
  abortSignal?: AbortSignal;
}): Promise<ModelChatResponse> {
  emitStatus(events, "Drafting final answer...", "final_answer");
  const request: ModelChatRequest = {
    messages,
    options,
    abortSignal,
  };
  const startedAt = nowMs();
  const requestChars = measureSerializedChars(request);
  emitModelCallTrace(events, {
    id: `model-call-${metricName}`,
    message: `Model call: ${metricName}`,
    request,
  });

  const response = await withModelWaitStatus(
    () => modelClient.chat(request),
    events,
    "model API response",
  );
  emitMetricEvent(events, {
    kind: "model_chat",
    name: metricName,
    durationMs: elapsedMs(startedAt),
    requestChars,
    responseChars: measureSerializedChars(response.raw ?? response.message),
    ...extractTokenUsageFields(response.raw),
  });
  emitThinking(response.message.thinking, events);
  emitDirectAssistantAnswer(response.message.content ?? "", events);
  return response;
}

async function emitFinalAnswer({
  modelClient,
  messages,
  events,
  enableStreaming,
  fallbackContent,
  finalInstruction = FINAL_ANSWER_PROMPT,
  metricName = "final_answer",
  relevancePrompt,
  think,
  options,
  abortSignal,
  onThinkingUnsupported,
  deferVisibleOutput = false,
}: {
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  events: AgentRunEvents;
  enableStreaming: boolean;
  fallbackContent: string;
  finalInstruction?: string | null;
  metricName?: string;
  relevancePrompt?: string;
  think?: ModelThink;
  options?: ModelRequestOptions;
  abortSignal?: AbortSignal;
  onThinkingUnsupported: () => void;
  deferVisibleOutput?: boolean;
}): Promise<ModelChatResponse | null> {
  if (!enableStreaming) {
    if (!deferVisibleOutput) {
      emitDirectAssistantAnswer(fallbackContent, events);
    }
    return null;
  }

  emitStatus(events, "Drafting final answer...", "final_answer");
  if (!deferVisibleOutput) {
    events.onFinalStart?.();
    events.onAssistantMessageStart?.();
  }

  let emittedContent = "";
  let observedContent = false;
  const wordTarget = parseGeneratedWordCountTargetFromMessages(messages);
  const verifyWordCount = wordTarget !== null;
  const englishGuard = isLikelyEnglishPrompt(relevancePrompt ?? "");
  const contentSanitizer = createAssistantContentSanitizer();
  const relevanceGate = createFinalAnswerRelevanceGate(relevancePrompt, events);
  const thinkingStream = createThinkingStream(events);
  const streamRequest: ModelChatRequest = {
    messages: buildFinalAnswerMessages(messages, finalInstruction),
    options,
    abortSignal,
  };
  const requestChars = measureSerializedChars(streamRequest);
  const startedAt = nowMs();
  const lifecycle = createStreamLifecycleTracker(events, startedAt);
  let response: ModelChatResponse;
  const emitVisibleFinalDelta = (content: string) => {
    if (deferVisibleOutput) {
      return;
    }
    if (englishGuard) {
      assertEnglishOnlyVisibleOutput(content, events);
    }

    lifecycle.mark("first_visible_content", "Showing safe answer text...", {
      releasedChars: content.length,
    });
    events.onFinalDelta?.(content);
    events.onAssistantDelta?.(content);
  };

  lifecycle.mark("stream_started", "Waiting for provider to send content...");
  emitModelCallTrace(events, {
    id: `model-call-stream-${metricName}`,
    message: `Model stream: ${metricName}`,
    request: streamRequest,
  });

  try {
    response = await streamChatWithThinkingFallback({
      modelClient,
      request: streamRequest,
      events,
      streamEvents: {
        onRawChunk: () => {
          lifecycle.mark("stream_connected", "Connected to model stream.");
          lifecycle.mark("first_raw_chunk", "Provider sent the first stream chunk.");
        },
        onContentDelta: (delta) => {
          lifecycle.mark(
            "first_content_delta",
            "Received answer text; checking early output...",
          );
          const sanitized = contentSanitizer.push(delta);
          if (!sanitized) {
            return;
          }

          observedContent = true;
          const topicalContent = relevanceGate.push(sanitized);
          if (!topicalContent) {
            lifecycle.mark("buffering_safety", "Checking early output before writing...", {
              bufferedChars: sanitized.length,
            });
            return;
          }

          emittedContent += topicalContent;
          if (!verifyWordCount) {
            emitVisibleFinalDelta(topicalContent);
          }
        },
        onThinkingDelta: (delta) => {
          lifecycle.mark(
            "first_thinking_delta",
            "Received thinking, waiting for answer text...",
          );
          thinkingStream.onDelta(delta);
        },
      },
      onThinkingUnsupported,
    });
    emitMetricEvent(events, {
      kind: "model_stream",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
      responseChars: measureSerializedChars(response.message),
      ...extractTokenUsageFields(response.raw),
    });
  } catch (error) {
    emitMetricEvent(events, {
      kind: "model_stream",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
    });
    throw error;
  }

  const trailingContent = contentSanitizer.flush();
  if (trailingContent) {
    observedContent = true;
    const topicalContent = relevanceGate.push(trailingContent);
    if (topicalContent) {
      emittedContent += topicalContent;
      if (!verifyWordCount) {
        emitVisibleFinalDelta(topicalContent);
      }
    }
  }

  thinkingStream.done();

  const sanitizedResponse = sanitizeAssistantContent(response.message.content);
  if (!observedContent && sanitizedResponse.trim()) {
    const topicalContent = relevanceGate.push(sanitizedResponse);
    if (topicalContent) {
      emittedContent += topicalContent;
      if (!verifyWordCount) {
        emitVisibleFinalDelta(topicalContent);
      }
    }
  }

  const bufferedTopicalContent = relevanceGate.finish();
  if (bufferedTopicalContent) {
    emittedContent += bufferedTopicalContent;
    if (!verifyWordCount) {
      emitVisibleFinalDelta(bufferedTopicalContent);
    }
  }

  if (wordTarget) {
    let finalContent = emittedContent;
    let correctionUsed = false;
    const initialCount = countMarkdownVisibleText(finalContent).wordCount;
    if (!isWordCountWithinTarget(initialCount, wordTarget)) {
      events.onStatus?.(
        `Word count ${initialCount}/${wordTarget.target} outside target; requesting one correction pass...`,
      );
      const corrected = await requestWordCountCorrection({
        modelClient,
        messages: buildFinalAnswerMessages(messages, finalInstruction),
        draft: finalContent,
        wordTarget,
        events,
        think,
        options,
        abortSignal,
        onThinkingUnsupported,
        metricName: `${metricName}_word_count_correction`,
      });
      if (corrected.trim()) {
        finalContent = corrected;
        correctionUsed = true;
      }
    }

    emittedContent = finalContent;
    response = {
      message: {
        role: "assistant",
        content: finalContent,
      },
      toolCalls: [],
    };
    emitVisibleFinalDelta(finalContent);
    const finalCount = countMarkdownVisibleText(finalContent).wordCount;
    events.onStatus?.(
      `Word count: ${finalCount}/${wordTarget.target} (${isWordCountWithinTarget(finalCount, wordTarget) ? "within target" : "outside target"}; correction=${correctionUsed ? "used" : "not used"}).`,
    );
  }

  // The sanitizer and relevance gate define the candidate that was actually
  // released (or held for proof verification). Always return and persist that
  // exact candidate rather than the provider's raw message.
  response = {
    ...response,
    message: {
      role: "assistant",
      content: emittedContent,
    },
    toolCalls: [],
  };

  if (!deferVisibleOutput) {
    events.onFinalDone?.();
    events.onAssistantMessageDone?.();
  }
  messages.push(withoutThinking(response.message));
  return response;
}

function buildFinalAnswerMessages(
  messages: ModelChatMessage[],
  finalInstruction: string | null,
): ModelChatMessage[] {
  if (finalInstruction === null) {
    return [...messages];
  }

  return [
    ...messages.filter((message) => {
      if (message.role !== "assistant") {
        return true;
      }

      return (
        hasRenderableAssistantContent(message.content) ||
        (message.toolCalls?.length ?? 0) > 0
      );
    }),
    {
      role: "user" as const,
      content: finalInstruction,
    },
  ];
}

interface RelevanceGate {
  push(delta: string): string;
  finish(): string;
}

interface RelevanceProfile {
  anchors: Set<string>;
  minOutputChars: number;
  expectedEnglish: boolean;
  acceptsCodeOutput: boolean;
  acceptsNumericOutput: boolean;
}

function createFinalAnswerRelevanceGate(
  prompt: string | undefined,
  events: AgentRunEvents,
): RelevanceGate {
  const profile = buildRelevanceProfile(prompt ?? "");

  if (!profile) {
    return {
      push: (delta) => delta,
      finish: () => "",
    };
  }

  let buffer = "";
  let released = false;

  const stopOffTopicOutput = (): never => {
    events.onStatus?.(OFF_TOPIC_MODEL_OUTPUT_MESSAGE);
    events.onTrace?.({
      id: `off-topic-output-${nowMs()}`,
      kind: "error",
      message: OFF_TOPIC_MODEL_OUTPUT_MESSAGE,
      outputPreview: {
        anchors: [...profile.anchors],
        preview: truncateForTrace(buffer.trim(), 500),
      },
      error: {
        code: "off_topic_model_output",
        message: OFF_TOPIC_MODEL_OUTPUT_MESSAGE,
      },
    });
    throw new ModelClientError(
      "invalid_response",
      OFF_TOPIC_MODEL_OUTPUT_MESSAGE,
      {
        details: {
          anchors: [...profile.anchors],
          preview: truncateForTrace(buffer.trim(), 500),
        },
      },
    );
  };

  return {
    push(delta: string) {
      if (released) {
        return delta;
      }

      buffer += delta;

      if (shouldStopForWrongLanguage(profile, buffer)) {
        return stopOffTopicOutput();
      }

      if (isTopicallyRelevant(profile, buffer)) {
        if (!canReleaseForLanguage(profile, buffer, false)) {
          return "";
        }

        released = true;
        const output = buffer;
        buffer = "";
        return output;
      }

      if (shouldStopForOffTopicOutput(profile, buffer)) {
        return stopOffTopicOutput();
      }

      return "";
    },
    finish() {
      if (released || !buffer) {
        return "";
      }

      if (shouldStopForWrongLanguage(profile, buffer)) {
        return stopOffTopicOutput();
      }

      if (isTopicallyRelevant(profile, buffer)) {
        if (!canReleaseForLanguage(profile, buffer, true)) {
          return stopOffTopicOutput();
        }

        released = true;
        const output = buffer;
        buffer = "";
        return output;
      }

      return stopOffTopicOutput();
    },
  };
}

function buildRelevanceProfile(prompt: string): RelevanceProfile | null {
  const anchors = new Set(
    extractSemanticTokens(prompt).filter(
      (token) => !PROMPT_ANCHOR_STOPWORDS.has(token),
    ),
  );

  if (anchors.size < 2) {
    return null;
  }

  return {
    anchors,
    minOutputChars: 360,
    expectedEnglish: isLikelyEnglishPrompt(prompt),
    acceptsCodeOutput: hasCodeAnswerIntent(prompt),
    acceptsNumericOutput: hasWordCountIntent(prompt),
  };
}

function isTopicallyRelevant(
  profile: RelevanceProfile,
  content: string,
): boolean {
  if (profile.acceptsCodeOutput && looksLikeCodeAnswer(content)) {
    return true;
  }
  if (profile.acceptsNumericOutput && /\b\d[\d,]*(?:\.\d+)?\b/.test(content)) {
    return true;
  }

  const outputTokens = new Set(extractSemanticTokens(content));
  for (const anchor of profile.anchors) {
    if (outputTokens.has(anchor)) {
      return true;
    }
  }

  return false;
}

function hasCodeAnswerIntent(prompt: string): boolean {
  return /\b(code|leetcode|program|function|method|algorithm|solution|solve|implementation)\b/i.test(
    prompt,
  );
}

function looksLikeCodeAnswer(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    /^```[a-z0-9_-]*\s*$/i.test(trimmed) ||
    /^```[a-z0-9_-]*\s*[\r\n]/i.test(trimmed) ||
    /\b(def|function|class|const|let|var|return|for|while|if)\b/.test(content)
  );
}

function shouldStopForOffTopicOutput(
  profile: RelevanceProfile,
  content: string,
): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.length >= profile.minOutputChars) {
    return true;
  }

  return extractSemanticTokens(trimmed).length >= 70;
}

function shouldStopForWrongLanguage(
  profile: RelevanceProfile,
  content: string,
): boolean {
  if (!profile.expectedEnglish) {
    return false;
  }

  const cjkChars = content.match(/[\u3400-\u9FFF\uF900-\uFAFF]/gu)?.length ?? 0;
  if (cjkChars < 24) {
    return false;
  }

  const englishLetters = content.match(/[A-Za-z]/g)?.length ?? 0;
  return cjkChars >= 80 || cjkChars > englishLetters * 1.25;
}

function canReleaseForLanguage(
  profile: RelevanceProfile,
  content: string,
  isFinal: boolean,
): boolean {
  if (!profile.expectedEnglish) {
    return true;
  }

  if (shouldStopForWrongLanguage(profile, content)) {
    return false;
  }

  if (isFinal) {
    return true;
  }

  if (isBriefMarkdownHeadingOnly(content)) {
    return false;
  }

  const englishLetters = content.match(/[A-Za-z]/g)?.length ?? 0;
  return englishLetters >= 10 || extractSemanticTokens(content).length >= 2;
}

function isBriefMarkdownHeadingOnly(content: string): boolean {
  const trimmed = content.trim();
  return /^#{1,6}\s+\S.{0,100}$/u.test(trimmed) && !/\n\S/u.test(trimmed);
}

function extractSemanticTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z][a-z0-9']{2,}/g);

  if (!tokens) {
    return [];
  }

  return tokens
    .map(normalizeSemanticToken)
    .filter(
      (token) =>
        token.length >= 4 || SHORT_PROMPT_ANCHOR_TOKENS.has(token),
    );
}

function normalizeSemanticToken(token: string): string {
  let normalized = token.replace(/'s$/u, "");

  if (normalized.length > 5 && normalized.endsWith("ies")) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (normalized.length > 5 && normalized.endsWith("ing")) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.length > 5 && normalized.endsWith("ed")) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.length > 4 && normalized.endsWith("s")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

const PROMPT_ANCHOR_STOPWORDS = new Set([
  "about",
  "action",
  "add",
  "answer",
  "append",
  "argumentative",
  "clearly",
  "compose",
  "content",
  "current",
  "detail",
  "draft",
  "essay",
  "exact",
  "generate",
  "grounded",
  "insert",
  "item",
  "items",
  "mission",
  "note",
  "please",
  "project",
  "prompt",
  "provide",
  "regard",
  "response",
  "short",
  "source",
  "summarize",
  "summary",
  "that",
  "this",
  "update",
  "user",
  "with",
  "word",
  "write",
  "written",
]);

const SHORT_PROMPT_ANCHOR_TOKENS = new Set([
  "ai",
  "api",
  "css",
  "dom",
  "mcp",
  "ui",
  "war",
  "web",
]);

async function streamChatWithThinkingFallback({
  modelClient,
  request,
  events,
  streamEvents,
  onThinkingUnsupported,
}: {
  modelClient: ModelClient;
  request: ModelChatRequest;
  events: AgentRunEvents;
  streamEvents: ModelChatStreamEvents;
  onThinkingUnsupported: () => void;
}): Promise<ModelChatResponse> {
  try {
    return await withModelRetry(
      () =>
        withModelWaitStatus(
          () => modelClient.streamChat(request, streamEvents),
          events,
          "streaming model response",
        ),
      {
        abortSignal: request.abortSignal,
        onRetry: (attempt, error, delayMs) => {
          events.onStatus?.(
            `Transient streaming model error; retrying stream (attempt ${attempt}) after ${delayMs}ms: ${getUnknownErrorMessage(error)}`,
          );
        },
      },
    );
  } catch (error) {
    if (request.think === undefined || !isThinkingUnsupportedError(error)) {
      throw error;
    }

    onThinkingUnsupported();
    const retryRequest = { ...request, think: undefined };
    return withModelRetry(
      () =>
        withModelWaitStatus(
          () => modelClient.streamChat(retryRequest, streamEvents),
          events,
          "streaming model retry",
        ),
      {
        abortSignal: retryRequest.abortSignal,
        onRetry: (attempt, retryError, delayMs) => {
          events.onStatus?.(
            `Transient streaming model error; retrying stream without thinking (attempt ${attempt}) after ${delayMs}ms: ${getUnknownErrorMessage(retryError)}`,
          );
        },
      },
    );
  }
}

function createThinkingStream(events: AgentRunEvents) {
  let started = false;
  const sanitizer = createAssistantContentSanitizer();

  return {
    onDelta(delta: string) {
      const sanitized = sanitizer.push(delta);
      if (!sanitized) {
        return;
      }

      if (!started) {
        started = true;
        events.onThinkingMessageStart?.();
      }

      events.onThinkingDelta?.(sanitized);
    },
    done() {
      const trailing = sanitizer.flush();
      if (trailing) {
        if (!started) {
          started = true;
          events.onThinkingMessageStart?.();
        }

        events.onThinkingDelta?.(trailing);
      }

      if (started) {
        events.onThinkingMessageDone?.();
      }
    },
  };
}

function emitThinking(thinking: string | undefined, events: AgentRunEvents) {
  const sanitized = sanitizeAssistantContent(thinking ?? "");
  if (!sanitized.trim()) {
    return;
  }

  events.onThinkingMessageStart?.();
  events.onThinkingDelta?.(sanitized);
  events.onThinkingMessageDone?.();
}

const READ_NAV_TOOL_NAMES = new Set([
  "read_current_file",
  "inspect_vault_context",
  "inspect_vault_index",
  "list_current_folder",
  "list_markdown_files",
  "read_markdown_files",
  "search_markdown_files",
  "inspect_semantic_index",
  "semantic_search_notes",
  "read_file",
  "count_words",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "list_folder",
  "get_path_info",
  "search_research_memory",
  "read_research_memory",
  "review_research_memory",
  "memory_search",
  "list_templates",
  "read_template",
  "browser_observe",
  "browser_screenshot",
  "browser_extract_markdown",
]);

const WRITE_TOOL_NAMES = new Set([
  "open_web_source",
  "create_design_canvas",
  "update_design_canvas",
  "create_svg_design",
  "create_design_package",
  "export_workspace_artifact",
  "memory_write_observation",
  "memory_write_task_summary",
  "memory_write_procedural",
  "memory_write_source",
  "seed_default_templates",
  "create_template",
  "fill_template",
  "create_research_pack",
  "create_folder",
  "create_file",
  "append_file",
  "replace_file",
  "move_path",
  "append_to_current_file",
  "append_to_current_section",
  "highlight_current_file_phrase",
  "restore_current_file_from_backup",
  "append_research_memory",
  "compact_research_memory",
  "rename_current_file",
  "retitle_current_file",
  "prepare_edit_current_section",
  "edit_current_section",
  "replace_current_file",
  "link_related_notes_in_current_file",
  "rebuild_semantic_index",
]);

const DELETE_TOOL_NAMES = new Set([
  "delete_path",
  "delete_current_file",
  "delete_research_memory_entry",
]);

const ALL_OPERATION_GOALS: OperationGoal[] = [
  "read_current_note",
  "web_search",
  "web_fetch",
  "current_note_title",
  "current_note_highlight",
  "current_note_restore",
  "current_note_content",
  "current_note_replace",
  "current_section_edit",
  "path_create",
  "path_append",
  "path_replace",
  "path_move",
  "path_delete",
  "current_note_delete",
];

const CURRENT_NOTE_RESUME_GOALS: OperationGoal[] = [
  "read_current_note",
  "current_note_title",
  "current_note_highlight",
  "current_note_restore",
  "current_note_content",
  "current_note_replace",
  "current_section_edit",
  "current_note_delete",
];

const TOOL_GOALS: Partial<Record<string, OperationGoal[]>> = {
  read_current_file: ["read_current_note"],
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
  rename_current_file: ["current_note_title"],
  retitle_current_file: ["current_note_title"],
  highlight_current_file_phrase: ["current_note_highlight"],
  restore_current_file_from_backup: ["current_note_restore"],
  append_to_current_file: ["current_note_content"],
  append_to_current_section: ["current_note_content"],
  replace_current_file: ["current_note_replace"],
  prepare_edit_current_section: ["current_section_edit"],
  edit_current_section: ["current_section_edit"],
  seed_default_templates: ["path_create"],
  create_template: ["path_create"],
  fill_template: ["path_create"],
  create_research_pack: ["path_create"],
  create_file: ["path_create"],
  create_folder: ["path_create"],
  append_file: ["path_append"],
  replace_file: ["path_replace"],
  move_path: ["path_move"],
  delete_path: ["path_delete"],
  delete_current_file: ["current_note_delete"],
};

const CODE_TOOL_NAMES = new Set([
  "run_code_block",
  "render_html_preview",
  "write_workspace_file",
  "read_workspace_file",
  "list_workspace_files",
  "replace_workspace_text",
  "preview_workspace_html",
  "export_workspace_artifact",
  "install_code_dependency",
]);
const BROWSER_TOOL_NAMES = new Set([
  "browser_open_page",
  "browser_observe",
  "browser_click",
  "browser_type",
  "browser_keypress",
  "browser_scroll",
  "browser_screenshot",
  "browser_extract_markdown",
]);
const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "memory_write_observation",
  "memory_write_task_summary",
  "memory_write_procedural",
  "memory_write_source",
]);

type ToolAuthority = "read" | "write" | "edit" | "delete" | "web" | "code";

const TOOL_AUTHORITY: Record<string, ToolAuthority> = {
  read_current_file: "read",
  inspect_vault_context: "read",
  inspect_vault_index: "read",
  list_current_folder: "read",
  list_markdown_files: "read",
  search_markdown_files: "read",
  inspect_semantic_index: "read",
  semantic_search_notes: "read",
  read_markdown_files: "read",
  read_file: "read",
  count_words: "read",
  get_note_graph_context: "read",
  find_related_notes: "read",
  suggest_note_links: "read",
  list_folder: "read",
  get_path_info: "read",
  search_research_memory: "read",
  read_research_memory: "read",
  review_research_memory: "read",
  list_templates: "read",
  read_template: "read",
  seed_default_templates: "write",
  create_template: "write",
  fill_template: "write",
  create_research_pack: "write",
  create_folder: "write",
  create_file: "write",
  append_file: "write",
  replace_file: "edit",
  move_path: "edit",
  append_to_current_file: "write",
  append_to_current_section: "write",
  highlight_current_file_phrase: "edit",
  restore_current_file_from_backup: "edit",
  append_research_memory: "write",
  compact_research_memory: "edit",
  rename_current_file: "edit",
  retitle_current_file: "edit",
  prepare_edit_current_section: "edit",
  edit_current_section: "edit",
  replace_current_file: "edit",
  link_related_notes_in_current_file: "edit",
  delete_path: "delete",
  delete_current_file: "delete",
  delete_research_memory_entry: "delete",
  web_search: "web",
  web_fetch: "web",
  read_source_section: "web",
  open_web_source: "web",
  browser_open_page: "web",
  browser_observe: "web",
  browser_click: "web",
  browser_type: "web",
  browser_keypress: "web",
  browser_scroll: "web",
  browser_screenshot: "web",
  browser_extract_markdown: "web",
  run_code_block: "code",
  render_html_preview: "code",
  write_workspace_file: "code",
  read_workspace_file: "code",
  list_workspace_files: "code",
  replace_workspace_text: "code",
  preview_workspace_html: "code",
  export_workspace_artifact: "code",
  install_code_dependency: "code",
  create_design_canvas: "write",
  update_design_canvas: "write",
  create_svg_design: "write",
  create_design_package: "write",
  memory_search: "read",
  memory_write_observation: "write",
  memory_write_task_summary: "write",
  memory_write_procedural: "write",
  memory_write_source: "write",
  rebuild_semantic_index: "write",
};

function getAllowedToolDefinitions(
  toolRegistry: ToolRegistry,
  prompt: string,
  missionIntent: MissionIntent,
  settings: ToolExecutionContext["settings"] | undefined,
  streamingWritebackKind: StreamingWritebackKind | null = null,
  reflex: ReflexDecision | null = null,
) {
  const noteOutputIntent = missionIntent.noteOutput;
  const allowAppend = hasAppendIntent(prompt);
  const allowSectionAppend = hasSectionAppendIntent(prompt);
  const allowDelete = hasDeleteIntent(prompt);
  const allowDeletePath = hasDeletePathIntent(prompt);
  const allowWholeNoteReplace = hasWholeNoteReplaceIntent(prompt);
  const allowEdit = hasEditIntent(prompt) && !allowWholeNoteReplace;
  const allowHighlight = hasHighlightIntent(prompt);
  const allowRestore = hasRestoreIntent(prompt);
  const allowReplace =
    hasReplaceIntent(prompt) && (!allowEdit || allowWholeNoteReplace) && !allowDelete;
  const allowMarkdownRetitle = hasMarkdownTitleContentIntent(prompt);
  const allowVisibleRename =
    isExplicitVisibleFileRenameIntent(prompt) ||
    (isVisibleTitleRenameIntent(prompt) && isTitleOnlyIntent(prompt));
  const allowRetitle = allowMarkdownRetitle || allowVisibleRename;
  const allowResume =
    hasCheckpointResumeIntent(prompt) || hasMissionResumeIntent(prompt);
  const allowReflexReadRouting =
    !missionIntent.explicitMutation && !missionIntent.explicitDelete;
  const hasReflexReadLabel = (labels: ReflexDecision["label"][]) =>
    allowReflexReadRouting && hasSafeReflexLabel(reflex, labels);
  const allowParallelVaultInspection = hasParallelVaultReadIntent(prompt);
  const allowWebSearch =
    shouldAllowWebSearch(prompt, missionIntent) ||
    allowResume ||
    hasReflexReadLabel(["web_research"]);
  const allowCurrentNoteRead =
    hasCurrentNoteReadIntent(prompt) || hasCurrentNoteSectionTarget(prompt) || allowResume;
  const allowWordCount =
    hasWordCountIntent(prompt) ||
    allowParallelVaultInspection ||
    hasReflexReadLabel(["word_count"]);
  const allowGraphContext =
    hasGraphConnectionIntent(prompt) ||
    allowParallelVaultInspection ||
    hasReflexReadLabel(["graph_context"]);
  const allowGraphLinkWrite = hasGraphLinkWriteIntent(prompt);
  const allowTemplateTools = hasTemplateIntent(prompt);
  const allowTemplateSeed = hasTemplateSeedIntent(prompt);
  const allowTemplateCreate = hasTemplateCreateIntent(prompt);
  const allowTemplateFill = hasTemplateFillIntent(prompt);
  const allowResearchPack = hasResearchPackIntent(prompt);
  const allowResearchMemory = hasResearchMemoryIntent(prompt);
  const allowResearchMemoryWrite = hasResearchMemoryWriteIntent(prompt);
  const allowVaultIndex = hasVaultIndexIntent(prompt);
  const allowSemanticSearch =
    isSemanticSearchEnabled(settings) &&
    (allowResume ||
      hasConceptualVaultSearchIntent(prompt) ||
      hasReflexReadLabel(["semantic_vault_search", "graph_context"]));
  const allowSemanticIndexInspect =
    isSemanticIndexEnabled(settings) &&
    (allowResume ||
      hasConceptualVaultSearchIntent(prompt) ||
      hasReflexReadLabel(["semantic_vault_search", "graph_context"]));
  const allowSemanticIndexMaintenance =
    isSemanticIndexEnabled(settings) && hasSemanticIndexMaintenanceIntent(prompt);
  const allowOpenWebSource = hasOpenWebSourceIntent(prompt);
  const allowCodeExecution = hasCodeExecutionIntent(prompt);
  const allowHtmlPreview = hasHtmlPreviewIntent(prompt) || allowCodeExecution;
  const allowDesignTools = hasDesignIntent(prompt);
  const allowDesignPackage = hasDesignPackageIntent(prompt);
  const allowBrowserTools = hasBrowserAutomationIntent(prompt);
  const allowExperienceMemory =
    settings?.experienceMemoryEnabled === true &&
    (hasExperienceMemoryIntent(prompt) ||
      hasWebSearchIntent(prompt) ||
      hasDesignIntent(prompt) ||
      hasBrowserAutomationIntent(prompt) ||
      hasLongResearchIntent(prompt) ||
      hasResearchMemoryIntent(prompt));
  const allowCanvasDesign = hasCanvasDesignIntent(prompt);
  const allowSvgDesign = hasSvgDesignIntent(prompt);
  const linearIntent = detectLinearIntent(prompt);
  const allowVaultBrowse =
    missionIntent.vaultContext ||
    allowResume ||
    hasVaultBrowseIntent(prompt) ||
    allowParallelVaultInspection ||
    allowGraphContext ||
    allowVaultIndex ||
    hasReflexReadLabel(["vault_search", "semantic_vault_search"]);
  const allowSpecificFileRead = hasSpecificFileReadIntent(prompt);
  const allowCreateFile = hasCreateFileIntent(prompt);
  const allowCreateFolder = hasCreateFolderIntent(prompt);
  const allowPathAppend = hasAppendIntent(prompt) && hasPathTargetIntent(prompt);
  const allowPathReplace = hasReplaceIntent(prompt) && hasPathTargetIntent(prompt);
  const allowMovePath = hasMovePathIntent(prompt);
  const preferPathTarget = hasExplicitNonCurrentNoteWriteTarget(prompt);
  const allowCurrentNoteOutput = noteOutputIntent && !preferPathTarget;
  const allowAutonomousAppend =
    allowCurrentNoteOutput &&
    !allowWholeNoteReplace &&
    !allowEdit &&
    !allowDelete &&
    (!allowRetitle || !hasTitleOnlyIntent(prompt));

  const filtered = toolRegistry.getDefinitions().filter((definition) => {
    const name = definition.function.name;

    if (name.startsWith("linear_")) {
      if (settings?.linearEnabled !== true || !linearIntent.explicit) {
        return false;
      }
      return (
        name !== "linear_delete_issue_permanently" ||
        hasExplicitPermanentLinearDeleteIntent(prompt)
      );
    }

    if (!isAllowedForMission(name, prompt, missionIntent, reflex)) {
      return false;
    }

    if (
      name === "web_search" ||
      name === "web_fetch" ||
      name === "read_source_section"
    ) {
      return allowWebSearch;
    }

    if (name === "open_web_source") {
      return allowOpenWebSource;
    }

    if (BROWSER_TOOL_NAMES.has(name)) {
      return allowBrowserTools;
    }

    if (MEMORY_TOOL_NAMES.has(name)) {
      return allowExperienceMemory;
    }

    if (name === "render_html_preview") {
      return allowHtmlPreview;
    }

    if (CODE_TOOL_NAMES.has(name)) {
      return allowCodeExecution;
    }

    if (name === "create_design_canvas") {
      return allowDesignTools && allowCanvasDesign && !allowDesignPackage;
    }

    if (name === "update_design_canvas") {
      return hasReviseDesignIntent(prompt) && allowCanvasDesign;
    }

    if (name === "create_svg_design") {
      return allowDesignTools && allowSvgDesign;
    }

    if (name === "create_design_package") {
      return allowDesignTools && allowDesignPackage;
    }

    if (name === "read_current_file") {
      return (
        !allowRestore &&
        (missionIntent.vaultContext ||
          allowCurrentNoteRead ||
          allowCurrentNoteOutput)
      );
    }

    if (name === "inspect_vault_context") {
      return allowVaultBrowse;
    }

    if (name === "inspect_vault_index") {
      return allowVaultBrowse || allowVaultIndex;
    }

    if (name === "list_markdown_files") {
      return allowVaultBrowse;
    }

    if (name === "search_markdown_files" || name === "read_markdown_files") {
      return allowVaultBrowse || allowSpecificFileRead;
    }

    if (name === "inspect_semantic_index") {
      return allowSemanticIndexInspect;
    }

    if (name === "semantic_search_notes") {
      return allowSemanticSearch;
    }

    if (name === "rebuild_semantic_index") {
      return allowSemanticIndexMaintenance;
    }

    if (name === "list_current_folder") {
      return allowVaultBrowse || allowSpecificFileRead;
    }

    if (name === "read_file") {
      return allowSpecificFileRead || allowVaultBrowse;
    }

    if (name === "count_words") {
      return allowWordCount;
    }

    if (
      name === "get_note_graph_context" ||
      name === "find_related_notes" ||
      name === "suggest_note_links"
    ) {
      return allowGraphContext;
    }

    if (name === "list_folder" || name === "get_path_info") {
      return allowVaultBrowse || allowSpecificFileRead;
    }

    if (name === "list_templates" || name === "read_template") {
      return allowTemplateTools;
    }

    if (name === "seed_default_templates") {
      return allowTemplateSeed;
    }

    if (name === "search_research_memory" || name === "read_research_memory") {
      return allowResearchMemory;
    }

    if (name === "append_research_memory") {
      return allowResearchMemoryWrite;
    }

    if (name === "review_research_memory") {
      return allowResearchMemory && hasResearchMemoryReviewIntent(prompt);
    }

    if (name === "compact_research_memory") {
      return allowResearchMemory && hasResearchMemoryCompactIntent(prompt);
    }

    if (name === "delete_research_memory_entry") {
      return allowResearchMemory && hasResearchMemoryDeleteIntent(prompt);
    }

    if (name === "create_template") {
      return allowTemplateCreate && !allowTemplateSeed;
    }

    if (name === "fill_template") {
      return allowTemplateFill;
    }

    if (name === "create_research_pack") {
      return allowResearchPack;
    }

    if (name === "create_folder") {
      return allowCreateFolder;
    }

    if (name === "create_file") {
      return allowCreateFile && !allowTemplateTools;
    }

    if (name === "append_file") {
      return allowPathAppend;
    }

    if (name === "replace_file") {
      return allowPathReplace;
    }

    if (name === "move_path") {
      return allowMovePath;
    }

    if (name === "delete_path") {
      return allowDeletePath;
    }

    if (name === "prepare_edit_current_section") {
      return allowEdit && streamingWritebackKind === "edit";
    }

    if (name === "append_to_current_section") {
      return allowSectionAppend && !preferPathTarget && !allowDelete;
    }

    if (name === "highlight_current_file_phrase") {
      return allowHighlight && !preferPathTarget && !allowDelete;
    }

    if (name === "restore_current_file_from_backup") {
      return allowRestore && !preferPathTarget && !allowDelete;
    }

    if (name === "append_to_current_file") {
      return (
        (allowAppend || allowAutonomousAppend) &&
        !preferPathTarget &&
        !hasTitleOnlyIntent(prompt) &&
        !allowSectionAppend &&
        !allowHighlight &&
        !allowRestore &&
        !allowEdit &&
        !allowDelete
      );
    }

    if (name === "retitle_current_file") {
      return (
        allowMarkdownRetitle &&
        !preferPathTarget &&
        !allowEdit &&
        !allowDelete
      );
    }

    if (name === "rename_current_file") {
      return (
        allowVisibleRename &&
        !preferPathTarget &&
        !allowEdit &&
        !allowDelete
      );
    }

    if (name === "edit_current_section") {
      return allowEdit && streamingWritebackKind !== "edit";
    }

    if (name === "replace_current_file") {
      return (
        allowReplace &&
        !preferPathTarget
      );
    }

    if (name === "delete_current_file") {
      return allowDelete;
    }

    if (name === "link_related_notes_in_current_file") {
      return allowGraphLinkWrite && !preferPathTarget;
    }

    return true;
  });

  // Explicit parallel vault-read missions must keep a multi-tool read batch
  // available even when mutation intent would otherwise narrow the allowlist.
  if (allowParallelVaultInspection) {
    return addToolDefinitions(filtered, toolRegistry, [
      "read_current_file",
      "count_words",
      "get_note_graph_context",
      "find_related_notes",
      "list_markdown_files",
      "append_to_current_file",
    ]);
  }

  return filtered;
}

function isAllowedForMission(
  name: string,
  prompt: string,
  intent: MissionIntent,
  reflex: ReflexDecision | null = null,
): boolean {
  if (!isToolWithinAutonomyScope(name, prompt, intent, reflex)) {
    return false;
  }

  if (READ_NAV_TOOL_NAMES.has(name)) {
    return (
      intent.vaultContext ||
      hasVaultBrowseIntent(prompt) ||
      hasParallelVaultReadIntent(prompt) ||
      hasSpecificFileReadIntent(prompt) ||
      hasCurrentNoteReadIntent(prompt) ||
      hasWordCountIntent(prompt) ||
      hasGraphConnectionIntent(prompt) ||
      hasConceptualVaultSearchIntent(prompt) ||
      hasTemplateIntent(prompt) ||
      hasResearchMemoryIntent(prompt) ||
      hasExperienceMemoryIntent(prompt) ||
      hasVaultIndexIntent(prompt) ||
      hasDesignIntent(prompt) ||
      hasBrowserAutomationIntent(prompt) ||
      hasCheckpointResumeIntent(prompt) ||
      hasMissionResumeIntent(prompt) ||
      hasSafeReflexLabel(reflex, [
        "vault_search",
        "semantic_vault_search",
        "graph_context",
        "word_count",
      ]) ||
      intent.noteOutput ||
      intent.explicitMutation
    );
  }

  if (DELETE_TOOL_NAMES.has(name)) {
    return intent.explicitDelete;
  }

  if (WRITE_TOOL_NAMES.has(name)) {
    if (name === "rebuild_semantic_index") {
      return hasSemanticIndexMaintenanceIntent(prompt);
    }

    if (name === "open_web_source") {
      return hasOpenWebSourceIntent(prompt);
    }

    if (
      name === "create_design_canvas" ||
      name === "create_svg_design" ||
      name === "create_design_package"
    ) {
      return hasDesignIntent(prompt);
    }

    if (name === "update_design_canvas") {
      return hasReviseDesignIntent(prompt);
    }

    if (name === "export_workspace_artifact") {
      return hasCodeExecutionIntent(prompt) || hasHtmlPreviewIntent(prompt);
    }

    if (MEMORY_TOOL_NAMES.has(name)) {
      return hasExperienceMemoryIntent(prompt) || hasResearchMemoryWriteIntent(prompt);
    }

    if (name === "compact_research_memory") {
      return hasResearchMemoryCompactIntent(prompt);
    }

    return intent.noteOutput || intent.explicitMutation || hasResearchMemoryWriteIntent(prompt);
  }

  if (
    name === "web_search" ||
    name === "web_fetch" ||
    name === "read_source_section"
  ) {
    return (
      hasWebSearchIntent(prompt) ||
      hasCheckpointResumeIntent(prompt) ||
      hasMissionResumeIntent(prompt) ||
      hasSafeReflexLabel(reflex, ["web_research"])
    );
  }

  if (BROWSER_TOOL_NAMES.has(name)) {
    return hasBrowserAutomationIntent(prompt);
  }

  if (CODE_TOOL_NAMES.has(name)) {
    return hasCodeExecutionIntent(prompt) || hasHtmlPreviewIntent(prompt);
  }

  return true;
}

function hasSafeReflexLabel(
  reflex: ReflexDecision | null,
  labels: ReflexDecision["label"][],
): boolean {
  return Boolean(
    reflex &&
      reflex.confidence >= 0.72 &&
      labels.includes(reflex.label) &&
      !reflex.safetyNotes.includes("unsafe"),
  );
}

function isSemanticSearchEnabled(
  settings: ToolExecutionContext["settings"] | undefined,
): boolean {
  return settings?.semanticSearchEnabled !== false;
}

function isSemanticIndexEnabled(
  settings: ToolExecutionContext["settings"] | undefined,
): boolean {
  return (
    settings?.semanticSearchEnabled !== false &&
    settings?.semanticIndexEnabled !== false
  );
}

function isToolWithinAutonomyScope(
  name: string,
  prompt: string,
  intent: MissionIntent,
  reflex: ReflexDecision | null = null,
): boolean {
  const scope = intent.autonomyScope;
  if (intent.explicitMutation && isBroadUnscopedVaultMutation(scope)) {
    return !WRITE_TOOL_NAMES.has(name) && !DELETE_TOOL_NAMES.has(name);
  }

  if (
    name === "web_search" ||
    name === "web_fetch" ||
    name === "read_source_section"
  ) {
    return (
      scope.read.web ||
      hasCheckpointResumeIntent(prompt) ||
      hasMissionResumeIntent(prompt) ||
      hasSafeReflexLabel(reflex, ["web_research"])
    );
  }

  if (name === "append_research_memory" || name === "compact_research_memory") {
    return scope.write.researchMemory;
  }

  if (name === "delete_research_memory_entry") {
    return scope.write.researchMemory && intent.explicitDelete;
  }

  if (
    name === "open_web_source" ||
    name === "create_design_canvas" ||
    name === "update_design_canvas" ||
    name === "create_svg_design" ||
    name === "create_design_package"
  ) {
    return scope.write.artifacts;
  }

  if (name === "export_workspace_artifact") {
    return scope.write.artifacts || hasCodeExecutionIntent(prompt);
  }

  if (BROWSER_TOOL_NAMES.has(name)) {
    return scope.read.web;
  }

  if (MEMORY_TOOL_NAMES.has(name)) {
    return name === "memory_search" ? true : scope.write.researchMemory;
  }

  if (name === "replace_current_file") {
    return scope.destructive.replaceCurrentNote;
  }

  if (name === "delete_current_file") {
    return scope.destructive.deleteCurrentNote;
  }

  if (name === "delete_path") {
    return scope.destructive.deletePaths;
  }

  if (
    name === "append_to_current_file" ||
    name === "append_to_current_section" ||
    name === "highlight_current_file_phrase" ||
    name === "restore_current_file_from_backup" ||
    name === "prepare_edit_current_section" ||
    name === "edit_current_section" ||
    name === "rename_current_file" ||
    name === "retitle_current_file" ||
    name === "link_related_notes_in_current_file"
  ) {
    return (
      scope.write.currentNote ||
      scope.destructive.replaceCurrentNote ||
      scope.destructive.deleteCurrentNote
    );
  }

  return true;
}

function createMissionOperationGoals({
  prompt,
  allowedToolNames,
  requiredWriteTools,
  researchPlan,
  streamingWritebackKind,
}: {
  prompt: string;
  allowedToolNames: Set<string>;
  requiredWriteTools: string[];
  researchPlan?: ResearchPlan | null;
  streamingWritebackKind: StreamingWritebackKind | null;
}): MissionOperationGoals {
  const goals = Object.fromEntries(
    ALL_OPERATION_GOALS.map((goal) => [goal, "not_requested" as const]),
  ) as Record<OperationGoal, OperationGoalState>;
  const requestGoal = (goal: OperationGoal) => {
    if (goals[goal] === "not_requested") {
      goals[goal] = "pending";
    }
  };

  for (const toolName of getMissingRequiredWebToolNames({
    prompt,
    allowedToolNames,
    executedWebSearchTool: false,
    executedWebFetchTool: false,
    researchPlan,
    missionEvidence: [],
  })) {
    if (toolName === "web_search") {
      requestGoal("web_search");
    }
    if (toolName === "web_fetch") {
      requestGoal("web_fetch");
    }
  }

  for (const toolName of requiredWriteTools) {
    for (const goal of TOOL_GOALS[toolName] ?? []) {
      requestGoal(goal);
    }
  }

  if (
    streamingWritebackKind === "append" &&
    shouldTrackStreamingAppendContent(prompt, requiredWriteTools)
  ) {
    requestGoal("current_note_content");
  } else if (streamingWritebackKind === "replace") {
    requestGoal("current_note_replace");
  } else if (streamingWritebackKind === "edit") {
    requestGoal("current_section_edit");
  }

  return { goals, completedTools: [] };
}

function shouldTrackStreamingAppendContent(
  prompt: string,
  requiredWriteTools: string[],
): boolean {
  if (hasTitleOnlyIntent(prompt)) {
    return false;
  }

  const writeToolOwnsContent = requiredWriteTools.some((toolName) =>
    [
      "append_to_current_file",
      "append_to_current_section",
      "append_file",
      "create_file",
      "fill_template",
      "create_research_pack",
      "append_research_memory",
      "create_design_canvas",
      "create_svg_design",
    ].includes(toolName),
  );
  if (writeToolOwnsContent) {
    return false;
  }

  return (
    hasExplicitStreamToCurrentNoteIntent(prompt) ||
    hasCurrentPageWritebackIntent(prompt) ||
    hasGeneratedWritingIntent(prompt) ||
    hasStaticGenerationIntent(prompt) ||
    hasNoteOutputIntent(prompt)
  );
}

function markOperationGoalDone(
  operationGoals: MissionOperationGoals,
  goal: OperationGoal,
) {
  if (operationGoals.goals[goal] !== "not_requested") {
    operationGoals.goals[goal] = "done";
  }
}

function markOperationGoalFailed(
  operationGoals: MissionOperationGoals,
  goal: OperationGoal,
) {
  if (
    operationGoals.goals[goal] !== "not_requested" &&
    operationGoals.goals[goal] !== "done"
  ) {
    operationGoals.goals[goal] = "failed";
  }
}

function markOperationGoalsForTool({
  operationGoals,
  toolName,
  ok,
  streamingWritebackKind,
}: {
  operationGoals: MissionOperationGoals;
  toolName: string;
  ok: boolean;
  streamingWritebackKind: StreamingWritebackKind | null;
}) {
  if (ok) {
    operationGoals.completedTools.push(toolName);
  }

  const goals = TOOL_GOALS[toolName] ?? [];
  for (const goal of goals) {
    if (
      ok &&
      toolName === "prepare_edit_current_section" &&
      streamingWritebackKind === "edit"
    ) {
      continue;
    }

    if (ok) {
      markOperationGoalDone(operationGoals, goal);
    } else {
      markOperationGoalFailed(operationGoals, goal);
    }
  }

  if (ok && toolName === "replace_current_file") {
    markOperationGoalDone(operationGoals, "current_note_content");
  }
}

function markStreamingWritebackGoalDone(
  operationGoals: MissionOperationGoals,
  kind: StreamingWritebackKind,
) {
  if (kind === "append") {
    markOperationGoalDone(operationGoals, "current_note_content");
  } else if (kind === "replace") {
    markOperationGoalDone(operationGoals, "current_note_replace");
    markOperationGoalDone(operationGoals, "current_note_content");
  } else {
    markOperationGoalDone(operationGoals, "current_section_edit");
  }
}

function isMissionComplete(operationGoals: MissionOperationGoals): boolean {
  return Object.values(operationGoals.goals).every(
    (state) => state === "not_requested" || state === "done",
  );
}

function hasPendingOperationGoals(operationGoals: MissionOperationGoals): boolean {
  return Object.values(operationGoals.goals).some((state) => state === "pending");
}

function hasPendingStreamingWritebackGoal(
  operationGoals: MissionOperationGoals,
  kind: StreamingWritebackKind | null,
): boolean {
  if (kind === "append") {
    return operationGoals.goals.current_note_content === "pending";
  }

  if (kind === "replace") {
    return operationGoals.goals.current_note_replace === "pending";
  }

  if (kind === "edit") {
    return operationGoals.goals.current_section_edit === "pending";
  }

  return false;
}

function getPendingRequiredWriteToolNames(
  operationGoals: MissionOperationGoals,
  requiredWriteTools: string[],
): string[] {
  const completed = new Set(operationGoals.completedTools);
  return requiredWriteTools.filter((toolName) => {
    if (completed.has(toolName)) {
      return false;
    }

    const goals = TOOL_GOALS[toolName] ?? [];
    if (goals.length === 0) {
      return true;
    }

    return goals.some((goal) => operationGoals.goals[goal] === "pending");
  });
}

function getRequiredWriteToolNames(
  prompt: string,
  allowedToolNames: Set<string>,
  missionIntent: MissionIntent,
  streamingWritebackKind: StreamingWritebackKind | null = null,
): string[] {
  const requiredToolNames: string[] = [];
  const wholeNoteReplace = hasWholeNoteReplaceIntent(prompt);
  const noteOutputIntent = missionIntent.noteOutput;

  const preferPathTarget = hasExplicitNonCurrentNoteWriteTarget(prompt);

  if (streamingWritebackKind === "edit") {
    requiredToolNames.push("prepare_edit_current_section");
  }

  if (hasSectionAppendIntent(prompt)) {
    requiredToolNames.push("append_to_current_section");
  }

  if (hasHighlightIntent(prompt)) {
    requiredToolNames.push("highlight_current_file_phrase");
  }

  if (hasRestoreIntent(prompt)) {
    requiredToolNames.push("restore_current_file_from_backup");
  }

  if (hasResearchMemoryWriteIntent(prompt)) {
    requiredToolNames.push("append_research_memory");
  }

  if (hasResearchMemoryCompactIntent(prompt)) {
    requiredToolNames.push("compact_research_memory");
  }

  if (hasResearchMemoryDeleteIntent(prompt)) {
    requiredToolNames.push("delete_research_memory_entry");
  }

  if (
    (hasAppendIntent(prompt) || noteOutputIntent) &&
    !preferPathTarget &&
    !wholeNoteReplace &&
    !hasSectionAppendIntent(prompt) &&
    !hasHighlightIntent(prompt) &&
    !hasRestoreIntent(prompt) &&
    !hasEditIntent(prompt) &&
    !hasDeleteIntent(prompt) &&
    streamingWritebackKind !== "append"
  ) {
    requiredToolNames.push("append_to_current_file");
  }

  if (hasAppendIntent(prompt) && hasPathTargetIntent(prompt)) {
    requiredToolNames.push("append_file");
  }

  if (hasReplaceIntent(prompt) && !preferPathTarget && streamingWritebackKind !== "replace") {
    requiredToolNames.push("replace_current_file");
  }

  if (hasReplaceIntent(prompt) && hasPathTargetIntent(prompt)) {
    requiredToolNames.push("replace_file");
  }

  if (hasTemplateSeedIntent(prompt)) {
    requiredToolNames.push("seed_default_templates");
  } else if (hasTemplateCreateIntent(prompt)) {
    requiredToolNames.push("create_template");
  }

  if (hasTemplateFillIntent(prompt)) {
    requiredToolNames.push("fill_template");
  }

  if (hasResearchPackIntent(prompt)) {
    requiredToolNames.push("create_research_pack");
  }

  if (hasDesignIntent(prompt) || hasReviseDesignIntent(prompt)) {
    if (hasReviseDesignIntent(prompt) && hasCanvasDesignIntent(prompt)) {
      requiredToolNames.push("update_design_canvas");
      if (
        /\b(create|draw|make|generate|build|draft)\b/i.test(prompt) &&
        !/\b(only|just)\s+revise\b/i.test(prompt)
      ) {
        requiredToolNames.push("create_design_canvas");
      }
    } else if (hasDesignPackageIntent(prompt)) {
      requiredToolNames.push("create_design_package");
    } else if (hasCanvasDesignIntent(prompt)) {
      requiredToolNames.push("create_design_canvas");
    }

    if (hasSvgDesignIntent(prompt) && !hasReviseDesignIntent(prompt)) {
      requiredToolNames.push("create_svg_design");
    }
  }

  if (hasMarkdownTitleContentIntent(prompt) && !preferPathTarget) {
    requiredToolNames.push("retitle_current_file");
  } else if (
    !preferPathTarget &&
    (isExplicitVisibleFileRenameIntent(prompt) ||
      (isVisibleTitleRenameIntent(prompt) && isTitleOnlyIntent(prompt)))
  ) {
    requiredToolNames.push("rename_current_file");
  }

  if (hasCreateFolderIntent(prompt)) {
    requiredToolNames.push("create_folder");
  }

  if (hasCreateFileIntent(prompt) && !hasTemplateIntent(prompt)) {
    requiredToolNames.push("create_file");
  }

  if (hasEditIntent(prompt) && !wholeNoteReplace && streamingWritebackKind !== "edit") {
    requiredToolNames.push("edit_current_section");
  }

  if (hasDeleteIntent(prompt)) {
    requiredToolNames.push("delete_current_file");
  }

  if (hasDeletePathIntent(prompt)) {
    requiredToolNames.push("delete_path");
  }

  if (hasMovePathIntent(prompt)) {
    requiredToolNames.push("move_path");
  }

  if (hasGraphLinkWriteIntent(prompt)) {
    requiredToolNames.push("link_related_notes_in_current_file");
  }

  return requiredToolNames.filter((name) => allowedToolNames.has(name));
}

function buildWriteCorrectionPrompt(requiredWriteTools: string[]): string {
  return [
    "The user explicitly requested a vault write or artifact creation, but you answered without using a write tool.",
    `Request one of these allowed write tools now: ${requiredWriteTools.join(", ")}.`,
    "If the mission needs multiple operations, request multiple tool calls in this step when the model API supports it.",
    "Do not provide chat-only prose until every requested write, update, create, or delete operation has completed.",
  ].join(" ");
}

function buildToolBeforeStreamingWritebackPrompt(
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];

  return [
    "The mission asks for sources, vault context, graph context, or verification before writing.",
    `Use the relevant available tools before final writeback. Available tools: ${toolNames.join(", ") || "none"}.`,
    "Request tools only. Do not draft the final answer yet.",
  ].join(" ");
}

function buildVaultTraversalBeforeFinalAnswerPrompt(
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];

  return [
    "The user asked what other folders, notes, or files say. You have vault traversal and read tools available, so do not claim you cannot access the vault.",
    "Use a map/select/read flow before giving the final answer: map the relevant folder or markdown-file set, select the likely files, then read note content with read_markdown_files or read_file before synthesizing.",
    "Start with list_current_folder when the active note location may matter, then use list_markdown_files, list_folder, search_markdown_files, read_markdown_files, read_file, or get_path_info as needed.",
    `Available tools: ${toolNames.join(", ") || "none"}.`,
    "Request tools only. Do not answer from filenames alone.",
  ].join(" ");
}

function buildWebResearchBeforeFinalAnswerPrompt(
  missingToolNames: string[],
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];

  return [
    "The user asked for current web research, sources, citations, or verification.",
    `Request these missing web tools before giving the final answer: ${missingToolNames.join(", ")}.`,
    `Available tools: ${toolNames.join(", ") || "none"}.`,
    "Use web_search before web_fetch unless the user supplied a specific URL; when both are needed, you may request both tool calls in the same step.",
    "Request tools only. Do not answer from memory.",
  ].join(" ");
}

function buildReflexCompletionCorrectionPrompt(
  missing: string[],
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];
  return [
    `Reflex completion gate requires before final answer: ${missing.join(", ")}.`,
    `Available tools: ${toolNames.join(", ") || "none"}.`,
    missing.includes("vault_evidence")
      ? "Use available vault or semantic search/read tools before answering."
      : "",
    missing.includes("web_evidence")
      ? "Use web_search and web_fetch when available before answering."
      : "",
    missing.includes("word_count") ? "Use count_words before answering." : "",
    missing.includes("write_receipt")
      ? "Use an available write tool and finish with a real receipt."
      : "",
    "If the required tool is unavailable, stop with a concise blocker instead of claiming completion.",
    "Request tools only. Do not answer from memory.",
  ].filter(Boolean).join(" ");
}

function buildFallbackWebSearchQuery(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact;
  }

  return compact.slice(0, 180);
}

function getLatestToolOutput(
  messages: ModelChatMessage[],
  toolName: string,
): unknown {
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || message.toolName !== toolName) {
      continue;
    }

    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (isRecord(parsed) && "output" in parsed) {
        return parsed.output;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function getFirstWebSearchResultUrl(output: unknown): string | null {
  return getWebSearchResultUrls(output)[0] ?? null;
}

function getWebSearchResultUrls(output: unknown): string[] {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return [];
  }

  const urls: string[] = [];
  for (const result of output.results) {
    if (!isRecord(result) || typeof result.url !== "string") {
      continue;
    }

    const url = result.url.trim();
    if (/^https?:\/\//i.test(url) && !urls.includes(url)) {
      urls.push(url);
    }
  }

  return urls;
}

function rankWebSearchResultUrls(output: unknown, query: string): string[] {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return [];
  }
  const queryTerms = getSourceRankingTerms(query);
  return output.results
    .map((result, index) => {
      if (!isRecord(result) || typeof result.url !== "string") return null;
      const url = result.url.trim();
      if (!/^https?:\/\//i.test(url)) return null;
      const text = [result.title, result.snippet, result.content, url]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
      const relevance = queryTerms.reduce(
        (score, term) => score + (text.includes(term) ? 1 : 0),
        0,
      );
      const authority = /(?:\.gov|\.edu|doi\.org|arxiv\.org|docs?\.)/i.test(url)
        ? 0.25
        : 0;
      return { url, index, score: relevance + authority };
    })
    .filter(
      (item): item is { url: string; index: number; score: number } => item !== null,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.url)
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

function getSourceRankingTerms(value: string): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "before",
    "cite",
    "cited",
    "citation",
    "current",
    "include",
    "multiple",
    "research",
    "source",
    "sources",
    "that",
    "their",
    "this",
    "verify",
    "with",
  ]);
  return [
    ...new Set(
      (value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(
        (term) => !stopWords.has(term),
      ),
    ),
  ].slice(0, 40);
}

function selectDomainDiverseUrls(
  candidateUrls: string[],
  alreadyFetchedUrls: string[],
  limit: number,
): string[] {
  if (limit <= 0) {
    return [];
  }

  const fetched = new Set(alreadyFetchedUrls);
  const usedDomains = new Set(
    alreadyFetchedUrls
      .map(getUrlHostname)
      .filter((domain): domain is string => Boolean(domain)),
  );
  const selected: string[] = [];
  const deferred: string[] = [];

  for (const url of candidateUrls) {
    if (fetched.has(url)) {
      continue;
    }
    const hostname = getUrlHostname(url);
    if (hostname && !usedDomains.has(hostname)) {
      selected.push(url);
      usedDomains.add(hostname);
    } else {
      deferred.push(url);
    }
    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const url of deferred) {
    if (selected.length >= limit) {
      break;
    }
    if (!selected.includes(url)) {
      selected.push(url);
    }
  }

  return selected;
}

function getFetchedWebSourceUrls(evidence: MissionEvidence[]): string[] {
  return [
    ...new Set(
      evidence
        .filter((item) => item.kind === "web_source" || Boolean(item.url))
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

function getUrlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function shouldExpandVaultRetrievalCoverage(
  output: unknown,
  researchPlan: ResearchPlan | null,
): boolean {
  if (
    !researchPlan ||
    (researchPlan.mode !== "deep_vault" && researchPlan.mode !== "deep_hybrid")
  ) {
    return false;
  }
  if (!isRecord(output)) {
    return false;
  }
  const coverage = isRecord(output.coverage) ? output.coverage : null;
  const confidence = coverage ? getString(coverage.confidence) : undefined;
  const mode = coverage ? getString(coverage.mode) : undefined;
  return (
    output.fallbackUsed === true ||
    coverage?.truncated === true ||
    mode === "sampled" ||
    mode === "fallback" ||
    confidence === "low"
  );
}

function buildUnavailableToolCorrectionPrompt(
  tools: ModelChatRequest["tools"],
): string {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];

  return [
    "You requested a write tool that is not available for this mission.",
    `Available tools are: ${toolNames.join(", ") || "none"}.`,
    "Choose an available write tool if one fits. Otherwise provide a concise final answer explaining what user intent is required.",
  ].join(" ");
}

function shouldObserveCurrentNote(
  prompt: string,
  allowedToolNames: Set<string>,
  missionIntent: MissionIntent,
): boolean {
  void missionIntent;
  // Keep read_current_file model-callable for explicit parallel inspection so
  // it can batch with other read-only tools instead of being prefetched away.
  if (hasParallelVaultReadIntent(prompt)) {
    return false;
  }
  return (
    allowedToolNames.has("read_current_file") &&
    requiresCurrentNoteContent(prompt)
  );
}

function hasParallelVaultReadIntent(prompt: string): boolean {
  return (
    /\bparallel\b[\s\S]{0,100}\b(?:vault\s+)?reads?\b/i.test(prompt) ||
    /\b(?:vault\s+)?reads?\b[\s\S]{0,100}\bparallel\b/i.test(prompt) ||
    /\bparallel\s+(?:read[-\s]?only\s+)?tools?\b/i.test(prompt)
  );
}

function shouldAllowWebSearch(
  prompt: string,
  missionIntent: MissionIntent,
): boolean {
  if (!hasWebSearchIntent(prompt)) {
    return false;
  }

  if (!missionIntent.vaultContext) {
    return true;
  }

  return hasExplicitWebSearchIntent(prompt);
}

function canStreamAnswerFromInitialCurrentNoteContext(
  tools: ModelChatRequest["tools"],
): boolean {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];
  return toolNames.length === 1 && toolNames[0] === "read_current_file";
}

function removeToolDefinition(
  tools: ModelToolDefinition[],
  name: string,
): ModelToolDefinition[] {
  return tools.filter((tool) => tool.function.name !== name);
}

function addToolDefinitions(
  tools: ModelToolDefinition[],
  toolRegistry: ToolRegistry,
  names: string[],
): ModelToolDefinition[] {
  const next = [...tools];
  const existing = new Set(next.map((tool) => tool.function.name));
  const definitions = new Map(
    toolRegistry.getDefinitions().map((tool) => [tool.function.name, tool]),
  );
  for (const name of names) {
    if (existing.has(name)) {
      continue;
    }
    const definition = definitions.get(name);
    if (!definition) {
      continue;
    }
    next.push(definition);
    existing.add(name);
  }
  return next;
}

function shouldOmitCurrentNoteReadForTargetOnlyWrite(
  prompt: string,
  missionIntent: MissionIntent,
): boolean {
  return (
    missionIntent.noteOutput &&
    !missionIntent.vaultContext &&
    !missionIntent.explicitDelete &&
    !requiresCurrentNoteContent(prompt)
  );
}

function getDirectCurrentNoteWritebackKind({
  prompt,
  missionIntent,
  streamingWritebackKind,
  toolContext,
}: {
  prompt: string;
  missionIntent: MissionIntent;
  streamingWritebackKind: StreamingWritebackKind | null;
  toolContext: ToolExecutionContext;
}): StreamingWritebackKind | null {
  if (
    streamingWritebackKind !== "append" ||
    !canUseCurrentNoteStreamingWriteback(toolContext) ||
    !missionIntent.noteOutput ||
    missionIntent.explicitDelete ||
    promptRequiresToolLoop(prompt) ||
    requiresCurrentNoteContent(prompt) ||
    hasExplicitNonCurrentNoteWriteTarget(prompt) ||
    // Title/rename must stay on the tool loop so rename_current_file can run
    // before (or with) streamed content writeback.
    hasTitleIntent(prompt) ||
    isVisibleTitleRenameIntent(prompt)
  ) {
    return null;
  }

  return "append";
}

function createRuntimeCache(): AgentRuntimeCache {
  return {
    toolResults: new Map(),
  };
}

function parseExplicitModelStepTarget(prompt: string): number | null {
  const match =
    /\b(?:complete|run|perform|use|take)\s+(?:exactly\s+)?(\d{1,3})\s+(?:model|agent|planning|loop)\s+steps?\b/i.exec(
      prompt,
    ) ??
    /\b(?:exactly\s+)?(\d{1,3})\s+(?:model|agent|planning|loop)\s+steps?\s+before\b/i.exec(
      prompt,
    );

  if (!match) {
    return null;
  }

  const target = Number.parseInt(match[1], 10);
  return Number.isFinite(target) && target > 0 ? target : null;
}

function getConfiguredMaxAgentSteps(
  settings: ToolExecutionContext["settings"] | undefined,
): number {
  return resolveConfiguredMaxAgentSteps(settings?.maxAgentSteps);
}

function buildInstantLocalAnswer(
  prompt: string,
  toolContext: ToolExecutionContext,
): string {
  const now = toolContext.now?.() ?? new Date();
  const lowerPrompt = prompt.toLowerCase();
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

  if (/\btime\b/.test(lowerPrompt) && !/\bdate|day\b/.test(lowerPrompt)) {
    return `Current local time: ${time}.`;
  }

  if (/\bdate|day\b/.test(lowerPrompt) && !/\btime\b/.test(lowerPrompt)) {
    return `Today is ${date}.`;
  }

  return `Today is ${date}. Current local time: ${time}.`;
}

function canUseCurrentNoteStreamingWriteback(
  toolContext: ToolExecutionContext,
): boolean {
  return (
    typeof toolContext.app?.workspace?.getActiveFile === "function" &&
    typeof toolContext.app?.vault?.read === "function" &&
    typeof toolContext.app?.vault?.modify === "function"
  );
}

function requiresCurrentNoteContent(prompt: string): boolean {
  return (
    isPromptOnCurrentPageIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    hasSectionAppendIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasTitleIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    /\b(read|check|inspect|look\s+at|open)\b[\s\S]{0,80}\b(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(current|this|active)\s+(note|file|markdown|document)\b[\s\S]{0,80}\b(read|check|inspect|look\s+at|open)\b/i.test(
      prompt,
    ) ||
    /\b(summari[sz]e|analy[sz]e|explain|extract|review|describe)\b[\s\S]{0,40}\b(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(summary|analysis|explanation|review|description)\s+of\s+(?:the\s+)?(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(what|which|where|why|how)\b[\s\S]{0,80}\b(current|this|active)\s+(note|file|markdown|document)\b/i.test(
      prompt,
    ) ||
    /\b(based\s+on|from|using|according\s+to)\s+(?:the\s+)?(current|this|active)\s+(note|file|markdown|document|content)\b/i.test(
      prompt,
    )
  );
}

function getPromptOnCurrentPageRoutingPrompt(
  prompt: string,
  currentNoteContext: unknown,
): string | null {
  if (!isPromptOnCurrentPageIntent(prompt)) {
    return null;
  }

  const pagePrompt = getCurrentNoteContextContent(currentNoteContext)?.trim();
  if (!pagePrompt) {
    return null;
  }

  const instructionPrompt = extractActiveInstructionBlockFromCurrentNote(pagePrompt);
  return instructionPrompt ? instructionPrompt : null;
}

function extractActiveInstructionBlockFromCurrentNote(markdown: string): string {
  const withoutFrontmatter = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
  const lines = withoutFrontmatter.split(/\r?\n/u);
  const collected: string[] = [];

  for (const line of lines) {
    if (isGeneratedOutputBoundaryHeading(line) && collected.some((item) => item.trim())) {
      break;
    }

    collected.push(line);
  }

  const prompt = collected.join("\n").trim();
  if (prompt) {
    return prompt;
  }

  return withoutFrontmatter.trim();
}

function isGeneratedOutputBoundaryHeading(line: string): boolean {
  const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  if (!match) {
    return false;
  }

  const heading = match[1].trim().toLowerCase();
  return (
    /^(findings?|results?|sources?|references?|receipts?|run details?|assistant|answer|output|summary|draft)\b/u.test(
      heading,
    ) ||
    /^a tale\b/u.test(heading)
  );
}

function classifyPromptOnCurrentPageMissionIntent(prompt: string): MissionIntent {
  const intent = classifyMissionIntent(prompt);
  if (intent.vaultContext && hasCurrentPageWritebackIntent(prompt)) {
    return {
      ...intent,
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    };
  }

  if (intent.explicitMutation || intent.explicitDelete) {
    return intent;
  }

  if (
    intent.noteOutput ||
    hasGeneratedWritingIntent(prompt) ||
    hasStaticGenerationIntent(prompt)
  ) {
    return {
      ...intent,
      mode: "note_output",
      noteOutput: true,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    };
  }

  return intent;
}

function promptRequiresToolLoop(prompt: string): boolean {
  return (
    hasWebSearchIntent(prompt) ||
    hasVaultContextQuestionIntent(prompt) ||
    hasVaultBrowseIntent(prompt) ||
    hasVaultIndexIntent(prompt) ||
    hasSpecificFileReadIntent(prompt) ||
    hasGraphConnectionIntent(prompt) ||
    hasTemplateIntent(prompt) ||
    hasResearchMemoryReadIntent(prompt) ||
    hasDesignIntent(prompt) ||
    hasCodeExecutionIntent(prompt) ||
    hasHtmlPreviewIntent(prompt) ||
    hasOpenWebSourceIntent(prompt) ||
    hasWordCountIntent(prompt)
  );
}

function shouldPrefetchVaultFolderAnswer(
  prompt: string,
  intent: MissionIntent,
): boolean {
  const safeCurrentPageWriteback =
    intent.explicitMutation &&
    intent.noteOutput &&
    hasCurrentPageWritebackIntent(prompt) &&
    !hasReplaceIntent(prompt) &&
    !hasEditIntent(prompt) &&
    !hasDeleteIntent(prompt) &&
    !hasDeletePathIntent(prompt);

  return (
    intent.vaultContext &&
    hasPrefetchableFolderSummaryIntent(prompt) &&
    !hasWebSearchIntent(prompt) &&
    !hasGraphConnectionIntent(prompt) &&
    !hasTemplateIntent(prompt) &&
    !hasSpecificFileReadIntent(prompt) &&
    !hasTopicSearchVaultQuestionIntent(prompt) &&
    !/^\s*Continue the prior vault exploration\b/i.test(prompt) &&
    (!intent.explicitMutation || safeCurrentPageWriteback) &&
    !intent.explicitDelete
  );
}

function hasPrefetchableFolderSummaryIntent(prompt: string): boolean {
  return (
    hasFolderContentQuestionIntent(prompt) &&
    /\b(say|says|contain|contains|contents?|details?|discover(?:ed|ies)?|findings?|report\s+back|gather|collect|read|summari[sz]e|what\s+they\s+say|tell\s+me(?:\s+what|\s+about)?)\b/i.test(
      prompt,
    )
  ) || /\b(gather|collect|read|summari[sz]e|report\s+back|tell\s+me)\b[\s\S]{0,160}\bother\s+folders?\b[\s\S]{0,80}\b(say|says|what\s+they\s+say|details?|contents?)\b/i.test(
    prompt,
  ) || hasNamedFolderTraversalIntent(prompt);
}

function hasTopicSearchVaultQuestionIntent(prompt: string): boolean {
  return /\b(what|where|find|search|show|list)\b[\s\S]{0,80}\b(my\s+)?notes?\b[\s\S]{0,80}\b(about|mention|mentions|reference|references|related\s+to)\b/i.test(
    prompt,
  );
}

function hasConceptualVaultSearchIntent(prompt: string): boolean {
  if (
    hasSpecificFileReadIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    hasDeletePathIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasReplaceIntent(prompt)
  ) {
    return false;
  }

  return (
    hasTopicSearchVaultQuestionIntent(prompt) ||
    hasGraphConnectionIntent(prompt) ||
    /\b(my\s+)?notes?\b[\s\S]{0,120}\b(idea|ideas|concepts?|themes?|topics?|memory|memories|relationships?|connections?|similar|related|about)\b/i.test(
      prompt,
    ) ||
    /\b(find|search|show|surface|retrieve)\b[\s\S]{0,120}\b(idea|ideas|concepts?|themes?|topics?|memory|memories|relationships?|connections?|similar|related)\b/i.test(
      prompt,
    )
  );
}

function hasSemanticIndexMaintenanceIntent(prompt: string): boolean {
  return /\b(rebuild|refresh|update|regenerate|repair|create)\b[\s\S]{0,120}\bsemantic\s+(vault\s+)?index\b|\bsemantic\s+(vault\s+)?index\b[\s\S]{0,120}\b(rebuild|refresh|update|regenerate|repair|create)\b/i.test(
    prompt,
  );
}

function requiresVaultTraversalBeforeFinalAnswer(
  prompt: string,
  runPlan: RunPlan,
  allowedToolNames: Set<string>,
): boolean {
  return (
    runPlan.slowPathReason === "needs_vault_context" &&
    hasFolderContentQuestionIntent(prompt) &&
    hasAnyAllowedTool(allowedToolNames, [
      "inspect_vault_context",
      "list_current_folder",
      "list_markdown_files",
      "search_markdown_files",
      "read_markdown_files",
      "read_file",
      "list_folder",
      "get_path_info",
    ])
  );
}

function getMissingRequiredWebToolNames({
  prompt,
  allowedToolNames,
  executedWebSearchTool,
  executedWebFetchTool,
  researchPlan,
  missionEvidence = [],
}: {
  prompt: string;
  allowedToolNames: Set<string>;
  executedWebSearchTool: boolean;
  executedWebFetchTool: boolean;
  researchPlan?: ResearchPlan | null;
  missionEvidence?: MissionEvidence[];
}): string[] {
  const minFetchedSources = researchPlan?.sourceRequirements.minFetchedSources ?? 0;
  const fetchedSourceCount = countFetchedWebSources(missionEvidence);
  const requiresWeb =
    hasWebSearchIntent(prompt) ||
    (researchPlan !== null &&
      researchPlan !== undefined &&
      (researchPlan.mode === "deep_web" || researchPlan.mode === "deep_hybrid"));

  if (!requiresWeb) {
    return [];
  }

  const missing: string[] = [];
  if (allowedToolNames.has("web_search") && !executedWebSearchTool) {
    missing.push("web_search");
  }
  if (
    (shouldRequireWebFetchBeforeFinalAnswer(prompt) ||
      minFetchedSources > fetchedSourceCount) &&
    allowedToolNames.has("web_fetch") &&
    (!executedWebFetchTool || fetchedSourceCount < minFetchedSources)
  ) {
    missing.push("web_fetch");
  }

  return missing;
}

function shouldRequireWebFetchBeforeFinalAnswer(prompt: string): boolean {
  return (
    hasWebSearchIntent(prompt) ||
    hasFetchedWebSourceIntent(prompt) ||
    hasDeepResearchIntent(prompt) ||
    hasCurrentWebFactIntent(prompt)
  );
}

function countFetchedWebSources(evidence: MissionEvidence[]): number {
  return new Set(
    evidence
      .filter((item) => item.kind === "web_source" || Boolean(item.url))
      .map((item) => item.url)
      .filter((url): url is string => Boolean(url)),
  ).size;
}

function areLoopRequiredToolsSatisfied(
  expectedTools: string[],
  successfulTools: string[],
): boolean {
  if (expectedTools.length === 0) {
    return false;
  }

  const successful = new Set(successfulTools);
  return expectedTools.every((toolName) => successful.has(toolName));
}

function hasAnyAllowedTool(
  allowedToolNames: Set<string>,
  toolNames: string[],
): boolean {
  return toolNames.some((toolName) => allowedToolNames.has(toolName));
}

function getPromptOnPageWritebackKind({
  prompt,
  currentNoteContext,
  toolContext,
  enableStreaming,
}: {
  prompt: string;
  currentNoteContext: unknown;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
}): StreamingWritebackKind | null {
  if (
    !enableStreaming ||
    !isPromptOnCurrentPageIntent(prompt) ||
    toolContext.settings?.streamWritebackMode !==
      "all_current_note_content_writes"
  ) {
    return null;
  }

  const pageContent = getCurrentNoteContextContent(currentNoteContext);
  const pagePrompt = pageContent
    ? extractActiveInstructionBlockFromCurrentNote(pageContent)
    : "";
  if (!pagePrompt || hasDeleteIntent(pagePrompt) || hasDeletePathIntent(pagePrompt)) {
    return null;
  }

  if (promptRequiresToolLoop(pagePrompt)) {
    return null;
  }

  const preferPathTarget =
    hasPathTargetIntent(pagePrompt) && !hasCurrentNoteTarget(pagePrompt);
  if (preferPathTarget) {
    return null;
  }

  if (hasWholeNoteReplaceIntent(pagePrompt)) {
    return "replace";
  }

  if (hasReplaceIntent(pagePrompt) && hasCurrentNoteTarget(pagePrompt)) {
    return "replace";
  }

  if (hasEditIntent(pagePrompt) && !hasWholeNoteReplaceIntent(pagePrompt)) {
    return null;
  }

  if (
    hasAppendIntent(pagePrompt) ||
    hasNoteOutputIntent(pagePrompt) ||
    hasStaticGenerationIntent(pagePrompt) ||
    hasGeneratedWritingIntent(pagePrompt)
  ) {
    return "append";
  }

  return null;
}

function getStreamingWritebackKind(
  prompt: string,
  toolContext: ToolExecutionContext,
  enableStreaming: boolean,
): StreamingWritebackKind | null {
  if (
    !enableStreaming ||
    !toolContext.writeAutonomy ||
    hasPriorAssistantResponseWritebackIntent(prompt) ||
    hasResearchMemoryWriteIntent(prompt) ||
    toolContext.settings?.streamWritebackMode !==
      "all_current_note_content_writes"
  ) {
    return null;
  }

  const preferPathTarget = hasExplicitNonCurrentNoteWriteTarget(prompt);

  if (preferPathTarget) {
    return null;
  }

  if (hasExplicitStreamToCurrentNoteIntent(prompt)) {
    return hasReplaceIntent(prompt) || isCurrentNoteReplaceResetPrompt(prompt)
      ? "replace"
      : "append";
  }

  if (isNamedSectionEditIntent(prompt)) {
    return "edit";
  }

  if (
    prefersStreamedReplaceForEditOrganize(prompt) ||
    hasWholeNoteReplaceIntent(prompt)
  ) {
    return "replace";
  }

  if (hasEditIntent(prompt) && !hasWholeNoteReplaceIntent(prompt)) {
    return "edit";
  }

  if (hasReplaceIntent(prompt)) {
    return "replace";
  }

  if (hasAppendIntent(prompt)) {
    return "append";
  }

  if (hasCurrentPageWritebackIntent(prompt)) {
    return "append";
  }

  if (
    hasNoteOutputIntent(prompt) ||
    toolContext.missionIntent?.noteOutput
  ) {
    return "append";
  }

  return null;
}

function classifyMissionIntent(prompt: string): MissionIntent {
  const generated = analyzeGeneratedOutputPrompt(prompt);
  const resetAction = analyzeCurrentNoteResetPrompt(prompt);
  const explicitGraphLinkWrite = hasGraphLinkWriteIntent(prompt);
  const explicitTemplateWrite =
    hasTemplateSeedIntent(prompt) ||
    hasTemplateCreateIntent(prompt) ||
    hasTemplateFillIntent(prompt) ||
    hasResearchPackIntent(prompt);
  const explicitResearchMemoryWrite = hasResearchMemoryWriteIntent(prompt);
  const explicitDesignWrite = hasDesignIntent(prompt);
  const explicitHighlightWrite = hasHighlightIntent(prompt);
  const explicitRestoreWrite = hasRestoreIntent(prompt);
  const chatOnlyResponse = hasChatOnlyResponseIntent(prompt);
  const explicitPersistence =
    (!chatOnlyResponse && hasExplicitWritePersistenceIntent(prompt)) ||
    explicitGraphLinkWrite ||
    explicitTemplateWrite ||
    explicitResearchMemoryWrite ||
    explicitDesignWrite ||
    explicitHighlightWrite ||
    explicitRestoreWrite;
  const explicitDelete =
    resetAction.kind !== "replace_current_note" &&
    (hasDeleteIntent(prompt) || hasDeletePathIntent(prompt));
  const explicitMutation =
    explicitPersistence ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    isCurrentNoteEditOrganizeIntent(prompt) ||
    isWholeNoteEditIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasSectionAppendIntent(prompt) ||
    explicitHighlightWrite ||
    explicitRestoreWrite ||
    hasTitleIntent(prompt) ||
    explicitGraphLinkWrite ||
    explicitTemplateWrite ||
    explicitResearchMemoryWrite ||
    explicitDesignWrite ||
    explicitDelete;
  const vaultContext =
    hasVaultContextQuestionIntent(prompt) ||
    hasResearchMemoryReadIntent(prompt) ||
    isVaultWideOrganizeIntent(prompt) ||
    (!explicitMutation && hasVaultBrowseIntent(prompt));
  const webAnswerOnly =
    hasWebSearchIntent(prompt) &&
    generated.target === "chat_only" &&
    !explicitPersistence &&
    !hasCurrentPageWritebackIntent(prompt) &&
    !hasPathTargetIntent(prompt);
  const noteOutput =
    !explicitResearchMemoryWrite &&
    !webAnswerOnly &&
    !isVaultWideOrganizeIntent(prompt) &&
    (hasNoteOutputIntent(prompt) ||
      isCurrentNoteEditOrganizeIntent(prompt) ||
      isWholeNoteEditIntent(prompt) ||
      generated.target === "current_note_append" ||
      generated.target === "current_note_replace");

  if (explicitDelete) {
    return buildMissionIntent(prompt, {
      mode: "explicit_delete",
      vaultContext,
      noteOutput: false,
      explicitPersistence,
      explicitMutation: true,
      explicitDelete: true,
      allowAutonomousWrite: false,
      requireWriteCompletion: true,
    });
  }

  // Vault-wide organize without targets: clarify/scope — do not force
  // requireWriteCompletion alone (avoids write_receipt dead-ends).
  if (isVaultWideOrganizeIntent(prompt) && !isCurrentNoteEditOrganizeIntent(prompt)) {
    return buildMissionIntent(prompt, {
      mode: "vault_context_answer",
      vaultContext: true,
      noteOutput: false,
      explicitPersistence: false,
      explicitMutation: false,
      explicitDelete: false,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
    });
  }

  if (explicitMutation) {
    return buildMissionIntent(prompt, {
      mode: "explicit_file_mutation",
      vaultContext,
      noteOutput:
        noteOutput ||
        isCurrentNoteEditOrganizeIntent(prompt) ||
        isWholeNoteEditIntent(prompt),
      explicitPersistence,
      explicitMutation: true,
      explicitDelete: false,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    });
  }

  if (vaultContext) {
    return buildMissionIntent(prompt, {
      mode: "vault_context_answer",
      vaultContext: true,
      noteOutput: false,
      explicitPersistence: false,
      explicitMutation: false,
      explicitDelete: false,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
    });
  }

  return buildMissionIntent(prompt, {
    mode: noteOutput ? "note_output" : "chat_only",
    vaultContext: false,
    noteOutput,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: noteOutput,
    requireWriteCompletion: noteOutput,
  });
}

function buildMissionIntent(
  prompt: string,
  intent: Omit<MissionIntent, "autonomyScope">,
): MissionIntent {
  const autonomyScope = deriveAutonomyScope(prompt, intent);
  if (intent.explicitMutation && isBroadUnscopedVaultMutation(autonomyScope)) {
    return {
      ...intent,
      noteOutput: false,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
      autonomyScope,
    };
  }

  return {
    ...intent,
    autonomyScope,
  };
}

function normalizeInvocationStepLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, Math.floor(value));
}

function suppressNoteWritebackForChatOnly(
  prompt: string,
  intent: MissionIntent,
): MissionIntent {
  return buildMissionIntent(prompt, {
    mode: intent.vaultContext ? "vault_context_answer" : "chat_only",
    vaultContext: intent.vaultContext,
    noteOutput: false,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
  });
}

function applyDefaultActiveNoteWriteback({
  prompt,
  missionIntent,
  toolContext,
  enableStreaming,
  forceChatOnly,
}: {
  prompt: string;
  missionIntent: MissionIntent;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  forceChatOnly: boolean;
}): MissionIntent {
  if (
    !shouldDefaultToActiveNoteWriteback({
      prompt,
      missionIntent,
      toolContext,
      enableStreaming,
      forceChatOnly,
    })
  ) {
    return missionIntent;
  }

  return buildMissionIntent(prompt, {
    ...missionIntent,
    mode: missionIntent.vaultContext ? "vault_context_answer" : "note_output",
    noteOutput: true,
    explicitPersistence: missionIntent.explicitPersistence,
    explicitMutation: missionIntent.explicitMutation,
    explicitDelete: false,
    allowAutonomousWrite: true,
    requireWriteCompletion: true,
  });
}

function shouldDefaultToActiveNoteWriteback({
  prompt,
  missionIntent,
  toolContext,
  enableStreaming,
  forceChatOnly,
}: {
  prompt: string;
  missionIntent: MissionIntent;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  forceChatOnly: boolean;
}): boolean {
  if (
    forceChatOnly ||
    hasChatOnlyResponseIntent(prompt) ||
    !enableStreaming ||
    toolContext.settings?.streamWritebackMode !==
      "all_current_note_content_writes" ||
    missionIntent.explicitDelete
  ) {
    return false;
  }

  const outputProfile = resolveOutputProfile(toolContext.settings);
  const hasActive = hasActiveCurrentMarkdownFile(toolContext);
  if (!hasActive) {
    if (outputProfile !== "active_or_new_note") {
      return false;
    }
    // Auto-create notes for plain content answers, not tool-first web/code/browser runs.
    if (
      hasWebSearchIntent(prompt) ||
      hasBrowserAutomationIntent(prompt) ||
      hasCodeExecutionIntent(prompt) ||
      hasOpenWebSourceIntent(prompt)
    ) {
      return false;
    }
  }

  if (
    hasPriorAssistantResponseWritebackIntent(prompt) ||
    hasResearchMemoryWriteIntent(prompt) ||
    hasTemplateIntent(prompt) ||
    hasDesignIntent(prompt) ||
    hasCodeExecutionIntent(prompt) ||
    hasWordCountIntent(prompt) ||
    hasHtmlPreviewIntent(prompt) ||
    hasOpenWebSourceIntent(prompt) ||
    hasBrowserAutomationIntent(prompt) ||
    hasExperienceMemoryIntent(prompt) ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    hasDeletePathIntent(prompt) ||
    hasTitleIntent(prompt) ||
    hasHighlightIntent(prompt) ||
    hasRestoreIntent(prompt) ||
    hasGraphLinkWriteIntent(prompt) ||
    hasSemanticIndexMaintenanceIntent(prompt)
  ) {
    return false;
  }

  if (hasExplicitNonCurrentNoteWriteTarget(prompt)) {
    return false;
  }

  if (missionIntent.explicitMutation && !missionIntent.noteOutput) {
    return false;
  }

  if (missionIntent.vaultContext || missionIntent.noteOutput) {
    return true;
  }

  return missionIntent.mode === "chat_only";
}

function applySafeReflexIntent({
  prompt,
  missionIntent,
  reflex,
}: {
  prompt: string;
  missionIntent: MissionIntent;
  reflex: ReflexDecision;
}): { missionIntent: MissionIntent; applied: boolean; reason: string } {
  if (
    !hasSafeReflexLabel(reflex, [
      "vault_search",
      "semantic_vault_search",
      "graph_context",
    ]) ||
    missionIntent.explicitMutation ||
    missionIntent.explicitDelete ||
    missionIntent.noteOutput
  ) {
    return { missionIntent, applied: false, reason: reflex.reason };
  }

  return {
    missionIntent: buildMissionIntent(prompt, {
      mode: "vault_context_answer",
      vaultContext: true,
      noteOutput: false,
      explicitPersistence: false,
      explicitMutation: false,
      explicitDelete: false,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
    }),
    applied: true,
    reason: `reflex_${reflex.label}_read_context`,
  };
}

function shouldFallbackGeneratedNoteOutputToChat(
  prompt: string,
  missionIntent: MissionIntent,
  toolContext: ToolExecutionContext,
  enableStreaming = true,
): boolean {
  if (!missionIntent.noteOutput || hasActiveCurrentMarkdownFile(toolContext)) {
    return false;
  }

  const outputProfile = resolveOutputProfile(toolContext.settings);
  const canLazyCreateNote =
    outputProfile === "active_or_new_note" &&
    enableStreaming &&
    toolContext.settings?.streamWritebackMode ===
      "all_current_note_content_writes";

  // Without a creatable note target, keep the legacy generated-append chat fallback.
  if (!canLazyCreateNote) {
    const generated = analyzeGeneratedOutputPrompt(prompt);
    return (
      generated.target === "current_note_append" &&
      !hasExplicitWritePersistenceIntent(prompt) &&
      !hasCurrentPageWritebackIntent(prompt) &&
      !hasPathTargetIntent(prompt)
    );
  }

  // Tool-first research without explicit note write stays in chat even when
  // active_or_new_note would otherwise create a note.
  if (
    (hasWebSearchIntent(prompt) ||
      hasBrowserAutomationIntent(prompt) ||
      hasCodeExecutionIntent(prompt) ||
      hasOpenWebSourceIntent(prompt)) &&
    !hasNoteOutputIntent(prompt) &&
    !hasCurrentPageWritebackIntent(prompt)
  ) {
    return true;
  }

  return false;
}

function resolveOutputProfile(
  settings: ToolExecutionContext["settings"] | undefined,
): OutputProfile {
  if (
    settings?.outputProfile === "active_or_new_note" ||
    settings?.outputProfile === "active_note_only" ||
    settings?.outputProfile === "chat_first"
  ) {
    return settings.outputProfile;
  }
  if (
    settings?.enableStreaming === false ||
    settings?.streamWritebackMode === "off"
  ) {
    return "chat_first";
  }
  return "active_or_new_note";
}

function buildMissionNoteOutputPlan(input: {
  prompt: string;
  missionIntent: MissionIntent;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  forceChatOnly: boolean;
}): NoteOutputPlan {
  const activeFile =
    input.toolContext.getCurrentMarkdownFile?.() ??
    input.toolContext.app?.workspace?.getActiveFile?.() ??
    null;
  const hasActive =
    Boolean(activeFile && (activeFile as { extension?: string }).extension === "md");
  const specialized =
    hasPriorAssistantResponseWritebackIntent(input.prompt) ||
    hasResearchMemoryWriteIntent(input.prompt) ||
    hasTemplateIntent(input.prompt) ||
    hasDesignIntent(input.prompt) ||
    hasCodeExecutionIntent(input.prompt) ||
    hasBrowserAutomationIntent(input.prompt) ||
    hasCreateFileIntent(input.prompt) ||
    hasCreateFolderIntent(input.prompt) ||
    hasMovePathIntent(input.prompt) ||
    hasDeleteIntent(input.prompt) ||
    hasDeletePathIntent(input.prompt) ||
    hasTitleIntent(input.prompt) ||
    hasHighlightIntent(input.prompt) ||
    hasRestoreIntent(input.prompt) ||
    hasGraphLinkWriteIntent(input.prompt) ||
    hasSemanticIndexMaintenanceIntent(input.prompt) ||
    hasExplicitNonCurrentNoteWriteTarget(input.prompt) ||
    ((hasWebSearchIntent(input.prompt) || hasOpenWebSourceIntent(input.prompt)) &&
      !hasCurrentPageWritebackIntent(input.prompt) &&
      !hasExplicitWritePersistenceIntent(input.prompt) &&
      !hasActive) ||
    input.missionIntent.explicitDelete ||
    (input.missionIntent.explicitMutation && !input.missionIntent.noteOutput);

  return resolveNoteOutputPlan({
    prompt: input.prompt,
    forceChatOnly: input.forceChatOnly,
    hasActiveMarkdownNote: hasActive,
    activeNoteIsPlaceholder: hasActive
      ? isPlaceholderNoteBasename(
          (activeFile as { basename?: string }).basename ?? "",
        )
      : true,
    outputProfile: resolveOutputProfile(input.toolContext.settings),
    enableStreaming: input.enableStreaming,
    streamWritebackMode:
      input.toolContext.settings?.streamWritebackMode ??
      "all_current_note_content_writes",
    autoTitleOnWrite: input.toolContext.settings?.autoTitleOnWrite !== false,
    specializedRoute: specialized,
    contentProducing: input.missionIntent.noteOutput
      ? true
      : input.missionIntent.vaultContext ||
          input.missionIntent.explicitDelete ||
          specialized
        ? false
        : undefined,
  });
}

function hasActiveCurrentMarkdownFile(
  toolContext: ToolExecutionContext,
): boolean {
  const resolved = toolContext.getCurrentMarkdownFile?.();
  if (resolved) {
    return true;
  }

  const workspace = (toolContext.app as { workspace?: {
    getActiveFile?: () => { extension?: string } | null;
  } } | undefined)?.workspace;
  return workspace?.getActiveFile?.()?.extension === "md";
}

function hasVaultContextQuestionIntent(prompt: string): boolean {
  return /\b(what\s+(did|do)\s+you\s+(learn|know|remember)\s+about\s+me|what\s+have\s+i\s+told\s+you|what\s+do\s+my\s+notes\s+say|based\s+on\s+my\s+notes|in\s+my\s+notes|across\s+my\s+notes|search\s+(my\s+)?notes|find\s+(notes?|details?|mentions?|references?)|where\s+did\s+i\s+mention|summari[sz]e\s+what\s+i\s+(know|have|wrote)|look\s+through\s+(my\s+)?vault|check\s+(my\s+)?folders?)\b/i.test(
    prompt,
  ) || hasFolderContentQuestionIntent(prompt) || hasGraphConnectionIntent(prompt);
}

function hasExplicitWritePersistenceIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert|copy|paste|put|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b[\s\S]{0,100}\b(note|file|markdown|vault|folder|directory|path|page|document)\b|\b(note|file|markdown|vault|folder|directory|path|page|document)\b[\s\S]{0,100}\b(append|save|write|update|add|insert|copy|paste|put|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b|\.md\b/i.test(
    prompt,
  );
}

function hasChatOnlyResponseIntent(prompt: string): boolean {
  return /\b(chat\s+only|only\s+in\s+chat|answer\s+in\s+chat|respond\s+in\s+chat|do\s+not\s+(?:write|append|save)\s+(?:to|in|into)\s+(?:the\s+)?(?:note|page|document|file))\b/i.test(
    prompt,
  );
}

function hasWordCountIntent(prompt: string): boolean {
  return /\b(word\s*count|count\s+(?:the\s+)?words?|how\s+many\s+words?|length\s+check|verify\s+(?:the\s+)?(?:word\s+)?length)\b/i.test(
    prompt,
  );
}

function hasGraphConnectionIntent(prompt: string): boolean {
  return /\b(graph|backlinks?|outgoing\s+links?|incoming\s+links?|related\s+notes?|semantic(?:ally)?\s+(?:related|connected)|connections?|connected|link(?:ed)?\s+notes?|note\s+relationships?|references?)\b/i.test(
    prompt,
  ) && /\b(note|notes|file|files|vault|current|this|active|markdown)\b/i.test(prompt);
}

function hasGraphLinkWriteIntent(prompt: string): boolean {
  return /\b(connect|link|add\s+(?:wiki\s+)?links?|insert\s+(?:wiki\s+)?links?|create\s+(?:wiki\s+)?links?)\b[\s\S]{0,100}\b(note|notes|current|this|active|markdown|file)\b|\b(note|notes|current|this|active|markdown|file)\b[\s\S]{0,100}\b(connect|link|add\s+(?:wiki\s+)?links?|insert\s+(?:wiki\s+)?links?|create\s+(?:wiki\s+)?links?)\b/i.test(
    prompt,
  );
}

function hasVaultIndexIntent(prompt: string): boolean {
  return /\b(index|map|overview|inventory|catalog|where\s+are|what\s+(notes|files|documents)|locate|find)\b[\s\S]{0,120}\b(vault|notes?|files?|documents?|folders?|markdown|notebook)\b|\b(vault|notes?|files?|documents?|folders?|markdown|notebook)\b[\s\S]{0,120}\b(index|map|overview|inventory|catalog|where|locate|find)\b/i.test(
    prompt,
  );
}

function hasOpenWebSourceIntent(prompt: string): boolean {
  return /\b(open|view|show|launch)\b[\s\S]{0,120}\b(source|sources|link|url|web|browser|reference|citation|page)\b|\b(source|sources|link|url|web\s+page|reference|citation|page)\b[\s\S]{0,120}\b(open|view|show|launch)\b/i.test(
    prompt,
  );
}

function hasCodeExecutionIntent(prompt: string): boolean {
  return /\b(run|execute|eval|evaluate|test|compile)\b[\s\S]{0,120}\b(code|script|program|snippet|python|javascript|typescript|html|css|c\+\+|cpp|c\s+code)\b|\b(code|script|program|snippet|python|javascript|typescript|html|css|c\+\+|cpp|c\s+code)\b[\s\S]{0,120}\b(run|execute|eval|evaluate|test|compile)\b/i.test(
    prompt,
  );
}

function hasHtmlPreviewIntent(prompt: string): boolean {
  return /\b(preview|render|show)\b[\s\S]{0,100}\b(html|css|web\s+page|mockup|prototype)\b|\b(html|css|web\s+page|mockup|prototype)\b[\s\S]{0,100}\b(preview|render|show)\b/i.test(
    prompt,
  );
}

function hasDesignIntent(prompt: string): boolean {
  return (
    /\b(create|make|draw|generate|build|draft|render|save|write|map|package|update|revise|edit|change|modify|improve|tweak|fix|adjust)\b[\s\S]{0,160}\b(canvas|design|design\s*package|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flows?|ui\s*flows?|architecture|system\s+design|software\s+architecture|service\s*blueprint|logistics\s*system|project\s*ideation|mind\s*map)\b|\b(canvas|design|design\s*package|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flows?|ui\s*flows?|architecture|system\s+design|software\s+architecture|service\s*blueprint|logistics\s*system|project\s*ideation|mind\s*map)\b[\s\S]{0,160}\b(create|make|draw|generate|build|draft|render|save|write|map|package|update|revise|edit|change|modify|improve|tweak|fix|adjust)\b/i.test(
      prompt,
    )
  );
}

function hasDesignPackageIntent(prompt: string): boolean {
  return /\b(design\s*package|service\s*blueprint|logistics\s*system|project\s*ideation|canvas\s+plus\s+(brief|markdown)|brief\s+plus\s+canvas|ui\s*flow|mind\s*map)\b/i.test(
    prompt,
  );
}

function hasCanvasDesignIntent(prompt: string): boolean {
  return (
    /\b(canvas|mind\s*map|concept\s*map|flowchart|workflow|user\s*flows?|ui\s*flows?|process\s*map|research\s*map|architecture\s*diagram|software\s+architecture|system\s+design|dependency\s*map|visual\s*map|diagram)\b/i.test(
      prompt,
    ) ||
    (hasDesignIntent(prompt) && !hasSvgDesignIntent(prompt))
  );
}

function hasSvgDesignIntent(prompt: string): boolean {
  return /\b(svg|wireframe|mockup|screen|layout|ui\s+design|static\s+diagram|sketch)\b/i.test(
    prompt,
  );
}

function hasBrowserAutomationIntent(prompt: string): boolean {
  return /\b(browser|web\s*acting|open\s+(?:the\s+)?page|open\s+(?:a\s+)?url|navigate|click|scroll|type\s+into|keypress|screenshot|extract\s+markdown|page\s+to\s+markdown|learn\s+(?:this\s+)?(?:page|site|workflow|game)|flash\s+game|swf)\b/i.test(
    prompt,
  );
}

function hasExperienceMemoryIntent(prompt: string): boolean {
  return /\b(experience\s+memory|episodic\s+memory|semantic\s+memory|procedural\s+memory|source\s+memory|memory\s+search|memory\s+write|store\s+(?:an?\s+)?memory|remember\s+this|learned\s+strategy)\b/i.test(
    prompt,
  );
}

function hasLongResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|long\s+research|in-depth\s+research|deep\s+dive|investigate|compare\s+sources|multi[-\s]?source|strategy|broad\s+constraints|evidence\s+ledger|checkpoint|long[-\s]?running)\b/i.test(
    prompt,
  );
}

function hasTemplateIntent(prompt: string): boolean {
  return /\b(template|templates|templated|form|boilerplate|reusable\s+(?:note|markdown|outline|format|structure)|fill\s+(?:this|the)?\s*(?:out\s+)?(?:form|template)|populate\s+(?:this|the)?\s*(?:form|template))\b/i.test(
    prompt,
  );
}

function hasTemplateCreateIntent(prompt: string): boolean {
  return (
    /\b(create|new|make|save)\b[\s\S]{0,100}\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b|\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b[\s\S]{0,100}\b(create|new|make|save)\b/i.test(
      prompt,
    ) && !hasCreateNoteFromTemplateIntent(prompt)
  );
}

function hasTemplateSeedIntent(prompt: string): boolean {
  return /\b(seed|install|create|make|add)\b[\s\S]{0,120}\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b|\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b[\s\S]{0,120}\b(seed|install|create|make|add)\b/i.test(
    prompt,
  );
}

function hasTemplateFillIntent(prompt: string): boolean {
  return /\b(fill|use|apply|complete|populate|render)\b[\s\S]{0,100}\b(template|form|boilerplate)\b|\b(template|form|boilerplate)\b[\s\S]{0,100}\b(fill|use|apply|complete|populate|render)\b|\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b[\s\S]{0,80}\bfrom\b[\s\S]{0,80}\btemplate\b|\bfrom\b[\s\S]{0,80}\btemplate\b[\s\S]{0,80}\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b/i.test(
    prompt,
  );
}

function hasCreateNoteFromTemplateIntent(prompt: string): boolean {
  return /\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b[\s\S]{0,100}\bfrom\b[\s\S]{0,80}\btemplate\b|\btemplate\b[\s\S]{0,100}\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b/i.test(
    prompt,
  );
}

function hasCheckpointResumeIntent(prompt: string): boolean {
  return hasMissionResumeIntent(prompt);
}

function hasCurrentNoteReadIntent(prompt: string): boolean {
  return (
    isPromptOnCurrentPageIntent(prompt) ||
    /\b(current|this|active)\s+(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,40}\b(current|this|active)\b|\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b[\s\S]{0,80}\b(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,80}\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b/i.test(
      prompt,
    )
  );
}

function hasGeneratedWritingIntent(prompt: string): boolean {
  return /\b(write|draft|compose|generate|create)\b[\s\S]{0,100}\b(essay|article|paragraph|summary|brief|outline|report|analysis|response|answer|markdown|content|write[-\s]?up)\b|\b(essay|article|paragraph|summary|brief|outline|report|analysis|response|answer|markdown|content|write[-\s]?up)\b[\s\S]{0,100}\b(write|draft|compose|generate|create)\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,80}\b\d{1,5}\s*words?\b/i.test(
    prompt,
  );
}

function hasCurrentPageWritebackIntent(prompt: string): boolean {
  return (
    /\b(stream|write|append|save|add|insert|put|record)\b[\s\S]{0,120}\b(?:onto|to|into|in|on)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i.test(
      prompt,
    ) ||
    /\b(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,120}\b(stream|write|append|save|add|insert|put|record)\b/i.test(
      prompt,
    )
  );
}

function hasExplicitStreamToCurrentNoteIntent(prompt: string): boolean {
  return (
    /\bstream(?:ing)?\b[\s\S]{0,120}\b(?:onto|to|into|in|on)\s+(?:this|the|current|active)?\s*(?:page|note|document|file)\b/i.test(
      prompt,
    ) ||
    /\b(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,120}\bstream(?:ing)?\b/i.test(
      prompt,
    )
  );
}

function hasCurrentNoteSectionTarget(prompt: string): boolean {
  return /\b(?:below|under|after|beneath|inside)\b[\s\S]{0,100}\b(?:section|heading)\b|\b(?:section|heading)\b[\s\S]{0,100}\b(?:below|under|after|beneath|inside)\b/i.test(
    prompt,
  );
}

function hasSectionAppendIntent(prompt: string): boolean {
  return (
    hasCurrentNoteSectionTarget(prompt) &&
    /\b(write|draft|compose|generate|append|add|insert|put)\b/i.test(prompt)
  );
}

function hasResearchMemoryIntent(prompt: string): boolean {
  return (
    hasResearchMemoryReadIntent(prompt) ||
    hasResearchMemoryWriteIntent(prompt) ||
    hasResearchMemoryReviewIntent(prompt) ||
    hasResearchMemoryCompactIntent(prompt) ||
    hasResearchMemoryDeleteIntent(prompt)
  );
}

function hasResearchMemoryReadIntent(prompt: string): boolean {
  return /\b(research\s+memory|topic\s+memory|memory|remember|recall|long[-\s]?term|continue\s+(?:this|the)\s+research|build\s+on\s+(?:this|the)\s+research)\b/i.test(
    prompt,
  );
}

function hasResearchMemoryWriteIntent(prompt: string): boolean {
  return /\b(save|store|remember|record|persist|append|add|update)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory|long[-\s]?term|research\s+topic)\b|\b(research\s+memory|topic\s+memory|memory|long[-\s]?term|research\s+topic)\b[\s\S]{0,120}\b(save|store|remember|record|persist|append|add|update)\b/i.test(
    prompt,
  );
}

function hasResearchMemoryReviewIntent(prompt: string): boolean {
  return /\b(review|audit|inspect|check|hygiene|duplicates?|stale|clean(?:up)?)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory)\b|\b(research\s+memory|topic\s+memory|memory)\b[\s\S]{0,120}\b(review|audit|inspect|check|hygiene|duplicates?|stale|clean(?:up)?)\b/i.test(
    prompt,
  );
}

function hasResearchMemoryCompactIntent(prompt: string): boolean {
  return /\b(compact|compress|summari[sz]e|dedupe|merge|clean(?:up)?)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory)\b|\b(research\s+memory|topic\s+memory|memory)\b[\s\S]{0,120}\b(compact|compress|summari[sz]e|dedupe|merge|clean(?:up)?)\b/i.test(
    prompt,
  );
}

function hasResearchMemoryDeleteIntent(prompt: string): boolean {
  return /\b(delete|remove|trash)\b[\s\S]{0,120}\b(research\s+memory|topic\s+memory|memory)\b|\b(research\s+memory|topic\s+memory|memory)\b[\s\S]{0,120}\b(delete|remove|trash)\b/i.test(
    prompt,
  );
}

function hasNamedFolderTraversalIntent(prompt: string): boolean {
  return (
    /\b(traverse|inspect|browse|read|look\s+through|check|summari[sz]e)\b[\s\S]{0,120}\bfolders?\b/i.test(
      prompt,
    ) &&
    /\bfolders?\b[\s\S]{0,100}\b(?:named|called)\b/i.test(prompt)
  );
}

function extractNamedVaultFolders(prompt: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bfolders?\s+(?:are\s+)?(?:named|called)\s+([^.\n]+)/gi,
    /\bthey\s+(?:are\s+)?(?:named|called)\s+([^.\n]+)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const rawList = match[1] ?? "";
      for (const raw of rawList.split(/\s*,\s*|\s+\band\s+/i)) {
        const name = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
        if (name) {
          names.add(name);
        }
      }
    }
  }

  return [...names];
}

function buildVaultPrefetchArgs(prompt: string): Record<string, unknown> {
  const targetFolders = extractNamedVaultFolders(prompt);
  if (targetFolders.length > 0) {
    return {
      scope: "all_vault",
      targetFolders,
    };
  }

  return { scope: "other_folders" };
}

function hasVaultBrowseIntent(prompt: string): boolean {
  return /\b(vault|files|file names|filenames|markdown files|md files|folders|folder|directory|directories|path|paths|list|browse|inspect|where\s+this\s+note\s+belongs|placement|organize\s+(?:the\s+)?vault|across\s+files)\b/i.test(
    prompt,
  );
}

function hasFolderContentQuestionIntent(prompt: string): boolean {
  return (
    hasNamedFolderTraversalIntent(prompt) ||
    /\b(other|all|nearby|related|vault|my)\s+(folders?|notes?|files?)\b/i.test(
      prompt,
    ) ||
    /\b(folders?|vault)\b[\s\S]{0,100}\b(say|says|contain|contains|details?|contents?|report\s+back|gather|browse|locate|summari[sz]e|tell\s+me)\b/i.test(
      prompt,
    ) ||
    /\b(gather|collect|read|inspect|look\s+through|browse|check|summari[sz]e|report)\b[\s\S]{0,140}\b(other\s+)?(folders?|vault|my\s+notes|notes?\s+in\s+(?:the\s+)?other\s+folders?|files?\s+in\s+(?:the\s+)?other\s+folders?)\b/i.test(
      prompt,
    )
  );
}

function hasSpecificFileReadIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(file named|note named|named file|named note|specific file|existing file|vault file)\b/i.test(
    prompt,
  );
}

function hasCreateFileIntent(prompt: string): boolean {
  if (!/\b(create|creating|new|make)\b/i.test(prompt)) {
    return false;
  }

  if (hasStaticGenerationIntent(prompt) && !/\b(file|note|vault|path)\b|\.md\b/i.test(prompt)) {
    return false;
  }

  return /\b(create|creating|new|make)\b[\s\S]{0,100}\b(note|file|md|vault)\b|\b(note|file|md|vault)\b[\s\S]{0,100}\b(create|creating|new|make)\b|\.md\b/i.test(
    prompt,
  );
}

function hasCreateFolderIntent(prompt: string): boolean {
  return /\b(create|creating|new|make)\b[\s\S]{0,100}\b(folder|directory)\b|\b(folder|directory)\b[\s\S]{0,100}\b(create|creating|new|make)\b/i.test(
    prompt,
  );
}

function hasPathTargetIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(path|folder|folders|directory|directories|vault file|vault folder|file named|note named|named file|named note|another file|specific file|existing file)\b/i.test(
    prompt,
  );
}

function hasResearchPackIntent(prompt: string): boolean {
  return /\b(create|make|build|generate|save)\b[\s\S]{0,120}\b(research\s+pack|research\s+brief|sources?\s+index|synthesis\s+pack|transactional\s+pack)\b|\b(research\s+pack|research\s+brief|sources?\s+index|synthesis\s+pack|transactional\s+pack)\b[\s\S]{0,120}\b(create|make|build|generate|save)\b/i.test(
    prompt,
  );
}

function hasExplicitNonCurrentPathTarget(prompt: string): boolean {
  return (
    !hasCurrentNoteTarget(prompt) &&
    /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(vault file|vault folder|file named|note named|named file|named note|another file|specific file|existing file)\b/i.test(
      prompt,
    )
  );
}

function hasExplicitNonCurrentNoteWriteTarget(prompt: string): boolean {
  return (
    hasExplicitNonCurrentPathTarget(prompt) &&
    (hasAppendIntent(prompt) ||
      hasReplaceIntent(prompt) ||
      hasCreateFileIntent(prompt) ||
      hasCreateFolderIntent(prompt) ||
      hasMovePathIntent(prompt) ||
      hasDeletePathIntent(prompt))
  );
}

function hasCurrentNoteTarget(prompt: string): boolean {
  return /\b(current|this|active)\s+(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,40}\b(current|this|active)\b/i.test(
    prompt,
  );
}

function hasNoteOutputIntent(prompt: string): boolean {
  if (hasChatOnlyResponseIntent(prompt)) {
    return false;
  }

  const generated = analyzeGeneratedOutputPrompt(prompt);
  if (
    generated.target === "current_note_append" ||
    generated.target === "current_note_replace"
  ) {
    return true;
  }

  if (
    hasAppendIntent(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasTitleIntent(prompt) ||
    hasHighlightIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasSectionAppendIntent(prompt) ||
    hasResearchMemoryWriteIntent(prompt) ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    hasDeletePathIntent(prompt)
  ) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt) && !hasFetchedWebSourceIntent(prompt)) {
    return false;
  }

  return /\b(research|investigate|analy[sz]e|synthesi[sz]e|summari[sz]e|summary|outline|brief|report|literature\s+review|field\s+notes?|meeting\s+notes?|findings|digest|recap|write[-\s]?up|cited\s+sources?|citations?)\b/i.test(
    prompt,
  );
}

function hasAppendIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,80}\b(note|file|markdown|vault|page|document)\b|\b(note|file|markdown|vault|page|document)\b[\s\S]{0,80}\b(append|save|write|update|add|insert|copy|paste|put)\b|\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,120}\.md\b/i.test(
    prompt,
  );
}

function hasReplaceIntent(prompt: string): boolean {
  return (
    isCurrentNoteReplaceResetPrompt(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\breplace\s+(?:the\s+)?existing\s+contents?\b/i.test(
      prompt,
    ) || hasClearPageAndWriteIntent(prompt)
  );
}

function hasWholeNoteReplaceIntent(prompt: string): boolean {
  if (
    isCurrentNoteReplaceResetPrompt(prompt) ||
    hasWholeNoteRevisionIntent(prompt)
  ) {
    return true;
  }

  if (!hasReplaceIntent(prompt)) {
    return false;
  }

  return (
    hasClearPageAndWriteIntent(prompt) ||
    /\b(rewrite|replace|reset|overwrite|clean\s+up|start\s+(?:fresh|cleanly)|edit\s+over)\b[\s\S]{0,100}\b(current|this|active|whole|entire|existing)\s+(note|file|markdown|document|page|content|contents)\b|\b(current|this|active|whole|entire|existing)\s+(note|file|markdown|document|page|content|contents)\b[\s\S]{0,100}\b(rewrite|replace|reset|overwrite|clean\s+up|start\s+(?:fresh|cleanly)|edit\s+over)\b/i.test(
      prompt,
    )
  );
}

function hasClearPageAndWriteIntent(prompt: string): boolean {
  return /\b(clear|delete|remove)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,180}\b(?:after|then)\b[\s\S]{0,120}\b(clear|delete|remove)\s+all\s+(?:the\s+)?(?:notes?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)\s+(?:page|note|document|file)\b/i.test(
    prompt,
  );
}

function hasWholeNoteRevisionIntent(prompt: string): boolean {
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }

  if (
    isWholeNoteEditIntent(prompt) ||
    isCurrentNoteEditOrganizeIntent(prompt)
  ) {
    return true;
  }

  const sectionTarget =
    /\b(section|heading)\b/i.test(prompt) &&
    !/\b(essay|draft|article|paragraphs?|body|content|document)\b/i.test(
      prompt,
    );
  if (sectionTarget) {
    return false;
  }

  const revisionVerb =
    /\b(edit(?:ing)?|revise|revising|revision|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail)\b/i;
  const wholeTextTarget =
    /\b(essay|draft|article|paragraphs?|body|content|document)\b|\b(?:whole|entire|current|this|active)\s+(?:note|page|file|markdown)\b|\b(?:note|page|file|markdown)\b[\s\S]{0,40}\b(?:whole|entire|current|this|active)\b/i;
  const updateVerb = /\b(update|updating)\b/i;

  return (
    revisionVerb.test(prompt) && wholeTextTarget.test(prompt)
  ) || (
    updateVerb.test(prompt) &&
    /\b(essay|draft|article|paragraphs?|body|content|document)\b|\b(?:whole|entire)\s+(?:note|page|file|markdown)\b/i.test(
      prompt,
    )
  );
}

function hasEditIntent(prompt: string): boolean {
  return isNamedSectionEditIntent(prompt);
}

function hasDeleteIntent(prompt: string): boolean {
  if (isCurrentNoteReplaceResetPrompt(prompt)) {
    return false;
  }

  return /\b(delete|remove|trash)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:current|this|active|whole|entire)\s+(?:note|file)\b[\s\S]{0,80}\b(delete|remove|trash)\b/i.test(
    prompt,
  );
}

function hasDeletePathIntent(prompt: string): boolean {
  if (isCurrentNoteReplaceResetPrompt(prompt)) {
    return false;
  }

  return /\b(delete|remove|trash)\b/i.test(prompt) && hasPathTargetIntent(prompt);
}

function hasMovePathIntent(prompt: string): boolean {
  const explicitPathSyntax =
    /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(path|folder|directory|vault\s+(?:file|folder)|file\s+named|note\s+named|named\s+(?:file|note))\b/i.test(
      prompt,
    );
  if (
    isVisibleTitleRenameIntent(prompt) &&
    hasCurrentNoteTarget(prompt) &&
    !/\b(move|relocate)\b/i.test(prompt) &&
    !explicitPathSyntax
  ) {
    return false;
  }

  const explicitRelocation =
    /\b(move|relocate)\b[\s\S]{0,100}\b(path|file|folder|note|vault|\.md)\b|\b(path|file|folder|note|vault|\.md)\b[\s\S]{0,100}\b(move|relocate)\b/i.test(
      prompt,
    );
  if (explicitRelocation) {
    return true;
  }

  const renamePath =
    /\brename\b[\s\S]{0,100}\b(path|file|folder|note|vault|\.md)\b|\b(path|file|folder|note|vault|\.md)\b[\s\S]{0,100}\brename\b/i.test(
      prompt,
    );
  if (!renamePath) {
    return false;
  }

  // Renaming the visible title of the active note is owned by
  // rename_current_file. Do not also create a generic move_path obligation
  // merely because the phrase "rename the current note" contains "note".
  if (
    isVisibleTitleRenameIntent(prompt) &&
    hasCurrentNoteTarget(prompt) &&
    !explicitPathSyntax
  ) {
    return false;
  }

  return true;
}

function hasWebSearchIntent(prompt: string): boolean {
  if (hasSimpleDateTimePrompt(prompt)) {
    return false;
  }

  if (hasPriorAssistantResponseWritebackIntent(prompt)) {
    return false;
  }

  if (hasTitleOnlyIntent(prompt)) {
    return false;
  }

  if (hasHighlightIntent(prompt)) {
    return false;
  }

  if (/\b(search|use|check|consult)\s+(?:the\s+)?web\b/i.test(prompt)) {
    return true;
  }

  if (hasCurrentWebFactIntent(prompt)) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt) && !hasFetchedWebSourceIntent(prompt)) {
    return false;
  }

  if (hasFolderContentQuestionIntent(prompt)) {
    return false;
  }

  if (hasExplicitWebSearchIntent(prompt) || hasDeepResearchIntent(prompt)) {
    return true;
  }

  return /\b(research|investigate|find|gather)\b/i.test(prompt);
}

function hasFetchedWebSourceIntent(prompt: string): boolean {
  return /\b(cited\s+sources?|cite\s+sources?|citations?|source\s+urls?|bibliography|reference\s+list|verified\s+sources?|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?))\b/i.test(
    prompt,
  );
}

function hasCurrentWebFactIntent(prompt: string): boolean {
  return /\b(?:latest|recent|current|up[-\s]?to[-\s]?date)\b[\s\S]{0,100}\b(?:events?|news|information|info|data|facts?|research|reports?|papers?|studies?|market|markets?|industry|industries|trends?|prices?|rates?|status|versions?|law|policy|policies)\b/i.test(
    prompt,
  );
}

function hasDeepResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|in[-\s]?depth(?:\s+(?:research|analysis|investigation|report))?|deep\s+dive|thorough\s+research|comprehensive\s+research|serious\s+research)\b/i.test(
    prompt,
  );
}

function hasExplicitWebSearchIntent(prompt: string): boolean {
  return /\b(web|internet|online|search|look\s+up|browse|sources?|citations?|cited|cite|news|up[-\s]?to[-\s]?date|verify|fact[-\s]?check)\b|\b(?:latest|recent|current)\b[\s\S]{0,60}\b(events?|news|information|info|version|versions?|prices?|rates?|status|facts?|research|reports?|papers?|studies?)\b/i.test(
    prompt,
  );
}

function hasSimpleDateTimePrompt(prompt: string): boolean {
  return /^\s*(?:(?:what(?:'s| is)?|tell me|give me|show me)\s+)?(?:today'?s\s+)?(?:current\s+)?(?:date|time|day)(?:\s+(?:today|now|right now))?\??\s*$/i.test(
    prompt,
  ) || /^\s*what\s+(?:date|time|day)\s+is\s+it(?:\s+(?:today|now|right now))?\??\s*$/i.test(
    prompt,
  );
}

function hasAmbiguousDatePrompt(prompt: string): boolean {
  if (!/\b(day|days|date|before|after|from)\b/i.test(prompt)) {
    return false;
  }

  const hasMonthDay =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i.test(
      prompt,
    );
  const hasNumericDate = /\b\d{1,2}[/-]\d{1,2}\b/.test(prompt);
  const hasYear = /\b(?:19|20)\d{2}\b/.test(prompt);

  return (hasMonthDay || hasNumericDate) && !hasYear;
}

function hasStaticGenerationIntent(prompt: string): boolean {
  return /\b(generate|write|draft|compose|create)\b[\s\S]{0,80}\b(essay|article|paragraph|summary|brief|outline|report|note|content|post)\b|\b(essay|article|paragraph|summary|brief|outline|report)\b[\s\S]{0,80}\b\d+\s*words?\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,80}\b\d{1,5}\s*words?\b/i.test(
    prompt,
  );
}

function hasTitleIntent(prompt: string): boolean {
  return isMarkdownTitleContentIntent(prompt) || isVisibleTitleRenameIntent(prompt);
}

function hasMarkdownTitleContentIntent(prompt: string): boolean {
  return isMarkdownTitleContentIntent(prompt);
}

function hasHighlightIntent(prompt: string): boolean {
  return /\b(find|search|locate|show)\b[\s\S]{0,120}\b(highlight|mark)\b|\b(highlight|mark)\b[\s\S]{0,120}\b(word|phrase|text|where|current\s+(?:note|file|page))\b/i.test(
    prompt,
  );
}

function hasRestoreIntent(prompt: string): boolean {
  return /\b(undo|restore|revert|rollback|roll\s+back)\b[\s\S]{0,140}\b(agent|last|previous|backup|current\s+(?:note|file|page)|this\s+(?:note|file|page))\b|\b(agent|last|previous|backup|current\s+(?:note|file|page)|this\s+(?:note|file|page))\b[\s\S]{0,140}\b(undo|restore|revert|rollback|roll\s+back)\b/i.test(
    prompt,
  );
}

function hasTitleOnlyIntent(prompt: string): boolean {
  return isTitleOnlyIntent(prompt);
}

function emitStatus(
  events: AgentRunEvents,
  message: string,
  phase?: AgentRunPhase,
) {
  events.onStatus?.(message);
  if (phase) {
    events.onPhaseChange?.(phase, message);
  }
}

function emitToolPreparationStatus(toolName: string, events: AgentRunEvents) {
  const message = getToolPreparationStatus(toolName);
  if (message) {
    events.onStatus?.(message);
  }
}

function getMilestoneStageForTool(
  toolName: string,
):
  | "gather"
  | "browser_observe"
  | "browser_act"
  | "synthesize"
  | "write_save"
  | "memory_reflection"
  | "verify" {
  if (
    toolName === "browser_observe" ||
    toolName === "browser_screenshot" ||
    toolName === "browser_extract_markdown"
  ) {
    return "browser_observe";
  }

  if (
    toolName === "browser_open_page" ||
    toolName === "browser_click" ||
    toolName === "browser_type" ||
    toolName === "browser_keypress" ||
    toolName === "browser_scroll"
  ) {
    return "browser_act";
  }

  if (
    MEMORY_TOOL_NAMES.has(toolName) ||
    toolName === "review_research_memory" ||
    toolName === "compact_research_memory" ||
    toolName === "delete_research_memory_entry"
  ) {
    return "memory_reflection";
  }

  if (isWriteToolName(toolName)) {
    return "write_save";
  }

  if (toolName === "count_words") {
    return "verify";
  }

  if (toolName === "render_html_preview" || toolName === "run_code_block") {
    return "synthesize";
  }

  return "gather";
}

function getToolPreparationStatus(toolName: string): string | null {
  if (toolName === "web_search") {
    return "Searching web...";
  }

  if (toolName === "web_fetch") {
    return "Fetching source page...";
  }

  if (toolName === "open_web_source") {
    return "Opening source and writing source note...";
  }

  if (toolName === "read_file") {
    return "Reading vault note...";
  }

  if (toolName === "inspect_vault_index") {
    return "Inspecting vault metadata index...";
  }

  if (toolName === "inspect_vault_context") {
    return "Inspecting vault folders and note contents...";
  }

  if (toolName === "count_words") {
    return "Counting note words...";
  }

  if (toolName === "get_note_graph_context") {
    return "Inspecting note graph context...";
  }

  if (toolName === "find_related_notes") {
    return "Finding related notes...";
  }

  if (toolName === "semantic_search_notes") {
    return "Searching notes semantically...";
  }

  if (toolName === "inspect_semantic_index") {
    return "Inspecting semantic vault index...";
  }

  if (toolName === "rebuild_semantic_index") {
    return "Rebuilding semantic vault index...";
  }

  if (toolName === "suggest_note_links") {
    return "Suggesting note links...";
  }

  if (toolName === "list_markdown_files") {
    return "Inspecting vault file list...";
  }

  if (toolName === "list_folder") {
    return "Inspecting vault folder...";
  }

  if (toolName === "get_path_info") {
    return "Inspecting vault path...";
  }

  if (toolName === "list_templates") {
    return "Listing templates...";
  }

  if (toolName === "read_template") {
    return "Reading template...";
  }

  if (toolName === "review_research_memory") {
    return "Reviewing research memory hygiene...";
  }

  if (toolName === "compact_research_memory") {
    return "Compacting research memory with backup...";
  }

  if (toolName === "delete_research_memory_entry") {
    return "Trashing research memory with backup...";
  }

  if (toolName === "seed_default_templates") {
    return "Creating default templates...";
  }

  if (toolName === "search_research_memory") {
    return "Searching research memory...";
  }

  if (toolName === "read_research_memory") {
    return "Reading research memory...";
  }

  if (toolName === "append_research_memory") {
    return "Saving research memory...";
  }

  if (toolName === "create_template") {
    return "Creating template...";
  }

  if (toolName === "fill_template") {
    return "Filling template...";
  }

  if (toolName === "create_research_pack") {
    return "Creating and verifying research pack...";
  }

  if (toolName === "create_folder") {
    return "Creating folder...";
  }

  if (toolName === "create_file") {
    return "Creating markdown file...";
  }

  if (toolName === "append_file") {
    return "Appending to vault file...";
  }

  if (toolName === "replace_file") {
    return "Replacing vault file with backup...";
  }

  if (toolName === "move_path") {
    return "Moving vault path...";
  }

  if (toolName === "delete_path") {
    return "Trashing vault path...";
  }

  if (toolName === "append_to_current_file") {
    return "Appending to note...";
  }

  if (toolName === "append_to_current_section") {
    return "Appending below note heading with backup...";
  }

  if (toolName === "retitle_current_file") {
    return "Retitling current note...";
  }

  if (toolName === "rename_current_file") {
    return "Renaming current note file...";
  }

  if (toolName === "highlight_current_file_phrase") {
    return "Highlighting phrase in current note...";
  }

  if (toolName === "restore_current_file_from_backup") {
    return "Restoring current note from backup...";
  }

  if (toolName === "prepare_edit_current_section") {
    return "Preparing current note section edit...";
  }

  if (toolName === "edit_current_section") {
    return "Editing current note section with backup...";
  }

  if (toolName === "replace_current_file") {
    return "Replacing current note with backup...";
  }

  if (toolName === "delete_current_file") {
    return "Deleting current note with backup...";
  }

  if (toolName === "link_related_notes_in_current_file") {
    return "Linking related notes...";
  }

  if (toolName === "run_code_block") {
    return "Running explicit code block...";
  }

  if (toolName === "render_html_preview") {
    return "Rendering HTML preview...";
  }

  if (toolName === "create_design_canvas") {
    return "Creating Obsidian canvas design...";
  }

  if (toolName === "create_design_package") {
    return "Creating design package...";
  }

  if (toolName === "create_svg_design") {
    return "Creating SVG design...";
  }

  if (toolName === "browser_open_page") {
    return "Opening visible companion browser page...";
  }

  if (toolName === "browser_observe") {
    return "Observing companion browser page...";
  }

  if (toolName === "browser_click") {
    return "Clicking in companion browser...";
  }

  if (toolName === "browser_type") {
    return "Typing in companion browser...";
  }

  if (toolName === "browser_keypress") {
    return "Sending browser keypress...";
  }

  if (toolName === "browser_scroll") {
    return "Scrolling companion browser...";
  }

  if (toolName === "browser_screenshot") {
    return "Capturing browser screenshot...";
  }

  if (toolName === "browser_extract_markdown") {
    return "Extracting page markdown...";
  }

  if (toolName === "memory_search") {
    return "Searching explicit experience memory...";
  }

  if (MEMORY_TOOL_NAMES.has(toolName)) {
    return "Writing explicit experience memory...";
  }

  return null;
}

function emitToolSuccessStatus(
  toolName: string,
  output: unknown,
  events: AgentRunEvents,
): string {
  if (toolName === "create_folder" && isRecord(output)) {
    const message = `Created folder ${String(output.path ?? "vault folder")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "create_file" && isRecord(output)) {
    const message = `Created file ${String(output.path ?? "vault file")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "append_file" && isRecord(output)) {
    const message = `Appended result to ${String(output.path ?? "vault file")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "replace_file" && isRecord(output)) {
    const message = `Replaced ${String(
      output.path ?? "vault file",
    )}; backup saved to ${String(output.backupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "move_path" && isRecord(output)) {
    const message = `Moved ${String(output.path ?? "vault path")} to ${String(
      output.toPath ?? "destination",
    )}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "delete_path" && isRecord(output)) {
    const message = `Trashed ${String(output.path ?? "vault path")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "restore_current_file_from_backup" && isRecord(output)) {
    const message = `Restored ${String(
      output.path ?? "current note",
    )} from ${String(output.restoredFromBackupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "inspect_vault_index" && isRecord(output)) {
    const count = getNumber(output.entryCount) ?? 0;
    const message = `Indexed ${count} vault entr${count === 1 ? "y" : "ies"} without reading note bodies.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "open_web_source" && isRecord(output)) {
    const message = `Saved source note ${String(output.path ?? "Agent Sources")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "run_code_block" && isRecord(output)) {
    const result = isRecord(output.result) ? output.result : isRecord(output.run) ? output.run : null;
    const exitCode = result ? getNumber(result.exitCode) : undefined;
    const timedOut = result ? Boolean(result.timedOut) : false;
    const message = timedOut
      ? `Code timed out for ${String(output.language ?? "snippet")}.`
      : exitCode === undefined
        ? `Code artifact prepared for ${String(output.language ?? "snippet")}.`
        : `Code finished with exit code ${exitCode}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "render_html_preview" && isRecord(output)) {
    const message = `Rendered HTML preview (${String(output.bytesRendered ?? "unknown")} bytes).`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "create_design_canvas" && isRecord(output)) {
    const message = `Created canvas ${String(output.path ?? "design")} with ${String(output.nodeCount ?? 0)} nodes and ${String(output.edgeCount ?? 0)} edges.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "create_design_package" && isRecord(output)) {
    const message = `Created design package ${String(output.briefPath ?? output.path ?? "brief")} with canvas ${String(output.canvasPath ?? "canvas")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "create_svg_design" && isRecord(output)) {
    const message = `Created SVG ${String(output.path ?? "design")} with ${String(output.shapeCount ?? 0)} shapes.`;
    events.onStatus?.(message);
    return message;
  }

  if (BROWSER_TOOL_NAMES.has(toolName) && isRecord(output)) {
    const message =
      output.status === "requires_approval"
        ? `Browser tool requires approval: ${String(output.reason ?? "safety policy")}.`
        : output.status === "blocked"
          ? `Browser tool blocked: ${String(output.reason ?? "safety policy")}.`
        : `Browser tool complete: ${toolName}.`;
    events.onStatus?.(message);
    return message;
  }

  if (MEMORY_TOOL_NAMES.has(toolName) && isRecord(output)) {
    const message =
      output.status === "blocked"
        ? `Memory tool blocked: ${String(output.reason ?? "settings or companion unavailable")}.`
        : `Memory tool complete: ${toolName}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "list_templates" && isRecord(output)) {
    const count = Array.isArray(output.templates) ? output.templates.length : 0;
    const message = `Found ${count} template${count === 1 ? "" : "s"}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "read_template" && isRecord(output)) {
    const message = `Read template ${String(output.path ?? "template")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "seed_default_templates" && isRecord(output)) {
    const created = Array.isArray(output.createdTemplates)
      ? output.createdTemplates.length
      : 0;
    const skipped = Array.isArray(output.skippedExisting)
      ? output.skippedExisting.length
      : 0;
    const message = `Created ${created} default template${created === 1 ? "" : "s"}${
      skipped > 0 ? `; skipped ${skipped} existing` : ""
    }.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "search_research_memory" && isRecord(output)) {
    const count = Array.isArray(output.matches) ? output.matches.length : 0;
    const message = `Found ${count} research memor${count === 1 ? "y" : "ies"}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "read_research_memory" && isRecord(output)) {
    const message = Boolean(output.found)
      ? `Read research memory ${String(output.path ?? "memory note")}.`
      : `No research memory found for ${String(output.topic ?? "that topic")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "append_research_memory" && isRecord(output)) {
    const message = Boolean(output.duplicate)
      ? `Research memory already had duplicate content at ${String(output.path ?? "memory note")}.`
      : `Saved research memory to ${String(output.path ?? "memory note")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "review_research_memory" && isRecord(output)) {
    const duplicateCount = Array.isArray(output.duplicates)
      ? output.duplicates.length
      : 0;
    const staleCount = Array.isArray(output.stale) ? output.stale.length : 0;
    const message = `Reviewed research memory: ${duplicateCount} duplicate group${duplicateCount === 1 ? "" : "s"}, ${staleCount} stale entr${staleCount === 1 ? "y" : "ies"}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "compact_research_memory" && isRecord(output)) {
    const message = `Compacted research memory ${String(output.path ?? "memory note")}; backup saved to ${String(output.backupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "delete_research_memory_entry" && isRecord(output)) {
    const message = `Trashed research memory ${String(output.path ?? "memory note")}; backup saved to ${String(output.backupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "create_template" && isRecord(output)) {
    const message = `Created template ${String(output.path ?? "template")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "fill_template" && isRecord(output)) {
    const message = `Created filled template note ${String(
      output.path ?? "vault note",
    )}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "create_research_pack" && isRecord(output)) {
    const createdCount = Array.isArray(output.createdPaths)
      ? output.createdPaths.length
      : 0;
    const message = `Created verified research pack ${String(
      output.path ?? "vault folder",
    )}${createdCount ? ` with ${createdCount} notes` : ""}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "append_to_current_file" && isRecord(output)) {
    const message = `Appended result to ${String(output.path ?? "current note")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "append_to_current_section" && isRecord(output)) {
    const message = `Appended below section ${String(
      output.heading ?? "target",
    )} in ${String(output.path ?? "current note")}; backup saved to ${String(
      output.backupPath ?? "backup",
    )}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "retitle_current_file" && isRecord(output)) {
    const message = `Updated note title in ${String(
      output.path ?? "current note",
    )}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "rename_current_file" && isRecord(output)) {
    const message = `Renamed current note from ${String(
      output.path ?? "current note",
    )} to ${String(output.toPath ?? "new title")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "highlight_current_file_phrase" && isRecord(output)) {
    const count = getNumber(output.matchCount) ?? 0;
    const message =
      count > 0
        ? `Highlighted ${count} match${count === 1 ? "" : "es"} in ${String(
            output.path ?? "current note",
          )}; backup saved to ${String(output.backupPath ?? "backup")}.`
        : `No matching phrase found in ${String(output.path ?? "current note")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "prepare_edit_current_section" && isRecord(output)) {
    const message = `Prepared section ${String(
      output.heading ?? "target",
    )} in ${String(output.path ?? "current note")}; backup saved to ${String(
      output.backupPath ?? "backup",
    )}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "edit_current_section" && isRecord(output)) {
    const message = `Edited section in ${String(
      output.path ?? "current note",
    )}; backup saved to ${String(output.backupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "replace_current_file" && isRecord(output)) {
    const message = `Replaced ${String(
      output.path ?? "current note",
    )}; backup saved to ${String(output.backupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "delete_current_file" && isRecord(output)) {
    const message = `Deleted ${String(
      output.path ?? "current note",
    )}; backup saved to ${String(output.backupPath ?? "backup")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "link_related_notes_in_current_file" && isRecord(output)) {
    const insertedCount = Array.isArray(output.insertedLinks)
      ? output.insertedLinks.length
      : 0;
    const message = `Linked ${insertedCount} related note${
      insertedCount === 1 ? "" : "s"
    } in ${String(output.path ?? "current note")}.`;
    events.onStatus?.(message);
    return message;
  }

  if (toolName === "web_search") {
    events.onStatus?.("Reading source results...");
  }

  if (toolName === "web_fetch") {
    events.onStatus?.("Source page fetched.");
  }

  const message = `Tool complete: ${toolName}`;
  events.onStatus?.(message);
  return message;
}

function buildReceiptFromToolExecution(
  toolName: string,
  result: ToolExecutionResult,
  descriptor: ToolDescriptor | null = null,
): AgentRunReceipt | null {
  if (result.receipt) {
    return canonicalActionReceiptToAgentRunReceipt(result.receipt, result.output);
  }
  const legacyReceipt = buildReceipt(toolName, result.output);
  if (legacyReceipt) {
    return descriptor
      ? {
          ...legacyReceipt,
          resource: buildDescriptorResourceRef(
            descriptor,
            result.output,
            legacyReceipt.path,
          ),
        }
      : legacyReceipt;
  }
  if (
    !descriptor ||
    descriptor.effect === "read" ||
    !descriptor.durability.receipt ||
    !isRecord(result.output) ||
    result.output.status === "requires_approval" ||
    result.output.status === "blocked"
  ) {
    return null;
  }
  const resource = buildDescriptorResourceRef(descriptor, result.output);
  return {
    toolName,
    operation: descriptor.capability.action,
    message: `${descriptor.capability.action} ${resource.id}`,
    resource,
    path: resource.system === "vault" ? resource.path : undefined,
    bytesWritten: getNumber(result.output.bytesWritten),
    bytesDeleted: getNumber(result.output.bytesDeleted),
    affectedCount: getNumber(result.output.affectedCount),
    output: result.output,
  };
}

function buildDescriptorResourceRef(
  descriptor: ToolDescriptor,
  output: unknown,
  fallbackPath?: string,
): ResourceRef {
  const record = isRecord(output) ? output : {};
  const path = getString(record.path) ?? fallbackPath;
  const id =
    getString(record.id) ??
    getString(record.identifier) ??
    getString(record.packageName) ??
    path ??
    `${descriptor.name}:result`;
  return {
    system: descriptor.capability.system,
    resourceType: descriptor.capability.resourceType,
    id,
    identifier: getString(record.identifier),
    path,
    url: getString(record.url),
    revision: getString(record.revision) ?? getString(record.updatedAt),
  };
}

function hasVaultWriteReceipt(receipts: AgentRunReceipt[]): boolean {
  return receipts.some((receipt) => {
    if (
      ["read", "list", "search", "validate"].includes(receipt.operation)
    ) {
      return false;
    }
    return receipt.resource
      ? receipt.resource.system === "vault"
      : Boolean(receipt.path);
  });
}

function sameAgentRunReceiptIdentity(
  left: AgentRunReceipt,
  right: AgentRunReceipt,
): boolean {
  if (left.id && right.id) {
    return left.id === right.id;
  }
  return (
    left.toolName === right.toolName &&
    left.operation === right.operation &&
    left.path === right.path &&
    left.toPath === right.toPath &&
    left.resource?.system === right.resource?.system &&
    left.resource?.id === right.resource?.id &&
    left.message === right.message
  );
}

function hasExternalActionReceipt(receipts: AgentRunReceipt[]): boolean {
  return receipts.some(
    (receipt) =>
      (receipt.resource?.system === "linear" ||
        receipt.resource?.system === "github") &&
      !["read", "list", "search"].includes(receipt.operation),
  );
}

function hasRequiredActionReceipt(
  plan: MissionPlan | null | undefined,
  receipts: AgentRunReceipt[],
): boolean {
  const proofKinds = new Set(
    plan?.tasks.flatMap((task) => task.completionContract.requiredProof) ?? [],
  );
  const requiresExternal = proofKinds.has("external_action_receipt");
  const vaultProofKinds: MissionPlanProofKind[] = [
    "write_receipt",
    "rename_receipt",
    "highlight_receipt",
  ];
  const requiresVault = vaultProofKinds.some((proof) => proofKinds.has(proof));
  if (requiresExternal && !hasExternalActionReceipt(receipts)) {
    return false;
  }
  if (requiresVault && !hasVaultWriteReceipt(receipts)) {
    return false;
  }
  if (requiresExternal || requiresVault) {
    return true;
  }
  return hasVaultWriteReceipt(receipts) || hasExternalActionReceipt(receipts);
}

function canonicalActionReceiptToAgentRunReceipt(
  receipt: ActionReceipt,
  output?: unknown,
): AgentRunReceipt {
  const outputRecord = isRecord(output) ? output : null;
  return {
    version: 1,
    id: receipt.id,
    toolName: receipt.toolName,
    operation: receipt.operation,
    message: receipt.message,
    actionId: receipt.actionId,
    resource: { ...receipt.resource },
    relatedResources: receipt.relatedResources?.map((resource) => ({
      ...resource,
    })),
    payloadFingerprint: receipt.payloadFingerprint,
    grantId: receipt.grantId,
    idempotencyKey: receipt.idempotencyKey,
    providerRequestId: receipt.providerRequestId,
    startedAt: receipt.startedAt,
    committedAt: receipt.committedAt,
    commitKind: receipt.commitKind,
    readback: { ...receipt.readback },
    effects: receipt.effects
      ? {
          ...receipt.effects,
          changedFields: receipt.effects.changedFields
            ? [...receipt.effects.changedFields]
            : undefined,
        }
      : undefined,
    path:
      receipt.resource.system === "vault"
        ? receipt.resource.path
        : typeof outputRecord?.path === "string"
          ? outputRecord.path
          : undefined,
    backupPath:
      typeof outputRecord?.backupPath === "string"
        ? outputRecord.backupPath
        : undefined,
    bytesWritten: receipt.effects?.bytesWritten,
    bytesDeleted: receipt.effects?.bytesDeleted,
    affectedCount: receipt.effects?.affectedCount,
    output,
  };
}

function buildReceipt(
  toolName: string,
  output: unknown,
): AgentRunReceipt | null {
  if (!isWriteToolName(toolName) || !isRecord(output)) {
    return null;
  }

  const path = getString(output.path);
  const toPath = getString(output.toPath);
  const backupPath = getString(output.backupPath);
  const restoredFromBackupPath = getString(output.restoredFromBackupPath);
  const bytesWritten = getNumber(output.bytesWritten);
  const bytesDeleted = getNumber(output.bytesDeleted);
  const affectedCount = getNumber(output.affectedCount);
  const matchCount = getNumber(output.matchCount);
  const operation = getReceiptOperation(toolName);
  const messageParts = [`${operation} ${path || "current note"}`];

  if (toPath) {
    messageParts.push(`to: ${toPath}`);
  }

  if (backupPath) {
    messageParts.push(`backup: ${backupPath}`);
  }

  if (restoredFromBackupPath) {
    messageParts.push(`restored_from: ${restoredFromBackupPath}`);
  }

  if (affectedCount !== undefined) {
    messageParts.push(`affected: ${affectedCount}`);
  }

  if (matchCount !== undefined) {
    messageParts.push(`matches: ${matchCount}`);
  }

  return {
    toolName,
    operation,
    path,
    toPath,
    backupPath,
    restoredFromBackupPath,
    bytesWritten,
    bytesDeleted,
    affectedCount: affectedCount ?? matchCount,
    output,
    message: messageParts.join("; "),
  };
}

function getReceiptOperation(toolName: string): AgentRunReceipt["operation"] {
  if (
    toolName === "open_web_source" ||
    toolName === "create_design_canvas" ||
    toolName === "create_svg_design" ||
    toolName === "create_design_package" ||
    toolName === "export_workspace_artifact" ||
    toolName === "seed_default_templates"
  ) {
    return "create";
  }

  if (
    toolName === "create_template" ||
    toolName === "fill_template" ||
    toolName === "create_research_pack"
  ) {
    return "create";
  }

  if (toolName === "create_folder") {
    return "create_folder";
  }

  if (toolName === "create_file") {
    return "create";
  }

  if (toolName === "append_file") {
    return "append";
  }

  if (toolName === "replace_file") {
    return "replace";
  }

  if (toolName === "move_path") {
    return "move";
  }

  if (toolName === "delete_path") {
    return "trash";
  }

  if (toolName === "append_to_current_file") {
    return "append";
  }

  if (toolName === "append_to_current_section") {
    return "append";
  }

  if (toolName === "append_research_memory") {
    return "append";
  }

  if (toolName === "compact_research_memory") {
    return "replace";
  }

  if (toolName === "delete_research_memory_entry") {
    return "trash";
  }

  if (toolName === "retitle_current_file") {
    return "retitle";
  }

  if (toolName === "rename_current_file") {
    return "rename_current_file";
  }

  if (toolName === "highlight_current_file_phrase") {
    return "highlight";
  }

  if (toolName === "restore_current_file_from_backup") {
    return "restore";
  }

  if (toolName === "edit_current_section") {
    return "edit";
  }

  if (toolName === "replace_current_file") {
    return "replace";
  }

  if (toolName === "delete_current_file") {
    return "delete";
  }

  if (toolName === "link_related_notes_in_current_file") {
    return "link_related_notes";
  }

  return "append";
}

function isWriteToolName(toolName: string): boolean {
  return (
    toolName === "create_folder" ||
    toolName === "open_web_source" ||
    toolName === "create_design_canvas" ||
    toolName === "create_svg_design" ||
    toolName === "create_design_package" ||
    toolName === "export_workspace_artifact" ||
    toolName === "seed_default_templates" ||
    toolName === "create_template" ||
    toolName === "fill_template" ||
    toolName === "create_research_pack" ||
    toolName === "create_file" ||
    toolName === "append_file" ||
    toolName === "replace_file" ||
    toolName === "move_path" ||
    toolName === "delete_path" ||
    toolName === "append_to_current_file" ||
    toolName === "append_to_current_section" ||
    toolName === "highlight_current_file_phrase" ||
    toolName === "restore_current_file_from_backup" ||
    toolName === "append_research_memory" ||
    toolName === "compact_research_memory" ||
    toolName === "delete_research_memory_entry" ||
    toolName === "rename_current_file" ||
    toolName === "retitle_current_file" ||
    toolName === "edit_current_section" ||
    toolName === "replace_current_file" ||
    toolName === "delete_current_file" ||
    toolName === "link_related_notes_in_current_file"
  );
}

function redactToolArguments(
  _toolName: string,
  args: Record<string, unknown>,
): unknown {
  const textFields = new Set([
    "text",
    "content",
    "summary",
    "templateText",
    "code",
    "html",
    "svg",
  ]);
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && textFields.has(key)) {
      output[key] = truncateForTrace(value, 600);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function truncateTracePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    return truncateForTrace(payload, 1000);
  }

  if (Array.isArray(payload)) {
    return payload.slice(0, 20).map((item) => truncateTracePayload(item));
  }

  if (!isRecord(payload)) {
    return payload;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      output[key] = truncateForTrace(value, 1000);
    } else if (Array.isArray(value)) {
      output[key] = value
        .slice(0, 20)
        .map((item) => truncateTracePayload(item));
    } else if (isRecord(value)) {
      output[key] = truncateTracePayload(value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function truncateForTrace(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated]`;
}

function truncateForPromptAnchor(text: string): string {
  return text.length <= 2000 ? text : `${text.slice(0, 2000)}\n[truncated]`;
}

function appendRelevancePromptContext(
  basePrompt: string,
  label: string,
  context: unknown,
): string {
  const serialized =
    typeof context === "string" ? context : (JSON.stringify(context) ?? "");
  const trimmed = serialized.trim();
  if (!trimmed) {
    return basePrompt;
  }

  return [basePrompt, `${label}: ${truncateForPromptAnchor(trimmed)}`]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function emitDirectAssistantAnswer(
  content: string,
  events: AgentRunEvents,
  requiresEnglishGuard = false,
) {
  const sanitized = sanitizeAssistantContent(content);
  if (!sanitized.trim()) {
    return;
  }
  if (requiresEnglishGuard) {
    assertEnglishOnlyVisibleOutput(sanitized, events);
  }

  emitStatus(events, "Drafting final answer...", "final_answer");
  events.onFinalStart?.();
  events.onAssistantMessageStart?.();
  events.onFinalDelta?.(sanitized);
  events.onAssistantDelta?.(sanitized);
  events.onFinalDone?.();
  events.onAssistantMessageDone?.();
}

function assertEnglishOnlyVisibleOutput(
  content: string,
  events: AgentRunEvents,
): void {
  const language = inspectEnglishOnlyOutput(content);
  if (language.ok) {
    return;
  }

  events.onStreamLifecycle?.({
    kind: "buffering_language",
    elapsedMs: 0,
    bufferedChars: content.length,
    message: "Language gate retrying English-only output...",
  });
  events.onStatus?.("Blocked non-English output before showing it.");
  throw new ModelClientError(
    "invalid_response",
    "Model produced non-English output.",
    {
      details: language,
    },
  );
}

function isEnglishOnlyGuardError(error: unknown): boolean {
  return (
    error instanceof ModelClientError &&
    error.category === "invalid_response" &&
    /non-English output|English-only guard/i.test(error.message)
  );
}

function emitLocalWriteSummary(
  events: AgentRunEvents,
  receipts: AgentRunReceipt[],
) {
  const message =
    receipts.length === 1
      ? `Done. ${receipts[0].message}.`
      : receipts.length > 1
        ? `Done. ${receipts.length} write operations completed.`
        : "Done. Write operation completed.";

  emitDirectAssistantAnswer(message, events);
}

async function streamCurrentNoteWriteback({
  kind,
  preparedSectionEdit,
  modelClient,
  messages,
  events,
  toolContext,
  knownToolNames,
  relevancePrompt,
  think,
  options,
  abortSignal,
  onThinkingUnsupported,
  onPartialReceipt,
  stagedContent,
  missionPrompt,
  lazyCreatePath,
  onNoteCreated,
}: {
  kind: StreamingWritebackKind;
  preparedSectionEdit: PreparedStreamingSectionEdit | null;
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  events: AgentRunEvents;
  toolContext: ToolExecutionContext;
  knownToolNames: Set<string>;
  relevancePrompt?: string;
  think?: ModelThink;
  options?: ModelRequestOptions;
  abortSignal?: AbortSignal;
  onThinkingUnsupported: () => void;
  onPartialReceipt?: (receipt: AgentRunReceipt) => void;
  /** Exact sanitized content that has already passed proof verification. */
  stagedContent?: string;
  missionPrompt?: string;
  lazyCreatePath?: string | null;
  onNoteCreated?: (file: { path: string; basename: string }) => void;
}): Promise<AgentRunReceipt> {
  const writer = await createStreamingNoteWriter({
    kind,
    toolContext,
    preparedSectionEdit,
    lazyCreatePath,
    onNoteCreated,
  });
  const activeBasename =
    toolContext.getCurrentMarkdownFile?.()?.basename ??
    toolContext.app.workspace.getActiveFile()?.basename ??
    (lazyCreatePath
      ? lazyCreatePath.replace(/^.*\//, "").replace(/\.md$/i, "")
      : undefined);
  const writebackPromptOptions = {
    missionPrompt: missionPrompt ?? toolContext.originalPrompt,
    activeBasename,
  };

  emitStatus(events, "Streaming writeback to note...", "final_answer");
  events.onFinalStart?.();
  events.onAssistantMessageStart?.();

  let response: ModelChatResponse | null = null;
  let emittedContent = "";

  const streamAttempt = async (
    retry: boolean,
  ): Promise<{
    response: ModelChatResponse;
    toolRequestDetected: boolean;
    content: string;
    wroteContent: boolean;
  }> => {
    const instruction = buildStreamingWritebackPrompt(
      kind,
      preparedSectionEdit,
      retry,
      writebackPromptOptions,
    );
    const streamRequest: ModelChatRequest = {
      messages: [
        ...messages,
        {
          role: "system" as const,
          content: instruction,
        },
      ],
      options,
      abortSignal,
    };
    const metricName = retry ? "stream_writeback_retry" : "stream_writeback";
    const requestChars = measureSerializedChars(streamRequest);
    const startedAt = nowMs();
    const lifecycle = createStreamLifecycleTracker(events, startedAt);
    const contentSanitizer = createAssistantContentSanitizer();
    const thinkingStream = createThinkingStream(events);
    const liveEmitter = createLiveWritebackEmitter({
      events,
      writer,
      knownToolNames,
      relevancePrompt,
      lifecycle,
    });
    let attemptContent = "";

    lifecycle.mark("stream_started", "Waiting for provider to send content...");
    emitModelCallTrace(events, {
      id: retry
        ? "model-call-stream-writeback-retry"
        : "model-call-stream-writeback",
      message: `Model stream: ${metricName}`,
      request: streamRequest,
    });

    try {
      const attemptResponse = await streamChatWithThinkingFallback({
        modelClient,
        request: streamRequest,
        events,
        streamEvents: {
          onRawChunk: () => {
            lifecycle.mark("stream_connected", "Connected to model stream.");
            lifecycle.mark(
              "first_raw_chunk",
              "Provider sent the first stream chunk.",
            );
          },
          onContentDelta: (delta) => {
            lifecycle.mark(
              "first_content_delta",
              "Received answer text; checking early output...",
            );
            const sanitized = contentSanitizer.push(delta);
            if (!sanitized) {
              return;
            }

            attemptContent += sanitized;
            liveEmitter.push(sanitized);
          },
          onThinkingDelta: (delta) => {
            lifecycle.mark(
              "first_thinking_delta",
              "Received thinking, waiting for answer text...",
            );
            thinkingStream.onDelta(delta);
          },
        },
        onThinkingUnsupported,
      });
      emitMetricEvent(events, {
        kind: "model_stream",
        name: metricName,
        durationMs: elapsedMs(startedAt),
        requestChars,
        responseChars: measureSerializedChars(attemptResponse.message),
        ...extractTokenUsageFields(attemptResponse.raw),
      });

      const trailingContent = contentSanitizer.flush();
      if (trailingContent) {
        attemptContent += trailingContent;
        liveEmitter.push(trailingContent);
      }

      thinkingStream.done();

      const sanitizedResponse = sanitizeAssistantContent(
        attemptResponse.message.content,
      );
      if (!attemptContent.trim() && sanitizedResponse.trim()) {
        attemptContent += sanitizedResponse;
        liveEmitter.push(sanitizedResponse);
      }

      const liveState = liveEmitter.finish();
      if (
        liveState.toolRequestDetected ||
        (!liveState.wroteContent &&
          containsRecoverableToolRequest(attemptContent, knownToolNames))
      ) {
        return {
          response: attemptResponse,
          toolRequestDetected: true,
          content: "",
          wroteContent: liveState.wroteContent,
        };
      }

      return {
        response: attemptResponse,
        toolRequestDetected: false,
        content: attemptContent,
        wroteContent: liveState.wroteContent,
      };
    } catch (error) {
      emitMetricEvent(events, {
        kind: "model_stream",
        name: metricName,
        durationMs: elapsedMs(startedAt),
        requestChars,
      });
      if (isInvalidResponseError(error)) {
        thinkingStream.done();
        throw error;
      }
      const trailingContent = contentSanitizer.flush();
      if (trailingContent) {
        attemptContent += trailingContent;
        liveEmitter.push(trailingContent);
      }

      thinkingStream.done();
      const liveState = liveEmitter.finish();
      if (liveState.wroteContent) {
        emittedContent += attemptContent;
      }
      throw error;
    }
  };

  try {
    if (stagedContent !== undefined) {
      if (!stagedContent.trim()) {
        throw new Error(EMPTY_STREAMING_WRITEBACK_MESSAGE);
      }
      emitStatus(events, "Committing verified writeback to note...", "final_answer");
      // No unverified draft was released, so the verified candidate is the
      // first visible content and should be emitted once as a normal delta.
      events.onFinalDelta?.(stagedContent);
      events.onAssistantDelta?.(stagedContent);
      writer.replaceContent(stagedContent);
      await writer.finish({ force: true });
      events.onFinalDone?.();
      events.onAssistantMessageDone?.();
      events.onStatus?.("Verified writeback complete.");
      return writer.buildReceipt(false);
    }

    let retryUsed = false;
    let attempt: Awaited<ReturnType<typeof streamAttempt>>;
    try {
      attempt = await streamAttempt(false);
    } catch (error) {
      if (!isEnglishOnlyGuardError(error) || writer.hasWritableContent()) {
        throw error;
      }

      events.onStatus?.(
        "Model produced non-English output; retrying English-only writeback...",
      );
      writer.discardNonWritableContent();
      retryUsed = true;
      attempt = await streamAttempt(true);
    }
    response = attempt.response;

    if (attempt.toolRequestDetected) {
      if (attempt.wroteContent) {
        throw new Error(
          "The model requested a tool after streamed writeback had started. Partial content may have been written.",
        );
      }
      events.onStatus?.(
        "Model requested a tool during writeback; retrying content-only output...",
      );
      writer.discardNonWritableContent();
      retryUsed = true;
      attempt = await streamAttempt(true);
      response = attempt.response;
    } else if (!attempt.content.trim()) {
      events.onStatus?.(
        "No writable content received; retrying content-only writeback...",
      );
      writer.discardNonWritableContent();
      retryUsed = true;
      attempt = await streamAttempt(true);
      response = attempt.response;
    }

    if (attempt.toolRequestDetected) {
      throw new Error(
        "The model requested a tool during streamed writeback instead of returning writable content. Nothing was written.",
      );
    }

    if (!attempt.content.trim()) {
      events.onStatus?.(EMPTY_STREAMING_WRITEBACK_MESSAGE);
      throw new Error(EMPTY_STREAMING_WRITEBACK_MESSAGE);
    }

    if (!retryUsed && hasUnclosedFence(attempt.content)) {
      events.onStatus?.(
        "Streamed writeback ended inside a fenced code block; retrying complete content...",
      );
      writer.replaceContent("");
      retryUsed = true;
      attempt = await streamAttempt(true);
      response = attempt.response;

      if (attempt.toolRequestDetected) {
        throw new Error(
          "The model requested a tool during streamed writeback instead of returning writable content. Nothing was written.",
        );
      }

      if (!attempt.content.trim()) {
        events.onStatus?.(EMPTY_STREAMING_WRITEBACK_MESSAGE);
        throw new Error(EMPTY_STREAMING_WRITEBACK_MESSAGE);
      }
    }

    const wordTarget = parseWritebackWordCountTargetFromMessages(messages);
    let correctionUsed = false;
    let contentToWrite = attempt.content;
    if (wordTarget) {
      const initialCount = countMarkdownVisibleText(contentToWrite).wordCount;
      if (!isWordCountWithinTarget(initialCount, wordTarget)) {
        events.onStatus?.(
          `Word count ${initialCount}/${wordTarget.target} outside target; requesting one correction pass...`,
        );
        const corrected = await requestWordCountCorrection({
          modelClient,
          messages,
          draft: contentToWrite,
          wordTarget,
          events,
          think,
          options,
          abortSignal,
          onThinkingUnsupported,
          metricName: "stream_writeback_word_count_correction",
        });
        if (corrected.trim()) {
          contentToWrite = corrected;
          writer.replaceContent(corrected);
          events.onFinalReplace?.(corrected);
          events.onAssistantReplace?.(corrected);
          correctionUsed = true;
        }
      }
    }

    emittedContent += contentToWrite;

    await writer.finish({ force: true });

    events.onFinalDone?.();
    events.onAssistantMessageDone?.();
    if (response) {
      messages.push(withoutThinking(response.message));
    }
    if (wordTarget) {
      const count = countMarkdownVisibleText(emittedContent).wordCount;
      events.onStatus?.(
        `Word count: ${count}/${wordTarget.target} (${isWordCountWithinTarget(count, wordTarget) ? "within target" : "outside target"}; correction=${correctionUsed ? "used" : "not used"}).`,
      );
    }
    events.onStatus?.("Streaming writeback complete.");
    return writer.buildReceipt(false);
  } catch (error) {
    await writer.finish();
    events.onFinalDone?.();
    events.onAssistantMessageDone?.();

    if (writer.hasWritableContent()) {
      const receipt = writer.buildReceipt(true);
      onPartialReceipt?.(receipt);
      events.onReceipt?.(receipt);
      events.onStatus?.(
        "Streaming writeback interrupted; partial content may have been written.",
      );
    }
    throw error;
  }
}

function buildStreamingWritebackPrompt(
  kind: StreamingWritebackKind,
  preparedSectionEdit: PreparedStreamingSectionEdit | null,
  retry = false,
  options: {
    missionPrompt?: string;
    activeBasename?: string;
  } = {},
): string {
  const retryPrefix = retry
    ? [
        "Previous stream failed the output contract or returned no writable markdown.",
        "Re-emit the FULL answer using the OUTPUT CONTRACT. First character must be #.",
      ]
    : [];

  if (kind === "edit") {
    return [
      ...retryPrefix,
      `Write the replacement markdown body for the section "${preparedSectionEdit?.heading ?? "target section"}" now.`,
      "Do not include the heading line itself.",
      "Use English unless the user explicitly requested another language in the current mission.",
      FINAL_ENGLISH_ONLY_RULE,
      "Return only the markdown body that belongs under that heading.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

  const basename = options.activeBasename?.trim() || "current note";
  const isPlaceholder = isPlaceholderNoteBasename(basename);
  const mission =
    typeof options.missionPrompt === "string" && options.missionPrompt.trim()
      ? truncateForPromptAnchor(options.missionPrompt)
      : "";
  const pluginBehavior = isPlaceholder
    ? [
        "PLUGIN BEHAVIOR (do not re-implement):",
        "- The plugin appends/replaces this markdown into the active note.",
        "- If the active note is a placeholder (Untitled / Untitled N), the plugin renames the file from your leading H1 after writeback.",
        "- Do not call rename_current_file, retitle_current_file, or any tool during this writeback turn.",
      ].join("\n")
    : [
        "PLUGIN BEHAVIOR (do not re-implement):",
        "- The plugin appends/replaces this markdown into the active note.",
        "- Do not rename the file; the note already has a real title.",
        "- Do not call rename_current_file, retitle_current_file, or any tool during this writeback turn.",
      ].join("\n");

  const actionLine =
    kind === "replace"
      ? "Write the full replacement markdown for the current note now."
      : "Write the markdown content to append to the current note now.";

  return [
    ...retryPrefix,
    actionLine,
    "OUTPUT CONTRACT (follow exactly):",
    "1. Line 1 MUST be exactly one Markdown H1: # <Title>",
    "2. Line 2 MUST be blank.",
    "3. Line 3+ is the note body only.",
    '4. Return ONLY that markdown. No preamble, no tool JSON, no receipts, no "here is", no thinking.',
    "TITLE RULES:",
    "- <Title> is a short human note title (about 3-8 words), derived from the user mission.",
    '- Do not use Untitled, Untitled N, or generic titles like "Notes" / "Response" / "Answer".',
    "- Do not put the title only as ## H2 or bold text; the first line must be # H1.",
    "- Do not repeat the same H1 later in the body.",
    pluginBehavior,
    `ACTIVE NOTE: ${basename}`,
    mission ? `USER MISSION: ${JSON.stringify(mission)}` : "",
    "GOOD:",
    "# Hello World in TypeScript",
    "",
    'console.log("Hello, world!");',
    "BAD:",
    "Here is the content:",
    "# Hello World in TypeScript",
    "BAD:",
    "## Hello World in TypeScript",
    "BAD:",
    '{"tool":"rename_current_file","title":"..."}',
    "Use English unless the user explicitly requested another language in the current mission.",
    FINAL_ENGLISH_ONLY_RULE,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Exported for unit tests of the Grok writeback contract. */
export function buildStreamingWritebackPromptForTests(
  kind: StreamingWritebackKind,
  options: {
    retry?: boolean;
    missionPrompt?: string;
    activeBasename?: string;
    preparedSectionEdit?: PreparedStreamingSectionEdit | null;
  } = {},
): string {
  return buildStreamingWritebackPrompt(
    kind,
    options.preparedSectionEdit ?? null,
    options.retry ?? false,
    {
      missionPrompt: options.missionPrompt,
      activeBasename: options.activeBasename,
    },
  );
}

function shouldEmitPlaceholderTitleWriteHint(input: {
  missionIntent: MissionIntent;
  streamingWritebackKind: StreamingWritebackKind | null;
  allowedToolNames: Set<string>;
  activeBasename?: string;
}): boolean {
  if (input.streamingWritebackKind !== null) {
    return false;
  }
  if (!input.missionIntent.noteOutput && !input.missionIntent.requireWriteCompletion) {
    return false;
  }
  const hasWriteTool =
    input.allowedToolNames.has("append_to_current_file") ||
    input.allowedToolNames.has("replace_current_file");
  if (!hasWriteTool) {
    return false;
  }
  return (
    !input.activeBasename ||
    isPlaceholderNoteBasename(input.activeBasename)
  );
}

interface WordCountTarget {
  target: number;
  exact: boolean;
  min: number;
  max: number;
}

function containsRecoverableToolRequest(
  content: string,
  knownToolNames: Set<string>,
): boolean {
  if (!content.trim()) {
    return false;
  }

  return (
    /<requested_tool_call\b/i.test(content) ||
    extractToolCallsFromAssistantText(content, knownToolNames).length > 0
  );
}

function createLiveWritebackEmitter({
  events,
  writer,
  knownToolNames,
  relevancePrompt,
  lifecycle,
}: {
  events: AgentRunEvents;
  writer: Awaited<ReturnType<typeof createStreamingNoteWriter>>;
  knownToolNames: Set<string>;
  relevancePrompt?: string;
  lifecycle: ReturnType<typeof createStreamLifecycleTracker>;
}) {
  let safetyBuffer = "";
  let live = false;
  let wroteContent = false;
  let toolRequestDetected = false;
  const relevanceGate = createFinalAnswerRelevanceGate(relevancePrompt, events);
  const englishGuard = isLikelyEnglishPrompt(relevancePrompt ?? "");

  const emit = (delta: string) => {
    if (!delta) {
      return;
    }

    const topicalDelta = relevanceGate.push(delta);
    if (!topicalDelta) {
      lifecycle.mark("buffering_safety", "Checking early output before writing...", {
        bufferedChars: delta.length,
      });
      return;
    }

    if (englishGuard) {
      assertEnglishOnlyVisibleOutput(topicalDelta, events);
    }

    wroteContent = true;
    lifecycle.mark("first_visible_content", "Showing safe answer text...", {
      releasedChars: topicalDelta.length,
    });
    lifecycle.mark("first_note_write", "Writing safe content to note...", {
      releasedChars: topicalDelta.length,
    });
    events.onFinalDelta?.(topicalDelta);
    events.onAssistantDelta?.(topicalDelta);
    writer.push(topicalDelta);
  };

  return {
    push(delta: string) {
      if (!delta || toolRequestDetected) {
        return;
      }

      if (live) {
        if (safetyBuffer) {
          safetyBuffer += delta;

          if (containsRecoverableToolRequest(safetyBuffer, knownToolNames)) {
            toolRequestDetected = true;
            safetyBuffer = "";
            return;
          }

          if (shouldKeepPostReleaseBuffer(safetyBuffer)) {
            lifecycle.mark("buffering_safety", "Checking possible tool output before writing...", {
              bufferedChars: safetyBuffer.length,
            });
            return;
          }

          emit(safetyBuffer);
          safetyBuffer = "";
          return;
        }

        if (containsRecoverableToolRequest(delta, knownToolNames)) {
          toolRequestDetected = true;
          return;
        }

        if (shouldKeepPostReleaseBuffer(delta)) {
          safetyBuffer = delta;
          lifecycle.mark("buffering_safety", "Checking possible tool output before writing...", {
            bufferedChars: safetyBuffer.length,
          });
          return;
        }

        emit(delta);
        return;
      }

      safetyBuffer += delta;

      if (containsRecoverableToolRequest(safetyBuffer, knownToolNames)) {
        toolRequestDetected = true;
        safetyBuffer = "";
        return;
      }

      if (shouldKeepWritebackSafetyBuffer(safetyBuffer)) {
        lifecycle.mark("buffering_safety", "Checking early output before writing...", {
          bufferedChars: safetyBuffer.length,
        });
        return;
      }

      live = true;
      emit(safetyBuffer);
      safetyBuffer = "";
    },
    finish() {
      if (safetyBuffer && !toolRequestDetected) {
        if (containsRecoverableToolRequest(safetyBuffer, knownToolNames)) {
          toolRequestDetected = true;
          safetyBuffer = "";
        } else {
          live = true;
          emit(safetyBuffer);
          safetyBuffer = "";
        }
      }

      if (!toolRequestDetected) {
        const trailingTopicalContent = relevanceGate.finish();
        if (trailingTopicalContent) {
          wroteContent = true;
          events.onFinalDelta?.(trailingTopicalContent);
          events.onAssistantDelta?.(trailingTopicalContent);
          writer.push(trailingTopicalContent);
        }
      }

      return { toolRequestDetected, wroteContent };
    },
  };
}

function shouldKeepWritebackSafetyBuffer(content: string): boolean {
  const trimmed = content.trimStart();

  if (!trimmed) {
    return true;
  }

  const lower = trimmed.toLowerCase();
  if ("<requested_tool_call".startsWith(lower)) {
    return true;
  }

  if (lower.startsWith("<requested_tool_call")) {
    return true;
  }

  if (
    (trimmed.startsWith("`") || trimmed.startsWith("\\`")) &&
    !/\n/.test(trimmed)
  ) {
    return true;
  }

  if (/^\\?`\\?`?\\?`?\s*(json|tool|tool_call|function)?\s*$/i.test(trimmed)) {
    return true;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }

  return false;
}

function shouldKeepPostReleaseBuffer(content: string): boolean {
  const trimmed = content.trimStart();
  const lower = trimmed.toLowerCase();

  return (
    lower.startsWith("<requested_tool_call") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /^\\?`\\?`?\\?`?\s*(json|tool|tool_call|function)\b/i.test(trimmed)
  );
}

function isInvalidResponseError(error: unknown): boolean {
  return (
    error instanceof ModelClientError &&
    error.category === "invalid_response"
  );
}

function parseWritebackWordCountTargetFromMessages(
  messages: ModelChatMessage[],
): WordCountTarget | null {
  const activeGeneratedTargetContext = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "system" &&
        /Generated output word target:/i.test(message.content),
    );
  if (activeGeneratedTargetContext) {
    return parseWordCountTarget(activeGeneratedTargetContext.content);
  }

  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage || !hasGeneratedWritingIntent(latestUserMessage.content)) {
    return null;
  }

  return parseWordCountTarget(latestUserMessage.content);
}

function hasUnclosedFence(content: string): boolean {
  return (content.match(/```/g)?.length ?? 0) % 2 === 1;
}

function parseGeneratedWordCountTargetFromMessages(
  messages: ModelChatMessage[],
): WordCountTarget | null {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!latestUserMessage || !hasGeneratedWritingIntent(latestUserMessage.content)) {
    return null;
  }

  return parseWordCountTarget(latestUserMessage.content);
}

function parseWordCountTarget(content: string): WordCountTarget | null {
  const exactMatch =
    /\bexactly\s+(\d{1,5})\s+words?\b/i.exec(content) ??
    /\b(\d{1,5})\s+words?\s+exactly\b/i.exec(content);
  if (exactMatch) {
    const target = Number(exactMatch[1]);
    return {
      target,
      exact: true,
      min: target,
      max: target,
    };
  }

  const approximateMatch =
    /\b(\d{1,5})\s*(?:-| )?words?\b/i.exec(content) ??
    /\b(\d{1,5})\s*(?:-| )?word\b/i.exec(content);
  if (!approximateMatch) {
    return null;
  }

  const target = Number(approximateMatch[1]);
  const tolerance = Math.max(1, Math.round(target * 0.1));
  return {
    target,
    exact: false,
    min: Math.max(1, target - tolerance),
    max: target + tolerance,
  };
}

function isWordCountWithinTarget(
  count: number,
  target: WordCountTarget,
): boolean {
  return count >= target.min && count <= target.max;
}

async function requestWordCountCorrection({
  modelClient,
  messages,
  draft,
  wordTarget,
  events,
  think,
  options,
  abortSignal,
  onThinkingUnsupported,
  metricName,
}: {
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  draft: string;
  wordTarget: WordCountTarget;
  events: AgentRunEvents;
  think?: ModelThink;
  options?: ModelRequestOptions;
  abortSignal?: AbortSignal;
  onThinkingUnsupported: () => void;
  metricName: string;
}): Promise<string> {
  const request: ModelChatRequest = {
    messages: [
      ...messages,
      {
        role: "assistant" as const,
        content: draft,
      },
      {
        role: "user" as const,
        content: buildWordCountCorrectionPrompt(wordTarget),
      },
    ],
    think: undefined,
    options,
    abortSignal,
  };
  const requestChars = measureSerializedChars(request);
  const startedAt = nowMs();

  emitModelCallTrace(events, {
    id: `model-call-${metricName}`,
    message: `Model chat: ${metricName}`,
    request,
  });

  try {
    const response = await chatWithThinkingFallback({
      modelClient,
      request,
      events,
      onThinkingUnsupported,
    });
    emitMetricEvent(events, {
      kind: "model_chat",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
      responseChars: measureSerializedChars(response.raw ?? response.message),
      ...extractTokenUsageFields(response.raw),
    });
    emitThinking(response.message.thinking, events);
    return sanitizeAssistantContent(response.message.content);
  } catch (error) {
    emitMetricEvent(events, {
      kind: "model_chat",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
    });
    throw error;
  }
}

async function repairEnglishOnlyOutput({
  modelClient,
  messages,
  draft,
  events,
  think,
  options,
  abortSignal,
  onThinkingUnsupported,
  metricName,
}: {
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  draft: string;
  events: AgentRunEvents;
  think?: ModelThink;
  options?: ModelRequestOptions;
  abortSignal?: AbortSignal;
  onThinkingUnsupported: () => void;
  metricName: string;
}): Promise<string> {
  const language = inspectEnglishOnlyOutput(draft);
  if (language.ok) {
    return draft;
  }

  events.onStreamLifecycle?.({
    kind: "buffering_language",
    elapsedMs: 0,
    bufferedChars: draft.length,
    message: "Language gate retrying English-only output...",
  });
  events.onStatus?.("Model produced non-English output; requesting English-only repair...");

  const repairOptions: ModelRequestOptions = {
    ...(options ?? {}),
    temperature: 0.1,
    top_p: 0.8,
  };
  const request: ModelChatRequest = {
    messages: [
      ...messages,
      {
        role: "assistant" as const,
        content: draft,
      },
      {
        role: "user" as const,
        content: buildEnglishOnlyRepairPrompt(),
      },
    ],
    think,
    options: repairOptions,
    abortSignal,
  };
  const requestChars = measureSerializedChars(request);
  const startedAt = nowMs();

  emitModelCallTrace(events, {
    id: `model-call-${metricName}`,
    message: `Model chat: ${metricName}`,
    request,
  });

  try {
    const response = await chatWithThinkingFallback({
      modelClient,
      request,
      events,
      onThinkingUnsupported,
    });
    emitMetricEvent(events, {
      kind: "model_chat",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
      responseChars: measureSerializedChars(response.raw ?? response.message),
      ...extractTokenUsageFields(response.raw),
    });
    emitThinking(response.message.thinking, events);
    const repaired = sanitizeAssistantContent(response.message.content);
    assertEnglishOnlyOutput(repaired);
    return repaired;
  } catch (error) {
    emitMetricEvent(events, {
      kind: "model_chat",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
    });
    throw error;
  }
}

async function chatWithThinkingFallback({
  modelClient,
  request,
  events,
  onThinkingUnsupported,
}: {
  modelClient: ModelClient;
  request: ModelChatRequest;
  events: AgentRunEvents;
  onThinkingUnsupported: () => void;
}): Promise<ModelChatResponse> {
  try {
    return await withModelWaitStatus(
      () => modelClient.chat(request),
      events,
      "word-count correction",
    );
  } catch (error) {
    if (request.think === undefined || !isThinkingUnsupportedError(error)) {
      throw error;
    }

    onThinkingUnsupported();
    return withModelWaitStatus(
      () => modelClient.chat({ ...request, think: undefined }),
      events,
      "word-count correction retry",
    );
  }
}

function buildWordCountCorrectionPrompt(target: WordCountTarget): string {
  const targetText = target.exact
    ? `exactly ${target.target} words`
    : `between ${target.min} and ${target.max} words, targeting ${target.target}`;

  return [
    `Revise the previous draft to be ${targetText}.`,
    "Keep the same topic, claims, citations, and useful details.",
    "Return only the revised answer text.",
  ].join(" ");
}

function consumeLeadingH1Title(buffer: string, force = false): LeadingTitleResult {
  const leadingBlank = /^(?:[ \t]*\r?\n)*/.exec(buffer)?.[0] ?? "";
  const candidate = buffer.slice(leadingBlank.length);
  if (!candidate) {
    return force ? { status: "no_title", body: buffer } : { status: "pending" };
  }

  if (
    !/^(?: {0,3})#(?:[ \t]|$)/.test(candidate) ||
    /^(?: {0,3})##/.test(candidate)
  ) {
    return { status: "no_title", body: buffer };
  }

  const newlineMatch = /\r?\n/.exec(candidate);
  if (!newlineMatch && !force) {
    return { status: "pending" };
  }

  const lineEnd = newlineMatch?.index ?? candidate.length;
  const line = candidate.slice(0, lineEnd).trimEnd();
  const match = /^(?: {0,3})#(?:[ \t]+)(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(
    line,
  );
  if (!match) {
    return { status: "no_title", body: buffer };
  }

  const newlineLength = newlineMatch?.[0].length ?? 0;
  const bodyStart = leadingBlank.length + lineEnd + newlineLength;
  const body = buffer.slice(bodyStart).replace(/^(?:[ \t]*\r?\n)+/, "");
  return {
    status: "title",
    title: match[1].trim(),
    body,
  };
}

async function createStreamingNoteWriter({
  kind,
  toolContext,
  preparedSectionEdit,
  lazyCreatePath,
  onNoteCreated,
}: {
  kind: StreamingWritebackKind;
  toolContext: ToolExecutionContext;
  preparedSectionEdit: PreparedStreamingSectionEdit | null;
  lazyCreatePath?: string | null;
  onNoteCreated?: (file: { path: string; basename: string }) => void;
}) {
  let file: ReturnType<typeof getActiveMarkdownFile> | null = null;
  let current = "";
  let createReceiptPath: string | null = null;
  const ensureFile = async () => {
    if (file) {
      return file;
    }
    if (lazyCreatePath) {
      const created = await createAutonomousNoteTarget({
        app: toolContext.app,
        path: lazyCreatePath,
        initialContent: "",
      });
      file = created.file;
      current = "";
      createReceiptPath = created.path;
      onNoteCreated?.({ path: created.path, basename: created.file.basename });
      return file;
    }
    file = getActiveMarkdownFile(toolContext);
    current =
      toolContext.getCurrentMarkdownContent?.(file) ??
      (await toolContext.app.vault.read(file));
    return file;
  };
  if (!lazyCreatePath) {
    file = getActiveMarkdownFile(toolContext);
    current =
      toolContext.getCurrentMarkdownContent?.(file) ??
      (await toolContext.app.vault.read(file));
  }
  const makeAppendBase = (content: string) =>
    `${content}${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}`;
  const getLatestAppendBaseSource = () =>
    (file && toolContext.getCurrentMarkdownContent?.(file)) ?? current;
  const makeRetitledAppendBase = (title: string) =>
    makeAppendBase(retitleNoteMarkdown(getLatestAppendBaseSource(), title));
  let baseContent = kind === "append" ? makeAppendBase(current) : "";
  let baseContentChanged = false;
  let leadingTitleBuffer: string | null = kind === "append" ? "" : null;
  const backupPath =
    kind === "replace" && file
      ? await backupActiveFile(toolContext, file, current)
      : kind === "edit"
        ? requirePreparedSectionEdit(preparedSectionEdit).backupPath
        : undefined;
  const section = kind === "edit" ? requirePreparedSectionEdit(preparedSectionEdit) : null;
  let streamedContent = "";
  let pendingChars = 0;
  let lastFlushAt = nowMs();
  let flushChain = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let hasQueuedWrite = false;

  const render = () => {
    if (kind === "append") {
      return `${baseContent}${streamedContent}`;
    }

    if (kind === "replace") {
      return streamedContent;
    }

    return `${section?.prefix ?? ""}${formatStreamingSectionBody(
      streamedContent,
      section?.suffix ?? "",
    )}${section?.suffix ?? ""}`;
  };
  const hasWritableContent = () => streamedContent.trim().length > 0;
  const hasNoteMutation = () => baseContentChanged || hasWritableContent();
  const writeContent = async (content: string) => {
    const target = await ensureFile();
    toolContext.setCurrentMarkdownContent?.(target, content);
    await toolContext.app.vault.modify(target, content);
  };
  const consumeAppendTitleIfPresent = (
    delta: string,
    force = false,
  ): string => {
    if (leadingTitleBuffer === null) {
      return delta;
    }

    leadingTitleBuffer += delta;
    const titleResult = consumeLeadingH1Title(leadingTitleBuffer, force);
    if (titleResult.status === "pending") {
      return "";
    }

    leadingTitleBuffer = null;
    if (titleResult.status === "title") {
      baseContent = makeRetitledAppendBase(titleResult.title);
      baseContentChanged = true;
      return titleResult.body;
    }

    return titleResult.body;
  };

  const queueFlush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingChars = 0;
    lastFlushAt = nowMs();
    const nextContent = render();
    hasQueuedWrite = true;
    flushChain = flushChain.then(() => writeContent(nextContent));
  };

  const scheduleFlush = () => {
    if (flushTimer !== null || pendingChars <= 0) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (pendingChars > 0) {
        queueFlush();
      }
    }, LIVE_FLUSH_TIMER_MS);
  };

  return {
    push(delta: string) {
      const writableDelta = consumeAppendTitleIfPresent(delta);
      if (!writableDelta) {
        return;
      }

      streamedContent += writableDelta;
      pendingChars += writableDelta.length;

      if (
        pendingChars >= LIVE_FLUSH_CHAR_THRESHOLD ||
        nowMs() - lastFlushAt >= LIVE_FLUSH_MS
      ) {
        queueFlush();
      } else {
        scheduleFlush();
      }
    },
    replaceContent(content: string) {
      if (kind === "append") {
        baseContent = makeAppendBase(getLatestAppendBaseSource());
        baseContentChanged = false;
        leadingTitleBuffer = "";
        streamedContent = consumeAppendTitleIfPresent(content, true);
      } else {
        streamedContent = content;
      }
      pendingChars = streamedContent.length;
      queueFlush();
    },
    hasWritableContent() {
      return hasNoteMutation();
    },
    discardNonWritableContent() {
      if (hasNoteMutation()) {
        return;
      }

      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      streamedContent = "";
      pendingChars = 0;
      leadingTitleBuffer = kind === "append" ? "" : null;
    },
    async finish(options: { force?: boolean } = {}) {
      const trailingTitleContent = consumeAppendTitleIfPresent("", true);
      if (trailingTitleContent) {
        streamedContent += trailingTitleContent;
        pendingChars += trailingTitleContent.length;
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (
        hasNoteMutation() &&
        (pendingChars > 0 || (options.force && !hasQueuedWrite))
      ) {
        queueFlush();
      }
      await flushChain;
    },
    buildReceipt(partial: boolean): AgentRunReceipt {
      const resolvedPath = file?.path ?? lazyCreatePath ?? "unknown";
      const operation =
        kind === "append" ? "append" : kind === "replace" ? "replace" : "edit";
      const bytesWritten =
        kind === "append" ? getByteLength(streamedContent) : getByteLength(render());
      const output = {
        path: resolvedPath,
        operation,
        backupPath,
        bytesWritten,
        streamed: true,
        partial,
        heading: section?.heading,
        level: section?.level,
        ...(createReceiptPath ? { createdPath: createReceiptPath } : {}),
      };

      const messageParts = [`${operation} ${resolvedPath}`];
      if (createReceiptPath) {
        messageParts.push(`created: ${createReceiptPath}`);
      }
      if (backupPath) {
        messageParts.push(`backup: ${backupPath}`);
      }
      if (partial) {
        messageParts.push("partial");
      }

      return {
        toolName:
          kind === "append"
            ? "append_to_current_file"
            : kind === "replace"
              ? "replace_current_file"
              : "edit_current_section",
        operation,
        path: resolvedPath,
        backupPath,
        bytesWritten: output.bytesWritten,
        output,
        message: messageParts.join("; "),
      };
    },
  };
}

function parsePreparedStreamingSectionEdit(
  output: unknown,
): PreparedStreamingSectionEdit {
  if (!isRecord(output)) {
    throw new Error("prepare_edit_current_section returned an invalid result.");
  }

  const path = getString(output.path);
  const backupPath = getString(output.backupPath);
  const heading = getString(output.heading);
  const prefix = getString(output.prefix);
  const suffix = typeof output.suffix === "string" ? output.suffix : "";
  const level = getNumber(output.level);
  const replacedChars = getNumber(output.replacedChars);

  if (!path || !backupPath || !heading || !prefix || level === undefined) {
    throw new Error("prepare_edit_current_section returned incomplete section data.");
  }

  return {
    path,
    backupPath,
    heading,
    level,
    prefix,
    suffix,
    replacedChars: replacedChars ?? 0,
  };
}

function requirePreparedSectionEdit(
  preparedSectionEdit: PreparedStreamingSectionEdit | null,
): PreparedStreamingSectionEdit {
  if (!preparedSectionEdit) {
    throw new Error("Streaming section edit requires prepare_edit_current_section first.");
  }

  return preparedSectionEdit;
}

function getActiveMarkdownFile(toolContext: ToolExecutionContext) {
  const file =
    toolContext.getCurrentMarkdownFile?.() ??
    toolContext.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    throw new Error(
      "An active markdown file is required. Open or focus a markdown note before running the mission.",
    );
  }

  return file;
}

async function backupActiveFile(
  toolContext: ToolExecutionContext,
  file: ReturnType<typeof getActiveMarkdownFile>,
  content: string,
): Promise<string> {
  if (!toolContext.app.vault.getFolderByPath(BACKUP_FOLDER)) {
    try {
      await toolContext.app.vault.createFolder(BACKUP_FOLDER);
    } catch (error) {
      if (!isFolderAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  const timestamp = (toolContext.now?.() ?? new Date()).getTime();
  const basename = sanitizeBackupBasename(file.basename);
  let backupPath = `${BACKUP_FOLDER}/${timestamp}-${basename}.md`;
  let suffix = 1;

  while (toolContext.app.vault.getFileByPath(backupPath)) {
    backupPath = `${BACKUP_FOLDER}/${timestamp}-${basename}-${suffix}.md`;
    suffix += 1;
  }

  await toolContext.app.vault.create(backupPath, content);
  return backupPath;
}

function isFolderAlreadyExistsError(error: unknown): boolean {
  return /folder already exists|already exists/i.test(getErrorMessage(error));
}

function sanitizeBackupBasename(basename: string): string {
  const sanitized = basename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized || "untitled";
}

function formatStreamingSectionBody(content: string, suffix: string): string {
  if (!content) {
    return "";
  }

  return suffix && !content.endsWith("\n") ? `${content}\n` : content;
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function sanitizeAssistantContent(content: string): string {
  return content.replace(
    /[<＜]\s*[|｜]\s*(?:begin\s*[_▁]+\s*of\s*[_▁]+\s*sentence|end\s*[_▁]+\s*of\s*[_▁]+\s*sentence|start\s*[_▁]+\s*header\s*[_▁]+\s*id|end\s*[_▁]+\s*header\s*[_▁]+\s*id|eot\s*[_▁]+\s*id|eom\s*[_▁]+\s*id)\s*[|｜]\s*[>＞]/gi,
    "",
  );
}

export function createAssistantContentSanitizer() {
  let pending = "";

  return {
    push(delta: string): string {
      pending = sanitizeAssistantContent(`${pending}${delta}`);

      const tokenStartIndex = findPotentialSpecialTokenStart(pending);
      if (tokenStartIndex < 0) {
        const output = pending;
        pending = "";
        return output;
      }

      const output = pending.slice(0, tokenStartIndex);
      pending = pending.slice(tokenStartIndex);
      return output;
    },
    flush(): string {
      const output = sanitizeAssistantContent(pending);
      pending = "";
      return output;
    },
  };
}

const NORMALIZED_SPECIAL_TOKENS = [
  "<|beginofsentence|>",
  "<|endofsentence|>",
  "<|startheaderid|>",
  "<|endheaderid|>",
  "<|eotid|>",
  "<|eomid|>",
];

const SPECIAL_TOKEN_LOOKBACK_CHARS = 80;

function findPotentialSpecialTokenStart(content: string): number {
  const searchStart = Math.max(0, content.length - SPECIAL_TOKEN_LOOKBACK_CHARS);
  for (let index = searchStart; index < content.length; index += 1) {
    if (content[index] !== "<" && content[index] !== "＜") {
      continue;
    }

    const candidate = normalizeSpecialTokenCandidate(content.slice(index));

    if (
      candidate &&
      NORMALIZED_SPECIAL_TOKENS.some((token) => token.startsWith(candidate))
    ) {
      return index;
    }
  }

  return -1;
}

function normalizeSpecialTokenCandidate(candidate: string): string {
  return candidate
    .toLowerCase()
    .replace(/＜/g, "<")
    .replace(/＞/g, ">")
    .replace(/｜/g, "|")
    .replace(/\s+/g, "")
    .replace(/[_▁]+/g, "");
}

function isClarifyingQuestionResponse(prompt: string, content: string): boolean {
  const sanitized = sanitizeAssistantContent(content).trim();
  if (!/\?\s*$/.test(sanitized)) {
    return false;
  }

  if (hasAmbiguousDatePrompt(prompt)) {
    return true;
  }

  if (sanitized.length > 700) {
    return false;
  }

  return (
    /^(before i|could you|can you|would you|which|what|where|when|who|how should|do you want|should i|may i|please (?:provide|confirm|choose|tell me)|i need|i(?:'|’)ll need|to proceed|to continue)\b/i.test(
      sanitized,
    ) ||
    /\b(clarify|clarification|confirm|choose|which|what|where|when|missing|required|need(?:ed)?|target|credential|permission)\b/i.test(
      sanitized,
    )
  );
}

function hasRenderableAssistantContent(content: string): boolean {
  return sanitizeAssistantContent(content).trim().length > 0;
}

function isThinkingUnsupportedError(error: unknown): boolean {
  const text = getErrorSearchText(error);
  return (
    /\b(think|thinking|reasoning)\b/.test(text) &&
    /\b(unsupported|not supported|invalid|unknown|unrecognized|unexpected)\b/.test(
      text,
    )
  );
}

function getUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

function getErrorSearchText(error: unknown): string {
  const parts: string[] = [];

  if (error instanceof Error) {
    parts.push(error.message);
  } else {
    parts.push(String(error));
  }

  if (error instanceof ModelClientError) {
    parts.push(JSON.stringify(error.details ?? ""));
    parts.push(String(error.status ?? ""));
  }

  return parts.join(" ").toLowerCase();
}

function completeRun(
  events: AgentRunEvents,
  stopReason: AgentRunStopReason,
  step: number,
  runStartedAt?: number,
  maxSteps = MAX_AGENT_STEPS,
  autoContinuation?: AutoContinuationDecision,
) {
  const message = getStopReasonMessage(stopReason);
  emitStatus(
    events,
    message,
    stopReason === "budget" || stopReason === "user_stopped"
      ? "stopped"
      : "done",
  );
  events.onRunComplete?.({
    step,
    maxSteps,
    stopReason,
    ...(autoContinuation
      ? {
          autoContinueRecommended: autoContinuation.recommended,
          autoContinueReason: autoContinuation.reason,
        }
      : {}),
  });
  events.onTrace?.({
    id: `final-${stopReason}`,
    kind: "final",
    step,
    message,
    outputPreview: {
      step,
      maxSteps,
      stopReason,
      autoContinueRecommended: autoContinuation?.recommended ?? false,
      autoContinueReason: autoContinuation?.reason ?? "not_budget",
    },
  });
  if (runStartedAt !== undefined) {
    emitMetricEvent(events, {
      kind: "run",
      name: "mission",
      step,
      durationMs: elapsedMs(runStartedAt),
    });
  }
}

function getStopReasonMessage(stopReason: AgentRunStopReason): string {
  switch (stopReason) {
    case "write_completed":
      return "Write complete.";
    case "clarifying_question":
      return "Needs clarification.";
    case "user_stopped":
      return "Stopped by user.";
    case "budget":
      return "Stopped at safety limit. Review partial results.";
    case "error":
      return "Error.";
    case "final":
    default:
      return "Done.";
  }
}

function formatDurableEvidenceForWriteback(evidence: MissionEvidence[]): string {
  const entries = evidence.slice(-12).map((item) => {
    const citationIds = [
      item.passageId,
      ...(item.passageIds ?? []),
      item.sourceId,
    ]
      .filter((value, index, values): value is string =>
        Boolean(value) && values.indexOf(value) === index,
      )
      .slice(0, 24);
    const locator = item.url ?? item.path ?? item.id;
    const citations =
      citationIds.length > 0
        ? ` Citation identifiers: ${citationIds.join(", ")}.`
        : "";
    return `- ${item.title} (${locator}): ${item.summary.slice(0, 800)}${citations}`;
  });
  return [
    "Verified durable mission evidence available for writeback.",
    "Use these exact source and passage identifiers when the final output requires citations. Do not invent identifiers.",
    ...entries,
  ].join("\n");
}

function hasRuntimeSnapshotPersistence(context: ToolExecutionContext): boolean {
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

function isBlockingPreWriteProof(item: string): boolean {
  return /web_evidence|source_coverage|source_domains|citation_coverage|fetched_sources|distinct_domains|vault_evidence|word_count|code_execution|research_plan_items/i.test(
    item,
  );
}

function isContentWriteToolThatNeedsEvidence(toolName: string): boolean {
  return [
    "create_file",
    "append_file",
    "replace_file",
    "append_to_current_file",
    "append_to_current_section",
    "edit_current_section",
    "replace_current_file",
    "link_related_notes_in_current_file",
    "fill_template",
    "create_template",
    "create_research_pack",
    "create_design_canvas",
    "create_svg_design",
    "create_design_package",
    "export_workspace_artifact",
  ].includes(toolName);
}

function getStreamingWritebackToolName(
  kind: StreamingWritebackKind,
): "append_to_current_file" | "replace_current_file" | "edit_current_section" {
  return kind === "append"
    ? "append_to_current_file"
    : kind === "replace"
      ? "replace_current_file"
      : "edit_current_section";
}

function requiresVerifiedFinalOutput(
  missionPlan: MissionPlan | null,
  researchPlan: ResearchPlan | null,
): boolean {
  return Boolean(
    researchPlan ||
      missionPlan?.tasks.some((task) =>
        task.completionContract.citationMode !== undefined,
      ),
  );
}

function isRepairableFinalOutputProof(item: string): boolean {
  return (
    item === "final_output" ||
    item === "citation_url_coverage" ||
    item === "limitations_section" ||
    item === "confidence_section" ||
    item === "unanswered_questions" ||
    item.startsWith("subquestion_citation_coverage:") ||
    item.startsWith("verifier:citation_coverage:") ||
    item === "verifier:final_output" ||
    item === "verifier:final_relevance" ||
    item.includes("claim_grounding") ||
    /^verifier:[^:]+:final_relevance$/u.test(item) ||
    /^plan:[^:]+:final_relevance$/u.test(item)
  );
}

function getProofGatedWritebackCandidateAcceptance(
  acceptance: MissionAcceptanceResult,
  requiredWriteTools: string[],
): MissionAcceptanceResult {
  const requiredWrites = new Set(requiredWriteTools);
  const missing = acceptance.missing.filter((item) => {
    if (item === "write_receipt") {
      return false;
    }
    if (item.startsWith("tool:")) {
      return !requiredWrites.has(item.slice("tool:".length));
    }
    if (item.startsWith("pending_goal:")) {
      // The candidate is intentionally checked before its single journaled
      // commit, so the current-note write goal must still be pending here.
      return false;
    }
    if (
      /^verifier:[^:]+:(?:write_receipt|artifact_receipt|rename_receipt|highlight_receipt)$/u.test(
        item,
      ) ||
      /^plan:[^:]+:(?:write_receipt|artifact_receipt|rename_receipt|highlight_receipt)$/u.test(
        item,
      )
    ) {
      return false;
    }
    return true;
  });
  return {
    ...acceptance,
    status: missing.length === 0 ? "pass" : acceptance.status,
    missing,
    reasons:
      missing.length === 0
        ? [...new Set([...acceptance.reasons, "candidate_proof_verified_before_commit"])]
        : acceptance.reasons,
  };
}

function buildFinalOutputVerificationCorrectionPrompt(
  acceptance: MissionAcceptanceResult,
  rejectedCandidate: string,
  missionPrompt = "",
): string {
  const requirePassageIds = shouldRequireClaimGrounding(missionPrompt);
  const citationMissing = acceptance.missing.some(
    (item) =>
      item === "citation_url_coverage" ||
      item.startsWith("subquestion_citation_coverage:") ||
      item.startsWith("verifier:citation_coverage:") ||
      item.includes("claim_grounding"),
  );
  return [
    `The draft failed final-output verification: ${acceptance.missing.join(", ")}.`,
    "Revise it before it can be shown to the user.",
    citationMissing || requirePassageIds
      ? requirePassageIds
        ? "Cite exact source-scoped passage identifiers already present in the evidence context (source:<id>:passage:<start>-<end>). Every material claim must include at least one persisted passage id. Do not invent identifiers or rely on bare URLs alone."
        : "Cite the bound source URL or exact source-scoped passage identifiers already present in the evidence context. Ground each material claim to a persisted passage id."
      : "",
    acceptance.missing.some((item) => item.includes("open_evidence_conflicts"))
      ? "Resolve or explicitly acknowledge open evidence conflicts with a Limitations note before finalizing."
      : "",
    acceptance.missing.includes("limitations_section")
      ? "Include an explicit Limitations section."
      : "",
    acceptance.missing.includes("confidence_section")
      ? "Include an explicit Confidence section."
      : "",
    acceptance.missing.some((item) =>
      item.includes("claim_grounding:missing_quote") ||
      item.includes("claim_grounding:quote_"),
    )
      ? "For quotation work, include at least one direct quote copied character-for-character from the cited passage. Every other quoted span must also appear verbatim in its cited passage; remove or paraphrase unsupported quotation marks. Paraphrased material claims still need persisted passage ids."
      : "",
    "Return only the corrected final answer. Do not request tools or repeat this instruction.",
    `Rejected draft for revision:\n${truncateForTrace(rejectedCandidate, 6000)}`,
  ].filter(Boolean).join("\n\n");
}

function getMissionLedgerStatusForStopReason(
  stopReason: AgentRunStopReason,
): MissionLedgerStatus {
  switch (stopReason) {
    case "write_completed":
    case "final":
    case "clarifying_question":
      return "complete";
    case "budget":
      return "budget";
    case "user_stopped":
      return "stopped";
    case "error":
    default:
      return "blocked";
  }
}

function isRunStopRequested(abortSignal: AbortSignal | undefined): boolean {
  return abortSignal?.aborted ?? false;
}

async function checkpointRunIfDue({
  toolContext,
  events,
  runId,
  step,
  stepLimit,
  runPlan,
  toolNames,
  status = "running",
  message,
  force = false,
}: {
  toolContext: ToolExecutionContext;
  events: AgentRunEvents;
  runId: string;
  step: number;
  stepLimit: number;
  runPlan: RunPlan;
  toolNames: string[];
  status?: string;
  message?: string;
  force?: boolean;
}) {
  if (
    step <= 0 ||
    (!force && step % CHECKPOINT_EVERY_STEPS !== 0) ||
    stepLimit < CHECKPOINT_EVERY_STEPS ||
    !hasCheckpointVaultApi(toolContext)
  ) {
    return;
  }

  try {
    const result = await appendAgentRunCheckpoint(toolContext, {
      runId,
      step,
      maxSteps: stepLimit,
      status,
      route: runPlan.route,
      toolNames,
      message: message ?? `Completed planning step ${step}; continuing agent loop.`,
      timestamp: toolContext.now?.() ?? new Date(),
    });
    events.onTrace?.({
      id: `checkpoint-${step}`,
      kind: "status",
      step,
      path: result.path,
      message: `Saved run checkpoint to ${result.path}`,
      outputPreview: result,
    });
  } catch (error) {
    events.onTrace?.({
      id: `checkpoint-${step}:error`,
      kind: "error",
      step,
      message: `Run checkpoint failed: ${getUnknownErrorMessage(error)}`,
      error: {
        code: "checkpoint_failed",
        message: getUnknownErrorMessage(error),
      },
    });
  }
}

function hasCheckpointVaultApi(toolContext: ToolExecutionContext): boolean {
  const vault = (toolContext as Partial<ToolExecutionContext>).app?.vault as
    | Record<string, unknown>
    | undefined;

  return (
    typeof vault?.getFolderByPath === "function" &&
    typeof vault.getFileByPath === "function" &&
    typeof vault.createFolder === "function" &&
    typeof vault.create === "function" &&
    typeof vault.read === "function" &&
    typeof vault.modify === "function"
  );
}

const CACHEABLE_TOOL_NAMES = new Set([
  "read_current_file",
  "inspect_vault_context",
  "list_markdown_files",
  "search_markdown_files",
  "inspect_semantic_index",
  "semantic_search_notes",
  "read_markdown_files",
  "read_file",
  "count_words",
  "web_fetch",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
]);

async function executePreparedToolWithMetrics({
  toolRegistry,
  preparedAction,
  authorization,
  toolContext,
  events,
  step,
}: {
  toolRegistry: ToolRegistry;
  preparedAction: PreparedAction;
  authorization: AuthorizedActionContext;
  toolContext: ToolExecutionContext;
  events: AgentRunEvents;
  step?: number;
}): Promise<ToolExecutionResult> {
  const startedAt = nowMs();
  const inputChars = measureSerializedChars(preparedAction.normalizedArgs);
  if (!toolRegistry.executePrepared) {
    return {
      ok: false,
      toolName: preparedAction.toolName,
      mutationState: "not_applied",
      error: {
        code: "prepared_execution_unavailable",
        message: "The tool registry does not support prepared execution.",
      },
    };
  }
  try {
    const result = await toolRegistry.executePrepared(
      preparedAction,
      toolContext,
      authorization,
    );
    emitMetricEvent(events, {
      kind: "tool",
      name: preparedAction.toolName,
      step,
      durationMs: elapsedMs(startedAt),
      inputChars,
      outputChars: measureSerializedChars(result),
    });
    return result;
  } catch (error) {
    emitMetricEvent(events, {
      kind: "tool",
      name: preparedAction.toolName,
      step,
      durationMs: elapsedMs(startedAt),
      inputChars,
    });
    throw error;
  }
}

function isPreparedActionWithinRunnerScope({
  toolName,
  descriptor,
  action,
  allowedToolNames,
  policyRouted,
  missionIntent,
  writeAutonomy,
}: {
  toolName: string;
  descriptor: ToolDescriptor;
  action: PreparedAction;
  allowedToolNames: Set<string>;
  policyRouted: RoutedMissionIntent;
  missionIntent: MissionIntent;
  writeAutonomy: boolean;
}): boolean {
  if (
    !allowedToolNames.has(toolName) ||
    action.toolName !== toolName ||
    action.target.system !== descriptor.capability.system ||
    action.target.resourceType !== descriptor.capability.resourceType
  ) {
    return false;
  }
  if (descriptor.effect === "read") {
    return true;
  }
  if (descriptor.capability.system === "vault") {
    return (
      policyRouted.writeScope !== "none" ||
      writeAutonomy ||
      missionIntent.explicitMutation ||
      missionIntent.noteOutput
    );
  }
  // External and workspace tools reach this point only after the mission
  // allowlist's explicit integration/code/browser intent gates accepted them.
  return descriptor.capability.system !== "web";
}

async function executeToolWithMetrics({
  toolRegistry,
  toolCall,
  toolContext,
  events,
  step,
}: {
  toolRegistry: ToolRegistry;
  toolCall: { name: string; arguments: Record<string, unknown> };
  toolContext: ToolExecutionContext;
  events: AgentRunEvents;
  step?: number;
}) {
  const startedAt = nowMs();
  const inputChars = measureSerializedChars(toolCall.arguments);
  const toolCache = toolContext.runtimeCache?.toolResults;
  const cacheKey =
    toolCache && CACHEABLE_TOOL_NAMES.has(toolCall.name)
      ? getToolCacheKey(toolCall.name, toolCall.arguments)
      : null;

  if (cacheKey) {
    const cachedResult = toolCache?.get(cacheKey);
    if (cachedResult) {
      emitMetricEvent(events, {
        kind: "tool",
        name: toolCall.name,
        step,
        durationMs: 0,
        cached: true,
        cacheKey,
        savedDurationMs: elapsedMs(startedAt),
        inputChars,
        outputChars: measureSerializedChars(cachedResult),
      });
      return cachedResult;
    }
  }

  try {
    const result = await toolRegistry.execute(toolCall, toolContext);
    if (cacheKey && result.ok) {
      toolCache?.set(cacheKey, result);
    }
    emitMetricEvent(events, {
      kind: "tool",
      name: toolCall.name,
      step,
      durationMs: elapsedMs(startedAt),
      inputChars,
      outputChars: measureSerializedChars(result),
    });
    if (result.ok && step === undefined) {
      const receipt = buildReceiptFromToolExecution(
        toolCall.name,
        result,
        toolRegistry.getDescriptor?.(toolCall.name) ?? null,
      );
      if (receipt) {
        const traceStep = step ?? 0;
        events.onTrace?.({
          id: `local:${traceStep}:${toolCall.name}:transaction:validated`,
          kind: "status",
          step: traceStep,
          toolName: toolCall.name,
          message: "Vault transaction validated.",
          outputPreview: truncateTracePayload(result.output),
        });
        events.onTrace?.({
          id: `local:${traceStep}:${toolCall.name}:transaction:applied`,
          kind: "status",
          step: traceStep,
          toolName: toolCall.name,
          message: "Vault transaction applied.",
          outputPreview: truncateTracePayload(result.output),
        });
        events.onReceipt?.(receipt);
        events.onTrace?.({
          id: `local:${traceStep}:${toolCall.name}:transaction:committed`,
          kind: "receipt",
          step: traceStep,
          toolName: toolCall.name,
          operation: receipt.operation,
          path: receipt.path,
          toPath: receipt.toPath,
          backupPath: receipt.backupPath,
          message: "Vault transaction committed.",
          outputPreview: truncateTracePayload(receipt.output ?? receipt),
        });
      }
    }
    return result;
  } catch (error) {
    emitMetricEvent(events, {
      kind: "tool",
      name: toolCall.name,
      step,
      durationMs: elapsedMs(startedAt),
      inputChars,
    });
    throw error;
  }
}

interface ToolApprovalRequestInfo {
  action: string;
  reason: string;
  policyTags: string[];
  timeoutMs?: number;
}

function getToolApprovalRequestInfo(
  toolCall: ModelToolCall,
  result: ToolExecutionResult,
): ToolApprovalRequestInfo | null {
  if (!result.ok || !isRecord(result.output)) {
    return null;
  }

  if (result.output.status !== "requires_approval") {
    return null;
  }

  const approval = isRecord(result.output.approval)
    ? result.output.approval
    : undefined;
  const safetyDecision = isRecord(result.output.safetyDecision)
    ? result.output.safetyDecision
    : undefined;
  const action = getString(approval?.action) ?? getString(result.output.operation) ?? toolCall.name;
  const reason =
    getString(approval?.reason) ??
    getString(result.output.reason) ??
    getString(safetyDecision?.reason) ??
    `${toolCall.name} requires approval.`;
  const tags = [
    ...getStringArray(safetyDecision?.policyTags),
    ...getStringArray(approval?.policyTags),
  ];
  const timeoutMs =
    getNumber(approval?.expiresInMs) ?? getNumber(result.output.expiresInMs);

  return {
    action,
    reason,
    policyTags: tags.length ? tags : ["approval_required"],
    timeoutMs,
  };
}

function compareRouterWithRegex(
  routed: RoutedMissionIntent,
  regexIntent: MissionIntent,
): "agree" | "disagree" {
  const routerWrite = routed.writeScope !== "none";
  const regexWrite = regexIntent.noteOutput || regexIntent.explicitMutation;
  const routerRead = routed.needsVaultContext || routed.mode === "vault_read";
  const regexRead = regexIntent.vaultContext;
  const routerWeb =
    routed.needsWebEvidence ||
    routed.mode === "web_research" ||
    routed.mode === "deep_research";
  const regexWeb = regexIntent.autonomyScope.read.web;
  const routerCode = routed.needsCodeExecution || routed.mode === "code_workflow";
  const regexCode = regexIntent.autonomyScope.write.artifacts;

  return routerWrite === regexWrite &&
    routerRead === regexRead &&
    routerWeb === regexWeb &&
    routerCode === regexCode
    ? "agree"
    : "disagree";
}

function buildToolCallFallbackId(
  runId: string,
  step: number,
  toolIndex: number | string,
  toolName: string,
): string {
  return `call_${runId}_${step}_${toolIndex}_${toolName}`.replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  );
}

function formatObservedToolFailureStatus(
  toolName: string,
  result: ToolExecutionResult,
): string {
  const detail = result.error?.message?.trim();
  if (result.error?.code === "policy_blocked") {
    if (detail?.startsWith("What: ")) {
      return detail;
    }
    const phaseMatch = /during research (\w+) phase/i.exec(detail ?? "");
    if (phaseMatch || /research_phase_gate|phase gate/i.test(detail ?? "")) {
      return formatFailureCopy(
        phaseGateFailureCopy(phaseMatch?.[1], detail),
      );
    }
    return formatFailureCopy(policyBlockFailureCopy(toolName, detail));
  }
  if (
    result.error?.code?.startsWith("approval_") ||
    /approval (denied|expired|aborted)/i.test(detail ?? "")
  ) {
    const decision =
      result.error?.code?.replace(/^approval_/, "") ||
      /approval (denied|expired|aborted)/i.exec(detail ?? "")?.[1] ||
      "denied";
    return formatFailureCopy(approvalDeniedFailureCopy(toolName, decision));
  }
  if (toolName === "web_fetch" || toolName === "web_search") {
    return formatWebFetchToolFailureCopy(detail);
  }
  return detail?.startsWith("What: ")
    ? detail
    : `Tool returned error: ${toolName}${detail ? ` (${detail})` : ""}`;
}

function getToolCacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function hashOperationInput(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((output, key) => {
      output[key] = stableNormalize(value[key]);
      return output;
    }, {});
}

function runtimeReceiptToAgentRunReceipt(
  receipt: MissionRuntimeReceipt,
): AgentRunReceipt | null {
  if (!isAgentRunReceiptOperation(receipt.operation)) {
    return null;
  }
  return {
    version: receipt.version,
    id: receipt.id,
    toolName: receipt.toolName,
    operation: receipt.operation,
    message: receipt.message,
    actionId: receipt.actionId,
    resource: receipt.resource ? { ...receipt.resource } : undefined,
    relatedResources: receipt.relatedResources?.map((resource) => ({
      ...resource,
    })),
    payloadFingerprint: receipt.payloadFingerprint,
    grantId: receipt.grantId,
    idempotencyKey: receipt.idempotencyKey,
    providerRequestId: receipt.providerRequestId,
    startedAt: receipt.startedAt,
    committedAt: receipt.committedAt,
    commitKind: receipt.commitKind,
    readback: receipt.readback ? { ...receipt.readback } : undefined,
    effects: receipt.effects
      ? {
          ...receipt.effects,
          changedFields: receipt.effects.changedFields
            ? [...receipt.effects.changedFields]
            : undefined,
        }
      : undefined,
    path: receipt.path,
    toPath: receipt.toPath,
    backupPath: receipt.backupPath,
    restoredFromBackupPath: receipt.restoredFromBackupPath,
    bytesWritten: receipt.bytesWritten,
    bytesDeleted: receipt.bytesDeleted,
    affectedCount: receipt.affectedCount,
    output: receipt.output,
  };
}

function missionLedgerStatusToRuntimeStatus(
  status: MissionLedgerStatus,
): MissionRuntimeStatus {
  switch (status) {
    case "complete":
      return "complete";
    case "blocked":
      return "blocked";
    case "stopped":
      return "stopped";
    case "budget":
      return "paused";
    case "running":
    default:
      return "running";
  }
}

function normalizeRuntimeAcceptance(
  acceptance: MissionLedger["acceptance"],
): MissionAcceptanceResult | undefined {
  if (
    !acceptance ||
    (acceptance.status !== "pass" &&
      acceptance.status !== "fail" &&
      acceptance.status !== "needs_more_work")
  ) {
    return undefined;
  }
  return {
    status: acceptance.status,
    confidence: acceptance.confidence,
    missing: [...acceptance.missing],
    reasons: [...acceptance.reasons],
    nextAction: acceptance.nextAction,
  };
}

function isAgentRunReceiptOperation(
  operation: string,
): operation is AgentRunReceipt["operation"] {
  return (
    operation === "create" ||
    operation === "create_folder" ||
    operation === "append" ||
    operation === "replace" ||
    operation === "edit" ||
    operation === "highlight" ||
    operation === "restore" ||
    operation === "retitle" ||
    operation === "rename_current_file" ||
    operation === "link_related_notes" ||
    operation === "move" ||
    operation === "trash" ||
    operation === "delete"
    || operation === "read"
    || operation === "list"
    || operation === "search"
    || operation === "update"
    || operation === "archive"
    || operation === "unarchive"
    || operation === "unlink"
    || operation === "validate"
    || operation === "promote"
    || operation === "merge"
    || operation === "execute"
    || operation === "install"
    || operation === "commit"
    || operation === "integrate"
    || operation === "publish"
    || operation === "link"
  );
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function extractTokenUsageFields(raw: unknown): Partial<AgentRunMetricEvent> {
  const records = Array.isArray(raw) ? raw : [raw];
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }

    const promptEvalCount = getNumber(record.prompt_eval_count);
    const evalCount = getNumber(record.eval_count);

    if (promptEvalCount !== undefined) {
      promptTokens = promptEvalCount;
    }

    if (evalCount !== undefined) {
      completionTokens = evalCount;
    }
  }

  const totalTokens =
    promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function measureSerializedChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
