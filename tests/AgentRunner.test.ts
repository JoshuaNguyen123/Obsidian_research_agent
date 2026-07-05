import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AGENT_STEPS,
  resolveThinkingMode,
  runAgentMission,
  sanitizeAssistantContent,
  type AgentRunConfigEvent,
  type AgentRunMetricEvent,
  type AgentRunReceipt,
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
import {
  BACKUP_FOLDER,
  MAX_INITIAL_CURRENT_NOTE_CHARS,
} from "../src/tools/constants";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";

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
      () => responseWithContent("Final WW2 answer", "thinking from final"),
    ],
  });

  await runAgentMission({
    prompt: "Search the web and give me an in depth analysis of WW2.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onAssistantDelta: (delta) => deltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_search"],
  );
  assert.deepEqual(
    executedCalls
      .filter((call) => call.name === "web_search")
      .map((call) => call.arguments.query),
    ["WW2 causes", "WW2 battles"],
  );
  assert.deepEqual(deltas, ["Final WW2 answer"]);
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

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () =>
        responseWithToolCall("web_search", {
          query: "The Grapes of Wrath Steinbeck sources",
        }),
      () => responseWithContent("Ready to write the cited essay."),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "Steinbeck's novel follows the Joad family under Depression-era pressure. ",
          "Source: https://example.com/grapes-of-wrath",
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
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  const firstStepToolNames =
    chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.deepEqual(firstStepToolNames, ["web_search", "web_fetch"]);
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
    ["read_current_file", "web_search"],
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
    `${notePrompt}\nSteinbeck's novel follows the Joad family under Depression-era pressure. Source: https://example.com/grapes-of-wrath`,
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

  const client = createClient({
    chatRequests,
    chatResponders: [() => responseWithContent("The note has 12 words.")],
  });

  await runAgentMission({
    prompt: "Count the words in the current note.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("count_words"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.ok(!toolNames.includes("replace_current_file"));
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
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "MCP servers" }),
      () => responseWithToolCall("web_fetch", { url: "https://example.com/mcp" }),
      () => responseWithContent("Cited answer with https://example.com/mcp"),
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
      () => responseWithContent("Ready to answer"),
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

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search"],
  );
  assert.equal(planningDeltas.length, 2);
  assert.ok(planningDeltas.every((delta) => delta.includes("route=grounded_workflow")));
  assert.ok(planningDeltas.every((delta) => delta.includes("tools=web_search, web_fetch")));
  assert.deepEqual(finalDeltas, ["Ready to answer"]);
  assert.deepEqual(assistantDeltas, ["Ready to answer"]);
  assert.ok(!assistantDeltas.join("").includes("Hidden tool preamble"));
  assert.deepEqual(toolStarts, ["web_search"]);
  assert.deepEqual(toolDone, ["web_search:true"]);
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
      () => responseWithContent(""),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "< | begin",
          "_of_sentence | ><|start_header",
          "_id|>assistant<|end_header",
          "_id|>\n\nMCP servers final answer<|end",
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

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search"],
  );
  assert.equal(finalDeltas.join(""), "assistant\n\nMCP servers final answer");
  assert.equal(assistantDeltas.join(""), "assistant\n\nMCP servers final answer");
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
      () => responseWithContent("Ready to answer"),
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

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 0);
  assert.deepEqual(finalDeltas, ["Ready to answer"]);
});

test("empty direct model content falls back to streamed final answer", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const finalDeltas: string[] = [];
  const assistantDeltas: string[] = [];

  const client = createClient({
    chatRequests,
    streamRequests,
    chatResponders: [
      () => responseWithToolCall("web_search", { query: "The Grapes of Wrath" }),
      () => responseWithContent("", "thinking without final prose"),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "Grounded Grapes ",
          "of Wrath final answer.",
        ]),
    ],
  });

  await runAgentMission({
    prompt: "Search the web for The Grapes of Wrath and summarize what you find.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: true,
    events: {
      onFinalDelta: (delta) => finalDeltas.push(delta),
      onAssistantDelta: (delta) => assistantDeltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
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
  assert.deepEqual(finalDeltas, ["Grounded Grapes ", "of Wrath final answer."]);
  assert.deepEqual(assistantDeltas, [
    "Grounded Grapes ",
    "of Wrath final answer.",
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

  assert.equal(chatRequests.length, 2);
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
      () => responseWithContent(""),
    ],
    streamResponders: [
      () => responseWithContentDeltas(["MCP servers ", "fallback answer."]),
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

  assert.equal(chatRequests.length, 2);
  assert.equal(streamRequests.length, 1);
  assert.equal(streamRequests[0].think, undefined);
  assert.deepEqual(finalDeltas, ["MCP servers ", "fallback answer."]);
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
      () => responseWithContent(""),
    ],
    streamResponders: [
      () => responseWithContent("MCP servers fallback answer."),
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

  assert.equal(metrics.filter((event) => event.kind === "model_chat").length, 2);
  assert.equal(metrics.some((event) => event.kind === "tool" && event.name === "web_search"), true);
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
      settings: createRunnerSettings(),
    } as ToolExecutionContext,
    enableStreaming: true,
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

test("retitle prompts expose retitle and suppress accidental append", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const statuses: string[] = [];
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
    prompt: "Update this note title around native Obsidian agentic research.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
    toolContext: {} as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
    },
  });

  const toolNames = chatRequests[0].tools?.map((tool) => tool.function.name) ?? [];
  assert.ok(toolNames.includes("retitle_current_file"));
  assert.ok(!toolNames.includes("append_to_current_file"));
  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["read_current_file", "retitle_current_file"],
  );
  assert.ok(statuses.includes("Retitling current note..."));
  assert.ok(statuses.includes("Updated note title in Current.md."));
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
  assert.equal(chatRequests.length, 6);
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
    configuredMax - 1,
  );
  assert.ok(statuses.includes("Stopped at safety limit. Review partial results."));
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
      () => responseWithContent("Cited answer with https://example.com/mcp"),
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
  assert.deepEqual(deltas, ["Cited answer with https://example.com/mcp"]);
});

test("low-cap sourced generated essay finalizes with note writeback", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const statuses: string[] = [];
  const finalDeltas: string[] = [];
  const vault = createRunnerVaultContext({
    prompt:
      "Write me a 1000 word essay on Grapes of Wrath. Use text level quotation and citations.",
    content: "Essay prompt",
  });
  vault.context.settings = createRunnerSettings({
    maxAgentSteps: 5,
    streamWritebackMode: "all_current_note_content_writes",
  });
  const essayDraft = [
    "The Grapes of Wrath argues for solidarity with cited textual evidence.",
    ...Array.from({ length: 920 }, (_, index) => `solidarity${index}`),
  ].join(" ");

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
      () => responseWithContentDeltas([essayDraft]),
    ],
  });

  await runAgentMission({
    prompt:
      "Write me a 1000 word essay on Grapes of Wrath. Use text level quotation and citations.",
    modelClient: client,
    toolRegistry: createRegistry(executedCalls),
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
  assert.deepEqual(finalDeltas, [essayDraft]);
  assert.equal(
    vault.content.get("Current.md"),
    `Essay prompt\n${essayDraft}`,
  );
});

test("explicit stream-to-page essay uses live writeback instead of append tool", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
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
          "# The Harvest of Injustice\n\n",
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
        responseWithToolCall("retitle_current_file", {
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
    ["read_current_file", "retitle_current_file"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("Current.md"),
    "# The Harvest of Injustice\n\nThe Grapes of Wrath presents survival as a collective duty.",
  );
});

test("citation writeback falls back to required web tools when model answers early", async () => {
  const prompt =
    "Write me a 300 word argumentative essay on Grapes of Wrath. Use text level quotation and citations.";
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const vault = createRunnerVaultContext({ prompt, content: "Prompt" });
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
              snippet: "Steinbeck source",
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
          title: "Fetched Grapes source",
          content: "Fetched page about The Grapes of Wrath.",
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
      () =>
        responseWithContent(
          "The Grapes of Wrath uses the Joads to argue for collective survival with cited evidence. " +
            "Steinbeck frames hardship as a public failure, not a private weakness. " +
            "The corrected draft keeps the source-backed claim while expanding the paragraph enough for the bounded correction pass.",
        ),
    ],
    streamResponders: [
      () =>
        responseWithContentDeltas([
          "The Grapes of Wrath uses the Joads to argue for collective survival with cited evidence.",
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
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests.length, 1);
  assert.match(vault.content.get("Current.md") ?? "", /collective survival/);
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

test("web append payload stays compact with capped note and source context", async () => {
  const chatRequests: ModelChatRequest[] = [];
  const streamRequests: ModelChatRequest[] = [];
  const executedCalls: ModelToolCall[] = [];
  const baseRegistry = createDefaultToolRegistry();
  const vault = createRunnerVaultContext({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    content: "n".repeat(12000),
  });

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
            content: "f".repeat(6000),
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
      () => responseWithContentDeltas(["MCP server research cited summary."]),
    ],
  });

  await runAgentMission({
    prompt: "Research MCP servers and append a concise cited summary to this note.",
    modelClient: client,
    toolRegistry: registry,
    toolContext: vault.context,
    enableStreaming: true,
  });

  assert.deepEqual(
    executedCalls.map((call) => call.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(streamRequests.length, 1);
  assert.equal(
    vault.content.get("Current.md"),
    `${"n".repeat(12000)}\nMCP server research cited summary.`,
  );
  const maxRequestChars = Math.max(
    ...[...chatRequests, ...streamRequests].map((request) =>
      JSON.stringify(request).length,
    ),
  );
  assert.ok(maxRequestChars < 30000, `request was ${maxRequestChars} chars`);
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
  const client = createClient({
    chatRequests,
    chatResponders: [
      () => {
        throw new ModelClientError("api", "thinking is unsupported by this model");
      },
      () => responseWithToolCall("web_search", { query: "MCP servers status" }),
      () => responseWithContent("Fallback answer"),
    ],
  });

  await runAgentMission({
    prompt: "Look up the current status of MCP servers.",
    modelClient: client,
    toolRegistry: createRegistry([]),
    toolContext: {
      settings: createRunnerSettings({ model: "gpt-oss:120b" }),
    } as ToolExecutionContext,
    enableStreaming: false,
    events: {
      onStatus: (message) => statuses.push(message),
      onAssistantDelta: (delta) => deltas.push(delta),
    },
  });

  assert.equal(chatRequests.length, 3);
  assert.equal(chatRequests[0].think, "medium");
  assert.equal(chatRequests[1].think, undefined);
  assert.equal(chatRequests[2].think, undefined);
  assert.ok(statuses.includes("Thinking unsupported; using standard loop."));
  assert.deepEqual(deltas, ["Fallback answer"]);
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
  assert.deepEqual(
    chatRequests[0].tools?.map((tool) => tool.function.name),
    ["read_current_file"],
  );
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
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.com/api",
    model: "gpt-oss:120b",
    enableStreaming: true,
    thinkingMode: "auto",
    streamWritebackMode: "all_current_note_content_writes",
    maxAgentSteps: MAX_AGENT_STEPS,
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

function createRunnerVaultContext(options: {
  prompt?: string;
  content?: string;
  now?: Date;
  model?: string;
  thinkingMode?: ThinkingMode;
  streamWritebackMode?: StreamWritebackMode;
  liveEditorWrite?: boolean;
} = {}) {
  const content = new Map<string, string>([
    ["Current.md", options.content ?? "Initial note"],
  ]);
  const folders = new Set<string>();
  const operations: string[] = [];
  const activeFile = {
    path: "Current.md",
    name: "Current.md",
    basename: "Current",
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
  return {
    getDefinitions: () => baseRegistry.getDefinitions(),
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
          name: "retitle_current_file",
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
