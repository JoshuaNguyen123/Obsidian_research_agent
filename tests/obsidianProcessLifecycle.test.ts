import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { terminateControlledObsidian } from "../scripts/obsidian-process-lifecycle";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("teardown asks the OS nothing directly — liveness comes from the shared CIM enumeration", () => {
  // This module used to answer "is our root still alive?" with
  // `tasklist /FI "PID eq <pid>"`, a filter this repo has documented as
  // unreliable, matched on PID + image name — which is not an identity inside
  // an Electron app where every process shares one image name. Reinstating any
  // tasklist readback here must fail loudly rather than in a 20-minute lane.
  const source = readFileSync(
    path.join(REPO_ROOT, "scripts", "obsidian-process-lifecycle.ts"),
    "utf8",
  )
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
  assert.doesNotMatch(source, /tasklist/iu);
  assert.doesNotMatch(source, /execFile/u);
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

test("the survivor sweep runs BEFORE the owned-exit recheck, so it can rescue it", async () => {
  // THE ORDERING DEFECT. The sweep used to run after the owned-exit recheck had
  // already returned its final verdict, so the one remediation this teardown
  // owns could never rescue the one probe a surviving ROOT fails. A fully
  // successful mission was therefore reported red for a process the harness had
  // just successfully reaped. On the unfixed tree the sweep is never reached
  // before the second owned-exit call and this rejects.
  const calls: string[] = [];
  let rootReaped = false;
  await terminateControlledObsidian(
    { pid: 4242, exitCode: null },
    {
      terminateOwnedTree: async () => {
        calls.push("terminate");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return rootReaped;
      },
      waitForNoRunningProcess: async (phase) => {
        calls.push(`process-drain:${phase}`);
        return rootReaped;
      },
      waitForCdpClose: async () => {
        calls.push("cdp-close");
        return true;
      },
      sweepSurvivingProcesses: async () => {
        calls.push("sweep");
        rootReaped = true;
      },
    },
  );

  assert.deepEqual(calls, [
    "terminate",
    "owned-exit:initial",
    "process-drain:initial",
    "cdp-close",
    "sweep",
    "owned-exit:recheck",
    "process-drain:recheck",
  ]);
});

test("the sweep still runs when CDP never closed — that is when the machine most needs it", async () => {
  // Remediation used to be gated on the CDP probe passing. A still-open CDP
  // port means the app is MORE alive, so skipping the sweep there leaked a
  // process into the next lane's already-running check.
  const calls: string[] = [];
  await assert.rejects(
    terminateControlledObsidian(
      { pid: 5150, exitCode: null },
      {
        terminateOwnedTree: async () => undefined,
        waitForOwnedExit: async () => true,
        waitForNoRunningProcess: async () => {
          calls.push("process-drain");
          return false;
        },
        waitForCdpClose: async () => false,
        sweepSurvivingProcesses: async () => {
          calls.push("sweep");
        },
      },
    ),
    /did not drain cleanly \(Obsidian process drain; CDP port close\)/u,
  );
  assert.deepEqual(calls, ["process-drain", "sweep", "process-drain"]);
});

test("what the sweep saw rides along in the teardown error", async () => {
  // A leaked child and a probe lying about a recycled PID produce the identical
  // "did not drain cleanly" sentence and need opposite fixes. The sweep's own
  // account of what it observed versus what it could reap is the discriminator,
  // and it must survive into the message a human reads.
  await assert.rejects(
    terminateControlledObsidian(
      { pid: 6060, exitCode: 1 },
      {
        terminateOwnedTree: async () => undefined,
        waitForOwnedExit: async () => true,
        waitForNoRunningProcess: async () => false,
        waitForCdpClose: async () => true,
        sweepSurvivingProcesses: async () =>
          "observed 4 Obsidian process(es); claimed 0 as owned",
      },
    ),
    (error: Error) => {
      // The parenthesised probe list stays the stable contract; diagnostics ride
      // outside it so existing readers keep matching.
      assert.match(
        error.message,
        /did not drain cleanly \(Obsidian process drain\)\./u,
      );
      assert.match(
        error.message,
        /Survivor sweep: observed 4 Obsidian process\(es\); claimed 0 as owned/u,
      );
      return true;
    },
  );
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

test("a graceful quit that exits the root replaces the owned-tree kill", async () => {
  // 2026-09-07: SecretStorage lives in DOMStorage, committed on a delay; a
  // taskkill inside that delay lost a rotated Linear OAuth pair that
  // data.json still referenced. Asking the app to quit lets Chromium commit
  // before the process is gone. The kill stays as the fallback only.
  const calls: string[] = [];
  await terminateControlledObsidian(
    { pid: 2468, exitCode: null },
    {
      requestGracefulExit: async () => {
        calls.push("graceful-request");
        return true;
      },
      terminateOwnedTree: async () => {
        calls.push("unexpected-terminate");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
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
  assert.deepEqual(calls, [
    "graceful-request",
    "owned-exit:graceful",
    "owned-exit:initial",
    "process-drain",
    "cdp-close",
  ]);
});

test("a graceful quit that does not finish in its bound hands the root to the kill unchanged", async () => {
  const calls: string[] = [];
  await terminateControlledObsidian(
    { pid: 1357, exitCode: null },
    {
      requestGracefulExit: async () => {
        calls.push("graceful-request");
        return true;
      },
      terminateOwnedTree: async (pid) => {
        calls.push(`terminate:${pid}`);
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return phase !== "graceful";
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
  assert.deepEqual(calls, [
    "graceful-request",
    "owned-exit:graceful",
    "terminate:1357",
    "owned-exit:initial",
  ]);
});

test("an undeliverable or throwing graceful request goes straight to the kill", async () => {
  for (const request of [async () => false, async () => { throw new Error("no bridge"); }]) {
    const calls: string[] = [];
    await terminateControlledObsidian(
      { pid: 8642, exitCode: null },
      {
        requestGracefulExit: request,
        terminateOwnedTree: async (pid) => {
          calls.push(`terminate:${pid}`);
        },
        waitForOwnedExit: async (phase) => {
          calls.push(`owned-exit:${phase}`);
          return true;
        },
        waitForNoRunningProcess: async () => true,
        waitForCdpClose: async () => true,
      },
    );
    assert.deepEqual(calls, ["terminate:8642", "owned-exit:initial"]);
  }
});

test("an already-exited root is never asked to quit", async () => {
  const calls: string[] = [];
  await terminateControlledObsidian(
    { pid: 9753, exitCode: 0 },
    {
      requestGracefulExit: async () => {
        calls.push("unexpected-graceful-request");
        return true;
      },
      terminateOwnedTree: async () => {
        calls.push("unexpected-terminate");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return true;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
  assert.deepEqual(calls, ["owned-exit:initial"]);
});
