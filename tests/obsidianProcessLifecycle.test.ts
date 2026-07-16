import assert from "node:assert/strict";
import test from "node:test";
import {
  tasklistContainsProcessId,
  terminateControlledObsidian,
} from "../scripts/obsidian-process-lifecycle";

test("owned process readback matches only the exact tasklist PID row", () => {
  const tasklist = [
    '"Obsidian.exe","1234","Console","1","100,000 K"',
    '"Obsidian.exe","91234","Console","1","100,000 K"',
  ].join("\r\n");
  assert.equal(tasklistContainsProcessId(tasklist, 1234), true);
  assert.equal(tasklistContainsProcessId(tasklist, 234), false);
  assert.equal(tasklistContainsProcessId(tasklist, 91234), true);
  assert.equal(
    tasklistContainsProcessId("INFO: No tasks are running which match the specified criteria.", 1234),
    false,
  );
});

test("controlled Obsidian teardown targets only its owned PID and rejects an incomplete drain", async () => {
  const calls: string[] = [];

  await assert.rejects(
    terminateControlledObsidian(
      { pid: 1234, exitCode: null },
      {
        terminateOwnedTree: async (pid) => {
          calls.push(`terminate:${pid}`);
        },
        waitForOwnedExit: async () => {
          calls.push("owned-exit");
          return true;
        },
        waitForNoRunningProcess: async () => {
          calls.push("process-drain");
          return false;
        },
        waitForCdpClose: async () => {
          calls.push("cdp-close");
          return true;
        },
      },
    ),
    /Controlled Obsidian teardown did not drain cleanly \(Obsidian process drain\)/u,
  );

  assert.deepEqual(calls, [
    "terminate:1234",
    "owned-exit",
    "process-drain",
    "cdp-close",
  ]);
});

test("an already-exited controlled root still requires process and CDP readback", async () => {
  const calls: string[] = [];

  await terminateControlledObsidian(
    { pid: 5678, exitCode: 0 },
    {
      terminateOwnedTree: async () => {
        calls.push("unexpected-terminate");
      },
      waitForOwnedExit: async () => {
        calls.push("owned-exit");
        return true;
      },
      waitForNoRunningProcess: async () => {
        calls.push("process-drain");
        return true;
      },
      waitForCdpClose: async () => {
        calls.push("cdp-close");
        return true;
      },
    },
  );

  assert.deepEqual(calls, ["owned-exit", "process-drain", "cdp-close"]);
});

test("a PID-tree dispatch race is accepted only when every shutdown readback is clean", async () => {
  await terminateControlledObsidian(
    { pid: 9012, exitCode: null },
    {
      terminateOwnedTree: async () => {
        throw new Error("process exited during taskkill");
      },
      waitForOwnedExit: async () => true,
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
});
