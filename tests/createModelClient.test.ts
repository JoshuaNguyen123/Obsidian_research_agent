import test from "node:test";
import assert from "node:assert/strict";
import {
  createConfiguredModelClient,
  createModelClientForSlot,
  hybridStreamingTransport,
} from "../src/model/createModelClient";
import { ModelClientError } from "../src/model/types";
import type { AgentSettings } from "../src/settings";

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    modelProvider: "ollama",
    ollamaApiKey: "ollama-key",
    ollamaBaseUrl: "https://ollama.com/api",
    openAiCompatibleApiKey: "openai-key",
    openAiCompatibleBaseUrl: "https://api.openai.com/v1",
    model: "test-model",
    enableStreaming: true,
    requestTimeoutMs: 180000,
    maxAgentSteps: 10,
    thinkingMode: "auto",
    streamWritebackMode: "all_current_note_content_writes",
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
    semanticSearchEnabled: true,
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticPythonCommand: "",
    semanticModelCacheDir: "",
    semanticIndexEnabled: true,
    semanticIndexFolder: "Agent Memory",
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 1000,
    semanticIndexPersistVectors: true,
    temperature: null,
    topK: null,
    topP: null,
    numCtx: null,
    ...overrides,
  };
}

test("createConfiguredModelClient selects Ollama by default", () => {
  const client = createConfiguredModelClient(settings());
  assert.equal(client.constructor.name, "OllamaClient");
});

test("createConfiguredModelClient selects OpenAI-compatible provider", () => {
  const client = createConfiguredModelClient(
    settings({ modelProvider: "openai_compatible" }),
  );
  assert.equal(client.constructor.name, "OpenAICompatibleClient");
});

test("model clients reject credential-bearing remote HTTP but allow loopback HTTP", () => {
  assert.throws(
    () =>
      createModelClientForSlot({
        provider: "openai_compatible",
        model: "test-model",
        baseUrl: "http://models.example.test/v1",
        apiKey: "must-not-leak",
        requestTimeoutMs: 1_000,
      }),
    /must use HTTPS/iu,
  );
  assert.equal(
    createModelClientForSlot({
      provider: "ollama",
      model: "test-model",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "local-key",
      requestTimeoutMs: 1_000,
    }).constructor.name,
    "OllamaClient",
  );
  assert.throws(
    () =>
      createModelClientForSlot({
        provider: "ollama",
        model: "test-model",
        baseUrl: "http://127.0.0.1.attacker.example",
        apiKey: "must-not-leak",
        requestTimeoutMs: 1_000,
      }),
    /must use HTTPS/iu,
  );
});

test("hybrid streaming transport does not re-run a timed-out request over the desktop fallback", async () => {
  // Regression: a provider that accepted the request and never answered made
  // the fetch path time out, after which the node fallback re-sent the same
  // request and waited out its own idle timeout — doubling every stalled
  // attempt. A timeout must surface immediately as the fetch-path error.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
    })) as typeof fetch;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      hybridStreamingTransport({
        // A closed loopback port: if the fallback were attempted it would fail
        // fast with a distinct "Desktop streaming fallback failed" message.
        url: "http://127.0.0.1:9/api/chat",
        method: "POST",
        body: "{}",
        timeoutMs: 25,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ModelClientError);
        assert.equal(error.category, "network");
        assert.match(error.message, /timed out after 25ms/u);
        assert.doesNotMatch(error.message, /Desktop streaming fallback/u);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
