import test from "node:test";
import assert from "node:assert/strict";

import {
  createLinkedDeadlineSignal,
  getAbortSignalMessage,
} from "../src/orchestrator/deadline";

test("linked deadline aborts a worker with an observable budget reason", async () => {
  const parent = new AbortController();
  const deadline = createLinkedDeadlineSignal(parent.signal, 5, "worker budget exhausted");
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deadline.signal.aborted, true);
    assert.equal(
      getAbortSignalMessage(deadline.signal, "fallback"),
      "worker budget exhausted",
    );
  } finally {
    deadline.dispose();
  }
});

test("linked deadline propagates the parent abort reason", () => {
  const parent = new AbortController();
  const deadline = createLinkedDeadlineSignal(parent.signal, 60_000, "timeout");
  try {
    parent.abort(new Error("user stopped"));
    assert.equal(deadline.signal.aborted, true);
    assert.equal(getAbortSignalMessage(deadline.signal, "fallback"), "user stopped");
  } finally {
    deadline.dispose();
  }
});
