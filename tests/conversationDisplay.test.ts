import assert from "node:assert/strict";
import test from "node:test";

import {
  projectConversationMessageForDisplayV1,
} from "../src/ui/conversationDisplay";
import type { AgentConversationMessage } from "../src/conversationHistory";

function project(history: AgentConversationMessage[]) {
  const counts = new Map<string, number>();
  return history.map((message) =>
    projectConversationMessageForDisplayV1(message, counts),
  );
}

test("persisted continuation history keeps compact deterministic attempt rows", () => {
  const history: AgentConversationMessage[] = [
    { role: "user", content: "Perform the original mission." },
    { role: "assistant", content: "The mission was interrupted." },
    { role: "user", content: "continue run run-root:one" },
    { role: "user", content: "continue run run-root:one" },
    { role: "user", content: "continue run run-child:two" },
  ];

  const firstRender = project(history);
  const secondRender = project(history);
  assert.deepEqual(secondRender, firstRender, "a persistence refresh must be stable");
  assert.deepEqual(
    firstRender.map((message) => ({
      content: message.content,
      runId: message.continuationRunId,
      attempt: message.continuationAttempt,
    })),
    [
      { content: "Perform the original mission.", runId: null, attempt: null },
      { content: "The mission was interrupted.", runId: null, attempt: null },
      { content: "Resuming mission — attempt 2", runId: "run-root:one", attempt: 2 },
      { content: "Resuming mission — attempt 3", runId: "run-root:one", attempt: 3 },
      { content: "Resuming mission — attempt 2", runId: "run-child:two", attempt: 2 },
    ],
  );
  assert.equal(history[2].content, "continue run run-root:one");
});
