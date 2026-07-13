import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PARALLEL_MISSION_READ_NODES,
  missionNodeRequiresExclusiveResourceLock,
  selectMissionNodeBatch,
  type SchedulableMissionEffect,
  type SchedulableMissionNode,
} from "../packages/headless-runtime/src/missionScheduler";

test("scheduler overlaps at most three descriptor-approved reads", () => {
  const batch = selectMissionNodeBatch({
    nodes: [1, 2, 3, 4].map((index) => node(`read-${index}`, "read", true)),
  });
  assert.equal(MAX_PARALLEL_MISSION_READ_NODES, 3);
  assert.deepEqual(batch, {
    nodeIds: ["read-1", "read-2", "read-3"],
    mode: "parallel_read",
    requiresExclusiveResourceLock: false,
  });
});

test("a non-parallel-safe read remains serial and stops the adjacent batch", () => {
  const firstSerial = selectMissionNodeBatch({
    nodes: [node("serial", "read", false), node("parallel", "read", true)],
  });
  assert.deepEqual(firstSerial.nodeIds, ["serial"]);
  assert.equal(firstSerial.mode, "serial");

  const afterParallel = selectMissionNodeBatch({
    nodes: [
      node("parallel", "read", true),
      node("serial", "read", false),
      node("later", "read", true),
    ],
  });
  assert.deepEqual(afterParallel.nodeIds, ["parallel"]);
});

test("mutations and external actions serialize and require a resource lock", () => {
  for (const effect of [
    "reversible_mutation",
    "destructive_mutation",
    "execution",
    "publish",
  ] as const) {
    const descriptor = { effect, execution: { parallelSafe: false } };
    const batch = selectMissionNodeBatch({
      nodes: [
        node(`${effect}-1`, effect, false),
        node(`${effect}-2`, effect, false),
      ],
    });
    assert.deepEqual(batch.nodeIds, [`${effect}-1`]);
    assert.equal(batch.requiresExclusiveResourceLock, true);
    assert.equal(missionNodeRequiresExclusiveResourceLock(descriptor), true);
  }
});

test("an active resource lock keeps the node out of the ready batch", () => {
  const batch = selectMissionNodeBatch({
    nodes: [
      node("locked", "read", true, ["vault:note:locked.md"]),
      node("free", "read", true, ["vault:note:free.md"]),
    ],
    lockedResourceKeys: new Set(["vault:note:locked.md"]),
  });
  assert.deepEqual(batch.nodeIds, ["free"]);
});

function node(
  id: string,
  effect: SchedulableMissionEffect,
  parallelSafe: boolean,
  resourceKeys: string[] = [`fixture:${id}`],
): SchedulableMissionNode {
  return {
    id,
    status: "ready",
    descriptor: { effect, execution: { parallelSafe } },
    resourceKeys,
  };
}
