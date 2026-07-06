import test from "node:test";
import assert from "node:assert/strict";
import {
  appendToolTranscript,
  ensureToolCallId,
} from "../src/model/toolTranscript";
import type { ModelChatMessage } from "../src/model/types";

test("ensureToolCallId preserves existing ids and applies fallback ids", () => {
  assert.deepEqual(
    ensureToolCallId(
      { id: "call_existing", name: "web_search", arguments: {} },
      "fallback",
    ),
    { id: "call_existing", name: "web_search", arguments: {} },
  );
  assert.deepEqual(
    ensureToolCallId({ name: "web_search", arguments: {} }, "fallback"),
    { id: "fallback", name: "web_search", arguments: {} },
  );
});

test("appendToolTranscript adds tool result for model-origin calls", () => {
  const messages: ModelChatMessage[] = [];
  const call = appendToolTranscript({
    messages,
    toolCall: { id: "call_1", name: "read_current_file", arguments: {} },
    resultContent: "{\"ok\":true}",
    origin: "model",
    fallbackId: "fallback",
  });

  assert.equal(call.id, "call_1");
  assert.deepEqual(messages, [
    {
      role: "tool",
      toolName: "read_current_file",
      toolCallId: "call_1",
      content: "{\"ok\":true}",
    },
  ]);
});

test("appendToolTranscript adds synthetic assistant call for runner-origin calls", () => {
  const messages: ModelChatMessage[] = [];
  appendToolTranscript({
    messages,
    toolCall: { name: "web_search", arguments: { query: "MCP" } },
    resultContent: "{\"ok\":true}",
    origin: "runner",
    fallbackId: "call_runner",
  });

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_runner",
          name: "web_search",
          arguments: { query: "MCP" },
        },
      ],
    },
    {
      role: "tool",
      toolName: "web_search",
      toolCallId: "call_runner",
      content: "{\"ok\":true}",
    },
  ]);
});
