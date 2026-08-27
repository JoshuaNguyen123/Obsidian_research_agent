import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendHostEventV1,
  describeSweepOutcomeV1,
  describeTaskkillOutcomeV1,
  orderKillsLeafFirstV1,
  readOwnedHostSpawnsV1,
  selectJournalOwnedResidueV1,
  sweepOwnedObsidianSurvivorsV1,
  type ObsidianEnumerationV1,
  type ObsidianProcessRowV1,
} from "../scripts/e2e-obsidian-sweep";
import {
  OBSIDIAN_RESIDUE_FAILURE_CLASS,
  attemptConsumesBudget,
  consecutiveGreens,
  consumedAttemptCount,
  isInfrastructureFailureClass,
} from "../scripts/run-proof-matrix.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUR_PORT = 11223;

/**
 * The four stderr strings taskkill actually produced during the 2026-08-27
 * compound campaign, copied verbatim from
 * e2e-host-diagnostics/host-events.jsonl. Every one of them was reported by the
 * harness as an undifferentiated "kill FAILED".
 */
const REAL_NOT_FOUND = 'ERROR: The process "5852" not found.';
const REAL_TERMINATING =
  "ERROR: The process with PID 25596 could not be terminated. " +
  "Reason: There is no running instance of the task.";
const REAL_ACCESS_DENIED =
  "ERROR: The process with PID 8412 could not be terminated. Reason: Access is denied.";

// ---- the kill-outcome fingerprint table ----

test("taskkill outcomes are told apart, not collapsed into one 'kill FAILED'", () => {
  // THE MEASUREMENT THIS ENCODES. Six force-kills against leaked root 25596
  // across 5.5 minutes all reported the same undiagnosable sentence, so the
  // journal could not distinguish a stale snapshot, a process already
  // terminating, and a process we do not own — three states needing three
  // different responses.
  const killed = describeTaskkillOutcomeV1(null);
  assert.equal(killed.outcome, "killed");
  assert.equal(killed.killed, true);
  assert.equal(killed.occupiesImageName, false);

  const gone = describeTaskkillOutcomeV1(new Error(REAL_NOT_FOUND));
  assert.equal(gone.outcome, "not_found");
  assert.equal(gone.reapable, false);
  // Nothing is there, so it cannot block the next lane's already-running gate.
  assert.equal(gone.occupiesImageName, false);

  const terminating = describeTaskkillOutcomeV1(new Error(REAL_TERMINATING));
  assert.equal(terminating.outcome, "terminating");
  // No further kill can reach a process whose termination is already in
  // flight — retrying is pure waste...
  assert.equal(terminating.reapable, false);
  // ...but it is still occupying the image name, so the next attempt WILL be
  // refused. This pair is the whole cascade in two booleans.
  assert.equal(terminating.occupiesImageName, true);

  const denied = describeTaskkillOutcomeV1(new Error(REAL_ACCESS_DENIED));
  assert.equal(denied.outcome, "access_denied");
  assert.equal(denied.occupiesImageName, true);

  const unknown = describeTaskkillOutcomeV1(new Error("ERROR: something else"));
  assert.equal(unknown.outcome, "kill_failed");
  assert.equal(unknown.reapable, true);
});

test("the sweep's account names a terminating survivor as unreapable, not as a botched kill", () => {
  const summary = describeSweepOutcomeV1({
    swept: 0,
    killedPids: [25596],
    killResults: [
      {
        pid: 25596,
        killed: false,
        error: REAL_TERMINATING,
        outcome: "terminating",
        reapable: false,
        occupiesImageName: true,
      },
    ],
    observed: [
      {
        pid: 25596,
        parentPid: 32024,
        commandLine: `C:\\Obsidian.exe --remote-debugging-port=${OUR_PORT}`,
        createdAtMs: 1_000,
      },
    ],
    residualPids: [25596],
  });
  assert.match(summary, /STILL TERMINATING, unreapable by any kill: 25596/u);
  assert.match(summary, /only time removes these/u);
  assert.match(summary, /still present after the sweep: 25596/u);
  // The pre-fix wording blamed the harness for a kill it could not have made.
  assert.doesNotMatch(summary, /kill FAILED for 25596/u);
});

test("a genuinely unowned process still reads as a hard kill failure", () => {
  // The opposite direction must NOT be softened: Access-is-denied means the
  // ownership scoping got something wrong, and that has to stay loud.
  const summary = describeSweepOutcomeV1({
    swept: 0,
    killedPids: [8412],
    killResults: [
      {
        pid: 8412,
        killed: false,
        error: REAL_ACCESS_DENIED,
        outcome: "access_denied",
        reapable: false,
        occupiesImageName: true,
      },
    ],
    observed: [],
  });
  assert.match(summary, /kill FAILED for 8412 \(.*Access is denied\./u);
  assert.doesNotMatch(summary, /STILL TERMINATING/u);
});

test("a stale snapshot reads as 'already gone', not as a leak", () => {
  const summary = describeSweepOutcomeV1({
    swept: 0,
    killedPids: [5852],
    killResults: [
      {
        pid: 5852,
        killed: false,
        error: REAL_NOT_FOUND,
        outcome: "not_found",
        reapable: false,
        occupiesImageName: false,
      },
    ],
    observed: [],
  });
  assert.match(summary, /already gone before the kill: 5852 \(stale snapshot, not a leak\)/u);
  assert.doesNotMatch(summary, /kill FAILED/u);
});

// ---- "we could not look" is not "there is nothing there" ----

function enumeration(
  processes: ObsidianProcessRowV1[],
): ObsidianEnumerationV1 {
  return { ok: true, processes, error: null };
}

const failedRead: ObsidianEnumerationV1 = {
  ok: false,
  processes: [],
  error: "CIM enumeration failed: timeout",
};

test("a failed process enumeration is never reported as an empty machine", async () => {
  // THE SILENT-LEAK GENERATOR THIS CLOSES. The CIM read is a PowerShell spawn
  // with a 30s timeout, and it is attempted precisely when the machine is
  // loaded. It used to `catch { return [] }`, so a read that timed out was
  // indistinguishable from "no Obsidian is running": the sweep claimed nothing,
  // killed nothing, and the teardown scored a live leak GREEN.
  const result = await sweepOwnedObsidianSurvivorsV1({
    platform: "win32",
    repoRoot: mkdtempSync(path.join(os.tmpdir(), "reap-")),
    rootPid: 100,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: 5_000,
    enumerate: async () => failedRead,
    kill: async () => {
      throw new Error("a sweep that could not enumerate must not kill anything");
    },
    sleep: async () => undefined,
  });
  assert.equal(result.enumerationOk, false);
  assert.deepEqual(result.killedPids, []);
  const summary = describeSweepOutcomeV1(result);
  assert.match(summary, /ENUMERATION FAILED/u);
  assert.match(summary, /this reading proves nothing about what is running/u);
  // "observed 0; claimed 0" would read as a clean machine, which is the lie.
  assert.doesNotMatch(summary, /^observed 0 Obsidian process\(es\); claimed 0 as owned$/u);
});

// ---- the sweep must re-enumerate, and reap leaf-first ----

test("the sweep reaps a child that only appears after the first snapshot", async () => {
  // A single snapshot cannot reap a tree: an Electron child that was mid-spawn
  // during the first read never appeared in the kill list at all, and the one
  // pass the sweep made was the only pass it would ever make.
  const root: ObsidianProcessRowV1 = {
    pid: 100,
    parentPid: 9,
    commandLine: `C:\\Obsidian.exe --remote-debugging-port=${OUR_PORT}`,
    createdAtMs: 5_000,
  };
  const lateChild: ObsidianProcessRowV1 = {
    pid: 101,
    parentPid: 100,
    commandLine: "C:\\Obsidian.exe --type=renderer",
    createdAtMs: 5_100,
  };
  const readings = [
    enumeration([root]),
    enumeration([root, lateChild]),
    enumeration([]),
    enumeration([]),
  ];
  let read = 0;
  const killed: number[] = [];
  const result = await sweepOwnedObsidianSurvivorsV1({
    platform: "win32",
    repoRoot: mkdtempSync(path.join(os.tmpdir(), "reap-")),
    rootPid: 100,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: 5_000,
    enumerate: async () => readings[Math.min(read++, readings.length - 1)],
    kill: async (pid: number) => {
      killed.push(pid);
      return {
        pid,
        outcome: "killed" as const,
        killed: true,
        reapable: false,
        occupiesImageName: false,
        error: null,
      };
    },
    sleep: async () => undefined,
  });
  assert.ok(
    killed.includes(101),
    "a child that appeared on the second reading must still be reaped",
  );
  assert.deepEqual(result.residualPids, [], "the sweep must verify by re-reading");
});

test("owned trees are reaped leaf-first so a dying root cannot orphan its children", () => {
  // Killing the root first reparents its children, and the very next
  // enumeration sees them as orphans rather than as members of a tree we
  // already claimed — recoverable only by rule 3, and only when the root's
  // creation time is known.
  const processes: ObsidianProcessRowV1[] = [
    { pid: 100, parentPid: 9, commandLine: "root", createdAtMs: 1 },
    { pid: 101, parentPid: 100, commandLine: "child", createdAtMs: 2 },
    { pid: 102, parentPid: 101, commandLine: "grandchild", createdAtMs: 3 },
  ];
  assert.deepEqual(
    orderKillsLeafFirstV1([100, 101, 102], processes),
    [102, 101, 100],
  );
});

// ---- campaign-scope ownership must be PROVEN, never inferred ----

const CAMPAIGN_SPAWN_MS = 1_000_000;

/** Exactly the shape the journal recorded for the leaked root 25596. */
const ourResidueRoot: ObsidianProcessRowV1 = {
  pid: 25596,
  parentPid: 32024,
  commandLine:
    "C:\\Obsidian.exe --remote-debugging-port=11223 --no-first-run " +
    "C:\\Users\\joshb\\OneDrive\\Desktop\\test_vault_obsidian_ai",
  // Measured: the journal line lands 14-305ms AFTER the kernel creation instant.
  createdAtMs: CAMPAIGN_SPAWN_MS - 23,
};

const ourSpawns = [
  { pid: 25596, spawnedAtMs: CAMPAIGN_SPAWN_MS, label: "flow-real", cdpPort: 11223 },
];

test("the campaign reaps residue it can prove it spawned", () => {
  const child: ObsidianProcessRowV1 = {
    pid: 25597,
    parentPid: 25596,
    commandLine: "C:\\Obsidian.exe --type=renderer",
    createdAtMs: CAMPAIGN_SPAWN_MS + 400,
  };
  assert.deepEqual(
    selectJournalOwnedResidueV1({
      processes: [ourResidueRoot, child],
      spawns: ourSpawns,
    }),
    [25596, 25597],
  );
});

test("a live foreign lane on the SAME test vault is never claimed", () => {
  // THE SAFETY REGRESSION THIS ENCODES. The campaign sweep selected by
  // `CommandLine -match 'test_vault_obsidian_ai'`, a path every instance on this
  // machine shares. It therefore force-killed another session's live lane —
  // exit 4294967295, no crash dump, no stderr — and was blamed on the product
  // for weeks. A vault path names a class, not a possession.
  const foreignLiveLane: ObsidianProcessRowV1 = {
    pid: 44444,
    parentPid: 9,
    commandLine:
      "C:\\Obsidian.exe --remote-debugging-port=11999 --no-first-run " +
      "C:\\Users\\joshb\\OneDrive\\Desktop\\test_vault_obsidian_ai",
    createdAtMs: CAMPAIGN_SPAWN_MS + 5_000,
  };
  const foreignRenderer: ObsidianProcessRowV1 = {
    pid: 44445,
    parentPid: 44444,
    commandLine: "C:\\Obsidian.exe --type=renderer",
    createdAtMs: CAMPAIGN_SPAWN_MS + 5_100,
  };
  const userOwnObsidian: ObsidianProcessRowV1 = {
    pid: 55555,
    parentPid: 9,
    commandLine: "C:\\Obsidian.exe",
    createdAtMs: 10,
  };
  assert.deepEqual(
    selectJournalOwnedResidueV1({
      processes: [foreignLiveLane, foreignRenderer, userOwnObsidian],
      spawns: ourSpawns,
    }),
    [],
    "nothing this campaign did not spawn may ever be selected for a kill",
  );
});

test("a PID-recycled impostor wearing our number is not our residue", () => {
  // Our process occupies its PID from creation until it exits, and the journal
  // line is written once spawn() returned — so that line falls inside our
  // process's lifetime, and any other process bearing the PID can only have
  // been created after ours died. Later creation is therefore proof of a
  // different process, not a tolerance guess.
  const impostor: ObsidianProcessRowV1 = {
    ...ourResidueRoot,
    createdAtMs: CAMPAIGN_SPAWN_MS + 1,
  };
  assert.deepEqual(
    selectJournalOwnedResidueV1({ processes: [impostor], spawns: ourSpawns }),
    [],
  );
  // And an ancient process that merely shares the number is equally excluded.
  assert.deepEqual(
    selectJournalOwnedResidueV1({
      processes: [{ ...ourResidueRoot, createdAtMs: CAMPAIGN_SPAWN_MS - 3_600_000 }],
      spawns: ourSpawns,
    }),
    [],
  );
});

test("no creation instant means no campaign claim, ever", () => {
  // Deliberately the OPPOSITE fail-safe from the teardown sweep: teardown owns
  // its root by construction, so disowning a survivor there would hide a leak.
  // Here a wrong claim force-kills a concurrent session's live lane, and a
  // missed claim is now harmless — the matrix reports residue and declines to
  // spend an attempt instead of starting into it.
  assert.deepEqual(
    selectJournalOwnedResidueV1({
      processes: [{ ...ourResidueRoot, createdAtMs: null }],
      spawns: ourSpawns,
    }),
    [],
  );
});

test("campaign spawn records are read back from the durable journal", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "reap-journal-"));
  try {
    const before = Date.now();
    appendHostEventV1(
      { kind: "host_spawned", label: "flow-real", pid: 25596, cdpPort: 11223 },
      repoRoot,
    );
    appendHostEventV1({ kind: "page_closed", pid: 25596 }, repoRoot);
    const spawns = readOwnedHostSpawnsV1({ sinceMs: before - 1_000, repoRoot });
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].pid, 25596);
    assert.ok(spawns[0].spawnedAtMs >= before - 1_000);
    // A spawn from before the window belongs to an earlier campaign.
    assert.deepEqual(
      readOwnedHostSpawnsV1({ sinceMs: Date.now() + 60_000, repoRoot }),
      [],
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ---- the cascade: a leftover must not burn the next attempts ----

test("a blocked-by-residue attempt spends no budget and preserves the streak", () => {
  // The 2026-08-27 cascade: two cleanup_failed teardowns leaked a live
  // Obsidian, then attempts 4 and 5 each paid ~150s of build, vault sync and
  // lane startup only to be refused by assertObsidianClosed.
  assert.equal(isInfrastructureFailureClass(OBSIDIAN_RESIDUE_FAILURE_CLASS), true);
  assert.equal(
    attemptConsumesBudget({
      green: false,
      failureClass: OBSIDIAN_RESIDUE_FAILURE_CLASS,
    }),
    false,
  );
  const manifest = {
    attempts: [
      { cell: "c", green: true, failureClass: "none" },
      { cell: "c", green: false, failureClass: OBSIDIAN_RESIDUE_FAILURE_CLASS },
    ],
    productClassCounts: {},
  };
  assert.equal(consumedAttemptCount(manifest, "c"), 1);
  assert.equal(consecutiveGreens(manifest, "c"), 1, "the streak must survive it");
});

test("preflight refusal remains infrastructure-classed and budget-exempt", () => {
  // Verified, not assumed: the refusal itself is correct behaviour, so it must
  // never cost the product an attempt.
  assert.equal(isInfrastructureFailureClass("harness:preflight_refused"), true);
  assert.equal(
    attemptConsumesBudget({ green: false, failureClass: "harness:preflight_refused" }),
    false,
  );
});

// ---- source guards ----

function sourceWithoutComments(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
}

test("the campaign sweep may never select Obsidian by vault path again", () => {
  const source = sourceWithoutComments("scripts/e2e-obsidian-campaign-sweep.mjs");
  assert.doesNotMatch(
    source,
    /test_vault_obsidian_ai/u,
    "ownership must be proven from the spawn journal, never inferred from a shared vault path",
  );
  assert.doesNotMatch(
    source,
    /catch\(\s*\(\)\s*=>\s*undefined\s*\)/u,
    "a swallowed kill outcome is what made the journal record five kills that never happened",
  );
  assert.match(
    source,
    /selectJournalOwnedResidueV1/u,
    "the campaign sweep must route through the proven-ownership selector",
  );
  assert.match(
    source,
    /residualPids/u,
    "the sweep must VERIFY by re-enumerating, not assume its kills landed",
  );
});

test("the matrix gates on residue BEFORE it spawns the attempt runner", () => {
  const source = sourceWithoutComments("scripts/run-proof-matrix.mjs");
  const gate = source.indexOf("drainCampaignObsidianResidue(");
  const spawn = source.indexOf("const result = spawnSync(process.execPath, runnerArgs");
  assert.ok(gate > 0 && spawn > 0, "both the gate and the runner spawn must exist");
  assert.ok(
    gate < spawn,
    "a machine known to be dirty must be detected before the attempt pays for startup",
  );
});

test("the already-running gate keeps refusing, and only its explanation grew", () => {
  // NOT NEGOTIABLE: a live Obsidian genuinely poisons a lane. The fix is to
  // stop leaking and to recover from a leak we own — never to start anyway.
  const source = sourceWithoutComments("scripts/e2e-preflight.mjs");
  assert.match(
    source,
    /Obsidian\.exe is already running\. Close Obsidian before running Playwright e2e\./u,
  );
  assert.match(source, /throw new Error\(/u);
  // The diagnostics must be additive: a failure to describe cannot let the
  // gate pass.
  assert.doesNotMatch(
    source,
    /if \(!reading\.ok\) return;/u,
    "an unreadable process table must never open the gate",
  );
});
