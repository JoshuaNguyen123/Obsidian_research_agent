import assert from "node:assert/strict";
import test from "node:test";
import {
  categorizeModelEndpoint,
  createObservableModelClient,
  cachedPromptTokenRatio,
  extractProviderTokenUsage,
  mergeModelUsageAggregatesV1,
  measureAssistantPayloadChars,
  type ModelCallEvidenceV1,
} from "../src/model/modelCallEvidence";
import { ModelClientError, type ModelClient } from "../src/model/types";

test("categorizes endpoints without retaining raw URLs", () => {
  assert.equal(categorizeModelEndpoint("http://127.0.0.1:11434/api"), "local");
  assert.equal(categorizeModelEndpoint("https://ollama.com/api"), "ollama_cloud");
  assert.equal(categorizeModelEndpoint("https://models.example.test/v1"), "custom");
});

test("merges disjoint provider-usage segments for continuation scorecards", () => {
  assert.deepEqual(
    mergeModelUsageAggregatesV1(
      {
        schemaVersion: 1,
        modelCallCount: 2,
        successfulCallCount: 1,
        failedCallCount: 1,
        reportedTokens: 120,
        estimatedTokens: 0,
        retries: 1,
        wallClockMs: 4_000,
      },
      {
        schemaVersion: 1,
        modelCallCount: 1,
        successfulCallCount: 1,
        failedCallCount: 0,
        reportedTokens: 0,
        estimatedTokens: 80,
        retries: 0,
        wallClockMs: 2_000,
      },
    ),
    {
      schemaVersion: 1,
      modelCallCount: 3,
      successfulCallCount: 2,
      failedCallCount: 1,
      reportedTokens: 120,
      estimatedTokens: 80,
      retries: 1,
      wallClockMs: 6_000,
    },
  );
});

test("extracts Ollama and OpenAI-compatible token usage", () => {
  assert.deepEqual(
    extractProviderTokenUsage({ prompt_eval_count: 10, eval_count: 4 }),
    { promptTokens: 10, completionTokens: 4, totalTokens: 14, cachedPromptTokens: 0, cachedReported: false, reported: true },
  );
  assert.deepEqual(
    extractProviderTokenUsage({
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }),
    { promptTokens: 8, completionTokens: 3, totalTokens: 11, cachedPromptTokens: 0, cachedReported: false, reported: true },
  );
});

test("emits redacted production evidence and enforces the call budget", async () => {
  const evidence: ModelCallEvidenceV1[] = [];
  const underlying: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "gpt-oss:120b-cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async () => ({
      message: { role: "assistant", content: "provider text" },
      toolCalls: [],
      raw: { prompt_eval_count: 7, eval_count: 5 },
    }),
    streamChat: async () => {
      throw new Error("not used");
    },
  };
  const observed = createObservableModelClient({
    client: underlying,
    budget: { schemaVersion: 1, maxCalls: 1, maxTokens: 100, maxWallClockMs: 10_000 },
    onEvidence: (item) => evidence.push(item),
  });

  await observed.client.chat({
    model: " glm-5.2 ",
    messages: [{ role: "user", content: "secret prompt" }],
    evidencePhase: "router",
  });
  await assert.rejects(
    observed.client.chat({ messages: [{ role: "user", content: "again" }] }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "provider_budget_exhausted",
  );

  assert.equal(evidence[0].outcome, "success");
  assert.equal(evidence[0].model, "glm-5.2");
  assert.equal(evidence[0].phase, "router");
  assert.equal(evidence[0].transportKind, "production");
  assert.equal(evidence[0].clientInvoked, true);
  assert.equal(evidence[0].responseChars, "provider text".length);
  assert.equal(evidence[0].totalTokens, 12);
  assert.equal(evidence[1].outcome, "budget_exhausted");
  assert.equal(evidence[1].clientInvoked, false);
  assert.equal(evidence[1].model, "gpt-oss:120b-cloud");
  assert.doesNotMatch(JSON.stringify(evidence), /secret prompt|provider text|ollama\.com/);
  assert.equal(observed.getUsage().modelCallCount, 1);
});

test("a pure tool-call success records its payload size, never zero chars", async () => {
  const toolCallResponse = {
    message: { role: "assistant" as const, content: "" },
    toolCalls: [
      {
        id: "call-1",
        name: "append_to_current_file",
        arguments: { content: "## Section\nStreamed body text." },
      },
    ],
  };
  assert.ok(measureAssistantPayloadChars(toolCallResponse) > 0);
  assert.equal(
    measureAssistantPayloadChars({
      message: { role: "assistant", content: "prose", thinking: "thought" },
      toolCalls: [],
    }),
    "prose".length + "thought".length,
  );

  const evidence: ModelCallEvidenceV1[] = [];
  const underlying: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "minimax-m3:cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async () => toolCallResponse,
    streamChat: async () => {
      throw new Error("not used");
    },
  };
  const observed = createObservableModelClient({
    client: underlying,
    budget: { schemaVersion: 1, maxCalls: 4, maxTokens: 100_000, maxWallClockMs: 10_000 },
    onEvidence: (item) => evidence.push(item),
  });
  await observed.client.chat({ messages: [{ role: "user", content: "go" }] });
  assert.equal(evidence[0].outcome, "success");
  // A tool-calling model is producing real output; harness attestation and
  // token estimation must both see a non-empty response.
  assert.ok(evidence[0].responseChars > 0);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /Streamed body text|append_to_current_file/,
  );
});

test("distinguishes an invoked-client quota failure from a local observer-budget rejection", async () => {
  const evidence: ModelCallEvidenceV1[] = [];
  const underlying: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "gpt-oss:120b-cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async () => {
      throw new ModelClientError(
        "provider_budget_exhausted",
        "Provider returned a quota error.",
      );
    },
    streamChat: async () => {
      throw new Error("not used");
    },
  };
  const observed = createObservableModelClient({
    client: underlying,
    budget: {
      schemaVersion: 1,
      maxCalls: 2,
      maxTokens: 100,
      maxWallClockMs: 10_000,
    },
    onEvidence: (item) => evidence.push(item),
  });

  await assert.rejects(
    observed.client.chat({ messages: [{ role: "user", content: "request" }] }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "provider_budget_exhausted",
  );

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].outcome, "budget_exhausted");
  assert.equal(evidence[0].clientInvoked, true);
  assert.equal(observed.getUsage().modelCallCount, 1);
  assert.equal(observed.getUsage().failedCallCount, 1);
});

/*
 * Provider-served prompt cache accounting.
 *
 * An agent loop resends a byte-identical system prompt and tool schema on every
 * step, so on a cloud-billed provider that prefix is the single largest
 * recurring cost. Nothing read the cached-token counters back, which made cache
 * effectiveness unmeasurable and therefore unimprovable.
 */

test("reads provider-served cached prompt tokens in all three reported shapes", () => {
  // OpenAI-compatible: nested under prompt_tokens_details.
  assert.equal(
    extractProviderTokenUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }).cachedPromptTokens,
    80,
  );
  // Flat cached_tokens.
  assert.equal(
    extractProviderTokenUsage({ usage: { prompt_tokens: 50, cached_tokens: 20 } })
      .cachedPromptTokens,
    20,
  );
  // Anthropic-shaped cache-read counter.
  assert.equal(
    extractProviderTokenUsage({
      usage: { prompt_tokens: 60, cache_read_input_tokens: 45 },
    }).cachedPromptTokens,
    45,
  );
});

test("a silent provider is not recorded as a measured cache miss", () => {
  const silent = extractProviderTokenUsage({ prompt_eval_count: 10, eval_count: 4 });
  assert.equal(silent.cachedReported, false);
  assert.equal(silent.cachedPromptTokens, 0);
  // Unknown and zero must stay distinguishable: reporting a provider that never
  // mentions caching as 0% would make an unmeasurable setup look like a broken
  // one, and would send someone optimizing a cache that does not exist.
  assert.equal(
    cachedPromptTokenRatio({
      promptTokens: silent.promptTokens,
      cachedPromptTokens: silent.cachedPromptTokens,
      cachedTokensReported: silent.cachedReported,
    }),
    null,
  );

  const measuredMiss = extractProviderTokenUsage({
    usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } },
  });
  assert.equal(measuredMiss.cachedReported, true);
  assert.equal(
    cachedPromptTokenRatio({
      promptTokens: measuredMiss.promptTokens,
      cachedPromptTokens: measuredMiss.cachedPromptTokens,
      cachedTokensReported: measuredMiss.cachedReported,
    }),
    0,
  );
});

test("a reported cache hit reaches the evidence record and its ratio", async () => {
  const evidence: ModelCallEvidenceV1[] = [];
  const underlying: ModelClient = {
    descriptor: {
      provider: "ollama",
      model: "gpt-oss:120b-cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
    },
    chat: async () => ({
      message: { role: "assistant", content: "text" },
      toolCalls: [],
      raw: {
        usage: {
          prompt_tokens: 200,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 150 },
        },
      },
    }),
    streamChat: async () => {
      throw new Error("unused");
    },
  };
  const observed = createObservableModelClient({
    client: underlying,
    budget: { schemaVersion: 1, maxCalls: 4, maxTokens: 100_000, maxWallClockMs: 10_000 },
    onEvidence: (record) => evidence.push(record),
  });

  await observed.client.chat({
    messages: [{ role: "user", content: "go" }],
  });

  const record = evidence.at(-1);
  assert.ok(record);
  assert.equal(record.cachedPromptTokens, 150);
  assert.equal(record.cachedTokensReported, true);
  assert.equal(
    cachedPromptTokenRatio(record),
    0.75,
  );
});
