import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  runAgentMission,
  type AgentRunReceipt,
  type AgentTraceEvent,
} from "../src/AgentRunner";
import { hasExplicitSingleWebFetchOnlyIntent } from "../src/agent/evidenceIntent";
import { hasExplicitNoNoteWriteIntent } from "../src/agent/noNoteWriteIntent";
import type { AgentSettings } from "../src/settings";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { writeSourceCacheNote } from "../src/tools/sourceCache";
import type {
  ToolExecutionContext,
  ToolRegistry,
} from "../src/tools/types";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";

/**
 * Exact-fetch / cache-read / no-write follow-ups must fail closed.
 *
 * Live failure: a DU-02 cache follow-up replaced the research note with
 * `# Owned Source Cache Verification` after `append_to_current_file` was
 * rejected as `proof_gated_writeback_required`. Byte equality on a seeded
 * path is not enough — create, replace, rename, and a failed-append
 * writeback path must all leave the existing title and body untouched.
 */

const CACHED_SOURCE_URL = "https://primary.owned.example/evidence/marker";
const EXACT_CACHE_FOLLOWUP =
  `Call web_fetch once for the exact already-fetched URL ${CACHED_SOURCE_URL} with refresh=false. Verify the cached passage is readable, do not search, and do not write or edit any note.`;
/** Live DU-02 follow-up text; the e2e lane does not re-stamp the DU-02 marker. */
const DAILY_USE_FOLLOWUP = EXACT_CACHE_FOLLOWUP;
const SET_LOOSE_FOLLOWUP = `Set-loose research follow-up. ${EXACT_CACHE_FOLLOWUP}`;

const RESEARCH_NOTE_PATH = "Current.md";
const RESEARCH_NOTE_TITLE = "Current";
const RESEARCH_NOTE_HEADING = "Controlled Onboarding Validation";
const RESEARCH_NOTE_BODY = [
  `# ${RESEARCH_NOTE_HEADING}`,
  "",
  "Original research findings remain here.",
  "",
  "## Findings",
  "",
  "Controlled onboarding validation improved retention according to the primary owned source.",
  "",
  "## Limitations",
  "",
  "The two sources conflict.",
].join("\n");

const ILLEGAL_REPLACEMENT = [
  "# Owned Source Cache Verification",
  "",
  "The cached passage is readable. This heading must never replace the research note.",
].join("\n");

const NOTE_MUTATION_OPERATIONS = new Set([
  "append",
  "create",
  "replace",
  "rename",
  "overwrite",
  "edit",
  "retitle",
  "rename_current_file",
  "move",
]);

const WRITE_TOOL_NAMES = new Set([
  "append_to_current_file",
  "replace_current_file",
  "create_file",
  "rename_current_file",
  "retitle_current_file",
  "append_file",
  "replace_file",
]);

test("exact-fetch follow-ups classify as cache-read and no-write", () => {
  for (const prompt of [EXACT_CACHE_FOLLOWUP, DAILY_USE_FOLLOWUP, SET_LOOSE_FOLLOWUP]) {
    assert.equal(hasExplicitSingleWebFetchOnlyIntent(prompt), true, prompt);
    assert.equal(hasExplicitNoNoteWriteIntent(prompt), true, prompt);
  }
});

const ILLEGAL_WRITE_CASES: Array<{
  name: string;
  toolName: string;
  args: Record<string, unknown>;
}> = [
  {
    name: "append_to_current_file",
    toolName: "append_to_current_file",
    args: { text: ILLEGAL_REPLACEMENT },
  },
  {
    name: "replace_current_file",
    toolName: "replace_current_file",
    args: { text: ILLEGAL_REPLACEMENT },
  },
  {
    name: "create_file",
    toolName: "create_file",
    args: {
      path: "Owned Source Cache Verification.md",
      content: ILLEGAL_REPLACEMENT,
    },
  },
  {
    name: "rename_current_file",
    toolName: "rename_current_file",
    args: { title: "Owned Source Cache Verification" },
  },
];

for (const write of ILLEGAL_WRITE_CASES) {
  test(`daily-use exact-cache follow-up refuses ${write.name} and keeps the research note`, async () => {
    await assertNoWriteFollowup({
      prompt: DAILY_USE_FOLLOWUP,
      writes: [{ name: write.toolName, arguments: write.args }],
      finalContent: "Cached passage is readable; staying in chat.",
      enableStreaming: false,
    });
  });
}

test("daily-use exact-cache follow-up keeps the note after a failed append plus replacement draft", async () => {
  await assertNoWriteFollowup({
    prompt: DAILY_USE_FOLLOWUP,
    writes: [
      {
        name: "append_to_current_file",
        arguments: { text: ILLEGAL_REPLACEMENT },
      },
    ],
    finalContent: ILLEGAL_REPLACEMENT,
    enableStreaming: true,
  });
});

test("set-loose exact-cache follow-up keeps the note after a failed append plus replacement draft", async () => {
  await assertNoWriteFollowup({
    prompt: SET_LOOSE_FOLLOWUP,
    writes: [
      {
        name: "append_to_current_file",
        arguments: { text: ILLEGAL_REPLACEMENT },
      },
    ],
    finalContent: ILLEGAL_REPLACEMENT,
    enableStreaming: true,
  });
});

test("daily-use exact-cache follow-up does not host-write a streamed replacement draft", async () => {
  await assertNoWriteFollowup({
    prompt: DAILY_USE_FOLLOWUP,
    writes: [],
    finalContent: ILLEGAL_REPLACEMENT,
    enableStreaming: true,
  });
});

async function assertNoWriteFollowup(input: {
  prompt: string;
  writes: Array<{ name: string; arguments: Record<string, unknown> }>;
  finalContent: string;
  enableStreaming: boolean;
}): Promise<void> {
  const vault = createVaultHarness({
    [RESEARCH_NOTE_PATH]: RESEARCH_NOTE_BODY,
  });
  await writeSourceCacheNote(vault.context, {
    url: CACHED_SOURCE_URL,
    title: "Owned alpha evidence",
    content:
      "Controlled onboarding validation improved retention and reduced errors in the primary evidence.",
  });
  vault.context.originalPrompt = input.prompt;
  const before = snapshotNoteIdentity(vault);
  const beforeUserNotes = snapshotUserNotes(vault.files);
  const executed: ModelToolCall[] = [];
  const receipts: AgentRunReceipt[] = [];
  const traces: AgentTraceEvent[] = [];
  const rejectionCodes: string[] = [];
  const requestedToolNames: string[] = [];

  await runAgentMission({
    prompt: input.prompt,
    modelClient: createHostileClient({
      writes: input.writes,
      finalContent: input.finalContent,
      requestedToolNames,
    }),
    toolRegistry: observeRegistry(createDefaultToolRegistry(), executed),
    toolContext: vault.context,
    enableStreaming: input.enableStreaming,
    maxSteps: 6,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
      onTrace: (event) => {
        traces.push(event);
        if (event.error?.code) rejectionCodes.push(event.error.code);
      },
    },
  });

  const after = snapshotNoteIdentity(vault);
  const debug = {
    prompt: input.prompt,
    requested: requestedToolNames,
    executed: executed.map((call) => call.name),
    receipts: receipts.map((receipt) => ({
      toolName: receipt.toolName,
      operation: receipt.operation,
      path: receipt.path,
      toPath: receipt.toPath,
    })),
    rejectionCodes,
    before,
    after,
    userNotes: [...snapshotUserNotes(vault.files).keys()],
    traces: traces
      .filter((event) => event.error || /write|append|replace|create|rename/iu.test(event.message ?? ""))
      .map((event) => ({
        kind: event.kind,
        toolName: event.toolName,
        message: event.message,
        code: event.error?.code ?? null,
      })),
  };

  assert.equal(after.path, before.path, JSON.stringify(debug));
  assert.equal(after.title, before.title, JSON.stringify(debug));
  assert.equal(after.heading, before.heading, JSON.stringify(debug));
  assert.equal(after.content, before.content, JSON.stringify(debug));
  assert.equal(after.fingerprint, before.fingerprint, JSON.stringify(debug));
  assert.equal(vault.files.get(RESEARCH_NOTE_PATH), RESEARCH_NOTE_BODY, JSON.stringify(debug));
  assert.doesNotMatch(
    after.content,
    /Owned Source Cache Verification/u,
    JSON.stringify(debug),
  );

  const createdUserNotes = [...snapshotUserNotes(vault.files).keys()].filter(
    (path) => !beforeUserNotes.has(path),
  );
  assert.deepEqual(createdUserNotes, [], JSON.stringify(debug));

  const mutationReceipts = receipts.filter((receipt) =>
    NOTE_MUTATION_OPERATIONS.has(receipt.operation),
  );
  assert.deepEqual(mutationReceipts, [], JSON.stringify(debug));

  const successfulWriteExecutions = executed.filter((call) =>
    WRITE_TOOL_NAMES.has(call.name),
  );
  // The model may *request* a write; the host must refuse it before vault
  // mutation. A recorded execute/executePrepared of a write tool on this
  // classified follow-up is a successful illegal write.
  assert.deepEqual(successfulWriteExecutions, [], JSON.stringify(debug));

  for (const write of input.writes) {
    assert.ok(
      requestedToolNames.includes(write.name),
      `hostile model must request ${write.name} so the host gate is exercised: ${JSON.stringify(debug)}`,
    );
    const refused =
      traces.some(
        (event) =>
          event.toolName === write.name &&
          (event.kind === "tool_rejected" ||
            event.error?.code === "proof_gated_writeback_required" ||
            event.error?.code === "tool_not_allowed" ||
            event.error?.code === "unknown_tool"),
      ) ||
      rejectionCodes.includes("proof_gated_writeback_required") ||
      rejectionCodes.includes("tool_not_allowed") ||
      traces.some((event) =>
        /Rejected unavailable tool|not available for this prompt|off-frontier/iu.test(
          event.message ?? "",
        ),
      );
    assert.ok(
      refused,
      `host must refuse ${write.name} fail-closed: ${JSON.stringify(debug)}`,
    );
  }

  if (rejectionCodes.includes("proof_gated_writeback_required")) {
    assert.equal(
      after.fingerprint,
      before.fingerprint,
      `proof_gated_writeback_required must fail closed without replacing the note: ${JSON.stringify(debug)}`,
    );
  }
}

function snapshotNoteIdentity(vault: ReturnType<typeof createVaultHarness>): {
  path: string;
  title: string;
  heading: string | null;
  content: string;
  fingerprint: string;
} {
  const active = vault.context.getCurrentMarkdownFile?.() ?? {
    path: RESEARCH_NOTE_PATH,
    basename: RESEARCH_NOTE_TITLE,
  };
  const content = vault.files.get(active.path) ?? "";
  const headingMatch = /^[ \t]{0,3}#(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/mu.exec(content);
  return {
    path: active.path,
    title: active.basename,
    heading: headingMatch?.[1]?.trim() ?? null,
    content,
    fingerprint: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
  };
}

function snapshotUserNotes(files: Map<string, string>): Map<string, string> {
  return new Map(
    [...files.entries()].filter(([path]) => !isOperationalVaultPath(path)),
  );
}

function isOperationalVaultPath(path: string): boolean {
  return (
    path.startsWith("Agent Runs/") ||
    path.startsWith("Agent Sources/") ||
    path.startsWith("Agent Research Memory/") ||
    path.startsWith("Agent Memory/") ||
    path.startsWith(".agent-backups/")
  );
}

function createHostileClient(input: {
  writes: Array<{ name: string; arguments: Record<string, unknown> }>;
  finalContent: string;
  requestedToolNames: string[];
}): ModelClient {
  let fetched = false;
  let writeIndex = 0;
  const next = (request: ModelChatRequest): ModelChatResponse => {
    if (isStructuredPlanningRequest(request)) {
      return responseWithContent(
        JSON.stringify({
          mode: "web_research",
          writeScope: "none",
          needsWebEvidence: true,
          needsVaultContext: false,
          needsCodeExecution: false,
          wordTarget: null,
          confidence: 1,
          rationale: "Exact cache fetch only; no note write.",
          nodes: [],
        }),
      );
    }
    const offered = new Set(
      (request.tools ?? []).map((tool) => tool.function.name),
    );
    // Request the illegal write first so a chat-only finish after cache
    // fetch cannot skip the host gate.
    if (writeIndex < input.writes.length) {
      const write = input.writes[writeIndex]!;
      writeIndex += 1;
      input.requestedToolNames.push(write.name);
      return responseWithToolCall(write.name, write.arguments);
    }
    if (!fetched && offered.has("web_fetch")) {
      fetched = true;
      input.requestedToolNames.push("web_fetch");
      return responseWithToolCall("web_fetch", {
        url: CACHED_SOURCE_URL,
        refresh: false,
      });
    }
    return responseWithContent(input.finalContent);
  };
  return {
    async chat(request) {
      return next(request);
    },
    async streamChat(request, events: ModelChatStreamEvents = {}) {
      const response = next(request);
      if (response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
}

function isStructuredPlanningRequest(request: ModelChatRequest): boolean {
  if (
    request.evidencePhase === "router" ||
    request.evidencePhase === "retry" ||
    request.evidencePhase === "graph_planner"
  ) {
    return true;
  }
  const required = request.format?.required;
  return (
    Array.isArray(required) &&
    (required.includes("writeScope") || required.includes("nodes"))
  );
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

function observeRegistry(
  registry: ToolRegistry,
  executed: ModelToolCall[],
): ToolRegistry {
  const prepare = registry.prepare?.bind(registry);
  const executePrepared = registry.executePrepared?.bind(registry);
  const getDescriptor = registry.getDescriptor?.bind(registry);
  return {
    getDefinitions: () => registry.getDefinitions(),
    getDescriptor: getDescriptor
      ? (toolName) => getDescriptor(toolName)
      : undefined,
    prepare: prepare ? (call, context) => prepare(call, context) : undefined,
    executePrepared: executePrepared
      ? async (action, context, authorization) => {
          executed.push({
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
      executed.push(call);
      return registry.execute(call, context);
    },
  };
}

function createVaultHarness(seed: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed));
  const folders = new Set<string>();
  let clock = Date.parse("2026-09-02T18:00:00.000Z");
  const mtimes = new Map<string, number>(
    [...files.keys()].map((path) => [path, clock]),
  );
  let activeFile = createFile(RESEARCH_NOTE_PATH);

  function createFile(path: string) {
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/u, ""),
      extension: name.includes(".")
        ? name.split(".").pop()?.toLowerCase() ?? ""
        : "",
      stat: {
        mtime: mtimes.get(path) ?? clock,
        ctime: mtimes.get(path) ?? clock,
        size: files.get(path)?.length ?? 0,
      },
    };
  }

  function getFile(path: string) {
    return files.has(path) ? createFile(path) : null;
  }

  function getFolder(path: string) {
    return folders.has(path)
      ? { path, name: path.split("/").pop() ?? path, children: [] }
      : null;
  }

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      getFiles: () => [...files.keys()].map(createFile),
      getAllLoadedFiles: () =>
        [
          ...[...folders].map((path) => getFolder(path)),
          ...[...files.keys()].map(createFile),
        ].filter(Boolean),
      getFileByPath: getFile,
      getFolderByPath: getFolder,
      getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, content: string) => {
        clock += 1;
        files.set(path, content);
        mtimes.set(path, clock);
        return createFile(path);
      },
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, content: string) => {
        clock += 1;
        files.set(file.path, content);
        mtimes.set(file.path, clock);
      },
      rename: async (file: { path: string }, toPath: string) => {
        const content = files.get(file.path);
        if (content === undefined) {
          throw new Error(`Path not found: ${file.path}`);
        }
        clock += 1;
        files.delete(file.path);
        mtimes.delete(file.path);
        files.set(toPath, content);
        mtimes.set(toPath, clock);
        if (activeFile.path === file.path) {
          activeFile = createFile(toPath);
        }
      },
    },
  };

  const context: ToolExecutionContext = {
    app: app as never,
    settings: createSettings(),
    originalPrompt: EXACT_CACHE_FOLLOWUP,
    httpTransport: async (request) => {
      if (String(request.url).endsWith("/web_fetch")) {
        return {
          status: 200,
          headers: {},
          json: {
            title: "Owned alpha evidence",
            url: CACHED_SOURCE_URL,
            content:
              "Controlled onboarding validation improved retention and reduced errors in the primary evidence.",
            links: [],
          },
        };
      }
      return {
        status: 500,
        headers: {},
        text: "not mocked",
      };
    },
    now: () => {
      clock += 1;
      return new Date(clock);
    },
    getCurrentMarkdownFile: () => activeFile as never,
    getCurrentMarkdownContent: (file) => files.get(file.path) ?? null,
  };

  return { context, files, folders };
}

function createSettings(): AgentSettings {
  return {
    settingsSchemaVersion: 2,
    workingMode: "automatic",
    autonomyProfile: "automatic",
    outputProfile: "active_or_new_note",
    modelProvider: "ollama",
    ollamaApiKey: "test-key",
    ollamaBaseUrl: "https://ollama.test/api",
    openAiCompatibleApiKey: "",
    openAiCompatibleBaseUrl: "https://openai.test/v1",
    model: "test-model",
    utilityModel: "",
    utilityModelProvider: "ollama",
    modelRouterEnabled: false,
    modelRouterMode: "off",
    enableStreaming: true,
    requestTimeoutMs: 60_000,
    maxAgentSteps: 12,
    maxRunMinutes: null,
    thinkingMode: "off",
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: true,
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
    orchestratorEnabled: false,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    scheduledMissions: [],
  };
}
