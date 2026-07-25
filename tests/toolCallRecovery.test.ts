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

test("vendor-native tool-call text formats recover known tool calls", () => {
  const known = new Set(["code_sandbox_status", "web_search"]);
  const cases: Array<{ label: string; content: string; expected: number }> = [
    {
      label: "kimi-k2 sentinel section",
      content:
        "I will check the sandbox now.<|tool_calls_section_begin|>" +
        "<|tool_call_begin|>functions.code_sandbox_status:0" +
        '<|tool_call_argument_begin|>{"detail":"full"}<|tool_call_end|>' +
        "<|tool_calls_section_end|>",
      expected: 1,
    },
    {
      label: "qwen/hermes tool_call block",
      content:
        'Sure.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "obsidian"}}\n</tool_call>',
      expected: 1,
    },
    {
      label: "llama function tag",
      content: '<function=code_sandbox_status>{"detail":"fast"}</function>',
      expected: 1,
    },
    {
      label: "bare pseudo-code call",
      content: 'I\'ll run functions.web_search({"query": "release notes"}) now.',
      expected: 1,
    },
    {
      label: "unknown tool name is dropped",
      content:
        '<tool_call>{"name": "not_a_tool", "arguments": {}}</tool_call>',
      expected: 0,
    },
  ];
  for (const item of cases) {
    const calls = extractToolCallsFromAssistantText(item.content, known);
    assert.equal(calls.length, item.expected, item.label);
    if (item.expected > 0) {
      assert.ok(known.has(calls[0].name), item.label);
      assert.equal(typeof calls[0].arguments, "object", item.label);
    }
  }

  const kimi = extractToolCallsFromAssistantText(
    "<|tool_call_begin|>functions.code_sandbox_status:0" +
      '<|tool_call_argument_begin|>{"detail":"full"}<|tool_call_end|>',
    known,
  );
  assert.equal(kimi[0].name, "code_sandbox_status");
  assert.deepEqual(kimi[0].arguments, { detail: "full" });

  const bare = extractToolCallsFromAssistantText(
    'web_search({"query": "x", "limit": 3})',
    known,
  );
  assert.deepEqual(bare[0].arguments, { query: "x", limit: 3 });
});

test("mixed prose with multiple vendor calls stays within the recovery cap", () => {
  const known = new Set(["web_search"]);
  const block = (query: string) =>
    `<tool_call>{"name":"web_search","arguments":{"query":"${query}"}}</tool_call>`;
  const calls = extractToolCallsFromAssistantText(
    `Intro. ${block("a")} middle ${block("b")} ${block("c")} ${block("d")} ${block("e")} outro`,
    known,
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((call) => call.index),
    [0, 1, 2, 3],
  );
});

test("one textual call parseable by two stages recovers exactly once", () => {
  const known = new Set(["web_search"]);
  const calls = extractToolCallsFromAssistantText(
    '<tool_call>{"name":"web_search","arguments":{"query":"solo"}}</tool_call>',
    known,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments, { query: "solo" });
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
