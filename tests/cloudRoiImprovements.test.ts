import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCloudConnectionGate,
  cloudProviderNeedsApiKey,
} from "../src/agent/cloudModelReadiness";
import {
  mapRunRouteToSchemaRoute,
  schemasForStep,
} from "../src/agent/toolSchemaPolicy";
import {
  buildSelectionResearchPrompt,
  isSelectionResearchDailyUsePrompt,
  SELECTION_RESEARCH_CONTRACT_MARKER,
} from "../src/agent/selectionResearchPrompt";
import {
  applyCloudProviderPreset,
  CLOUD_PROVIDER_PRESETS,
  getCloudProviderPreset,
  matchCloudProviderPreset,
  repairOllamaCloudBaseUrl,
} from "../src/model/cloudProviderPresets";
import {
  accumulateOpenAIStreamToolCalls,
  finalizeOpenAIStreamToolCallsForTest,
  OpenAICompatibleClient,
} from "../src/model/OpenAICompatibleClient";
import { ModelClientError } from "../src/model/types";
import { parseProviderToolArguments } from "../src/model/toolArgumentNormalization";
import {
  cloudProviderBlockerFromError,
  formatModelFailureCopy,
} from "../src/agent/failureCopy";
import {
  continueLatestRunSafeCopy,
  chatProviderBlockerTitle,
} from "../src/ui/agentViewCopy";
import { constrainToolsToMissionGraphFrontier } from "../src/AgentRunner";
import type { ModelToolDefinition } from "../src/model/types";

test("cloud connection gate blocks unverified BYOK and explains next step", () => {
  const blocked = evaluateCloudConnectionGate({
    verified: false,
    provider: "openai_compatible",
    model: "gpt-4o-mini",
    hasApiKey: false,
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.what, /API key is missing/i);
  assert.match(blocked.next, /Test connection/i);

  const ready = evaluateCloudConnectionGate({
    verified: true,
    provider: "ollama",
    model: "gpt-oss:120b-cloud",
    hasApiKey: true,
    baseUrl: "https://ollama.com",
  });
  assert.equal(ready.ok, true);
  assert.equal(cloudProviderNeedsApiKey("openai_compatible", "https://api.openai.com/v1"), true);
  assert.equal(cloudProviderNeedsApiKey("openai_compatible", "http://127.0.0.1:1234/v1"), false);
});

test("OpenAI-compatible client fails fast on missing remote API key", async () => {
  const client = new OpenAICompatibleClient({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    transport: async () => {
      throw new Error("should not reach transport");
    },
  });
  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: "user", content: "hi" }],
      }),
    (error: unknown) =>
      error instanceof ModelClientError && error.category === "missing_api_key",
  );
});

test("OpenAI stream tool_calls accumulate parallel deltas by id when index omitted", () => {
  const accumulators = new Map();
  accumulateOpenAIStreamToolCalls(
    [{ id: "call_a", function: { name: "web_search", arguments: '{"q":' } }],
    accumulators,
  );
  accumulateOpenAIStreamToolCalls(
    [{ id: "call_b", function: { name: "web_fetch", arguments: '{"u":' } }],
    accumulators,
  );
  accumulateOpenAIStreamToolCalls(
    [{ id: "call_a", function: { arguments: '"cats"}' } }],
    accumulators,
  );
  accumulateOpenAIStreamToolCalls(
    [{ id: "call_b", function: { arguments: '"https://example.com"}' } }],
    accumulators,
  );
  const finalized = finalizeOpenAIStreamToolCallsForTest(accumulators);
  assert.equal(finalized.length, 2);
  assert.equal(finalized[0]?.name, "web_search");
  assert.deepEqual(finalized[0]?.arguments, { q: "cats" });
  assert.equal(finalized[1]?.name, "web_fetch");
  assert.deepEqual(finalized[1]?.arguments, { u: "https://example.com" });
});

test("tool argument normalization unwraps kwargs and string envelopes", () => {
  assert.deepEqual(
    parseProviderToolArguments({ kwargs: { path: "Note.md" } }),
    { path: "Note.md" },
  );
  assert.deepEqual(
    parseProviderToolArguments({ tool_input: '{"query":"x"}' }),
    { query: "x" },
  );
});

test("cloud provider blocker copy covers 401/429/timeout", () => {
  assert.match(
    formatModelFailureCopy({ category: "rate_limit", message: "429" }),
    /rate limit/i,
  );
  assert.match(
    cloudProviderBlockerFromError({ category: "auth", message: "bad key" }).next,
    /API key/i,
  );
  assert.equal(chatProviderBlockerTitle(), "Cloud model blocked");
});

test("runRoute maps to schema policy and drops Linear on current-note", () => {
  assert.equal(mapRunRouteToSchemaRoute("direct_writeback"), "current_note");
  assert.equal(mapRunRouteToSchemaRoute("single_model_writeback"), "current_note");
  assert.equal(mapRunRouteToSchemaRoute("instant_local"), "current_note");
  assert.equal(mapRunRouteToSchemaRoute("grounded_workflow"), "research");
  assert.equal(mapRunRouteToSchemaRoute("tool_required"), "research");
  assert.equal(mapRunRouteToSchemaRoute("prefetched_vault_answer"), "vault");
  assert.equal(mapRunRouteToSchemaRoute("prefetched_vault_writeback"), "vault");
  assert.equal(mapRunRouteToSchemaRoute("single_model_answer"), "default");
  assert.equal(mapRunRouteToSchemaRoute("code"), "code");
  assert.equal(mapRunRouteToSchemaRoute("unknown_route"), "default");

  const schemas = schemasForStep({
    route: "direct_writeback",
    frontier: ["replace_current_file"],
    graphRequired: [],
    allSchemas: [
      { type: "function", function: { name: "replace_current_file" } },
      { type: "function", function: { name: "read_current_file" } },
      { type: "function", function: { name: "linear_create_issue" } },
      { type: "function", function: { name: "github_create_pull_request" } },
    ],
  });
  const names = schemas.map((s) => s.function.name);
  assert.ok(names.includes("replace_current_file"));
  assert.ok(!names.includes("linear_create_issue"));
  assert.ok(!names.includes("github_create_pull_request"));

  const researchSchemas = schemasForStep({
    route: "grounded_workflow",
    frontier: ["web_search"],
    graphRequired: ["web_fetch"],
    allSchemas: [
      { type: "function", function: { name: "web_search" } },
      { type: "function", function: { name: "web_fetch" } },
      { type: "function", function: { name: "read_current_file" } },
      { type: "function", function: { name: "linear_create_issue" } },
    ],
  });
  const researchNames = researchSchemas.map((s) => s.function.name);
  assert.ok(researchNames.includes("web_search"));
  assert.ok(researchNames.includes("web_fetch"));
  assert.ok(researchNames.includes("read_current_file"));
  assert.ok(!researchNames.includes("linear_create_issue"));

  const compoundSchemas = schemasForStep({
    route: "grounded_workflow",
    frontier: ["code_workspace_create_file"],
    graphRequired: [],
    allSchemas: [
      { type: "function", function: { name: "code_workspace_create_file" } },
      { type: "function", function: { name: "code_sandbox_status" } },
      { type: "function", function: { name: "publish_research_to_linear" } },
      { type: "function", function: { name: "linear_create_issue" } },
      { type: "function", function: { name: "web_search" } },
    ],
  });
  const compoundNames = compoundSchemas.map((s) => s.function.name);
  assert.ok(compoundNames.includes("code_workspace_create_file"));
  assert.ok(compoundNames.includes("code_sandbox_status"));
  assert.ok(compoundNames.includes("publish_research_to_linear"));
  assert.ok(compoundNames.includes("web_search"));
  assert.ok(!compoundNames.includes("linear_create_issue"));
});

test("constrainToolsToMissionGraphFrontier shrinks note route without graph", () => {
  const tools: ModelToolDefinition[] = [
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
        name: "linear_create_issue",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const constrained = constrainToolsToMissionGraphFrontier(tools, null, {
    route: "direct_writeback",
  });
  assert.deepEqual(
    constrained.map((t) => t.function.name),
    ["append_to_current_file"],
  );
});

test("constrainToolsToMissionGraphFrontier shrinks research and vault routes without graph", () => {
  const tools: ModelToolDefinition[] = [
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
        name: "read_file",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "linear_create_issue",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "github_list_pull_requests",
        parameters: { type: "object", properties: {} },
      },
    },
  ];
  const research = constrainToolsToMissionGraphFrontier(tools, null, {
    route: "grounded_workflow",
  });
  assert.deepEqual(
    research.map((t) => t.function.name).sort(),
    ["read_file", "web_search"],
  );
  const vault = constrainToolsToMissionGraphFrontier(tools, null, {
    route: "prefetched_vault_answer",
  });
  // Without a graph, vault/research routes only strip linear_*/github_* noise
  // (not an empty-frontier whitelist), so Soft research tools stay available.
  assert.deepEqual(
    vault.map((t) => t.function.name).sort(),
    ["read_file", "web_search"],
  );
});

test("selection research prompt binds DU-02 contract marker", () => {
  const built = buildSelectionResearchPrompt({
    selection: "quantum computing milestones",
    notePath: "Research.md",
    mode: "stream_page",
  });
  assert.equal(built.dailyUseId, "DU-02");
  assert.ok(built.prompt.includes(SELECTION_RESEARCH_CONTRACT_MARKER));
  assert.ok(isSelectionResearchDailyUsePrompt(built.prompt));
  assert.match(built.prompt, /web_search|web_fetch/i);
});

test("continue latest run copy promises no write replay", () => {
  assert.match(
    continueLatestRunSafeCopy({
      runId: "run-1",
      nextAction: "Finish citations",
      completedWriteCount: 2,
    }),
    /will not be replayed/i,
  );
});

test("cloud provider presets include OpenAI OpenRouter Azure and Ollama Cloud", () => {
  assert.ok(CLOUD_PROVIDER_PRESETS.length >= 4);
  assert.equal(getCloudProviderPreset("openai")?.baseUrl, "https://api.openai.com/v1");
  assert.equal(
    getCloudProviderPreset("openrouter")?.baseUrl,
    "https://openrouter.ai/api/v1",
  );
  assert.match(getCloudProviderPreset("azure_openai")?.baseUrl ?? "", /azure/i);
  assert.equal(getCloudProviderPreset("ollama_cloud")?.provider, "ollama");
  assert.equal(getCloudProviderPreset("ollama_cloud")?.suggestedModel, "glm-5.2");
  assert.equal(
    getCloudProviderPreset("ollama_cloud")?.baseUrl,
    "https://ollama.com/api",
  );
});

test("Ollama Cloud preset sets base URL only and leaves the model tag alone", () => {
  const settings = {
    modelProvider: "ollama" as const,
    model: "qwen3.5:cloud",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
  };
  const preset = getCloudProviderPreset("ollama_cloud");
  assert.ok(preset);
  applyCloudProviderPreset(settings, preset);
  assert.equal(settings.ollamaBaseUrl, "https://ollama.com/api");
  assert.equal(settings.model, "qwen3.5:cloud");
});

test("matchCloudProviderPreset recognizes applied Ollama Cloud endpoint", () => {
  const settings = {
    modelProvider: "ollama" as const,
    model: "glm-5.2",
    ollamaBaseUrl: "https://ollama.com/api/",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
  };
  assert.equal(matchCloudProviderPreset(settings)?.id, "ollama_cloud");
  settings.ollamaBaseUrl = "http://127.0.0.1:11434";
  assert.equal(matchCloudProviderPreset(settings), undefined);
});

test("repairOllamaCloudBaseUrl heals bare ollama.com host", () => {
  assert.equal(repairOllamaCloudBaseUrl("https://ollama.com"), "https://ollama.com/api");
  assert.equal(repairOllamaCloudBaseUrl("https://ollama.com/"), "https://ollama.com/api");
  assert.equal(
    repairOllamaCloudBaseUrl("https://ollama.com/api"),
    "https://ollama.com/api",
  );
  assert.equal(
    repairOllamaCloudBaseUrl("http://127.0.0.1:11434"),
    "http://127.0.0.1:11434",
  );
});

test("OpenAI-compatible presets still apply a suggested model", () => {
  const settings = {
    modelProvider: "ollama" as const,
    model: "keep-me",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openAiCompatibleBaseUrl: "http://127.0.0.1:9",
  };
  const preset = getCloudProviderPreset("openrouter");
  assert.ok(preset);
  applyCloudProviderPreset(settings, preset);
  assert.equal(settings.modelProvider, "openai_compatible");
  assert.equal(settings.openAiCompatibleBaseUrl, "https://openrouter.ai/api/v1");
  assert.equal(settings.model, "openai/gpt-4o-mini");
});
