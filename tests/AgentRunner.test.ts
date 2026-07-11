import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AGENT_STEPS,
  resolveThinkingMode,
  runAgentMission,
  sanitizeAssistantContent,
  buildStreamingWritebackPromptForTests,
  type AgentRunCompleteEvent,
  type AgentRunConfigEvent,
  type AgentRunMetricEvent,
  type AgentRunReceipt,
  type AgentTraceEvent,
} from "../src/AgentRunner";
import { ModelClientError } from "../src/model/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../src/tools/types";
import type {
  AgentSettings,
  StreamWritebackMode,
  ThinkingMode,
} from "../src/settings";
import type { SemanticEmbeddingProvider } from "../src/embeddings/types";
import {
  BACKUP_FOLDER,
  MAX_INITIAL_CURRENT_NOTE_CHARS,
} from "../src/tools/constants";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import {
  ApprovalBroker,
  type ApprovalRequest,
} from "../src/agent/approvalBroker";
import { __setCodeToolsDesktopAppForTests } from "../src/tools/codeTools";
import { extractEvidencePassages } from "../src/agent/researchDossier";
import {
  withPreparedActionFingerprint,
  type ToolDescriptor,
} from "../src/agent/actions";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { AgentTool } from "../src/tools/types";
import { parseMissionRuntimeSnapshotFromMarkdown } from "../src/agent/runStore";

test("observes the current note before the first model planning step", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Final answer")],
  });

  await runAgentMission({
    prompt: "What is this current note about?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.deepEqual(executedCalls[0].arguments, {
    maxChars: MAX_INITIAL_CURRENT_NOTE_CHARS,
  });
  assert.equal(chatRequests.length, 1);
  const currentNoteContextMessage = chatRequests[0].messages.find((message) =>
    /Current note context/.test(message.content),
  );
  assert.ok(currentNoteContextMessage);
  assert.match(currentNoteContextMessage.content, /"path":"Current.md"/);
  assert.match(currentNoteContextMessage.content, /"content":"Initial note"/);
  assert.deepEqual(statuses.slice(0, 3), [
    "Reading current note...",
    "Planning...",
    "Agent step 1 of max 2...",
  ]);
  assert.deepEqual(deltas, ["Final answer"]);
  assert.ok(statuses.includes("Done."));
});

test("current-note observe failure stops before calling the model", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("should not run")],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt: "What is this current note about?",
        modelClient: client,
        toolRegistry: createRegistry(executedCalls, {
          readCurrentError: "An active markdown file is required.",
        }),
        toolContext: {} as ToolExecutionContext,
        enableStreaming: false,
      }),
    /active markdown file/,
  );

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(chatRequests.length, 0);
});

test("vague follow-up continues a pending current-note read", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Current note content: Initial note")],
  });

  await runAgentMission({
    prompt: "Continue",
    conversationHistory: [
      {
        role: "assistant",
        content: "I'll read the current note to see what prompt is available.",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(chatRequests.length, 1);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Resolve this turn's tool routing as: "Read the current note\."/i.test(
        message.content,
      ),
    ),
  );
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Current note context/.test(message.content),
    ),
  );
  assert.deepEqual(deltas, ["Current note content: Initial note"]);
});

test("includes prior user and assistant chat history before current prompt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Expanded essay")],
  });

  await runAgentMission({
    prompt: "Edit the essay you gave me with more details.",
    conversationHistory: [
      { role: "user", content: "Write a short essay about coral reefs." },
      { role: "assistant", content: "Coral reefs are living ocean cities." },
    ],
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 1);
  const messages = chatRequests[0].messages;
  assert.match(
    messages.at(-4)?.content ?? "",
    /Recent chat history is included/,
  );
  assert.deepEqual(messages.slice(-3), [
    { role: "user", content: "Write a short essay about coral reefs." },
    { role: "assistant", content: "Coral reefs are living ocean cities." },
    { role: "user", content: "Edit the essay you gave me with more details." },
  ]);
  assert.deepEqual(deltas, ["Expanded essay"]);
});

test("tool-loop turns use chat only and emit direct final answer without synthesis", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "WW2 causes" }),
      () => responseWithToolCall("web_search", { query: "WW2 battles" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Final WW2 answer. Source: https://example.com/source",
          "thinking from final",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web and give me a short overview of WW2.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 4);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_search", "web_fetch"],
  );
  assert.deepEqual(
    executedCalls
      .filter((call) => call.name === "web_search")
      .map((call) => call.arguments.query),
    ["WW2 causes", "WW2 battles"],
  );
  assert.deepEqual(deltas, [
    "Final WW2 answer. Source: https://example.com/source",
  ]);
  assert.deepEqual(thinkingDeltas, ["thinking from final"]);
});

test("assistant JSON tool blocks are recovered and executed as tool calls", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          [
            "I'll inspect the current folder first.",
            "",
            "```json",
            '{ "name": "list_current_folder" }',
            "```",
          ].join("\n"),
        ),
      () => responseWithContent("I found the folder details."),
    ],
  });

  await runAgentMission({
    prompt: "Inspect the vault structure with tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_current_folder"],
  );
  assert.deepEqual(deltas, ["I found the folder details."]);
  assert.ok(
    statuses.some((message) =>
      message.includes("Recovered text tool request: list_current_folder"),
    ),
  );
});

test("assistant compact tool JSON recovers tool field and top-level arguments", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          '{"tool":"rename_current_file","title":"History Snapshot"}',
        ),
      () => responseWithContent("Renamed."),
    ],
  });

  await runAgentMission({
    prompt: "No, you need to target Untitled and then change that.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => [call.name, call.arguments.title]),
    [["read_current_file", undefined], ["rename_current_file", "History Snapshot"]],
  );
});

test("assistant XML-ish tool blocks are recovered and executed as tool calls", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          [
            "<requested_tool_call>",
            "<name>list_folder</name>",
            "<arguments>{\"path\":\"/\"}</arguments>",
            "</requested_tool_call>",
          ].join(""),
        ),
      () => responseWithContent("Root folder inspected."),
    ],
  });

  await runAgentMission({
    prompt: "Look through my vault folders.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_folder"],
  );
  assert.deepEqual(executedCalls[0].arguments, { path: "" });
  assert.ok(
    statuses.some((message) =>
      message.includes("Recovered text tool request: list_folder"),
    ),
  );
});

test("recovered list_folder slash path targets the vault root", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          [
            "I'll continue exploring your vault structure.",
            "",
            "\\`\\`\\`json",
            '{ "name": "list_folder", "arguments": { "path": "/" } }',
            "\\`\\`\\`",
          ].join("\n"),
        ),
      () => responseWithContent("Root folder inspected."),
    ],
  });

  await runAgentMission({
    prompt: "Inspect the vault structure with tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_folder"],
  );
  assert.deepEqual(executedCalls[0].arguments, { path: "" });
  assert.deepEqual(deltas, ["Root folder inspected."]);
});

test("vague keep-going prompts inherit prior vault tool exploration intent", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("list_folder", { path: "" }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["Vault folder exploration can continue."]),
    ],
  });

  await runAgentMission({
    prompt: "Keep going",
    conversationHistory: [
      {
        role: "assistant",
        content:
          'I will inspect the vault root.\n```json\n{ "name": "list_folder", "arguments": { "path": "/" } }\n```',
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Continue the prior vault exploration/.test(message.content),
    ),
  );
  assert.ok(
    chatRequests[0].tools
      ?.map((tool) => tool.function.name)
      .includes("list_folder"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_folder"],
  );
  assert.deepEqual(finalDeltas, ["Vault folder exploration can continue."]);
});

test("static essay prompts stream to chat and append to the current note", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const planningDeltas: string[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Write me a short essay about the Mexican-American war.",
    content: "Existing note",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "A 300 word ",
          "Mexican-American War essay.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Write me a short essay about the Mexican-American war.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onPlanningDelta: (delta) => planningDeltas.push(delta),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].tools, undefined);
  assert.equal(streamRequests[0].think, undefined);
  assert.deepEqual(planningDeltas, []);
  assert.deepEqual(finalDeltas, ["A 300 word Mexican-American War essay."]);
  assert.deepEqual(assistantDeltas, ["A 300 word Mexican-American War essay."]);
  assert.equal(
    vault.content.get("Current.md"),
    "Existing note\nA 300 word Mexican-American War essay.",
  );
  assert.ok(statuses.includes("Using direct note writeback; no tool loop needed..."));
  assert.ok(statuses.includes("Streaming writeback to note..."));
});

test("plain Q&A defaults to streamed current-note writeback when an active note exists", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt: "What is 2+2?",
    content: "# Scratch\n\n",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["2+2 equals ", "4."]),
    ],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get("Current.md"), "# Scratch\n\n2+2 equals 4.");
  assert.equal(finalDeltas.join(""), "2+2 equals 4.");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.equal((receipts[0].output as { streamed?: boolean }).streamed, true);
  assert.equal(configs[0].writebackMode, "streaming_current_note");
  assert.equal(configs[0].chatOnlyOverride, false);
});

test("prompt-level chat-only wording leaves the active note unchanged", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const original = "Original note";
  const prompt = "What is 2+2? Answer in chat only; do not write to the note.";
  const vault = createRunnerVaultContext({ prompt, content: original });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["In chat only: 2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(assistantDeltas, ["In chat only: 2+2 equals 4."]);
  assert.equal(vault.content.get("Current.md"), original);
  assert.equal(receipts.length, 0);
  assert.equal(configs[0].writebackMode, "off");
  assert.equal(configs[0].chatOnlyOverride, false);
});

test("forceChatOnly leaves the active note unchanged without mutating the prompt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const original = "Original note";
  const prompt = "What is 2+2?";
  const vault = createRunnerVaultContext({ prompt, content: original });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    forceChatOnly: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].messages.at(-1)?.content, prompt);
  assert.equal(vault.content.get("Current.md"), original);
  assert.equal(receipts.length, 0);
  assert.equal(configs[0].writebackMode, "off");
  assert.equal(configs[0].chatOnlyOverride, true);
});

test("vault folder synthesis defaults to streamed note writeback after reads", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const prompt = "Synthesize what the notes in the Other folder say.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Synthesis\n\n",
  });
  vault.folders.add("Other");
  vault.content.set("Other/alpha.md", "The Other folder mentions quasarflux.");

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Other notes mention quasarflux."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get("Current.md"), "# Synthesis\n\nOther notes mention quasarflux.");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.equal(configs.at(-1)?.writebackMode, "streaming_current_note");
  assert.equal(configs.at(-1)?.route, "prefetched_vault_writeback");
});

test("plain Q&A creates a new note when no active markdown note exists", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt: "What is 2+2?",
    content: "",
  });
  // No active markdown note — force autonomous create path.
  (vault.context.app.workspace as { getActiveFile: () => null }).getActiveFile =
    () => null;
  vault.context.getCurrentMarkdownFile = () => null;
  (vault.context.app as { fileManager?: unknown }).fileManager = {
    getNewFileParent: () => ({ path: "" }),
    renameFile: async (
      file: { path: string; basename?: string },
      newPath: string,
    ) => {
      await vault.context.app.vault.rename(file as never, newPath);
    },
  };
  vault.context.settings = createRunnerSettings({
    outputProfile: "active_or_new_note",
    autonomyProfile: "automatic",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["# Answer\n\n2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.ok(assistantDeltas.join("").includes("2+2 equals 4."));
  assert.ok(receipts.length >= 1);
  const planEvent = configs.find((event) => event.noteOutputPlan);
  assert.equal(planEvent?.noteOutputPlan?.destination, "new_note");
  assert.ok(
    [...vault.content.keys()].some(
      (path) =>
        path.endsWith(".md") &&
        !path.startsWith("Agent Runs/") &&
        (path.includes("Untitled") || path.includes("Answer")),
    ),
  );
});

test("plain Q&A falls back to chat when output profile is chat_first and no note is active", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const assistantDeltas: string[] = [];
  const receipts: AgentRunReceipt[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["2+2 equals 4."]),
    ],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: {
      app: {
        workspace: {
          getActiveFile: () => null,
        },
        vault: {},
      } as never,
      settings: createRunnerSettings({
        outputProfile: "chat_first",
        streamWritebackMode: "off",
      }),
      originalPrompt: "What is 2+2?",
      httpTransport: async () => ({
        status: 500,
        headers: {},
        json: { error: "not mocked" },
      }),
    },
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(assistantDeltas, ["2+2 equals 4."]);
  assert.equal(receipts.length, 0);
});

test("artifact path destructive code and browser prompts are not coerced into current-note append", async () => {
  const cases = [
    "Create a design canvas for onboarding.",
    "Create a note at Projects/Test.md with hello.",
    "Delete the current note.",
    "Run this JavaScript code: console.log(1).",
    "Open the browser and inspect https://example.com.",
  ];

  for (const prompt of cases) {
    const chatRequests: ModelChatRequest[] = [];
    const streamRequests: ModelChatRequest[] = [];
    const receipts: AgentRunReceipt[] = [];
    const configs: AgentRunConfigEvent[] = [];
    const original = "Original note";
    const vault = createRunnerVaultContext({ prompt, content: original });
    vault.context.settings = createRunnerSettings({
      browserToolsEnabled: true,
    });
    const client = createClient({
      chatRequests,
      streamRequests,
      chatResponders: Array.from(
        { length: MAX_AGENT_STEPS },
        () => () => responseWithContent("Handled in chat/tool routing."),
      ),
    });

    await runAgentMission({
      prompt,
      modelClient: client,
      toolRegistry: createDefaultToolRegistry(),
      toolContext: vault.context,
      enableStreaming: true,
      events: {
        onReceipt: (receipt) => receipts.push(receipt),
        onRunConfig: (event) => configs.push(event),
      },
    });

    assert.equal(vault.content.get("Current.md"), original, prompt);
    assert.equal(streamRequests.length, 0, prompt);
    assert.equal(receipts.length, 0, prompt);
    assert.notEqual(configs[0].writebackMode, "streaming_current_note", prompt);
  }
});

test("word-target generation writeback performs one internal correction pass", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const finalReplacements: string[] = [];
  const statuses: string[] = [];
  const correctedDraft = "one two three four five six seven eight nine ten";
  const vault = createRunnerVaultContext({
    prompt: "Write exactly 10 words about Obsidian.",
    content: "Existing note",
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Obsidian draft."]),
    ],
    chatResponders: [
      () => responseWithContent(correctedDraft),
    ],
  });

  await runAgentMission({
    prompt: "Write exactly 10 words about Obsidian.",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onFinalReplace: (content) => finalReplacements.push(content),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(chatRequests.length, 1);
  assert.deepEqual(finalDeltas, ["Obsidian draft."]);
  assert.deepEqual(finalReplacements, [correctedDraft]);
  assert.ok(
    statuses.includes(
      "Word count 2/10 outside target; requesting one correction pass...",
    ),
  );
  assert.ok(
    statuses.includes("Word count: 10/10 (within target; correction=used)."),
  );
  assert.equal(vault.content.get("Current.md"), `Existing note\n${correctedDraft}`);
});

test("prompt-on-page generation streams the extracted answer into the current note", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const notePrompt =
    "Prompt: Write a short English response about The Grapes of Wrath by John Steinbeck.";
  const vault = createRunnerVaultContext({
    prompt: "Read the prompt on the page",
    content: notePrompt,
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "Steinbeck's ",
          "The Grapes of Wrath follows migrant families with grounded detail.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Read the prompt on the page",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onReceipt: (receipt) =>
        receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].tools, undefined);
  assert.equal(streamRequests[0].think, undefined);
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Current note context/.test(message.content),
    ),
  );
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Extract the prompt, instructions, question, or task/.test(message.content),
    ),
  );
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Prompt-on-page writeback is active/.test(message.content),
    ),
  );
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /Write the markdown content to append to the current note now/i,
  );
  assert.equal(
    finalDeltas.join(""),
    "Steinbeck's The Grapes of Wrath follows migrant families with grounded detail.",
  );
  assert.deepEqual(assistantDeltas, finalDeltas);
  assert.equal(
    vault.content.get("Current.md"),
    `${notePrompt}\nSteinbeck's The Grapes of Wrath follows migrant families with grounded detail.`,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.equal(receipts[0].streamed, true);
  assert.ok(statuses.includes("Reading current note..."));
  assert.ok(statuses.includes("Streaming writeback to note..."));
  assert.ok(statuses.includes("Streaming writeback complete."));
});

test("prompt-on-page citation prompts use tools before streamed writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const notePrompt =
    "Use web search to write a concise essay about The Grapes of Wrath with cited source URLs.";
  const vault = createRunnerVaultContext({
    prompt: "Read the prompt on the page",
    content: notePrompt,
  });
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "The Grapes of Wrath source",
              url: "https://example.com/grapes-of-wrath",
              snippet: "Steinbeck and the Joad family during the Depression.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "The Grapes of Wrath source",
          content:
            "Steinbeck's novel follows the Joad family under Depression-era pressure.",
          links: [],
        },
      };
    }
    return { status: 404, headers: {}, json: { error: "not mocked" } };
  };

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "The Grapes of Wrath Steinbeck sources",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes-of-wrath",
        }),
      () => responseWithContent("Ready to write the cited essay."),
    ],
    streamResponders: [
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId, "streamed writeback must receive a fetched passage id");
        return responseWithContentDeltas([
          "Steinbeck's novel follows the Joad family under Depression-era pressure. ",
          `Source: https://example.com/grapes-of-wrath Passage evidence: [${passageId}]`,
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt: "Read the prompt on the page",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.ok(firstStepToolNames.includes("append_to_current_file"));
  assert.match(chatRequests[0].messages.at(-1)?.content ?? "", /cited source URLs/);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /current note has already been read/i.test(message.content),
    ),
  );
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Use the relevant available tools before final writeback/i.test(
        message.content,
      ),
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "web_search", "web_fetch"],
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "read_current_file").length,
    1,
  );
  assert.ok(statuses.includes("Using prompt from current note for tool routing..."));
  assert.ok(
    !statuses.includes(
      "Sources or vault tools are required; asking model to use tools before writing...",
    ),
  );
  assert.equal(
    vault.content.get("Current.md"),
    `${notePrompt}\nSteinbeck's novel follows the Joad family under Depression-era pressure. Source: https://example.com/grapes-of-wrath Passage evidence: [${getPassageCitationIds(streamRequests[0])[0]}]`,
  );
});

test("notepage prompt wrapper routes to prefetched vault writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const notePrompt = [
    "You job is to traverse the 3 untitled folders. They are named Untitled, Untitled 1 and Untitled 2.",
    "",
    "I need you to tell me about the things discovered in those folders. Specifically, I want you to stream them onto this page.",
  ].join("\n");
  const streamedFinding = "quasarflux";
  const vault = createRunnerVaultContext({
    prompt: "Refer  to the notes in the notepage as the prompt",
    content: notePrompt,
  });
  vault.content.set("Untitled/alpha.md", "quasarflux discovery");
  vault.content.set("Untitled 1/beta.md", "beta discovery");
  vault.content.set("Untitled 2/gamma.md", "gamma discovery");

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas([streamedFinding]),
    ],
  });

  await runAgentMission({
    prompt: "Refer  to the notes in the notepage as the prompt",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "inspect_vault_context"],
  );
  assert.deepEqual(executedCalls[1].arguments, {
    scope: "all_vault",
    targetFolders: ["Untitled", "Untitled 1", "Untitled 2"],
  });
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].tools, undefined);
  assert.equal(streamRequests[0].think, undefined);
  assert.equal(configs.at(-1)?.route, "prefetched_vault_writeback");
  assert.equal(configs.at(-1)?.writebackMode, "streaming_current_note");
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Prefetched vault context/.test(message.content),
    ),
  );
  assert.equal(vault.content.get("Current.md"), `${notePrompt}\n${streamedFinding}`);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "append");
  assert.ok(statuses.includes("Inspecting named vault folders locally..."));
  assert.ok(!statuses.some((status) => /Vault traversal required/i.test(status)));
  assert.ok(
    !statuses.some((status) =>
      /could not get the model to request vault tools/i.test(status),
    ),
  );
});

test("prompt-on-page routing ignores prior generated findings as instructions", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const notePrompt = [
    "You job is to traverse the 3 untitled folders. They are named Untitled, Untitled 1 and Untitled 2.",
    "",
    "I need you to tell me about the things discovered in those folders. Specifically, I want you to stream them onto this page.",
    "## Findings",
    "",
    "- Old generated finding that should remain context only.",
    "",
    "## A Tale of Toyota, Lion, and Blue",
    "",
    "Old generated story that should not become the new mission.",
  ].join("\n");
  const vault = createRunnerVaultContext({
    prompt: "Refer to the notes in the notepage as the prompt",
    content: notePrompt,
  });
  vault.content.set("Untitled/alpha.md", "alpha discovery");
  vault.content.set("Untitled 1/beta.md", "beta discovery");
  vault.content.set("Untitled 2/gamma.md", "gamma discovery");
  const client = createClient({
    chatRequests: [],
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Fresh folder findings."]),
    ],
  });

  await runAgentMission({
    prompt: "Refer to the notes in the notepage as the prompt",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "inspect_vault_context"],
  );
  assert.deepEqual(executedCalls[1].arguments, {
    scope: "all_vault",
    targetFolders: ["Untitled", "Untitled 1", "Untitled 2"],
  });
  const userMission =
    [...streamRequests[0].messages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
  assert.match(userMission, /traverse the 3 untitled folders/i);
  assert.doesNotMatch(userMission, /Old generated finding/);
  assert.doesNotMatch(userMission, /A Tale of Toyota/);
  assert.equal(vault.content.get("Current.md"), `${notePrompt}\nFresh folder findings.`);
});

test("below Findings section routes to section append with backup", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const vault = createRunnerVaultContext({
    prompt:
      "Great, below the Findings section, can you write me a short story incorporating my favorite things?",
    content: [
      "# Research Note",
      "",
      "## Findings",
      "",
      "- Favorite car brand: Toyota.",
      "- Favorite animal: Lion.",
      "- Favorite color: Blue.",
      "",
      "## Next",
      "",
      "Keep this section.",
    ].join("\n"),
    now: new Date(321),
  });
  const story = "A blue Toyota carried a lion toward a quiet sunrise.";
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_section", {
          heading: "Findings",
          level: 2,
          content: story,
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Great, below the Findings section, can you write me a short story incorporating my favorite things?",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "Favorite car brand: Toyota. Favorite animal: Lion. Favorite color: Blue.",
      },
    ],
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_section"],
  );
  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("append_to_current_section"));
  assert.ok(!firstToolNames.includes("append_to_current_file"));
  assert.equal(
    vault.content.get("Current.md"),
    [
      "# Research Note",
      "",
      "## Findings",
      "",
      "- Favorite car brand: Toyota.",
      "- Favorite animal: Lion.",
      "- Favorite color: Blue.",
      "",
      story,
      "",
      "## Next",
      "",
      "Keep this section.",
    ].join("\n"),
  );
  assert.equal(
    vault.content.get(".agent-backups/321-Current.md"),
    [
      "# Research Note",
      "",
      "## Findings",
      "",
      "- Favorite car brand: Toyota.",
      "- Favorite animal: Lion.",
      "- Favorite color: Blue.",
      "",
      "## Next",
      "",
      "Keep this section.",
    ].join("\n"),
  );
  assert.equal(receipts[0].toolName, "append_to_current_section");
  assert.equal(receipts[0].backupPath, ".agent-backups/321-Current.md");
});

test("context follow-up favorite things passes relevance gate", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const client = createClient({
    chatRequests: [],
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "A blue Toyota waited as a lion crossed the quiet road.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Write a short story incorporating my favorite things.",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "Favorite car brand: Toyota. Favorite animal: Lion. Favorite color: Blue.",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(
    finalDeltas.join(""),
    "A blue Toyota waited as a lion crossed the quiet road.",
  );
  assert.ok(
    !statuses.includes(
      "Stopped model output because it drifted off topic from the current mission.",
    ),
  );
});

test("delete all notes on the page routes to replace-current-page with backup", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt =
    "I want you to delete all the notes on the page and then write a 300 word essay on the renaissance.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Old Notes\n\nOld Renaissance notes to remove.",
    now: new Date(987),
  });
  const backupVault = vault.context.app.vault as never as {
    getFolderByPath: (path: string) => unknown;
    createFolder: (path: string) => Promise<void>;
  };
  const originalGetFolderByPath = backupVault.getFolderByPath;
  backupVault.getFolderByPath = (path: string) =>
    path === BACKUP_FOLDER ? null : originalGetFolderByPath(path);
  backupVault.createFolder = async (path: string) => {
    vault.operations.push(`createFolder:${path}`);
    if (path === BACKUP_FOLDER) {
      throw new Error("Folder already exists.");
    }
  };
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithContent("Ready to replace the page."),
      () =>
        responseWithContent(
          "# The Renaissance\n\nThe Renaissance reshaped European art, science, and humanist thought.",
        ),
    ],
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# The Renaissance\n\n",
          "The Renaissance reshaped European art, science, and humanist thought.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("Current.md"),
    "# The Renaissance\n\nThe Renaissance reshaped European art, science, and humanist thought.",
  );
  assert.equal(
    vault.content.get(".agent-backups/987-Current.md"),
    "# Old Notes\n\nOld Renaissance notes to remove.",
  );
  assert.ok(vault.operations.includes(`createFolder:${BACKUP_FOLDER}`));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "replace");
  assert.equal(receipts[0].toolName, "replace_current_file");
});

test("research memory save uses durable memory tool with streaming enabled", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt =
    "Save this to research memory for E2E memory topic: E2E_MEMORY_MARKER.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-04T12:00:00.000Z"),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      (request) => {
        const toolNames =
          request.tools?.map((tool) => tool.function.name).filter(Boolean) ?? [];
        assert.ok(toolNames.includes("append_research_memory"));
        assert.ok(!toolNames.includes("append_to_current_file"));
        return responseWithToolCall("append_research_memory", {
          topic: "E2E memory topic",
          text: "E2E_MEMORY_MARKER",
          keywords: ["e2e", "memory"],
        });
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_research_memory"],
  );
  assert.match(
    vault.content.get("Agent Memory/Research/e2e-memory-topic.md") ?? "",
    /E2E_MEMORY_MARKER/,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_research_memory");
});

test("prompt-on-page word target counts generated output only before writing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const notePrompt = "Prompt: Write exactly 5 words about Obsidian.";
  const correctedDraft = "one two three four five";
  const vault = createRunnerVaultContext({
    prompt: "Read the prompt on the page",
    content: notePrompt,
  });

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Obsidian note"]),
    ],
    chatResponders: [
      () => responseWithContent(correctedDraft),
    ],
  });

  await runAgentMission({
    prompt: "Read the prompt on the page",
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
  assert.equal(vault.content.get("Current.md"), `${notePrompt}\n${correctedDraft}`);
  assert.ok(
    statuses.includes(
      "Word count 2/5 outside target; requesting one correction pass...",
    ),
  );
  assert.ok(
    statuses.includes("Word count: 5/5 (within target; correction=used)."),
  );
});

test("buffered final answers strip raw model special tokens", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("<|begin_of_sentence|>Final answer<|end_of_sentence|>"),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about the Vietnam War?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(deltas, ["Final answer"]);
});

test("english prompts include english response policy", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("English answer")],
  });

  await runAgentMission({
    prompt: "Write a short essay about The Grapes of Wrath.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const promptText = chatRequests[0].messages
    .map((message) => message.content)
    .join("\n");

  assert.match(promptText, /Default to English for English missions/);
  assert.match(promptText, /Do not switch to Chinese/);
  assert.match(promptText, /Stay on the user's requested topic/);
});

test("plain static writing prompts do not expose current-note write tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Static answer"),
    ],
  });

  await runAgentMission({
    prompt: "I want you to generate a concise research paragraph regarding the Vietnam War.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("read_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("web_search"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.deepEqual(deltas, ["Static answer"]);
});

test("vault traversal prompts expose folder and path inspection tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_current_folder", {}),
      () => responseWithContent("Vault placement answer"),
    ],
  });

  await runAgentMission({
    prompt: "Browse the vault folders and suggest where this note belongs.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("list_current_folder"));
  assert.ok(toolNames.includes("list_folder"));
  assert.ok(toolNames.includes("get_path_info"));
  assert.ok(toolNames.includes("list_markdown_files"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "list_current_folder"],
  );
});

test("path CRUD prompts expose only the relevant mutation tools", async () => {
  const scenarios: Array<{
    prompt: string;
    expected: string[];
    absent: string[];
  }> = [
    {
      prompt: "Create a new markdown file at Projects/Brief.md.",
      expected: ["create_file"],
      absent: ["create_folder", "append_to_current_file", "replace_current_file"],
    },
    {
      prompt: "Create a folder at Projects/New.",
      expected: ["create_folder"],
      absent: ["create_file", "replace_file", "delete_path"],
    },
    {
      prompt: "Append this text to the file Projects/Brief.md.",
      expected: ["append_file"],
      absent: ["append_to_current_file", "replace_file"],
    },
    {
      prompt: "Replace the file Projects/Brief.md with a clean brief.",
      expected: ["replace_file"],
      absent: ["replace_current_file", "append_file"],
    },
    {
      prompt: "Rename the file Projects/Brief.md to Projects/Renamed.md.",
      expected: ["move_path"],
      absent: ["retitle_current_file", "replace_file"],
    },
    {
      prompt: "Delete the folder Projects/Archive.",
      expected: ["delete_path"],
      absent: ["delete_current_file", "replace_file"],
    },
  ];

  for (const scenario of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: Array.from(
        { length: MAX_AGENT_STEPS },
        () => () => responseWithContent("Done"),
      ),
    });

    await runAgentMission({
      prompt: scenario.prompt,
      modelClient: client,
      toolRegistry: createRegistry([]),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const toolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    for (const toolName of scenario.expected) {
      assert.ok(toolNames.includes(toolName), scenario.prompt);
    }

    for (const toolName of scenario.absent) {
      assert.ok(!toolNames.includes(toolName), scenario.prompt);
    }
  }
});

test("template prompts expose template tools without generic file creation", async () => {
  const scenarios: Array<{
    prompt: string;
    expected: string[];
    absent: string[];
  }> = [
    {
      prompt: "List my saved templates.",
      expected: ["list_templates", "read_template"],
      absent: ["create_template", "fill_template", "create_file"],
    },
    {
      prompt: "Create a reusable meeting notes template.",
      expected: ["create_template"],
      absent: ["seed_default_templates", "fill_template", "create_file"],
    },
    {
      prompt: "Seed the default starter templates.",
      expected: ["seed_default_templates"],
      absent: ["create_template", "fill_template", "create_file"],
    },
    {
      prompt:
        "Use the meeting template to create a note at Meetings/Product Sync.md.",
      expected: ["list_templates", "read_template", "fill_template"],
      absent: ["seed_default_templates", "create_file", "append_to_current_file"],
    },
    {
      prompt: "Create a research pack with a brief, sources index, and synthesis.",
      expected: ["create_research_pack"],
      absent: ["create_file", "fill_template", "append_to_current_file"],
    },
    {
      prompt: "Write a 500 word essay about coral reefs.",
      expected: [],
      absent: [
        "list_templates",
        "read_template",
        "seed_default_templates",
        "create_template",
        "fill_template",
      ],
    },
  ];

  for (const scenario of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: Array.from(
        { length: MAX_AGENT_STEPS },
        () => () => responseWithContent("Done"),
      ),
    });

    await runAgentMission({
      prompt: scenario.prompt,
      modelClient: client,
      toolRegistry: createRegistry([]),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const toolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    for (const toolName of scenario.expected) {
      assert.ok(toolNames.includes(toolName), scenario.prompt);
    }

    for (const toolName of scenario.absent) {
      assert.ok(!toolNames.includes(toolName), scenario.prompt);
    }
  }
});

test("path write prompts require the matching path-based write tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I would create it in chat only."),
      () =>
        responseWithToolCall("create_file", {
          path: "Projects/Brief.md",
          content: "# Brief",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Create a new markdown file at Projects/Brief.md.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: create_file/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_file"],
  );
  assert.ok(statuses.includes("Created file Projects/Brief.md."));
});

test("template fill prompts require fill_template and emit a create receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I filled it in chat only."),
      () =>
        responseWithToolCall("fill_template", {
          templatePath: "Meeting.md",
          values: { title: "Product Sync" },
          targetPath: "Meetings/Product Sync.md",
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Use the meeting template to create a note at Meetings/Product Sync.md.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: fill_template/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["fill_template"],
  );
  assert.ok(statuses.includes("Created filled template note Meetings/Product Sync.md."));
  assert.deepEqual(receipts, ["create Meetings/Product Sync.md"]);
});

test("default template seed prompts require seed_default_templates and emit receipts", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I created the templates in chat only."),
      () =>
        responseWithToolCall("seed_default_templates", {
          createFolders: true,
        }),
    ],
  });

  await runAgentMission({
    prompt: "Seed the default starter templates in my vault.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: seed_default_templates/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["seed_default_templates"],
  );
  assert.ok(statuses.includes("Created 6 default templates."));
  assert.deepEqual(receipts, ["create Templates; affected: 6"]);
});

test("design prompts expose and require native artifact write tools", async () => {
  const scenarios: Array<{
    prompt: string;
    requiredTool: string;
    absentTool: string;
    expectedStatus: string;
    expectedReceipt: string;
  }> = [
    {
      prompt: "Draw an Obsidian canvas product flow diagram.",
      requiredTool: "create_design_canvas",
      absentTool: "create_svg_design",
      expectedStatus: "Created canvas Designs/Product Flow.canvas with 2 nodes and 1 edges.",
      expectedReceipt: "create Designs/Product Flow.canvas",
    },
    {
      prompt: "Create a software architecture diagram for the agent.",
      requiredTool: "create_design_canvas",
      absentTool: "create_svg_design",
      expectedStatus: "Created canvas Designs/Product Flow.canvas with 2 nodes and 1 edges.",
      expectedReceipt: "create Designs/Product Flow.canvas",
    },
    {
      prompt: "Create an SVG wireframe mockup for the settings screen.",
      requiredTool: "create_svg_design",
      absentTool: "create_design_canvas",
      expectedStatus: "Created SVG Designs/settings-wireframe.svg with 3 shapes.",
      expectedReceipt: "create Designs/settings-wireframe.svg",
    },
  ];

  for (const scenario of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const statuses: string[] = [];
    const receipts: string[] = [];
    const executedCalls: ModelToolCall[] = [];

    const client = createClient({
      chatRequests,
      chatResponders: [
        () => responseWithContent("I described the design in chat only."),
        () => responseWithToolCall(scenario.requiredTool, {}),
      ],
    });

    await runAgentMission({
      prompt: scenario.prompt,
      modelClient: client,
      toolRegistry: createRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
      events: {
        onStatus: (message) => statuses.push(message),
        onReceipt: (receipt) => receipts.push(receipt.message),
      },
    });

    const firstToolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(firstToolNames.includes(scenario.requiredTool), scenario.prompt);
    assert.ok(!firstToolNames.includes(scenario.absentTool), scenario.prompt);
    assert.match(
      chatRequests[1].messages.at(-1)?.content ?? "",
      new RegExp(`Request one of these allowed write tools now: ${scenario.requiredTool}`),
    );
    assert.deepEqual(
      executedCalls.map((call) => call.name),
      [scenario.requiredTool],
    );
    assert.ok(statuses.includes(scenario.expectedStatus), scenario.prompt);
    assert.deepEqual(receipts, [scenario.expectedReceipt]);
  }
});

test("diagram follow-up after chat answer creates a native canvas artifact", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: string[] = [];
  const assistantDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I can describe the diagram in chat."),
      () => responseWithToolCall("create_design_canvas", {}),
    ],
  });

  await runAgentMission({
    prompt: "Can you create us the diagram?",
    conversationHistory: [
      {
        role: "assistant",
        content:
          "Here is Mermaid diagram text for a literary recommendation flowchart.",
      },
      {
        role: "user",
        content: "Why can't you create the diagram?",
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) => receipts.push(receipt.message),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  const firstToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("create_design_canvas"));
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: create_design_canvas/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_design_canvas"],
  );
  assert.ok(
    statuses.includes("Created canvas Designs/Product Flow.canvas with 2 nodes and 1 edges."),
  );
  assert.deepEqual(receipts, ["create Designs/Product Flow.canvas"]);
  assert.deepEqual(assistantDeltas, [
    "Done. create Designs/Product Flow.canvas.",
  ]);
});

test("explicit web and citation prompts expose web_search and web_fetch", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "Vietnam War scholarship" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/vietnam" }),
      () => responseWithContent("Research answer with https://example.com/vietnam"),
    ],
  });

  await runAgentMission({
    prompt: "Search the web and give me source URLs on recent Vietnam War scholarship.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("web_search"));
  assert.ok(toolNames.includes("web_fetch"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
});

test("current-note summary prompts expose read and append tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Summary" }),
    ],
  });

  await runAgentMission({
    prompt: "Summarize this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  assert.deepEqual(chatRequests[0].tools?.map((tool) => tool.function.name), [
    "read_current_file",
    "append_to_current_file",
  ]);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_file"],
  );
});

test("append-only prompts expose append_to_current_file without reading target-only note content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "## Actions" }),
    ],
  });

  await runAgentMission({
    prompt: "Append 5 action items to this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  assert.deepEqual(
    chatRequests[0].tools?.map((tool) => tool.function.name),
    ["append_to_current_file"],
  );
});

test("page and document write targets expose append_to_current_file", async () => {
  const scenarios = [
    "Can you write this short update onto the page?",
    "Copy this summary into the document.",
  ];

  for (const prompt of scenarios) {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const client = createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("append_to_current_file", {
            text: `Content for ${prompt}`,
          }),
      ],
    });

    await runAgentMission({
      prompt,
      modelClient: client,
      toolRegistry: createRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
    });

    const toolNames =
      chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
    assert.ok(toolNames.includes("append_to_current_file"), prompt);
    assert.deepEqual(
      executedCalls.map((call) => call.name),
      ["append_to_current_file"],
    );
  }
});

test("prior assistant essay follow-up requires current-note append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const priorEssay =
    "The Mexican-American War reshaped borders and politics in North America.";

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "You can copy the text from my previous response and paste it directly.",
        ),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: priorEssay,
        }),
    ],
  });

  await runAgentMission({
    prompt: "Can you write this essay onto the page?",
    conversationHistory: [
      {
        role: "assistant",
        content: priorEssay,
      },
    ],
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[0].tools?.some((tool) => tool.function.name === "append_to_current_file"), true);
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Append the most recent assistant response/.test(message.content),
    ),
  );
  assert.ok(
    chatRequests[0].messages.some((message) => message.content.includes(priorEssay)),
  );
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: append_to_current_file/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.deepEqual(deltas, ["Done. append Current.md."]);
  assert.ok(statuses.includes("Write required; asking model to use a write tool..."));
});

test("vault placement prompts expose markdown file listing", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Placement suggestion")],
  });

  await runAgentMission({
    prompt: "Look at the markdown file names in this vault and suggest where this note belongs.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("list_markdown_files"));
});

test("what do you know about me prompts expose read-only vault traversal tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I found notes about you in the vault."),
    ],
  });

  await runAgentMission({
    prompt: "What do you know about me?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  for (const toolName of [
    "read_current_file",
    "list_current_folder",
    "list_markdown_files",
    "search_markdown_files",
    "read_markdown_files",
    "read_file",
    "list_folder",
    "get_path_info",
  ]) {
    assert.ok(toolNames.includes(toolName), toolName);
  }

  for (const toolName of [
    "append_to_current_file",
    "replace_current_file",
    "delete_current_file",
    "append_file",
    "replace_file",
    "delete_path",
  ]) {
    assert.ok(!toolNames.includes(toolName), toolName);
  }

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(deltas, ["I found notes about you in the vault."]);
  assert.ok(!statuses.includes("Write required; asking model to use a write tool..."));
});

test("other-folder content prompts prefetch vault context before final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "People/Untitled.md says Alex likes local AI tools. Projects/Untitled.md says Alex is building an Obsidian research agent. Archive/Untitled.md says Alex prefers traceable agent actions.",
        ),
    ],
  });

  await runAgentMission({
    prompt: "What do the other notes in the other folders say?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].tools, undefined);
  assert.equal(chatRequests[0].think, undefined);
  assert.match(
    chatRequests[0].messages.map((message) => message.content).join("\n"),
    /Prefetched vault context/i,
  );
  assert.ok(
    statuses.includes(
      "Inspecting vault context locally...",
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
  assert.match(deltas.join(""), /People\/Untitled\.md/);
  assert.ok(!deltas.join("").includes("cannot access"));
});

test("gather-details folder prompts are classified as vault context answers", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent(
          "People/Untitled.md says Alex likes local AI tools.",
        ),
    ],
  });

  await runAgentMission({
    prompt:
      "On this note, I want you to gather details from the other folders and report back to me what they say.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].missionMode, "vault_context_answer");
  assert.equal(configs[0].contextScope, "vault");
  assert.equal(configs[0].vaultContext, true);
  assert.equal(configs[0].currentNoteContext, false);
  assert.equal(configs[0].route, "prefetched_vault_answer");
  assert.equal(configs[0].slowPathReason, "needs_vault_context");
  assert.deepEqual(configs[0].allowedToolNames, []);
  assert.ok(configs[0].routeTraceReasons.includes("prefetchable_vault_folder_answer"));
  assert.equal(
    chatRequests[0].tools,
    undefined,
  );
  assert.equal(chatRequests[0].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
});

test("vault traversal fallback stops after one non-tool correction", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const completions: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I cannot access the vault."),
      () => responseWithContent("I still cannot access the vault."),
    ],
  });

  await runAgentMission({
    prompt: "What do the other notes in the other folders say?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls, {
      inspectVaultError: "mock prefetch failure",
    }),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.ok(
    statuses.includes(
      "Vault traversal required; asking model to inspect folders and notes before answering...",
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["inspect_vault_context"],
  );
  assert.match(deltas.join(""), /could not get the model to request vault tools/i);
  assert.deepEqual(completions, ["error"]);
});

test("model planning errors complete as resumable error stops", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const completions: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        throw new Error("mock model transport failure");
      },
    ],
  });

  await runAgentMission({
    prompt: "Answer a simple question.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(completions, ["error"]);
  assert.ok(
    statuses.includes("Model step failed: mock model transport failure"),
  );
  assert.match(deltas.join(""), /Model step failed: mock model transport failure/);
  assert.match(deltas.join(""), /run "continue run run-/);
});

test("graph connection questions expose read-only graph tools", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("These notes are related.")],
  });

  await runAgentMission({
    prompt: "Are my current note and related notes connected in the Obsidian graph?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  for (const toolName of [
    "get_note_graph_context",
    "find_related_notes",
    "suggest_note_links",
  ]) {
    assert.ok(toolNames.includes(toolName), toolName);
  }
  assert.ok(!toolNames.includes("link_related_notes_in_current_file"));
});

test("connect-note prompts expose inline graph link writing", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("link_related_notes_in_current_file", {}),
    ],
  });

  await runAgentMission({
    prompt: "Connect this note to related notes with inline wiki links.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("get_note_graph_context"));
  assert.ok(toolNames.includes("find_related_notes"));
  assert.ok(toolNames.includes("suggest_note_links"));
  assert.ok(toolNames.includes("link_related_notes_in_current_file"));
});

test("word count prompts expose count_words without write tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("The note has 12 words."),
      () => responseWithToolCall("count_words", {}),
      () => responseWithContent("The note has 12 words."),
    ],
  });

  await runAgentMission({
    prompt: "Count the words in the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("count_words"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["count_words"]);
});

test("streaming-mode word count stays read-only and accepts a concise numeric answer", async () => {
  const prompt = "Use the count_words tool to count the words in the current note.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note content",
  });
  vault.context.settings = createRunnerSettings({
    streamWritebackMode: "all_current_note_content_writes",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("count_words", {}),
      () => responseWithContent("3"),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("count_words"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["count_words"]);
  assert.equal(vault.content.get("Current.md"), "Initial note content");
  assert.equal(deltas.join(""), "3");
});

test("chat-only note write negation does not require append receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("2+2 equals 4. No note write was needed."),
    ],
  });

  await runAgentMission({
    prompt:
      "What is 2+2? Answer in chat only; do not write to the note and do not use tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(executedCalls, []);
  assert.deepEqual(deltas, ["2+2 equals 4. No note write was needed."]);
});

test("what did you learn about me can traverse untitled notes before answering", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_markdown_files", {}),
      () =>
        responseWithToolCall("read_markdown_files", {
          paths: [
            "People/Untitled.md",
            "Projects/Untitled.md",
            "Archive/Untitled.md",
          ],
        }),
      () =>
        responseWithContent(
          "You like local AI tools (People/Untitled.md), are building an Obsidian research agent (Projects/Untitled.md), and prefer traceable actions (Archive/Untitled.md).",
        ),
    ],
  });

  await runAgentMission({
    prompt: "What did you learn about me?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["list_markdown_files", "read_markdown_files"],
  );
  assert.match(deltas.join(""), /People\/Untitled\.md/);
  assert.match(deltas.join(""), /Projects\/Untitled\.md/);
  assert.match(deltas.join(""), /Archive\/Untitled\.md/);
});

test("vault context search prompts expose search and batch read tools", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("search_markdown_files", { query: "MCP" }),
      () => responseWithContent("MCP appears in your notes."),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about MCP?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("search_markdown_files"));
  assert.ok(toolNames.includes("inspect_semantic_index"));
  assert.ok(toolNames.includes("semantic_search_notes"));
  assert.ok(toolNames.includes("read_markdown_files"));
  assert.ok(!toolNames.includes("append_to_current_file"));
});

test("conceptual vault prompts expose semantic search as a read tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "ritual kingship themes",
        }),
      () =>
        responseWithContent(
          "People/Untitled.md is related to ritual kingship themes.",
        ),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about ritual kingship themes?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("inspect_semantic_index"));
  assert.ok(toolNames.includes("semantic_search_notes"));
  assert.ok(toolNames.includes("search_markdown_files"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["semantic_search_notes"],
  );
});

test("direct mutation prompts withhold semantic search", async () => {
  const chatRequests: ModelChatRequest[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Replacement\n\nRitual kingship summary.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Replace the current note with a ritual kingship summary.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("inspect_semantic_index"));
  assert.ok(!toolNames.includes("semantic_search_notes"));
});

test("semantic index maintenance prompts expose rebuild tool only on request", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("rebuild_semantic_index", {}),
      () => responseWithContent("Semantic index rebuilt."),
    ],
  });

  await runAgentMission({
    prompt: "Rebuild the semantic vault index.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("rebuild_semantic_index"));
  assert.ok(!toolNames.includes("inspect_semantic_index"));
  assert.ok(!toolNames.includes("semantic_search_notes"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["rebuild_semantic_index"],
  );
});

test("agentic reflex can upgrade ambiguous prompts to semantic vault routing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Reflex routed answer.")],
  });
  const { context } = createRunnerVaultContext({
    prompt: "Surface ritual kingship implications.",
  });
  context.settings = createRunnerSettings({
    agenticReflexEnabled: true,
  });
  context.semanticEmbeddingProvider = createReflexSemanticEmbeddingProvider();

  await runAgentMission({
    prompt: "Surface ritual kingship implications.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("semantic_search_notes"));
  assert.ok(toolNames.includes("search_markdown_files"));
  assert.equal(configs.at(-1)?.reflexLabel, "semantic_vault_search");
});

test("agentic reflex cannot expose semantic tools for explicit mutation prompts", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Replacement\n\nRitual kingship summary.",
        }),
    ],
  });
  const { context } = createRunnerVaultContext({
    prompt: "Replace the current note with a ritual kingship summary.",
  });
  context.settings = createRunnerSettings({
    agenticReflexEnabled: true,
  });
  context.semanticEmbeddingProvider = createReflexSemanticEmbeddingProvider();

  await runAgentMission({
    prompt: "Replace the current note with a ritual kingship summary.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: context,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("semantic_search_notes"));
  assert.ok(!toolNames.includes("inspect_semantic_index"));
});

test("saving a vault-context answer enables agent-selected current-note writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "## What I know\n- You like local AI tools.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Save what you know about me into the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_file"],
  );
  assert.deepEqual(receipts, ["append Current.md"]);
});

test("path update prompts enable path write tools and require completion", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_file", {
          path: "People/Profile.md",
          text: "## Learned\n- Prefers traceable AI actions.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Update the note in People/Profile.md with what you learned.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["append_file"]);
  assert.deepEqual(receipts, ["append People/Profile.md"]);
});

test("delete path prompts expose delete_path and emit a trash receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("delete_path", { path: "Projects/Old.md" }),
    ],
  });

  await runAgentMission({
    prompt: "Delete Projects/Old.md.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("delete_path"));
  assert.ok(!toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("replace_file"));
  assert.deepEqual(executedCalls.map((call) => call.name), ["delete_path"]);
  assert.deepEqual(receipts, ["trash Projects/Old.md; affected: 1"]);
});

test("runner emits structured trace events for intent, tools, receipts, metrics, and final state", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const traceKinds: string[] = [];
  const traceMessages: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Trace me" }),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onTrace: (event) => {
        traceKinds.push(event.kind);
        traceMessages.push(event.message);
      },
    },
  });

  for (const kind of [
    "mission_intent",
    "allowed_tools",
    "model_call",
    "tool_start",
    "tool_result",
    "receipt",
    "metric",
    "acceptance",
    "final",
  ]) {
    assert.ok(traceKinds.includes(kind), kind);
  }
  assert.ok(traceMessages.some((message) => /Mission mode:/.test(message)));
});

test("run config reports current-note context separately from vault questions", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Context" }),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].missionMode, "explicit_file_mutation");
  assert.equal(configs[0].contextScope, "none");
  assert.equal(configs[0].currentNoteContext, false);
  assert.equal(configs[0].vaultContext, false);
});

test("run config reports vault and mixed context scopes", async () => {
  const vaultConfigs: AgentRunConfigEvent[] = [];
  const mixedConfigs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithContent("Vault answer"),
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithContent("Mixed answer"),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about me?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => vaultConfigs.push(event),
    },
  });

  await runAgentMission({
    prompt: "Look through my vault and summarize this current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => mixedConfigs.push(event),
    },
  });

  const vaultConfig = vaultConfigs.at(-1);
  const mixedConfig = mixedConfigs.at(-1);
  assert.equal(vaultConfig?.missionMode, "vault_context_answer");
  assert.equal(vaultConfig?.contextScope, "vault");
  assert.equal(vaultConfig?.currentNoteContext, false);
  assert.equal(vaultConfig?.vaultContext, true);
  assert.equal(mixedConfig?.missionMode, "vault_context_answer");
  assert.equal(mixedConfig?.contextScope, "vault_and_current_note");
  assert.equal(mixedConfig?.currentNoteContext, true);
  assert.equal(mixedConfig?.vaultContext, true);
});

test("run config reports browse-only vault routes as vault context", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_current_folder", {}),
      () => responseWithContent("Vault placement answer"),
    ],
  });

  await runAgentMission({
    prompt: "Browse the vault folders and suggest where this note belongs.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].missionMode, "vault_context_answer");
  assert.equal(configs[0].contextScope, "vault_and_current_note");
  assert.equal(configs[0].vaultContext, true);
  assert.equal(configs[0].currentNoteContext, true);
  assert.equal(configs[0].route, "grounded_workflow");
  assert.equal(configs[0].slowPathReason, "needs_vault_context");
});

test("run config reports structured dependency blockers", async () => {
  const configs: AgentRunConfigEvent[] = [];
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Four.")],
  });

  await runAgentMission({
    prompt: "What is 2+2?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      app: {} as never,
      settings: createRunnerSettings({
        modelProvider: "openai_compatible",
        openAiCompatibleApiKey: "",
        requestTimeoutMs: 1000,
      }),
      originalPrompt: "What is 2+2?",
      httpTransport: async () => ({
        status: 500,
        headers: {},
        json: {},
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const dependencyStatus = configs.at(-1)?.dependencyStatus ?? [];
  const providerAuth = dependencyStatus.find(
    (item) => item.category === "provider_auth",
  );
  const modelTimeout = dependencyStatus.find(
    (item) => item.category === "model_timeout",
  );
  const vaultApi = dependencyStatus.find(
    (item) => item.category === "obsidian_vault",
  );
  assert.equal(providerAuth?.status, "blocked");
  assert.match(providerAuth?.nextAction ?? "", /API key/i);
  assert.equal(modelTimeout?.status, "degraded");
  assert.equal(vaultApi?.status, "blocked");
});

test("web append prompts expose web and current-note write tools without path CRUD", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () => responseWithToolCall("append_to_current_file", { text: "Summary" }),
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(!toolNames.includes("read_current_file"));
  assert.ok(toolNames.includes("web_search"));
  assert.ok(toolNames.includes("web_fetch"));
  assert.ok(toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("list_folder"));
  assert.ok(!toolNames.includes("get_path_info"));
  assert.ok(!toolNames.includes("create_file"));
  assert.ok(!toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("replace_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch", "append_to_current_file"],
  );
});

test("mixed current-note rename and web research keeps grounded web tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Research remains incomplete."),
    ],
  });

  await runAgentMission({
    prompt:
      'Rename the current note to "Durable Target", then research with deep web sources.',
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 1 }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunConfig: (event) => configs.push(event),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.equal(configs[0]?.route, "grounded_workflow");
  assert.ok(toolNames.includes("rename_current_file"));
  assert.ok(toolNames.includes("web_search"));
  assert.ok(toolNames.includes("web_fetch"));
});

test("premature current-note append is rejected until required web fetch completes", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with citations to this note.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const traces: AgentTraceEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "MCP servers",
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const allowedAppend =
    "MCP servers expose tools and resources through a standard protocol. Source: https://example.com/mcp";
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "PREMATURE APPEND MUST NEVER REACH THE NOTE",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: allowedAppend,
        }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onTrace: (event) => traces.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch", "append_to_current_file"],
  );
  assert.equal(
    executedCalls.filter((call) => call.name === "append_to_current_file")
      .length,
    1,
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal(receipts[0].path, "Current.md");
  assert.equal(
    vault.content.get("Current.md"),
    `Initial note\n${allowedAppend}`,
  );
  assert.doesNotMatch(
    vault.content.get("Current.md") ?? "",
    /PREMATURE APPEND/,
  );

  const rejected = traces.find(
    (event) =>
      event.kind === "tool_rejected" &&
      event.toolName === "append_to_current_file" &&
      event.error?.code === "plan_dependency_violation",
  );
  assert.ok(rejected, "the premature append must produce an observable dependency rejection");
  assert.match(rejected.message, /task-research-web must complete first/);

  const ledgerMarkdown = [...vault.content.entries()]
    .filter(([path]) => /^Agent Runs\/.+\.md$/u.test(path))
    .map(([, content]) => content)
    .find((content) => /## Mission Ledger/u.test(content));
  assert.ok(ledgerMarkdown, "the run must persist its mission plan");
  const ledgerJson = /## Mission Ledger\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
    ledgerMarkdown,
  )?.[1];
  assert.ok(ledgerJson, "the persisted mission ledger JSON must be readable");
  const ledger = JSON.parse(ledgerJson) as {
    missionPlan?: {
      tasks?: Array<{ id?: string; receiptIds?: string[] }>;
    };
  };
  const taskAct = ledger.missionPlan?.tasks?.find(
    (task) => task.id === "task-act",
  );
  assert.ok(taskAct);
  assert.equal(taskAct.receiptIds?.length, 2);
  assert.ok(taskAct.receiptIds?.some((id) => id.startsWith("receipt:")));
});

test("sourced streaming writeback keeps the write tool visible but stages its payload", async () => {
  const prompt =
    "Research MCP servers and append a concise cited summary with source URLs to this note.";
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "Current note",
  });

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "MCP server cited summary. Source: https://example.com/mcp",
        }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  const writeStepToolNames =
    chatRequests[2].tools?.map((tool) => tool.function.name) ?? [];

  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.ok(firstStepToolNames.includes("append_to_current_file"));
  assert.ok(writeStepToolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(
    statuses.some((message) =>
      /Held append_to_current_file before mutation.*requires final passage verification/i.test(
        message,
      ),
    ),
  );
  assert.ok(
    !statuses.some((message) =>
      /Rejected unavailable tool: (web_search|append_to_current_file|replace_current_file)/.test(
        message,
      ),
    ),
  );
  assert.equal(vault.content.get("Current.md"), "Current note");
});

test("broad vault mutation without a target removes write tools and records no write receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const receipts: AgentRunReceipt[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Update my whole vault with this project summary.",
    content: "Do not overwrite this note.",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Which file or folder should I update?"),
    ],
  });

  await runAgentMission({
    prompt: "Update my whole vault with this project summary.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onRunConfig: (event) => configs.push(event),
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.equal(configs[0].writeAutonomy, false);
  assert.equal(configs[0].autonomyScope.read.vault, true);
  assert.equal(configs[0].autonomyScope.write.currentNote, false);
  assert.ok(toolNames.includes("list_markdown_files"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("append_file"));
  assert.ok(!toolNames.includes("replace_file"));
  assert.deepEqual(receipts, []);
  assert.equal(vault.content.get("Current.md"), "Do not overwrite this note.");
});

test("runner records tool evidence and receipts into the durable mission ledger", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Search the web for MCP sources and cite one source.",
    content: "Initial note",
  });
  vault.context.settings.researchMemoryEnabled = false;
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () => responseWithContent("Draft answer with https://example.com/mcp"),
      (request) =>
        responseWithContent(
          `Cited answer with https://example.com/mcp ${getPassageCitationIds(request)[0] ?? ""}`.trim(),
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP sources and cite one source.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const ledgerEntry = [...vault.content.entries()].find(([path]) =>
    /^Agent Runs\/.+\.md$/.test(path),
  );
  assert.ok(ledgerEntry);
  assert.match(ledgerEntry[1], /"kind": "web_source"/);
  assert.match(ledgerEntry[1], /https:\/\/example\.com\/mcp/);
  assert.deepEqual(receipts, []);

  const appendVault = createRunnerVaultContext({
    prompt: "Append the result to the current note.",
    content: "Initial note",
  });
  const appendClient = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "Ledger receipt" }),
    ],
  });
  const appendReceipts: AgentRunReceipt[] = [];

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: appendClient,
    toolRegistry: createCollectingRegistry([]),
    toolContext: appendVault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => appendReceipts.push(receipt),
    },
  });

  const appendLedgerEntry = [...appendVault.content.entries()].find(([path]) =>
    /^Agent Runs\/.+\.md$/.test(path),
  );
  assert.equal(appendReceipts.length, 1);
  assert.ok(appendLedgerEntry);
  assert.match(appendLedgerEntry[1], /"kind": "receipt"/);
  assert.match(appendLedgerEntry[1], /"receipts": \[/);
});

test("tool-planning preambles stay out of streamed final output", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const planningDeltas: string[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const toolStarts: string[] = [];
  const toolDone: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall(
          "web_search",
          { query: "MCP servers" },
          "Hidden tool preamble",
        ),
      () =>
        responseWithToolCall(
          "web_fetch",
          { url: "https://example.com/source" },
          "Hidden fetch preamble",
        ),
      () =>
        responseWithContent(
          "Ready to answer. Source: https://example.com/source",
        ),
    ],
    streamResponders: [
      () => responseWithContent("Final cited answer"),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onPlanningDelta: (delta) => planningDeltas.push(delta),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onToolStart: (event) => toolStarts.push(event.name),
      onToolDone: (event) => toolDone.push(`${event.name}:${event.ok}`),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(planningDeltas.length, 3);
  assert.ok(planningDeltas.every((delta) => delta.includes("route=grounded_workflow")));
  assert.ok(
    planningDeltas.slice(0, 2).every((delta) =>
      delta.includes("tools=web_search, web_fetch"),
    ),
  );
  assert.match(planningDeltas[2], /tools=none/);
  assert.deepEqual(finalDeltas, [
    "Ready to answer. Source: https://example.com/source",
  ]);
  assert.deepEqual(assistantDeltas, [
    "Ready to answer. Source: https://example.com/source",
  ]);
  assert.ok(!assistantDeltas.join("").includes("Hidden tool preamble"));
  assert.ok(!assistantDeltas.join("").includes("Hidden fetch preamble"));
  assert.deepEqual(toolStarts, ["web_search", "web_fetch"]);
  assert.deepEqual(toolDone, ["web_search:true", "web_fetch:true"]);
});

test("streamed final answers strip special tokens split across chunks", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "< | begin",
          "_of_sentence | ><|start_header",
          "_id|>assistant<|end_header",
          "_id|>\n\nMCP servers final answer. Source: https://example.com/source<|end",
          "_of_sentence|>",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(
    finalDeltas.join(""),
    "assistant\n\nMCP servers final answer. Source: https://example.com/source",
  );
  assert.equal(
    assistantDeltas.join(""),
    "assistant\n\nMCP servers final answer. Source: https://example.com/source",
  );
  assert.ok(!finalDeltas.join("").includes("<|"));
  assert.ok(!finalDeltas.join("").includes("< |"));
});

test("tool-result final prose skips redundant streaming synthesis", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Ready to answer. Source: https://example.com/source",
        ),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["Final ", "answer."]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.deepEqual(finalDeltas, [
    "Ready to answer. Source: https://example.com/source",
  ]);
});

test("empty direct model content falls back to streamed final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "The Grapes of Wrath" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes-of-wrath",
        }),
      () => responseWithContent("", "thinking without final prose"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "Grounded Grapes ",
          "of Wrath final answer. Source: https://example.com/grapes-of-wrath",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for The Grapes of Wrath and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests[0].messages.at(-1)?.role, "user");
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /Current user mission: "Search the web for The Grapes of Wrath and summarize what you find\."/,
  );
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /ignore it and produce the requested answer/,
  );
  assert.equal(
    streamRequests[0].messages.some(
      (message) =>
        message.role === "assistant" &&
        !message.content.trim() &&
        !message.toolCalls?.length,
    ),
    false,
  );
  assert.deepEqual(finalDeltas, [
    "Grounded Grapes of Wrath final answer. Source: https://example.com/grapes-of-wrath",
  ]);
  assert.deepEqual(assistantDeltas, [
    "Grounded Grapes of Wrath final answer. Source: https://example.com/grapes-of-wrath",
  ]);
});

test("off-topic streamed final answer is stopped before display", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "The Grapes of Wrath" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes-of-wrath",
        }),
      () => responseWithContent("", "thinking without final prose"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Compound Interest Worksheet\n\n",
          "A quarterly compounding schedule starts with a principal balance, applies a fixed annual rate, ",
          "adds each period's accrued amount to the balance, and repeats the arithmetic for the next quarter. ",
          "The method is useful for amortization tables, savings projections, and classroom finance examples. ",
          "It does not require narrative interpretation, historical context, literary analysis, or outside evidence.",
        ]),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt: "Search the web for The Grapes of Wrath and summarize what you find.",
        modelClient: client,
        toolRegistry: createRegistry([]),
        toolContext: {} as ToolExecutionContext,
        enableStreaming: true,
        events: {
          onFinalDelta: (delta) => finalDeltas.push(delta),
          onAssistantDelta: (delta) => assistantDeltas.push(delta),
          onStatus: (message) => statuses.push(message),
        },
      }),
    /drifted off topic/,
  );

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(finalDeltas, []);
  assert.deepEqual(assistantDeltas, []);
  assert.ok(
    statuses.includes(
      "Stopped model output because it drifted off topic from the current mission.",
    ),
  );
});

test("empty tool-result final content falls back to streamed synthesis", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "MCP servers ",
          "fallback answer. Source: https://example.com/source",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.deepEqual(finalDeltas, [
    "MCP servers fallback answer. Source: https://example.com/source",
  ]);
});

test("metrics are emitted for model, tool, stream fallback, and run timing", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContent(
          "MCP servers fallback answer. Source: https://example.com/source",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(metrics.filter((event) => event.kind === "model_chat").length, 3);
  assert.equal(metrics.some((event) => event.kind === "tool" && event.name === "web_search"), true);
  assert.equal(metrics.some((event) => event.kind === "tool" && event.name === "web_fetch"), true);
  assert.equal(metrics.some((event) => event.kind === "model_stream"), true);
  assert.equal(metrics.some((event) => event.kind === "run"), true);

  for (const metric of metrics) {
    assert.ok(metric.durationMs >= 0);
  }

  const firstModelMetric = metrics.find((event) => event.kind === "model_chat");
  assert.ok((firstModelMetric?.requestChars ?? 0) > 0);
  assert.ok((firstModelMetric?.responseChars ?? 0) > 0);
});

test("model requests include configured options and metrics include token counts", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithContent("Coral fact", undefined, {
          message: { role: "assistant", content: "Coral fact" },
          prompt_eval_count: 12,
          eval_count: 4,
        }),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about coral reefs?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({
        temperature: 0.2,
        topK: 40,
        topP: 0.8,
        numCtx: 4096,
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.deepEqual(chatRequests[0].options, {
    temperature: 0.2,
    top_k: 40,
    top_p: 0.8,
    num_ctx: 4096,
  });
  const modelMetric = metrics.find((event) => event.kind === "model_chat");
  assert.equal(modelMetric?.promptTokens, 12);
  assert.equal(modelMetric?.completionTokens, 4);
  assert.equal(modelMetric?.totalTokens, 16);
});

test("stream metrics include token counts from the final raw chunk", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas(["Streamed fact"], "Streamed fact", [], {
          raw: [{}, { prompt_eval_count: 8, eval_count: 3 }],
        }),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about coral reefs?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ outputProfile: "chat_first" }),
    } as ToolExecutionContext,
    enableStreaming: true,
    forceChatOnly: true,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  const streamMetric = metrics.find((event) => event.kind === "model_stream");
  assert.equal(streamMetric?.promptTokens, 8);
  assert.equal(streamMetric?.completionTokens, 3);
  assert.equal(streamMetric?.totalTokens, 11);
});

test("unavailable tool calls are rejected before execution", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "percentage change" }),
      () => responseWithContent("Final direct answer"),
    ],
  });

  await runAgentMission({
    prompt: "What is the percentage change from 10 to 12?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.ok(statuses.includes("Rejected unavailable tool: web_search"));
  assert.deepEqual(deltas, ["Final direct answer"]);
});

test("duplicate read-only tool calls hit the run-local cache", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("search_markdown_files", { query: "local AI" }),
      () => responseWithToolCall("search_markdown_files", { query: "local AI" }),
      () => responseWithContent("Found local AI notes."),
    ],
  });

  await runAgentMission({
    prompt: "Search my notes for local AI tools.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["search_markdown_files"],
  );
  assert.ok(
    metrics.some(
      (event) =>
        event.kind === "tool" &&
        event.name === "search_markdown_files" &&
        event.cached === true,
    ),
  );
});

test("duplicate semantic search tool calls hit the run-local cache", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "local AI concepts",
        }),
      () =>
        responseWithToolCall("semantic_search_notes", {
          query: "local AI concepts",
        }),
      () => responseWithContent("Found local AI notes."),
    ],
  });

  await runAgentMission({
    prompt: "What do my notes say about local AI concepts?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["semantic_search_notes"],
  );
  assert.ok(
    metrics.some(
      (event) =>
        event.kind === "tool" &&
        event.name === "semantic_search_notes" &&
        event.cached === true,
    ),
  );
});

test("append prompts require a write tool and do not implicitly append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I will append this in chat only."),
      () => responseWithToolCall("append_to_current_file", { text: "## Result" }),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: append_to_current_file/,
  );
  assert.deepEqual(deltas, ["Done. append Current.md."]);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.ok(statuses.includes("Write required; asking model to use a write tool..."));
  assert.ok(statuses.includes("Appended result to Current.md."));
  assert.ok(statuses.includes("Write complete."));
});

test("successful write tools stop the loop without an extra final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("append_to_current_file", { text: "## Result" }),
      () => responseWithContent("should not run"),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(deltas, ["Done. append Current.md."]);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.ok(statuses.includes("Appending to note..."));
  assert.ok(statuses.includes("Appended result to Current.md."));
});

test("write missions emit receipts and a local final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const receipts: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "## Result",
        }),
    ],
    streamResponders: [
      () => responseWithContent("Appended the result to the current note."),
    ],
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt.message),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["append_to_current_file"],
  );
  assert.deepEqual(finalDeltas, ["Done. append Current.md."]);
  assert.deepEqual(receipts, ["append Current.md"]);
});

test("replace prompts expose replace but not append unless append intent exists", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("replace_current_file", { text: "# Brief" }),
    ],
  });

  await runAgentMission({
    prompt: "Replace this note with a clean project brief.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "replace_current_file"],
  );
});

test("whole-note replace wins over broad content edit wording", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("list_markdown_files", {}),
      () => responseWithToolCall("replace_current_file", { text: "# Brief" }),
    ],
  });

  await runAgentMission({
    prompt:
      "Look at the markdown file names in this vault, then replace the current file content with a clean project brief.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("list_markdown_files"));
  assert.ok(firstStepToolNames.includes("replace_current_file"));
  assert.ok(!firstStepToolNames.includes("edit_current_section"));
  assert.ok(
    chatRequests[0].messages.some((message) => /Tools:/.test(message.content)),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "list_markdown_files", "replace_current_file"],
  );
  assert.ok(!statuses.includes("Rejected unavailable tool: replace_current_file"));
  assert.ok(statuses.includes("Replaced Current.md; backup saved to .agent-backups/1-Current.md."));
});

test("visible title prompts expose rename_current_file and suppress accidental append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Native Obsidian Agentic Research",
        }),
    ],
  });

  await runAgentMission({
    prompt:
      "Rename the current note to Native Obsidian Agentic Research, then confirm the visible title.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("rename_current_file"));
  assert.ok(!toolNames.includes("move_path"));
  assert.ok(!toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "rename_current_file"],
  );
  assert.ok(statuses.includes("Renaming current note file..."));
  assert.ok(statuses.includes("Renamed current note from Current.md to Renamed.md."));
});

test("compound long research continues after its current-note rename receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Durable Research Target",
        }),
      () =>
        responseWithToolCall("get_note_graph_context", {
          path: "Research Context 1.md",
        }),
      () =>
        responseWithToolCall("get_note_graph_context", {
          path: "Research Context 2.md",
        }),
      ...Array.from({ length: 4 }, () => () =>
        responseWithContent(
          "Research remains incomplete; continue gathering evidence.",
        ),
      ),
    ],
  });

  await runAgentMission({
    prompt:
      "Perform long-running research. Rename the current note to Durable Research Target, then inspect the current note graph until the segment budget requires continuation.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ maxAgentSteps: 7 }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const executedNames = executedCalls.map((call) => call.name);
  assert.deepEqual(executedNames.slice(0, 3), [
    "read_current_file",
    "rename_current_file",
    "get_note_graph_context",
  ]);
  assert.ok(chatRequests.length > 1);
});

test("current-note rename before long research does not require generic move_path", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Long Research Target",
        }),
    ],
  });

  await runAgentMission({
    prompt:
      'Perform long-running research for E2E_AUTO_SEGMENT_CONTINUATION. Rename the current note to "Long Research Target", then inspect the current note graph and keep reading graph context until the segment budget requires durable continuation.',
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("rename_current_file"));
  assert.ok(!toolNames.includes("move_path"));
});

test("titled generated writing uses append without requiring rename tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Create a 50 word piece of text with the title Purple Horizon on this page.",
    path: "Untitled.md",
    content: "",
    streamWritebackMode: "off",
  });

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "# Purple Horizon\n\nPurple Horizon body text.",
        }),
      () => responseWithContent("Done."),
    ],
  });

  await runAgentMission({
    prompt: "Create a 50 word piece of text with the title Purple Horizon on this page.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  const firstToolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("append_to_current_file"));
  assert.ok(!firstToolNames.includes("rename_current_file"));
  assert.ok(!firstToolNames.includes("retitle_current_file"));
  assert.ok(
    executedCalls.some((call) => call.name === "append_to_current_file"),
  );
  assert.ok(
    !executedCalls.some((call) => call.name === "rename_current_file"),
  );
});

test("explicit rename prompts still expose rename_current_file", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt: "Rename the current note to Purple Horizon.",
    path: "Untitled.md",
    content: "",
    streamWritebackMode: "off",
  });

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "Purple Horizon",
        }),
      () => responseWithContent("Renamed."),
    ],
  });

  await runAgentMission({
    prompt: "Rename the current note to Purple Horizon.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  const firstToolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstToolNames.includes("rename_current_file"));
  assert.ok(!firstToolNames.includes("retitle_current_file"));
});

test("explicit H1 title prompts keep retitle_current_file", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("retitle_current_file", {
          title: "Native Obsidian Agentic Research",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Change the H1 heading title in this note around native Obsidian agentic research.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("rename_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "retitle_current_file"],
  );
});

test("highlight prompts expose highlight_current_file_phrase without replacement tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("highlight_current_file_phrase", {
          phrase: "silver lantern",
        }),
      () => responseWithContent("Highlighted silver lantern."),
    ],
  });

  await runAgentMission({
    prompt: "Find and highlight silver lantern in the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("highlight_current_file_phrase"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["highlight_current_file_phrase"],
  );
});

test("restore prompts expose restore_current_file_from_backup without append or replace tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("restore_current_file_from_backup", {}),
      () => responseWithContent("Restored from backup."),
    ],
  });

  await runAgentMission({
    prompt: "Undo the last agent edit in the current note from backup.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("restore_current_file_from_backup"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["restore_current_file_from_backup"],
  );
});

test("edit prompts expose section edit and suppress other mutation tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("I edited it in chat only."),
      () =>
        responseWithToolCall("edit_current_section", {
          heading: "Goals",
          level: 2,
          content: "New goals.",
        }),
    ],
  });

  await runAgentMission({
    prompt: "Edit the Goals section in this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("edit_current_section"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.ok(!toolNames.includes("delete_current_file"));
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Request one of these allowed write tools now: edit_current_section/,
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "edit_current_section"],
  );
  assert.ok(statuses.includes("Editing current note section with backup..."));
  assert.ok(
    statuses.includes(
      "Edited section in Current.md; backup saved to .agent-backups/1-Current.md.",
    ),
  );
});

test("delete prompts expose delete and suppress other mutation tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithToolCall("delete_current_file", {})],
  });

  await runAgentMission({
    prompt: "Delete the current note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("delete_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("edit_current_section"));
  assert.ok(!toolNames.includes("replace_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "delete_current_file"],
  );
  assert.ok(statuses.includes("Deleting current note with backup..."));
  assert.ok(
    statuses.includes(
      "Deleted Current.md; backup saved to .agent-backups/1-Current.md.",
    ),
  );
});

test("budget stop uses adaptive web budget and does not synthesize", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const toolStarts: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const chatResponders: ChatResponder[] = Array.from(
    { length: MAX_AGENT_STEPS },
    (_, index) => () =>
      responseWithToolCall("web_search", { query: `q${index + 1}` }),
  );

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders,
  });

  await runAgentMission({
    prompt: "Search the web forever.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
      onToolStart: (event) => toolStarts.push(event.name),
    },
  });

  assert.ok(chatRequests.length < MAX_AGENT_STEPS);
  assert.equal(chatRequests.length, 5);
  assert.equal(streamRequests.length, 0);
  assert.equal(
    executedCalls.filter((call) => call.name === "web_search").length,
    5,
  );
  assert.equal(toolStarts.length, 5);
  assert.ok(statuses.includes("Stopped at safety limit. Review partial results."));
  assert.deepEqual(deltas, []);
});

test("configured max agent steps caps grounded research loops", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const configuredMax = 3;
  const chatResponders: ChatResponder[] = Array.from(
    { length: MAX_AGENT_STEPS },
    (_, index) => () =>
      responseWithToolCall("web_search", { query: `deep-${index + 1}` }),
  );

  const client = createClient({
    chatRequests,
    chatResponders,
  });

  await runAgentMission({
    prompt: "Do deep research on Obsidian plugins.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({
        model: "gpt-oss:120b",
        maxAgentSteps: configuredMax,
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].route, "grounded_workflow");
  assert.equal(configs[0].maxSteps, configuredMax);
  assert.equal(configs[0].maxStepsForRun, configuredMax);
  assert.equal(configs[0].resolvedThink, "medium");
  assert.equal(chatRequests.length, configuredMax);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(
    executedCalls.filter((call) => call.name === "web_search").length,
    2,
  );
  assert.ok(statuses.includes("Stopped at safety limit. Review partial results."));
});

test("explicit model-step prompts set the visible run step cap", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const targetSteps = 10;
  const prompt = `Inspect the current note graph for E2E_LOOP_STEPS_${targetSteps} and complete exactly ${targetSteps} model steps before the final answer.`;
  const client = createClient({
    chatRequests,
    chatResponders: [
      ...Array.from({ length: targetSteps - 1 }, (_, index) => () =>
        responseWithToolCall("get_note_graph_context", {
          path: `Loop Context ${index + 1}.md`,
        }),
      ),
      () => responseWithContent(`E2E_LOOP_DONE_${targetSteps}`),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({
        maxAgentSteps: 30,
      }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].route, "grounded_workflow");
  assert.equal(configs[0].maxSteps, 30);
  assert.equal(configs[0].maxStepsForRun, targetSteps);
  assert.ok(statuses.includes(`Agent step 1 of max ${targetSteps}...`));
  assert.ok(statuses.includes(`Agent step ${targetSteps} of max ${targetSteps}...`));
  assert.equal(chatRequests.length, targetSteps);
  assert.equal(
    executedCalls.filter((call) => call.name === "get_note_graph_context").length,
    6,
  );
});

test("aborted runs stop before the next model loop step", async () => {
  const controller = new AbortController();
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const completions: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "first query" }),
      () => {
        throw new Error("stop should prevent a second model call");
      },
    ],
  });

  await runAgentMission({
    prompt: "Search the web and keep investigating.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    abortSignal: controller.signal,
    events: {
      onStatus: (message) => statuses.push(message),
      onToolDone: () => controller.abort(),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search"],
  );
  assert.deepEqual(completions, ["user_stopped"]);
  assert.ok(statuses.includes("Stopped by user."));
});

test("write-required chat-only answers stop at route budget without emitting content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const chatResponders: ChatResponder[] = Array.from(
    { length: 3 },
    () => () => responseWithContent("chat-only answer"),
  );

  const client = createClient({
    chatRequests,
    chatResponders,
  });

  await runAgentMission({
    prompt: "Append the result to the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.ok(statuses.includes("Stopped at safety limit. Review partial results."));
  assert.deepEqual(deltas, []);
});

test("web research can search then fetch a source before answering", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      (request) =>
        responseWithContent(
          `Cited answer with https://example.com/mcp ${getPassageCitationIds(request)[0] ?? ""}`.trim(),
        ),
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and give me cited sources.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(deltas.length, 1);
  assert.match(deltas[0], /Cited answer with https:\/\/example\.com\/mcp/);
  assert.match(deltas[0], /source:[a-z0-9]+:passage:\d+-\d+/i);
});

test("low-cap sourced generated essay finalizes with note writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const finalDeltas: string[] = [];
  const grapesEvidenceText =
    'The Grapes of Wrath source says Steinbeck frames "solidarity through the Joad family" as quoted textual pressure.';
  const vault = createRunnerVaultContext({
    prompt:
      "Write me a 1000 word essay on Grapes of Wrath. Use text level quotation and citations.",
    content: "Essay prompt",
  });
  vault.context.settings = createRunnerSettings({
    maxAgentSteps: 5,
    streamWritebackMode: "all_current_note_content_writes",
  });
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Grapes source",
              url: "https://example.com/grapes",
              snippet: "Steinbeck quotation context.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Grapes source",
          url: "https://example.com/grapes",
          content: grapesEvidenceText,
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };
  const essayDraft = grapesEvidenceText;
  let verifiedEssayDraft = "";

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Grapes of Wrath quotations citations",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/grapes",
        }),
      () => responseWithContent("Ready to write the sourced essay."),
    ],
    streamResponders: [
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        const citedSentence =
          `${essayDraft} Source: https://example.com/grapes Evidence: ${passageId ?? ""}`.trim();
        verifiedEssayDraft = Array.from({ length: 40 }, () => citedSentence).join(
          " ",
        );
        return responseWithContentDeltas([verifiedEssayDraft]);
      },
    ],
  });

  await runAgentMission({
    prompt:
      "Write me a 1000 word essay on Grapes of Wrath. Use text level quotation and citations.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    statuses.some((message) =>
      /Tool context is sufficient; drafting final output/.test(message),
    ),
  );
  assert.ok(!statuses.includes("Stopped at safety limit. Review partial results."));
  assert.deepEqual(finalDeltas, [verifiedEssayDraft]);
  assert.equal(
    vault.content.get("Current.md"),
    `Essay prompt\n${verifiedEssayDraft}`,
  );
});

test("explicit stream-to-page essay uses live writeback instead of append tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const prompt =
    "Write me a 1000 word essay on grapes of wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const essayBody = [
    "# The Harvest of Injustice: Grapes of Wrath",
    "",
    "The Grapes of Wrath argues that dignity survives displacement.",
    ...Array.from({ length: 910 }, (_, index) => `solidarity${index}`),
  ].join(" ");
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# The Harvest of Injustice: Grapes of Wrath\n\n",
          essayBody.replace(/^# The Harvest of Injustice: Grapes of Wrath\s*/, ""),
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(executedCalls, []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal((receipts[0].output as { streamed?: boolean }).streamed, true);
  const note = vault.content.get("Current.md") ?? "";
  assert.match(note, /^# The Harvest of Injustice: Grapes of Wrath/m);
  assert.doesNotMatch(note, /^# Untitled/m);
  assert.equal(
    (note.match(/^# The Harvest of Injustice: Grapes of Wrath/gm) ?? []).length,
    1,
  );
  assert.equal(
    completions.at(-1)?.stopReason,
    "write_completed",
    statuses.join("\n"),
  );
  assert.ok(!statuses.includes("Stopped at safety limit. Review partial results."));
  assert.ok(!statuses.some((message) => /Completion held for verification/.test(message)));
});

test("streaming writeback prompt includes Grok title output contract", () => {
  const prompt = buildStreamingWritebackPromptForTests("append", {
    missionPrompt: "Write Hello World in TypeScript on this page.",
    activeBasename: "Untitled 1",
  });
  assert.match(prompt, /OUTPUT CONTRACT/);
  assert.match(prompt, /PLUGIN BEHAVIOR/);
  assert.match(prompt, /ACTIVE NOTE: Untitled 1/);
  assert.match(prompt, /# Hello World in TypeScript/);
  assert.match(prompt, /Do not call rename_current_file/);
  assert.match(prompt, /plugin renames the file from your leading H1/);

  const retryPrompt = buildStreamingWritebackPromptForTests("append", {
    retry: true,
    activeBasename: "Untitled",
  });
  assert.match(retryPrompt, /First character must be #/);

  const namedPrompt = buildStreamingWritebackPromptForTests("append", {
    activeBasename: "Existing Note",
  });
  assert.match(namedPrompt, /Do not rename the file; the note already has a real title/);
});

test("streamed append onto Untitled 1 auto-renames visible title from leading H1", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const prompt =
    "Write Hello World in TypeScript on this page and stream it to the note.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Untitled 1.md",
    content: "",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Hello World in TypeScript\n\n",
          '```ts\nconsole.log("Hello, world!");\n```\n',
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry([]),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 1);
  assert.match(
    streamRequests[0].messages.at(-1)?.content ?? "",
    /OUTPUT CONTRACT/,
  );
  assert.ok(
    receipts.some((receipt) => receipt.toolName === "append_to_current_file"),
  );
  const renameReceipt = receipts.find(
    (receipt) => receipt.toolName === "rename_current_file",
  );
  assert.ok(renameReceipt, statuses.join("\n"));
  assert.equal(renameReceipt?.path, "Untitled 1.md");
  assert.equal(renameReceipt?.toPath, "Hello World in TypeScript.md");
  assert.equal(vault.content.has("Untitled 1.md"), false);
  assert.match(
    vault.content.get("Hello World in TypeScript.md") ?? "",
    /Hello, world!/,
  );
  assert.ok(
    statuses.some((message) =>
      /Renamed placeholder note to Hello World in TypeScript/i.test(message),
    ),
  );
});

test("streamed append onto named notes does not auto-rename", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt = "Write a short note about grapes and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Research.md",
    content: "# Research\n\n",
  });
  const client = createClient({
    chatRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Grapes Notes\n\n",
          "Grapes grow on vines.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.ok(
    receipts.some((receipt) => receipt.toolName === "append_to_current_file"),
  );
  assert.ok(
    !receipts.some((receipt) => receipt.toolName === "rename_current_file"),
  );
  assert.ok(vault.content.has("Research.md"));
  assert.equal(vault.content.has("Grapes Notes.md"), false);
});

test("tool-path append onto Untitled auto-renames without model rename call", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const prompt = "Append a titled hello world note to this page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Untitled.md",
    content: "",
    streamWritebackMode: "off",
  });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("append_to_current_file", {
          text: "# Hello World in TypeScript\n\nconsole.log('hi');\n",
        }),
      () => responseWithContent("Appended the titled note."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.ok(
    executedCalls.some((call) => call.name === "append_to_current_file"),
    statuses.join("\n"),
  );
  assert.ok(
    !executedCalls.some((call) => call.name === "rename_current_file"),
  );
  const renameReceipt = receipts.find(
    (receipt) => receipt.toolName === "rename_current_file",
  );
  assert.ok(renameReceipt, `receipts=${JSON.stringify(receipts)}\n${statuses.join("\n")}`);
  assert.equal(renameReceipt?.toPath, "Hello World in TypeScript.md");
  assert.equal(vault.content.has("Untitled.md"), false);
  assert.ok(vault.content.has("Hello World in TypeScript.md"));
});

test("placeholder auto-rename uses numeric suffix on collision", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  const prompt = "Write Hello World in TypeScript on this page.";
  const vault = createRunnerVaultContext({
    prompt,
    path: "Untitled.md",
    content: "",
  });
  vault.content.set("Hello World in TypeScript.md", "existing\n");
  const client = createClient({
    chatRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Hello World in TypeScript\n\n",
          "body text",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const renameReceipt = receipts.find(
    (receipt) => receipt.toolName === "rename_current_file",
  );
  assert.equal(renameReceipt?.toPath, "Hello World in TypeScript 2.md");
  assert.ok(vault.content.has("Hello World in TypeScript 2.md"));
  assert.ok(vault.content.has("Hello World in TypeScript.md"));
});

test("streamed writeback does not reuse an older generated word target", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const prompt =
    "Write me a short essay on Grapes of Wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Harvest of Injustice\n\n",
          "The Grapes of Wrath follows the Joad family through migration, hunger, and labor exploitation.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    conversationHistory: [
      {
        role: "user",
        content: "Generate me a 1000 word essay on Grapes of Wrath.",
      },
      {
        role: "assistant",
        content: "Earlier short draft.",
      },
    ],
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    streamRequests[0].messages.some((message) =>
      /Generate me a 1000 word essay on Grapes of Wrath/i.test(message.content),
    ),
    "the regression must include the older numeric request in prompt history",
  );
  assert.ok(!statuses.some((message) => /1000|correction pass/i.test(message)));
  assert.equal(
    vault.content.get("Current.md"),
    "# Harvest of Injustice\n\nThe Grapes of Wrath follows the Joad family through migration, hunger, and labor exploitation.",
  );
});

test("current-note writeback flushes token-sized chunks before completion", async () => {
  const prompt = "In this note, write a short project update.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const chunks = Array.from(
    { length: 14 },
    (_, index) => `Project update ${index}. `,
  );
  const client: ModelClient = {
    chat: async () => {
      throw new Error("chat should not be called for direct writeback");
    },
    streamChat: async (_request, events = {}) => {
      for (const chunk of chunks) {
        events.onContentDelta?.(chunk);
      }
      await Promise.resolve();
      await Promise.resolve();
      assert.match(vault.content.get("Current.md") ?? "", /Project update 0/);
      return responseWithContent(chunks.join(""));
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  assert.equal(vault.content.get("Current.md"), `Initial note\n${chunks.join("")}`);
});

test("generated leading H1 retitles top note title instead of duplicating body title", async () => {
  const prompt = "Write a short essay on Grapes of Wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "   # The Harvest",
          " of Injustice #\n\n",
          "The Grapes of Wrath follows families facing dispossession.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  const note = vault.content.get("Current.md") ?? "";
  assert.equal(
    note,
    "# The Harvest of Injustice\n\nThe Grapes of Wrath follows families facing dispossession.",
  );
  assert.equal((note.match(/^# /gm) ?? []).length, 1);
});

test("generated leading H1 retitles the latest current-note body", async () => {
  const prompt = "Write a short essay on Grapes of Wrath and stream it to the page.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () => {
        vault.content.set(
          "Current.md",
          "# Untitled\n\nPrompt text that arrived after writer setup.\n",
        );
        return responseWithContentDeltas([
          "# The Harvest of Injustice\n\n",
          "The Grapes of Wrath follows families facing dispossession.",
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  assert.equal(
    vault.content.get("Current.md"),
    [
      "# The Harvest of Injustice",
      "",
      "Prompt text that arrived after writer setup.",
      "The Grapes of Wrath follows families facing dispossession.",
    ].join("\n"),
  );
});

test("compound title and essay prompt retitles then streams essay content", async () => {
  const prompt =
    "Write an essay on Grapes of Wrath on this note and change the title as well.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("rename_current_file", {
          title: "The Harvest of Injustice",
        }),
      () => responseWithContent("Ready to write the essay."),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "The Grapes of Wrath presents survival as a collective duty.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "rename_current_file"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("The Harvest of Injustice.md"),
    "# Untitled\n\nThe Grapes of Wrath presents survival as a collective duty.",
  );
});

test("citation writeback falls back to required web tools when model answers early", async () => {
  const prompt =
    "Write me a 300 word argumentative essay on Grapes of Wrath. Use text level quotation and citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({ prompt, content: "Prompt" });
  let fetchedUrl = "";
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Unrelated gardening result",
              url: "https://example.com/gardening",
              snippet: "Tomato planting calendar",
            },
            {
              title: "Grapes source",
              url: "https://example.com/grapes",
              snippet: "Steinbeck source",
            },
          ],
        },
      };
    }

    if (request.url.endsWith("/web_fetch")) {
      fetchedUrl = JSON.parse(
        typeof request.body === "string" ? request.body : "{}",
      )?.url ?? "";
      return {
        status: 200,
        headers: {},
        json: {
          title: "Fetched Grapes source",
          content:
            'The Grapes of Wrath source says "collective survival" names hardship as a public failure.',
          links: [],
        },
      };
    }

    throw new Error(`Unexpected request: ${request.url}`);
  };
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("I can answer without tools."),
      () => responseWithContent("Still answering without tools."),
      () => responseWithContent("Ready to write from sources."),
      (request) =>
        responseWithContent(
          "The Grapes of Wrath uses the Joads to argue for collective survival with cited evidence. " +
            "Steinbeck frames hardship as a public failure, not a private weakness. " +
            "The corrected draft keeps the source-backed claim while expanding the paragraph enough for the bounded correction pass. " +
            (getPassageCitationIds(request)[0] ?? ""),
        ),
    ],
    streamResponders: [
      (request) => {
        const citedSentence =
          `The Grapes of Wrath source says "collective survival" names hardship as a public failure. Source: https://example.com/grapes ${getPassageCitationIds(request)[0] ?? ""}`.trim();
        return responseWithContentDeltas([
          Array.from({ length: 14 }, () => citedSentence).join(" "),
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(fetchedUrl, "https://example.com/grapes");
  assert.equal(streamRequests.length, 1);
  assert.match(vault.content.get("Current.md") ?? "", /collective survival/);
});

test("proof-gated cited writeback stages one correction before one note commit", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with passage citations to this note.";
  const originalNote = "Original note must remain byte-identical while drafts are checked.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const statuses: string[] = [];
  const verificationTraces: Array<{ message: string; outputPreview?: unknown }> = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: originalNote,
  });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "MCP servers",
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const invalidDraft =
    "INVALID UNVERIFIED WRITEBACK: MCP servers expose tools, but this draft has no bound citation.";
  let correctedDraft = "";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () => responseWithContent("Ready to write the cited summary."),
    ],
    streamResponders: [
      () => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        assert.equal(
          vault.operations.filter((item) => item === "modify:Current.md").length,
          0,
        );
        return responseWithContentDeltas([invalidDraft]);
      },
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        assert.equal(
          vault.operations.filter((item) => item === "modify:Current.md").length,
          0,
        );
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId, "the correction must retain the fetched passage id");
        correctedDraft =
          "MCP servers expose tools and resources through a standard protocol. " +
          `Source: https://example.com/mcp Passage evidence: [${passageId}]`;
        return responseWithContentDeltas([correctedDraft]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onStatus: (message) => statuses.push(message),
      onTrace: (event) => {
        if (event.kind === "verification") {
          verificationTraces.push({
            message: event.message ?? "",
            outputPreview: event.outputPreview,
          });
        }
      },
    },
  });

  assert.equal(executedCalls[0]?.name, "web_search");
  assert.ok(executedCalls.slice(1).every((call) => call.name === "web_fetch"));
  assert.ok(executedCalls.filter((call) => call.name === "web_fetch").length >= 1);
  assert.equal(
    streamRequests.length,
    2,
    JSON.stringify({ statuses, note: vault.content.get("Current.md") }),
  );
  assert.ok(
    statuses.some((message) =>
      /Writeback draft held for verification.*Requesting one correction/i.test(
        message,
      ),
    ),
    JSON.stringify(statuses),
  );
  assert.ok(
    verificationTraces.some((trace) =>
      /claim_grounding/i.test(trace.message),
    ),
    JSON.stringify(verificationTraces.map((trace) => trace.message)),
  );
  assert.ok(
    statuses.some((message) => /claim_grounding/i.test(message)) ||
      verificationTraces.some((trace) => {
        const preview =
          trace.outputPreview &&
          typeof trace.outputPreview === "object" &&
          trace.outputPreview !== null
            ? (trace.outputPreview as { missing?: string[] }).missing
            : undefined;
        return Array.isArray(preview)
          ? preview.some((item) => item.includes("claim_grounding"))
          : false;
      }) ||
      statuses.some((message) =>
        /Writeback draft held for verification/i.test(message),
      ),
    "expected claim grounding or citation hold before correction",
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].toolName, "append_to_current_file");
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
  );
  assert.equal(
    vault.content.get("Current.md"),
    `${originalNote}\n${correctedDraft}`,
  );
  assert.doesNotMatch(vault.content.get("Current.md") ?? "", /INVALID UNVERIFIED/);
});

test("proof-sensitive direct write tools are staged before the single verified mutation", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with passage citations to this note.";
  const originalNote = "Original note must not receive an unverified direct tool payload.";
  const directDraft = "DIRECT UNVERIFIED WRITE TOOL PAYLOAD";
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const rejectionCodes: string[] = [];
  const vault = createRunnerVaultContext({ prompt, content: originalNote });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  let correctedDraft = "";
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () =>
        responseWithToolCall("append_to_current_file", {
          text: directDraft,
        }),
      () => responseWithContent("Ready for runner-owned verified writeback."),
    ],
    streamResponders: [
      (request) => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(passageId);
        correctedDraft =
          `MCP servers expose tools and resources through a standard protocol. Source: https://example.com/mcp [${passageId}]`;
        return responseWithContentDeltas([correctedDraft]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onTrace: (event) => {
        if (event.error?.code) {
          rejectionCodes.push(event.error.code);
        }
      },
    },
  });

  assert.deepEqual(executedCalls.map((call) => call.name), [
    "web_search",
    "web_fetch",
  ]);
  assert.ok(rejectionCodes.includes("proof_gated_writeback_required"));
  assert.equal(receipts.length, 1);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    1,
  );
  assert.equal(vault.content.get("Current.md"), `${originalNote}\n${correctedDraft}`);
  assert.doesNotMatch(vault.content.get("Current.md") ?? "", /DIRECT UNVERIFIED/);
});

test("repeated invalid proof-gated writeback leaves the note byte-identical", async () => {
  const prompt =
    "Research MCP servers on the web and append a concise summary with citations to this note.";
  const originalNote = "Original note bytes must survive rejected research drafts.\n";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const assistantDeltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: originalNote,
  });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          query: "MCP servers",
          results: [
            {
              title: "MCP overview",
              snippet: "MCP servers expose tools and resources.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "MCP overview",
          url: "https://example.com/mcp",
          content:
            "MCP servers expose tools and resources through a standard protocol.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const invalidDraft =
    "INVALID UNVERIFIED WRITEBACK: relevant research prose without a bound passage citation.";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/mcp",
        }),
      () => responseWithContent("Ready to write the cited summary."),
    ],
    streamResponders: [
      () => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        return responseWithContentDeltas([invalidDraft]);
      },
      () => {
        assert.equal(vault.content.get("Current.md"), originalNote);
        return responseWithContentDeltas([
          `${invalidDraft} The single correction is still uncited.`,
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.deepEqual(executedCalls.slice(0, 2).map((call) => call.name), [
    "web_search",
    "web_fetch",
  ]);
  assert.ok(
    executedCalls.slice(1).every((call) => call.name === "web_fetch"),
    JSON.stringify(executedCalls.map((call) => call.name)),
  );
  assert.equal(
    streamRequests.length,
    2,
    JSON.stringify({
      assistantDeltas,
      note: vault.content.get("Current.md"),
      operations: vault.operations,
    }),
  );
  assert.deepEqual(receipts, []);
  assert.equal(vault.content.get("Current.md"), originalNote);
  assert.equal(
    vault.operations.filter((item) => item === "modify:Current.md").length,
    0,
  );
  assert.doesNotMatch(assistantDeltas.join(""), /INVALID UNVERIFIED/);
  assert.match(
    assistantDeltas.join(""),
    /Note writeback was not applied because proof verification is incomplete/i,
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "budget");
});

test("current market note writeback falls back to web tools before writing", async () => {
  const prompt = [
    "I want you to write on this note.",
    "",
    "Start by titling it Software project.",
    "",
    "I want you to find and organize information about the current online dating market and also the social media market.",
    "",
    "Write in a business type, market research format.",
  ].join("\n");
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const assistantDeltas: string[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Untitled\n\n",
  });
  const marketSources = [
    {
      title: "Dating market source",
      url: "https://example.com/dating-market",
      snippet: "Current online dating market data.",
    },
    {
      title: "Social media market source",
      url: "https://example.org/social-media-market",
      snippet: "Current social media market data.",
    },
    {
      title: "Consumer platform source",
      url: "https://example.net/platform-market",
      snippet: "Current consumer platform market data.",
    },
  ];
  let marketFetchIndex = 0;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: marketSources,
        },
      };
    }

    if (request.url.endsWith("/web_fetch")) {
      const source = marketSources[
        Math.min(marketFetchIndex, marketSources.length - 1)
      ];
      marketFetchIndex += 1;
      return {
        status: 200,
        headers: {},
        json: {
          title: source.title,
          url: source.url,
          content: `${source.snippet} Fetched current market source content with market sizing, retention, and monetization evidence.`,
          links: [],
        },
      };
    }

    throw new Error(`Unexpected request: ${request.url}`);
  };
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("I can draft this without tools."),
      () => responseWithContent("Still drafting without tools."),
      () => responseWithContent("Ready to write from current market sources."),
    ],
    streamResponders: [
      (request) => {
        const passageIds = getPassageCitationIds(request).slice(0, 3);
        const cited = passageIds.length > 0 ? ` [${passageIds.join("] [")}]` : "";
        const body = [
          "# Software project",
          "",
          "## Market Overview",
          "",
          `Current online dating market data and social media market data both show retention and monetization pressure across consumer platforms.${cited}`,
          "",
          `Source URLs: ${marketSources.map((source) => source.url).join(" ")}`,
          "",
          "## Limitations",
          "Evidence is limited to the fetched market pages in this run.",
          "",
          "## Confidence",
          "Medium confidence based on three fetched sources.",
        ].join("\n");
        return responseWithContentDeltas([body]);
      },
      (request) => {
        const passageIds = getPassageCitationIds(request).slice(0, 3);
        const cited = passageIds.length > 0 ? ` [${passageIds.join("] [")}]` : "";
        const body = [
          "# Software project",
          "",
          "## Market Overview",
          "",
          `Current online dating market data and social media market data both show retention and monetization pressure across consumer platforms.${cited}`,
          "",
          `Source URLs: ${marketSources.map((source) => source.url).join(" ")}`,
          "",
          "## Limitations",
          "Evidence is limited to the fetched market pages in this run.",
          "",
          "## Confidence",
          "Medium confidence based on three fetched sources.",
        ].join("\n");
        return responseWithContentDeltas([body]);
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("web_search"));
  assert.ok(firstStepToolNames.includes("web_fetch"));
  assert.equal(executedCalls[0]?.name, "web_search");
  assert.ok(
    executedCalls.slice(1).every((call) => call.name === "web_fetch"),
  );
  assert.ok(
    executedCalls.filter((call) => call.name === "web_fetch").length >= 1,
  );
  assert.ok(
    streamRequests.length >= 1,
    JSON.stringify({
      statuses,
      assistantDeltas,
      chatRequestCount: chatRequests.length,
      executed: executedCalls.map((call) => call.name),
      note: vault.content.get("Current.md") ?? "",
      streamRequests: streamRequests.length,
    }),
  );
  assert.ok(
    statuses.some((message) =>
      /Model did not request required web tools; running read-only web fallback/.test(
        message,
      ),
    ),
  );
  assert.ok(
    !assistantDeltas.some((delta) =>
      /I could not get the model to request the required read tools/i.test(delta),
    ),
  );
  const note = vault.content.get("Current.md") ?? "";
  assert.match(
    note,
    /^# Software project/m,
    JSON.stringify({ statuses, assistantDeltas, note, streamRequests: streamRequests.length }),
  );
  assert.match(note, /current online dating market/i);
  assert.match(note, /social media market/i);
});

test("model can return multiple tool calls in one step for compound create mission", async () => {
  const prompt =
    "Create folder Projects/New and create note Projects/New/Brief.md.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({ prompt });
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCalls([
          { name: "create_folder", arguments: { path: "Projects/New" } },
          {
            name: "create_file",
            arguments: {
              path: "Projects/New/Brief.md",
              content: "# Brief",
            },
          },
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_folder", "create_file"],
  );
});

test("multi-step CRUD mission continues after the first mutation", async () => {
  const prompt =
    "Create Projects/Temp.md, append to Projects/Temp.md, then delete Projects/Temp.md.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("create_file", {
          path: "Projects/Temp.md",
          content: "# Temp",
          createFolders: true,
        }),
      () =>
        responseWithToolCall("append_file", {
          path: "Projects/Temp.md",
          text: "\nMore",
        }),
      () =>
        responseWithToolCall("delete_path", {
          path: "Projects/Temp.md",
        }),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {},
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["create_file", "append_file", "delete_path"],
  );
});

test("delete then write replaces current note instead of trashing it", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const vault = createRunnerVaultContext({
    prompt:
      "Delete the current note. Ensure the space is empty. I want you to write now, a 1000 word essay on Grapes of Wrath.",
    content: "Old essay",
  });
  const essayDraft = [
    "New Grapes of Wrath essay.",
    ...Array.from({ length: 920 }, (_, index) => `migration${index}`),
  ].join(" ");

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to replace the note.")],
    streamResponders: [
      () => responseWithContentDeltas([essayDraft]),
    ],
  });

  await runAgentMission({
    prompt:
      "Delete the current note. Ensure the space is empty. I want you to write now, a 1000 word essay on Grapes of Wrath.",
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(vault.content.get("Current.md"), essayDraft);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation, "replace");
  assert.ok(receipts[0].backupPath?.startsWith(".agent-backups/"));
  assert.equal(vault.content.has("Current.md"), true);
});

test("non-streaming delete-current-note then write accepts replace receipt as the content write", async () => {
  const prompt =
    "Delete the current note. Ensure that the space is empty. I want you to write now, a 300 word essay on Grapes of Wrath. Include E2E_DELETE_CURRENT_WRITE_UNIT.";
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const vault = createRunnerVaultContext({
    prompt,
    content: "# Old E2E Page\n\nE2E_DELETE_CURRENT_OLD_UNIT\n",
  });
  const broker = new ApprovalBroker();
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("replace_current_file", {
          text: "# Grapes of Wrath\n\nE2E_DELETE_CURRENT_WRITE_UNIT\n",
        }),
      () =>
        responseWithContent(
          "Done. Replaced the current note with the requested Grapes of Wrath essay.",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onStatus: (message) => statuses.push(message),
      onRunComplete: (event) => completions.push(event),
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "replace_current_file"],
  );
  assert.equal(
    completions.at(-1)?.stopReason,
    "write_completed",
    statuses.join("\n"),
  );
  assert.ok(!statuses.includes("Stopped at safety limit. Review partial results."));
  assert.ok(!statuses.some((message) => /tool:append_to_current_file/.test(message)));
});

test("web append payload stays compact with capped note and source context", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const compactStatuses: string[] = [];
  const baseRegistry = createDefaultToolRegistry();
  const vault = createRunnerVaultContext({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    content: "n".repeat(12000),
  });
  const fetchedSourceContent =
    "MCP servers research cited summary explains MCP servers and source context. " +
    "f".repeat(6000);
  const compactPassageId = extractEvidencePassages(fetchedSourceContent, {
    sourceLocator: "https://example.com/1",
  }).passages[0]?.id;

  const registry: ToolRegistry = {
    getDefinitions: () => baseRegistry.getDefinitions(),
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);

      if (call.name === "read_current_file") {
        const maxChars =
          typeof call.arguments.maxChars === "number"
            ? call.arguments.maxChars
            : 12000;
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: "Current.md",
            content: "n".repeat(maxChars),
          },
        };
      }

      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: Array.from({ length: 3 }, (_, index) => ({
              title: `Result ${index + 1}`,
              url: `https://example.com/${index + 1}`,
              snippet: "s".repeat(800),
            })),
          },
        };
      }

      if (call.name === "web_fetch") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            title: "Fetched source",
            url: call.arguments.url,
            content: fetchedSourceContent,
            links: [],
          },
        };
      }

      return {
        ok: true,
        toolName: call.name,
        output: { path: "Current.md", bytesWritten: 20 },
      };
    },
  };

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/1" }),
      () => responseWithContent("Ready to append the sourced summary."),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["MCP servers research cited summary."]),
      (request) => {
        const evidence = getPassageCitationIds(request).join(" ") || compactPassageId || "";
        return responseWithContentDeltas([
          `MCP servers research cited summary. This concise summary covers MCP servers. Source: https://example.com/1 ${evidence}`.trim(),
        ]);
      },
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => compactStatuses.push(message),
    },
  });

  assert.equal(executedCalls[0]?.name, "web_search");
  assert.ok(executedCalls.slice(1).every((call) => call.name === "web_fetch"));
  assert.ok(executedCalls.filter((call) => call.name === "web_fetch").length >= 1);
  assert.equal(streamRequests.length, 2);
  const writtenNote = vault.content.get("Current.md") ?? "";
  assert.ok(writtenNote.startsWith("n".repeat(12000)));
  assert.match(
    writtenNote,
    /MCP servers research cited summary/,
    JSON.stringify(compactStatuses),
  );
  assert.match(writtenNote, /https:\/\/example\.com\/1/);
  assert.match(writtenNote, /source:[a-z0-9]+:passage:\d+-\d+/i);
  const maxRequestChars = Math.max(
    ...[...chatRequests, ...streamRequests].map((request) =>
      JSON.stringify(request).length,
    ),
  );
  assert.ok(
    maxRequestChars < 30000,
    `request was ${maxRequestChars} chars; chat=${chatRequests.map((request) => JSON.stringify(request).length).join(",")}; stream=${streamRequests.map((request) => JSON.stringify(request).length).join(",")}`,
  );
});

test("simple date prompts avoid vault and web tools", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Today is Friday.")],
  });

  await runAgentMission({
    prompt: "What is today's date?",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      now: () => new Date("2026-07-04T12:34:56"),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.deepEqual(executedCalls, []);
  assert.match(deltas.join(""), /Today is Saturday, July 4, 2026\./);
});

test("ambiguous date math is marked as a clarification stop", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const completions: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("What year should I use for February 9?"),
    ],
  });

  await runAgentMission({
    prompt: "What is the date 2902 days from February 9?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.equal(chatRequests[0].tools, undefined);
  assert.deepEqual(completions, ["clarifying_question"]);
});

test("concise assistant questions are marked as clarification stops", async () => {
  const completions: string[] = [];
  const deltas: string[] = [];

  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithContent("Which note should I use as the source?"),
    ],
  });

  await runAgentMission({
    prompt: "Help me with this.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onRunComplete: (event) => completions.push(event.stopReason),
    },
  });

  assert.deepEqual(deltas, ["Which note should I use as the source?"]);
  assert.deepEqual(completions, ["clarifying_question"]);
});

test("unavailable write tool requests trigger one corrective replan", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("replace_current_file", { text: "# Replacement" }),
      () => responseWithToolCall("append_to_current_file", { text: "Summary" }),
    ],
  });

  await runAgentMission({
    prompt: "Summarize this note.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "append_to_current_file"],
  );
  assert.ok(statuses.includes("Rejected unavailable tool: replace_current_file"));
  assert.ok(
    statuses.includes(
      "Unavailable write tool requested; asking model to choose an allowed path...",
    ),
  );
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /requested a write tool that is not available/,
  );
});

test("auto thinking resolves known model families and omits unknown models", () => {
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "gpt-oss:120b" })),
    "medium",
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "qwen3:32b" })),
    true,
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "deepseek-r1:8b" })),
    true,
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "deepseek-v3.1:671b" })),
    true,
  );
  assert.equal(
    resolveThinkingMode(createRunnerSettings({ model: "llama3.1:8b" })),
    undefined,
  );
  assert.equal(
    resolveThinkingMode(
      createRunnerSettings({ model: "llama3.1:8b", thinkingMode: "high" }),
    ),
    "high",
  );
  assert.equal(
    resolveThinkingMode(
      createRunnerSettings({ model: "gpt-oss:120b", thinkingMode: "off" }),
    ),
    undefined,
  );
});

test("unsupported thinking retries once without think and completes", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        throw new ModelClientError("api", "thinking is unsupported by this model");
      },
      () => responseWithToolCall("web_search", { query: "MCP servers status" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Fallback answer. Source: https://example.com/source",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ model: "gpt-oss:120b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 4);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(chatRequests[1].think, undefined);
  assert.equal(chatRequests[2].think, undefined);
  assert.equal(chatRequests[3].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(statuses.includes("Thinking unsupported; using standard loop."));
  assert.deepEqual(deltas, [
    "Fallback answer. Source: https://example.com/source",
  ]);
});

test("transient model API errors retry before blocking", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        const error = new Error("Internal Server Error (ref: retry-once)") as Error & {
          category?: string;
          status?: number;
        };
        error.name = "ModelClientError";
        error.category = "api";
        error.status = 500;
        throw error;
      },
      () => responseWithContent("Recovered answer"),
    ],
  });

  await runAgentMission({
    prompt: "Give me a concise answer about planning.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ model: "llama3.1:8b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[0].think, undefined);
  assert.equal(chatRequests[1].think, undefined);
  assert.ok(
    statuses.includes("Transient model provider error; retrying model step..."),
  );
  assert.deepEqual(deltas, ["Recovered answer"]);
});

test("repeated transient model API errors retry without thinking mode", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const deltas: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const transientError = () => {
    throw new ModelClientError(
      "api",
      "Internal Server Error (ref: retry-without-thinking)",
      { status: 500 },
    );
  };
  const client = createClient({
    chatRequests,
    chatResponders: [
      transientError,
      transientError,
      () => responseWithToolCall("web_search", { query: "MCP servers status" }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/source",
        }),
      () =>
        responseWithContent(
          "Recovered web answer. Source: https://example.com/source",
        ),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for MCP servers.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {
      settings: createRunnerSettings({ model: "gpt-oss:120b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 5);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(chatRequests[1].think, "medium");
  assert.equal(chatRequests[2].think, undefined);
  assert.equal(chatRequests[3].think, undefined);
  assert.equal(chatRequests[4].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(
    statuses.includes("Transient model provider error; retrying model step..."),
  );
  assert.ok(
    statuses.includes(
      "Transient model provider error persisted; retrying without thinking mode...",
    ),
  );
  assert.ok(statuses.includes("Thinking unsupported; using standard loop."));
  assert.deepEqual(deltas, [
    "Recovered web answer. Source: https://example.com/source",
  ]);
});

test("english-only direct answers repair CJK before display", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const deltas: string[] = [];
  const statuses: string[] = [];

  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithContent("Coral reefs 珊瑚 support biodiversity."),
      () => responseWithContent("Coral reefs support biodiversity."),
    ],
  });

  await runAgentMission({
    prompt: "What is one fact about coral reefs?",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.match(
    chatRequests[1].messages.at(-1)?.content ?? "",
    /Rewrite the previous answer in English only/,
  );
  assert.deepEqual(deltas, ["Coral reefs support biodiversity."]);
  assert.ok(
    statuses.includes(
      "Model produced non-English output; requesting English-only repair...",
    ),
  );
});

test("unknown auto thinking model omits think in runner requests", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("Direct answer")],
  });

  await runAgentMission({
    prompt: "Write a short static answer.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ model: "llama3.1:8b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
  });

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
});

test("append writeback streams final markdown into the current note only", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const metrics: AgentRunMetricEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithContent("Ready to append.", "private planning"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas(
          ["- First action\n", "- Second action\n"],
          "- First action\n- Second action\n",
          ["private thinking should stay out"],
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      onReceipt: (receipt) => receipts.push(receipt.output as Record<string, unknown>),
      onMetric: (event) => metrics.push(event),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].think, undefined);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.equal(
    vault.content.get("Current.md"),
    "Initial note\n- First action\n- Second action\n",
  );
  assert.equal(finalDeltas.join(""), "- First action\n- Second action\n");
  assert.deepEqual(thinkingDeltas, ["private thinking should stay out"]);
  assert.ok(!vault.content.get("Current.md")?.includes("private thinking"));
  assert.equal(receipts[0].streamed, true);
  assert.equal(receipts[0].partial, false);
  assert.equal(receipts[0].operation, "append");
  assert.ok(
    metrics.some(
      (event) =>
        event.kind === "model_stream" &&
        event.name === "stream_writeback" &&
        (event.requestChars ?? 0) > 0,
    ),
  );
});

test("simple generated current-note writeback skips read and planner loops", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const configs: AgentRunConfigEvent[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt = "In this note, can you write me a summary of the Vietnam war?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "The Vietnam War was a Cold War-era conflict involving Vietnam, the United States, and regional allies.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
      onRunConfig: (event) => configs.push(event),
    },
  });

  assert.equal(configs[0].writeAutonomy, true);
  assert.equal(configs[0].writebackMode, "streaming_current_note");
  assert.equal(configs[0].route, "direct_writeback");
  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    [],
  );
  assert.ok(statuses.includes("Using direct note writeback; no tool loop needed..."));
  assert.ok(!statuses.includes("Reading current note..."));
  assert.ok(!statuses.includes("Planning..."));
  assert.ok(!statuses.some((message) => /Agent step/.test(message)));
  assert.equal(
    finalDeltas.join(""),
    "The Vietnam War was a Cold War-era conflict involving Vietnam, the United States, and regional allies.",
  );
  assert.equal(
    vault.content.get("Current.md"),
    "The Vietnam War was a Cold War-era conflict involving Vietnam, the United States, and regional allies.",
  );
});

test("current-note writeback prefers live editor updates when available", async () => {
  const prompt = "In this note, write a short project update.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
    liveEditorWrite: true,
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () => responseWithContentDeltas(["Live editor chunk.\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
  });

  assert.equal(vault.content.get("Current.md"), "Initial note\nLive editor chunk.\n");
  assert.ok(vault.operations.includes("setEditor:Current.md"));
  assert.ok(vault.operations.includes("modify:Current.md"));
  assert.ok(
    vault.operations.indexOf("setEditor:Current.md") <
      vault.operations.indexOf("modify:Current.md"),
  );
});

test("current-note writeback streams chunks live to chat and note", async () => {
  const finalDeltas: string[] = [];
  const prompt = "In this note, write a short project update.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const firstChunk = `${"A".repeat(801)}\n`;
  const secondChunk = "Second live chunk.\n";
  const client: ModelClient = {
    chat: async () => {
      throw new Error("chat should not be called for direct writeback");
    },
    streamChat: async (_request, events = {}) => {
      events.onContentDelta?.(firstChunk);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(finalDeltas.join(""), firstChunk);
      assert.equal(vault.content.get("Current.md"), `Initial note\n${firstChunk}`);

      events.onContentDelta?.(secondChunk);
      return responseWithContent(firstChunk + secondChunk);
    },
  };

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(finalDeltas.join(""), firstChunk + secondChunk);
  assert.equal(
    vault.content.get("Current.md"),
    `Initial note\n${firstChunk}${secondChunk}`,
  );
});

test("streamed note writeback stops Chinese off-topic output before note mutation", async () => {
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "In this note, can you write me a summary of the Vietnam war?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests: [],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# 1. 前言\n\n",
          "在上一篇文章中，我们分析了`axios`的请求配置，知道了在`axios`中，默认配置和用户配置可以合并，并且用户配置会优先于默认配置。",
          "接下来，我们就合并后的配置看看`axios`是如何来发请求的。\n\n",
          "在`/lib/core/Axios.js`文件中，我们可以看到，在`Axios`的原型上存在一个`request`方法。",
        ]),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onFinalDelta: (delta) => finalDeltas.push(delta),
          onAssistantDelta: (delta) => assistantDeltas.push(delta),
          onStatus: (message) => statuses.push(message),
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /drifted off topic/,
  );

  assert.deepEqual(finalDeltas, []);
  assert.deepEqual(assistantDeltas, []);
  assert.deepEqual(receipts, []);
  assert.equal(vault.content.get("Current.md"), "Initial note");
  assert.ok(
    statuses.includes(
      "Stopped model output because it drifted off topic from the current mission.",
    ),
  );
});

test("streamed note writeback retries CJK output before note mutation", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const lifecycleMessages: string[] = [];
  const statuses: string[] = [];
  const prompt = "In this note, can you write me a summary of the Vietnam war?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests: [],
    streamRequests,
    streamResponders: [
      () => responseWithContentDeltas(["Vietnam 战争 summary.\n"]),
      () => responseWithContentDeltas(["The Vietnam War summary.\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
      onStreamLifecycle: (event) => lifecycleMessages.push(event.message),
    },
  });

  assert.equal(streamRequests.length, 2);
  assert.deepEqual(finalDeltas, ["The Vietnam War summary.\n"]);
  assert.equal(vault.content.get("Current.md"), "Initial note\nThe Vietnam War summary.\n");
  assert.ok(!vault.content.get("Current.md")?.includes("战争"));
  assert.ok(
    lifecycleMessages.includes("Language gate retrying English-only output..."),
  );
  assert.ok(
    statuses.includes(
      "Model produced non-English output; retrying English-only writeback...",
    ),
  );
});

test("thinking-only writeback retries once and fails without a receipt", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () => responseWithContentDeltas([], "", ["thinking only"]),
      () => responseWithContentDeltas([], "", ["still thinking only"]),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onStatus: (message) => statuses.push(message),
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /The model returned no writable content\. Nothing was written\./,
  );

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 2);
  assert.equal(streamRequests[0].think, undefined);
  assert.equal(streamRequests[1].think, undefined);
  assert.equal(vault.content.get("Current.md"), "Initial note");
  assert.deepEqual(receipts, []);
  assert.ok(
    statuses.includes(
      "No writable content received; retrying content-only writeback...",
    ),
  );
  assert.ok(
    statuses.includes(
      "The model returned no writable content. Nothing was written.",
    ),
  );
});

test("streamed writeback suppresses requested tool markup and retries without writing it", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "<requested_tool_call>",
          "<name>read_current_file</name>",
          "</requested_tool_call>",
        ]),
      () => responseWithContentDeltas(["- Real action\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
    },
  });

  assert.equal(streamRequests.length, 2);
  assert.deepEqual(finalDeltas, ["- Real action\n"]);
  assert.equal(vault.content.get("Current.md"), "Initial note\n- Real action\n");
  assert.ok(!vault.content.get("Current.md")?.includes("requested_tool_call"));
  assert.ok(
    statuses.includes(
      "Model requested a tool during writeback; retrying content-only output...",
    ),
  );
});

test("streamed writeback writes post-release python fence chunks", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const prompt = "Can you write the solution to two sum leetcode problem on the current page?";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "```",
          "python\n",
          "def two_sum(nums, target):\n",
          "    seen = {}\n",
          "    for index, num in enumerate(nums):\n",
          "        need = target - num\n",
          "        if need in seen:\n",
          "            return [seen[need], index]\n",
          "        seen[num] = index\n",
          "    return []\n",
          "```\n",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 1);
  assert.match(finalDeltas.join(""), /def two_sum/);
  assert.match(vault.content.get("Current.md") ?? "", /return \[seen\[need\], index\]/);
  assert.match(vault.content.get("Current.md") ?? "", /```\n$/);
});

test("repeated streamed tool markup fails cleanly without note mutation", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const toolMarkup = [
    "<requested_tool_call>",
    "<name>read_current_file</name>",
    "</requested_tool_call>",
  ];
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () => responseWithContentDeltas(toolMarkup),
      () => responseWithContentDeltas(toolMarkup),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /requested a tool during streamed writeback/,
  );

  assert.equal(streamRequests.length, 2);
  assert.equal(vault.content.get("Current.md"), "Initial note");
  assert.deepEqual(receipts, []);
});

test("writeback retry writes content from the second stream", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const statuses: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Append 2 action items to this note.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Initial note",
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to append.")],
    streamResponders: [
      () => responseWithContentDeltas([], "", ["thinking only"]),
      () => responseWithContentDeltas(["- First\n", "- Second\n"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onStatus: (message) => statuses.push(message),
      onReceipt: (receipt) =>
        receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  assert.equal(chatRequests.length, 0);
  assert.equal(streamRequests.length, 2);
  assert.equal(streamRequests[0].think, undefined);
  assert.equal(streamRequests[1].think, undefined);
  assert.deepEqual(finalDeltas, ["- First\n", "- Second\n"]);
  assert.equal(vault.content.get("Current.md"), "Initial note\n- First\n- Second\n");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].bytesWritten, 17);
  assert.ok(
    statuses.includes(
      "No writable content received; retrying content-only writeback...",
    ),
  );
  assert.ok(statuses.includes("Streaming writeback complete."));
});

test("empty replace writeback does not erase the current note", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Original note",
    now: new Date(654),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to replace.")],
    streamResponders: [
      () => responseWithContentDeltas([], "", ["thinking only"]),
      () => responseWithContentDeltas([], ""),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /The model returned no writable content\. Nothing was written\./,
  );

  assert.equal(streamRequests.length, 2);
  assert.equal(vault.content.get("Current.md"), "Original note");
  assert.equal(vault.content.get(".agent-backups/654-Current.md"), "Original note");
  assert.equal(vault.operations.includes("modify:Current.md"), false);
  assert.deepEqual(receipts, []);
});

test("replace writeback creates a backup before streaming replacement content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Old note",
    now: new Date(456),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to replace.")],
    streamResponders: [
      () => responseWithContentDeltas(["# Brief\n", "\nReplacement body."]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  assert.equal(streamRequests.length, 1);
  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(firstStepToolNames.includes("read_current_file"));
  assert.ok(firstStepToolNames.includes("replace_current_file"));
  assert.equal(vault.content.get("Current.md"), "# Brief\n\nReplacement body.");
  assert.equal(vault.content.get(".agent-backups/456-Current.md"), "Old note");
  assert.ok(
    vault.operations.indexOf("create:.agent-backups/456-Current.md") <
      vault.operations.indexOf("modify:Current.md"),
  );
  assert.equal(receipts[0].streamed, true);
  assert.equal(receipts[0].backupPath, ".agent-backups/456-Current.md");
  assert.equal(receipts[0].operation, "replace");
});

test("direct essay edit routes to whole-note replace instead of section edit", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Edit the essay and add more detail to the paragraphs.";
  const original = "# Essay\n\nThin original paragraph.\n";
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(321),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to revise.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Essay\n",
          "\nExpanded paragraph with additional textual detail.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) =>
        receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual(firstStepToolNames, ["read_current_file"]);
  assert.ok(!firstStepToolNames.includes("prepare_edit_current_section"));
  assert.ok(!firstStepToolNames.includes("edit_current_section"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("Current.md"),
    "# Essay\n\nExpanded paragraph with additional textual detail.",
  );
  assert.equal(vault.content.get(".agent-backups/321-Current.md"), original);
  assert.equal(receipts[0].operation, "replace");
  assert.equal(receipts[0].backupPath, ".agent-backups/321-Current.md");
});

test("revision approval follow-up inherits prior assistant edit intent", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Go ahead and revise";
  const original = "# Essay\n\nThin original paragraph.\n";
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(322),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready to revise.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "# Essay\n",
          "\nExpanded follow-up revision with additional detail.",
        ]),
    ],
  });

  await runAgentMission({
    prompt,
    conversationHistory: [
      {
        role: "assistant",
        content:
          "I'll revise the essay to add more textual detail, historical context, and analytical depth. Let me update the current section with an expanded version.",
      },
    ],
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) =>
        receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual(firstStepToolNames, ["read_current_file"]);
  assert.ok(!firstStepToolNames.includes("prepare_edit_current_section"));
  assert.ok(!firstStepToolNames.includes("edit_current_section"));
  assert.ok(
    chatRequests[0].messages.some((message) =>
      /Resolve this turn's tool routing as: "Revise this essay by replacing the active note with an expanded draft\."/i.test(
        message.content,
      ),
    ),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("Current.md"),
    "# Essay\n\nExpanded follow-up revision with additional detail.",
  );
  assert.equal(vault.content.get(".agent-backups/322-Current.md"), original);
  assert.equal(receipts[0].operation, "replace");
  assert.equal(receipts[0].backupPath, ".agent-backups/322-Current.md");
});

test("section edit writeback prepares heading and preserves surrounding content", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Edit the Goals section in this note.";
  const original = [
    "# Project",
    "",
    "Intro.",
    "",
    "## Goals",
    "Old goals.",
    "",
    "## Scope",
    "Keep scope.",
  ].join("\n");
  const vault = createRunnerVaultContext({
    prompt,
    content: original,
    now: new Date(789),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("prepare_edit_current_section", {
          heading: "Goals",
          level: 2,
        }),
      () => responseWithContent("Ready to stream the section body."),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["New goals.", "\n- Ship streaming edits"]),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onReceipt: (receipt) => receipts.push(receipt.output as Record<string, unknown>),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  assert.ok(
    chatRequests[0].tools
      ?.map((tool) => tool.function.name)
      .includes("prepare_edit_current_section"),
  );
  assert.ok(
    !chatRequests[0].tools
      ?.map((tool) => tool.function.name)
      .includes("edit_current_section"),
  );
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "prepare_edit_current_section"],
  );
  assert.equal(
    vault.content.get("Current.md"),
    [
      "# Project",
      "",
      "Intro.",
      "",
      "## Goals",
      "New goals.",
      "- Ship streaming edits",
      "## Scope",
      "Keep scope.",
    ].join("\n"),
  );
  assert.equal(vault.content.get(".agent-backups/789-Current.md"), original);
  assert.equal(receipts[0].streamed, true);
  assert.equal(receipts[0].operation, "edit");
  assert.equal(receipts[0].heading, "Goals");
});

test("interrupted streamed replace emits a partial receipt and keeps backup", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Original note",
    now: new Date(987),
  });
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [() => responseWithContent("Ready.")],
    streamResponders: [
      () =>
        responseWithContentDeltas(["# Partial brief"], "# Partial brief", [], {
          streamError: new Error("stream interrupted"),
        }),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /stream interrupted/,
  );

  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get(".agent-backups/987-Current.md"), "Original note");
  assert.equal(vault.content.get("Current.md"), "# Partial brief");
  assert.ok(
    vault.operations.indexOf("create:.agent-backups/987-Current.md") <
      vault.operations.indexOf("modify:Current.md"),
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].streamed, true);
  assert.equal(receipts[0].partial, true);
  assert.equal(receipts[0].backupPath, ".agent-backups/987-Current.md");
});

test("interrupted streamed replace before content preserves the current note", async () => {
  const streamRequests: ModelChatRequest[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const prompt = "Replace this note with a clean project brief.";
  const vault = createRunnerVaultContext({
    prompt,
    content: "Original note",
    now: new Date(988),
  });
  const client = createClient({
    chatRequests: [],
    streamRequests,
    chatResponders: [() => responseWithContent("Ready.")],
    streamResponders: [
      () =>
        responseWithContentDeltas([], "", [], {
          streamError: new Error("stream failed before content"),
        }),
    ],
  });

  await assert.rejects(
    () =>
      runAgentMission({
        prompt,
        modelClient: client,
        toolRegistry: createDefaultToolRegistry(),
        toolContext: vault.context,
        enableStreaming: true,
        events: {
          onReceipt: (receipt) =>
            receipts.push(receipt.output as Record<string, unknown>),
        },
      }),
    /stream failed before content/,
  );

  assert.equal(streamRequests.length, 1);
  assert.equal(vault.content.get(".agent-backups/988-Current.md"), "Original note");
  assert.equal(vault.content.get("Current.md"), "Original note");
  assert.equal(vault.operations.includes("modify:Current.md"), false);
  assert.deepEqual(receipts, []);
});

test("assistant sanitizer strips malformed special tokens", () => {
  assert.equal(
    sanitizeAssistantContent(
      "< | begin_of__sentence | >Final answer< | end_of_sentence | >",
    ),
    "Final answer",
  );
  assert.equal(
    sanitizeAssistantContent("<｜begin▁of▁sentence｜># 1. 两数之和"),
    "# 1. 两数之和",
  );
});

type TestModelChatResponse = ModelChatResponse & {
  contentDeltas?: string[];
  thinkingDeltas?: string[];
  streamError?: unknown;
};

type ChatResponder = (request: ModelChatRequest) => TestModelChatResponse;

function createClient({
  chatRequests,
  streamRequests = [],
  chatResponders = [],
  streamResponders,
}: {
  chatRequests: ModelChatRequest[];
  streamRequests?: ModelChatRequest[];
  chatResponders?: ChatResponder[];
  streamResponders?: ChatResponder[];
}): ModelClient {
  return {
    chat: async (request) => {
      chatRequests.push(cloneRequest(request));
      const responder = chatResponders[chatRequests.length - 1];

      if (!responder) {
        throw new Error(`No chat responder for request ${chatRequests.length}`);
      }

      return responder(request);
    },
    streamChat: async (request, events: ModelChatStreamEvents = {}) => {
      streamRequests.push(cloneRequest(request));
      const responders = streamResponders ?? chatResponders;
      const responder = responders[streamRequests.length - 1];

      if (!responder) {
        throw new Error(`No stream responder for request ${streamRequests.length}`);
      }

      const response = responder(request);
      const thinkingDeltas =
        response.thinkingDeltas ??
        (response.message.thinking ? [response.message.thinking] : []);
      const contentDeltas =
        response.contentDeltas ??
        (response.message.content ? [response.message.content] : []);

      for (const delta of thinkingDeltas) {
        events.onThinkingDelta?.(delta);
      }

      for (const delta of contentDeltas) {
        events.onContentDelta?.(delta);
      }

      if (response.streamError) {
        throw response.streamError;
      }

      return response;
    },
  };
}

function getPassageCitationIds(request: ModelChatRequest): string[] {
  const matches = request.messages
    .flatMap((message) =>
      message.content.match(/source:[a-z0-9]+:passage:\d+-\d+/giu) ?? [],
    );
  return [...new Set(matches)];
}

function cloneRequest(request: ModelChatRequest): ModelChatRequest {
  return {
    ...request,
    messages: [...request.messages],
    tools: request.tools ? [...request.tools] : undefined,
  };
}

function createRunnerSettings(
  overrides: Partial<AgentSettings> = {},
): AgentSettings {
  return {
    settingsSchemaVersion: 2,
    autonomyProfile: "automatic",
    outputProfile: "active_or_new_note",
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.com/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "gpt-oss:120b",
    enableStreaming: true,
    thinkingMode: "auto",
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: true,
    maxAgentSteps: MAX_AGENT_STEPS,
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: false,
    agenticReflexDiagnosticsEnabled: true,
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: true,
    researchMemoryFolder: "Agent Research Memory",
    semanticSearchEnabled: true,
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: true,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 1000,
    semanticIndexPersistVectors: true,
    requestTimeoutMs: 60000,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    ...overrides,
  };
}

function createReflexSemanticEmbeddingProvider(): SemanticEmbeddingProvider {
  return {
    async embed(request) {
      const semanticVector = [1, 0];
      const otherVector = [0, 1];
      const classify = (text: string) =>
        /notes say|related ideas|conceptually|ritual kingship|archive entries/i.test(
          text,
        )
          ? semanticVector
          : otherVector;
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(classify),
        queries: request.queries.map(classify),
      };
    },
  };
}

function createRunnerVaultContext(options: {
  prompt?: string;
  content?: string;
  path?: string;
  now?: Date;
  model?: string;
  thinkingMode?: ThinkingMode;
  streamWritebackMode?: StreamWritebackMode;
  liveEditorWrite?: boolean;
} = {}) {
  const notePath = options.path ?? "Current.md";
  const noteName = notePath.split("/").pop() ?? notePath;
  const noteBasename = noteName.replace(/\.[^.]+$/i, "");
  const content = new Map<string, string>([
    [notePath, options.content ?? "Initial note"],
  ]);
  const folders = new Set<string>();
  const operations: string[] = [];
  const activeFile = {
    path: notePath,
    name: noteName,
    basename: noteBasename,
    extension: "md",
  };

  const getFile = (path: string) => {
    if (!content.has(path)) {
      return null;
    }

    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/i, ""),
      extension: name.includes(".")
        ? name.split(".").pop()?.toLowerCase() ?? ""
        : "",
    };
  };

  const getFolder = (path: string) => {
    if (!path || !folders.has(path)) {
      return null;
    }

    return {
      path,
      name: path.split("/").pop() ?? path,
    };
  };

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      getAllLoadedFiles: () => [
        ...[...folders].map((path) => ({
          path,
          name: path.split("/").pop() ?? path,
        })),
        ...[...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
      ],
      cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
      read: async (file: { path: string }) => content.get(file.path) ?? "",
      modify: async (file: { path: string }, data: string) => {
        operations.push(`modify:${file.path}`);
        content.set(file.path, data);
      },
      getFileByPath: getFile,
      getFolderByPath: getFolder,
      getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
      createFolder: async (path: string) => {
        operations.push(`createFolder:${path}`);
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        operations.push(`create:${path}`);
        content.set(path, data);
        return getFile(path);
      },
      rename: async (file: { path: string; name?: string; basename?: string }, newPath: string) => {
        operations.push(`rename:${file.path}:${newPath}`);
        const value = content.get(file.path) ?? "";
        content.delete(file.path);
        content.set(newPath, value);
        file.path = newPath;
        file.name = newPath.split("/").pop() ?? newPath;
        file.basename = file.name.replace(/\.[^.]+$/i, "");
      },
    },
  };

  const context: ToolExecutionContext = {
    app: app as never,
    settings: createRunnerSettings({
      model: options.model ?? "gpt-oss:120b",
      thinkingMode: options.thinkingMode ?? "auto",
      streamWritebackMode:
        options.streamWritebackMode ?? "all_current_note_content_writes",
    }),
    originalPrompt: options.prompt ?? "Append to this note.",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      json: { error: "not mocked" },
    }),
    now: () => options.now ?? new Date(123),
    getCurrentMarkdownFile: () => activeFile as never,
    getCurrentMarkdownContent: (file) => content.get(file.path) ?? null,
    setCurrentMarkdownContent: options.liveEditorWrite
      ? (file, data) => {
          operations.push(`setEditor:${file.path}`);
          content.set(file.path, data);
          return true;
        }
      : undefined,
  };

  return { context, content, folders, operations };
}

function createCollectingRegistry(executedCalls: ModelToolCall[]): ToolRegistry {
  const baseRegistry = createDefaultToolRegistry();
  const prepare = baseRegistry.prepare?.bind(baseRegistry);
  const executePrepared = baseRegistry.executePrepared?.bind(baseRegistry);
  const getDescriptor = baseRegistry.getDescriptor?.bind(baseRegistry);
  return {
    getDefinitions: () => baseRegistry.getDefinitions(),
    getDescriptor: getDescriptor
      ? (toolName) => getDescriptor(toolName)
      : undefined,
    prepare: prepare
      ? (call, context) => prepare(call, context)
      : undefined,
    executePrepared: executePrepared
      ? async (action, context, authorization) => {
          executedCalls.push({
            name: action.toolName,
            arguments:
              action.normalizedArgs && typeof action.normalizedArgs === "object"
                ? (action.normalizedArgs as Record<string, unknown>)
                : {},
          });
          return executePrepared(action, context, authorization);
        }
      : undefined,
    execute: async (call, context) => {
      executedCalls.push(call);
      return baseRegistry.execute(call, context);
    },
  };
}

function createRegistry(
  executedCalls: ModelToolCall[],
  options: {
    readCurrentError?: string;
    inspectVaultError?: string;
  } = {},
): ToolRegistry {
  return {
    getDefinitions: () => [
      {
        type: "function",
        function: {
          name: "read_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_current_folder",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_markdown_files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_markdown_files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "inspect_semantic_index",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "semantic_search_notes",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "rebuild_semantic_index",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_markdown_files",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "inspect_vault_context",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "count_words",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "get_note_graph_context",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "find_related_notes",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "suggest_note_links",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_folder",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "get_path_info",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "search_research_memory",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_research_memory",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_research_memory",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_templates",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "read_template",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "seed_default_templates",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_template",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "fill_template",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_research_pack",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_folder",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "replace_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "move_path",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "delete_path",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_to_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "append_to_current_section",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "rename_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "retitle_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "highlight_current_file_phrase",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "restore_current_file_from_backup",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "prepare_edit_current_section",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "edit_current_section",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "replace_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "delete_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "link_related_notes_in_current_file",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_design_canvas",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "create_svg_design",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);

      if (call.name === "read_current_file" && options.readCurrentError) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "execution_failed",
            message: options.readCurrentError,
          },
        };
      }

      if (call.name === "inspect_vault_context" && options.inspectVaultError) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "execution_failed",
            message: options.inspectVaultError,
          },
        };
      }

      return {
        ok: true,
        toolName: call.name,
        output:
          call.name === "read_current_file"
            ? { path: "Current.md", content: "Initial note" }
            : call.name === "list_current_folder"
              ? {
                  activeFile: { path: "Current.md", basename: "Current" },
                  currentFolder: { path: "", name: "" },
                  parentFolder: null,
                  entries: [],
                }
            : call.name === "list_markdown_files"
              ? [
                  { path: "People/Untitled.md", basename: "Untitled" },
                  { path: "Projects/Untitled.md", basename: "Untitled" },
                  { path: "Archive/Untitled.md", basename: "Untitled" },
                ]
            : call.name === "search_markdown_files"
              ? {
                  query: call.arguments.query,
                  limit: call.arguments.limit ?? 30,
                  results: [
                    {
                      path: "People/Untitled.md",
                      basename: "Untitled",
                      matchCount: 1,
                      snippet: "Alex likes local AI tools.",
                    },
                  ],
                  truncated: false,
                }
            : call.name === "semantic_search_notes"
              ? {
                  operation: "semantic_search_notes",
                  mode: "hybrid_semantic",
                  indexUsed: false,
                  indexFresh: false,
                  model: "nomic-ai/nomic-embed-text-v1.5-Q",
                  dim: 512,
                  fallbackUsed: false,
                  results: [
                    {
                      path: "People/Untitled.md",
                      title: "Untitled",
                      score: 0.84,
                      semanticScore: 0.79,
                      lexicalScore: 0.22,
                      reasons: ["semantic_similarity"],
                      heading: null,
                      snippet: "Alex likes local AI tools.",
                    },
                  ],
                }
            : call.name === "inspect_semantic_index"
              ? {
                  operation: "inspect_semantic_index",
                  indexAvailable: true,
                  indexFresh: true,
                  indexedAt: "2026-07-05T00:00:00.000Z",
                  model: "nomic-ai/nomic-embed-text-v1.5-Q",
                  dim: 512,
                  concepts: [{ term: "local", count: 1, paths: ["People/Untitled.md"] }],
                  results: [
                    {
                      path: "People/Untitled.md",
                      title: "Untitled",
                      snippet: "Alex likes local AI tools.",
                    },
                  ],
                }
            : call.name === "rebuild_semantic_index"
              ? {
                  ok: true,
                  operation: "semantic_index_rebuild",
                  markdownPath: "Agent Memory/Semantic Vault Index.md",
                  jsonPath: "Agent Memory/semantic-vault-index.json",
                  indexedAt: "2026-07-05T00:00:00.000Z",
                  noteCount: 1,
                  chunkCount: 1,
                  updatedPaths: ["People/Untitled.md"],
                  removedPaths: [],
                  skippedPaths: [],
                }
            : call.name === "read_markdown_files"
              ? {
                  requestedCount: (call.arguments.paths as unknown[] | undefined)
                    ?.length ?? 0,
                  returnedCount: 3,
                  files: [
                    {
                      path: "People/Untitled.md",
                      basename: "Untitled",
                      content: "Alex likes local AI tools.",
                      truncated: false,
                    },
                    {
                      path: "Projects/Untitled.md",
                      basename: "Untitled",
                      content: "Alex is building an Obsidian research agent.",
                      truncated: false,
                    },
                    {
                      path: "Archive/Untitled.md",
                      basename: "Untitled",
                      content: "Alex prefers traceable agent actions.",
                      truncated: false,
                    },
                  ],
                  skipped: [],
                }
            : call.name === "inspect_vault_context"
              ? {
                  activeFile: {
                    path: "Current.md",
                    folder: "",
                    basename: "Current",
                  },
                  scope: call.arguments.scope ?? "other_folders",
                  folders: [
                    { path: "People", name: "People", markdownCount: 1 },
                    { path: "Projects", name: "Projects", markdownCount: 1 },
                    { path: "Archive", name: "Archive", markdownCount: 1 },
                  ],
                  selectedFiles: [
                    {
                      path: "People/Untitled.md",
                      folder: "People",
                      basename: "Untitled",
                    },
                    {
                      path: "Projects/Untitled.md",
                      folder: "Projects",
                      basename: "Untitled",
                    },
                    {
                      path: "Archive/Untitled.md",
                      folder: "Archive",
                      basename: "Untitled",
                    },
                  ],
                  files: [
                    {
                      path: "People/Untitled.md",
                      folder: "People",
                      basename: "Untitled",
                      content: "Alex likes local AI tools.",
                      truncated: false,
                    },
                    {
                      path: "Projects/Untitled.md",
                      folder: "Projects",
                      basename: "Untitled",
                      content: "Alex is building an Obsidian research agent.",
                      truncated: false,
                    },
                    {
                      path: "Archive/Untitled.md",
                      folder: "Archive",
                      basename: "Untitled",
                      content: "Alex prefers traceable agent actions.",
                      truncated: false,
                    },
                  ],
                  skipped: [],
                  truncated: false,
                }
            : call.name === "list_folder"
              ? { path: call.arguments.path ?? "", entries: [] }
            : call.name === "get_path_info"
              ? { path: call.arguments.path ?? "", exists: true, type: "folder" }
            : call.name === "list_templates"
              ? {
                  templateFolder: "Templates",
                  templates: [
                    {
                      path: "Templates/Meeting.md",
                      basename: "Meeting",
                    },
                  ],
                  truncated: false,
                }
            : call.name === "read_template"
              ? {
                  path: call.arguments.path ?? "Templates/Meeting.md",
                  content: "# {{title}}\n\nDate: {{date}}",
                  placeholders: ["title", "date"],
                  truncated: false,
                }
            : call.name === "seed_default_templates"
              ? {
                  path: "Templates",
                  operation: "create",
                  createdTemplates: [
                    { path: "Templates/Research brief.md" },
                    { path: "Templates/Research note.md" },
                    { path: "Templates/Linear ticket.md" },
                    { path: "Templates/Experiment log.md" },
                    { path: "Templates/Essay section.md" },
                    { path: "Templates/Design brief.md" },
                  ],
                  skippedExisting: [],
                  affectedCount: 6,
                }
            : call.name === "create_template"
              ? {
                  path: call.arguments.path,
                  operation: "create",
                  templateFolder: "Templates",
                  placeholders: ["title"],
                  bytesWritten: 12,
                }
            : call.name === "fill_template"
              ? {
                  path: call.arguments.targetPath ?? "Meeting.md",
                  operation: "create",
                  templateSource: call.arguments.templatePath
                    ? "saved_template"
                    : "ad_hoc_template",
                  templatePath: call.arguments.templatePath,
                  placeholders: ["title"],
                  valuesApplied: ["title"],
                  bytesWritten: 12,
                }
            : call.name === "create_research_pack"
              ? {
                  path: call.arguments.baseFolder ?? "Research/Pack",
                  operation: "create_research_pack",
                  createdPaths: ["Brief.md", "Sources.md", "Synthesis.md", "Index.md"],
                  bytesWritten: 48,
                }
            : call.name === "create_folder"
              ? { path: call.arguments.path, operation: "create_folder" }
            : call.name === "create_file"
              ? {
                  path: call.arguments.path,
                  operation: "create",
                  bytesWritten: 12,
                }
            : call.name === "append_file"
              ? {
                  path: call.arguments.path,
                  operation: "append",
                  bytesWritten: 9,
                }
            : call.name === "replace_file"
              ? {
                  path: call.arguments.path,
                  operation: "replace",
                  backupPath: ".agent-backups/1-Target.md",
                  bytesWritten: 9,
                }
            : call.name === "move_path"
              ? {
                  path: call.arguments.fromPath,
                  toPath: call.arguments.toPath,
                  operation: "move",
                }
            : call.name === "delete_path"
              ? {
                  path: call.arguments.path,
                  operation: "trash",
                  affectedCount: 1,
                }
            : call.name === "append_to_current_file"
              ? { path: "Current.md", bytesWritten: 9 }
            : call.name === "rename_current_file"
              ? {
                  path: "Current.md",
                  toPath: "Renamed.md",
                  title: call.arguments.title,
                  changed: true,
                  operation: "rename_current_file",
                  bytesWritten: 0,
                }
            : call.name === "retitle_current_file"
              ? {
                  path: "Current.md",
                  title: call.arguments.title,
                  changed: true,
                  suggestedFileRename: {
                    from: "Current.md",
                    to: "Native Obsidian Agentic Research.md",
                  },
                }
            : call.name === "highlight_current_file_phrase"
              ? {
                  path: "Current.md",
                  operation: "highlight",
                  phrase: call.arguments.phrase,
                  matchCount: 1,
                  backupPath: ".agent-backups/1-Current.md",
                  changed: true,
                  bytesWritten: 24,
                }
            : call.name === "restore_current_file_from_backup"
              ? {
                  path: "Current.md",
                  operation: "restore",
                  restoredFromBackupPath: ".agent-backups/1-Current.md",
                  backupPath: ".agent-backups/2-Current.md",
                  bytesWritten: 24,
                }
            : call.name === "edit_current_section"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  heading: call.arguments.heading,
                  level: call.arguments.level ?? 2,
                  bytesWritten: 20,
                  replacedChars: 9,
                }
            : call.name === "prepare_edit_current_section"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  heading: call.arguments.heading,
                  level: call.arguments.level ?? 2,
                  prefix: "## Goals\n",
                  suffix: "\n## Scope\nKeep scope.",
                  replacedChars: 11,
                }
            : call.name === "replace_current_file"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  bytesWritten: 9,
                }
            : call.name === "delete_current_file"
              ? {
                  path: "Current.md",
                  backupPath: ".agent-backups/1-Current.md",
                  bytesDeleted: 12,
                }
            : call.name === "link_related_notes_in_current_file"
              ? {
                  path: "Current.md",
                  operation: "link_related_notes",
                  backupPath: ".agent-backups/1-Current.md",
                  insertedLinks: [],
                  skipped: [],
                  bytesWritten: 12,
                }
            : call.name === "web_fetch"
              ? {
                  title: "Fetched source",
                  url: call.arguments.url,
                  content: "Fetched content",
                  links: [],
                }
            : call.name === "create_design_canvas"
              ? {
                  path: "Designs/Product Flow.canvas",
                  operation: "create",
                  nodeCount: 2,
                  edgeCount: 1,
                  canvas: {
                    nodes: [{ id: "start" }, { id: "end" }],
                    edges: [{ id: "edge" }],
                  },
                }
            : call.name === "create_svg_design"
              ? {
                  path: "Designs/settings-wireframe.svg",
                  operation: "create",
                  shapeCount: 3,
                  svg: "<svg><rect/><text>Settings</text></svg>",
                }
              : { value: call.name, args: call.arguments },
      };
    },
  };
}

function responseWithToolCall(
  name: string,
  args: Record<string, unknown>,
  content = "Hidden tool preamble",
): ModelChatResponse {
  const toolCall = { name, arguments: args };
  return {
    message: {
      role: "assistant",
      content,
      toolCalls: [toolCall],
    },
    toolCalls: [toolCall],
  };
}

function responseWithToolCalls(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  content = "Hidden tool preamble",
): ModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      toolCalls: calls,
    },
    toolCalls: calls,
  };
}

function responseWithContent(
  content: string,
  thinking?: string,
  raw?: unknown,
): TestModelChatResponse {
  return {
    message: {
      role: "assistant",
      content,
      thinking,
    },
    toolCalls: [],
    raw,
  };
}

function responseWithContentDeltas(
  contentDeltas: string[],
  content = contentDeltas.join(""),
  thinkingDeltas: string[] = [],
  options: {
    streamError?: unknown;
    raw?: unknown;
  } = {},
): TestModelChatResponse {
  return {
    ...responseWithContent(content),
    contentDeltas,
    thinkingDeltas,
    raw: options.raw,
    streamError: options.streamError,
  };
}

function createCodeToolsRegistry(
  executedCalls: ModelToolCall[],
  executedContexts: ToolExecutionContext[] = [],
): ToolRegistry {
  const toolNames = [
    "read_current_file",
    "run_code_block",
    "install_code_dependency",
    "write_workspace_file",
  ];
  return {
    getDefinitions: () =>
      toolNames.map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object" as const, properties: {} },
        },
      })),
    execute: async (call, context): Promise<ToolExecutionResult> => {
      executedCalls.push(call);
      executedContexts.push(context);
      if (call.name === "read_current_file") {
        return {
          ok: true,
          toolName: call.name,
          output: { path: "Current.md", content: "Initial note" },
        };
      }
      if (call.name === "run_code_block") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            language: "python",
            operation: "run",
            result: { exitCode: 0, stdout: "ok", stderr: "", timedOut: false },
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: { ok: true, toolName: call.name },
      };
    },
  };
}

test("accepted web research runs auto-save durable research memory", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
  const executedCalls: ModelToolCall[] = [];
  const prompt =
    "Search the web for the Ollama structured outputs documentation and summarize it.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  const registry: ToolRegistry = {
    getDefinitions: () =>
      ["read_current_file", "web_search", "web_fetch", "append_research_memory"].map(
        (name) => ({
          type: "function" as const,
          function: {
            name,
            parameters: { type: "object" as const, properties: {} },
          },
        }),
      ),
    execute: async (call): Promise<ToolExecutionResult> => {
      executedCalls.push(call);
      if (call.name === "web_search") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            results: [
              {
                title: "Router roundup",
                url: "https://example.com/routers",
                snippet: "Local LLM routers compared.",
              },
            ],
          },
        };
      }
      if (call.name === "web_fetch") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            title: "Router roundup",
            url: "https://example.com/routers",
            content: "Detailed comparison of local LLM routers.",
            links: [],
          },
        };
      }
      if (call.name === "append_research_memory") {
        return {
          ok: true,
          toolName: call.name,
          output: {
            path: "Agent Research Memory/latest-local-llm-routers.md",
            operation: "create",
            topic: call.arguments.topic,
            bytesWritten: 256,
          },
        };
      }
      return {
        ok: true,
        toolName: call.name,
        output: { path: "Current.md", content: "Initial note" },
      };
    },
  };

  const finalAnswer =
    "Ollama structured outputs constrain responses to a JSON schema. Source: https://example.com/routers";
  const citedFinalAnswer = (request: ModelChatRequest) => {
    const passageId = getPassageCitationIds(request)[0];
    assert.ok(passageId, "fetched passage id must be visible to final synthesis");
    return responseWithContent(`${finalAnswer}\nPassage evidence: [${passageId}]`);
  };
  const client = createClient({
    chatRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/routers" }),
      citedFinalAnswer,
      citedFinalAnswer,
      citedFinalAnswer,
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const memoryCall = executedCalls.find(
    (call) => call.name === "append_research_memory",
  );
  assert.ok(memoryCall, "accepted research run must auto-save research memory");
  assert.ok(String(memoryCall.arguments.topic).length > 0);
  assert.match(String(memoryCall.arguments.text), /Mission:/);
  assert.match(String(memoryCall.arguments.text), /https:\/\/example\.com\/routers/);
  assert.deepEqual(memoryCall.arguments.sourceUrls, [
    "https://example.com/routers",
  ]);
  assert.ok(
    statuses.some((message) => /Saved research memory:/.test(message)),
    JSON.stringify(statuses),
  );
});

test("proof-sensitive streamed final holds the invalid draft and emits the exact sanitized correction", async () => {
  const prompt =
    "Search the web for Ollama structured outputs documentation and summarize it with citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Ollama structured outputs",
              url: "https://example.com/ollama-structured-outputs",
              snippet: "Ollama can constrain generated output with a JSON schema.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Ollama structured outputs",
          content:
            "Ollama structured outputs accept a JSON schema and constrain model responses to that schema.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  let correctedCandidate = "";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/ollama-structured-outputs",
        }),
      () => responseWithContent(""),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas(
          [
            "<|begin_of_sentence|>INVALID UNVERIFIED DRAFT: Ollama structured outputs constrain JSON, but this draft cites no bound passage.<|end_of_sentence|>",
          ],
          "RAW FIRST PROVIDER CONTENT MUST NOT LEAK",
        ),
      (request) => {
        const passageId = getPassageCitationIds(request)[0];
        assert.ok(
          passageId,
          "the correction request must retain the fetched passage identifier",
        );
        correctedCandidate =
          "Ollama structured outputs constrain responses with a JSON schema. " +
          `Source: https://example.com/ollama-structured-outputs Passage evidence: [${passageId}]`;
        return responseWithContentDeltas(
          [
            `<|begin_of_sentence|>${correctedCandidate}<|end_of_sentence|>`,
          ],
          "RAW SECOND PROVIDER CONTENT MUST NOT LEAK",
        );
      },
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests.length, 2);
  assert.ok(
    [...chatRequests, ...streamRequests].some((request) =>
      request.messages.some((message) =>
        /draft failed final-output verification/i.test(message.content),
      ),
    ),
    "the second candidate must be prompted by the proof correction gate",
  );
  assert.ok(
    statuses.some((message) => /(?:Draft|Writeback draft) held for verification/.test(message)),
    JSON.stringify(statuses),
  );
  assert.equal(finalDeltas.join(""), correctedCandidate);
  assert.equal(assistantDeltas.join(""), correctedCandidate);
  assert.doesNotMatch(finalDeltas.join(""), /INVALID UNVERIFIED DRAFT/);
  assert.doesNotMatch(finalDeltas.join(""), /RAW (?:FIRST|SECOND) PROVIDER/);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "write_completed");
});

test("repeated proof-sensitive candidate failures emit only a resumable blocker", async () => {
  const prompt =
    "Search the web for Ollama structured outputs documentation and summarize it with citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const assistantDeltas: string[] = [];
  const completions: AgentRunCompleteEvent[] = [];
  const vault = createRunnerVaultContext({ prompt });
  vault.context.settings.researchMemoryEnabled = false;
  vault.context.settings.maxAgentSteps = 4;
  vault.context.httpTransport = async (request) => {
    if (request.url.endsWith("/web_search")) {
      return {
        status: 200,
        headers: {},
        json: {
          results: [
            {
              title: "Ollama structured outputs",
              url: "https://example.com/ollama-structured-outputs",
              snippet: "Ollama can constrain generated output with a JSON schema.",
            },
          ],
        },
      };
    }
    if (request.url.endsWith("/web_fetch")) {
      return {
        status: 200,
        headers: {},
        json: {
          title: "Ollama structured outputs",
          content:
            "Ollama structured outputs accept a JSON schema and constrain model responses to that schema.",
          links: [],
        },
      };
    }
    throw new Error(`Unexpected request: ${request.url}`);
  };

  const invalidCandidate =
    "INVALID UNVERIFIED DRAFT: Ollama structured outputs constrain JSON without citing the bound passage.";
  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "Ollama structured outputs documentation",
        }),
      () =>
        responseWithToolCall("web_fetch", {
          url: "https://example.com/ollama-structured-outputs",
        }),
      () => responseWithContent(""),
      () => responseWithContent(""),
    ],
    streamResponders: [
      () => responseWithContentDeltas([invalidCandidate]),
      () =>
        responseWithContentDeltas(
          [`${invalidCandidate} This second attempt is still uncited.`],
          "RAW REPEATED FAILURE MUST NOT LEAK",
        ),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createCollectingRegistry(executedCalls),
    toolContext: vault.context,
    enableStreaming: true,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
      onRunComplete: (event) => completions.push(event),
    },
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests.length, 2);
  assert.doesNotMatch(assistantDeltas.join(""), /INVALID UNVERIFIED DRAFT/);
  assert.doesNotMatch(assistantDeltas.join(""), /RAW REPEATED FAILURE/);
  assert.match(
    assistantDeltas.join(""),
    /Note writeback was not applied because proof verification is incomplete/i,
  );
  assert.ok(
    statuses.some((message) =>
      /Note writeback was not applied because proof verification is incomplete/i.test(
        message,
      ),
    ),
    JSON.stringify(statuses),
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].stopReason, "budget");
});

test("policy engine requires approval before install_code_dependency executes", async () => {
  __setCodeToolsDesktopAppForTests(true);
  try {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const approvalRequests: ApprovalRequest[] = [];
    const resolvedDecisions: string[] = [];
    const broker = new ApprovalBroker();

    const client = createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("install_code_dependency", {
            manager: "pip",
            packageName: "requests",
          }),
        () => responseWithContent("Stopped: the dependency install was denied."),
        () => responseWithContent("Stopped: the dependency install was denied."),
        () => responseWithContent("Stopped: the dependency install was denied."),
      ],
    });

    await runAgentMission({
      prompt: "Run the python code snippet after installing the requests package.",
      modelClient: client,
      toolRegistry: createCodeToolsRegistry(executedCalls),
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
      approvalBroker: broker,
      events: {
        onApprovalRequest: (request) => {
          approvalRequests.push(request);
          broker.resolve(request.id, "denied");
        },
        onApprovalResolved: ({ decision }) => {
          resolvedDecisions.push(decision);
        },
      },
    });

    assert.equal(approvalRequests.length, 1);
    assert.equal(approvalRequests[0].toolName, "install_code_dependency");
    assert.ok(approvalRequests[0].policyTags.includes("dependency_install"));
    assert.deepEqual(resolvedDecisions, ["denied"]);
    assert.ok(
      !executedCalls.some((call) => call.name === "install_code_dependency"),
      "denied install must never reach the tool registry",
    );
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }
});

test("policy engine approval allows install_code_dependency with granted context", async () => {
  __setCodeToolsDesktopAppForTests(true);
  try {
    const chatRequests: ModelChatRequest[] = [];
    const executedCalls: ModelToolCall[] = [];
    const executedContexts: ToolExecutionContext[] = [];
    const broker = new ApprovalBroker();
    let requestCheckpointPersisted = false;
    let resolutionCheckpointPersisted = false;
    const baseRegistry = createCodeToolsRegistry(executedCalls, executedContexts);
    const orderedRegistry: ToolRegistry = {
      getDefinitions: () => baseRegistry.getDefinitions(),
      execute: async (call, context) => {
        if (call.name === "install_code_dependency") {
          assert.equal(requestCheckpointPersisted, true);
          assert.equal(resolutionCheckpointPersisted, true);
        }
        return baseRegistry.execute(call, context);
      },
    };

    const client = createClient({
      chatRequests,
      chatResponders: [
        () =>
          responseWithToolCall("install_code_dependency", {
            manager: "pip",
            packageName: "requests",
          }),
        () =>
          responseWithToolCall("run_code_block", {
            language: "python",
            code: "print('ok')",
          }),
        () => responseWithContent("Installed requests and ran the snippet."),
        () => responseWithContent("Installed requests and ran the snippet."),
      ],
    });

    await runAgentMission({
      prompt: "Run the python code snippet after installing the requests package.",
      modelClient: client,
      toolRegistry: orderedRegistry,
      toolContext: {} as ToolExecutionContext,
      enableStreaming: false,
      approvalBroker: broker,
      events: {
        onApprovalRequest: async (request) => {
          await Promise.resolve();
          requestCheckpointPersisted = true;
          broker.resolve(request.id, "approved");
        },
        onApprovalResolved: async () => {
          assert.equal(requestCheckpointPersisted, true);
          await Promise.resolve();
          resolutionCheckpointPersisted = true;
        },
      },
    });

    const installIndex = executedCalls.findIndex(
      (call) => call.name === "install_code_dependency",
    );
    assert.ok(installIndex >= 0, "approved install must execute");
    assert.equal(
      executedContexts[installIndex]?.userApprovalGranted,
      true,
      "approved install runs with approval-granted context",
    );
    assert.ok(executedCalls.some((call) => call.name === "run_code_block"));
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }
});

test("required prepared actions bind double approval before one external execution", async () => {
  const prompt = "Create a Linear issue titled Research follow-up.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  vault.context.settings.linearEnabled = true;
  const broker = new ApprovalBroker();
  const approvalRequests: ApprovalRequest[] = [];
  const receipts: AgentRunReceipt[] = [];
  let prepareCalls = 0;
  let legacyExecutions = 0;
  let preparedExecutions = 0;
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "linear_create_issue",
    capability: { system: "linear", resourceType: "issue", action: "create" },
    effect: "reversible_mutation",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "double_exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind: "external_action",
  };
  const tool: AgentTool = {
    name: descriptor.name,
    description: "Create one Linear issue.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    descriptor,
    execute: async () => {
      legacyExecutions += 1;
      return { bypassed: true };
    },
    prepare: async (args, context) => {
      prepareCalls += 1;
      return {
        ok: true,
        action: await withPreparedActionFingerprint({
          version: 1,
          id: "linear-action-1",
          runId: context.runId!,
          toolCallId: "linear-call-1",
          toolName: descriptor.name,
          target: {
            system: "linear",
            resourceType: "issue",
            id: "new:linear-call-1",
            teamId: "team-1",
          },
          relatedResources: [],
          normalizedArgs: { title: String(args.title ?? "") },
          preview: {
            summary: "Create Linear issue Research follow-up",
            destination: "Linear team team-1",
            outboundPayload: { title: String(args.title ?? "") },
            warnings: [],
            outboundBytes: 18,
          },
          idempotencyKey: `${context.runId}:linear-call-1`,
          preparedAt: "2026-07-11T12:00:00.000Z",
          expiresAt: "2026-07-11T12:05:00.000Z",
        }),
      };
    },
    executePrepared: async (action, context) => {
      preparedExecutions += 1;
      const authorized = context.authorizedAction!;
      return {
        mutationState: "applied",
        output: { identifier: "RES-123" },
        receipt: {
          version: 1,
          id: "linear-receipt-1",
          runId: action.runId,
          actionId: action.id,
          toolName: action.toolName,
          operation: "create",
          resource: {
            system: "linear",
            resourceType: "issue",
            id: "issue-123",
            identifier: "RES-123",
            teamId: "team-1",
          },
          message: "Created Linear issue RES-123",
          payloadFingerprint: action.payloadFingerprint,
          grantId: authorized.grantId,
          idempotencyKey: action.idempotencyKey,
          startedAt: "2026-07-11T12:00:01.000Z",
          committedAt: "2026-07-11T12:00:03.000Z",
          commitKind: "committed",
          readback: {
            status: "verified",
            checkedAt: "2026-07-11T12:00:02.000Z",
            observedRevision: "updated-at-1",
          },
          effects: { affectedCount: 1, changedFields: ["title"] },
        },
      };
    },
  };
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () =>
        responseWithToolCall("linear_create_issue", {
          title: "Research follow-up",
        }),
      () => responseWithContent("Created Linear issue RES-123."),
      () => responseWithContent("Created Linear issue RES-123."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: new DefaultToolRegistry([tool]),
    toolContext: vault.context,
    enableStreaming: false,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        approvalRequests.push(request);
        broker.resolve(request.id, "approved");
      },
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  assert.equal(prepareCalls, 1);
  assert.equal(legacyExecutions, 0);
  assert.equal(preparedExecutions, 1);
  assert.deepEqual(
    approvalRequests.map((request) => request.confirmationIndex),
    [1, 2],
  );
  assert.ok(
    approvalRequests.every(
      (request) =>
        request.requiredConfirmations === 2 &&
        request.payloadFingerprint ===
          approvalRequests[0].payloadFingerprint &&
        request.preparedAction?.id === "linear-action-1",
    ),
  );
  assert.equal(receipts[0]?.resource?.system, "linear");
  assert.equal(receipts[0]?.path, undefined);
  assert.match(receipts[0]?.grantId ?? "", /^grant:approval-/);
  const runtimeSnapshot = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) => snapshot?.operationJournal.some(
      (record) => record.toolName === "linear_create_issue",
    ));
  const actionRecord = runtimeSnapshot?.operationJournal.find(
    (record) => record.toolName === "linear_create_issue",
  );
  assert.equal(actionRecord?.version, 2);
  assert.equal(actionRecord?.state, "committed");
  assert.equal(
    actionRecord?.preparedAction?.payloadFingerprint,
    approvalRequests[0].payloadFingerprint,
  );
  assert.match(actionRecord?.authorization?.grantId ?? "", /^grant:approval-/);
  assert.equal(actionRecord?.receipt?.resource?.system, "linear");
});

test("optional legacy tools keep execution policy while descriptors drive WAL classification", async () => {
  const prompt = "Promote workspace item item-1.";
  const vault = createRunnerVaultContext({
    prompt,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  let executions = 0;
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "promote_workspace_item",
    capability: {
      system: "workspace",
      resourceType: "work_item",
      action: "promote",
    },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "optional",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "optional",
      reconciliation: "optional",
    },
    allowedPrincipals: ["single_agent"],
  };
  const registry = new DefaultToolRegistry([
    {
      name: descriptor.name,
      description: "Promote a workspace item.",
      parameters: { type: "object", properties: {} },
      descriptor,
      execute: async () => {
        executions += 1;
        return { status: "ok", id: "item-1", affectedCount: 1 };
      },
    },
  ]);
  const client = createClient({
    chatRequests: [],
    chatResponders: [
      () => responseWithToolCall(descriptor.name, {}),
      () => responseWithContent("Promoted workspace item item-1."),
    ],
  });

  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  assert.equal(executions, 1);
  const runtimeSnapshot = [...vault.content.values()]
    .map((markdown) => parseMissionRuntimeSnapshotFromMarkdown(markdown))
    .find((snapshot) => snapshot?.operationJournal.some(
      (record) => record.toolName === descriptor.name,
    ));
  const journal = runtimeSnapshot?.operationJournal.find(
    (record) => record.toolName === descriptor.name,
  );
  assert.equal(journal?.version, 2);
  assert.equal(journal?.state, "committed");
  assert.equal(journal?.descriptor?.capability.action, "promote");
  assert.equal(journal?.preparedAction, undefined);
  assert.equal(journal?.receipt?.resource?.system, "workspace");
});
