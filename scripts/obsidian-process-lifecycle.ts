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
