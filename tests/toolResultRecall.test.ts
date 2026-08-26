import assert from "node:assert/strict";
import test from "node:test";
import { createToolResultStoreV1 } from "../src/agent/toolResultStore";
import { compactLoopMessages } from "../src/agent/runContext";
import { recallToolResultTool } from "../src/tools/recallTools";
import type { ModelChatMessage } from "../src/model/types";
import type { MissionLedger } from "../src/agent/missionLedger";
import type { ToolExecutionContext } from "../src/tools/types";

/*
 * Compaction as a reference, not a deletion.
 *
 * shrinkToolMessageForCompaction rewrites an oversized tool result down to a
 * whitelist of chaining keys, and the original used to be gone from the run.
 * The agent could not reopen evidence it had already paid a tool call to fetch,
 * so it refetched -- which grew the prompt and triggered more compaction.
 */

const ledger = { runId: "run-1", steps: [], evidence: [] } as unknown as MissionLedger;

function bigToolMessages(turns: number): ModelChatMessage[] {
  const messages: ModelChatMessage[] = [{ role: "system", content: "SYSTEM" }];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "assistant", content: `step ${index}` });
    messages.push({
      role: "tool",
      content: JSON.stringify({
        ok: true,
        findings: `unique-marker-${index} ${"x".repeat(4000)}`,
      }),
    });
  }
  return messages;
}

test("a stashed payload comes back whole", () => {
  const store = createToolResultStoreV1("run-1");
  const key = store.stash({ toolName: "web_fetch", step: 3, content: "full body" });

  assert.equal(key, "tr_run-1_1");
  const recalled = store.recall(key);
  assert.equal(recalled.status, "found");
  assert.equal(recalled.content, "full body");
  assert.equal(recalled.toolName, "web_fetch");
  assert.equal(recalled.step, 3);
});

test("a query returns only matching lines, with line numbers", () => {
  const store = createToolResultStoreV1("run-1");
  const key = store.stash({
    toolName: "web_fetch",
    step: 1,
    content: ["alpha", "beta matters", "gamma", "beta again"].join("\n"),
  });

  const recalled = store.recall(key, { query: "beta" });
  assert.deepEqual(recalled.matchLines, [2, 4]);
  assert.match(recalled.content ?? "", /2: beta matters/u);
  // Searching is the cheap path: recall exists to reopen a payload, not to
  // flood the prompt with it again.
  assert.ok(!recalled.content?.includes("alpha"));
});

test("an evicted key is distinguished from a key that never existed", () => {
  const store = createToolResultStoreV1("run-1", { maxChars: 100 });
  const first = store.stash({ toolName: "a", step: 1, content: "x".repeat(80) });
  store.stash({ toolName: "b", step: 2, content: "y".repeat(80) });

  // These are different problems: one is a real limit to route around, the
  // other is a hallucinated key. Collapsing them would teach the model the
  // wrong lesson.
  assert.equal(store.recall(first).status, "evicted");
  assert.equal(store.recall("tr_run-1_999").status, "unknown");
  assert.match(store.recall(first).message ?? "", /Re-run the tool/u);
});

test("compaction stashes what it shrinks and says how to get it back", () => {
  const store = createToolResultStoreV1("run-1");
  const messages = bigToolMessages(12);

  const compacted = compactLoopMessages({
    messages,
    ledger,
    keepRecentSteps: 2,
    maxPromptChars: 8_000,
    stash: (content) => store.stash({ toolName: "t", step: 0, content }),
  });

  assert.equal(compacted.applied, true);
  const slim = compacted.messages.find(
    (message) => message.role === "tool" && message.content.includes("recallKey"),
  );
  assert.ok(slim, "a shrunk tool message should carry a recall key");

  const parsed = JSON.parse(slim.content) as {
    recallKey: string;
    recallHint: string;
  };
  // Spelled out, not just a bare identifier: a smaller tool-trained model will
  // not infer an affordance from an opaque key.
  assert.match(parsed.recallHint, /recall_tool_result/u);

  const recalled = store.recall(parsed.recallKey);
  assert.equal(recalled.status, "found");
  assert.match(recalled.content ?? "", /unique-marker-0/u);
});

test("without a stash, compaction stays exactly as destructive as before", () => {
  const compacted = compactLoopMessages({
    messages: bigToolMessages(12),
    ledger,
    keepRecentSteps: 2,
    maxPromptChars: 8_000,
  });

  assert.equal(compacted.applied, true);
  // Unit callers and any path that has not adopted a store must be unaffected.
  assert.ok(
    !compacted.messages.some((message) => message.content.includes("recallKey")),
  );
});

test("the tool reports an absent store honestly rather than as an error", async () => {
  const result = (await recallToolResultTool.execute(
    { key: "tr_run-1_1" },
    { runtimeCache: {} } as unknown as ToolExecutionContext,
  )) as { status: string; message: string };

  assert.equal(result.status, "unavailable");
  assert.match(result.message, /nothing to recall/u);
});

test("the tool round-trips a stashed payload through a real store", async () => {
  const store = createToolResultStoreV1("run-1");
  const key = store.stash({
    toolName: "web_fetch",
    step: 2,
    content: "line one\nthe answer is 42\nline three",
  });

  const result = (await recallToolResultTool.execute(
    { key, query: "answer" },
    { toolResultStore: store } as unknown as ToolExecutionContext,
  )) as { status: string; content: string; matchLines: number[] };

  assert.equal(result.status, "found");
  assert.deepEqual(result.matchLines, [2]);
  assert.match(result.content, /the answer is 42/u);
});
