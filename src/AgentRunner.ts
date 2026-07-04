import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatMessage,
  ModelClient,
  ModelChatStreamEvents,
  ModelToolCall,
  ModelRequestOptions,
  ModelThink,
} from "./model/types";
import { ModelClientError } from "./model/types";
import type {
  AgentMissionMode,
  MissionIntent,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./tools/types";
import {
  BACKUP_FOLDER,
  MAX_AGENT_STEPS,
  MAX_INITIAL_CURRENT_NOTE_CHARS,
} from "./tools/constants";
import { serializeToolResult } from "./tools/validation";
import {
  toConversationModelMessages,
  type AgentConversationMessage,
} from "./conversationHistory";
import { countMarkdownVisibleText } from "./tools/wordCount";

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
  requestChars?: number;
  responseChars?: number;
  inputChars?: number;
  outputChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentRunConfigEvent {
  model: string;
  base: string;
  streaming: boolean;
  thinkingMode: string;
  resolvedThink: string;
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
  onFinalDone?: () => void;
  onReceipt?: (receipt: AgentRunReceipt) => void;
  onAssistantMessageStart?: () => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantMessageDone?: () => void;
  onThinkingMessageStart?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onThinkingMessageDone?: () => void;
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
10. Only request replace_current_file when the user explicitly asks to rewrite, replace, clean up, reset, start fresh, or overwrite the whole current note.
11. Only request delete_current_file when the user explicitly asks to delete, remove, or trash the current note.
12. Use list_current_folder before broad vault traversal when the mission depends on where the active note lives.
13. Use list_folder and get_path_info to inspect vault folder structure before making path-based file changes.
14. Use path-based CRUD tools only for explicit file or folder create, append, replace, move, rename, delete, remove, or trash requests.
15. For vault context questions, including "what do you know about me", inspect note contents before answering. Do not rely on filenames or note titles because notes may be untitled. Start with list_current_folder when the active note's location may matter, then use list_markdown_files, search_markdown_files, read_markdown_files, read_file, list_folder, or get_path_info as needed. Cite vault-relative source paths in the final answer.
16. For graph, backlink, related-note, or note-connection questions, use graph/search tools before answering. Separate explicit Obsidian links/backlinks from inferred semantic relationships and cite vault-relative note paths.
17. For note/file word-count or length-check questions, call count_words and answer from the tool result.
18. Do not write to notes for a vault context answer unless the user asks to save, write, update, create, move, rename, delete, connect, link, or graph something.
19. When you need tools, request tools without writing user-facing prose or preambles.
20. When the mission is expected to produce note output, choose the safest useful write tool instead of only answering in chat.
21. If a date calculation is missing a year or reference date, ask one concise clarifying question instead of guessing.
22. When you have enough context and no note write is required, stop requesting tools and write the final answer.
23. If a web tool fails, explain that web access failed and include the tool error instead of inventing sourced facts.
24. Default to English for English user missions. Use another language only when the current user mission is written primarily in that language or explicitly requests it.
25. Stay on the user's requested topic and task. Do not substitute unrelated coding problems, examples, translations, or template answers.`;

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
  ].join(" ");
}

function getFinalAnswerRelevancePrompt(
  prompt: string,
  currentNoteContext: unknown,
): string {
  if (!isPromptOnCurrentPageIntent(prompt)) {
    return prompt;
  }

  const noteContent = getCurrentNoteContextContent(currentNoteContext);
  if (!noteContent) {
    return prompt;
  }

  return `${prompt}\n\n${truncateForPromptAnchor(noteContent)}`;
}

function getCurrentNoteContextContent(currentNoteContext: unknown): string | null {
  if (!isRecord(currentNoteContext)) {
    return null;
  }

  return getString(currentNoteContext.content) ?? null;
}

function isPromptOnCurrentPageIntent(prompt: string): boolean {
  return /\b(read|check|extract|use|answer|run|execute|follow)\b[\s\S]{0,80}\b(prompt|instruction|question|task|request)\b[\s\S]{0,80}\b(?:on|from|in)\s+(?:the\s+)?(?:page|note|document)\b|\b(prompt|instruction|question|task|request)\b[\s\S]{0,80}\b(?:on|from|in)\s+(?:the\s+)?(?:page|note|document)\b/i.test(
    prompt,
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

function isVagueContinuationFollowup(prompt: string): boolean {
  return /^\s*(continue|go on|keep going|keep exploring|keep searching|read it|check it|do that|please do|yes|ok|okay)\.?\s*$/i.test(
    prompt,
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
  let activeThink = resolveThinkingMode(toolContext.settings);
  const intentPrompt = resolvePromptForIntent(prompt, conversationHistory);
  let activeIntentPrompt = intentPrompt;
  let missionIntent = classifyMissionIntent(activeIntentPrompt);
  let writeAutonomy = missionIntent.allowAutonomousWrite;
  let runToolContext: ToolExecutionContext = {
    ...toolContext,
    writeAutonomy,
    missionIntent,
  };
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
    streamingWritebackKind,
  );
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
  const shouldReadCurrentNote = shouldObserveCurrentNote(
    activeIntentPrompt,
    allowedToolNames,
    missionIntent,
  );
  let executedModelTool = false;
  let wroteToNote = false;
  let unavailableToolCorrectionUsed = false;
  let lastStep = 0;
  const writeReceipts: AgentRunReceipt[] = [];
  let preparedStreamingSectionEdit: PreparedStreamingSectionEdit | null = null;
  const stopIfRequested = (step = Math.max(lastStep, 0)) => {
    if (!isRunStopRequested(abortSignal)) {
      return false;
    }

    completeRun(events, "user_stopped", step, runStartedAt);
    return true;
  };

  if (stopIfRequested(0)) {
    return;
  }

  events.onRunConfig?.(
    buildRunConfigEvent({
      toolContext: runToolContext,
      enableStreaming,
      activeThink,
      modelOptions,
      writeAutonomy,
      missionIntent,
      currentNoteContext: shouldReadCurrentNote,
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
    writeAutonomy = missionIntent.allowAutonomousWrite;
    runToolContext = {
      ...toolContext,
      writeAutonomy,
      missionIntent,
    };
    streamingWritebackKind = getStreamingWritebackKind(
      activeIntentPrompt,
      runToolContext,
      enableStreaming,
    );
    tools = getAllowedToolDefinitions(
      toolRegistry,
      activeIntentPrompt,
      missionIntent,
      streamingWritebackKind,
    );
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
    followupIntentContext = null;

    events.onStatus?.("Using prompt from current note for tool routing...");
    events.onRunConfig?.(
      buildRunConfigEvent({
        toolContext: runToolContext,
        enableStreaming,
        activeThink,
        modelOptions,
        writeAutonomy,
        missionIntent,
        currentNoteContext: true,
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

  const finalAnswerRelevancePrompt = getFinalAnswerRelevancePrompt(
    activeIntentPrompt,
    currentNoteContext,
  );
  const promptOnPageWritebackKind = getPromptOnPageWritebackKind({
    prompt,
    currentNoteContext,
    toolContext: runToolContext,
    enableStreaming,
  });

  const conversationMessages = toConversationModelMessages(conversationHistory);

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
    {
      role: "system" as const,
      content: formatMissionIntentContext(missionIntent),
    },
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
    ...(currentNoteContext === null
      ? []
      : [
          {
            role: "system" as const,
            content: formatCurrentNoteContext(currentNoteContext),
          },
        ]),
    {
      role: "system" as const,
      content: formatAllowedToolsContext(tools),
    },
    ...(streamingWritebackKind === null
      ? []
      : [
          {
            role: "system" as const,
            content: formatStreamingWritebackContext(streamingWritebackKind),
          },
        ]),
    ...(conversationMessages.length === 0
      ? []
      : [
          {
            role: "system" as const,
            content: formatConversationHistoryContext(),
          },
          ...conversationMessages,
        ]),
    {
      role: "user" as const,
      content: activeIntentPrompt,
    },
  ];

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
    completeRun(events, "write_completed", 1, runStartedAt);
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
    completeRun(
      events,
      isClarifyingQuestionResponse(activeIntentPrompt, response?.message.content ?? "")
        ? "clarifying_question"
        : "final",
      1,
      runStartedAt,
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
    completeRun(
      events,
      isClarifyingQuestionResponse(activeIntentPrompt, response?.message.content ?? "")
        ? "clarifying_question"
        : "final",
      1,
      runStartedAt,
    );
    return;
  }

  emitStatus(events, "Planning...", "planning");

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    if (stopIfRequested(step)) {
      return;
    }

    lastStep = step;
    events.onStatus?.(`Agent step ${step} of max ${MAX_AGENT_STEPS}...`);
    events.onPhaseChange?.(
      "planning",
      `Planning step ${step} of max ${MAX_AGENT_STEPS}...`,
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

    if (stopIfRequested(step)) {
      return;
    }

    const responseToolCalls = getResponseToolCallsFromModelOutput(
      response,
      knownToolNames,
      events,
      step,
    );
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
          if (step < MAX_AGENT_STEPS) {
            events.onStatus?.(
              "Sources or vault tools are required; asking model to use tools before writing...",
            );
            messages.push({
              role: "system" as const,
              content: buildToolBeforeStreamingWritebackPrompt(tools),
            });
            continue;
          }

          break;
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
        writeReceipts.push(receipt);
        events.onReceipt?.(receipt);
        completeRun(events, "write_completed", lastStep, runStartedAt);
        return;
      }

      if (writeRequired && !wroteToNote) {
        if (step < MAX_AGENT_STEPS) {
          events.onStatus?.("Write required; asking model to use a write tool...");
          messages.push({
            role: "system" as const,
            content: buildWriteCorrectionPrompt(requiredWriteTools),
          });
          continue;
        }

        break;
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
        });
        emitDirectAssistantAnswer(directContent, events);
      }
      completeRun(
        events,
        isClarifyingQuestionResponse(activeIntentPrompt, response.message.content)
          ? "clarifying_question"
          : "final",
        lastStep,
        runStartedAt,
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
      let result: ToolExecutionResult;
      try {
        result = await executeToolWithMetrics({
          toolRegistry,
          toolCall,
          toolContext: runToolContext,
          events,
          step,
        });
      } catch (error) {
        if (stopIfRequested(step)) {
          return;
        }
        throw error;
      }
      executedModelTool = true;
      messages.push({
        role: "tool" as const,
        toolName: toolCall.name,
        content: serializeToolResult(result),
      });

      if (result.ok) {
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

        if (isWriteToolName(toolCall.name)) {
          wroteToNote = true;
        }
      } else {
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
    }

    if (!wroteToNote && stopIfRequested(step)) {
      return;
    }

    if (
      shouldReplanAfterUnavailableTool &&
      !unavailableToolCorrectionUsed &&
      step < MAX_AGENT_STEPS
    ) {
      unavailableToolCorrectionUsed = true;
      events.onStatus?.("Unavailable write tool requested; asking model to choose an allowed path...");
      messages.push({
        role: "system" as const,
        content: buildUnavailableToolCorrectionPrompt(tools),
      });
      continue;
    }

    if (wroteToNote) {
      emitRunDiagnostics({
        events,
        toolContext: runToolContext,
        tools,
        enableStreaming,
        finalMode: "none",
      });
      emitLocalWriteSummary(events, writeReceipts);
      completeRun(events, "write_completed", lastStep, runStartedAt);
      return;
    }
  }

  completeRun(events, "budget", Math.max(lastStep, MAX_AGENT_STEPS), runStartedAt);
}

export type FinalEmissionMode =
  | "direct"
  | "buffered_final"
  | "streaming_direct"
  | "streaming_final"
  | "streaming_writeback"
  | "none";

type StreamingWritebackKind = "append" | "replace" | "edit";

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

function formatCurrentNoteContext(currentNoteContext: unknown): string {
  return `Current note context: ${JSON.stringify(currentNoteContext)}`;
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
  return [
    `Mission mode: ${intent.mode}.`,
    `Vault context answer: ${intent.vaultContext ? "yes" : "no"}.`,
    `Autonomous write allowed: ${intent.allowAutonomousWrite ? "yes" : "no"}.`,
    `Write required: ${intent.requireWriteCompletion ? "yes" : "no"}.`,
    `Delete allowed: ${
      intent.explicitDelete ? "yes, explicit delete intent detected" : "no"
    }.`,
  ].join(" ");
}

function formatFollowupIntentContext(intentPrompt: string): string {
  return [
    "The current user message is a short follow-up to recent chat.",
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

function formatStreamingWritebackContext(kind: StreamingWritebackKind): string {
  if (kind === "edit") {
    return [
      "Streaming writeback is active for a current-note section edit.",
      "First request prepare_edit_current_section for the target heading.",
      "After that tool succeeds, do not request edit_current_section; provide only the markdown body that should replace the section.",
      "Thinking traces are never written to the note.",
    ].join(" ");
  }

  const blockedTool =
    kind === "append" ? "append_to_current_file" : "replace_current_file";

  return [
    `Streaming writeback is active for ${kind} on the current note.`,
    `Do not request ${blockedTool}; it is intentionally absent while streaming writeback is active.`,
    "When ready to write, provide only the markdown content for the note write.",
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
  toolContext,
  enableStreaming,
  activeThink,
  modelOptions,
  writeAutonomy,
  missionIntent,
  currentNoteContext,
}: {
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  activeThink: ModelThink | undefined;
  modelOptions: ModelRequestOptions | undefined;
  writeAutonomy: boolean;
  missionIntent: MissionIntent;
  currentNoteContext: boolean;
}): AgentRunConfigEvent {
  const settings = toolContext.settings;
  return {
    model: settings?.model?.trim() || "unknown",
    base: formatBaseUrlCategory(settings?.ollamaBaseUrl?.trim() || ""),
    streaming: enableStreaming,
    thinkingMode: settings?.thinkingMode ?? "auto",
    resolvedThink: formatResolvedThink(activeThink),
    temperature: modelOptions?.temperature,
    topK: modelOptions?.top_k,
    topP: modelOptions?.top_p,
    numCtx: modelOptions?.num_ctx,
    writeAutonomy,
    missionMode: missionIntent.mode,
    contextScope: getRunContextScope({
      vaultContext: missionIntent.vaultContext,
      currentNoteContext,
    }),
    currentNoteContext,
    vaultContext: missionIntent.vaultContext,
    maxSteps: MAX_AGENT_STEPS,
  };
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
}: {
  events: AgentRunEvents;
  toolContext: ToolExecutionContext;
  tools: ModelChatRequest["tools"];
  enableStreaming: boolean;
  finalMode: FinalEmissionMode;
}) {
  events.onStatus?.(
    formatRunDiagnostics({
      toolContext,
      toolCount: tools?.length ?? 0,
      enableStreaming,
      finalMode,
    }),
  );
}

export function formatRunDiagnostics({
  toolContext,
  toolCount,
  enableStreaming,
  finalMode,
}: {
  toolContext: ToolExecutionContext;
  toolCount: number;
  enableStreaming: boolean;
  finalMode: FinalEmissionMode;
}): string {
  const settings = toolContext.settings;
  const model = settings?.model?.trim() || "unknown";
  const baseUrl = settings?.ollamaBaseUrl?.trim() || "";
  const modelOptions = buildModelRequestOptions(settings);

  return [
    "Run diagnostics:",
    `model=${model};`,
    `base=${formatBaseUrlCategory(baseUrl)};`,
    `streaming=${enableStreaming ? "on" : "off"};`,
    `missionMode=${toolContext.missionIntent?.mode ?? "unknown"};`,
    `writeAutonomy=${toolContext.writeAutonomy ? "on" : "off"};`,
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
  let response: ModelChatResponse;
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
      onContentDelta: (delta) => {
        const sanitized = contentSanitizer.push(delta);
        if (!sanitized) {
          return;
        }

        observedContent = true;
        const topicalContent = relevanceGate.push(sanitized);
        if (!topicalContent) {
          return;
        }

        emittedContent += topicalContent;
        if (!verifyWordCount) {
          events.onFinalDelta?.(topicalContent);
          events.onAssistantDelta?.(topicalContent);
        }
      },
      onThinkingDelta: thinkingStream.onDelta,
      },
      onThinkingUnsupported,
    });
    emitMetricEvent(events, {
      kind: "model_stream",
      name: metricName,
      durationMs: elapsedMs(startedAt),
      requestChars,
      responseChars: measureSerializedChars(response.raw ?? response.message),
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
        events.onFinalDelta?.(topicalContent);
        events.onAssistantDelta?.(topicalContent);
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
        events.onFinalDelta?.(topicalContent);
        events.onAssistantDelta?.(topicalContent);
      }
    }
  }

  const bufferedTopicalContent = relevanceGate.finish();
  if (bufferedTopicalContent) {
    emittedContent += bufferedTopicalContent;
    if (!verifyWordCount) {
      events.onFinalDelta?.(bufferedTopicalContent);
      events.onAssistantDelta?.(bufferedTopicalContent);
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
    events.onFinalDelta?.(finalContent);
    events.onAssistantDelta?.(finalContent);
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

      if (isTopicallyRelevant(profile, buffer)) {
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

      if (isTopicallyRelevant(profile, buffer)) {
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
  };
}

function isTopicallyRelevant(
  profile: RelevanceProfile,
  content: string,
): boolean {
  const outputTokens = new Set(extractSemanticTokens(content));
  for (const anchor of profile.anchors) {
    if (outputTokens.has(anchor)) {
      return true;
    }
  }

  return false;
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

function extractSemanticTokens(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z][a-z0-9']{2,}/g);

  if (!tokens) {
    return [];
  }

  return tokens
    .map(normalizeSemanticToken)
    .filter((token) => token.length >= 4);
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
  "answer",
  "argumentative",
  "clearly",
  "compose",
  "current",
  "detail",
  "draft",
  "essay",
  "exact",
  "generate",
  "grounded",
  "mission",
  "note",
  "please",
  "prompt",
  "provide",
  "regard",
  "response",
  "source",
  "summarize",
  "summary",
  "user",
  "word",
  "write",
  "written",
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
  "list_current_folder",
  "list_markdown_files",
  "read_markdown_files",
  "search_markdown_files",
  "read_file",
  "count_words",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "list_folder",
  "get_path_info",
]);

const WRITE_TOOL_NAMES = new Set([
  "create_folder",
  "create_file",
  "append_file",
  "replace_file",
  "move_path",
  "append_to_current_file",
  "retitle_current_file",
  "prepare_edit_current_section",
  "edit_current_section",
  "replace_current_file",
  "link_related_notes_in_current_file",
]);

const DELETE_TOOL_NAMES = new Set(["delete_path", "delete_current_file"]);

function getAllowedToolDefinitions(
  toolRegistry: ToolRegistry,
  prompt: string,
  missionIntent: MissionIntent,
  streamingWritebackKind: StreamingWritebackKind | null = null,
) {
  const noteOutputIntent = missionIntent.noteOutput;
  const allowAppend = hasAppendIntent(prompt);
  const allowDelete = hasDeleteIntent(prompt);
  const allowDeletePath = hasDeletePathIntent(prompt);
  const allowWholeNoteReplace = hasWholeNoteReplaceIntent(prompt);
  const allowEdit = hasEditIntent(prompt) && !allowWholeNoteReplace;
  const allowReplace =
    hasReplaceIntent(prompt) && (!allowEdit || allowWholeNoteReplace) && !allowDelete;
  const allowRetitle = hasTitleIntent(prompt);
  const allowWebSearch = hasWebSearchIntent(prompt);
  const allowCurrentNoteRead = hasCurrentNoteReadIntent(prompt);
  const allowWordCount = hasWordCountIntent(prompt);
  const allowGraphContext = hasGraphConnectionIntent(prompt);
  const allowGraphLinkWrite = hasGraphLinkWriteIntent(prompt);
  const allowVaultBrowse =
    missionIntent.vaultContext || hasVaultBrowseIntent(prompt) || allowGraphContext;
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
    !allowRetitle;

  return toolRegistry.getDefinitions().filter((definition) => {
    const name = definition.function.name;

    if (!isAllowedForMission(name, prompt, missionIntent)) {
      return false;
    }

    if (name === "web_search" || name === "web_fetch") {
      return allowWebSearch;
    }

    if (name === "read_current_file") {
      return (
        missionIntent.vaultContext ||
        allowCurrentNoteRead ||
        allowCurrentNoteOutput
      );
    }

    if (name === "list_markdown_files") {
      return allowVaultBrowse;
    }

    if (name === "search_markdown_files" || name === "read_markdown_files") {
      return allowVaultBrowse || allowSpecificFileRead;
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

    if (name === "create_folder") {
      return allowCreateFolder;
    }

    if (name === "create_file") {
      return allowCreateFile;
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

    if (name === "append_to_current_file") {
      return (
        (allowAppend || allowAutonomousAppend) &&
        streamingWritebackKind !== "append" &&
        !preferPathTarget &&
        !hasTitleOnlyIntent(prompt) &&
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
        streamingWritebackKind !== "replace" &&
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
): boolean {
  if (READ_NAV_TOOL_NAMES.has(name)) {
    return (
      intent.vaultContext ||
      hasVaultBrowseIntent(prompt) ||
      hasSpecificFileReadIntent(prompt) ||
      hasCurrentNoteReadIntent(prompt) ||
      hasWordCountIntent(prompt) ||
      hasGraphConnectionIntent(prompt) ||
      intent.noteOutput ||
      intent.explicitMutation
    );
  }

  if (DELETE_TOOL_NAMES.has(name)) {
    return intent.explicitDelete;
  }

  if (WRITE_TOOL_NAMES.has(name)) {
    return intent.noteOutput || intent.explicitMutation;
  }

  if (name === "web_search" || name === "web_fetch") {
    return hasWebSearchIntent(prompt);
  }

  return true;
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

  if (
    (hasAppendIntent(prompt) || noteOutputIntent) &&
    !preferPathTarget &&
    !wholeNoteReplace &&
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

  if (hasTitleIntent(prompt) && !preferPathTarget) {
    requiredToolNames.push("retitle_current_file");
  }

  if (hasCreateFolderIntent(prompt)) {
    requiredToolNames.push("create_folder");
  }

  if (hasCreateFileIntent(prompt)) {
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
    "The user explicitly requested a note write, but you answered without using a write tool.",
    `Request one of these allowed write tools now: ${requiredWriteTools.join(", ")}.`,
    "Do not provide chat-only prose until the note write has completed.",
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
  const preferPathTarget = hasPathTargetIntent(prompt) && !hasCurrentNoteTarget(prompt);
  return (
    allowedToolNames.has("read_current_file") &&
    (hasCurrentNoteReadIntent(prompt) ||
      (missionIntent.noteOutput && !preferPathTarget))
  );
}

function canStreamAnswerFromInitialCurrentNoteContext(
  tools: ModelChatRequest["tools"],
): boolean {
  const toolNames = tools?.map((tool) => tool.function.name) ?? [];
  return toolNames.length === 1 && toolNames[0] === "read_current_file";
}

function getPromptOnCurrentPageRoutingPrompt(
  prompt: string,
  currentNoteContext: unknown,
): string | null {
  if (!isPromptOnCurrentPageIntent(prompt)) {
    return null;
  }

  const pagePrompt = getCurrentNoteContextContent(currentNoteContext)?.trim();
  return pagePrompt ? pagePrompt : null;
}

function classifyPromptOnCurrentPageMissionIntent(prompt: string): MissionIntent {
  const intent = classifyMissionIntent(prompt);
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
    hasSpecificFileReadIntent(prompt) ||
    hasGraphConnectionIntent(prompt) ||
    hasWordCountIntent(prompt)
  );
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

  const pagePrompt = getCurrentNoteContextContent(currentNoteContext);
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
    toolContext.settings?.streamWritebackMode !==
      "all_current_note_content_writes"
  ) {
    return null;
  }

  const preferPathTarget = hasPathTargetIntent(prompt) && !hasCurrentNoteTarget(prompt);

  if (preferPathTarget) {
    return null;
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
  const vaultContext = hasVaultContextQuestionIntent(prompt);
  const explicitGraphLinkWrite = hasGraphLinkWriteIntent(prompt);
  const explicitPersistence =
    hasExplicitWritePersistenceIntent(prompt) || explicitGraphLinkWrite;
  const explicitDelete = hasDeleteIntent(prompt) || hasDeletePathIntent(prompt);
  const explicitMutation =
    explicitPersistence ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasTitleIntent(prompt) ||
    explicitGraphLinkWrite ||
    explicitDelete;
  const noteOutput = !vaultContext && hasNoteOutputIntent(prompt);

  if (explicitDelete) {
    return {
      mode: "explicit_delete",
      vaultContext,
      noteOutput: false,
      explicitPersistence,
      explicitMutation: true,
      explicitDelete: true,
      allowAutonomousWrite: false,
      requireWriteCompletion: true,
    };
  }

  if (explicitMutation) {
    return {
      mode: "explicit_file_mutation",
      vaultContext,
      noteOutput,
      explicitPersistence,
      explicitMutation: true,
      explicitDelete: false,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
    };
  }

  if (vaultContext) {
    return {
      mode: "vault_context_answer",
      vaultContext: true,
      noteOutput: false,
      explicitPersistence: false,
      explicitMutation: false,
      explicitDelete: false,
      allowAutonomousWrite: false,
      requireWriteCompletion: false,
    };
  }

  return {
    mode: noteOutput ? "note_output" : "chat_only",
    vaultContext: false,
    noteOutput,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: noteOutput,
    requireWriteCompletion: noteOutput,
  };
}

function hasVaultContextQuestionIntent(prompt: string): boolean {
  return /\b(what\s+(did|do)\s+you\s+(learn|know|remember)\s+about\s+me|what\s+have\s+i\s+told\s+you|what\s+do\s+my\s+notes\s+say|based\s+on\s+my\s+notes|in\s+my\s+notes|across\s+my\s+notes|search\s+(my\s+)?notes|find\s+(notes?|details?|mentions?|references?)|where\s+did\s+i\s+mention|summari[sz]e\s+what\s+i\s+(know|have|wrote)|look\s+through\s+(my\s+)?vault|check\s+(my\s+)?folders?)\b/i.test(
    prompt,
  ) || hasGraphConnectionIntent(prompt);
}

function hasExplicitWritePersistenceIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b[\s\S]{0,100}\b(note|file|markdown|vault|folder|directory|path)\b|\b(note|file|markdown|vault|folder|directory|path)\b[\s\S]{0,100}\b(append|save|write|update|add|insert|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b|\.md\b/i.test(
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

function hasCurrentNoteReadIntent(prompt: string): boolean {
  return (
    isPromptOnCurrentPageIntent(prompt) ||
    /\b(current|this|active)\s+(note|file|markdown|document)\b|\b(note|file|markdown|document)\b[\s\S]{0,40}\b(current|this|active)\b|\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b[\s\S]{0,80}\b(note|file|markdown|document)\b|\b(note|file|markdown|document)\b[\s\S]{0,80}\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b/i.test(
      prompt,
    )
  );
}

function hasGeneratedWritingIntent(prompt: string): boolean {
  return /\b(write|draft|compose|generate|create)\b[\s\S]{0,100}\b(essay|article|paragraph|summary|brief|outline|report|analysis|response|answer|markdown|content|write[-\s]?up)\b|\b(essay|article|paragraph|summary|brief|outline|report|analysis|response|answer|markdown|content|write[-\s]?up)\b[\s\S]{0,100}\b(write|draft|compose|generate|create)\b|\b(write|draft|compose|generate|create)\b[\s\S]{0,80}\b\d{1,5}\s*words?\b/i.test(
    prompt,
  );
}

function hasVaultBrowseIntent(prompt: string): boolean {
  return /\b(vault|files|file names|filenames|markdown files|md files|folders|folder|directory|directories|path|paths|list|browse|inspect|where\s+this\s+note\s+belongs|placement|organize\s+(?:the\s+)?vault|across\s+files)\b/i.test(
    prompt,
  );
}

function hasSpecificFileReadIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(file named|note named|named file|named note|specific file|existing file|vault file)\b/i.test(
    prompt,
  );
}

function hasCreateFileIntent(prompt: string): boolean {
  if (!/\b(create|new|make)\b/i.test(prompt)) {
    return false;
  }

  if (hasStaticGenerationIntent(prompt) && !/\b(file|note|vault|path)\b|\.md\b/i.test(prompt)) {
    return false;
  }

  return /\b(create|new|make)\b[\s\S]{0,100}\b(note|file|md|vault)\b|\b(note|file|md|vault)\b[\s\S]{0,100}\b(create|new|make)\b|\.md\b/i.test(
    prompt,
  );
}

function hasCreateFolderIntent(prompt: string): boolean {
  return /\b(create|new|make)\b[\s\S]{0,100}\b(folder|directory)\b|\b(folder|directory)\b[\s\S]{0,100}\b(create|new|make)\b/i.test(
    prompt,
  );
}

function hasPathTargetIntent(prompt: string): boolean {
  return /(?:^|[\s"'`])[\w .@()-]+\/[\w .@()/-]+|\.md\b|\b(path|folder|folders|directory|directories|vault file|vault folder|file named|note named|named file|named note|another file|specific file|existing file)\b/i.test(
    prompt,
  );
}

function hasCurrentNoteTarget(prompt: string): boolean {
  return /\b(current|this|active)\s+(note|file|markdown|document)\b|\b(note|file|markdown|document)\b[\s\S]{0,40}\b(current|this|active)\b/i.test(
    prompt,
  );
}

function hasNoteOutputIntent(prompt: string): boolean {
  if (
    hasAppendIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasTitleIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasDeleteIntent(prompt) ||
    hasDeletePathIntent(prompt)
  ) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt)) {
    return false;
  }

  return /\b(research|investigate|analy[sz]e|synthesi[sz]e|summari[sz]e|summary|outline|brief|report|literature\s+review|field\s+notes?|meeting\s+notes?|findings|digest|recap|write[-\s]?up|cited\s+sources?|citations?)\b/i.test(
    prompt,
  );
}

function hasAppendIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert)\b[\s\S]{0,80}\b(note|file|markdown|vault)\b|\b(note|file|markdown|vault)\b[\s\S]{0,80}\b(append|save|write|update|add|insert)\b/i.test(
    prompt,
  );
}

function hasReplaceIntent(prompt: string): boolean {
  return /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+fresh\b/i.test(
    prompt,
  );
}

function hasWholeNoteReplaceIntent(prompt: string): boolean {
  if (!hasReplaceIntent(prompt)) {
    return false;
  }

  return /\b(rewrite|replace|reset|overwrite|clean\s+up|start\s+fresh)\b[\s\S]{0,100}\b(current|this|active|whole|entire)\s+(note|file|markdown|document|content)\b|\b(current|this|active|whole|entire)\s+(note|file|markdown|document|content)\b[\s\S]{0,100}\b(rewrite|replace|reset|overwrite|clean\s+up|start\s+fresh)\b/i.test(
    prompt,
  );
}

function hasEditIntent(prompt: string): boolean {
  return /\b(edit|revise|update|replace|rewrite)\b[\s\S]{0,80}\b(section|heading|part|paragraph|content)\b|\b(section|heading|part|paragraph|content)\b[\s\S]{0,80}\b(edit|revise|update|replace|rewrite)\b/i.test(
    prompt,
  );
}

function hasDeleteIntent(prompt: string): boolean {
  return /\b(delete|remove|trash)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:current|this|active|whole|entire)\s+(?:note|file)\b[\s\S]{0,80}\b(delete|remove|trash)\b/i.test(
    prompt,
  );
}

function hasDeletePathIntent(prompt: string): boolean {
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

  if (hasExplicitWebSearchIntent(prompt)) {
    return true;
  }

  if (hasStaticGenerationIntent(prompt)) {
    return false;
  }

  return /\b(research|investigate|find|gather)\b/i.test(prompt);
}

function hasExplicitWebSearchIntent(prompt: string): boolean {
  return /\b(web|internet|online|search|look\s+up|browse|sources?|citations?|cited|cite|latest|recent|news|up[-\s]?to[-\s]?date|verify|fact[-\s]?check)\b|\bcurrent\b[\s\S]{0,40}\b(events?|news|information|info|version|versions?|prices?|rates?|status|facts?)\b/i.test(
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

  return !/\b(append|add|insert)\b/i.test(prompt);
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

function getToolPreparationStatus(toolName: string): string | null {
  if (toolName === "web_search") {
    return "Searching web...";
  }

  if (toolName === "web_fetch") {
    return "Fetching source page...";
  }

  if (toolName === "read_file") {
    return "Reading vault note...";
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

  if (toolName === "append_to_current_file" && isRecord(output)) {
    const message = `Appended result to ${String(output.path ?? "current note")}.`;
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
    toolName === "create_file" ||
    toolName === "append_file" ||
    toolName === "replace_file" ||
    toolName === "move_path" ||
    toolName === "delete_path" ||
    toolName === "append_to_current_file" ||
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
  const textFields = new Set(["text", "content"]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function emitDirectAssistantAnswer(content: string, events: AgentRunEvents) {
  const sanitized = sanitizeAssistantContent(content);
  if (!sanitized.trim()) {
    return;
  }

  emitStatus(events, "Drafting final answer...", "final_answer");
  events.onFinalStart?.();
  events.onAssistantMessageStart?.();
  events.onFinalDelta?.(sanitized);
  events.onAssistantDelta?.(sanitized);
  events.onFinalDone?.();
  events.onAssistantMessageDone?.();
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
    deltas: string[];
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
    const contentSanitizer = createAssistantContentSanitizer();
    const thinkingStream = createThinkingStream(events);
    let attemptContent = "";
    const attemptDeltas: string[] = [];

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
          onContentDelta: (delta) => {
            const sanitized = contentSanitizer.push(delta);
            if (!sanitized) {
              return;
            }

            attemptContent += sanitized;
            attemptDeltas.push(sanitized);
          },
          onThinkingDelta: thinkingStream.onDelta,
        },
        onThinkingUnsupported,
      });
      emitMetricEvent(events, {
        kind: "model_stream",
        name: metricName,
        durationMs: elapsedMs(startedAt),
        requestChars,
        responseChars: measureSerializedChars(
          attemptResponse.raw ?? attemptResponse.message,
        ),
        ...extractTokenUsageFields(attemptResponse.raw),
      });

      const trailingContent = contentSanitizer.flush();
      if (trailingContent) {
        attemptContent += trailingContent;
        attemptDeltas.push(trailingContent);
      }

      thinkingStream.done();

      const sanitizedResponse = sanitizeAssistantContent(
        attemptResponse.message.content,
      );
      if (!attemptContent.trim() && sanitizedResponse.trim()) {
        attemptContent += sanitizedResponse;
        attemptDeltas.push(sanitizedResponse);
      }

      if (containsRecoverableToolRequest(attemptContent, knownToolNames)) {
        return {
          response: attemptResponse,
          toolRequestDetected: true,
          content: "",
          deltas: [],
        };
      }

      return {
        response: attemptResponse,
        toolRequestDetected: false,
        content: attemptContent,
        deltas: attemptDeltas,
      };
    } catch (error) {
      emitMetricEvent(events, {
        kind: "model_stream",
        name: metricName,
        durationMs: elapsedMs(startedAt),
        requestChars,
      });
      const trailingContent = contentSanitizer.flush();
      if (trailingContent) {
        attemptContent += trailingContent;
        attemptDeltas.push(trailingContent);
      }

      thinkingStream.done();
      if (
        attemptContent.trim() &&
        !containsRecoverableToolRequest(attemptContent, knownToolNames)
      ) {
        emitBufferedWritebackContent(attemptDeltas, events, writer);
        emittedContent += attemptContent;
      }
      throw error;
    }
  };

  try {
    let retryUsed = false;
    let attempt = await streamAttempt(false);
    response = attempt.response;

    if (attempt.toolRequestDetected) {
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

    const wordTarget = parseWritebackWordCountTargetFromMessages(messages);
    let correctionUsed = false;
    let contentToWrite = attempt.content;
    let deltasToWrite = attempt.deltas;
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
          deltasToWrite = [corrected];
          correctionUsed = true;
        }
      }
    }

    emitBufferedWritebackContent(deltasToWrite, events, writer);
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
        "The previous writeback stream returned no writable markdown.",
        "Return only the requested markdown content now.",
      ]
    : [];

  if (kind === "append") {
    return [
      ...retryPrefix,
      "Write the markdown content to append to the current note now.",
      "Use English unless the user explicitly requested another language in the current mission.",
      "Return only the markdown that should be appended.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

  if (kind === "replace") {
    return [
      ...retryPrefix,
      "Write the full replacement markdown for the current note now.",
      "Use English unless the user explicitly requested another language in the current mission.",
      "Return only the complete replacement note content.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

  return [
    ...retryPrefix,
    `Write the replacement markdown body for the section "${preparedSectionEdit?.heading ?? "target section"}" now.`,
    "Do not include the heading line itself.",
    "Use English unless the user explicitly requested another language in the current mission.",
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

function emitBufferedWritebackContent(
  deltas: string[],
  events: AgentRunEvents,
  writer: Awaited<ReturnType<typeof createStreamingNoteWriter>>,
) {
  for (const delta of deltas) {
    if (!delta) {
      continue;
    }
    events.onFinalDelta?.(delta);
    events.onAssistantDelta?.(delta);
    writer.push(delta);
  }
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

function parseWritebackWordCountTargetFromMessages(
  messages: ModelChatMessage[],
): WordCountTarget | null {
  for (const message of [...messages].reverse()) {
    if (
      message.role !== "user" &&
      !/Current note context:/i.test(message.content)
    ) {
      continue;
    }

    const target = parseWordCountTarget(message.content);
    if (target) {
      return target;
    }
  }

  return null;
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
    think,
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
  const baseContent =
    kind === "append"
      ? `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}`
      : "";
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

  const queueFlush = () => {
    pendingChars = 0;
    lastFlushAt = nowMs();
    const nextContent = render();
    flushChain = flushChain.then(() => toolContext.app.vault.modify(file, nextContent));
  };

  return {
    push(delta: string) {
      streamedContent += delta;
      pendingChars += delta.length;

      if (pendingChars >= 800 || nowMs() - lastFlushAt >= 750) {
        queueFlush();
      }
    },
    hasWritableContent() {
      return hasWritableContent();
    },
    discardNonWritableContent() {
      if (hasWritableContent()) {
        return;
      }

      streamedContent = "";
      pendingChars = 0;
    },
    async finish(options: { force?: boolean } = {}) {
      if (
        hasWritableContent() &&
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
    await toolContext.app.vault.createFolder(BACKUP_FOLDER);
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
  return hasAmbiguousDatePrompt(prompt) && /\?\s*$/.test(sanitizeAssistantContent(content).trim());
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
    maxSteps: MAX_AGENT_STEPS,
    stopReason,
  });
  events.onTrace?.({
    id: `final-${stopReason}`,
    kind: "final",
    step,
    message,
    outputPreview: {
      step,
      maxSteps: MAX_AGENT_STEPS,
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

function isRunStopRequested(abortSignal: AbortSignal | undefined): boolean {
  return abortSignal?.aborted ?? false;
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

  try {
    const result = await toolRegistry.execute(toolCall, toolContext);
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
