import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectMemorySignatureV1,
  createTrailingDebounce,
  shouldReloadProjectMemoryV1,
} from "../src/agent/projectMemoryReloadGate";

/*
 * Project-memory reload gate.
 *
 * A note switch reloads project memory only when the memory location or one
 * of its files actually changed; the signature comes from stats Obsidian
 * already holds, so an unchanged vault costs zero reads per click.
 */

const stats = (mtime: number, size = 10) => [
  { path: "Agent Memory/conversation-history.json", mtime, size },
  { path: "Agent Memory/research-memory-index.json", mtime: 1, size: 3 },
  { path: "Agent Memory/tool-outcome-memory.json", mtime: 2, size: 900 },
];

test("the first load always happens and an unchanged vault never reloads", () => {
  const signature = buildProjectMemorySignatureV1("Agent Memory", stats(5));
  assert.equal(shouldReloadProjectMemoryV1(null, signature), true);
  assert.equal(shouldReloadProjectMemoryV1(signature, signature), false);
});

test("a changed mtime, size, missing file, or different location reloads", () => {
  const base = buildProjectMemorySignatureV1("Agent Memory", stats(5));
  assert.equal(
    shouldReloadProjectMemoryV1(base, buildProjectMemorySignatureV1("Agent Memory", stats(6))),
    true,
  );
  assert.equal(
    shouldReloadProjectMemoryV1(base, buildProjectMemorySignatureV1("Agent Memory", stats(5, 11))),
    true,
  );
  assert.equal(
    shouldReloadProjectMemoryV1(
      base,
      buildProjectMemorySignatureV1("Agent Memory", [
        { path: "Agent Memory/conversation-history.json", mtime: null, size: null },
        ...stats(5).slice(1),
      ]),
    ),
    true,
  );
  assert.equal(
    shouldReloadProjectMemoryV1(base, buildProjectMemorySignatureV1("Research/Agent Memory", stats(5))),
    true,
  );
  // Order of the stat list does not matter.
  assert.equal(
    buildProjectMemorySignatureV1("Agent Memory", [...stats(5)].reverse()),
    base,
  );
});

test("the trailing debounce folds paired events into one call and can be cancelled", () => {
  const pending: Array<{ id: number; fn: () => void; delay: number }> = [];
  let nextId = 1;
  const timers = {
    set: (fn: () => void, delay: number) => {
      const id = nextId++;
      pending.push({ id, fn, delay });
      return id;
    },
    clear: (handle: unknown) => {
      const index = pending.findIndex((entry) => entry.id === handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  let calls = 0;
  const debounce = createTrailingDebounce(() => (calls += 1), 150, timers);

  // file-open and active-leaf-change both fire for one click.
  debounce.schedule();
  debounce.schedule();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.delay, 150);
  pending[0]!.fn();
  assert.equal(calls, 1);

  debounce.schedule();
  debounce.cancel();
  assert.equal(pending.length, 1, "cancel removes the pending timer");
  // The cleared handle is gone from the queue, so nothing fires.
  assert.equal(calls, 1);

  debounce.schedule();
  debounce.flush();
  assert.equal(calls, 2);
  debounce.flush();
  assert.equal(calls, 2, "flush without a pending call is a no-op");
});
