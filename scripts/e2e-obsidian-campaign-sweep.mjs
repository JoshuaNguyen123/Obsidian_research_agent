import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  appendHostEventV1,
  enumerateObsidianProcessesV1,
} from "./e2e-obsidian-sweep.js";
import {
  isProcessAlive,
  readLockOwner,
  resolveE2eLockPath,
} from "./run-e2e-exclusive.mjs";

const execFileAsync = promisify(execFile);
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
 * Kill leaked test-vault Obsidian processes between campaign cells — but never
 * while another runner legitimately holds the exclusive lock.
 *
 * Selecting by `CommandLine -match 'test_vault_obsidian_ai'` matches a LIVE
 * lane's root just as readily as a zombie; force-killing it then produced exit
 * 4294967295, no Windows Error Reporting event, no crash dump and no stderr —
 * a death indistinguishable from a product crash until you decode the exit
 * code. Deferring to the lock holder is what makes the sweep safe.
 */
export async function sweepTestVaultObsidianZombiesV1({
  stage = "unknown",
  env = process.env,
  repoRoot = REPO_ROOT,
  log = console,
} = {}) {
  if (process.platform !== "win32") {
    return { swept: 0, skipped: false, reason: null };
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
    return { swept: 0, skipped: true, reason };
  }
  const processes = await enumerateObsidianProcessesV1();
  const targets = processes.filter((row) =>
    /test_vault_obsidian_ai/iu.test(row.commandLine),
  );
  appendHostEventV1(
    {
      kind: "campaign_sweep",
      stage,
      observed: processes.map((row) => ({
        pid: row.pid,
        parentPid: row.parentPid,
        commandLine: row.commandLine.slice(0, 400),
      })),
      killedPids: targets.map((row) => row.pid),
    },
    repoRoot,
  );
  for (const row of targets) {
    await execFileAsync("taskkill", ["/PID", String(row.pid), "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
  }
  if (targets.length > 0) {
    log.log?.(
      `Swept ${targets.length} test-vault Obsidian zombie process(es) before ${stage}.`,
    );
  }
  return { swept: targets.length, skipped: false, reason: null };
}
