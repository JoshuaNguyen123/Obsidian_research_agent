import test from "node:test";
import assert from "node:assert/strict";

import { runAgentMission, type AgentTraceEvent } from "../src/AgentRunner";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { CRITIC_ALLOWED_TOOLS } from "../src/orchestrator/criticWorker";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";

/*
 * The independent critic on the plain single-agent path.
 *
 * The critic module has always carried a read-only registry with exactly the
 * tools needed to check a claim against its source, and an 8-step ceiling. Its
 * only call site sat behind an active orchestrator Lead *and* Specialist, a
 * second model client, and an unspent Specialist step -- so an ordinary
 * research mission got no model-driven self-critique at all.
 *
 * These pin what "reachable" has to mean: it runs, it is bounded, it is
 * offered only read-only tools, and it cannot change the mission's outcome.
 */

const VAULT_PROMPT =
  "Search my notes for concepts related to onboarding and tell me what I concluded.";

test("a plain research mission reaches one bounded, read-only critic pass", async () => {
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
  });
  vault.context.settings.agenticReflexEnabled = true;
  const traces: AgentTraceEvent[] = [];
  const criticRequests: ModelChatRequest[] = [];

  await runAgentMission({
    prompt: VAULT_PROMPT,
    modelClient: createModelClient({
      responses: [
        responseWithToolCall("semantic_search_notes", {
          query: "onboarding conclusions",
        }),
        responseWithToolCall("read_file", { path: "Research/Onboarding.md" }),
        responseWithContent("Activation, not signup, is the onboarding metric."),
      ],
      // The critic is the only turn seeded with an "independent critic" system
      // prompt, which is what lets this harness answer it separately.
      onCriticRequest: (request) => criticRequests.push(request),
      criticReply:
        'Reviewed. {"verdict":"needs_more_work","missing":["no date on the source note"],"summary":"Claim is supported but undated."}',
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onTrace: (trace) => traces.push(trace) },
  });

  const criticTrace = traces.find((trace) =>
    String(trace.id).startsWith("single-agent-critic-"),
  );
  assert.ok(
    criticTrace,
    `expected an advisory critic trace, saw: ${JSON.stringify(
      traces.map((trace) => trace.id).slice(0, 40),
    )}`,
  );
  assert.equal((criticTrace.outputPreview as { advisory?: boolean }).advisory, true);
  assert.deepEqual(
    (criticTrace.outputPreview as { missing?: string[] }).missing,
    ["no date on the source note"],
  );

  assert.equal(
    criticRequests.length,
    1,
    "the critic may spend at most one bounded pass per run",
  );
  // Structural independence: the critic is handed only the read-only subset,
  // never the write tools the mission itself was allowed.
  const offered = (criticRequests[0]?.tools ?? []).map(
    (definition) => definition.function.name,
  );
  assert.ok(offered.length > 0, "the critic must be able to open a source");
  for (const name of offered) {
    assert.ok(
      CRITIC_ALLOWED_TOOLS.has(name),
      `critic was offered a tool outside its read-only registry: ${name}`,
    );
  }
});

test("a critic verdict of needs_more_work does not fail the mission", async () => {
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
  });
  vault.context.settings.agenticReflexEnabled = true;
  const traces: AgentTraceEvent[] = [];
  let completionStopReason: string | undefined;

  await runAgentMission({
    prompt: VAULT_PROMPT,
    modelClient: createModelClient({
      responses: [
        responseWithToolCall("semantic_search_notes", {
          query: "onboarding conclusions",
        }),
        responseWithToolCall("read_file", { path: "Research/Onboarding.md" }),
        responseWithContent("Activation, not signup, is the onboarding metric."),
      ],
      criticReply:
        '{"verdict":"needs_more_work","missing":["everything"],"summary":"Reject."}',
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onTrace: (trace) => traces.push(trace),
      onRunComplete: (event) => {
        completionStopReason = event.stopReason;
      },
    },
  });

  assert.ok(
    traces.some((trace) => String(trace.id).startsWith("single-agent-critic-")),
    "the critic should have run",
  );
  assert.ok(
    completionStopReason === "final" ||
      completionStopReason === "write_completed",
    `acceptance must stay the sole gate; saw stopReason=${completionStopReason}`,
  );
});

test("the critic stays off when agentic reflex is disabled", async () => {
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
  });
  vault.context.settings.agenticReflexEnabled = false;
  const traces: AgentTraceEvent[] = [];
  let criticCalls = 0;

  await runAgentMission({
    prompt: VAULT_PROMPT,
    modelClient: createModelClient({
      responses: [
        responseWithToolCall("semantic_search_notes", {
          query: "onboarding conclusions",
        }),
        responseWithToolCall("read_file", { path: "Research/Onboarding.md" }),
        responseWithContent("Activation, not signup, is the onboarding metric."),
      ],
      onCriticRequest: () => {
        criticCalls += 1;
      },
      criticReply: '{"verdict":"pass","missing":[],"summary":"Fine."}',
    }),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onTrace: (trace) => traces.push(trace) },
  });

  assert.equal(criticCalls, 0);
  assert.equal(
    traces.filter((trace) => String(trace.id).startsWith("single-agent-critic-"))
      .length,
    0,
  );
});

/**
 * A model client that answers the mission turns from a fixed script and
 * answers the critic's isolated transcript separately, so the two cannot
 * consume each other's responses.
 */
function createModelClient(options: {
  responses: ModelChatResponse[];
  criticReply: string;
  onCriticRequest?: (request: ModelChatRequest) => void;
}): ModelClient {
  let index = 0;
  const isCriticRequest = (request: ModelChatRequest) =>
    request.messages.some(
      (message) =>
        message.role === "system" &&
        message.content.includes("independent critic"),
    );
  const answer = (request: ModelChatRequest): ModelChatResponse => {
    if (isCriticRequest(request)) {
      options.onCriticRequest?.(request);
      return responseWithContent(options.criticReply);
    }
    return options.responses[Math.min(index++, options.responses.length - 1)];
  };
  return {
    async chat(request) {
      return answer(request);
    },
    async streamChat(request, events: ModelChatStreamEvents = {}) {
      const response = answer(request);
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
}

function responseWithToolCall(
  name: string,
  args: Record<string, unknown>,
): ModelChatResponse {
  const toolCalls: ModelToolCall[] = [{ name, arguments: args }];
  return {
    message: { role: "assistant", content: "", toolCalls },
    toolCalls,
  };
}

function responseWithContent(content: string): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls: [] };
}

function createVaultHarness(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  let clock = Date.parse("2026-08-23T09:00:00.000Z");

  const createFile = (path: string) => {
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/u, ""),
      extension: name.includes(".") ? (name.split(".").pop() ?? "") : "",
      stat: { mtime: clock, ctime: clock, size: files.get(path)?.length ?? 0 },
    };
  };
  const getFile = (path: string) => (files.has(path) ? createFile(path) : null);
  const activeFile = createFile("Current.md");

  const app = {
    workspace: { getActiveFile: () => activeFile },
    vault: {
      getFiles: () => [...files.keys()].map(createFile),
      getAllLoadedFiles: () => [...files.keys()].map(createFile),
      getFileByPath: getFile,
      getFolderByPath: () => null,
      getAbstractFileByPath: getFile,
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      createFolder: async () => undefined,
      create: async (path: string, content: string) => {
        clock += 1;
        files.set(path, content);
        return createFile(path);
      },
      modify: async (file: { path: string }, content: string) => {
        clock += 1;
        files.set(file.path, content);
      },
    },
  };

  const context: ToolExecutionContext = {
    app: app as never,
    settings: createSettings(),
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
    getCurrentMarkdownContent: (file) => files.get(file.path) ?? null,
  };

  return { context, files };
}

function createSettings(): AgentSettings {
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
    maxAgentSteps: 12,
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
    agenticReflexEnabled: true,
    agenticReflexDiagnosticsEnabled: true,
    semanticSearchEnabled: true,
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
