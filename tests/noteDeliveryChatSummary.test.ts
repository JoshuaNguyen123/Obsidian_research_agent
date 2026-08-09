import assert from "node:assert/strict";
import test from "node:test";

import { buildNoteDeliveryChatSummaryV1 } from "../src/agent/noteDeliveryChatSummary";

test("new-note reports persist a concise Chat link and verified receipt", () => {
  const summary = buildNoteDeliveryChatSummaryV1({
    fullContent: "# Agent Orchestration Guide\n\nA very long report.",
    noteOutputPlan: {
      destination: "new_note",
      mutation: "create",
      delivery: "stream",
      title: "automatic",
      reason: "untargeted_content_create",
    },
    receipts: [
      {
        toolName: "append_to_current_file",
        operation: "append",
        path: "Agent Orchestration Guide.md",
        bytesWritten: 4096,
        message: "append Agent Orchestration Guide.md",
        readback: {
          status: "verified",
          checkedAt: "2026-08-07T00:00:00.000Z",
        },
      },
    ],
  });
  assert.match(summary, /\[\[Agent Orchestration Guide\.md\|Agent Orchestration Guide\]\]/u);
  assert.match(summary, /4096 bytes written/u);
  assert.match(summary, /readback verified/u);
  assert.doesNotMatch(summary, /very long report/u);
});

test("Chat-only and unverified output remain honest", () => {
  const content = "Answer in Chat";
  assert.equal(
    buildNoteDeliveryChatSummaryV1({
      fullContent: content,
      noteOutputPlan: {
        destination: "chat",
        mutation: "append",
        delivery: "atomic",
        title: "preserve",
        reason: "force_chat_only",
      },
      receipts: [],
    }),
    content,
  );
});
