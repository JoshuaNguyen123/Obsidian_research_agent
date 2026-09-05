import { processTestVaultFile } from "./helpers/atomicTestVault";
import test from "node:test";
import assert from "node:assert/strict";

import { runAgentMission, type AgentRunReceipt } from "../src/AgentRunner";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { LIVENESS_CAVEAT_HEADING } from "../src/agent/livenessRecheckPolicy";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
  ModelToolCall,
} from "../src/model/types";

/*
 * A 404'd citation has to reach the reader.
 *
 * The orchestrator worker has always appended a "Liveness caveats" block to its
 * handoff summary. The single-agent path -- the one an ordinary research
 * mission takes -- emitted the same finding to onStatus/onTrace only, so on a
 * normal run a dead citation sat in the finished note with the warning visible
 * nowhere but a sidebar the reader scrolls past once.
 */

const RESEARCH_PROMPT =
  "Research activation metrics on the web and append a short summary to the current note.";

const DEAD_SOURCE = "https://primary.example/gone";
const LIVE_SOURCE = "https://alternate.example/still-here";

/** The graph reserves a fetch node per required source, so both must be read. */
const RESEARCH_SCRIPT = [
  responseWithToolCall("web_search", { query: "activation metrics" }),
  responseWithToolCall("web_fetch", { url: DEAD_SOURCE }),
  responseWithToolCall("web_fetch", { url: LIVE_SOURCE }),
  responseWithToolCall("append_to_current_file", {
    text: "Activation, not signup, predicts retention across both studied cohorts.",
  }),
  responseWithContent(
    "Activation, not signup, predicts retention across both studied cohorts.",
  ),
];

function searchResults() {
  return {
    status: 200 as const,
    headers: {},
    json: {
      results: [
        {
          title: "Primary source on activation",
          url: DEAD_SOURCE,
          snippet:
            "Activation, not signup, is the metric that predicts retention in the studied cohort.",
        },
        {
          title: "Corroborating source on activation",
          url: LIVE_SOURCE,
          snippet:
            "An independent replication reports the same activation effect across two later cohorts.",
        },
      ],
    },
  };
}

function fetchedSource(body: string) {
  const requested = JSON.parse(body || "{}") as { url?: string };
  const url = requested.url === LIVE_SOURCE ? LIVE_SOURCE : DEAD_SOURCE;
  return {
    status: 200 as const,
    headers: {},
    json: {
      title: url === LIVE_SOURCE ? "Corroborating source" : "Primary source",
      url,
      content:
        url === LIVE_SOURCE
          ? "An independent replication followed nine thousand accounts and reported the same activation effect, with the per-cohort breakdown reproduced in full so the finding can be cited directly."
          : "Activation, not signup, is the metric that predicts retention. The cohort study followed twelve thousand accounts across two quarters and reported the effect at every tier, with enough concrete detail to cite directly.",
      links: [],
    },
  };
}

test("a dead citation is written into the note the reader keeps", async () => {
  const vault = createVaultHarness({ "Current.md": "# Working note\n" });
  const receipts: AgentRunReceipt[] = [];
  const probeRequests: Array<{ url: string; method: string }> = [];
  vault.context.httpTransport = async (request) => {
    const url = String(request.url);
    if (url.endsWith("/web_search")) return searchResults();
    if (url.endsWith("/web_fetch")) {
      return fetchedSource(String(request.body ?? "{}"));
    }
    // Anything else is the liveness probe against a cited page itself. Only the
    // primary source has 404'd since it was fetched.
    probeRequests.push({ url, method: String(request.method ?? "GET") });
    return { status: url.startsWith(DEAD_SOURCE) ? 404 : 200, headers: {} };
  };

  await runAgentMission({
    prompt: RESEARCH_PROMPT,
    modelClient: createModelClient(RESEARCH_SCRIPT),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {
      onReceipt: (receipt) => receipts.push(receipt),
    },
  });

  const note = vault.files.get("Current.md") ?? "";
  assert.ok(
    probeRequests.length > 0,
    "the cited source should have been re-probed",
  );
  assert.ok(
    note.includes(LIVENESS_CAVEAT_HEADING),
    `the caveat must land in the note, not only the sidebar:\n${note}`,
  );
  assert.ok(note.includes(DEAD_SOURCE), note);
  // The original body survives: a dead link is a caveat for the reader, never
  // grounds to retract verified work.
  assert.ok(note.startsWith("# Working note"), note);

  const caveatReceipt = receipts.find(
    (receipt) =>
      (receipt.output as { livenessCaveat?: boolean } | undefined)
        ?.livenessCaveat === true,
  );
  assert.ok(caveatReceipt, "the host append must return a receipt");
  assert.equal(caveatReceipt.operation, "append");
  assert.equal(caveatReceipt.path, "Current.md");
  assert.equal(caveatReceipt.readback?.status, "verified");
});

test("a healthy citation adds no caveat section", async () => {
  const vault = createVaultHarness({ "Current.md": "# Working note\n" });
  vault.context.httpTransport = async (request) => {
    const url = String(request.url);
    if (url.endsWith("/web_search")) return searchResults();
    if (url.endsWith("/web_fetch")) {
      return fetchedSource(String(request.body ?? "{}"));
    }
    return { status: 200, headers: {} };
  };

  await runAgentMission({
    prompt: RESEARCH_PROMPT,
    modelClient: createModelClient(RESEARCH_SCRIPT),
    toolRegistry: createDefaultToolRegistry(),
    toolContext: vault.context,
    enableStreaming: false,
    events: {},
  });

  const note = vault.files.get("Current.md") ?? "";
  assert.ok(!note.includes(LIVENESS_CAVEAT_HEADING), note);
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
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
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
    enableStreaming: false,
    requestTimeoutMs: 60_000,
    maxAgentSteps: 16,
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
