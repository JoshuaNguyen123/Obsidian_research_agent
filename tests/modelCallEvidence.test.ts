import assert from "node:assert/strict";
import test from "node:test";
import {
  categorizeModelEndpoint,
  createObservableModelClient,
  extractProviderTokenUsage,
  type ModelCallEvidenceV1,
} from "../src/model/modelCallEvidence";
import { ModelClientError, type ModelClient } from "../src/model/types";

test("categorizes endpoints without retaining raw URLs", () => {
  assert.equal(categorizeModelEndpoint("http://127.0.0.1:11434/api"), "local");
  assert.equal(categorizeModelEndpoint("https://ollama.com/api"), "ollama_cloud");
  assert.equal(categorizeModelEndpoint("https://models.example.test/v1"), "custom");
});

test("extracts Ollama and OpenAI-compatible token usage", () => {
  assert.deepEqual(
    extractProviderTokenUsage({ prompt_eval_count: 10, eval_count: 4 }),
    { promptTokens: 10, completionTokens: 4, totalTokens: 14, reported: true },
  );
  assert.deepEqual(
    extractProviderTokenUsage({
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }),
    { promptTokens: 8, completionTokens: 3, totalTokens: 11, reported: true },
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
  assert.equal(evidence[0].phase, "router");
  assert.equal(evidence[0].transportKind, "production");
  assert.equal(evidence[0].responseChars, "provider text".length);
  assert.equal(evidence[0].totalTokens, 12);
  assert.equal(evidence[1].outcome, "budget_exhausted");
  assert.doesNotMatch(JSON.stringify(evidence), /secret prompt|provider text|ollama\.com/);
  assert.equal(observed.getUsage().modelCallCount, 1);
});
