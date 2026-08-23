import test from "node:test";
import assert from "node:assert/strict";

import { runAgentMission, type AgentTraceEvent } from "../src/AgentRunner";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { AgentSettings } from "../src/settings";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../src/tools/types";
import type {
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";

/*
 * The vault retrieval gate, end to end through the real vault tools.
 *
 * Every earlier test of this behaviour was pure: `researchRetrievalGate` was
 * handed a surfaced list and a read list, and the semantic-degradation e2e lane
 * calls the tool directly rather than through the runner. Both stayed green
 * while the wiring between them was inert -- the runner sourced its "already
 * read" set from mission evidence, and a vault search stamps its own top hit
 * onto the evidence record it produces. The search paid the debt it had just
 * created, and the highest-scoring note was treated as read without ever being
 * opened.
 *
 * These drive the loop the product actually runs: a real `semantic_search_notes`
 * with no embedding provider configured (which is exactly the degraded case),
 * the real follow-up host, and the real pre-write permit.
 */

// Conceptual vault vocabulary ("concepts related to") is what puts
// `semantic_search_notes` on the frontier, and the citation vocabulary is what
// makes the write proof-gated. Both are load-bearing for this suite.
const VAULT_RESEARCH_PROMPT =
  "Search my notes for concepts related to onboarding and append a cited answer with passage citations to the current note.";

test("a degraded vault search is corroborated by keyword search and its top hit is opened", async () => {
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
    "Research/Retention.md": "Retention follows activation within two weeks.",
    "Research/Pricing.md": "Pricing tiers were deferred to next quarter.",
  });
  const executed: ModelToolCall[] = [];
  const statuses: string[] = [];

  await runAgentMission({
    prompt: VAULT_RESEARCH_PROMPT,
    modelClient: createModelClient([
      responseWithToolCall("semantic_search_notes", {
        query: "onboarding conclusions",
      }),
      responseWithContent("Activation is the onboarding metric."),
    ]),
    toolRegistry: observeRegistry(createDefaultToolRegistry(), executed),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onStatus: (status) => statuses.push(status) },
  });

  // No embedding provider is configured, so the real tool falls back to keyword
  // matching. The user is told in one sentence what they actually got.
  assert.ok(
    statuses.some((status) => /keyword search/i.test(status)),
    `expected an honest fallback status, saw: ${JSON.stringify(statuses.slice(0, 12))}`,
  );

  const names = executed.map((call) => call.name);
  assert.ok(
    names.includes("semantic_search_notes"),
    "the model's own search should run",
  );
  // Scheduled by the host, not the model. The degraded search scored chunks
  // from a bounded slice of the vault and never matched the exact phrase, so
  // the same query goes to the full-vault keyword scan.
  assert.ok(
    names.includes("search_markdown_files"),
    `expected host keyword corroboration, saw: ${JSON.stringify(names)}`,
  );

  const readPaths = executed
    .filter((call) => call.name === "read_file")
    .map((call) => String(call.arguments.path));
  assert.ok(readPaths.length > 0, "the host should open what the search found");
  assert.ok(
    readPaths.includes("Research/Onboarding.md"),
    `the top-ranked hit must be opened, saw: ${JSON.stringify(readPaths)}`,
  );
});

test("the host never spends a follow-up the mission graph will refuse", async () => {
  // A prompt naming semantic retrieval gets an exact planned frontier:
  // `semantic_search_notes`, then `read_markdown_files` handed to the model as
  // its only legal next step. The graph is already enforcing the body read
  // there, so the host has no gap to fill -- but it used to schedule
  // `read_file` anyway, announce it as a follow-up, and have it refused as
  // `mission_graph_authority_blocked` after the call was already made.
  //
  // The host does not substitute a reader the graph is ready for either. That
  // was tried and reverted: taking `read_markdown_files` consumes the node the
  // model was meant to use, which is what
  // "explicit semantic retrieval uses the exact semantic then batch-read
  // frontier" in AgentRunner.test.ts pins.
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
    "Research/Retention.md": "Retention follows activation within two weeks.",
  });
  const traces: AgentTraceEvent[] = [];

  await runAgentMission({
    prompt:
      "Use semantic retrieval over my notes for concepts related to onboarding, batch-read only returned note paths, then append a grounded synthesis to the current note.",
    modelClient: createModelClient([
      responseWithToolCall("semantic_search_notes", {
        query: "onboarding conclusions",
      }),
      responseWithContent("Activation is the onboarding metric."),
    ]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onTrace: (trace) => traces.push(trace) },
  });

  const refusedFollowups = traces.filter(
    (trace) =>
      trace.error?.code === "mission_graph_authority_blocked" &&
      String(trace.id).includes(":auto-"),
  );
  assert.deepEqual(
    refusedFollowups.map((trace) => trace.toolName),
    [],
    "host follow-ups must be planned against the graph's ready frontier",
  );
});

test("a vault answer is held when the search's notes were never opened", async () => {
  // The reachable shape. The host's read follow-up names `read_file`; a
  // frontier that offers only the batch reader drops it, so nothing opens the
  // note, and the model answers from snippets. Before acceptance emitted
  // `vault_note_body_read` this walked straight through the write permit: the
  // token was synthesised at the permit and appended to a message, while the
  // branch condition read `evaluateCurrentAcceptance().missing`, which never
  // contained it.
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
  });
  const traces: AgentTraceEvent[] = [];

  await runAgentMission({
    prompt: VAULT_RESEARCH_PROMPT,
    modelClient: createModelClient([
      responseWithToolCall("semantic_search_notes", {
        query: "onboarding conclusions",
      }),
      responseWithToolCall("append_to_current_file", {
        text: "Activation is the onboarding metric.",
      }),
      responseWithContent("Activation is the onboarding metric."),
    ]),
    toolRegistry: withoutTools(createDefaultToolRegistry(), ["read_file"]),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onTrace: (trace) => traces.push(trace) },
  });

  const held = traces.filter((trace) =>
    /vault_note_body_read/u.test(
      `${trace.message ?? ""} ${JSON.stringify(trace.outputPreview ?? null)}`,
    ),
  );
  assert.ok(
    held.length > 0,
    `expected the vault body-read debt to hold the write, saw: ${JSON.stringify(
      traces.filter((t) => t.error).map((t) => t.error?.code),
    )}`,
  );
  assert.equal(
    vault.files.get("Current.md"),
    "# Working note",
    "the note must be untouched while the debt is unpaid",
  );
});

test("an unreadable surfaced note stops owing instead of stranding the mission", async () => {
  // Every surfaced note is tried and none opens. The debt must go quiet: a
  // requirement nothing can discharge is a stranded run, not a safeguard.
  const vault = createVaultHarness({
    "Current.md": "# Working note",
    "Research/Onboarding.md":
      "Activation, not signup, is the onboarding metric we settled on.",
  });
  const statuses: string[] = [];

  await runAgentMission({
    prompt: VAULT_RESEARCH_PROMPT,
    modelClient: createModelClient([
      responseWithToolCall("semantic_search_notes", {
        query: "onboarding conclusions",
      }),
      responseWithToolCall("read_file", { path: "Research/Onboarding.md" }),
      responseWithContent("Activation is the onboarding metric."),
    ]),
    toolRegistry: failReads(createDefaultToolRegistry()),
    toolContext: vault.context,
    enableStreaming: false,
    events: { onStatus: (status) => statuses.push(status) },
  });

  const bodyReadComplaints = statuses.filter((status) =>
    /vault_note_body_read/u.test(status),
  );
  assert.equal(
    bodyReadComplaints.length,
    0,
    `the debt must go quiet once every surfaced note was tried, saw: ${JSON.stringify(
      bodyReadComplaints.slice(0, 4),
    )}`,
  );
});

/**
 * `createDefaultToolRegistry()` returns a class instance, so its methods live
 * on the prototype. Spreading it silently drops `execute`, `getDescriptor` and
 * the prepared-action methods -- which reads as "toolRegistry.execute is not a
 * function" several layers away. Delegate explicitly instead.
 */
function wrapRegistry(
  registry: ToolRegistry,
  overrides: Partial<ToolRegistry> = {},
): ToolRegistry {
  const base: ToolRegistry = {
    getDefinitions: () => registry.getDefinitions(),
    execute: (call, context) => registry.execute(call, context),
    ...(registry.getDescriptor
      ? { getDescriptor: (name: string) => registry.getDescriptor?.(name) ?? null }
      : {}),
    ...(registry.prepare
      ? { prepare: (call, context) => registry.prepare!(call, context) }
      : {}),
    ...(registry.executePrepared
      ? {
          executePrepared: (action, context, authorization) =>
            registry.executePrepared!(action, context, authorization),
        }
      : {}),
    ...(registry.reconcile
      ? { reconcile: (action, context) => registry.reconcile!(action, context) }
      : {}),
  };
  return { ...base, ...overrides };
}

/** Wraps a registry so the test sees every call the runner actually made. */
function observeRegistry(
  registry: ToolRegistry,
  executed: ModelToolCall[],
): ToolRegistry {
  return wrapRegistry(registry, {
    execute: async (call, context) => {
      executed.push({ name: call.name, arguments: { ...call.arguments } });
      return registry.execute(call, context);
    },
  });
}

/** A frontier that simply does not offer some tools. */
function withoutTools(
  registry: ToolRegistry,
  dropped: readonly string[],
): ToolRegistry {
  return wrapRegistry(registry, {
    getDefinitions: () =>
      registry
        .getDefinitions()
        .filter((definition) => !dropped.includes(definition.function.name)),
  });
}

/** A vault whose notes are findable but not openable. */
function failReads(registry: ToolRegistry): ToolRegistry {
  return wrapRegistry(registry, {
    execute: async (call, context): Promise<ToolExecutionResult> => {
      if (call.name === "read_file" || call.name === "read_markdown_files") {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "execution_failed",
            message: "Markdown file not found.",
          },
        };
      }
      return registry.execute(call, context);
    },
  });
}

function createVaultHarness(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  let clock = Date.parse("2026-08-22T09:00:00.000Z");

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
    // Semantic search is on and no embedding provider is wired, which is
    // precisely the degraded configuration the user hits when FastEmbed is
    // missing: the settings say "semantic", the retrieval is keyword.
    settings: { ...createSettings(), semanticSearchEnabled: true },
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
    researchMemoryEnabled: true,
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

function createModelClient(responses: ModelChatResponse[]): ModelClient {
  let index = 0;
  const next = () => responses[Math.min(index++, responses.length - 1)];
  return {
    async chat() {
      return next();
    },
    async streamChat(_request, events: ModelChatStreamEvents = {}) {
      const response = next();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
