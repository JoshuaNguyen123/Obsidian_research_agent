import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import {
  appendHostEventV1,
  describeWindowsExitCodeV1,
  selectOwnedObsidianPidsV1,
  summarizeRecentHostDeathV1,
} from "../scripts/e2e-obsidian-sweep";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUR_PORT = 11223;

/** Our harness's Obsidian: a browser root carrying our unique CDP port. */
const ourRoot = {
  pid: 100,
  parentPid: 9,
  commandLine: `C:\\Obsidian.exe --remote-debugging-port=${OUR_PORT} --no-first-run C:\\test_vault_obsidian_ai`,
  createdAtMs: 5_000,
};
const ourRenderer = {
  pid: 101,
  parentPid: 100,
  commandLine: 'C:\\Obsidian.exe --type=renderer --user-data-dir="C:\\obsidian"',
  createdAtMs: 5_100,
};
const ourGpu = {
  pid: 102,
  parentPid: 100,
  commandLine: 'C:\\Obsidian.exe --type=gpu-process --user-data-dir="C:\\obsidian"',
  createdAtMs: 5_100,
};

/** A concurrent harness instance on a different CDP port. */
const foreignHarnessRoot = {
  pid: 200,
  parentPid: 9,
  commandLine:
    "C:\\Obsidian.exe --remote-debugging-port=11999 --no-first-run C:\\test_vault_obsidian_ai",
  createdAtMs: 4_000,
};
const foreignHarnessRenderer = {
  pid: 201,
  parentPid: 200,
  commandLine: 'C:\\Obsidian.exe --type=renderer --user-data-dir="C:\\obsidian"',
  createdAtMs: 4_100,
};

/** The user's own Obsidian: a plain root with no debugging port at all. */
const userRoot = {
  pid: 300,
  parentPid: 9,
  commandLine: "C:\\Obsidian.exe",
  createdAtMs: 1_000,
};
const userRenderer = {
  pid: 301,
  parentPid: 300,
  commandLine: 'C:\\Obsidian.exe --type=renderer --user-data-dir="C:\\obsidian"',
  createdAtMs: 1_100,
};

test("the survivor sweep kills only this instance's Obsidian tree", () => {
  const processes = [
    ourRoot,
    ourRenderer,
    ourGpu,
    foreignHarnessRoot,
    foreignHarnessRenderer,
    userRoot,
    userRenderer,
  ];
  const killed = selectOwnedObsidianPidsV1({
    processes,
    rootPid: ourRoot.pid,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: ourRoot.createdAtMs,
  });
  assert.deepEqual(killed, [100, 101, 102]);
  // The regression this encodes: the pre-fix sweep enumerated by image name
  // and killed every PID it saw, so a concurrent harness's LIVE run and the
  // user's own window both died. Neither may ever appear in the kill list.
  for (const spared of [200, 201, 300, 301]) {
    assert.ok(!killed.includes(spared), `foreign PID ${spared} must be spared`);
  }
});

test("a foreign root is spared even when it is the only Obsidian running", () => {
  const killed = selectOwnedObsidianPidsV1({
    processes: [userRoot, userRenderer],
    rootPid: ourRoot.pid,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: ourRoot.createdAtMs,
  });
  assert.deepEqual(killed, []);
});

test("orphaned helpers of our own root are claimed; older orphans are not", () => {
  const ourOrphan = {
    pid: 110,
    parentPid: 100, // root already exited and is absent from the enumeration
    commandLine: 'C:\\Obsidian.exe --type=utility --user-data-dir="C:\\obsidian"',
    createdAtMs: 5_200,
  };
  const olderOrphan = {
    pid: 310,
    parentPid: 300,
    commandLine: 'C:\\Obsidian.exe --type=utility --user-data-dir="C:\\obsidian"',
    createdAtMs: 900,
  };
  const killed = selectOwnedObsidianPidsV1({
    processes: [ourOrphan, olderOrphan],
    rootPid: 100,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: ourRoot.createdAtMs,
  });
  assert.deepEqual(killed, [110]);
});

test("without a known root creation time no orphan is claimed on suspicion", () => {
  const orphan = {
    pid: 410,
    parentPid: 999,
    commandLine: 'C:\\Obsidian.exe --type=renderer --user-data-dir="C:\\obsidian"',
    createdAtMs: 7_000,
  };
  const killed = selectOwnedObsidianPidsV1({
    processes: [orphan],
    rootPid: 100,
    cdpPort: OUR_PORT,
    rootCreatedAtMs: null,
  });
  assert.deepEqual(killed, []);
});

test("Windows exit codes name the ACTION that produced them", () => {
  // Measured with a controlled process-tree probe on 2026-08-26. 4294967295
  // had been read for weeks as an unexplained silent crash; it is a kill.
  const forced = describeWindowsExitCodeV1(4294967295, null);
  assert.equal(forced.kind, "force_killed_stop_process");
  assert.equal(forced.forcedExternally, true);
  assert.match(forced.summary, /Stop-Process -Force/u);
  assert.match(forced.summary, /did not crash/u);

  const taskkilled = describeWindowsExitCodeV1(1, null);
  assert.equal(taskkilled.kind, "force_killed_taskkill");
  assert.equal(taskkilled.forcedExternally, true);

  assert.equal(describeWindowsExitCodeV1(0, null).kind, "clean");
  assert.equal(describeWindowsExitCodeV1(0, null).forcedExternally, false);
  assert.equal(describeWindowsExitCodeV1(null, "SIGKILL").kind, "signalled");
});

test("no campaign or harness sweep may force-kill Obsidian by image name again", () => {
  // Source-level guard: the two duplicated Stop-Process sweeps and the two
  // duplicated tasklist image-name sweeps are what killed live hosts. All four
  // now route through the shared scoped sweep; re-inlining any of them
  // must fail here rather than in a mystery lane at 3am.
  const guarded = [
    "scripts/run-proof-matrix.mjs",
    "scripts/run-workflow-audit-e2e.mjs",
    "e2e/fixtures/nativeObsidianHarness.ts",
    "e2e/fixtures/phase4Harness.ts",
  ];
  for (const relative of guarded) {
    // Comment lines are excluded: each of these files explains the historical
    // kill in prose, and that explanation is the point.
    const source = readFileSync(path.join(REPO_ROOT, relative), "utf8")
      .split(/\r?\n/u)
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
      .join("\n");
    assert.doesNotMatch(
      source,
      /Stop-Process/u,
      `${relative} must not force-kill Obsidian directly; use the shared scoped sweep.`,
    );
    assert.doesNotMatch(
      source,
      /IMAGENAME eq/u,
      `${relative} must not enumerate Obsidian by image name (tasklist /FI is unreliable here); use the shared CIM enumeration.`,
    );
  }
});

test("a force-killed host death reads back as self-describing, not as a crash", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "host-journal-"));
  try {
    const sinceMs = Date.now() - 1_000;
    // Exactly what the harness writes when a sweep force-kills a live host:
    // an exit the run never asked for.
    const decoded = describeWindowsExitCodeV1(4294967295, null);
    appendHostEventV1(
      {
        kind: "host_exited",
        label: "compound-flow-real-live",
        pid: 4242,
        exitCode: 4294967295,
        signal: null,
        lifetimeMs: 204_000,
        exitKind: decoded.kind,
        forcedExternally: decoded.forcedExternally,
        diagnosis: decoded.summary,
        teardownRequested: false,
      },
      repoRoot,
    );

    const summary = summarizeRecentHostDeathV1(sinceMs, repoRoot);
    assert.ok(summary, "a recorded death must be readable back");
    // The three facts that were missing from every artifact before this:
    // WHO ended it, that nobody asked it to end, and that it was not a crash.
    assert.match(summary!, /host_exited/u);
    assert.match(summary!, /Stop-Process -Force/u);
    assert.match(summary!, /teardownRequested=false/u);
    assert.match(summary!, /exitCode=4294967295/u);
    assert.match(summary!, /did not crash/u);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an orderly teardown is not reported as a death", () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "host-journal-"));
  try {
    const sinceMs = Date.now() - 1_000;
    appendHostEventV1({ kind: "host_spawned", pid: 1 }, repoRoot);
    appendHostEventV1({ kind: "page_closed", pid: 1 }, repoRoot);
    // No host_exited yet: nothing to blame, so the poll error must stay bare
    // rather than inventing a cause.
    assert.equal(summarizeRecentHostDeathV1(sinceMs, repoRoot), null);

    // A death recorded BEFORE the window under test belongs to an earlier run.
    appendHostEventV1(
      { kind: "host_exited", exitCode: 1, signal: null, diagnosis: "old" },
      repoRoot,
    );
    assert.equal(summarizeRecentHostDeathV1(Date.now() + 60_000, repoRoot), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
