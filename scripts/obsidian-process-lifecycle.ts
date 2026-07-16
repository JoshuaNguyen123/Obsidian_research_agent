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

export async function waitForWindowsProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isWindowsProcessIdRunning(pid))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !(await isWindowsProcessIdRunning(pid));
}

export function tasklistContainsProcessId(output: string, pid: number): boolean {
  const escapedPid = String(pid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^"[^"]+","${escapedPid}",`, "imu").test(output);
}

async function isWindowsProcessIdRunning(pid: number): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { windowsHide: true },
  );
  return tasklistContainsProcessId(String(stdout), pid);
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
