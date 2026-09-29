import { processTestVaultFile } from "./helpers/atomicTestVault";
import test from "node:test";
import assert from "node:assert/strict";

import { runAgentMission, type AgentTraceEvent } from "../src/AgentRunner";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { AgentSettings } from "../src/settings";
import type { ToolExecutionContext } from "../src/tools/types";
import type {
  HttpRequest,
  HttpResponse,
  ModelChatRequest,
  ModelChatResponse,
  ModelChatStreamEvents,
  ModelClient,
} from "../src/model/types";
import { DECISION_EVIDENCE_CLAUSES_V1 } from "../src/decisions/missionDecisionAssessment";

/*
 * The Jev mission assessment inside a real run: what reaches the decision
 * endpoint, what reaches the model, and what never changes.
 */

const PARAPHRASE =
  "Write a short note on why the Roman Empire fell, and back every claim up with what's out there.";

type Scripted = Record<string, unknown>;

function jevAnswers(overrides: Scripted = {}): Scripted {
  return {
    route: {
      type: "choice",
      choice: "web_research",
      confidence: 0.9,
      probabilities: { web_research: 0.9, vault_write: 0.1 },
    },
    web_evidence: { type: "noul", noul: 0.96 },
    vault_evidence: { type: "noul", noul: 0.02 },
    research_mode: {
      type: "choice",
      choice: "deep_web",
      confidence: 0.9,
      probabilities: { deep_web: 0.9, none: 0.1 },
    },
    effort_tier: {
      type: "choice",
      choice: "standard",
      confidence: 0.8,
      probabilities: { standard: 0.8, quick: 0.2 },
    },
    risk: { type: "choice", choice: "low", confidence: 0.9, probabilities: { low: 0.9, medium: 0.1 } },
    freshness: {
      type: "choice",
      choice: "helpful",
      confidence: 0.8,
      probabilities: { helpful: 0.8, none: 0.2 },
    },
    ...overrides,
  };
}

interface Harness {
  context: ToolExecutionContext;
  decisionRequests: Array<{ body: Record<string, unknown> }>;
  modelRequests: ModelChatRequest[];
  traces: AgentTraceEvent[];
}

function harness(options: {
  settings?: Partial<AgentSettings> & Record<string, unknown>;
  decisionResponse?: (body: Record<string, unknown>) => HttpResponse;
}): Harness {
  const decisionRequests: Harness["decisionRequests"] = [];
  const files = new Map<string, string>([["Current.md", "# Working note\n"]]);
  let clock = Date.parse("2026-09-28T09:00:00.000Z");
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
    fileManager: { getNewFileParent: () => ({ path: "" }), renameFile: async () => undefined },
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
  const httpTransport = async (request: HttpRequest): Promise<HttpResponse> => {
    if (request.url.includes("/decisions")) {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      decisionRequests.push({ body });
      return (
        options.decisionResponse?.(body) ?? {
          status: 200,
          headers: {},
          json: {
            id: "gen-dec-test",
            model: "typesafe/jev-1.13-20260917",
            answers: jevAnswers(),
            usage: { input_tokens: 300, output_tokens: 20, cost: 0.00001 },
          },
        }
      );
    }
    return { status: 500, headers: {}, text: "not mocked" };
  };
  const context: ToolExecutionContext = {
    app: app as never,
    settings: {
      ...baseSettings(),
      decisionApiKey: "sk-or-test",
      ...(options.settings ?? {}),
    } as AgentSettings,
    originalPrompt: "",
    httpTransport,
    now: () => {
      clock += 1;
      return new Date(clock);
    },
    getCurrentMarkdownFile: () => activeFile as never,
    getCurrentMarkdownContent: (file) => files.get(file.path) ?? null,
  };
  return { context, decisionRequests, modelRequests: [], traces: [] };
}

/**
 * Run until the first model request, then stop: everything the decision
 * model can influence is visible on that request.
 */
async function runUntilFirstModelCall(h: Harness, prompt: string): Promise<void> {
  const controller = new AbortController();
  const answer = (): ModelChatResponse => ({
    message: { role: "assistant", content: "Stopping here." },
    toolCalls: [],
  });
  const client: ModelClient = {
    async chat(request) {
      h.modelRequests.push(request);
      controller.abort();
      return answer();
    },
    async streamChat(request, events: ModelChatStreamEvents = {}) {
      h.modelRequests.push(request);
      controller.abort();
      events.onContentDelta?.("Stopping here.");
      return answer();
    },
  };
  await runAgentMission({
    prompt,
    modelClient: client,
    toolRegistry: createDefaultToolRegistry(),
    toolContext: h.context,
    enableStreaming: true,
    abortSignal: controller.signal,
    events: { onTrace: (event) => h.traces.push(event) },
  });
}

const PROMOTED = { e2eHarnessAttestationEnabled: true, decisionE2EHarnessPromotion: true };

function modelText(h: Harness): string {
  return h.modelRequests
    .flatMap((request) => request.messages.map((message) => message.content))
    .join("\n");
}

function offeredTools(h: Harness): string[] {
  return [
    ...new Set(
      h.modelRequests.flatMap((request) => (request.tools ?? []).map((tool) => tool.function.name)),
    ),
  ];
}

test("Off sends nothing to the decision endpoint", async () => {
  const h = harness({ settings: { decisionModelMode: "off" } });
  await runUntilFirstModelCall(h, PARAPHRASE);
  assert.equal(h.decisionRequests.length, 0);
  assert.ok(!modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web));
  assert.ok(!h.traces.some((trace) => trace.id.startsWith("decision-")));
});

test("Shadow asks once, records the call, and changes nothing the run does", async () => {
  const off = harness({ settings: { decisionModelMode: "off" } });
  await runUntilFirstModelCall(off, PARAPHRASE);
  const h = harness({ settings: { decisionModelMode: "shadow" } });
  await runUntilFirstModelCall(h, PARAPHRASE);
  assert.equal(h.decisionRequests.length, 1);
  const body = h.decisionRequests[0]!.body;
  assert.equal(body.model, "typesafe/jev-1.13");
  const state = body.state as Record<string, unknown>;
  assert.equal(state.mission, PARAPHRASE);
  assert.ok(!JSON.stringify(body).includes("sk-or-test"), "the credential is a header, never state");
  assert.ok(!modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web));
  assert.deepEqual(offeredTools(h).sort(), offeredTools(off).sort(), "Shadow must not change tool exposure");
  const call = h.traces.find((trace) => trace.id.startsWith("decision-call-"));
  assert.ok(call, "the call is recorded for Run Details");
  assert.match(call!.message, /answered in \d+ ms \(shadow/u);
});

test("Enabled applies a confident semantic evidence request to the whole run", async () => {
  const h = harness({ settings: { decisionModelMode: "enabled", ...PROMOTED } });
  await runUntilFirstModelCall(h, PARAPHRASE);
  assert.equal(h.decisionRequests.length, 1);
  assert.ok(
    h.traces.some((trace) => /Jev found a request for web evidence/u.test(trace.message)),
    h.traces.map((trace) => trace.message).join("\n"),
  );
  assert.ok(modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web), "the model sees the contract");
  const tools = offeredTools(h);
  assert.ok(
    tools.includes("web_search") || tools.includes("web_fetch"),
    `web research is offered: ${tools.join(", ")}`,
  );
});

test("Enabled without a clear answer leaves the routing prompt unchanged", async () => {
  const h = harness({
    settings: { decisionModelMode: "enabled", ...PROMOTED },
    decisionResponse: () => ({
      status: 200,
      headers: {},
      json: {
        model: "typesafe/jev-1.13-20260917",
        answers: jevAnswers({ web_evidence: { type: "noul", noul: 0.62 } }),
      },
    }),
  });
  await runUntilFirstModelCall(h, PARAPHRASE);
  assert.equal(h.decisionRequests.length, 1);
  assert.ok(!modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web));
});

test("an explicit no-web instruction outranks a confident decision", async () => {
  const prompt =
    "Write a short note on tidal energy and back it up with what's out there; do not use the web.";
  const h = harness({ settings: { decisionModelMode: "enabled", ...PROMOTED } });
  await runUntilFirstModelCall(h, prompt);
  assert.ok(!modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web));
  const tools = offeredTools(h);
  assert.ok(!tools.includes("web_search") && !tools.includes("web_fetch"), tools.join(", "));
});

test("direct chat and target-only writes never ask the decision model", async () => {
  for (const prompt of [
    "Explain the difference between TCP and UDP.",
    "Write this brief to the current page.",
  ]) {
    const h = harness({ settings: { decisionModelMode: "enabled", ...PROMOTED } });
    await runUntilFirstModelCall(h, prompt);
    assert.equal(h.decisionRequests.length, 0, prompt);
  }
});

test("a decision outage is recorded as unavailable and never as a tool failure", async () => {
  const h = harness({
    settings: { decisionModelMode: "enabled", ...PROMOTED },
    decisionResponse: () => ({ status: 503, headers: {}, json: { error: { code: 503 } } }),
  });
  await runUntilFirstModelCall(h, PARAPHRASE);
  assert.equal(h.decisionRequests.length, 1);
  const call = h.traces.find((trace) => trace.id.startsWith("decision-call-"));
  assert.match(call?.message ?? "", /unavailable: provider_unavailable; the existing checks decide/u);
  assert.ok(!h.traces.some((trace) => trace.kind === "tool_result" && /decision/u.test(trace.message)));
  assert.ok(!modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web));
});

test("routing is promoted: an Enabled setting acts with no harness switch", async () => {
  // Mission routing passed its held-out gates and the owner switched it on
  // (2026-09-28). An unpromoted component still runs in Shadow; that
  // resolution is pinned in decisionRuntime.test.ts with claim support.
  const h = harness({ settings: { decisionModelMode: "enabled" } });
  await runUntilFirstModelCall(h, PARAPHRASE);
  assert.equal(h.decisionRequests.length, 1);
  assert.ok(modelText(h).includes(DECISION_EVIDENCE_CLAUSES_V1.web), "the model sees the contract");
  assert.ok(!h.traces.some((trace) => trace.id === "decision-mode-held-in-shadow"));
});

function baseSettings(): AgentSettings {
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
