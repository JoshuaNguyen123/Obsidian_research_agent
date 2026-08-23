import test from "node:test";
import assert from "node:assert/strict";

import { runAgentMission, type AgentRunReceipt } from "../src/AgentRunner";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
} from "../src/model/types";

/*
 * Research frontmatter on the main writeback path.
 *
 * `withResearchNoteFrontmatter` was real, tested, and called from exactly one
 * place — the research-template workflow. Every note the streamed writeback
 * created landed with no title, no date, no tags, no source count and no run
 * id, which in a graph-native app is a note you read once and then cannot find
 * again.
 *
 * The other half of the contract matters just as much: a note the user already
 * owns must never have YAML prepended to it. That is a destructive edit, not
 * an enhancement.
 */

const ANSWER =
  "# The Joad Family\n\nSteinbeck follows a tenant family driven west by dispossession, and the novel tracks what that migration costs them.";

/** The path the streamed writeback created, read off its own receipt. */
function streamedNotePath(receipts: readonly AgentRunReceipt[]): string | null {
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const output = receipts[index]?.output as
      | { streamed?: boolean; createdPath?: string }
      | undefined;
    if (output?.streamed === true && typeof output.createdPath === "string") {
      return output.createdPath;
    }
  }
  return null;
}

test("a note the run creates carries frontmatter the vault can index", async () => {
  const vault = createVaultHarness({ activeNote: false });
  const receipts: AgentRunReceipt[] = [];

  await runAgentMission({
    prompt: "Summarise the Joad family in The Grapes of Wrath.",
    modelClient: createModelClient([responseWithContent(ANSWER)]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: { onReceipt: (receipt) => receipts.push(receipt) },
  });

  const path = streamedNotePath(receipts);
  assert.ok(path, `no streamed note was created: ${[...vault.files.keys()]}`);
  const note = vault.files.get(path) ?? "";
  assert.ok(note.startsWith("---\n"), note.slice(0, 200));
  // The generated H1 becomes the note title rather than being duplicated in
  // the body, which is what makes the property useful in a graph view.
  assert.match(note, /^title: "?The Joad Family/mu);
  assert.match(note, /^created: "?\d{4}-\d{2}-\d{2}T/mu);
  assert.match(note, /^tags: \[research/mu);
  // Counted from real evidence records, so a run that retrieved nothing says
  // so rather than implying grounding it does not have.
  assert.match(note, /^sources: 0$/mu);
  assert.match(note, /^agent-run-id: "?run-/mu);
  // Exactly one block: Obsidian reads only the first, and a second would render
  // as a stray horizontal rule in the middle of the note.
  assert.equal((note.match(/^---$/gmu) ?? []).length, 2);
  assert.match(note, /Steinbeck follows a tenant family/u);
});

test("a note the user already owns is never given frontmatter", async () => {
  // Prepending YAML to someone's existing note is a destructive edit, which is
  // why the append/replace/edit kinds are excluded rather than unhandled.
  const vault = createVaultHarness({ activeNote: true });

  await runAgentMission({
    prompt: "Summarise the Joad family in The Grapes of Wrath on this page.",
    modelClient: createModelClient([responseWithContent(ANSWER)]),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: true,
    events: {},
  });

  const note = vault.files.get("Current.md") ?? "";
  assert.match(note, /Steinbeck follows a tenant family/u);
  assert.ok(note.startsWith("# Working note"), note.slice(0, 200));
  assert.ok(!note.includes("agent-run-id:"), note.slice(0, 400));
});

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

function responseWithContent(content: string): ModelChatResponse {
  return { message: { role: "assistant", content }, toolCalls: [] };
}

function createVaultHarness(options: { activeNote: boolean }) {
  const files = new Map<string, string>([["Current.md", "# Working note\n"]]);
  const folders = new Set<string>();
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
  const activeFile = options.activeNote ? createFile("Current.md") : null;

  const rename = async (file: { path: string }, newPath: string) => {
    const value = files.get(file.path) ?? "";
    files.delete(file.path);
    files.set(newPath, value);
    file.path = newPath;
  };

  const app = {
    workspace: { getActiveFile: () => activeFile },
    fileManager: {
      getNewFileParent: () => ({ path: "" }),
      renameFile: rename,
    },
    vault: {
      getFiles: () => [...files.keys()].map(createFile),
      getAllLoadedFiles: () => [...files.keys()].map(createFile),
      getFileByPath: getFile,
      getFolderByPath: (path: string) =>
        folders.has(path) ? { path, name: path } : null,
      getAbstractFileByPath: (path: string) =>
        getFile(path) ?? (folders.has(path) ? { path, name: path } : null),
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, content: string) => {
        clock += 1;
        files.set(path, content);
        return createFile(path);
      },
      rename,
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
