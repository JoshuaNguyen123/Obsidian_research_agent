import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";
import { runAgentMission, type AgentRunCompleteEvent, type AgentRunMetricEvent } from "../src/AgentRunner";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type { ModelChatRequest, ModelChatResponse, ModelChatStreamEvents, ModelClient } from "../src/model/types";
import { classifyUnproductiveModelResponseV1, UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1 } from "../src/model/degenerateStreamGuard";
import { isCutDeliberationV1, readsAsDeliberationLeadV1, settleCutDeliberationV1 } from "../src/model/cutDeliberation";

// Research Agent Platform ATR-15 comparison V5 (2026-10-26): a team Lead's first agent step spent its whole
// output limit on this, with no tool call and no closing tag, and the run never answered.
const CUT = "Let me analyze what's being asked here. The mission is to append a two-sentence summary to the current note. The system prompt says the note must keep its title, and the handoff lists the sources";

const reply = (content: string, doneReason?: string, toolCalls: ModelChatResponse["toolCalls"] = []): ModelChatResponse => ({
  message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) },
  toolCalls,
  ...(doneReason ? { doneReason } : {}),
});

test("a reply cut off at its length limit while deliberating is thinking, and reads as thinking_only", () => {
  for (const doneReason of ["length", "max_tokens", "model_length", "LENGTH"]) {
    const settled = settleCutDeliberationV1(reply(CUT, doneReason));
    assert.equal(settled.message.content, "", doneReason);
    assert.equal(settled.message.thinking, CUT);
    assert.equal(classifyUnproductiveModelResponseV1(settled)?.kind, "thinking_only");
  }
});

test("only a cut reply that opened as deliberation, with no tool call and no tag, is moved", () => {
  const essay = `# Breadth-first search

${"Breadth-first search visits every neighbour first. ".repeat(20)}`;
  const kept = reply(essay, "length");
  assert.equal(settleCutDeliberationV1(kept), kept, "an answer cut off at the limit keeps what it wrote");
  const finished = reply(CUT, "stop");
  assert.equal(settleCutDeliberationV1(finished), finished, "a reply that ended on its own is left as it came");
  const call = { name: "read_current_file", arguments: {} };
  const withTool = reply(CUT, "length", [call]);
  assert.equal(settleCutDeliberationV1(withTool), withTool, "a reply that called a tool did some work");
  const tagged = reply(`${CUT}</think>An answer.`, "length");
  assert.equal(isCutDeliberationV1(tagged), false, "a reasoning tag is another reader's to split");
  assert.equal(readsAsDeliberationLeadV1("Let me explain how BFS works."), false, "explaining is answering");
  assert.equal(readsAsDeliberationLeadV1("The user wants a short brief."), true);
});

test("a cut reply is left as it came when its content is the answer by another sign", () => {
  // The provider kept reasoning apart itself, so the content is what it answered.
  const thought: ModelChatResponse = { ...reply(CUT, "length"), message: { role: "assistant", content: CUT, thinking: "Planning the summary." } };
  assert.equal(settleCutDeliberationV1(thought), thought);
  // A tool call written as text is recovered from the content by the caller.
  const textCall = reply(`Let me analyze what to read first. <tool_call>{"name":"read_current_file","arguments":{}}</tool_call>`, "length");
  assert.equal(settleCutDeliberationV1(textCall), textCall);
  // Analyzing what was handed over opens an answer; analyzing the ask is deliberation.
  assert.equal(readsAsDeliberationLeadV1("Let me analyze the data for you: revenue rose 12% in the third quarter."), false);
  for (const lead of ["Let me analyze what's being asked here.", "Let me analyze the request.", "Okay, let me analyze this task."]) {
    assert.equal(readsAsDeliberationLeadV1(lead), true, lead);
  }
});

test("a run whose first step is cut off while deliberating goes on to do the work, and never sends it back as words", async () => {
  const appendCall = { name: "append_to_current_file", arguments: { text: "Activation predicts retention." } };
  const requests: ModelChatRequest[] = [];
  const responses = [reply(CUT, "length"), reply("", undefined, [appendCall]), reply("Activation predicts retention.")];
  let index = 0;
  const modelClient: ModelClient = {
    async chat(request) {
      requests.push(request);
      return responses[Math.min(index++, responses.length - 1)]!;
    },
    async streamChat(request, events: ModelChatStreamEvents = {}) {
      requests.push(request);
      const response = responses[Math.min(index++, responses.length - 1)]!;
      if (response.message.content) events.onContentDelta?.(response.message.content);
      return response;
    },
  };
  const harness = createRunHarness();
  const metrics: AgentRunMetricEvent[] = [];
  const traces: string[] = [];
  let complete: AgentRunCompleteEvent | undefined;
  await runAgentMission({
    prompt: "Append a two-sentence summary to the current note.",
    modelClient,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: harness.context,
    enableStreaming: false,
    events: {
      onMetric: (event) => metrics.push(event),
      onTrace: (event) => traces.push(event.id),
      onRunComplete: (event) => {
        complete = event;
      },
    },
  });
  assert.ok(traces.some((id) => id.startsWith("cut-deliberation-")), "the move is in the run's record");
  assert.equal(metrics.filter((event) => event.name === UNPRODUCTIVE_MODEL_RESPONSE_METRIC_NAME_V1).length, 1, "counted once as unproductive");
  assert.notEqual(complete?.stopReason, "error");
  assert.match(String(harness.files.get("Current.md")), /Activation predicts retention/u, "the work was done after it");
  for (const request of requests) {
    for (const message of request.messages) {
      if (message.role === "assistant") assert.equal(String(message.content ?? "").includes("Let me analyze"), false, "the deliberation went back as a reply's words");
    }
  }
});

// --- run harness (as in unproductiveModelResponse.test.ts) ------------------------------------------------------

const SEED_NOTE = "# Current\n\nSeed.\n";

function createRunHarness() {
  const files = new Map<string, string>([["Current.md", SEED_NOTE]]);
  let clock = Date.parse("2026-08-26T09:00:00.000Z");
  const createFile = (path: string) => ({
    path,
    name: path,
    basename: path.replace(/\.[^.]+$/u, ""),
    extension: "md",
    stat: { mtime: clock, ctime: clock, size: files.get(path)?.length ?? 0 },
  });
  const activeFile = createFile("Current.md");
  const app = {
    workspace: { getActiveFile: () => activeFile },
    vault: {
      getFiles: () => [...files.keys()].map(createFile),
      getAllLoadedFiles: () => [...files.keys()].map(createFile),
      getFileByPath: (path: string) =>
        files.has(path) ? createFile(path) : null,
      getFolderByPath: () => null,
      getAbstractFileByPath: (path: string) =>
        files.has(path) ? createFile(path) : null,
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      createFolder: async () => undefined,
      create: async (path: string, content: string) => {
        files.set(path, content);
        return createFile(path);
      },
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, content: string) => {
        files.set(file.path, content);
      },
    },
  };
  const context: ToolExecutionContext = {
    app: app as never,
    settings: createRunSettings(),
    originalPrompt: "",
    httpTransport: async () => ({
      status: 500,
      headers: {},
      text: "not mocked",
    }),
    now: () => {
      clock += 1;
      return new Date(clock);
    },
    getCurrentMarkdownFile: () => activeFile as never,
    getCurrentMarkdownContent: (file: { path: string }) =>
      files.get(file.path) ?? null,
  };
  return { context, files };
}

/** The observed failure's own step budget, so the early stop is visible. */
function createRunSettings(): AgentSettings {
  return {
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.test/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://openai.test/v1",
    model: "test-model",
    utilityModel: "",
    utilityModelProvider: "ollama",
    modelRouterEnabled: false,
    enableStreaming: false,
    requestTimeoutMs: 60_000,
    maxAgentSteps: 11,
    maxRunMinutes: null,
    thinkingMode: "off",
    streamWritebackMode: "off",
    templateFolder: "Templates",
    templateOutputFolder: "",
    researchMemoryEnabled: false,
    researchMemoryFolder: "Agent Research Memory",
    companionBaseUrl: "http://127.0.0.1:8765",
    browserToolsEnabled: false,
    experienceMemoryEnabled: false,
    defaultBrowserMissionMode: "supervised",
    agenticReflexEnabled: false,
    agenticReflexDiagnosticsEnabled: true,
    semanticSearchEnabled: false,
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: false,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3_000,
    semanticIndexMaxFiles: 1_000,
    semanticIndexPersistVectors: true,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    scheduledMissions: [],
  };
}
