import test from "node:test";
import assert from "node:assert/strict";
import {
  extractToolCallsFromAssistantText,
  recoverToolCallsFromAssistantMessage,
} from "../src/agent/toolCallRecovery";
import type { ModelChatResponse } from "../src/model/types";

test("XML-ish requested tool blocks recover known tool calls", () => {
  const calls = extractToolCallsFromAssistantText(
    [
      "<requested_tool_call>",
      "<name>list_folder</name>",
      "<arguments>{\"path\":\"/\"}</arguments>",
      "</requested_tool_call>",
    ].join(""),
    new Set(["list_folder"]),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "list_folder");
  assert.deepEqual(calls[0].arguments, { path: "" });
});

test("compact JSON recovers tool field and top-level arguments", () => {
  const calls = extractToolCallsFromAssistantText(
    '{"tool":"rename_current_file","title":"History Snapshot"}',
    new Set(["rename_current_file"]),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { title: "History Snapshot" });
});

test("provider tool calls bypass text recovery", () => {
  const response: Pick<ModelChatResponse, "message" | "toolCalls"> = {
    message: {
      role: "assistant",
      content: '{"name":"list_folder","arguments":{"path":"/"}}',
    },
    toolCalls: [
      {
        name: "read_current_file",
        arguments: {},
        index: 0,
        raw: { source: "provider" },
      },
    ],
  };

  assert.deepEqual(
    recoverToolCallsFromAssistantMessage(response, new Set(["list_folder"])),
    response.toolCalls,
  );
});
