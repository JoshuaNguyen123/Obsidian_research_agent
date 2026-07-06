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
  MAX_AGENT_STEPS,
  MAX_INITIAL_CURRENT_NOTE_CHARS,
} from "./tools/constants";
import { getErrorMessage, serializeToolResult } from "./tools/validation";
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
import {
  analyzeGeneratedOutputPrompt,
} from "./agent/generatedOutputPolicy";
import {
  analyzeCurrentNoteResetPrompt,
  isCurrentNoteReplaceResetPrompt,
} from "./agent/currentNoteResetPolicy";
import { planLoopBudget } from "./agent/loopPlanner";
import {
  decideNextLoopAction,
  type LoopLedger,
} from "./agent/loopDecision";
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
  setLedgerNextAction,
  setLedgerAcceptance,
  setLedgerLastSafeStep,
  summarizeMissionLedger,
  updateMissionLedgerStatus,
  upsertLedgerEvidence,
  writeMissionLedger,
  type MissionLedger,
  type MissionLedgerStatus,
  type MissionLedgerSummary,
} from "./agent/missionLedger";
import {
  evidenceFromReceipt,
  evidenceFromToolResult,
} from "./agent/missionEvidence";
import { retitleNoteMarkdown } from "./tools/noteTitles";
import {
  buildMissionResumeContext,
} from "./agent/missionResume";
import {
  evaluateMissionAcceptance,
  formatMissionAcceptanceCorrection,
  type MissionAcceptanceResult,
} from "./agent/missionAcceptance";
import {
  classifyStructuredIntent,
  formatStructuredIntentForPrompt,
} from "./agent/intent/structuredIntent";
import {
  appendAgentRunCheckpoint,
  createAgentRunId,
  type LatestAgentRunCheckpoint,
  readLatestAgentRunCheckpoint,
} from "./agent/checkpoints";
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

export { MAX_AGENT_STEPS } from "./tools/constants";
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
  toolName: string;
  operation:
    | "create"
    | "create_folder"
    | "append"
    | "replace"
    | "edit"
    | "retitle"
    | "link_related_notes"
    | "move"
    | "trash"
    | "delete";
  message: string;
  path?: string;
  toPath?: string;
  backupPath?: string;
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
  route: RunRoute;
  expectedTimeClass: RunPlan["expectedTimeClass"];
  maxStepsForRun: number;
  slowPathReason: SlowPathReason;
  englishGuard: boolean;
  temperature?: number;
  topK?: number;
  topP?: number;
  numCtx?: number;
  writeAutonomy: boolean;
  missionMode: AgentMissionMode;
  contextScope: AgentRunContextScope;
  currentNoteContext: boolean;
  vaultContext: boolean;
  maxSteps: number;
  autonomyScope: AutonomyScope;
  missionLedger?: MissionLedgerSummary;
  modelProvider?: string;
  reflexLabel?: string;
  reflexConfidence?: number;
  reflexTopAction?: string;
  reflexProgressScore?: number;
  reflexLoopRisk?: number;
  reflexCompletionMissing?: string[];
  reflexAppliedReason?: string;
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

export type RunRoute =
  | "instant_local"
  | "direct_writeback"
  | "prefetched_vault_answer"
  | "prefetched_vault_writeback"
  | "single_model_answer"
  | "single_model_writeback"
  | "tool_required"
  | "grounded_workflow";

export type SlowPathReason =
  | "none"
  | "needs_current_note"
  | "needs_web_sources"
  | "needs_vault_context"
  | "needs_graph_context"
  | "needs_word_count"
  | "needs_edit_or_replace"
  | "needs_model_planning";

export type RunWritebackMode =
  | "off"
  | "tool_write"
  | "streaming_current_note"
  | "streaming_after_tools";

export interface RunPlan {
  route: RunRoute;
  maxStepsForRun: number;
  thinking: ModelThink | undefined;
  allowedTools: ModelToolDefinition[];
  slowPathReason: SlowPathReason;
  expectedTimeClass: "quick" | "normal" | "long";
  requiresEnglishGuard: boolean;
}

export type AgentRunContextScope =
  | "none"
  | "current_note"
  | "vault"
  | "vault_and_current_note";

export type AgentTraceKind =
  | "status"
  | "mission_intent"
  | "allowed_tools"
  | "model_call"
  | "tool_start"
  | "tool_result"
  | "tool_rejected"
  | "receipt"
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
  onTrace?: (event: AgentTraceEvent) => void;
}

interface RunAgentMissionOptions {
  prompt: string;
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  conversationHistory?: AgentConversationMessage[];
  events?: AgentRunEvents;
  abortSignal?: AbortSignal;
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
6. For title, heading, rename, retitle, organize, restructure, or improve requests, use retitle_current_file for title changes instead of appending a new H1.
7. Do not append duplicate H1 titles. Updating the markdown H1 is separate from renaming the file; suggest file renames in the final answer only when the tool returns a suggestion.
8. Prefer append_to_current_file only for explicit append/add/insert requests that do not replace an existing title or section.
9. Use edit_current_section when the user asks to edit, revise, update, rewrite, or replace a heading section.
10. Use append_to_current_section when the user asks to write, add, append, or insert content below, under, after, or inside a named heading section.
11. Only request replace_current_file when the user explicitly asks to rewrite, replace, clean up, reset, start fresh, overwrite the whole current note, or clear/delete page content and then write new content.
12. Treat whole-note/essay/body/paragraph revision requests as current-note replacement with backup. Use edit_current_section only when the user names a heading or section.
13. Only request delete_current_file when the user explicitly asks to delete, remove, or trash the current note. Treat "delete all notes on the page and write..." as replacing current page content, not trashing the note.
14. Use list_current_folder before broad vault traversal when the mission depends on where the active note lives.
15. Use list_folder and get_path_info to inspect vault folder structure before making path-based file changes.
16. Use path-based CRUD tools only for explicit file or folder create, append, replace, move, rename, delete, remove, or trash requests.
17. For vault context questions, including "what do you know about me", inspect note contents before answering. Do not rely on filenames or note titles because notes may be untitled. Start with list_current_folder when the active note's location may matter, then use list_markdown_files, search_markdown_files, read_markdown_files, read_file, list_folder, or get_path_info as needed. Cite vault-relative source paths in the final answer.
18. For durable research memory, use search_research_memory/read_research_memory before continuing a remembered topic, and append_research_memory when the user asks to save, remember, persist, or build durable topic memory.
19. For graph, backlink, related-note, or note-connection questions, use graph/search tools before answering. Separate explicit Obsidian links/backlinks from inferred semantic relationships and cite vault-relative note paths.
20. For note/file word-count or length-check questions, call count_words and answer from the tool result.
21. Do not write to notes for a vault context answer unless the user asks to save, write, update, create, move, rename, delete, connect, link, graph, or remember something.
22. When you need tools, request tools without writing user-facing prose or preambles.
23. When the mission is expected to produce note output, choose the safest useful write tool instead of only answering in chat.
24. If a date calculation is missing a year or reference date, ask one concise clarifying question instead of guessing.
25. Ask one concise clarifying question when the mission is impossible, dangerous, destructive, missing required credentials, or lacks a required target/value that tools cannot discover. Do not ask when you can proceed safely from vault context, defaults, or available tools.
26. When you have enough context and no note write is required, stop requesting tools and write the final answer.
27. If a web tool fails, explain that web access failed and include the tool error instead of inventing sourced facts.
28. Default to English for English user missions. Use another language only when the current user mission is written primarily in that language or explicitly requests it.
29. Use template tools only when the user asks to create, list, read, use, apply, or fill templates. Saved templates live in the configured template folder and use {{field}} placeholders.
30. When filling a template, prefer fill_template over generic file creation. Use templateText for ad hoc templates supplied in the mission, or templatePath for saved templates.
31. For conceptual vault questions, first inspect the semantic index when available, then call semantic_search_notes for ranked evidence before broad file reads. Use exact path/title/heading tools for exact requests. Never use semantic index tools for delete, move, replace, or direct write-only requests. Treat index summaries as navigation aids; cite and rely on source note paths.
32. Stay on the user's requested topic and task. Do not substitute unrelated coding problems, examples, translations, or template answers.`;

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
  return /^\s*(continue|go on|go ahead|keep going|keep exploring|keep searching|read it|check it|do that|do it|please do|yes|ok|okay)\.?\s*$/i.test(
    prompt,
  );
}

function isRevisionApprovalFollowup(prompt: string): boolean {
  const normalized = prompt.trim();
  return (
    /^(go ahead|do it|do that|please do|yes|ok|okay)\b[\s\S]{0,80}\b(revise|edit|update|rewrite|expand|improve|iterate|change|make)\b/i.test(
      normalized,
    ) ||
    /^(go ahead|do it|do that|please do|yes|ok|okay)\.?\s*$/i.test(
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
  modelClient,
  toolRegistry,
  toolContext,
  enableStreaming,
  conversationHistory = [],
  events = {},
  abortSignal,
}: RunAgentMissionOptions): Promise<void> {
  const runStartedAt = nowMs();
  const runId = createAgentRunId(toolContext.now?.() ?? new Date());
  const runtimeCache = createRuntimeCache();
  let activeThink = resolveThinkingMode(toolContext.settings);
  const intentPrompt = resolvePromptForIntent(prompt, conversationHistory);
  let activeIntentPrompt = intentPrompt;
  let missionIntent = classifyMissionIntent(activeIntentPrompt);
  let writeAutonomy = missionIntent.allowAutonomousWrite;
  let runToolContext: ToolExecutionContext = {
    ...toolContext,
    originalPrompt: activeIntentPrompt,
    runtimeCache,
    reportProgress: (message) => events.onStatus?.(message),
    writeAutonomy,
    missionIntent,
  };
  if (
    shouldFallbackGeneratedNoteOutputToChat(activeIntentPrompt, missionIntent, runToolContext)
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
  const missionEvidenceRecords: MissionEvidence[] = [];
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
  let structuredIntent = classifyStructuredIntent(activeIntentPrompt, missionIntent);
  const modelOptions = buildModelRequestOptions(runToolContext.settings);
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
  if (shouldOmitCurrentNoteReadForTargetOnlyWrite(activeIntentPrompt, missionIntent)) {
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
  const shouldReadCurrentNote = shouldObserveCurrentNote(
    activeIntentPrompt,
    allowedToolNames,
    missionIntent,
  );
  let executedModelTool = false;
  let wroteToNote = false;
  let unavailableToolCorrectionUsed = false;
  let vaultTraversalCorrectionUsed = false;
  let webResearchCorrectionUsed = false;
  let toolBeforeWriteCorrectionUsed = false;
  let consecutiveNoProgressSteps = 0;
  let lastProgressSignature = "";
  let lastStep = 0;
  let executedWebSearchTool = false;
  let executedWebFetchTool = false;
  const successfulToolNames: string[] = [];
  const failedToolNames: string[] = [];
  const writeReceipts: AgentRunReceipt[] = [];
  let preparedStreamingSectionEdit: PreparedStreamingSectionEdit | null = null;
  let missionLedger: MissionLedger | null = null;
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
      missionIntent,
      currentNoteContext: shouldReadCurrentNote,
      runPlan,
      streamingWritebackKind,
      directCurrentNoteWritebackKind,
      missionLedger: undefined,
      reflexOutput,
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
    writeAutonomy = missionIntent.allowAutonomousWrite;
    runToolContext = {
      ...toolContext,
      originalPrompt: activeIntentPrompt,
      runtimeCache,
      reportProgress: (message) => events.onStatus?.(message),
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
        missionIntent,
        currentNoteContext: true,
        runPlan,
        streamingWritebackKind,
        directCurrentNoteWritebackKind,
        missionLedger: undefined,
        reflexOutput,
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

  const finalAnswerRelevancePrompt = getFinalAnswerRelevancePrompt(
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
  const generatedOutputPolicy = analyzeGeneratedOutputPrompt(activeIntentPrompt);
  const loopBudgetPlan = planLoopBudget({
    prompt: activeIntentPrompt,
    route: runPlan.route,
    generated: generatedOutputPolicy,
    configuredMaxSteps: getConfiguredMaxAgentSteps(runToolContext.settings),
    requestedSteps: parseExplicitModelStepTarget(activeIntentPrompt),
  });
  const operationGoals = createMissionOperationGoals({
    prompt: activeIntentPrompt,
    allowedToolNames,
    requiredWriteTools,
    streamingWritebackKind,
  });
  if (currentNoteContext !== null) {
    markOperationGoalDone(operationGoals, "read_current_note");
  }
  missionLedger = createMissionLedger({
    runId,
    mission: activeIntentPrompt,
    route: runPlan.route,
    loopBudget: loopBudgetPlan,
    now: runToolContext.now?.() ?? new Date(),
  });
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
        missionIntent,
        currentNoteContext: shouldReadCurrentNote || currentNoteContext !== null,
        runPlan,
        streamingWritebackKind,
        directCurrentNoteWritebackKind,
        missionLedger: summarizeMissionLedger(missionLedger),
        reflexOutput,
      }),
    );
  };
  const persistMissionLedger = async (traceId: string) => {
    if (!missionLedger) {
      return;
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
  };
  const evaluateCurrentAcceptance = (
    finalOutput?: string,
  ): MissionAcceptanceResult => {
    return evaluateMissionAcceptance({
      prompt: activeIntentPrompt,
      missionIntent,
      requiredTools: [...new Set(requiredWriteTools)],
      successfulTools: successfulToolNames,
      failedTools: failedToolNames,
      evidence: missionEvidenceRecords,
      receipts: writeReceipts,
      finalOutput,
      operationGoals: operationGoals.goals,
    });
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
      acceptance.missing.some(
        (item) => item.startsWith("pending_goal:") || item.startsWith("failed_goal:"),
      )
    ) {
      return requiredWriteTools.some((toolName) => allowedToolNames.has(toolName));
    }

    if (missing.has("web_evidence")) {
      return allowedToolNames.has("web_search") || allowedToolNames.has("web_fetch");
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
  const recordMissionAcceptance = async (
    acceptance: MissionAcceptanceResult,
    step: number,
  ) => {
    events.onTrace?.({
      id: `mission-acceptance-${step}`,
      kind: "status",
      step,
      message: `Mission acceptance: ${acceptance.status}`,
      outputPreview: acceptance,
    });
    if (!missionLedger) {
      return;
    }
    setLedgerAcceptance(
      missionLedger,
      acceptance,
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
  const finishRun = async (
    stopReason: AgentRunStopReason,
    step: number,
    maxSteps = runPlan.maxStepsForRun,
    nextAction?: string,
  ) => {
    const acceptance = evaluateCurrentAcceptance();
    await recordMissionAcceptance(acceptance, step);
    if (missionLedger) {
      updateMissionLedgerStatus(
        missionLedger,
        acceptance.status === "fail" &&
          (stopReason === "final" || stopReason === "write_completed")
          ? "blocked"
          : getMissionLedgerStatusForStopReason(stopReason),
        runToolContext.now?.() ?? new Date(),
      );
      setLedgerNextAction(
        missionLedger,
        nextAction ??
          acceptance.nextAction ??
          getStopReasonMessage(stopReason),
        runToolContext.now?.() ?? new Date(),
      );
      await persistMissionLedger(`mission-ledger-complete-${stopReason}`);
    }
    completeRun(events, stopReason, step, runStartedAt, maxSteps);
  };
  const recordLedgerToolResult = async (
    toolName: string,
    result: ToolExecutionResult,
    step: number,
  ) => {
    if (!missionLedger || !result.ok) {
      return;
    }
    const evidence = evidenceFromToolResult(toolName, result);
    markLedgerToolUsed(
      missionLedger,
      toolName,
      evidence?.id,
      runToolContext.now?.() ?? new Date(),
    );
    if (evidence) {
      missionEvidenceRecords.push(evidence);
      upsertLedgerEvidence(
        missionLedger,
        evidence,
        runToolContext.now?.() ?? new Date(),
      );
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
    addLedgerReceipt(
      missionLedger,
      evidence.id,
      runToolContext.now?.() ?? new Date(),
    );
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
    addLedgerBlocker(
      missionLedger,
      blocker,
      runToolContext.now?.() ?? new Date(),
    );
  };
  const runObservedModelToolCall = async ({
    origin,
    toolCall,
    step,
    toolIndex,
  }: {
    origin: "model" | "runner";
    toolCall: ModelToolCall;
    step: number;
    toolIndex: number | "runner";
  }): Promise<ToolExecutionResult> => {
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

    const result = await executeToolWithMetrics({
      toolRegistry,
      toolCall,
      toolContext: runToolContext,
      events,
      step,
    });

    executedModelTool = true;
    const recordedToolCall = appendToolTranscript({
      messages,
      toolCall,
      resultContent: serializeToolResult(result),
      origin,
      fallbackId: `call_${runId}_${step}_${toolIndex}_${toolCall.name}`.replace(
        /[^A-Za-z0-9_-]/g,
        "_",
      ),
    });
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

      const receipt = buildReceipt(toolCall.name, result.output);
      if (receipt) {
        writeReceipts.push(receipt);
        events.onReceipt?.(receipt);
        await recordLedgerReceipt(receipt, step);
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

      if (isWriteToolName(toolCall.name)) {
        wroteToNote = true;
      }
    } else {
      failedToolNames.push(toolCall.name);
      events.onStatus?.(`Tool returned error: ${toolCall.name}`);
      events.onToolDone?.({
        ...toolEventBase,
        ok: false,
        message: `Tool returned error: ${toolCall.name}`,
        error: result.error,
      });
      events.onTrace?.({
        id: `${toolEventBase.id}:result`,
        kind: "tool_result",
        step,
        toolName: toolCall.name,
        message: `Tool returned error: ${toolCall.name}`,
        error: result.error,
        outputPreview: truncateTracePayload(result),
      });
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
            max_results: 3,
          },
        },
        step,
        toolIndex: "runner",
      });
      searchOutput = result.output;
    }

    if (
      missingToolNames.includes("web_fetch") &&
      allowedToolNames.has("web_fetch") &&
      !executedWebFetchTool
    ) {
      const url = getFirstWebSearchResultUrl(
        searchOutput ?? getLatestToolOutput(messages, "web_search"),
      );
      if (!url) {
        events.onStatus?.(
          "Web fallback could not find a safe result URL to fetch.",
        );
        return false;
      }

      await runObservedModelToolCall({
        origin: "runner",
        toolCall: {
          name: "web_fetch",
          arguments: { url },
        },
        step,
        toolIndex: "runner",
      });
    }

    return getMissingRequiredWebToolNames({
      prompt: activeIntentPrompt,
      allowedToolNames,
      executedWebSearchTool,
      executedWebFetchTool,
    }).length === 0;
  };
  await persistMissionLedger("mission-ledger-start");

  const compactedConversation =
    compactConversationForPrompt(conversationHistory);
  const conversationMessages =
    toCompactedConversationModelMessages(compactedConversation);

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
    ...(checkpointResumeContext === null
      ? []
      : [
          {
            role: "system" as const,
            content: checkpointResumeContext,
          },
        ]),
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
    emitDirectAssistantAnswer(
      buildInstantLocalAnswer(activeIntentPrompt, runToolContext),
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
        expectedTimeClass: "normal",
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
      receipt = await streamCurrentNoteWriteback({
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
      receipt = await streamCurrentNoteWriteback({
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
      receipt = await streamCurrentNoteWriteback({
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
  const stepLimit = Math.min(runPlan.maxStepsForRun, MAX_AGENT_STEPS);

  for (let step = 1; step <= stepLimit; step += 1) {
    if (stopIfRequested(step)) {
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
    events.onPlanningDelta?.(
      [
        `Step ${step}/${stepLimit}`,
        `route=${runPlan.route}`,
        `reason=${runPlan.slowPathReason}`,
        `tool_budget=${loopBudgetPlan.toolStepBudget}`,
        `finalization_reserved=${loopBudgetPlan.finalizationReserve}`,
        `tools=${Array.from(allowedToolNames).join(", ") || "none"}`,
      ].join("; "),
    );

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
      throw error;
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
        if (requireToolBeforeStreamingWriteback && !executedModelTool) {
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
          receipt = await streamCurrentNoteWriteback({
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
          });
        } catch (error) {
          if (stopIfRequested(step)) {
            return;
          }
          throw error;
        }
        if (stopIfRequested(step)) {
          return;
        }
        markStreamingWritebackGoalDone(operationGoals, streamingWritebackKind);
        writeReceipts.push(receipt);
        events.onReceipt?.(receipt);
        await recordLedgerReceipt(receipt);
        await finishRun("write_completed", lastStep, stepLimit);
        return;
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
        receipts: writeReceipts,
        settings: runToolContext.settings,
        embeddingProvider: runToolContext.semanticEmbeddingProvider,
      });
      if (
        runToolContext.settings?.agenticReflexEnabled === true &&
        !reflexOutput.completion.complete
      ) {
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

        const message = `I could not complete the mission because required evidence is missing: ${reflexOutput.completion.missing.join(", ")}. No additional vault files were changed.`;
        emitDirectAssistantAnswer(message, events, runPlan.requiresEnglishGuard);
        recordLedgerBlocker(message);
        await finishRun("error", lastStep, stepLimit);
        return;
      }

      const acceptanceBeforeFinal = evaluateCurrentAcceptance();
      await recordMissionAcceptance(acceptanceBeforeFinal, step);
      if (
        shouldContinueForMissionAcceptance(
          acceptanceBeforeFinal,
          step,
          stepLimit,
        )
      ) {
        if (step < stepLimit) {
          events.onStatus?.(
            `Mission acceptance missing: ${acceptanceBeforeFinal.missing.join(", ")}.`,
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
          await emitFinalAnswer({
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
          });
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
        emitDirectAssistantAnswer(
          directContent,
          events,
          runPlan.requiresEnglishGuard,
        );
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

    for (let toolIndex = 0; toolIndex < responseToolCalls.length; toolIndex += 1) {
      if (stopIfRequested(step)) {
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
          content: serializeToolResult({
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
        continue;
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
        throw error;
      }
    }

    if (stopIfRequested(step)) {
      return;
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
    });
    const pendingStreamingWriteback =
      hasPendingStreamingWritebackGoal(operationGoals, streamingWritebackKind);
    const writeMissionComplete =
      completedAnyWrite &&
      pendingRequiredWriteToolsAfterToolUse.length === 0 &&
      missingRequiredWebToolsAfterToolUse.length === 0 &&
      !pendingStreamingWriteback;
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

    if (writeMissionComplete) {
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

    const loopLedger: LoopLedger = {
      successfulTools: [...successfulToolNames],
      failedTools: [...failedToolNames],
      repeatedToolCalls: consecutiveNoProgressSteps,
      requiredToolsSatisfied: areLoopRequiredToolsSatisfied(
        loopBudgetPlan.expectedTools,
        successfulToolNames,
      ),
      finalizationReserved: loopBudgetPlan.finalizationReserve > 0,
      writeCompleted: writeMissionComplete,
    };
    const loopDecision = decideNextLoopAction(loopLedger, loopBudgetPlan);
    if (
      loopDecision.action === "force_final_no_tools" &&
      pendingRequiredWriteToolsAfterToolUse.length === 0 &&
      (!completedAnyWrite || !missionComplete) &&
      step < stepLimit
    ) {
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

type StreamingWritebackKind = "append" | "replace" | "edit";

const LIVE_FLUSH_CHAR_THRESHOLD = 120;
const LIVE_FLUSH_MS = 150;
const LIVE_FLUSH_TIMER_MS = 75;

type OperationGoal =
  | "read_current_note"
  | "web_search"
  | "web_fetch"
  | "current_note_title"
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
    events.onStatus?.(`Tool returned error: ${name}`);
    events.onToolDone?.({
      ...toolEventBase,
      ok: false,
      message: `Tool returned error: ${name}`,
      error: result.error,
    });
    events.onTrace?.({
      id: `${toolEventBase.id}:result`,
      kind: "tool_result",
      step,
      toolName: name,
      message: `Tool returned error: ${name}`,
      error: result.error,
      outputPreview: truncateTracePayload(result),
    });
    throw new Error(result.error?.message ?? `Tool returned error: ${name}`);
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
}): Promise<string | null> {
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
      events.onStatus?.(`Loaded mission ledger ${missionResume.path} for resume context...`);
      events.onTrace?.({
        id: "mission-ledger-resume",
        kind: "status",
        path: missionResume.path,
        message: `Loaded mission ledger ${missionResume.path} for resume context.`,
        outputPreview: {
          runId: missionResume.ledger.runId,
          status: missionResume.ledger.status,
          evidenceCount: missionResume.ledger.evidence.length,
          nextActions: missionResume.ledger.nextActions,
          plan: missionResume.plan,
        },
      });
      return missionResume.promptContext;
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
    return formatCheckpointResumeContext(checkpoint);
  } catch (error) {
    events.onTrace?.({
      id: "checkpoint-resume:error",
      kind: "error",
      message: `Could not load checkpoint resume context: ${getUnknownErrorMessage(error)}`,
      error: {
        code: "checkpoint_resume_failed",
        message: getUnknownErrorMessage(error),
      },
    });
    return null;
  }
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
  missionIntent,
  currentNoteContext,
  runPlan,
  streamingWritebackKind,
  directCurrentNoteWritebackKind,
  missionLedger,
  reflexOutput,
}: {
  runId: string;
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  activeThink: ModelThink | undefined;
  modelOptions: ModelRequestOptions | undefined;
  writeAutonomy: boolean;
  missionIntent: MissionIntent;
  currentNoteContext: boolean;
  runPlan: RunPlan;
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
  missionLedger?: MissionLedgerSummary;
  reflexOutput?: AgenticReflexOutput;
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
    route: runPlan.route,
    expectedTimeClass: runPlan.expectedTimeClass,
    maxStepsForRun: runPlan.maxStepsForRun,
    slowPathReason: runPlan.slowPathReason,
    englishGuard: runPlan.requiresEnglishGuard,
    temperature: modelOptions?.temperature,
    topK: modelOptions?.top_k,
    topP: modelOptions?.top_p,
    numCtx: modelOptions?.num_ctx,
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
    if (/"name"\s*:/.test(snippet)) {
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
  const name = getString(value.name);
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
    value.input ??
    {};

  if (isRecord(args)) {
    return args;
  }

  if (typeof args === "string" && args.trim()) {
    const parsedArgs = parseJsonCandidate(args);
    if (isRecord(parsedArgs)) {
      return parsedArgs;
    }
  }

  return {};
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

export function resolveThinkingMode(
  settings: ToolExecutionContext["settings"] | undefined,
): ModelThink | undefined {
  const mode = settings?.thinkingMode ?? "auto";

  if (mode === "off") {
    return undefined;
  }

  if (mode !== "auto") {
    return mode;
  }

  const model = settings?.model?.trim().toLowerCase() ?? "";

  if (!model) {
    return undefined;
  }

  if (model.startsWith("gpt-oss")) {
    return "medium";
  }

  if (
    model.startsWith("qwen3") ||
    model.startsWith("deepseek-r1") ||
    model.startsWith("deepseek-v3.1")
  ) {
    return true;
  }

  return undefined;
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
    const response = await withModelWaitStatus(
      () => modelClient.chat(request),
      events,
      "model API response",
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
      const retryResponse = await withModelWaitStatus(
        () => modelClient.chat(retryRequest),
        events,
        "model API retry",
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
}): Promise<ModelChatResponse | null> {
  if (!enableStreaming) {
    emitDirectAssistantAnswer(fallbackContent, events);
    return null;
  }

  emitStatus(events, "Drafting final answer...", "final_answer");
  events.onFinalStart?.();
  events.onAssistantMessageStart?.();

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

  events.onFinalDone?.();
  events.onAssistantMessageDone?.();
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
  };
}

function isTopicallyRelevant(
  profile: RelevanceProfile,
  content: string,
): boolean {
  if (profile.acceptsCodeOutput && looksLikeCodeAnswer(content)) {
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
    return await withModelWaitStatus(
      () => modelClient.streamChat(request, streamEvents),
      events,
      "streaming model response",
    );
  } catch (error) {
    if (request.think === undefined || !isThinkingUnsupportedError(error)) {
      throw error;
    }

    onThinkingUnsupported();
    return withModelWaitStatus(
      () => modelClient.streamChat({ ...request, think: undefined }, streamEvents),
      events,
      "streaming model retry",
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
  "create_svg_design",
  "create_design_package",
  "memory_write_observation",
  "memory_write_task_summary",
  "memory_write_procedural",
  "memory_write_source",
  "seed_default_templates",
  "create_template",
  "fill_template",
  "create_folder",
  "create_file",
  "append_file",
  "replace_file",
  "move_path",
  "append_to_current_file",
  "append_to_current_section",
  "append_research_memory",
  "compact_research_memory",
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

const TOOL_GOALS: Partial<Record<string, OperationGoal[]>> = {
  read_current_file: ["read_current_note"],
  web_search: ["web_search"],
  web_fetch: ["web_fetch"],
  retitle_current_file: ["current_note_title"],
  append_to_current_file: ["current_note_content"],
  append_to_current_section: ["current_note_content"],
  replace_current_file: ["current_note_replace"],
  prepare_edit_current_section: ["current_section_edit"],
  edit_current_section: ["current_section_edit"],
  create_file: ["path_create"],
  create_folder: ["path_create"],
  append_file: ["path_append"],
  replace_file: ["path_replace"],
  move_path: ["path_move"],
  delete_path: ["path_delete"],
  delete_current_file: ["current_note_delete"],
};

const CODE_TOOL_NAMES = new Set(["run_code_block", "render_html_preview"]);
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
  create_folder: "write",
  create_file: "write",
  append_file: "write",
  replace_file: "edit",
  move_path: "edit",
  append_to_current_file: "write",
  append_to_current_section: "write",
  append_research_memory: "write",
  compact_research_memory: "edit",
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
  create_design_canvas: "write",
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
  const allowReplace =
    hasReplaceIntent(prompt) && (!allowEdit || allowWholeNoteReplace) && !allowDelete;
  const allowRetitle = hasTitleIntent(prompt);
  const allowReflexReadRouting =
    !missionIntent.explicitMutation && !missionIntent.explicitDelete;
  const hasReflexReadLabel = (labels: ReflexDecision["label"][]) =>
    allowReflexReadRouting && hasSafeReflexLabel(reflex, labels);
  const allowWebSearch =
    shouldAllowWebSearch(prompt, missionIntent) || hasReflexReadLabel(["web_research"]);
  const allowCurrentNoteRead =
    hasCurrentNoteReadIntent(prompt) || hasCurrentNoteSectionTarget(prompt);
  const allowWordCount =
    hasWordCountIntent(prompt) || hasReflexReadLabel(["word_count"]);
  const allowGraphContext =
    hasGraphConnectionIntent(prompt) || hasReflexReadLabel(["graph_context"]);
  const allowGraphLinkWrite = hasGraphLinkWriteIntent(prompt);
  const allowTemplateTools = hasTemplateIntent(prompt);
  const allowTemplateSeed = hasTemplateSeedIntent(prompt);
  const allowTemplateCreate = hasTemplateCreateIntent(prompt);
  const allowTemplateFill = hasTemplateFillIntent(prompt);
  const allowResearchMemory = hasResearchMemoryIntent(prompt);
  const allowResearchMemoryWrite = hasResearchMemoryWriteIntent(prompt);
  const allowVaultIndex = hasVaultIndexIntent(prompt);
  const allowSemanticSearch =
    isSemanticSearchEnabled(settings) &&
    (hasConceptualVaultSearchIntent(prompt) ||
      hasReflexReadLabel(["semantic_vault_search", "graph_context"]));
  const allowSemanticIndexInspect =
    isSemanticIndexEnabled(settings) &&
    (hasConceptualVaultSearchIntent(prompt) ||
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
  const allowVaultBrowse =
    missionIntent.vaultContext ||
    hasVaultBrowseIntent(prompt) ||
    allowGraphContext ||
    allowVaultIndex ||
    hasReflexReadLabel(["vault_search", "semantic_vault_search"]);
  const allowSpecificFileRead = hasSpecificFileReadIntent(prompt);
  const allowCreateFile = hasCreateFileIntent(prompt);
  const allowCreateFolder = hasCreateFolderIntent(prompt);
  const allowPathAppend = hasAppendIntent(prompt) && hasPathTargetIntent(prompt);
  const allowPathReplace = hasReplaceIntent(prompt) && hasPathTargetIntent(prompt);
  const allowMovePath = hasMovePathIntent(prompt);
  const preferPathTarget = hasPathTargetIntent(prompt) && !hasCurrentNoteTarget(prompt);
  const allowCurrentNoteOutput = noteOutputIntent && !preferPathTarget;
  const allowAutonomousAppend =
    allowCurrentNoteOutput &&
    !allowWholeNoteReplace &&
    !allowEdit &&
    !allowDelete &&
    (!allowRetitle || !hasTitleOnlyIntent(prompt));

  return toolRegistry.getDefinitions().filter((definition) => {
    const name = definition.function.name;

    if (!isAllowedForMission(name, prompt, missionIntent, reflex)) {
      return false;
    }

    if (name === "web_search" || name === "web_fetch") {
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

    if (name === "run_code_block") {
      return allowCodeExecution;
    }

    if (name === "render_html_preview") {
      return allowHtmlPreview;
    }

    if (name === "create_design_canvas") {
      return allowDesignTools && allowCanvasDesign && !allowDesignPackage;
    }

    if (name === "create_svg_design") {
      return allowDesignTools && allowSvgDesign;
    }

    if (name === "create_design_package") {
      return allowDesignTools && allowDesignPackage;
    }

    if (name === "read_current_file") {
      return (
        missionIntent.vaultContext ||
        allowCurrentNoteRead ||
        allowCurrentNoteOutput
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

    if (name === "append_to_current_file") {
      return (
        (allowAppend || allowAutonomousAppend) &&
        !preferPathTarget &&
        !hasTitleOnlyIntent(prompt) &&
        !allowSectionAppend &&
        !allowEdit &&
        !allowDelete
      );
    }

    if (name === "retitle_current_file") {
      return allowRetitle && !preferPathTarget && !allowEdit && !allowDelete;
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
}

function isAllowedForMission(
  name: string,
  prompt: string,
  intent: MissionIntent,
  reflex: ReflexDecision | null = null,
): boolean {
  if (!isToolWithinAutonomyScope(name, intent, reflex)) {
    return false;
  }

  if (READ_NAV_TOOL_NAMES.has(name)) {
    return (
      intent.vaultContext ||
      hasVaultBrowseIntent(prompt) ||
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

    if (MEMORY_TOOL_NAMES.has(name)) {
      return hasExperienceMemoryIntent(prompt) || hasResearchMemoryWriteIntent(prompt);
    }

    if (name === "compact_research_memory") {
      return hasResearchMemoryCompactIntent(prompt);
    }

    return intent.noteOutput || intent.explicitMutation || hasResearchMemoryWriteIntent(prompt);
  }

  if (name === "web_search" || name === "web_fetch") {
    return hasWebSearchIntent(prompt) || hasSafeReflexLabel(reflex, ["web_research"]);
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
  intent: MissionIntent,
  reflex: ReflexDecision | null = null,
): boolean {
  const scope = intent.autonomyScope;
  if (intent.explicitMutation && isBroadUnscopedVaultMutation(scope)) {
    return !WRITE_TOOL_NAMES.has(name) && !DELETE_TOOL_NAMES.has(name);
  }

  if (name === "web_search" || name === "web_fetch") {
    return scope.read.web || hasSafeReflexLabel(reflex, ["web_research"]);
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
    name === "create_svg_design" ||
    name === "create_design_package"
  ) {
    return scope.write.artifacts;
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
    name === "prepare_edit_current_section" ||
    name === "edit_current_section" ||
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
  streamingWritebackKind,
}: {
  prompt: string;
  allowedToolNames: Set<string>;
  requiredWriteTools: string[];
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
  if (operationGoals.goals[goal] !== "not_requested") {
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
}

function markStreamingWritebackGoalDone(
  operationGoals: MissionOperationGoals,
  kind: StreamingWritebackKind,
) {
  if (kind === "append") {
    markOperationGoalDone(operationGoals, "current_note_content");
  } else if (kind === "replace") {
    markOperationGoalDone(operationGoals, "current_note_replace");
  } else {
    markOperationGoalDone(operationGoals, "current_section_edit");
  }
}

function isMissionComplete(operationGoals: MissionOperationGoals): boolean {
  return Object.values(operationGoals.goals).every(
    (state) => state === "not_requested" || state === "done",
  );
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
  return requiredWriteTools.filter((toolName) => !completed.has(toolName));
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

  const preferPathTarget = hasPathTargetIntent(prompt) && !hasCurrentNoteTarget(prompt);

  if (streamingWritebackKind === "edit") {
    requiredToolNames.push("prepare_edit_current_section");
  }

  if (hasSectionAppendIntent(prompt)) {
    requiredToolNames.push("append_to_current_section");
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

  if (hasDesignIntent(prompt)) {
    if (hasDesignPackageIntent(prompt)) {
      requiredToolNames.push("create_design_package");
    } else if (hasCanvasDesignIntent(prompt)) {
      requiredToolNames.push("create_design_canvas");
    }

    if (hasSvgDesignIntent(prompt)) {
      requiredToolNames.push("create_svg_design");
    }
  }

  if (hasTitleIntent(prompt) && !preferPathTarget) {
    requiredToolNames.push("retitle_current_file");
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
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return null;
  }

  for (const result of output.results) {
    if (!isRecord(result) || typeof result.url !== "string") {
      continue;
    }

    const url = result.url.trim();
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
  }

  return null;
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
  return (
    allowedToolNames.has("read_current_file") &&
    requiresCurrentNoteContent(prompt)
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
    (hasPathTargetIntent(prompt) && !hasCurrentNoteTarget(prompt))
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

function createRunPlan({
  prompt,
  missionIntent,
  tools,
  settings,
  streamingWritebackKind,
  directCurrentNoteWritebackKind,
  reflex,
}: {
  prompt: string;
  missionIntent: MissionIntent;
  tools: ModelToolDefinition[];
  settings: ToolExecutionContext["settings"];
  streamingWritebackKind: StreamingWritebackKind | null;
  directCurrentNoteWritebackKind: StreamingWritebackKind | null;
  reflex?: ReflexDecision | null;
}): RunPlan {
  const requiresEnglishGuard = isLikelyEnglishPrompt(prompt);
  const configuredMaxSteps = getConfiguredMaxAgentSteps(settings);
  const explicitModelStepTarget = parseExplicitModelStepTarget(prompt);
  const allowReflexReadRouting =
    !missionIntent.explicitMutation && !missionIntent.explicitDelete;
  const hasReflexReadLabel = (labels: ReflexDecision["label"][]) =>
    allowReflexReadRouting && hasSafeReflexLabel(reflex ?? null, labels);
  const capSteps = (steps: number) =>
    estimateLoopBudget({
      route: "tool_required",
      configuredMaxSteps,
      requestedSteps: steps,
    });
  const applyExplicitModelStepTarget = (steps: number) =>
    explicitModelStepTarget === null ? steps : capSteps(explicitModelStepTarget);

  const plan = ({
    route,
    maxStepsForRun,
    thinking,
    allowedTools,
    slowPathReason,
    expectedTimeClass,
  }: Omit<RunPlan, "requiresEnglishGuard">): RunPlan => ({
    route,
    maxStepsForRun,
    thinking,
    allowedTools,
    slowPathReason,
    expectedTimeClass,
    requiresEnglishGuard,
  });

  const grounded = (
    slowPathReason: SlowPathReason,
    expectedTimeClass: RunPlan["expectedTimeClass"] = "long",
  ) => {
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const loopBudget = planLoopBudget({
      prompt,
      route: "grounded_workflow",
      generated,
      configuredMaxSteps,
    });
    return plan({
      route: "grounded_workflow",
      maxStepsForRun: applyExplicitModelStepTarget(
        Math.max(
          1,
          Math.min(
            loopBudget.hardCap,
            hasLongResearchIntent(prompt)
              ? loopBudget.hardCap
              : loopBudget.toolStepBudget + loopBudget.finalizationReserve,
          ),
        ),
      ),
      thinking: resolveThinkingMode(settings),
      allowedTools: tools,
      slowPathReason,
      expectedTimeClass,
    });
  };

  if (hasSimpleDateTimePrompt(prompt)) {
    return plan({
      route: "instant_local",
      maxStepsForRun: 0,
      thinking: undefined,
      allowedTools: [],
      slowPathReason: "none",
      expectedTimeClass: "quick",
    });
  }

  if (directCurrentNoteWritebackKind !== null) {
    return plan({
      route: "direct_writeback",
      maxStepsForRun: capSteps(1),
      thinking: undefined,
      allowedTools: [],
      slowPathReason: "none",
      expectedTimeClass: "quick",
    });
  }

  if (hasGraphConnectionIntent(prompt) || hasReflexReadLabel(["graph_context"])) {
    return grounded("needs_graph_context", "normal");
  }

  if (shouldPrefetchVaultFolderAnswer(prompt, missionIntent)) {
    return plan({
      route:
        missionIntent.noteOutput && streamingWritebackKind === "append"
          ? "prefetched_vault_writeback"
          : "prefetched_vault_answer",
      maxStepsForRun: capSteps(1),
      thinking: undefined,
      allowedTools: [],
      slowPathReason: "needs_vault_context",
      expectedTimeClass: "quick",
    });
  }

  if (
    hasVaultContextQuestionIntent(prompt) ||
    hasVaultBrowseIntent(prompt) ||
    hasReflexReadLabel(["vault_search", "semantic_vault_search"])
  ) {
    return grounded("needs_vault_context", "normal");
  }

  if (hasWebSearchIntent(prompt) || hasReflexReadLabel(["web_research"])) {
    return grounded("needs_web_sources", "long");
  }

  if (hasLongResearchIntent(prompt) || hasBrowserAutomationIntent(prompt)) {
    return grounded("needs_model_planning", "long");
  }

  if (
    hasDesignIntent(prompt) ||
    hasCodeExecutionIntent(prompt) ||
    hasHtmlPreviewIntent(prompt) ||
    hasOpenWebSourceIntent(prompt)
  ) {
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const loopBudget = planLoopBudget({
      prompt,
      route: "grounded_workflow",
      generated,
      configuredMaxSteps,
    });
    return plan({
      route: "grounded_workflow",
      maxStepsForRun: applyExplicitModelStepTarget(
        Math.max(
          1,
          Math.min(
            loopBudget.hardCap,
            loopBudget.toolStepBudget + loopBudget.finalizationReserve,
          ),
        ),
      ),
      thinking: resolveThinkingMode(settings),
      allowedTools: tools,
      slowPathReason: "needs_model_planning",
      expectedTimeClass: "normal",
    });
  }

  if (hasWordCountIntent(prompt) || hasReflexReadLabel(["word_count"])) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(3),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_word_count",
      expectedTimeClass: "quick",
    });
  }

  if (hasResearchMemoryReadIntent(prompt)) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(2),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_vault_context",
      expectedTimeClass: "quick",
    });
  }

  if (requiresCurrentNoteContent(prompt)) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(2),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: "needs_current_note",
      expectedTimeClass: "quick",
    });
  }

  if (streamingWritebackKind !== null) {
    return plan({
      route: "single_model_writeback",
      maxStepsForRun: capSteps(streamingWritebackKind === "edit" ? 3 : 1),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason:
        streamingWritebackKind === "edit" ? "needs_edit_or_replace" : "none",
      expectedTimeClass: streamingWritebackKind === "edit" ? "normal" : "quick",
    });
  }

  if (missionIntent.explicitMutation || missionIntent.requireWriteCompletion) {
    return plan({
      route: "tool_required",
      maxStepsForRun: capSteps(3),
      thinking: undefined,
      allowedTools: tools,
      slowPathReason: missionIntent.explicitMutation
        ? "needs_edit_or_replace"
        : "needs_model_planning",
      expectedTimeClass: "normal",
    });
  }

  return plan({
    route: "single_model_answer",
    maxStepsForRun: applyExplicitModelStepTarget(capSteps(2)),
    thinking: undefined,
    allowedTools: tools,
    slowPathReason: "none",
    expectedTimeClass: "quick",
  });
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
}: {
  prompt: string;
  allowedToolNames: Set<string>;
  executedWebSearchTool: boolean;
  executedWebFetchTool: boolean;
}): string[] {
  if (!hasWebSearchIntent(prompt)) {
    return [];
  }

  const missing: string[] = [];
  if (allowedToolNames.has("web_search") && !executedWebSearchTool) {
    missing.push("web_search");
  }
  if (
    shouldRequireWebFetchBeforeFinalAnswer(prompt) &&
    allowedToolNames.has("web_fetch") &&
    !executedWebFetchTool
  ) {
    missing.push("web_fetch");
  }

  return missing;
}

function shouldRequireWebFetchBeforeFinalAnswer(prompt: string): boolean {
  return hasFetchedWebSourceIntent(prompt);
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

  const preferPathTarget = hasPathTargetIntent(prompt) && !hasCurrentNoteTarget(prompt);

  if (preferPathTarget) {
    return null;
  }

  if (hasExplicitStreamToCurrentNoteIntent(prompt)) {
    return hasReplaceIntent(prompt) || isCurrentNoteReplaceResetPrompt(prompt)
      ? "replace"
      : "append";
  }

  if (hasWholeNoteReplaceIntent(prompt)) {
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
    (toolContext.missionIntent?.noteOutput &&
      (hasStaticGenerationIntent(prompt) || hasGeneratedWritingIntent(prompt)))
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
    hasTemplateFillIntent(prompt);
  const explicitResearchMemoryWrite = hasResearchMemoryWriteIntent(prompt);
  const explicitDesignWrite = hasDesignIntent(prompt);
  const explicitPersistence =
    hasExplicitWritePersistenceIntent(prompt) ||
    explicitGraphLinkWrite ||
    explicitTemplateWrite ||
    explicitResearchMemoryWrite ||
    explicitDesignWrite;
  const explicitDelete =
    resetAction.kind !== "replace_current_note" &&
    (hasDeleteIntent(prompt) || hasDeletePathIntent(prompt));
  const explicitMutation =
    explicitPersistence ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasWholeNoteRevisionIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasSectionAppendIntent(prompt) ||
    hasTitleIntent(prompt) ||
    explicitGraphLinkWrite ||
    explicitTemplateWrite ||
    explicitResearchMemoryWrite ||
    explicitDesignWrite ||
    explicitDelete;
  const vaultContext =
    hasVaultContextQuestionIntent(prompt) ||
    hasResearchMemoryReadIntent(prompt) ||
    (!explicitMutation && hasVaultBrowseIntent(prompt));
  const webAnswerOnly =
    hasWebSearchIntent(prompt) &&
    generated.target === "chat_only" &&
    !explicitPersistence &&
    !hasCurrentPageWritebackIntent(prompt) &&
    !hasPathTargetIntent(prompt);
  const noteOutput =
    !vaultContext &&
    !explicitResearchMemoryWrite &&
    !webAnswerOnly &&
    (hasNoteOutputIntent(prompt) ||
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

  if (explicitMutation) {
    return buildMissionIntent(prompt, {
      mode: "explicit_file_mutation",
      vaultContext,
      noteOutput,
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
): boolean {
  if (!missionIntent.noteOutput || hasActiveCurrentMarkdownFile(toolContext)) {
    return false;
  }

  const generated = analyzeGeneratedOutputPrompt(prompt);
  return (
    generated.target === "current_note_append" &&
    !hasExplicitWritePersistenceIntent(prompt) &&
    !hasCurrentPageWritebackIntent(prompt) &&
    !hasPathTargetIntent(prompt)
  );
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
  return /\b(create|make|draw|generate|build|draft|render|save|write|map|package)\b[\s\S]{0,160}\b(canvas|design|design\s*package|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flows?|ui\s*flows?|architecture|system\s+design|software\s+architecture|service\s*blueprint|logistics\s*system|project\s*ideation|mind\s*map)\b|\b(canvas|design|design\s*package|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flows?|ui\s*flows?|architecture|system\s+design|software\s+architecture|service\s*blueprint|logistics\s*system|project\s*ideation|mind\s*map)\b[\s\S]{0,160}\b(create|make|draw|generate|build|draft|render|save|write|map|package)\b/i.test(
    prompt,
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
  return (
    /^\s*(continue|keep\s+going|resume|carry\s+on|pick\s+up)\b/i.test(
      prompt,
    ) ||
    /\b(resume|continue|keep\s+going|carry\s+on|pick\s+up)\b[\s\S]{0,120}\b(agent\s+run|mission|checkpoint|previous\s+run|prior\s+run|last\s+run)\b/i.test(
      prompt,
    ) ||
    /\b(agent\s+run|mission|checkpoint|previous\s+run|prior\s+run|last\s+run)\b[\s\S]{0,120}\b(resume|continue|keep\s+going|carry\s+on|pick\s+up)\b/i.test(
      prompt,
    )
  );
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

function hasCurrentNoteTarget(prompt: string): boolean {
  return /\b(current|this|active)\s+(note|file|markdown|document|page)\b|\b(note|file|markdown|document|page)\b[\s\S]{0,40}\b(current|this|active)\b/i.test(
    prompt,
  );
}

function hasNoteOutputIntent(prompt: string): boolean {
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
  if (hasWholeNoteRevisionIntent(prompt)) {
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
  return /\b(edit|revise|update|replace|rewrite)\b[\s\S]{0,80}\b(section|heading)\b|\b(section|heading)\b[\s\S]{0,80}\b(edit|revise|update|replace|rewrite)\b/i.test(
    prompt,
  );
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
  return /\b(move|relocate)\b[\s\S]{0,100}\b(path|file|folder|note|vault|\.md)\b|\b(rename)\b[\s\S]{0,100}\b(path|file|folder|note|vault|\.md)\b|\b(path|file|folder|note|vault|\.md)\b[\s\S]{0,100}\b(move|relocate|rename)\b/i.test(
    prompt,
  );
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

  if (/\b(search|use|check|consult)\s+(?:the\s+)?web\b/i.test(prompt)) {
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
  return /^\s*(what(?:'s| is)?|tell me|give me|show me)?\s*(today'?s\s+)?(current\s+)?(date|time|day)(\s+(today|now|right now))?\??\s*$/i.test(
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
  return /\b(retitle|rename|title|heading|h1)\b|\bcall\s+(?:this|the)\s+note\b|\b(note|file)\b[\s\S]{0,80}\b(organize|restructure|improve)\b|\b(organize|restructure|improve)\b[\s\S]{0,80}\b(note|file)\b/i.test(
    prompt,
  );
}

function hasTitleOnlyIntent(prompt: string): boolean {
  if (!hasTitleIntent(prompt)) {
    return false;
  }

  return !/\b(append|add|insert|write|draft|compose|generate|create|stream|essay|article|paragraph|report|brief|summary|analysis|content)\b/i.test(prompt);
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
  const bytesWritten = getNumber(output.bytesWritten);
  const bytesDeleted = getNumber(output.bytesDeleted);
  const affectedCount = getNumber(output.affectedCount);
  const operation = getReceiptOperation(toolName);
  const messageParts = [`${operation} ${path || "current note"}`];

  if (toPath) {
    messageParts.push(`to: ${toPath}`);
  }

  if (backupPath) {
    messageParts.push(`backup: ${backupPath}`);
  }

  if (affectedCount !== undefined) {
    messageParts.push(`affected: ${affectedCount}`);
  }

  return {
    toolName,
    operation,
    path,
    toPath,
    backupPath,
    bytesWritten,
    bytesDeleted,
    affectedCount,
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
    toolName === "seed_default_templates"
  ) {
    return "create";
  }

  if (
    toolName === "create_template" ||
    toolName === "fill_template"
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
    toolName === "seed_default_templates" ||
    toolName === "create_template" ||
    toolName === "fill_template" ||
    toolName === "create_file" ||
    toolName === "append_file" ||
    toolName === "replace_file" ||
    toolName === "move_path" ||
    toolName === "delete_path" ||
    toolName === "append_to_current_file" ||
    toolName === "append_to_current_section" ||
    toolName === "append_research_memory" ||
    toolName === "compact_research_memory" ||
    toolName === "delete_research_memory_entry" ||
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
}): Promise<AgentRunReceipt> {
  const writer = await createStreamingNoteWriter({
    kind,
    toolContext,
    preparedSectionEdit,
  });

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
): string {
  const retryPrefix = retry
    ? [
        "The previous writeback stream returned no writable markdown or incomplete markdown.",
        "Return the complete requested markdown content now.",
      ]
    : [];

  if (kind === "append") {
    return [
      ...retryPrefix,
      "Write the markdown content to append to the current note now.",
      "Use English unless the user explicitly requested another language in the current mission.",
      FINAL_ENGLISH_ONLY_RULE,
      "Return only the markdown that should be appended.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

  if (kind === "replace") {
    return [
      ...retryPrefix,
      "Write the full replacement markdown for the current note now.",
      "Use English unless the user explicitly requested another language in the current mission.",
      FINAL_ENGLISH_ONLY_RULE,
      "Return only the complete replacement note content.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

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
}: {
  kind: StreamingWritebackKind;
  toolContext: ToolExecutionContext;
  preparedSectionEdit: PreparedStreamingSectionEdit | null;
}) {
  const file = getActiveMarkdownFile(toolContext);
  const current =
    toolContext.getCurrentMarkdownContent?.(file) ??
    (await toolContext.app.vault.read(file));
  const makeAppendBase = (content: string) =>
    `${content}${content.length > 0 && !content.endsWith("\n") ? "\n" : ""}`;
  const getLatestAppendBaseSource = () =>
    toolContext.getCurrentMarkdownContent?.(file) ?? current;
  const makeRetitledAppendBase = (title: string) =>
    makeAppendBase(retitleNoteMarkdown(getLatestAppendBaseSource(), title));
  let baseContent = kind === "append" ? makeAppendBase(current) : "";
  let baseContentChanged = false;
  let leadingTitleBuffer: string | null = kind === "append" ? "" : null;
  const backupPath =
    kind === "replace"
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
    toolContext.setCurrentMarkdownContent?.(file, content);
    await toolContext.app.vault.modify(file, content);
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
        (options.force || pendingChars > 0)
      ) {
        queueFlush();
      }
      await flushChain;
    },
    buildReceipt(partial: boolean): AgentRunReceipt {
      const operation =
        kind === "append" ? "append" : kind === "replace" ? "replace" : "edit";
      const bytesWritten =
        kind === "append" ? getByteLength(streamedContent) : getByteLength(render());
      const output = {
        path: file.path,
        operation,
        backupPath,
        bytesWritten,
        streamed: true,
        partial,
        heading: section?.heading,
        level: section?.level,
      };

      const messageParts = [`${operation} ${file.path}`];
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
        path: file.path,
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

function getToolCacheKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
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
