import assert from "node:assert/strict";
import test from "node:test";
import {
  ClarificationBroker,
  type ClarificationRequest,
} from "../src/agent/clarificationBroker";
import { askUserTool } from "../src/tools/clarificationTools";
import type { ToolExecutionContext } from "../src/tools/types";

test("a pending question resolves with the user's answer", async () => {
  const broker = new ClarificationBroker();
  const seen: ClarificationRequest[] = [];
  const outcome = broker.request(
    { runId: "run-1", question: "Which note did you mean?", options: ["Alpha", "Beta"] },
    { onRequest: (request) => { seen.push(request); } },
  );
  await Promise.resolve();
  const pending = seen[0];
  assert.ok(pending);
  assert.equal(pending.options.length, 2);
  assert.equal(broker.answer(pending.id, "  Alpha  "), true);
  assert.deepEqual(await outcome, { status: "answered", answer: "Alpha" });
  assert.equal(broker.getPending().length, 0);
});

test("skipping leaves the run free to proceed on its assumption", async () => {
  const broker = new ClarificationBroker();
  let id = "";
  const outcome = broker.request(
    { runId: "run-2", question: "Weekly or monthly?", options: [] },
    { onRequest: (request) => { id = request.id; } },
  );
  await Promise.resolve();
  assert.equal(broker.skip(id), true);
  assert.deepEqual(await outcome, { status: "skipped" });
});

test("an unanswered question expires instead of hanging the run", async () => {
  const broker = new ClarificationBroker();
  const outcome = await broker.request(
    { runId: "run-3", question: "Still there?", options: [] },
    { timeoutMs: 1 },
  );
  assert.deepEqual(outcome, { status: "expired" });
});

test("an aborted run settles its pending question", async () => {
  const broker = new ClarificationBroker();
  const controller = new AbortController();
  const outcome = broker.request(
    { runId: "run-4", question: "Which folder?", options: [] },
    { abortSignal: controller.signal },
  );
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await outcome, { status: "aborted" });
});

test("options are de-duplicated, trimmed, and capped at four", async () => {
  const broker = new ClarificationBroker();
  const seen: ClarificationRequest[] = [];
  const outcome = broker.request(
    {
      runId: "run-5",
      question: "Pick one",
      options: ["  A  ", "a", "B", "C", "D", "E"],
    },
    { onRequest: (request) => { seen.push(request); } },
  );
  await Promise.resolve();
  const pending = seen[0]!;
  assert.deepEqual(pending.options, ["A", "B", "C", "D"]);
  broker.skip(pending.id);
  await outcome;
});

test("an empty answer or unknown id never resolves a question", async () => {
  const broker = new ClarificationBroker();
  let id = "";
  const outcome = broker.request(
    { runId: "run-6", question: "Which one?", options: [] },
    { onRequest: (request) => { id = request.id; } },
  );
  await Promise.resolve();
  assert.equal(broker.answer(id, "   "), false);
  assert.equal(broker.answer("clarification-nope-1", "hi"), false);
  assert.equal(broker.skip(id), true);
  await outcome;
});

test("ask_user returns the answer as intent, not authority", async () => {
  const context = {
    requestUserClarification: async () => ({
      status: "answered" as const,
      answer: "Use the quarterly note",
    }),
  } as unknown as ToolExecutionContext;
  const result = (await askUserTool.execute(
    { question: "Which note?", options: ["Quarterly", "Monthly"] },
    context,
  )) as Record<string, unknown>;
  assert.equal(result.answered, true);
  assert.equal(result.answer, "Use the quarterly note");
  assert.match(String(result.guidance), /does not authorize/i);
});

test("ask_user proceeds on its assumption with no interactive host", async () => {
  const result = (await askUserTool.execute(
    { question: "Which note?", assumption: "the active note" },
    {} as ToolExecutionContext,
  )) as Record<string, unknown>;
  assert.equal(result.answered, false);
  assert.equal(result.reason, "no_interactive_user");
  assert.match(String(result.guidance), /the active note/);
});

test("ask_user tells the model how to continue when the user does not answer", async () => {
  const context = {
    requestUserClarification: async () => ({ status: "expired" as const }),
  } as unknown as ToolExecutionContext;
  const result = (await askUserTool.execute(
    { question: "Weekly or monthly?", assumption: "weekly" },
    context,
  )) as Record<string, unknown>;
  assert.equal(result.answered, false);
  assert.equal(result.reason, "expired");
  assert.match(String(result.guidance), /Proceed with: weekly/);
});
