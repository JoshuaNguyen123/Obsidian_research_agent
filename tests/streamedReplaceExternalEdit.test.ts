import test from "node:test";
import assert from "node:assert/strict";

import { runAgentMission } from "../src/AgentRunner";
import { ApprovalBroker } from "../src/agent/approvalBroker";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
} from "../src/model/types";

/*
 * A replacement approval is granted over one exact note state. If the reader
 * types while the card is up, executing that stale approval must not destroy
 * their bytes: either the execute refuses on the contentRevision precondition,
 * or the runner re-prepares over the edited note (fresh approval, fresh
 * backup that contains the edit). This pins the prepared-replace contract at
 * the approval window; the streamed writer's own first-flush gate is proven
 * separately against the live app.
 */

const SEED = "# Working note\n\nOriginal paragraph the user owns.\n";
const USER_EDIT_LINE = "TYPED-WHILE-COMPOSING keep me\n";
const MODEL_ANSWER =
  "# CRDT Overview\n\nConflict-free replicated data types merge concurrent updates deterministically, so replicas converge without coordination. GCounter and ORSet are the canonical examples used in collaborative editors.";

test("an edit made while the approval card is up is never destroyed by the stale approval", async () => {
  const vault = createVaultHarness();
  const statuses: string[] = [];

  // The rewrite mission requires the current note to be read before writing,
  // so the scripted model reads first, then answers.
  const responses: ModelChatResponse[] = [
    responseWithToolCall("read_current_file", {}),
    responseWithContent(MODEL_ANSWER),
  ];
  let responseIndex = 0;
  const nextResponse = () => responses[Math.min(responseIndex++, responses.length - 1)];
  const modelClient: ModelClient = {
    async chat() {
      return nextResponse();
    },
    async streamChat(_request, events: ModelChatStreamEvents = {}) {
      const response = nextResponse();
      if (!response.toolCalls?.length && response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
  const broker = new ApprovalBroker();
  let approvals = 0;
  await runAgentMission({
    prompt: "Rewrite the entire current note as a concise overview of CRDTs.",
    modelClient,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: { onApprovalRequest: (request) => {
      approvals += 1;
      if (approvals === 1) {
        // The reader types while the first approval card is up: after the
        // replacement was prepared and fingerprinted, before it executes.
        vault.files.set("Current.md", SEED + USER_EDIT_LINE);
      }
      broker.resolve(request.id, "approved");
    }, onStatus: (message) => statuses.push(message) },
  }).catch(() => {
    // The stopped stream may surface as a run error; the assertions below are
    // about what happened to the note and what the reader was told.
  });

  const note = vault.files.get("Current.md") ?? "";
  if (approvals <= 1) {
    // One approval was granted over the pre-edit note; executing it over the
    // edited note must be refused, keeping the reader's bytes.
    assert.ok(
      note.includes("TYPED-WHILE-COMPOSING"),
      `single-approval run overwrote the reader's edit; note: ${note.slice(0, 200)}
statuses: ${statuses.join(" | ")}`,
    );
    assert.ok(
      !note.includes("CRDT Overview"),
      `the replacement committed under a stale approval: ${note.slice(0, 200)}`,
    );
  } else {
    // The runner re-prepared over the edited note and the reader approved
    // again. The replacement may proceed then, but only with the edit
    // preserved in the backup the fresh preparation captured.
    const backups = [...vault.files.entries()].filter(([path]) => path !== "Current.md");
    assert.ok(
      backups.some(([, content]) => content.includes("TYPED-WHILE-COMPOSING")),
      `re-approved replacement lost the reader's edit; files: ${[...vault.files.keys()].join(", ")}
statuses: ${statuses.join(" | ")}`,
    );
  }
  assert.ok(
    statuses.some((message) => /changed after preparation|Stopped streamed writeback/u.test(message)) || approvals >= 2,
    `the stale approval was executed without any report; statuses: ${statuses.join(" | ")}`,
  );
});

function responseWithToolCall(
  name: string,
  args: Record<string, unknown>,
): ModelChatResponse {
  return {
    message: { role: "assistant", content: "Hidden tool preamble", toolCalls: [{ name, arguments: args }] },
    toolCalls: [{ name, arguments: args }],
  };
}

function responseWithContent(content: string): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls: [] };
}

function createVaultHarness() {
  const files = new Map<string, string>([["Current.md", SEED]]);
  const folders = new Set<string>();
  let clock = Date.parse("2026-08-24T09:00:00.000Z");

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
  const activeFile = createFile("Current.md");

  const app = {
    workspace: {
      getActiveFile: () => activeFile,
    },
    vault: {
      getName: () => "test-vault",
      getFileByPath: (path: string) =>
        files.has(path) ? createFile(path) : null,
      getAbstractFileByPath: (path: string) =>
        files.has(path) ? createFile(path) : null,
      getMarkdownFiles: () => [...files.keys()].map(createFile),
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      getFolderByPath: (path: string) => (folders.has(path) ? { path } : null),
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, content: string) => {
        clock += 1;
        files.set(path, content);
        return createFile(path);
      },
      rename: async (file: { path: string }, newPath: string) => {
        const value = files.get(file.path) ?? "";
        files.delete(file.path);
        files.set(newPath, value);
        file.path = newPath;
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
    httpTransport: async () => ({ status: 500, headers: {}, text: "not mocked" }),
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
    enableStreaming: true,
    requestTimeoutMs: 60_000,
    maxAgentSteps: 16,
    maxRunMinutes: null,
    thinkingMode: "off",
    streamWritebackMode: "all_current_note_content_writes",
    outputProfile: "active_or_new_note",
    autonomyProfile: "automatic",
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
  } as unknown as AgentSettings;
}

test("a conversational preamble above the H1 never reaches the committed note", async () => {
  const vault = createVaultHarness();
  const statuses: string[] = [];
  const preambled =
    "Sure, here is the rewritten note:" + String.fromCharCode(10, 10) + MODEL_ANSWER;
  const responses: ModelChatResponse[] = [
    responseWithToolCall("read_current_file", {}),
    responseWithContent(preambled),
  ];
  let responseIndex = 0;
  const nextResponse = () => responses[Math.min(responseIndex++, responses.length - 1)];
  const modelClient: ModelClient = {
    async chat() {
      return nextResponse();
    },
    async streamChat(_request, events: ModelChatStreamEvents = {}) {
      const response = nextResponse();
      if (!response.toolCalls?.length && response.message.content) {
        events.onContentDelta?.(response.message.content);
      }
      return response;
    },
  };
  const broker = new ApprovalBroker();
  await runAgentMission({
    prompt: "Rewrite the entire current note as a concise overview of CRDTs.",
    modelClient,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    approvalBroker: broker,
    events: {
      onApprovalRequest: (request) => {
        broker.resolve(request.id, "approved");
      },
      onStatus: (message) => statuses.push(message),
    },
  }).catch(() => {
    // Commit outcome is asserted on the vault below.
  });

  const note = vault.files.get("Current.md") ?? "";
  assert.ok(
    note.includes("CRDT Overview"),
    `the rewrite never committed; note: ${note.slice(0, 200)} statuses: ${statuses.join(" | ")}`,
  );
  assert.ok(
    !note.includes("here is the rewritten note"),
    `dialogue preamble leaked into the committed note: ${note.slice(0, 200)}`,
  );
  assert.ok(
    note.trimStart().startsWith("#"),
    `committed note does not open at the heading: ${note.slice(0, 120)}`,
  );
});
