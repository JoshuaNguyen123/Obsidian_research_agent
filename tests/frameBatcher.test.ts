import assert from "node:assert/strict";
import test from "node:test";
import {
  KeyedFrameBatcher,
  type FrameScheduler,
} from "../src/ui/frameBatcher";

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

test("KeyedFrameBatcher coalesces repeated work per key into one frame", () => {
  const controlled = controlledScheduler();
  const batcher = new KeyedFrameBatcher<string>(controlled.scheduler);
  const calls: string[] = [];

  batcher.schedule("message", () => calls.push("old"));
  batcher.schedule("message", () => calls.push("latest"));
  batcher.schedule("scroll", () => calls.push("scroll"));

  assert.equal(controlled.scheduledCount, 1);
  assert.equal(batcher.pendingCount, 2);
  assert.equal(controlled.runNext(), true);
  assert.deepEqual(calls, ["latest", "scroll"]);
  assert.equal(batcher.pendingCount, 0);
});

test("KeyedFrameBatcher flushes synchronously and cancellation drops stale work", () => {
  const controlled = controlledScheduler();
  const batcher = new KeyedFrameBatcher<string>(controlled.scheduler);
  const calls: string[] = [];

  batcher.schedule("assistant", () => calls.push("assistant"));
  batcher.schedule("thinking", () => calls.push("thinking"));
  batcher.flush("assistant");
  batcher.cancel("thinking");

  assert.deepEqual(calls, ["assistant"]);
  assert.equal(controlled.scheduledCount, 0);
  assert.equal(controlled.runNext(), false);
});
