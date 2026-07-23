import assert from "node:assert/strict";
import test from "node:test";
import {
  isDirectOllamaCloudApiBaseUrl,
  parseOllamaContextLength,
  preflightOllamaCloudAgentCapabilities,
} from "../src/model/ollamaCloudCapabilityPreflight";
import { ModelClientError, type HttpRequest } from "../src/model/types";

const CLOUD_DESCRIPTOR = {
  provider: "ollama" as const,
  model: "glm-5.2",
  endpointCategory: "ollama_cloud" as const,
  transportKind: "production" as const,
};

test("probes the exact configured Ollama Cloud model with official /api/show semantics", async () => {
  const requests: HttpRequest[] = [];
  const result = await preflightOllamaCloudAgentCapabilities({
    descriptor: CLOUD_DESCRIPTOR,
    baseUrl: "https://ollama.com/api/",
    apiKey: "secret-key",
    model: "glm-5.2",
    requestTimeoutMs: 12_345,
    transport: async (nextRequest) => {
      requests.push(nextRequest);
      return {
        status: 200,
        headers: {},
        json: {
          capabilities: ["completion", "thinking", "tools"],
          model_info: {
            "glm.context_length": 131_072,
          },
        },
      };
    },
  });

  assert.deepEqual(result, {
    model: "glm-5.2",
    capabilities: ["completion", "thinking", "tools"],
    contextLength: 131_072,
  });
  const request = requests[0];
  assert.ok(request);
  assert.equal(request?.url, "https://ollama.com/api/show");
  assert.equal(request?.method, "POST");
  assert.equal(request?.body, JSON.stringify({ model: "glm-5.2" }));
  assert.equal(request?.headers?.Authorization, "Bearer secret-key");
  assert.equal(request?.timeoutMs, 12_345);
  assert.doesNotMatch(JSON.stringify(result), /secret-key/u);
});

test("fails closed when the selected cloud model lacks tools or thinking", async () => {
  await assert.rejects(
    () =>
      preflightOllamaCloudAgentCapabilities({
        descriptor: CLOUD_DESCRIPTOR,
        baseUrl: "https://ollama.com/api",
        apiKey: "secret-key",
        model: "completion-only:cloud",
        transport: async () => ({
          status: 200,
          headers: {},
          json: { capabilities: ["completion"] },
        }),
      }),
    (error: unknown) =>
      error instanceof ModelClientError &&
      error.category === "api" &&
      /not Automatic-ready/u.test(error.message) &&
      /tools \+ thinking/u.test(error.message) &&
      /Test connection again/u.test(error.message) &&
      !error.message.includes("secret-key"),
  );
});

test("fails closed on invalid metadata or a returned model identity mismatch", async () => {
  await assert.rejects(
    () =>
      preflightOllamaCloudAgentCapabilities({
        descriptor: CLOUD_DESCRIPTOR,
        baseUrl: "https://ollama.com/api",
        apiKey: "secret-key",
        model: "glm-5.2",
        transport: async () => ({ status: 200, headers: {}, json: [] }),
      }),
    (error: unknown) =>
      error instanceof ModelClientError &&
      error.category === "invalid_response" &&
      /Automatic mode remains blocked/u.test(error.message),
  );

  await assert.rejects(
    () =>
      preflightOllamaCloudAgentCapabilities({
        descriptor: CLOUD_DESCRIPTOR,
        baseUrl: "https://ollama.com/api",
        apiKey: "secret-key",
        model: "glm-5.2",
        transport: async () => ({
          status: 200,
          headers: {},
          json: {
            model: "another-model:cloud",
            capabilities: ["tools", "thinking"],
          },
        }),
      }),
    (error: unknown) =>
      error instanceof ModelClientError &&
      /instead of the configured model glm-5\.2/u.test(error.message),
  );
});

test("leaves local Ollama, custom Ollama, and OpenAI-compatible connections unchanged", async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    return { status: 200, headers: {}, json: {} };
  };

  for (const entry of [
    {
      descriptor: { ...CLOUD_DESCRIPTOR, endpointCategory: "local" as const },
      baseUrl: "http://127.0.0.1:11434/api",
    },
    {
      descriptor: { ...CLOUD_DESCRIPTOR, endpointCategory: "custom" as const },
      baseUrl: "https://example.test/api",
    },
    {
      descriptor: {
        ...CLOUD_DESCRIPTOR,
        provider: "openai_compatible" as const,
        endpointCategory: "custom" as const,
      },
      baseUrl: "https://api.openai.com/v1",
    },
  ]) {
    assert.equal(
      await preflightOllamaCloudAgentCapabilities({
        ...entry,
        apiKey: "irrelevant",
        model: entry.descriptor.model,
        transport,
      }),
      null,
    );
  }

  assert.equal(calls, 0);
});

test("only the canonical direct cloud API is preflighted and context parsing is conservative", () => {
  assert.equal(isDirectOllamaCloudApiBaseUrl("https://ollama.com/api/"), true);
  assert.equal(isDirectOllamaCloudApiBaseUrl("http://ollama.com/api"), false);
  assert.equal(isDirectOllamaCloudApiBaseUrl("https://api.ollama.com/api"), false);
  assert.equal(isDirectOllamaCloudApiBaseUrl("https://ollama.com/custom"), false);
  assert.equal(
    parseOllamaContextLength({
      "first.context_length": 131_072,
      "second.context_length": 65_536,
      "unsafe.context_length": "999999",
    }),
    65_536,
  );
  assert.equal(parseOllamaContextLength({ "model.context_length": -1 }), null);
});

test("maps capability endpoint authorization failures without exposing credentials", async () => {
  await assert.rejects(
    () =>
      preflightOllamaCloudAgentCapabilities({
        descriptor: CLOUD_DESCRIPTOR,
        baseUrl: "https://ollama.com/api",
        apiKey: "secret-key",
        model: "glm-5.2",
        transport: async () => ({
          status: 401,
          headers: {},
          json: { error: "invalid token" },
        }),
      }),
    (error: unknown) =>
      error instanceof ModelClientError &&
      error.category === "auth" &&
      /invalid token/u.test(error.message) &&
      !error.message.includes("secret-key"),
  );
});
