export interface ControlledProcessHandle {
  readonly pid?: number;
  readonly exitCode: number | null;
}

/**
 * Which pass a process readback is running in.
 *
 *   graceful — the app was ASKED to quit (Electron app.quit through the
 *             renderer bridge) and nothing has been killed yet. A normal
 *             Chromium shutdown commits DOMStorage — where Obsidian keeps its
 *             SecretStorage — so a secret rotated seconds before teardown
 *             reaches disk instead of dying with the process (the 2026-09-07
 *             Linear OAuth loss). The bound is short: a quit that does not
 *             finish promptly is handed to the kill below, unchanged.
 *   initial — nothing has been done since the kill was dispatched, so the probe
 *             must allow the OS the full unwind time it may legitimately need.
 *   recheck — the survivor sweep has just run. It force-kills with
 *             TerminateProcess, which the kernel reflects in the process table
 *             within milliseconds, so this pass is a CONFIRMATION, not another
 *             open-ended wait. Re-running the full initial timeout here was
 *             pure duplication: it repeated a wait that had already expired
 *             with no remediation in between.
 */
export type TeardownProbePhase = "graceful" | "initial" | "recheck";

export interface ControlledObsidianTeardownOperations {
  /**
   * Optional: ask the application to exit on its own before anything is
   * killed. Resolves true when the request was delivered; false (or a throw)
   * means the bridge was unavailable and the teardown proceeds straight to
   * the owned-tree kill. When delivered, the "graceful" owned-exit wait
   * decides whether the kill is still needed.
   */
  requestGracefulExit?(): Promise<boolean>;
  terminateOwnedTree(pid: number): Promise<void>;
  waitForOwnedExit(phase: TeardownProbePhase): Promise<boolean>;
  waitForNoRunningProcess(phase: TeardownProbePhase): Promise<boolean>;
  waitForCdpClose(): Promise<boolean>;
  /**
   * Optional targeted kill of surviving application processes. Orphaned
   * Electron children outlive a self-exited root (the owned tree kill is
   * skipped once exitCode is set) and a parentage-gapped taskkill /T, and a
   * hung root can outlive its own kill dispatch. The sweep runs before EVERY
   * remaining readback so it can actually rescue the teardown, and may return a
   * one-line summary of what it saw versus what it managed to reap — that line
   * is what tells a lying probe apart from a genuine leak.
   */
  sweepSurvivingProcesses?(): Promise<string | void>;
}

interface TeardownProbeResult {
  name: string;
  passed: boolean;
  error: string | null;
}

export async function terminateControlledObsidian(
  process: ControlledProcessHandle | null,
  operations: ControlledObsidianTeardownOperations,
): Promise<void> {
  if (!process?.pid) {
    return;
  }

  let dispatchError: string | null = null;
  let exitedGracefully = false;
  if (process.exitCode === null && operations.requestGracefulExit) {
    let delivered = false;
    try {
      delivered = await operations.requestGracefulExit();
    } catch {
      delivered = false;
    }
    if (delivered) {
      try {
        exitedGracefully = await operations.waitForOwnedExit("graceful");
      } catch {
        exitedGracefully = false;
      }
    }
  }
  if (process.exitCode === null && !exitedGracefully) {
    try {
      await operations.terminateOwnedTree(process.pid);
    } catch (error) {
      dispatchError = formatError(error);
    }
  }

  const probes = [
    await runProbe("owned process exit", () =>
      operations.waitForOwnedExit("initial"),
    ),
    await runProbe("Obsidian process drain", () =>
      operations.waitForNoRunningProcess("initial"),
    ),
    await runProbe("CDP port close", operations.waitForCdpClose),
  ];
  // The probes are intentionally serial because process drain and CDP closure
  // can take longer than the owned-root handle to settle on Windows.
  //
  // ORDERING IS LOAD-BEARING. The sweep is the ONLY remediation this teardown
  // has, so it must precede every readback it could rescue. It used to run
  // between the two drain checks but AFTER the owned-exit recheck had already
  // returned its final verdict — so a surviving root, which the sweep does
  // reap, still failed the teardown, and the owned-exit "recheck" was a verbatim
  // repeat of a wait that had just timed out. It is also no longer gated on CDP
  // closure: a still-open CDP port means the app is MORE alive, not less, and
  // that is precisely when the machine most needs sweeping before the next lane.
  // A still-live PID or application process remains a hard failure afterwards.
  let sweepSummary: string | null = null;
  if (!probes[0].passed || !probes[1].passed) {
    if (operations.sweepSurvivingProcesses) {
      try {
        const summary = await operations.sweepSurvivingProcesses();
        if (typeof summary === "string" && summary.trim() !== "") {
          sweepSummary = summary.trim();
        }
      } catch (error) {
        // The sweep is best-effort recovery; the rechecks below decide. Its
        // failure is still recorded — a sweep that could not run is evidence.
        sweepSummary = `sweep failed: ${formatError(error)}`;
      }
    }
    if (!probes[0].passed) {
      probes[0] = await runProbe("owned process exit", () =>
        operations.waitForOwnedExit("recheck"),
      );
    }
    if (!probes[1].passed) {
      probes[1] = await runProbe("Obsidian process drain", () =>
        operations.waitForNoRunningProcess("recheck"),
      );
    }
  }
  const failures = probes.filter((probe) => !probe.passed);
  if (failures.length === 0) {
    return;
  }

  const details = failures.map((failure) =>
    failure.error ? `${failure.name}: ${failure.error}` : failure.name,
  );
  if (dispatchError) {
    details.push(`owned PID-tree termination dispatch: ${dispatchError}`);
  }
  // The sweep summary rides OUTSIDE the parenthesised probe list: that list is
  // the stable, matched-against contract naming which readbacks failed.
  throw new Error(
    `Controlled Obsidian teardown did not drain cleanly (${details.join("; ")}).` +
      (sweepSummary ? ` Survivor sweep: ${sweepSummary}` : ""),
  );
}

async function runProbe(
  name: string,
  probe: () => Promise<boolean>,
): Promise<TeardownProbeResult> {
  try {
    return {
      name,
      passed: await probe(),
      error: null,
    };
  } catch (error) {
    return {
      name,
      passed: false,
      error: formatError(error),
    };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
