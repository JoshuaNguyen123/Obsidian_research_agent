import test from "node:test";
import assert from "node:assert/strict";
import { createConfiguredModelClient } from "../src/model/createModelClient";
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
