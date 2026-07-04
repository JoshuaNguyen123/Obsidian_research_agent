import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatMessage,
  ModelClient,
  ModelChatStreamEvents,
  ModelRequestOptions,
  ModelThink,
} from "./model/types";
import { ModelClientError } from "./model/types";
import type {
  AgentMissionMode,
  MissionIntent,
  ToolExecutionContext,
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
  vaultContext: boolean;
  maxSteps: number;
}

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
16. Do not write to notes for a vault context answer unless the user asks to save, write, update, create, move, rename, or delete something.
17. When you need tools, request tools without writing user-facing prose or preambles.
18. When the mission is expected to produce note output, choose the safest useful write tool instead of only answering in chat.
19. If a date calculation is missing a year or reference date, ask one concise clarifying question instead of guessing.
20. When you have enough context and no note write is required, stop requesting tools and write the final answer.
21. If a web tool fails, explain that web access failed and include the tool error instead of inventing sourced facts.`;

const FINAL_ANSWER_PROMPT = [
  "Provide the final answer for the user now.",
  "Use the current conversation, current-note context, and any tool results.",
  "Do not request tools.",
  "Do not mention hidden planning unless it is directly useful to the user.",
].join(" ");

export async function runAgentMission({
  prompt,
  modelClient,
  toolRegistry,
  toolContext,
  enableStreaming,
  conversationHistory = [],
  events = {},
}: RunAgentMissionOptions): Promise<void> {
  const runStartedAt = nowMs();
  let activeThink = resolveThinkingMode(toolContext.settings);
  const missionIntent = classifyMissionIntent(prompt);
  const writeAutonomy = missionIntent.allowAutonomousWrite;
  const runToolContext: ToolExecutionContext = {
    ...toolContext,
    writeAutonomy,
    missionIntent,
  };
  const modelOptions = buildModelRequestOptions(runToolContext.settings);
  const disableThinkingForRun = () => {
    if (activeThink !== undefined) {
      activeThink = undefined;
      events.onStatus?.("Thinking unsupported; using standard loop.");
    }
  };
  const streamingWritebackKind = getStreamingWritebackKind(
    prompt,
    runToolContext,
    enableStreaming,
  );
  const tools = getAllowedToolDefinitions(
    toolRegistry,
    prompt,
    missionIntent,
    streamingWritebackKind,
  );
  const allowedToolNames = new Set(tools.map((tool) => tool.function.name));
  const requiredWriteTools = getRequiredWriteToolNames(
    prompt,
    allowedToolNames,
    missionIntent,
    streamingWritebackKind,
  );
  const writeRequired =
    missionIntent.requireWriteCompletion && requiredWriteTools.length > 0;
  const shouldReadCurrentNote = shouldObserveCurrentNote(
    prompt,
    allowedToolNames,
    missionIntent,
  );
  let executedModelTool = false;
  let wroteToNote = false;
  let unavailableToolCorrectionUsed = false;
  let lastStep = 0;
  const writeReceipts: AgentRunReceipt[] = [];
  let preparedStreamingSectionEdit: PreparedStreamingSectionEdit | null = null;

  events.onRunConfig?.(
    buildRunConfigEvent({
      toolContext: runToolContext,
      enableStreaming,
      activeThink,
      modelOptions,
      writeAutonomy,
      missionIntent,
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
  const conversationMessages = toConversationModelMessages(conversationHistory);

  const messages: ModelChatMessage[] = [
    {
      role: "system" as const,
      content: SYSTEM_PROMPT,
    },
    {
      role: "system" as const,
      content: formatRuntimeContext(runToolContext, prompt),
    },
    {
      role: "system" as const,
      content: formatMissionIntentContext(missionIntent),
    },
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
      content: prompt,
    },
  ];

  if (enableStreaming && tools.length === 0 && !writeRequired) {
    emitRunDiagnostics({
        events,
        toolContext: runToolContext,
        tools,
        enableStreaming,
        finalMode: "streaming_direct",
    });
    const response = await emitFinalAnswer({
      modelClient,
      messages,
      events,
      enableStreaming,
      fallbackContent: "",
      finalInstruction: null,
      metricName: "direct_answer",
      think: activeThink,
      options: modelOptions,
      onThinkingUnsupported: disableThinkingForRun,
    });
    completeRun(
      events,
      isClarifyingQuestionResponse(prompt, response?.message.content ?? "")
        ? "clarifying_question"
        : "final",
      1,
      runStartedAt,
    );
    return;
  }

  emitStatus(events, "Planning...", "planning");

  for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
    lastStep = step;
    events.onStatus?.(`Agent step ${step} of max ${MAX_AGENT_STEPS}...`);
    events.onPhaseChange?.(
      "planning",
      `Planning step ${step} of max ${MAX_AGENT_STEPS}...`,
    );

    const response = await chatForAgentStep(
      modelClient,
      buildChatRequest(messages, tools, activeThink, modelOptions),
      events,
      step,
      disableThinkingForRun,
    );

    messages.push(withoutThinking(response.message));

    if (response.toolCalls.length === 0) {
      if (
        streamingWritebackKind &&
        (streamingWritebackKind !== "edit" || preparedStreamingSectionEdit)
      ) {
        emitRunDiagnostics({
          events,
          toolContext: runToolContext,
          tools,
          enableStreaming,
          finalMode: "streaming_writeback",
        });
        const receipt = await streamCurrentNoteWriteback({
          kind: streamingWritebackKind,
          preparedSectionEdit: preparedStreamingSectionEdit,
          modelClient,
          messages,
          events,
          toolContext: runToolContext,
          think: activeThink,
          options: modelOptions,
          onThinkingUnsupported: disableThinkingForRun,
        });
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

      if (executedModelTool && enableStreaming && !hasDirectFinalContent) {
        emitRunDiagnostics({
          events,
          toolContext: runToolContext,
          tools,
          enableStreaming,
          finalMode: "streaming_final",
        });
        await emitFinalAnswer({
          modelClient,
          messages,
          events,
          enableStreaming,
          fallbackContent: response.message.content,
          think: activeThink,
          options: modelOptions,
          onThinkingUnsupported: disableThinkingForRun,
        });
      } else {
        emitRunDiagnostics({
          events,
          toolContext: runToolContext,
          tools,
          enableStreaming,
          finalMode: executedModelTool ? "buffered_final" : "direct",
        });
        emitDirectAssistantAnswer(response.message.content, events);
      }
      completeRun(
        events,
        isClarifyingQuestionResponse(prompt, response.message.content)
          ? "clarifying_question"
          : "final",
        lastStep,
        runStartedAt,
      );
      return;
    }

    let shouldReplanAfterUnavailableTool = false;

    for (let toolIndex = 0; toolIndex < response.toolCalls.length; toolIndex += 1) {
      const toolCall = response.toolCalls[toolIndex];
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
      const result = await executeToolWithMetrics({
        toolRegistry,
        toolCall,
        toolContext: runToolContext,
        events,
        step,
      });
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
): ModelChatRequest {
  return {
    messages,
    tools: tools && tools.length > 0 ? tools : undefined,
    think,
    options,
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
}: {
  toolContext: ToolExecutionContext;
  enableStreaming: boolean;
  activeThink: ModelThink | undefined;
  modelOptions: ModelRequestOptions | undefined;
  writeAutonomy: boolean;
  missionIntent: MissionIntent;
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
    vaultContext: missionIntent.vaultContext,
    maxSteps: MAX_AGENT_STEPS,
  };
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
    const response = await modelClient.chat(request);
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
      const retryResponse = await modelClient.chat(retryRequest);
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
  think,
  options,
  onThinkingUnsupported,
}: {
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  events: AgentRunEvents;
  enableStreaming: boolean;
  fallbackContent: string;
  finalInstruction?: string | null;
  metricName?: string;
  think?: ModelThink;
  options?: ModelRequestOptions;
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
  const contentSanitizer = createAssistantContentSanitizer();
  const thinkingStream = createThinkingStream(events);
  const streamRequest: ModelChatRequest = {
    messages:
      finalInstruction === null
        ? [...messages]
        : [
            ...messages,
            {
              role: "system" as const,
              content: finalInstruction,
            },
          ],
    think,
    options,
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

        emittedContent += sanitized;
        events.onFinalDelta?.(sanitized);
        events.onAssistantDelta?.(sanitized);
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
    emittedContent += trailingContent;
    events.onFinalDelta?.(trailingContent);
    events.onAssistantDelta?.(trailingContent);
  }

  thinkingStream.done();

  const sanitizedResponse = sanitizeAssistantContent(response.message.content);
  if (!emittedContent.trim() && sanitizedResponse.trim()) {
    events.onFinalDelta?.(sanitizedResponse);
    events.onAssistantDelta?.(sanitizedResponse);
  }

  events.onFinalDone?.();
  events.onAssistantMessageDone?.();
  messages.push(withoutThinking(response.message));
  return response;
}

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
    return await modelClient.streamChat(request, streamEvents);
  } catch (error) {
    if (request.think === undefined || !isThinkingUnsupportedError(error)) {
      throw error;
    }

    onThinkingUnsupported();
    return modelClient.streamChat({ ...request, think: undefined }, streamEvents);
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
  const allowVaultBrowse =
    missionIntent.vaultContext || hasVaultBrowseIntent(prompt);
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

  return requiredToolNames.filter((name) => allowedToolNames.has(name));
}

function buildWriteCorrectionPrompt(requiredWriteTools: string[]): string {
  return [
    "The user explicitly requested a note write, but you answered without using a write tool.",
    `Request one of these allowed write tools now: ${requiredWriteTools.join(", ")}.`,
    "Do not provide chat-only prose until the note write has completed.",
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

  if (hasNoteOutputIntent(prompt)) {
    return "append";
  }

  return null;
}

function classifyMissionIntent(prompt: string): MissionIntent {
  const vaultContext = hasVaultContextQuestionIntent(prompt);
  const explicitPersistence = hasExplicitWritePersistenceIntent(prompt);
  const explicitDelete = hasDeleteIntent(prompt) || hasDeletePathIntent(prompt);
  const explicitMutation =
    explicitPersistence ||
    hasCreateFileIntent(prompt) ||
    hasCreateFolderIntent(prompt) ||
    hasMovePathIntent(prompt) ||
    hasReplaceIntent(prompt) ||
    hasEditIntent(prompt) ||
    hasTitleIntent(prompt) ||
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
  );
}

function hasExplicitWritePersistenceIntent(prompt: string): boolean {
  return /\b(append|save|write|update|add|insert|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b[\s\S]{0,100}\b(note|file|markdown|vault|folder|directory|path)\b|\b(note|file|markdown|vault|folder|directory|path)\b[\s\S]{0,100}\b(append|save|write|update|add|insert|record|persist|create|make|replace|rewrite|edit|revise|rename|move|delete|remove|trash)\b|\.md\b/i.test(
    prompt,
  );
}

function hasCurrentNoteReadIntent(prompt: string): boolean {
  return /\b(current|this|active)\s+(note|file|markdown|document)\b|\b(note|file|markdown|document)\b[\s\S]{0,40}\b(current|this|active)\b|\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b[\s\S]{0,80}\b(note|file|markdown|document)\b|\b(note|file|markdown|document)\b[\s\S]{0,80}\b(summarize|summary|append|replace|rewrite|reset|overwrite|edit|revise|delete|remove|trash|retitle|title|heading|h1|organize|restructure|clean\s+up)\b/i.test(
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
    return true;
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
  return /\b(generate|write|draft|compose|create)\b[\s\S]{0,80}\b(essay|article|paragraph|summary|brief|outline|report|note|content|post)\b|\b(essay|article|paragraph|summary|brief|outline|report)\b[\s\S]{0,80}\b\d+\s*words?\b/i.test(
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
    toolName === "delete_current_file"
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
  think,
  options,
  onThinkingUnsupported,
}: {
  kind: StreamingWritebackKind;
  preparedSectionEdit: PreparedStreamingSectionEdit | null;
  modelClient: ModelClient;
  messages: ModelChatMessage[];
  events: AgentRunEvents;
  toolContext: ToolExecutionContext;
  think?: ModelThink;
  options?: ModelRequestOptions;
  onThinkingUnsupported: () => void;
}): Promise<AgentRunReceipt> {
  const writer = await createStreamingNoteWriter({
    kind,
    toolContext,
    preparedSectionEdit,
  });
  const instruction = buildStreamingWritebackPrompt(kind, preparedSectionEdit);
  const streamRequest: ModelChatRequest = {
    messages: [
      ...messages,
      {
        role: "system" as const,
        content: instruction,
      },
    ],
    think,
    options,
  };
  const requestChars = measureSerializedChars(streamRequest);
  const startedAt = nowMs();
  emitModelCallTrace(events, {
    id: "model-call-stream-writeback",
    message: "Model stream: stream_writeback",
    request: streamRequest,
  });

  emitStatus(events, "Streaming writeback to note...", "final_answer");
  events.onFinalStart?.();
  events.onAssistantMessageStart?.();

  const contentSanitizer = createAssistantContentSanitizer();
  const thinkingStream = createThinkingStream(events);
  let response: ModelChatResponse | null = null;

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

          events.onFinalDelta?.(sanitized);
          events.onAssistantDelta?.(sanitized);
          writer.push(sanitized);
        },
        onThinkingDelta: thinkingStream.onDelta,
      },
      onThinkingUnsupported,
    });
    emitMetricEvent(events, {
      kind: "model_stream",
      name: "stream_writeback",
      durationMs: elapsedMs(startedAt),
      requestChars,
      responseChars: measureSerializedChars(response.raw ?? response.message),
      ...extractTokenUsageFields(response.raw),
    });

    const trailingContent = contentSanitizer.flush();
    if (trailingContent) {
      events.onFinalDelta?.(trailingContent);
      events.onAssistantDelta?.(trailingContent);
      writer.push(trailingContent);
    }

    thinkingStream.done();
    await writer.finish({ force: true });

    events.onFinalDone?.();
    events.onAssistantMessageDone?.();
    messages.push(withoutThinking(response.message));
    events.onStatus?.("Streaming writeback complete.");
    return writer.buildReceipt(false);
  } catch (error) {
    emitMetricEvent(events, {
      kind: "model_stream",
      name: "stream_writeback",
      durationMs: elapsedMs(startedAt),
      requestChars,
    });
    const trailingContent = contentSanitizer.flush();
    if (trailingContent) {
      events.onFinalDelta?.(trailingContent);
      events.onAssistantDelta?.(trailingContent);
      writer.push(trailingContent);
    }

    thinkingStream.done();
    await writer.finish();
    events.onFinalDone?.();
    events.onAssistantMessageDone?.();

    const receipt = writer.buildReceipt(true);
    events.onReceipt?.(receipt);
    events.onStatus?.("Streaming writeback interrupted; partial content may have been written.");
    throw error;
  }
}

function buildStreamingWritebackPrompt(
  kind: StreamingWritebackKind,
  preparedSectionEdit: PreparedStreamingSectionEdit | null,
): string {
  if (kind === "append") {
    return [
      "Write the markdown content to append to the current note now.",
      "Return only the markdown that should be appended.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

  if (kind === "replace") {
    return [
      "Write the full replacement markdown for the current note now.",
      "Return only the complete replacement note content.",
      "Do not include preambles, explanations, receipts, or thinking traces.",
    ].join(" ");
  }

  return [
    `Write the replacement markdown body for the section "${preparedSectionEdit?.heading ?? "target section"}" now.`,
    "Do not include the heading line itself.",
    "Return only the markdown body that belongs under that heading.",
    "Do not include preambles, explanations, receipts, or thinking traces.",
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
  const current = await toolContext.app.vault.read(file);
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
    async finish(options: { force?: boolean } = {}) {
      if (options.force || streamedContent.length > 0 || pendingChars > 0) {
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
  const file = toolContext.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    throw new Error("An active markdown file is required.");
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
    /<\s*\|\s*(?:begin\s*_+\s*of\s*_+\s*sentence|end\s*_+\s*of\s*_+\s*sentence|start\s*_+\s*header\s*_+\s*id|end\s*_+\s*header\s*_+\s*id|eot\s*_+\s*id|eom\s*_+\s*id)\s*\|\s*>/gi,
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
  let index = content.indexOf("<", searchStart);

  while (index >= 0) {
    const candidate = normalizeSpecialTokenCandidate(content.slice(index));

    if (
      candidate &&
      NORMALIZED_SPECIAL_TOKENS.some((token) => token.startsWith(candidate))
    ) {
      return index;
    }

    index = content.indexOf("<", index + 1);
  }

  return -1;
}

function normalizeSpecialTokenCandidate(candidate: string): string {
  return candidate.toLowerCase().replace(/\s+/g, "").replace(/_+/g, "");
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
    stopReason === "budget" ? "stopped" : "done",
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
    case "budget":
      return "Stopped at safety limit. Review partial results.";
    case "error":
      return "Error.";
    case "final":
    default:
      return "Done.";
  }
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
