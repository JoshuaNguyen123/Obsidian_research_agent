import assert from "node:assert/strict";
import test from "node:test";
import { type FrameScheduler } from "../src/ui/frameBatcher";
import { createRunDetailsFrameBatcher } from "../src/ui/runDetailsBatcher";

function controlledScheduler() {
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request(callback) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      callbacks.delete(handle);
    },
  };
  return {
    scheduler,
    runNext() {
      const entry = callbacks.entries().next().value as
        | [number, () => void]
        | undefined;
      if (!entry) return false;
      callbacks.delete(entry[0]);
      entry[1]();
      return true;
    },
    get scheduledCount() {
      return callbacks.size;
    },
  };
}

test("Run Details trace and graph DOM coalesce to one frame each", () => {
  const controlled = controlledScheduler();
  const batcher = createRunDetailsFrameBatcher(controlled.scheduler);
  const calls: string[] = [];

  batcher.scheduleTrace(() => calls.push("trace-old"));
  batcher.scheduleTrace(() => calls.push("trace-latest"));
  batcher.scheduleGraph(() => calls.push("graph-old"));
  batcher.scheduleGraph(() => calls.push("graph-latest"));

  assert.equal(controlled.scheduledCount, 1);
  assert.equal(batcher.pendingCount, 2);
  assert.equal(controlled.runNext(), true);
  assert.deepEqual(calls, ["trace-latest", "graph-latest"]);
  assert.equal(batcher.pendingCount, 0);
});

test("Run Details flush applies the latest scheduled trace immediately", () => {
  const controlled = controlledScheduler();
  const batcher = createRunDetailsFrameBatcher(controlled.scheduler);
  const calls: string[] = [];

  batcher.scheduleTrace(() => calls.push("trace"));
  batcher.scheduleGraph(() => calls.push("graph"));
  batcher.flushTrace();

  assert.deepEqual(calls, ["trace"]);
  assert.equal(controlled.runNext(), true);
  assert.deepEqual(calls, ["trace", "graph"]);
});
