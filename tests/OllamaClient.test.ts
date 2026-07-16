import test from "node:test";
import assert from "node:assert/strict";
import {
  getOllamaChatUrl,
  normalizeOllamaBaseUrl,
  OllamaClient,
  parseOllamaChatStream,
  parseOllamaChatResponse,
} from "../src/model/OllamaClient";
import { HttpRequest, ModelClientError } from "../src/model/types";

test("normalizes Ollama base URLs and builds chat URLs", () => {
  assert.equal(
    normalizeOllamaBaseUrl("https://ollama.com/api/"),
    "https://ollama.com/api",
  );
  assert.equal(
    getOllamaChatUrl("http://localhost:11434/api/"),
    "http://localhost:11434/api/chat",
  );
});

test("exposes a redacted production descriptor", () => {
  const client = new OllamaClient({
    baseUrl: "https://ollama.com/api?credential=never-retained",
    apiKey: "secret-never-retained",
    model: "gpt-oss:120b-cloud",
    transport: async () => ({ status: 200, headers: {}, json: {} }),
  });
  assert.deepEqual(client.descriptor, {
    provider: "ollama",
    model: "gpt-oss:120b-cloud",
    endpointCategory: "ollama_cloud",
    transportKind: "production",
  });
  assert.doesNotMatch(JSON.stringify(client.descriptor), /secret|credential=/u);
});

test("fails fast when Ollama Cloud is missing an API key", async () => {
  let transportCalled = false;
  const client = new OllamaClient({
    baseUrl: "https://ollama.com/api",
    apiKey: "",
    model: "gpt-oss:120b",
    transport: async () => {
      transportCalled = true;
      throw new Error("transport should not be called");
    },
  });

  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: "user", content: "Hello" }],
      }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "missing_api_key",
  );
  assert.equal(transportCalled, false);
});

test("sends auth headers, non-streaming chat body, and tool definitions", async () => {
  let capturedRequest: HttpRequest | undefined;
  const client = new OllamaClient({
    baseUrl: "https://ollama.com/api/",
    apiKey: "test-key",
    model: "gpt-oss:120b",
    transport: async (request) => {
      capturedRequest = request;
      return {
        status: 200,
        headers: {},
        json: {
          message: {
            role: "assistant",
            content: "Ready.",
            thinking: "Considering tools.",
            tool_calls: [
              {
                type: "function",
                function: {
                  index: 0,
                  name: "web_search",
                  arguments: { query: "MCP servers" },
                },
              },
            ],
          },
          done: true,
          done_reason: "stop",
        },
        text: "",
      };
    },
  });

  const response = await client.chat({
    messages: [{ role: "user", content: "Search MCP servers" }],
    think: "medium",
    options: {
      temperature: 0.2,
      top_k: 40,
      top_p: 0.8,
      num_ctx: 4096,
    },
    tools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      },
    ],
  });

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.url, "https://ollama.com/api/chat");
  assert.equal(capturedRequest.method, "POST");
  assert.equal(capturedRequest.throw, false);
  assert.equal(capturedRequest.headers?.Authorization, "Bearer test-key");

  const body = JSON.parse(String(capturedRequest.body));
  assert.equal(body.model, "gpt-oss:120b");
  assert.equal(body.stream, false);
  assert.equal(body.think, "medium");
  assert.deepEqual(body.options, {
    temperature: 0.2,
    top_k: 40,
    top_p: 0.8,
    num_ctx: 4096,
  });
  assert.equal(body.messages[0].content, "Search MCP servers");
  assert.equal(body.tools[0].function.name, "web_search");

  assert.equal(response.message.content, "Ready.");
  assert.equal(response.message.thinking, "Considering tools.");
  assert.equal(response.doneReason, "stop");
  assert.equal(response.toolCalls[0].name, "web_search");
  assert.deepEqual(response.toolCalls[0].arguments, { query: "MCP servers" });
});

test("passes request timeout to chat transport and maps timeout errors", async () => {
  let capturedTimeoutMs = 0;
  const client = new OllamaClient({
    baseUrl: "https://ollama.com/api/",
    apiKey: "test-key",
    model: "gpt-oss:120b",
    requestTimeoutMs: 42,
    transport: async (request) => {
      capturedTimeoutMs = request.timeoutMs ?? 0;
      throw new Error("Request timed out after 42ms.");
    },
  });

  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: "user", content: "Hello" }],
      }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "network" &&
      /timed out/.test(error.message),
  );
  assert.equal(capturedTimeoutMs, 42);
});

test("maps auth HTTP failures to auth errors", async () => {
  const client = new OllamaClient({
    baseUrl: "https://ollama.com/api",
    apiKey: "bad-key",
    model: "gpt-oss:120b",
    transport: async () => ({
      status: 401,
      headers: {},
      json: { error: "invalid api key" },
      text: "",
    }),
  });

  await assert.rejects(
    () =>
      client.chat({
        messages: [{ role: "user", content: "Hello" }],
      }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "auth" &&
      error.status === 401 &&
      error.message === "invalid api key",
  );
});

test("parses tool arguments returned as JSON strings", () => {
  const response = parseOllamaChatResponse({
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          function: {
            name: "read_current_file",
            arguments: "{\"path\":\"Current.md\"}",
          },
        },
      ],
    },
  });

  assert.equal(response.toolCalls[0].name, "read_current_file");
  assert.deepEqual(response.toolCalls[0].arguments, { path: "Current.md" });
});

test("rejects invalid response bodies", () => {
  assert.throws(
    () => parseOllamaChatResponse({ done: true }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "invalid_response",
  );
});

test("parses streamed NDJSON content, thinking, and tool calls", async () => {
  const contentDeltas: string[] = [];
  const thinkingDeltas: string[] = [];
  const response = await parseOllamaChatStream(
    chunks([
      '{"message":{"role":"assistant","thinking":"checking "},"done":false}\n',
      '{"message":{"role":"assistant","content":"Hello"},"done":false}\n{"message":{"role":"assistant","content":" world"},"done":false}\n',
      '{"message":{"role":"assistant","tool_calls":[{"function":{"name":"read_current_file","arguments":{}}}]},"done":true,"done_reason":"stop"}\n',
    ]),
    {
      onContentDelta: (delta) => contentDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    },
  );

  assert.equal(response.message.content, "Hello world");
  assert.equal(response.message.thinking, "checking ");
  assert.equal(response.toolCalls[0].name, "read_current_file");
  assert.deepEqual(response.toolCalls[0].arguments, {});
  assert.equal(response.doneReason, "stop");
  assert.deepEqual(contentDeltas, ["Hello", " world"]);
  assert.deepEqual(thinkingDeltas, ["checking "]);
});

test("streams chat through streaming transport with stream true", async () => {
  let capturedRequest: HttpRequest | undefined;
  const client = new OllamaClient({
    baseUrl: "https://ollama.com/api",
    apiKey: "test-key",
    model: "gpt-oss:120b",
    transport: async () => {
      throw new Error("non-streaming transport should not be called");
    },
    streamingTransport: async (request) => {
      capturedRequest = request;
      return {
        status: 200,
        headers: {},
        body: chunks([
          '{"message":{"role":"assistant","content":"streamed"}}\n',
        ]),
      };
    },
  });

  const response = await client.streamChat({
    messages: [{ role: "user", content: "Hello" }],
    think: true,
    options: { temperature: 0.1 },
  });

  assert.equal(response.message.content, "streamed");
  assert.ok(capturedRequest);
  const body = JSON.parse(String(capturedRequest.body));
  assert.equal(body.stream, true);
  assert.equal(body.think, true);
  assert.deepEqual(body.options, { temperature: 0.1 });
});

async function* chunks(values: string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}
