import { appendFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import {
  isProcessAlive,
  readLockOwner,
  resolveE2eLockPath,
} from "./run-e2e-exclusive.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Durable host-death journal. It must NOT live under test-results/, which
 * Playwright wipes at the start of every run — that wipe is why three silent
 * host deaths on 2026-08-26 left no evidence behind. Gitignored.
 */
export const HOST_DIAGNOSTICS_RELATIVE_DIR = "e2e-host-diagnostics";
export const HOST_EVENT_JOURNAL_RELATIVE_PATH = `${HOST_DIAGNOSTICS_RELATIVE_DIR}/host-events.jsonl`;

export function hostEventJournalPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, ...HOST_EVENT_JOURNAL_RELATIVE_PATH.split("/"));
}

/**
 * Append one host-lifecycle fact. Best-effort: diagnostics must never fail a
 * run. Each line is self-contained JSON so a death can be read without any
 * surviving process, and so concurrent writers cannot corrupt each other's
 * records (single append-mode write per line).
 */
export function appendHostEventV1(event, repoRoot = REPO_ROOT) {
  try {
    const file = hostEventJournalPath(repoRoot);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        writerPid: process.pid,
        ...event,
      })}\n`,
      "utf8",
    );
  } catch {
    // A journal write must never break a lane.
  }
}

/**
 * Decode a Windows child exit into the ACTION that produced it. Measured on
 * DESKTOP-OKEU52H 2026-08-26 with a controlled process-tree probe, because
 * exit 4294967295 had been reported for weeks as an unexplained "silent
 * crash":
 *
 *   Stop-Process -Force   -> code 4294967295 (0xFFFFFFFF), signal null
 *   taskkill /PID /F      -> code 1,          signal null
 *   taskkill /PID /T /F   -> code 1,          signal null
 *   child.kill("SIGKILL") -> code null,       signal "SIGKILL"
 *
 * The distinction is load-bearing: 4294967295 is NOT a crash and NOT an OOM.
 * It is always an external force-kill, so a death carrying it must be blamed
 * on whoever swept, never on the product.
 */
export function describeWindowsExitCodeV1(code, signal) {
  if (signal) {
    return {
      kind: "signalled",
      forcedExternally: true,
      summary: `terminated by signal ${signal}`,
    };
  }
  if (code === 0) {
    return { kind: "clean", forcedExternally: false, summary: "exited cleanly (0)" };
  }
  if (code === 4294967295) {
    return {
      kind: "force_killed_stop_process",
      forcedExternally: true,
      summary:
        "exit 4294967295 (0xFFFFFFFF) = TerminateProcess(-1), the signature of " +
        "PowerShell `Stop-Process -Force`. This host was force-killed by another " +
        "process; it did not crash and it did not run out of memory. Check the " +
        `sweep records in ${HOST_EVENT_JOURNAL_RELATIVE_PATH} for the killer.`,
    };
  }
  if (code === 1) {
    return {
      kind: "force_killed_taskkill",
      forcedExternally: true,
      summary:
        "exit 1 with no signal = `taskkill /F`. This is what an ORDERLY harness " +
        "teardown looks like, so it is only suspicious when the run had not " +
        "reached teardown.",
    };
  }
  return {
    kind: "other",
    forcedExternally: false,
    summary: `exited with code ${String(code)}`,
  };
}

/**
 * Enumerate Obsidian processes through CIM.
 *
 * Deliberately NOT `tasklist /FI`: that filter is known to lie on this machine
 * (a documented liveness trap), and a truncated or stale listing here makes a
 * LONE harness believe it has phantom survivors — which then makes it sweep.
 * CIM also carries ParentProcessId, CommandLine and CreationDate, which are
 * exactly the fields ownership scoping needs.
 */
export async function enumerateObsidianProcessesV1(imageName = "Obsidian.exe") {
  if (process.platform !== "win32") return [];
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${imageName.replace(/'/gu, "''")}'" | ` +
    "Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | " +
    "ConvertTo-Json -Compress -Depth 3";
  let raw = "";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 30_000, encoding: "utf8" },
    );
    raw = String(stdout ?? "").trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row?.ProcessId),
      parentPid: Number(row?.ParentProcessId),
      commandLine: String(row?.CommandLine ?? ""),
      createdAtMs: parseCimDate(row?.CreationDate),
    }))
    .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
}

function parseCimDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const dotnet = value.match(/\/Date\((\d+)\)\//u);
  if (dotnet) return Number(dotnet[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function commandLineNamesPort(commandLine, cdpPort) {
  if (!cdpPort) return false;
  return new RegExp(`--remote-debugging-port=${cdpPort}(?!\\d)`, "u").test(
    String(commandLine ?? ""),
  );
}

function isHelperProcess(commandLine) {
  return /--type=/u.test(String(commandLine ?? ""));
}

/**
 * Decide which Obsidian PIDs THIS harness instance owns.
 *
 * The bug this replaces killed by image name alone, so one harness instance
 * force-killed another instance's live run — and would equally have killed a
 * user's own Obsidian window. Ownership is established three ways, in order of
 * strength:
 *
 *  1. our spawned root PID, and any root whose command line carries OUR unique
 *     `--remote-debugging-port` (Electron puts it only on the browser process);
 *  2. everything transitively descended from those roots by ParentProcessId
 *     (this is how renderer/GPU/utility children are claimed — they carry no
 *     port of their own);
 *  3. orphaned helpers whose parent is no longer among the live Obsidian
 *     processes AND that were created no earlier than our root — the actual
 *     case this sweep exists for, since a self-exited root strands children
 *     that `taskkill /T` never reaches.
 *
 * Anything reachable from a FOREIGN root (a different port, or a plain root
 * with no port at all, i.e. the user's own Obsidian) is excluded first and can
 * never be selected, even if rule 3 would otherwise claim it.
 */
export function selectOwnedObsidianPidsV1({
  processes = [],
  rootPid = null,
  cdpPort = null,
  rootCreatedAtMs = null,
} = {}) {
  const rows = processes.filter(
    (row) => Number.isSafeInteger(row?.pid) && row.pid > 0,
  );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const childrenOf = new Map();
  for (const row of rows) {
    if (!childrenOf.has(row.parentPid)) childrenOf.set(row.parentPid, []);
    childrenOf.get(row.parentPid).push(row.pid);
  }
  const collectTree = (pid, into) => {
    if (into.has(pid)) return;
    into.add(pid);
    for (const child of childrenOf.get(pid) ?? []) collectTree(child, into);
  };

  const isOurRoot = (row) =>
    (rootPid !== null && row.pid === rootPid) ||
    commandLineNamesPort(row.commandLine, cdpPort);
  // A root we did not launch: no --type= helper marker and not ours. This is
  // the user's own Obsidian, or a concurrent harness on another port.
  const isForeignRoot = (row) => !isOurRoot(row) && !isHelperProcess(row.commandLine);

  const foreign = new Set();
  for (const row of rows) if (isForeignRoot(row)) collectTree(row.pid, foreign);

  const owned = new Set();
  for (const row of rows) if (isOurRoot(row)) collectTree(row.pid, owned);
  for (const pid of owned) foreign.delete(pid);

  if (rootCreatedAtMs !== null) {
    for (const row of rows) {
      if (owned.has(row.pid) || foreign.has(row.pid)) continue;
      // Still parented by a live Obsidian process => it belongs to that tree,
      // which we already classified. Only true orphans are claimable.
      if (byPid.has(row.parentPid)) continue;
      if (!isHelperProcess(row.commandLine)) continue;
      if (row.createdAtMs === null || row.createdAtMs < rootCreatedAtMs) continue;
      owned.add(row.pid);
    }
  }
  return [...owned].sort((a, b) => a - b);
}

/**
 * Force-kill only the Obsidian processes this instance owns, recording the RAW
 * enumeration next to the kill list. If a sweep ever takes a PID that was not
 * ours, that pairing proves it from a single lane's journal.
 */
export async function sweepOwnedObsidianSurvivorsV1({
  stage = "unknown",
  rootPid = null,
  cdpPort = null,
  rootCreatedAtMs = null,
  imageName = "Obsidian.exe",
  repoRoot = REPO_ROOT,
} = {}) {
  if (process.platform !== "win32") return { swept: 0, killedPids: [], observed: [] };
  const processes = await enumerateObsidianProcessesV1(imageName);
  const killedPids = selectOwnedObsidianPidsV1({
    processes,
    rootPid,
    cdpPort,
    rootCreatedAtMs,
  });
  appendHostEventV1(
    {
      kind: "owned_survivor_sweep",
      stage,
      rootPid,
      cdpPort,
      rootCreatedAtMs,
      observed: processes.map((row) => ({
        pid: row.pid,
        parentPid: row.parentPid,
        createdAtMs: row.createdAtMs,
        commandLine: row.commandLine.slice(0, 400),
      })),
      killedPids,
      sparedPids: processes
        .map((row) => row.pid)
        .filter((pid) => !killedPids.includes(pid)),
    },
    repoRoot,
  );
  for (const pid of killedPids) {
    await execFileAsync("taskkill", ["/PID", String(pid), "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
  }
  return { swept: killedPids.length, killedPids, observed: processes };
}

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
 * lane's root just as readily as a zombie; `Stop-Process -Force` then produces
 * exit 4294967295, no Windows Error Reporting event, no crash dump and no
 * stderr — a death indistinguishable from a product crash until you decode the
 * exit code. Deferring to the lock holder is what makes the sweep safe.
 */
export async function sweepTestVaultObsidianZombiesV1({
  stage = "unknown",
  env = process.env,
  repoRoot = REPO_ROOT,
  log = console,
} = {}) {
  if (process.platform !== "win32") return { swept: 0, skipped: false, reason: null };
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
