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

test("an image-scoped readback never matches a foreign process on a recycled PID", () => {
  const foreign = '"notepad.exe","1234","Console","1","10,000 K"';
  const owned = '"Obsidian.exe","1234","Console","1","100,000 K"';
  assert.equal(tasklistContainsProcessId(foreign, 1234, "Obsidian.exe"), false);
  assert.equal(tasklistContainsProcessId(owned, 1234, "Obsidian.exe"), true);
  // Without an expected image the historical bare-PID behavior is preserved.
  assert.equal(tasklistContainsProcessId(foreign, 1234), true);
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
    "process-drain",
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

test("controlled teardown reconciles an owned-PID boundary race after app drain", async () => {
  let ownedExitChecks = 0;
  await terminateControlledObsidian(
    { pid: 3456, exitCode: null },
    {
      terminateOwnedTree: async () => undefined,
      waitForOwnedExit: async () => {
        ownedExitChecks += 1;
        return ownedExitChecks === 2;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );

  assert.equal(ownedExitChecks, 2);
});

test("controlled teardown reconciles a terminal Windows process-drain boundary race", async () => {
  let ownedExitChecks = 0;
  let processDrainChecks = 0;
  await terminateControlledObsidian(
    { pid: 4567, exitCode: null },
    {
      terminateOwnedTree: async () => undefined,
      waitForOwnedExit: async () => {
        ownedExitChecks += 1;
        return ownedExitChecks === 2;
      },
      waitForNoRunningProcess: async () => {
        processDrainChecks += 1;
        return processDrainChecks === 2;
      },
      waitForCdpClose: async () => true,
    },
  );

  assert.equal(ownedExitChecks, 2);
  assert.equal(processDrainChecks, 2);
});

test("controlled teardown still rejects a live owned PID after terminal recheck", async () => {
  let ownedExitChecks = 0;
  await assert.rejects(
    terminateControlledObsidian(
      { pid: 7890, exitCode: null },
      {
        terminateOwnedTree: async () => undefined,
        waitForOwnedExit: async () => {
          ownedExitChecks += 1;
          return false;
        },
        waitForNoRunningProcess: async () => true,
        waitForCdpClose: async () => true,
      },
    ),
    /Controlled Obsidian teardown did not drain cleanly \(owned process exit\)/u,
  );

  assert.equal(ownedExitChecks, 2);
});

test("controlled teardown still rejects a live Obsidian process after terminal recheck", async () => {
  let processDrainChecks = 0;
  await assert.rejects(
    terminateControlledObsidian(
      { pid: 8901, exitCode: null },
      {
        terminateOwnedTree: async () => undefined,
        waitForOwnedExit: async () => true,
        waitForNoRunningProcess: async () => {
          processDrainChecks += 1;
          return false;
        },
        waitForCdpClose: async () => true,
      },
    ),
    /Controlled Obsidian teardown did not drain cleanly \(Obsidian process drain\)/u,
  );

  assert.equal(processDrainChecks, 2);
});

test("a drain failure sweeps orphaned survivors before the terminal recheck", async () => {
  const calls: string[] = [];
  let processDrainChecks = 0;
  await terminateControlledObsidian(
    { pid: 2468, exitCode: 1 },
    {
      terminateOwnedTree: async () => {
        calls.push("unexpected-terminate");
      },
      waitForOwnedExit: async () => true,
      waitForNoRunningProcess: async () => {
        processDrainChecks += 1;
        calls.push(`process-drain:${processDrainChecks}`);
        // Survivors drain only after the sweep killed them.
        return processDrainChecks === 2;
      },
      waitForCdpClose: async () => true,
      sweepSurvivingProcesses: async () => {
        calls.push("sweep");
      },
    },
  );

  assert.deepEqual(calls, ["process-drain:1", "sweep", "process-drain:2"]);
});

test("a failing survivor sweep still defers to the terminal drain recheck", async () => {
  let processDrainChecks = 0;
  await assert.rejects(
    terminateControlledObsidian(
      { pid: 1357, exitCode: 1 },
      {
        terminateOwnedTree: async () => undefined,
        waitForOwnedExit: async () => true,
        waitForNoRunningProcess: async () => {
          processDrainChecks += 1;
          return false;
        },
        waitForCdpClose: async () => true,
        sweepSurvivingProcesses: async () => {
          throw new Error("tasklist unavailable");
        },
      },
    ),
    /Controlled Obsidian teardown did not drain cleanly \(Obsidian process drain\)/u,
  );

  assert.equal(processDrainChecks, 2);
});
