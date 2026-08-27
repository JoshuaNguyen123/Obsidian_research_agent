// CommonJS on purpose. Playwright loads the e2e fixtures as CommonJS, so a
// fixture cannot import an ESM `.mjs` (it fails with "Cannot use 'import.meta'
// outside a module"), while the campaign runners are plain Node ESM. A CJS
// core is the one shape BOTH can consume, which is what keeps this single
// shared implementation from splitting back into per-caller copies.
//
// The lock-aware campaign sweep needs the ESM runner's lock helpers and
// therefore lives in the thin ESM wrapper, e2e-obsidian-campaign-sweep.mjs.
const { appendFileSync, mkdirSync, readFileSync } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.dirname(__dirname);

/**
 * Durable host-death journal. It must NOT live under test-results/, which
 * Playwright wipes at the start of every run — that wipe is why three silent
 * host deaths on 2026-08-26 left no evidence behind. Gitignored.
 */
const HOST_DIAGNOSTICS_RELATIVE_DIR = "e2e-host-diagnostics";
const HOST_EVENT_JOURNAL_RELATIVE_PATH = `${HOST_DIAGNOSTICS_RELATIVE_DIR}/host-events.jsonl`;

function hostEventJournalPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, ...HOST_EVENT_JOURNAL_RELATIVE_PATH.split("/"));
}

/**
 * Append one host-lifecycle fact. Best-effort: diagnostics must never fail a
 * run. Each line is self-contained JSON so a death can be read without any
 * surviving process, and so concurrent writers cannot corrupt each other's
 * records (single append-mode write per line).
 */
function appendHostEventV1(event, repoRoot = REPO_ROOT) {
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
function describeWindowsExitCodeV1(code, signal) {
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
 * Decode what `taskkill /PID n /F` actually reported. Measured against the
 * 2026-08-27 compound campaign journal, where SIX kill dispatches against one
 * leaked root all "failed" and the harness reported a single undifferentiated
 * `kill FAILED` — a sentence that cannot be acted on, because these four
 * outcomes need four different responses:
 *
 *   killed        — TerminateProcess succeeded. Done.
 *   not_found     — `ERROR: The process "N" not found.` The PID is not in the
 *                   process table at all. Our enumeration snapshot was stale;
 *                   there is nothing to reap and nothing to report.
 *   terminating   — `ERROR: The process with PID N could not be terminated.
 *                   Reason: There is no running instance of the task.`
 *                   taskkill FOUND the PID but termination is already in
 *                   flight, so no further kill can reach it. This is the shape
 *                   that cost attempts 1 and 3: the process is genuinely
 *                   unreapable AND genuinely still occupying the image name, so
 *                   it is neither a probe lying nor a kill we botched. Only
 *                   time removes it — and until it goes, the next lane's
 *                   already-running gate will refuse.
 *   access_denied — `Reason: Access is denied.` We do not own it, or it is
 *                   elevated. A sweep must NEVER escalate around this; it is
 *                   the signal that ownership scoping got something wrong.
 *
 * `reapable` answers the only question the sweep can act on: is another kill
 * attempt worth making? `occupiesImageName` answers the question the NEXT lane
 * cares about: will the already-running gate still see this PID?
 */
function describeTaskkillOutcomeV1(error) {
  if (!error) {
    return {
      outcome: "killed",
      killed: true,
      reapable: false,
      occupiesImageName: false,
      error: null,
    };
  }
  const message = summarizeError(error);
  if (/not found/iu.test(message)) {
    return {
      outcome: "not_found",
      killed: false,
      reapable: false,
      occupiesImageName: false,
      error: message,
    };
  }
  if (/there is no running instance of the task/iu.test(message)) {
    return {
      outcome: "terminating",
      killed: false,
      reapable: false,
      occupiesImageName: true,
      error: message,
    };
  }
  if (/access is denied/iu.test(message)) {
    return {
      outcome: "access_denied",
      killed: false,
      reapable: false,
      occupiesImageName: true,
      error: message,
    };
  }
  return {
    outcome: "kill_failed",
    killed: false,
    reapable: true,
    occupiesImageName: true,
    error: message,
  };
}

async function forceKillPidV1(pid, execImpl = execFileAsync) {
  return execImpl("taskkill", ["/PID", String(pid), "/F"], {
    windowsHide: true,
  }).then(
    () => ({ pid, ...describeTaskkillOutcomeV1(null) }),
    (error) => ({ pid, ...describeTaskkillOutcomeV1(error) }),
  );
}

/**
 * Order a kill list LEAF-FIRST.
 *
 * Killing a root before its children hands those children to a new parent, so
 * the very next enumeration sees them as orphans rather than as members of a
 * tree we already claimed — and rule 3 only claims an orphan when
 * `rootCreatedAtMs` is known. Reaping depth-first removes the reparenting
 * window entirely instead of relying on a later rule to recover from it.
 */
function orderKillsLeafFirstV1(pids, processes) {
  const parentOf = new Map(
    processes.map((row) => [row.pid, row.parentPid]),
  );
  const target = new Set(pids);
  const depth = (pid) => {
    let steps = 0;
    let cursor = pid;
    const guard = new Set();
    while (!guard.has(cursor)) {
      guard.add(cursor);
      const parent = parentOf.get(cursor);
      if (parent === undefined || !target.has(parent)) break;
      cursor = parent;
      steps += 1;
    }
    return steps;
  };
  return [...pids].sort((a, b) => depth(b) - depth(a) || a - b);
}

/**
 * Enumerate Obsidian processes through CIM, REPORTING WHETHER THE READ WORKED.
 *
 * Deliberately NOT `tasklist /FI`: that filter is known to lie on this machine
 * (a documented liveness trap), and a truncated or stale listing here makes a
 * LONE harness believe it has phantom survivors — which then makes it sweep.
 * CIM also carries ParentProcessId, CommandLine and CreationDate, which are
 * exactly the fields ownership scoping needs.
 *
 * THE FAILURE-IS-NOT-EMPTINESS RULE. This used to `catch { return [] }`, so a
 * PowerShell spawn that timed out (30s — reachable on a machine at 100% CPU,
 * which is exactly when leaks happen) was indistinguishable from "no Obsidian
 * is running". Every caller reads that answer as CLEAN: the drain probe passes,
 * `obsidianRunning()` says no, and the survivor sweep claims nothing and kills
 * nothing. A failed read therefore scored a leak GREEN and handed the live
 * process to the next lane's already-running check. `ok:false` is the third
 * state that keeps "we could not look" from masquerading as "there is nothing
 * there".
 */
async function enumerateObsidianProcessesDetailedV1(imageName = "Obsidian.exe") {
  if (process.platform !== "win32") {
    return { ok: true, processes: [], error: null };
  }
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
  } catch (error) {
    return {
      ok: false,
      processes: [],
      error: `CIM enumeration failed: ${summarizeError(error)}`,
    };
  }
  // An empty stdout is a genuine "no matching process": Get-CimInstance emits
  // nothing when the filter matches nothing.
  if (!raw) return { ok: true, processes: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      processes: [],
      error: `CIM enumeration returned unparseable output: ${summarizeError(error)}`,
    };
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return {
    ok: true,
    error: null,
    processes: rows
      .map((row) => ({
        pid: Number(row?.ProcessId),
        parentPid: Number(row?.ParentProcessId),
        commandLine: String(row?.CommandLine ?? ""),
        createdAtMs: parseCimDate(row?.CreationDate),
      }))
      .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0),
  };
}

/**
 * Compatibility shape for callers that only want the rows. A caller that must
 * distinguish "nothing running" from "could not look" MUST use the detailed
 * form — this one still collapses the two.
 */
async function enumerateObsidianProcessesV1(imageName = "Obsidian.exe") {
  return (await enumerateObsidianProcessesDetailedV1(imageName)).processes;
}

function summarizeError(error) {
  return String(error?.stderr || error?.message || error)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
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
 * Is this row's creation instant inside the window our root process occupied?
 *
 * THE PID-RECYCLING HOLE THIS CLOSES. Windows hands PIDs back out aggressively,
 * and EVERY process in an Electron app shares one image name — so "PID 8412
 * named Obsidian.exe" is not an identity at all, and the image-name guard that
 * was supposed to defeat recycling defeats nothing here: the likeliest claimant
 * of a freed Obsidian PID is another Obsidian process. A recycled root PID made
 * BOTH teardown process probes report a dead root as still-alive, which is the
 * false red this window removes.
 *
 * Creation time closes it, and the bound is causal rather than a tolerance
 * guess: `rootCreatedAtMs` is stamped immediately BEFORE spawn() and
 * `teardownStartedAtMs` when teardown begins, so our root was necessarily
 * created inside that interval. Our root's PID cannot be recycled until our
 * root dies, and our root dies DURING teardown — therefore a row bearing our
 * PID but created after teardown began is, by construction, a different process
 * wearing our number.
 *
 * When a bound (or the row's own creation time) is unknown the window opens
 * fully and ownership degrades to the historical PID-only test. That direction
 * is deliberate: disowning a real survivor turns a genuine leak into a silent
 * green that poisons the NEXT lane's already-running check, which is strictly
 * worse than the false red this exists to remove.
 */
function createdWithinRootLifetimeV1(
  createdAtMs,
  rootCreatedAtMs = null,
  teardownStartedAtMs = null,
) {
  if (createdAtMs === null || createdAtMs === undefined) return true;
  if (rootCreatedAtMs !== null && createdAtMs < rootCreatedAtMs) return false;
  if (teardownStartedAtMs !== null && createdAtMs > teardownStartedAtMs) return false;
  return true;
}

/**
 * Decide which Obsidian PIDs THIS harness instance owns.
 *
 * The bug this replaces killed by image name alone, so one harness instance
 * force-killed another instance's live run — and would equally have killed a
 * user's own Obsidian window. Ownership is established three ways, in order of
 * strength:
 *
 *  1. our spawned root PID *qualified by creation time* (see
 *     createdWithinRootLifetimeV1 — a bare PID is not an identity on Windows),
 *     and any root whose command line carries OUR unique
 *     `--remote-debugging-port` (Electron puts it only on the browser process,
 *     and the port is exclusive, so that match needs no time qualifier);
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
function selectOwnedObsidianPidsV1({
  processes = [],
  rootPid = null,
  cdpPort = null,
  rootCreatedAtMs = null,
  teardownStartedAtMs = null,
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

  const withinRootLifetime = (row) =>
    createdWithinRootLifetimeV1(row.createdAtMs, rootCreatedAtMs, teardownStartedAtMs);
  const isOurRoot = (row) =>
    (rootPid !== null && row.pid === rootPid && withinRootLifetime(row)) ||
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
      // No creation time => no claim. An orphan is claimed on evidence, never
      // on suspicion, and the same lifetime window that qualifies the root PID
      // bounds the claim at BOTH ends: a helper that appeared after teardown
      // began cannot be a child of the root we are tearing down.
      if (row.createdAtMs === null) continue;
      if (!withinRootLifetime(row)) continue;
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
async function sweepOwnedObsidianSurvivorsV1({
  stage = "unknown",
  rootPid = null,
  cdpPort = null,
  rootCreatedAtMs = null,
  teardownStartedAtMs = null,
  imageName = "Obsidian.exe",
  repoRoot = REPO_ROOT,
  // A single snapshot cannot reap a tree. Re-enumerating catches children that
  // were mid-spawn during the first read and any that reparented as their root
  // died; without it the sweep could only ever kill what it happened to see in
  // one instant.
  passes = 3,
  passDelayMs = 400,
  enumerate = enumerateObsidianProcessesDetailedV1,
  kill = forceKillPidV1,
  sleep = delayMs,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    return {
      swept: 0,
      killedPids: [],
      killResults: [],
      observed: [],
      residualPids: [],
      enumerationOk: true,
      enumerationError: null,
    };
  }
  const killResults = [];
  const killedPids = [];
  let observed = [];
  let enumerationOk = true;
  let enumerationError = null;
  let owned = [];

  for (let pass = 0; pass < Math.max(1, passes); pass += 1) {
    const reading = await enumerate(imageName);
    enumerationOk = reading.ok;
    enumerationError = reading.error;
    // "We could not look" must never be reported as "there was nothing there".
    // Claiming nothing on a failed read is what let a live survivor through.
    if (!reading.ok) break;
    observed = reading.processes;
    owned = selectOwnedObsidianPidsV1({
      processes: observed,
      rootPid,
      cdpPort,
      rootCreatedAtMs,
      teardownStartedAtMs,
    });
    if (pass === 0) {
      appendHostEventV1(
        {
          kind: "owned_survivor_sweep",
          stage,
          rootPid,
          cdpPort,
          rootCreatedAtMs,
          teardownStartedAtMs,
          observed: observed.map((row) => ({
            pid: row.pid,
            parentPid: row.parentPid,
            createdAtMs: row.createdAtMs,
            commandLine: row.commandLine.slice(0, 400),
          })),
          killedPids: owned,
          sparedPids: observed
            .map((row) => row.pid)
            .filter((pid) => !owned.includes(pid)),
        },
        repoRoot,
      );
    }
    if (owned.length === 0) break;
    // Per-PID outcomes, not a swallowed `.catch(() => undefined)`. A kill that
    // FAILED and a kill that succeeded used to be the same observable event, so
    // "the drain still sees survivors after the sweep" could not be read as
    // either "the sweep could not kill them" or "the probe is lying about
    // them" — the exact discrimination this teardown failure needs.
    for (const pid of orderKillsLeafFirstV1(owned, observed)) {
      const outcome = await kill(pid);
      killResults.push({ ...outcome, pass });
      if (!killedPids.includes(pid)) killedPids.push(pid);
    }
    // Another pass is worth making whenever this one CHANGED something (a kill
    // that landed can orphan children, and a child that was mid-spawn during
    // the first read only shows up on a later one) or when a failure is still
    // retryable. It is worth nothing when every survivor is beyond any kill —
    // a tree reporting `terminating` will not yield to more force, so spinning
    // on it would burn teardown budget for no chance of progress.
    const thisPass = killResults.filter((entry) => entry.pass === pass);
    if (thisPass.every((entry) => !entry.killed && !entry.reapable)) break;
    if (pass < Math.max(1, passes) - 1) await sleep(passDelayMs);
  }

  // What is STILL there after the sweep, by proven ownership — the only honest
  // answer to "did the sweep work", and the fact the next attempt needs.
  let residualPids = [];
  if (enumerationOk) {
    const verify = await enumerate(imageName);
    if (verify.ok) {
      observed = verify.processes;
      residualPids = selectOwnedObsidianPidsV1({
        processes: verify.processes,
        rootPid,
        cdpPort,
        rootCreatedAtMs,
        teardownStartedAtMs,
      });
    } else {
      enumerationOk = false;
      enumerationError = verify.error;
    }
  }

  const result = {
    swept: killResults.filter((entry) => entry.killed).length,
    killedPids,
    killResults,
    observed,
    residualPids,
    enumerationOk,
    enumerationError,
  };
  appendHostEventV1(
    {
      kind: "owned_survivor_sweep_result",
      stage,
      rootPid,
      cdpPort,
      killResults,
      residualPids,
      enumerationOk,
      enumerationError,
    },
    repoRoot,
  );
  return result;
}

/**
 * One line naming what the sweep SAW versus what it could actually reap, for
 * the teardown error a human reads at 3am. The two shapes it must tell apart:
 *
 *   "observed 4, claimed 0" — Obsidian processes exist but none is ours. A
 *      probe that still fails after this is lying (recycled PID, foreign
 *      instance), not reporting a leak.
 *   "claimed 4, kill FAILED for 8412" — a genuine survivor the harness could
 *      not reap. That is a real leak and must stay red.
 */
function describeSweepOutcomeV1(result) {
  const observed = result?.observed ?? [];
  const killResults = result?.killResults ?? [];
  // One verdict per PID: the LAST pass is what the machine was left in.
  const finalByPid = new Map();
  for (const entry of killResults) {
    finalByPid.set(entry.pid, {
      ...entry,
      // Records written before the fingerprint table existed carry only
      // killed/error, so derive the outcome rather than mislabel them.
      outcome:
        entry.outcome ??
        (entry.killed ? "killed" : describeTaskkillOutcomeV1(entry.error).outcome),
    });
  }
  const claimed = result?.killedPids?.length
    ? result.killedPids
    : [...finalByPid.keys()];
  const parts = [`observed ${observed.length} Obsidian process(es)`];
  if (result && result.enumerationOk === false) {
    // A sweep that could not look must not be read as a sweep that found
    // nothing — that conflation scored real leaks green.
    parts.push(
      `ENUMERATION FAILED (${result.enumerationError ?? "unknown error"}) — ` +
      "this reading proves nothing about what is running",
    );
  }
  if (claimed.length === 0) {
    parts.push("claimed 0 as owned");
  } else {
    const finals = claimed.map((pid) => finalByPid.get(pid)).filter(Boolean);
    parts.push(
      `claimed ${claimed.length} as owned [${claimed.join(", ")}], ` +
      `force-killed ${finals.filter((entry) => entry.killed).length}`,
    );
    const byOutcome = (outcome) =>
      finals.filter((entry) => entry.outcome === outcome);
    const alreadyGone = byOutcome("not_found");
    if (alreadyGone.length > 0) {
      parts.push(
        `already gone before the kill: ${alreadyGone.map((entry) => entry.pid).join(", ")} ` +
        "(stale snapshot, not a leak)",
      );
    }
    const terminating = byOutcome("terminating");
    if (terminating.length > 0) {
      // The shape that cost attempts 1 and 3 of the 2026-08-27 campaign. It is
      // NOT a kill we botched and NOT a probe lying: no kill can reach a
      // process already terminating, and it keeps occupying the image name
      // until the kernel finishes, so the next lane's gate will refuse.
      parts.push(
        `STILL TERMINATING, unreapable by any kill: ${terminating.map((entry) => entry.pid).join(", ")} ` +
        "(taskkill reports the termination is already in flight; only time removes these)",
      );
    }
    const failed = finals.filter(
      (entry) =>
        !entry.killed &&
        entry.outcome !== "not_found" &&
        entry.outcome !== "terminating",
    );
    if (failed.length > 0) {
      parts.push(
        `kill FAILED for ${failed.map((entry) => `${entry.pid} (${entry.error})`).join(", ")}`,
      );
    }
  }
  const residual = result?.residualPids ?? [];
  if (residual.length > 0) {
    parts.push(`still present after the sweep: ${residual.join(", ")}`);
  }
  return parts.join("; ");
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for OUR root Obsidian process to be gone, authoritatively.
 *
 * This replaces a `tasklist /FI "PID eq <pid>"` readback. Two independent
 * reasons, both already paid for in this repo:
 *   - `tasklist /FI` is documented to lie about liveness on this machine; CIM
 *     is the enumeration every other liveness question here already uses.
 *   - the old readback identified our root as "this PID, image Obsidian.exe",
 *     which cannot survive PID recycling inside an Electron app where every
 *     process carries that image name. CIM carries CreationDate, so identity
 *     becomes PID *and* creation instant.
 *
 * The child handle stays the fastest authority: Node sets exitCode only once
 * the OS has reported the child's exit, so a non-null exitCode ends the wait
 * without consulting the OS at all.
 */
async function waitForOwnedRootExitV1({
  handle = null,
  rootPid = null,
  rootCreatedAtMs = null,
  teardownStartedAtMs = null,
  imageName = "Obsidian.exe",
  timeoutMs = 30_000,
  pollMs = 250,
} = {}) {
  if (rootPid === null || rootPid === undefined) return true;
  const stillAlive = async () => {
    if (handle && handle.exitCode !== null) return false;
    const reading = await enumerateObsidianProcessesDetailedV1(imageName);
    // A read that FAILED says nothing about liveness. Treating it as "no rows,
    // therefore exited" turned every CIM timeout under load into a green
    // teardown over a live process — the silent leak that poisons the next
    // lane. Unknown resolves to "still alive": a false red is recoverable, a
    // leaked host is not.
    if (!reading.ok) return true;
    return reading.processes.some(
      (row) =>
        row.pid === rootPid &&
        createdWithinRootLifetimeV1(
          row.createdAtMs,
          rootCreatedAtMs,
          teardownStartedAtMs,
        ),
    );
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await stillAlive())) return true;
    await delayMs(pollMs);
  }
  return !(await stillAlive());
}

/**
 * Read back what the journal says about this run's host, so a failing poll can
 * report the REAL cause instead of the poll it happened to die in. Returns the
 * most recent host_exited/renderer_crashed record at or after `sinceMs`.
 */
function summarizeRecentHostDeathV1(sinceMs, repoRoot = REPO_ROOT) {
  let lines;
  try {
    lines = readFileSync(hostEventJournalPath(repoRoot), "utf8")
      .split(/\r?\n/u)
      .filter(Boolean);
  } catch {
    return null;
  }
  for (const line of lines.reverse()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(String(event.ts ?? ""));
    if (!Number.isFinite(at) || at < sinceMs) continue;
    if (event.kind !== "host_exited" && event.kind !== "renderer_crashed") continue;
    return (
      `${String(event.kind)}: ${String(event.diagnosis ?? "")} ` +
      `(exitCode=${String(event.exitCode ?? "n/a")}, ` +
      `signal=${String(event.signal ?? "n/a")}, ` +
      `teardownRequested=${String(event.teardownRequested ?? "n/a")})`
    );
  }
  return null;
}

/**
 * Every Obsidian root THIS repo root spawned at or after `sinceMs`, read back
 * from the durable journal.
 *
 * The campaign sweep runs BETWEEN attempts, so it has no live handle and no
 * root PID of its own — which is why it used to select by
 * `CommandLine -match 'test_vault_obsidian_ai'`. That is the exact rule that
 * once force-killed another session's live lane: the vault path is shared by
 * every instance, so it identifies a MACHINE-WIDE class, not a possession. The
 * journal is the campaign's own write log; a spawn record in it is proof the
 * campaign started that process.
 */
function readOwnedHostSpawnsV1({ sinceMs = 0, repoRoot = REPO_ROOT } = {}) {
  let lines;
  try {
    lines = readFileSync(hostEventJournalPath(repoRoot), "utf8")
      .split(/\r?\n/u)
      .filter(Boolean);
  } catch {
    return [];
  }
  const spawns = [];
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.kind !== "host_spawned") continue;
    const spawnedAtMs = Date.parse(String(event.ts ?? ""));
    const pid = Number(event.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (!Number.isFinite(spawnedAtMs) || spawnedAtMs < sinceMs) continue;
    spawns.push({
      pid,
      spawnedAtMs,
      label: event.label ?? null,
      cdpPort: event.cdpPort ?? null,
    });
  }
  return spawns;
}

/**
 * Default slack between a process's creation instant and the journal line that
 * records it. Measured across the 2026-08-27 campaign's ten spawns: the record
 * lands 14–305ms AFTER the kernel's CreationDate. 60s is far beyond anything
 * observed and still bounded.
 */
const SPAWN_CLAIM_WINDOW_MS = 60_000;

/**
 * Which LIVE Obsidian PIDs are residue this campaign itself created?
 *
 * Ownership is PID *and* creation instant, exactly as the teardown sweep
 * requires, and the bound is causal rather than a tolerance guess:
 *
 *   our process occupies its PID from its creation until it exits, and the
 *   journal line is written once spawn() has returned — so the line's instant
 *   necessarily falls INSIDE our process's lifetime. Any other process wearing
 *   that PID can only have been created after ours exited, which is strictly
 *   after the journal line. `createdAtMs <= spawnedAtMs` therefore excludes
 *   every PID-recycled impostor by construction.
 *
 * A row with NO creation time is NOT claimed. That is the opposite fail-safe
 * from the teardown sweep, and deliberately so: teardown owns its root by
 * construction, so disowning a survivor there would hide a leak, whereas here
 * a wrong claim force-kills a concurrent session's live lane. A missed claim
 * is now harmless — the caller reports residue and the campaign declines to
 * spend an attempt instead of starting into it.
 */
function selectJournalOwnedResidueV1({
  processes = [],
  spawns = [],
  claimWindowMs = SPAWN_CLAIM_WINDOW_MS,
} = {}) {
  const rows = processes.filter(
    (row) => Number.isSafeInteger(row?.pid) && row.pid > 0,
  );
  const spawnByPid = new Map();
  for (const spawn of spawns) {
    const existing = spawnByPid.get(spawn.pid);
    if (!existing || spawn.spawnedAtMs > existing.spawnedAtMs) {
      spawnByPid.set(spawn.pid, spawn);
    }
  }
  const isOurSpawn = (row) => {
    const spawn = spawnByPid.get(row.pid);
    if (!spawn) return false;
    // No creation instant => no proof => no claim.
    if (row.createdAtMs === null || row.createdAtMs === undefined) return false;
    if (row.createdAtMs > spawn.spawnedAtMs) return false;
    return row.createdAtMs >= spawn.spawnedAtMs - claimWindowMs;
  };

  const childrenOf = new Map();
  for (const row of rows) {
    if (!childrenOf.has(row.parentPid)) childrenOf.set(row.parentPid, []);
    childrenOf.get(row.parentPid).push(row.pid);
  }
  const owned = new Set();
  const collectTree = (pid) => {
    if (owned.has(pid)) return;
    owned.add(pid);
    for (const child of childrenOf.get(pid) ?? []) collectTree(child);
  };
  for (const row of rows) if (isOurSpawn(row)) collectTree(row.pid);
  return [...owned].sort((a, b) => a - b);
}

module.exports = {
  summarizeRecentHostDeathV1,
  HOST_DIAGNOSTICS_RELATIVE_DIR,
  HOST_EVENT_JOURNAL_RELATIVE_PATH,
  hostEventJournalPath,
  appendHostEventV1,
  describeWindowsExitCodeV1,
  describeTaskkillOutcomeV1,
  forceKillPidV1,
  orderKillsLeafFirstV1,
  enumerateObsidianProcessesV1,
  enumerateObsidianProcessesDetailedV1,
  createdWithinRootLifetimeV1,
  selectOwnedObsidianPidsV1,
  sweepOwnedObsidianSurvivorsV1,
  describeSweepOutcomeV1,
  waitForOwnedRootExitV1,
  readOwnedHostSpawnsV1,
  selectJournalOwnedResidueV1,
  SPAWN_CLAIM_WINDOW_MS,
};
