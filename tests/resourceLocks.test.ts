import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireResourceLocks,
  createResourceLockState,
  normalizeResourceLockState,
  pruneExpiredResourceLocks,
  releaseResourceLocks,
  renewResourceLocks,
} from "../src/agent/queue/resourceLocks";

const T0 = "2026-07-11T12:00:00.000Z";

test("resource lock acquisition is atomic across Linear and repository resources", () => {
  const initial = createResourceLockState(T0);
  const acquired = acquireResourceLocks(initial, {
    resourceKeys: ["repository:research-agent", "linear:issue:issue-1"],
    ownerId: "worker-1",
    at: T0,
    leaseMs: 60_000,
  });
  assert.equal(acquired.accepted, true);
  assert.match(acquired.token!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.keys(acquired.state.locks).length, 2);
  assert.equal(initial.revision, 0);

  const conflict = acquireResourceLocks(acquired.state, {
    resourceKeys: ["linear:issue:issue-2", "repository:research-agent"],
    ownerId: "worker-2",
    at: "2026-07-11T12:00:30.000Z",
    leaseMs: 60_000,
  });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.state, acquired.state);
  assert.deepEqual(conflict.conflicts, ["repository:research-agent"]);
  assert.equal(conflict.state.locks["linear:issue:issue-2"], undefined);
});

test("lock renewal and release require the exact owner and token", () => {
  const acquired = acquireResourceLocks(createResourceLockState(T0), {
    resourceKeys: ["linear:issue:issue-1", "repository:research-agent"],
    ownerId: "worker-1",
    at: T0,
    leaseMs: 60_000,
  });
  const wrongToken = `sha256:${"0".repeat(64)}`;
  const rejected = renewResourceLocks(acquired.state, {
    resourceKeys: ["linear:issue:issue-1", "repository:research-agent"],
    ownerId: "worker-1",
    token: wrongToken,
    at: "2026-07-11T12:00:30.000Z",
    leaseMs: 60_000,
  });
  assert.equal(rejected.accepted, false);

  const renewed = renewResourceLocks(acquired.state, {
    resourceKeys: ["linear:issue:issue-1", "repository:research-agent"],
    ownerId: "worker-1",
    token: acquired.token!,
    at: "2026-07-11T12:00:30.000Z",
    leaseMs: 120_000,
  });
  assert.equal(renewed.accepted, true);
  assert.equal(
    renewed.state.locks["repository:research-agent"].expiresAt,
    "2026-07-11T12:02:30.000Z",
  );

  const released = releaseResourceLocks(renewed.state, {
    resourceKeys: ["linear:issue:issue-1", "repository:research-agent"],
    ownerId: "worker-1",
    token: acquired.token!,
    at: "2026-07-11T12:00:45.000Z",
  });
  assert.equal(released.accepted, true);
  assert.deepEqual(Object.keys(released.state.locks), []);
});

test("expired locks can be pruned and safely reacquired", () => {
  const acquired = acquireResourceLocks(createResourceLockState(T0), {
    resourceKeys: ["repository:research-agent"],
    ownerId: "worker-1",
    at: T0,
    leaseMs: 1_000,
  });
  const pruned = pruneExpiredResourceLocks(
    acquired.state,
    "2026-07-11T12:00:01.000Z",
  );
  assert.deepEqual(Object.keys(pruned.locks), []);
  assert.deepEqual(
    normalizeResourceLockState(JSON.parse(JSON.stringify(pruned))),
    pruned,
  );
  const reacquired = acquireResourceLocks(pruned, {
    resourceKeys: ["repository:research-agent"],
    ownerId: "worker-2",
    at: "2026-07-11T12:00:01.000Z",
    leaseMs: 1_000,
  });
  assert.equal(reacquired.accepted, true);
});
