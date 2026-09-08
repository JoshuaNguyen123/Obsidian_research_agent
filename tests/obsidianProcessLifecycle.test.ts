import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  selectOwnedObsidianPidsV1,
  type ObsidianProcessRowV1,
} from "../scripts/e2e-obsidian-sweep";
import {
  createTeardownOwnershipWindow,
  terminateControlledObsidian,
  type ControlledObsidianTeardownOperations,
  type TeardownOwnershipWindow,
} from "../scripts/obsidian-process-lifecycle";
import {
  gracefulQuitMayHaveReachedAppV1,
  requestGracefulObsidianQuitV1,
  type GracefulQuitOutcome,
  type GracefulQuitPageLike,
} from "../e2e/fixtures/gracefulObsidianQuit";

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

test("the ownership window stays open across the graceful quit and closes exactly once", () => {
  let now = 1_000;
  const ownership = createTeardownOwnershipWindow(() => now);

  // While the app is alive by our own choice, the bound has to keep up with it:
  // anything Obsidian spawns during the graceful window is still ours.
  assert.equal(ownership.isClosed(), false);
  assert.equal(ownership.upperBoundMs(), 1_000);
  now = 4_000;
  assert.equal(ownership.upperBoundMs(), 4_000);

  // Once the kill phase begins the bound freezes, and it never re-stamps: a
  // bound that kept moving would keep widening what this teardown is entitled
  // to kill, and nothing born after the graceful window can be ours.
  assert.equal(ownership.close(), 4_000);
  now = 9_000;
  assert.equal(ownership.isClosed(), true);
  assert.equal(ownership.upperBoundMs(), 4_000);
  assert.equal(ownership.close(), 4_000);
});

test("the ownership window closes after the graceful wait and before the kill", async () => {
  // THE OWNERSHIP-DRIFT DEFECT. The bound used to be stamped when teardown
  // began, before the app had even been ASKED to quit — so every helper the
  // still-live app spawned during the graceful window was born outside it and
  // disowned. On the unfixed tree there is no such call at all and this fails.
  const calls: string[] = [];
  await terminateControlledObsidian(
    { pid: 1122, exitCode: null },
    {
      requestGracefulExit: async () => {
        calls.push("graceful-request");
        return true;
      },
      closeOwnershipWindow: () => {
        calls.push("close-ownership-window");
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
    "close-ownership-window",
    "terminate:1122",
    "owned-exit:initial",
  ]);
});

test("the ownership window closes exactly once, whether or not anything is killed", async () => {
  // A graceful quit that worked skips the kill entirely, but the survivor sweep
  // and both drain probes still run — and they resolve ownership against this
  // bound, so it has to be stamped on that path too. A teardown with no
  // graceful quit at all stamps it at the same instant teardown began, which is
  // exactly the old behaviour: nothing moves where nothing kept the app alive.
  const run = async (gracefulExitSucceeds: boolean | null): Promise<string[]> => {
    const calls: string[] = [];
    const operations = {
      closeOwnershipWindow: () => {
        calls.push("close-ownership-window");
      },
      terminateOwnedTree: async () => {
        calls.push("terminate");
      },
      waitForOwnedExit: async () => true,
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    };
    await terminateControlledObsidian(
      { pid: 3344, exitCode: null },
      gracefulExitSucceeds === null
        ? operations
        : { ...operations, requestGracefulExit: async () => gracefulExitSucceeds },
    );
    return calls;
  };

  assert.deepEqual(await run(true), ["close-ownership-window"]);
  assert.deepEqual(await run(false), ["close-ownership-window", "terminate"]);
  assert.deepEqual(await run(null), ["close-ownership-window", "terminate"]);
});

/**
 * The ownership window only matters if the resolver downstream of it changes
 * its answer, so these drive the REAL selector rather than a restatement of it:
 * the fix is a boundary the harness feeds to selectOwnedObsidianPidsV1, and a
 * producer proven only against its own idea of the boundary proves nothing.
 */
const OUR_PORT = 11223;
const TEARDOWN_STARTED_AT_MS = 100_000;
const OUR_ROOT_CREATED_AT_MS = 50_000;

/**
 * A utility helper the still-live app spawned 1.5s into the graceful window,
 * orphaned when the root it belonged to finished quitting. This is the shape
 * `taskkill /T` can never reach, so if the sweep does not claim it, nothing
 * does: it holds the vault and the machine lock into the next lane.
 */
const helperSpawnedDuringGracefulWindow = {
  pid: 701,
  parentPid: 700,
  commandLine: 'C:\\Obsidian.exe --type=utility --user-data-dir="C:\\obsidian"',
  createdAtMs: TEARDOWN_STARTED_AT_MS + 1_500,
};

/** The user's own Obsidian, and a helper it spawned in the same instant. */
const userRoot = {
  pid: 300,
  parentPid: 9,
  commandLine: "C:\\Obsidian.exe",
  createdAtMs: 1_000,
};
const userLateHelper = {
  pid: 301,
  parentPid: 300,
  commandLine: 'C:\\Obsidian.exe --type=renderer --user-data-dir="C:\\obsidian"',
  createdAtMs: TEARDOWN_STARTED_AT_MS + 1_500,
};
/** A concurrent harness instance on its own CDP port. */
const foreignHarnessRoot = {
  pid: 200,
  parentPid: 9,
  commandLine: `C:\\Obsidian.exe --remote-debugging-port=11999 C:\\test_vault_obsidian_ai`,
  createdAtMs: 4_000,
};

function ownedWithBound(
  processes: ObsidianProcessRowV1[],
  teardownStartedAtMs: number,
): number[] {
  return selectOwnedObsidianPidsV1({
    processes,
    rootPid: 700,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: OUR_ROOT_CREATED_AT_MS,
    teardownStartedAtMs,
  });
}

test("a helper spawned during the graceful window is still owned at the kill", async () => {
  // Stamping the bound when teardown STARTED disowns it — it was born 1.5s
  // later, while we were deliberately keeping the app alive. This is the
  // orphan the fix exists to keep claimable.
  assert.deepEqual(
    ownedWithBound([helperSpawnedDuringGracefulWindow], TEARDOWN_STARTED_AT_MS),
    [],
    "the pre-fix bound disowns it — that is the leak",
  );

  let now = TEARDOWN_STARTED_AT_MS;
  const ownership = createTeardownOwnershipWindow(() => now);
  await terminateControlledObsidian(
    { pid: 700, exitCode: null },
    {
      requestGracefulExit: async () => true,
      closeOwnershipWindow: () => {
        ownership.close();
      },
      terminateOwnedTree: async () => undefined,
      waitForOwnedExit: async (phase) => {
        // The graceful window is where the app spends its last three seconds.
        if (phase === "graceful") now = TEARDOWN_STARTED_AT_MS + 3_000;
        return true;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );

  // The teardown must have frozen the window on its way out of the graceful
  // phase — a window still open here would keep widening for as long as the
  // kill and the readbacks take, which is the other half of the same bug.
  now = TEARDOWN_STARTED_AT_MS + 90_000;
  assert.equal(ownership.isClosed(), true);
  assert.equal(ownership.upperBoundMs(), TEARDOWN_STARTED_AT_MS + 3_000);

  assert.deepEqual(
    ownedWithBound([helperSpawnedDuringGracefulWindow], ownership.upperBoundMs()),
    [701],
  );
});

test("widening the window for the graceful quit never claims a process that was not ours", async () => {
  let now = TEARDOWN_STARTED_AT_MS;
  const ownership = createTeardownOwnershipWindow(() => now);
  now = TEARDOWN_STARTED_AT_MS + 3_000;
  ownership.close();

  // A foreign root, a helper it spawned inside our graceful window, a
  // concurrent harness on another port, and a helper that predates our own root
  // entirely. None of them may be touched, however wide our window is.
  const predatesOurRoot = {
    pid: 88,
    parentPid: 9,
    commandLine: 'C:\\Obsidian.exe --type=gpu-process --user-data-dir="C:\\obsidian"',
    createdAtMs: OUR_ROOT_CREATED_AT_MS - 1,
  };
  assert.deepEqual(
    ownedWithBound(
      [
        helperSpawnedDuringGracefulWindow,
        userRoot,
        userLateHelper,
        foreignHarnessRoot,
        predatesOurRoot,
      ],
      ownership.upperBoundMs(),
    ),
    [701],
  );
});

test("the native harness resolves ownership from the window, not from a teardown-start stamp", () => {
  // The harness is the only consumer that feeds the bound to the root-exit
  // probe, the drain probe and the sweep, and those three must never disagree
  // about what we own. It cannot be unit-driven (it imports Playwright), so the
  // wiring is pinned here.
  const source = readFileSync(
    path.join(REPO_ROOT, "e2e", "fixtures", "nativeObsidianHarness.ts"),
    "utf8",
  )
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
  assert.match(source, /createTeardownOwnershipWindow\(\)/u);
  assert.match(source, /closeOwnershipWindow:/u);
  assert.doesNotMatch(source, /teardownStartedAtMs\s*=\s*Date\.now\(\)/u);
  assert.equal(
    source.match(/teardownStartedAtMs: ownership\.upperBoundMs\(\)/gu)?.length,
    1,
  );
  assert.equal(source.match(/ownership\.upperBoundMs\(\)/gu)?.length, 3);
});

// ---------------------------------------------------------------------------
// PHASE-4 HARNESS TEARDOWN
//
// e2e/fixtures/phase4Harness.ts runs the same controlled teardown as
// nativeObsidianHarness and was left carrying both defects after the fix
// above. It cannot be unit-driven — it imports Playwright and its
// `terminateObsidian` is internal — so instead of restating the fix as a
// string match, these cases read the only two things that actually vary
// between the broken and the fixed teardown (which bound it hands the
// ownership resolver, and how it maps the graceful-quit outcome) and then let
// the REAL selector and the REAL orchestrator decide the outcome. A pin alone
// would prove the harness SAYS `ownership.upperBoundMs()`; this proves what
// saying it buys: the orphan is claimable and the kill waits.
// ---------------------------------------------------------------------------

/** The root-exit probe, the drain probe and the survivor sweep. All three. */
const PHASE4_OWNERSHIP_CONSUMERS = 3;
/** phase4Harness.DEFAULT_CDP_PORT — the port that makes a root row ours. */
const PHASE4_CDP_PORT = 11223;
const PHASE4_ROOT_PID = 700;
const PHASE4_ROOT_CREATED_AT_MS = 120_000;
const PHASE4_TEARDOWN_STARTED_AT_MS = 200_000;
/** How long Obsidian spends quitting — inside the harness's 10s graceful wait. */
const PHASE4_GRACEFUL_WINDOW_MS = 3_000;

interface Phase4TeardownWiringV1 {
  closesOwnershipWindow: boolean;
  readsOwnershipAtCallTime: boolean;
  routesGracefulOutcomeThroughPredicate: boolean;
}

/**
 * Read the phase-4 teardown's wiring out of its source.
 *
 * Comment lines are excluded: the fixture explains both historical defects in
 * prose, and matching that prose would score the explanation as the fix.
 */
function phase4TeardownWiringV1(): Phase4TeardownWiringV1 {
  const source = readFileSync(
    path.join(REPO_ROOT, "e2e", "fixtures", "phase4Harness.ts"),
    "utf8",
  )
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
  return {
    closesOwnershipWindow: /closeOwnershipWindow:/u.test(source),
    // Every ownership consumer has to read the window AT CALL TIME. One left
    // holding a captured number is a teardown whose drain probe and whose only
    // remediation disagree about what it owns.
    readsOwnershipAtCallTime:
      source.match(/ownership\.upperBoundMs\(\)/gu)?.length ===
        PHASE4_OWNERSHIP_CONSUMERS &&
      !/teardownStartedAtMs\s*=\s*Date\.now\(\)/u.test(source),
    routesGracefulOutcomeThroughPredicate:
      /gracefulQuitMayHaveReachedAppV1\(/u.test(source) &&
      !/=== "dispatched"/u.test(source),
  };
}

/** The bound the harness, as wired today, would hand the ownership resolver. */
function phase4OwnershipBoundMsV1(
  wiring: Phase4TeardownWiringV1,
  ownership: TeardownOwnershipWindow,
  fixedStampMs: number,
): number {
  return wiring.readsOwnershipAtCallTime ? ownership.upperBoundMs() : fixedStampMs;
}

/** The verdict the harness, as wired today, would draw from a quit outcome. */
function phase4GracefulExitDecisionV1(
  wiring: Phase4TeardownWiringV1,
  outcome: GracefulQuitOutcome,
): boolean {
  return wiring.routesGracefulOutcomeThroughPredicate
    ? gracefulQuitMayHaveReachedAppV1(outcome)
    : outcome === "dispatched";
}

/**
 * A utility helper the still-live app spawned 1.5s into the graceful window,
 * orphaned when the root it belonged to finished quitting. `taskkill /T` can
 * never reach this shape, so if the scoped sweep does not claim it nothing
 * does: it holds the vault and the machine lock into the next occurrence of
 * the cohort.
 */
const phase4HelperSpawnedDuringGracefulWindow: ObsidianProcessRowV1 = {
  pid: 701,
  parentPid: PHASE4_ROOT_PID,
  commandLine: 'C:\\Obsidian.exe --type=utility --user-data-dir="C:\\obsidian"',
  createdAtMs: PHASE4_TEARDOWN_STARTED_AT_MS + 1_500,
};
/** The user's own Obsidian, and a renderer it happened to spawn in our window. */
const phase4UserRoot: ObsidianProcessRowV1 = {
  pid: 300,
  parentPid: 9,
  commandLine: "C:\\Obsidian.exe",
  createdAtMs: 1_000,
};
const phase4UserLateHelper: ObsidianProcessRowV1 = {
  pid: 301,
  parentPid: 300,
  commandLine: 'C:\\Obsidian.exe --type=renderer --user-data-dir="C:\\obsidian"',
  createdAtMs: PHASE4_TEARDOWN_STARTED_AT_MS + 1_500,
};
/** A concurrent harness mid-run on its own CDP port, and one of its children. */
const phase4ConcurrentHarnessRoot: ObsidianProcessRowV1 = {
  pid: 200,
  parentPid: 9,
  commandLine:
    "C:\\Obsidian.exe --remote-debugging-port=11999 C:\\test_vault_obsidian_ai",
  createdAtMs: 4_000,
};
const phase4ConcurrentHarnessHelper: ObsidianProcessRowV1 = {
  pid: 202,
  parentPid: 200,
  commandLine: 'C:\\Obsidian.exe --type=utility --user-data-dir="C:\\other"',
  createdAtMs: PHASE4_TEARDOWN_STARTED_AT_MS + 1_500,
};
/** An orphaned helper that existed before our root did. Never ours. */
const phase4HelperPredatingOurRoot: ObsidianProcessRowV1 = {
  pid: 88,
  parentPid: 9,
  commandLine: 'C:\\Obsidian.exe --type=gpu-process --user-data-dir="C:\\obsidian"',
  createdAtMs: PHASE4_ROOT_CREATED_AT_MS - 1,
};

function phase4OwnedWithBoundV1(
  processes: ObsidianProcessRowV1[],
  teardownStartedAtMs: number,
): number[] {
  return selectOwnedObsidianPidsV1({
    processes,
    rootPid: PHASE4_ROOT_PID,
    cdpPort: PHASE4_CDP_PORT,
    rootCreatedAtMs: PHASE4_ROOT_CREATED_AT_MS,
    teardownStartedAtMs,
  });
}

/** Run the phase-4 teardown as the fixture wires it, on a controllable clock. */
async function runPhase4TeardownV1(
  wiring: Phase4TeardownWiringV1,
  ownership: TeardownOwnershipWindow,
  onGracefulWait: () => void,
): Promise<void> {
  const operations: ControlledObsidianTeardownOperations = {
    requestGracefulExit: async () => true,
    terminateOwnedTree: async () => undefined,
    waitForOwnedExit: async (phase) => {
      if (phase === "graceful") onGracefulWait();
      return true;
    },
    waitForNoRunningProcess: async () => true,
    waitForCdpClose: async () => true,
  };
  if (wiring.closesOwnershipWindow) {
    operations.closeOwnershipWindow = () => {
      ownership.close();
    };
  }
  await terminateControlledObsidian(
    { pid: PHASE4_ROOT_PID, exitCode: null },
    operations,
  );
}

test("a helper born in the phase-4 graceful window is still owned when the sweep runs", async () => {
  // The leak, stated by the real selector rather than by us: a bound stamped
  // when teardown began cannot reach a process born 1.5s later, while we were
  // deliberately keeping the app alive to let it commit DOMStorage.
  assert.deepEqual(
    phase4OwnedWithBoundV1(
      [phase4HelperSpawnedDuringGracefulWindow],
      PHASE4_TEARDOWN_STARTED_AT_MS,
    ),
    [],
    "the teardown-start stamp disowns it — that is the orphan that survives",
  );

  let now = PHASE4_TEARDOWN_STARTED_AT_MS;
  const wiring = phase4TeardownWiringV1();
  const ownership = createTeardownOwnershipWindow(() => now);
  await runPhase4TeardownV1(wiring, ownership, () => {
    // Obsidian spends its last three seconds in the graceful wait, still
    // spawning helpers of its own the whole time.
    now = PHASE4_TEARDOWN_STARTED_AT_MS + PHASE4_GRACEFUL_WINDOW_MS;
  });
  // The survivor sweep is the last thing a teardown does — a minute and a half
  // of kills and readbacks after the graceful window closed. The bound it uses
  // must have frozen back there, or it keeps widening what we may kill.
  now = PHASE4_TEARDOWN_STARTED_AT_MS + 90_000;

  assert.deepEqual(
    phase4OwnedWithBoundV1(
      [phase4HelperSpawnedDuringGracefulWindow],
      phase4OwnershipBoundMsV1(wiring, ownership, PHASE4_TEARDOWN_STARTED_AT_MS),
    ),
    [phase4HelperSpawnedDuringGracefulWindow.pid],
  );
});

test("no bound the phase-4 teardown can hand the sweep ever claims a process that was not ours", () => {
  // Killing a process that was never ours is worse than leaking one: the
  // victims are the user's own window and a concurrent harness's live run, and
  // this harness has done exactly that before. The exclusions therefore have to
  // hold at EVERY instant the window could freeze at, not just the one the
  // fixed teardown happens to pick.
  const processes = [
    phase4HelperSpawnedDuringGracefulWindow,
    phase4UserRoot,
    phase4UserLateHelper,
    phase4ConcurrentHarnessRoot,
    phase4ConcurrentHarnessHelper,
    phase4HelperPredatingOurRoot,
  ];
  const neverOurs = [
    phase4UserRoot.pid,
    phase4UserLateHelper.pid,
    phase4ConcurrentHarnessRoot.pid,
    phase4ConcurrentHarnessHelper.pid,
    phase4HelperPredatingOurRoot.pid,
  ];
  for (const boundMs of [
    PHASE4_TEARDOWN_STARTED_AT_MS,
    PHASE4_TEARDOWN_STARTED_AT_MS + PHASE4_GRACEFUL_WINDOW_MS,
    PHASE4_TEARDOWN_STARTED_AT_MS + 90_000,
  ]) {
    const owned = phase4OwnedWithBoundV1(processes, boundMs);
    for (const pid of neverOurs) {
      assert.equal(owned.includes(pid), false, `pid ${pid} at bound ${boundMs}`);
    }
  }
  // And the claim survives the exclusions: widening the window buys the orphan
  // and nothing else, which is the only trade that makes it safe.
  assert.deepEqual(
    phase4OwnedWithBoundV1(
      processes,
      PHASE4_TEARDOWN_STARTED_AT_MS + PHASE4_GRACEFUL_WINDOW_MS,
    ),
    [phase4HelperSpawnedDuringGracefulWindow.pid],
  );
});

test("the phase-4 teardown waits for the exit when the quit tore down its own reporter", async () => {
  // A renderer being unloaded by the quit it just accepted cannot answer the
  // evaluate that asked for it, so the dispatch times out and the request
  // reports "failed" — the NORMAL signature of a successful quit. Reading that
  // as "not delivered" spends the whole graceful budget on the dispatch and
  // fires taskkill /F at ~2s, into the delayed DOMStorage commit that cost a
  // rotated Linear OAuth pair on 2026-09-07. On the unfixed wiring "kill" is
  // the first entry here.
  const wiring = phase4TeardownWiringV1();
  const calls: string[] = [];
  const rendererGoingAway: GracefulQuitPageLike = {
    isClosed: () => false,
    evaluate: (() =>
      new Promise(() => undefined)) as GracefulQuitPageLike["evaluate"],
  };
  await terminateControlledObsidian(
    { pid: PHASE4_ROOT_PID, exitCode: null },
    {
      requestGracefulExit: async () =>
        phase4GracefulExitDecisionV1(
          wiring,
          await requestGracefulObsidianQuitV1(rendererGoingAway, 20),
        ),
      terminateOwnedTree: async () => {
        calls.push("kill");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return true;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
  assert.deepEqual(calls, ["owned-exit:graceful", "owned-exit:initial"]);
});

test("the phase-4 teardown still skips the wait when a healthy renderer says there is no bridge", async () => {
  // The counterpart the fix must not lose. "unavailable" is a full answer from
  // a renderer that is not going anywhere, so nothing is committing DOMStorage
  // and waiting a whole owned-exit budget on it is dead time in every teardown
  // of the cohort.
  const wiring = phase4TeardownWiringV1();
  const calls: string[] = [];
  const healthyRendererWithoutBridge: GracefulQuitPageLike = {
    isClosed: () => false,
    evaluate: (async () => false) as unknown as GracefulQuitPageLike["evaluate"],
  };
  await terminateControlledObsidian(
    { pid: PHASE4_ROOT_PID, exitCode: null },
    {
      requestGracefulExit: async () =>
        phase4GracefulExitDecisionV1(
          wiring,
          await requestGracefulObsidianQuitV1(healthyRendererWithoutBridge),
        ),
      terminateOwnedTree: async () => {
        calls.push("kill");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return true;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
  assert.deepEqual(calls, ["kill", "owned-exit:initial"]);
});

test("the phase-4 harness resolves ownership from the window and routes the quit outcome through the predicate", () => {
  // The wiring the three behavioural cases above depend on, pinned so that a
  // re-inlined `Date.now()` stamp or a revived `=== "dispatched"` cannot make
  // them silently model a harness that no longer exists.
  const wiring = phase4TeardownWiringV1();
  assert.deepEqual(wiring, {
    closesOwnershipWindow: true,
    readsOwnershipAtCallTime: true,
    routesGracefulOutcomeThroughPredicate: true,
  });
});
