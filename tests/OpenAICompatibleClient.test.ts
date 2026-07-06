import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOpenAIChatBody,
  OpenAICompatibleClient,
  parseOpenAIChatResponse,
  parseOpenAIChatStream,
  toOpenAIMessages,
} from "../src/model/OpenAICompatibleClient";
import type { HttpRequest } from "../src/model/types";
import { ModelClientError } from "../src/model/types";

test("maps internal messages to OpenAI-compatible tool transcripts", () => {
  const messages = toOpenAIMessages([
    { role: "system", content: "System" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_1",
          name: "read_current_file",
          arguments: { path: "Current.md" },
        },
      ],
    },
    {
      role: "tool",
      toolName: "read_current_file",
      toolCallId: "call_1",
      content: "{\"ok\":true}",
    },
  ]);

  assert.deepEqual(messages[1], {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "read_current_file",
          arguments: "{\"path\":\"Current.md\"}",
        },
      },
    ],
  });
  assert.deepEqual(messages[2], {
    role: "tool",
    tool_call_id: "call_1",
    content: "{\"ok\":true}",
  });
});

test("builds OpenAI-compatible chat body with tools and options", () => {
  const body = buildOpenAIChatBody(
    {
      messages: [{ role: "user", content: "Search" }],
      tools: [
        {
          type: "function",
          function: {
            name: "web_search",
            description: "Search web",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      options: { temperature: 0.2, top_p: 0.9, num_ctx: 1024 },
    },
    "gpt-test",
    false,
  ) as Record<string, unknown>;

  assert.equal(body.model, "gpt-test");
  assert.equal(body.stream, false);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 1024);
});

test("parses OpenAI-compatible tool calls", () => {
  const response = parseOpenAIChatResponse({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: {
                name: "web_search",
                arguments: "{\"query\":\"MCP\"}",
              },
            },
          ],
        },
      },
    ],
  });

  assert.equal(response.doneReason, "tool_calls");
  assert.equal(response.toolCalls[0].id, "call_abc");
  assert.equal(response.toolCalls[0].name, "web_search");
  assert.deepEqual(response.toolCalls[0].arguments, { query: "MCP" });
});

test("parses OpenAI-compatible streaming text and tool deltas", async () => {
  const deltas: string[] = [];
  const response = await parseOpenAIChatStream(
    asyncIterable([
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"query\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"MCP\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]),
    { onContentDelta: (delta) => deltas.push(delta) },
  );

  assert.deepEqual(deltas, ["Hello ", "world"]);
  assert.equal(response.message.content, "Hello world");
  assert.equal(response.toolCalls[0].id, "call_1");
  assert.deepEqual(response.toolCalls[0].arguments, { query: "MCP" });
});

test("OpenAI-compatible client sends auth and maps errors", async () => {
  let captured: HttpRequest | undefined;
  const client = new OpenAICompatibleClient({
    baseUrl: "https://api.openai.com/v1/",
    apiKey: "sk-test",
    model: "gpt-test",
    transport: async (request) => {
      captured = request;
      return {
        status: 401,
        headers: {},
        json: { error: { message: "bad key" } },
      };
    },
  });

  await assert.rejects(
    () => client.chat({ messages: [{ role: "user", content: "Hello" }] }),
    (error) =>
      error instanceof ModelClientError &&
      error.category === "auth" &&
      error.message === "bad key",
  );
  assert.equal(captured?.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(captured?.headers?.Authorization, "Bearer sk-test");
});

async function* asyncIterable(values: string[]): AsyncIterable<string> {
  for (const value of values) {
    yield value;
  }
}
