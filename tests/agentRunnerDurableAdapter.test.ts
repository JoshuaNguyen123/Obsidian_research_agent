import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDurableOutcomeFromAgentRunner,
  isTransientAgentRunError,
} from "../src/agent/agentRunnerDurableAdapter";

test("durable adapter continues only productive budget completions", () => {
  const productive = buildDurableOutcomeFromAgentRunner({
    segmentId: "run-1",
    toolCalls: 7,
    complete: {
      step: 100,
      maxSteps: 100,
      stopReason: "budget",
      autoContinueRecommended: true,
      autoContinueReason: "budget_exhausted",
    },
  });
  assert.equal(productive.productive, true);
  assert.equal(productive.continuation?.recommended, true);
  assert.equal(productive.modelSteps, 100);
  assert.equal(productive.toolCalls, 7);

  const stalled = buildDurableOutcomeFromAgentRunner({
    toolCalls: 0,
    complete: {
      step: 100,
      maxSteps: 100,
      stopReason: "budget",
      autoContinueRecommended: false,
    },
  });
  assert.equal(stalled.productive, false);
  assert.equal(stalled.continuation?.recommended, false);
});

test("durable adapter accepts terminal proof and pauses clarification", () => {
  assert.equal(
    buildDurableOutcomeFromAgentRunner({
      toolCalls: 1,
      complete: { step: 4, maxSteps: 100, stopReason: "write_completed" },
    }).accepted,
    true,
  );
  assert.equal(
    buildDurableOutcomeFromAgentRunner({
      toolCalls: 0,
      complete: { step: 2, maxSteps: 100, stopReason: "clarifying_question" },
    }).safetyPause?.code,
    "clarification_required",
  );
});

test("durable adapter retries only transient errors", () => {
  assert.equal(
    isTransientAgentRunError({ code: "model_error", message: "HTTP 503 unavailable" }),
    true,
  );
  assert.equal(
    isTransientAgentRunError({ code: "auth_error", message: "API key missing" }),
    false,
  );
  const transient = buildDurableOutcomeFromAgentRunner({
    toolCalls: 0,
    complete: { step: 3, maxSteps: 100, stopReason: "error" },
    lastError: { code: "network_error", message: "connection timed out" },
  });
  assert.equal(transient.transientFailure?.code, "network_error");
});

test("durable adapter promotes unresolved approval and unsafe WAL", () => {
  const approval = buildDurableOutcomeFromAgentRunner({
    complete: { step: 2, maxSteps: 100, stopReason: "error" },
    toolCalls: 0,
    pendingApproval: { id: "approval-1", summary: "Approve upload" },
  });
  assert.deepEqual(approval.approval, {
    id: "approval-1",
    summary: "Approve upload",
  });

  const unsafe = buildDurableOutcomeFromAgentRunner({
    complete: { step: 2, maxSteps: 100, stopReason: "final" },
    toolCalls: 1,
    unsafeWalIds: ["op-1", "op-1", "op-2"],
    unsafeWalMessage: "Inspect before replay.",
  });
  assert.deepEqual(unsafe.unsafeWal, {
    operationIds: ["op-1", "op-2"],
    message: "Inspect before replay.",
  });
  assert.equal(unsafe.accepted, undefined);
});
