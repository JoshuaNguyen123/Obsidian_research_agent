import test from "node:test";
import assert from "node:assert/strict";
import {
  appendConversationMessage,
  getConversationCharCount,
  normalizeConversationHistory,
  resolveConversationHistoryOnProjectLoadV1,
  toConversationModelMessages,
  trimConversationHistory,
  type AgentConversationMessage,
} from "../src/conversationHistory";

test("normalizes malformed saved conversation history to valid chat messages", () => {
  const history = normalizeConversationHistory([
    { role: "user", content: "Write an essay." },
    { role: "assistant", content: "Essay draft." },
    { role: "tool", content: "hidden tool result" },
    { role: "thinking", content: "hidden thinking" },
    { role: "status", content: "Planning..." },
    { role: "user", content: "" },
    { role: "assistant", content: 42 },
    null,
  ]);

  assert.deepEqual(history, [
    { role: "user", content: "Write an essay." },
    { role: "assistant", content: "Essay draft." },
  ]);
});

test("trims conversation history to newest messages by count", () => {
  const history = Array.from({ length: 5 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1}`,
  })) as AgentConversationMessage[];

  assert.deepEqual(
    trimConversationHistory(history, {
      maxMessages: 3,
      maxMessageChars: 100,
      maxTotalChars: 1_000,
    }),
    [
      { role: "user", content: "message 3" },
      { role: "assistant", content: "message 4" },
      { role: "user", content: "message 5" },
    ],
  );
});

test("trims conversation history by individual and total character caps", () => {
  const history = normalizeConversationHistory(
    [
      { role: "user", content: "a".repeat(10) },
      { role: "assistant", content: "b".repeat(10) },
      { role: "user", content: "c".repeat(30) },
    ],
    {
      maxMessages: 10,
      maxMessageChars: 12,
      maxTotalChars: 24,
    },
  );

  assert.equal(history.length, 2);
  assert.equal(history[0].content, "b".repeat(10));
  assert.equal(history[1].content.length, 12);
  assert.ok(history[1].content.startsWith("c"));
  assert.ok(getConversationCharCount(history) <= 24);
});

test("appendConversationMessage preserves bounded history and clear-to-empty behavior", () => {
  const history = appendConversationMessage(
    [{ role: "user", content: "previous" }],
    { role: "assistant", content: "reply" },
    {
      maxMessages: 1,
      maxMessageChars: 100,
      maxTotalChars: 100,
    },
  );

  assert.deepEqual(history, [{ role: "assistant", content: "reply" }]);
  assert.deepEqual(normalizeConversationHistory([]), []);
});

test("loading a folder with no history file does not keep the previous folder transcript", () => {
  const previousFolderChat: AgentConversationMessage[] = [
    { role: "user", content: "secret from folder A" },
    { role: "assistant", content: "reply in folder A" },
  ];
  assert.deepEqual(
    resolveConversationHistoryOnProjectLoadV1({
      folderScoped: true,
      folderHistory: null,
      pluginDataHistory: previousFolderChat,
    }),
    [],
  );
});

test("vault-root sessions keep data.json when no project folder is active", () => {
  const pluginData: AgentConversationMessage[] = [
    { role: "user", content: "root chat" },
  ];
  assert.deepEqual(
    resolveConversationHistoryOnProjectLoadV1({
      folderScoped: false,
      folderHistory: null,
      pluginDataHistory: pluginData,
    }),
    pluginData,
  );
});

test("toConversationModelMessages emits only user and assistant model messages", () => {
  assert.deepEqual(
    toConversationModelMessages([
      { role: "user", content: "Original essay request" },
      { role: "assistant", content: "Original essay" },
    ]),
    [
      { role: "user", content: "Original essay request" },
      { role: "assistant", content: "Original essay" },
    ],
  );
});
