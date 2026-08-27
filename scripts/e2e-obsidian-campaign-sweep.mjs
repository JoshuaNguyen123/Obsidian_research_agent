import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendHostEventV1,
  enumerateObsidianProcessesDetailedV1,
  forceKillPidV1,
  orderKillsLeafFirstV1,
  readOwnedHostSpawnsV1,
  selectJournalOwnedResidueV1,
} from "./e2e-obsidian-sweep.js";
import {
  isProcessAlive,
  readLockOwner,
  resolveE2eLockPath,
} from "./run-e2e-exclusive.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Is some OTHER live process holding the machine-wide exclusive e2e lock?
 *
 * The campaign zombie sweeps ran in the campaign PARENT, before the child
 * runner acquires this lock, and never consulted it — so a campaign starting
 * while another session's lane was mid-mission force-killed that lane's host.
 * That is the 4294967295 death. One shared guard now serves every campaign
 * sweep site so the two can never drift apart again.
 */
export async function foreignExclusiveLockHolderV1(env = process.env) {
  const owner = await readLockOwner(resolveE2eLockPath(env)).catch(() => null);
  const metadata = owner?.metadata;
  if (!metadata || metadata.hostname !== os.hostname()) return null;
  const pid = Number(metadata.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return null;
  if (!isProcessAlive(pid)) return null;
  return {
    pid,
    startedAt: metadata.startedAt ?? null,
    cwd: metadata.cwd ?? null,
    playwrightArgs: metadata.playwrightArgs ?? null,
  };
}

/**
 * Reap Obsidian processes THIS campaign leaked, between cells — never while
 * another runner legitimately holds the exclusive lock, and never anything the
 * campaign cannot prove it started.
 *
 * TWO defects this replaces, both measured in the 2026-08-27 compound campaign
 * where one leaked root (25596) burned attempts 4 and 5:
 *
 *  1. OWNERSHIP WAS INFERRED FROM A VAULT PATH.
 *     `CommandLine -match 'test_vault_obsidian_ai'` matches a LIVE lane's root
 *     just as readily as a leak, because every instance on this machine shares
 *     that vault. Force-killing on that match produced exit 4294967295 with no
 *     Windows Error Reporting event, no crash dump and no stderr — a death
 *     indistinguishable from a product crash until you decode the exit code.
 *     Ownership is now PID + creation instant proven against this repo root's
 *     own spawn journal (selectJournalOwnedResidueV1), so a process we did not
 *     start cannot be selected at all. The lock deferral stays as a second,
 *     independent guard.
 *
 *  2. THE KILL OUTCOME WAS THROWN AWAY.
 *     `.catch(() => undefined)` after a `killedPids` list that was recorded
 *     BEFORE any kill ran. The journal therefore recorded "killed [25596]"
 *     five times across 5.5 minutes for a process that never died — the
 *     campaign believed it had cleaned up and started two attempts into a
 *     machine that still had a live Obsidian on it. Kills now carry per-PID
 *     outcomes and the sweep VERIFIES by re-enumerating, so `residualPids` is
 *     an observation rather than an assumption.
 */
export async function sweepTestVaultObsidianZombiesV1({
  stage = "unknown",
  env = process.env,
  repoRoot = REPO_ROOT,
  log = console,
  sinceMs = 0,
} = {}) {
  if (process.platform !== "win32") {
    return {
      swept: 0,
      skipped: false,
      reason: null,
      targetedPids: [],
      killResults: [],
      residualPids: [],
      enumerationOk: true,
    };
  }
  const holder = await foreignExclusiveLockHolderV1(env);
  if (holder) {
    const reason =
      `exclusive Obsidian e2e lock is held by live PID ${holder.pid}` +
      `${holder.startedAt ? ` (since ${holder.startedAt})` : ""}` +
      `${holder.cwd ? ` in ${holder.cwd}` : ""}`;
    appendHostEventV1(
      { kind: "campaign_sweep_skipped", stage, reason, holder },
      repoRoot,
    );
    log.warn?.(
      `Skipped the test-vault Obsidian sweep before ${stage}: ${reason}. ` +
        "Sweeping now would force-kill a running lane's host.",
    );
    return {
      swept: 0,
      skipped: true,
      reason,
      targetedPids: [],
      killResults: [],
      residualPids: [],
      enumerationOk: true,
    };
  }

  const spawns = readOwnedHostSpawnsV1({ sinceMs, repoRoot });
  const reading = await enumerateObsidianProcessesDetailedV1();
  const targetedPids = reading.ok
    ? selectJournalOwnedResidueV1({ processes: reading.processes, spawns })
    : [];
  appendHostEventV1(
    {
      kind: "campaign_sweep",
      stage,
      enumerationOk: reading.ok,
      enumerationError: reading.error,
      observed: reading.processes.map((row) => ({
        pid: row.pid,
        parentPid: row.parentPid,
        createdAtMs: row.createdAtMs,
        commandLine: row.commandLine.slice(0, 400),
      })),
      // TARGETED, not "killed" — this list is written before any kill runs and
      // must never again claim an outcome it has not observed.
      targetedPids,
      sparedPids: reading.processes
        .map((row) => row.pid)
        .filter((pid) => !targetedPids.includes(pid)),
    },
    repoRoot,
  );

  const killResults = [];
  for (const pid of orderKillsLeafFirstV1(targetedPids, reading.processes)) {
    killResults.push(await forceKillPidV1(pid));
  }

  // VERIFY. The campaign's next act is to start an attempt on this machine, so
  // "did they actually go" is the only answer worth recording.
  let residualPids = [];
  let enumerationOk = reading.ok;
  if (reading.ok) {
    const verify = await enumerateObsidianProcessesDetailedV1();
    enumerationOk = verify.ok;
    residualPids = verify.ok
      ? selectJournalOwnedResidueV1({ processes: verify.processes, spawns })
      : targetedPids;
  }
  const killed = killResults.filter((entry) => entry.killed).length;
  appendHostEventV1(
    {
      kind: "campaign_sweep_result",
      stage,
      killResults,
      residualPids,
      enumerationOk,
    },
    repoRoot,
  );
  if (targetedPids.length > 0) {
    log.log?.(
      `Swept ${killed}/${targetedPids.length} campaign-owned Obsidian process(es) before ${stage}` +
        (residualPids.length > 0
          ? `; STILL PRESENT: ${residualPids.join(", ")}`
          : "") +
        ".",
    );
  }
  if (!enumerationOk) {
    log.warn?.(
      `Could not enumerate Obsidian processes before ${stage}; ` +
        "treat this as UNKNOWN, not as a clean machine.",
    );
  }
  return {
    swept: killed,
    skipped: false,
    reason: null,
    targetedPids,
    killResults,
    residualPids,
    enumerationOk,
  };
}
