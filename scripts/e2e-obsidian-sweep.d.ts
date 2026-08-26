export const HOST_DIAGNOSTICS_RELATIVE_DIR: string;
export const HOST_EVENT_JOURNAL_RELATIVE_PATH: string;

export interface ObsidianProcessRowV1 {
  pid: number;
  parentPid: number;
  commandLine: string;
  createdAtMs: number | null;
}

export interface WindowsExitDescriptionV1 {
  kind:
    | "clean"
    | "signalled"
    | "force_killed_stop_process"
    | "force_killed_taskkill"
    | "other";
  forcedExternally: boolean;
  summary: string;
}

export function hostEventJournalPath(repoRoot?: string): string;

export function appendHostEventV1(
  event: Record<string, unknown>,
  repoRoot?: string,
): void;

export function describeWindowsExitCodeV1(
  code: number | null,
  signal: string | null,
): WindowsExitDescriptionV1;

export function enumerateObsidianProcessesV1(
  imageName?: string,
): Promise<ObsidianProcessRowV1[]>;

/**
 * Ownership identity is PID *plus* creation instant: a bare PID is not an
 * identity on Windows, where PIDs recycle and every Electron process shares one
 * image name. Unknown bounds open the window (degrade to PID-only) so a real
 * survivor is never disowned into a silent leak.
 */
export function createdWithinRootLifetimeV1(
  createdAtMs: number | null | undefined,
  rootCreatedAtMs?: number | null,
  teardownStartedAtMs?: number | null,
): boolean;

export function selectOwnedObsidianPidsV1(options?: {
  processes?: ObsidianProcessRowV1[];
  rootPid?: number | null;
  cdpPort?: number | null;
  rootCreatedAtMs?: number | null;
  teardownStartedAtMs?: number | null;
}): number[];

export interface OwnedSurvivorKillResultV1 {
  pid: number;
  killed: boolean;
  error: string | null;
}

export interface OwnedSurvivorSweepResultV1 {
  swept: number;
  killedPids: number[];
  killResults: OwnedSurvivorKillResultV1[];
  observed: ObsidianProcessRowV1[];
}

export function sweepOwnedObsidianSurvivorsV1(options?: {
  stage?: string;
  rootPid?: number | null;
  cdpPort?: number | null;
  rootCreatedAtMs?: number | null;
  teardownStartedAtMs?: number | null;
  imageName?: string;
  repoRoot?: string;
}): Promise<OwnedSurvivorSweepResultV1>;

export function describeSweepOutcomeV1(
  result: OwnedSurvivorSweepResultV1 | null | undefined,
): string;

export function waitForOwnedRootExitV1(options?: {
  handle?: { readonly exitCode: number | null } | null;
  rootPid?: number | null;
  rootCreatedAtMs?: number | null;
  teardownStartedAtMs?: number | null;
  imageName?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean>;

export function summarizeRecentHostDeathV1(
  sinceMs: number,
  repoRoot?: string,
): string | null;
