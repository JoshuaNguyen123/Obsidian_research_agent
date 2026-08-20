import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ControlledProcessHandle {
  readonly pid?: number;
  readonly exitCode: number | null;
}

export interface ControlledObsidianTeardownOperations {
  terminateOwnedTree(pid: number): Promise<void>;
  waitForOwnedExit(): Promise<boolean>;
  waitForNoRunningProcess(): Promise<boolean>;
  waitForCdpClose(): Promise<boolean>;
  /**
   * Optional targeted kill of surviving application processes. Orphaned
   * Electron children outlive a self-exited root (the owned tree kill is
   * skipped once exitCode is set) and a parentage-gapped taskkill /T; the
   * sweep runs before the terminal drain recheck so they cannot fail the
   * teardown or poison the next lane's already-running check.
   */
  sweepSurvivingProcesses?(): Promise<void>;
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
  if (process.exitCode === null) {
    try {
      await operations.terminateOwnedTree(process.pid);
    } catch (error) {
      dispatchError = formatError(error);
    }
  }

  const probes = [
    await runProbe("owned process exit", operations.waitForOwnedExit),
    await runProbe("Obsidian process drain", operations.waitForNoRunningProcess),
    await runProbe("CDP port close", operations.waitForCdpClose),
  ];
  // The probes are intentionally serial because process drain and CDP closure
  // can take longer than the owned-root handle to settle on Windows. Once CDP
  // is confirmed closed, reconcile one boundary race on either earlier process
  // readback before deciding teardown failed. A still-live PID or application
  // process remains a hard failure after this terminal recheck.
  if (probes[2].passed) {
    if (!probes[0].passed) {
      probes[0] = await runProbe(
        "owned process exit",
        operations.waitForOwnedExit,
      );
    }
    if (!probes[1].passed) {
      if (operations.sweepSurvivingProcesses) {
        try {
          await operations.sweepSurvivingProcesses();
        } catch {
          // The sweep is best-effort recovery; the recheck below decides.
        }
      }
      probes[1] = await runProbe(
        "Obsidian process drain",
        operations.waitForNoRunningProcess,
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
  throw new Error(
    `Controlled Obsidian teardown did not drain cleanly (${details.join("; ")}).`,
  );
}

export interface WindowsProcessExitProbeOptions {
  /**
   * Authoritative exit signal: Node sets exitCode only after the OS reports
   * the child's exit, so a non-null value ends the wait immediately without
   * consulting tasklist (whose bare-PID filter can match a recycled PID).
   */
  handle?: ControlledProcessHandle;
  /**
   * Restrict tasklist matches to this image name so a foreign process that
   * claimed the recycled PID can never masquerade as the still-live root.
   */
  expectedImageName?: string;
}

export async function waitForWindowsProcessExit(
  pid: number,
  timeoutMs: number,
  options: WindowsProcessExitProbeOptions = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (options.handle && options.handle.exitCode !== null) {
      return true;
    }
    if (!(await isWindowsProcessIdRunning(pid, options.expectedImageName))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (options.handle && options.handle.exitCode !== null) {
    return true;
  }
  const row = await windowsTasklistRow(pid, options.expectedImageName);
  if (row !== null) {
    console.warn(
      `[obsidian-lifecycle] PID ${pid} still matched tasklist after ${timeoutMs}ms: ${row}`,
    );
    return false;
  }
  return true;
}

export function tasklistContainsProcessId(
  output: string,
  pid: number,
  expectedImageName?: string,
): boolean {
  return tasklistMatchingRow(output, pid, expectedImageName) !== null;
}

function tasklistMatchingRow(
  output: string,
  pid: number,
  expectedImageName?: string,
): string | null {
  const escapedPid = String(pid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imagePattern = expectedImageName
    ? expectedImageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "[^\"]+";
  const match = new RegExp(
    `^"${imagePattern}","${escapedPid}",[^\r\n]*`,
    "imu",
  ).exec(output);
  return match ? match[0] : null;
}

async function isWindowsProcessIdRunning(
  pid: number,
  expectedImageName?: string,
): Promise<boolean> {
  return (await windowsTasklistRow(pid, expectedImageName)) !== null;
}

async function windowsTasklistRow(
  pid: number,
  expectedImageName?: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { windowsHide: true },
  );
  return tasklistMatchingRow(String(stdout), pid, expectedImageName);
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
