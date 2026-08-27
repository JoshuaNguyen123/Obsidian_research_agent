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
 * `ok:false` is the third state that keeps "we could not look" from being read
 * as "there is nothing there". A caller that treats a failed read as an empty
 * process table scores a live leak green.
 */
export interface ObsidianEnumerationV1 {
  ok: boolean;
  processes: ObsidianProcessRowV1[];
  error: string | null;
}

export function enumerateObsidianProcessesDetailedV1(
  imageName?: string,
): Promise<ObsidianEnumerationV1>;

export type TaskkillOutcomeV1 =
  | "killed"
  | "not_found"
  | "terminating"
  | "access_denied"
  | "kill_failed";

export interface TaskkillDescriptionV1 {
  outcome: TaskkillOutcomeV1;
  killed: boolean;
  /** Is another kill attempt worth making? */
  reapable: boolean;
  /** Will the next lane's already-running gate still see this PID? */
  occupiesImageName: boolean;
  error: string | null;
}

export function describeTaskkillOutcomeV1(
  error: unknown,
): TaskkillDescriptionV1;

export function forceKillPidV1(
  pid: number,
  execImpl?: (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<TaskkillDescriptionV1 & { pid: number }>;

/** Deepest descendants first, so a killed root cannot orphan its children. */
export function orderKillsLeafFirstV1(
  pids: readonly number[],
  processes: readonly ObsidianProcessRowV1[],
): number[];

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
  outcome?: TaskkillOutcomeV1;
  reapable?: boolean;
  occupiesImageName?: boolean;
  pass?: number;
}

export interface OwnedSurvivorSweepResultV1 {
  swept: number;
  killedPids: number[];
  killResults: OwnedSurvivorKillResultV1[];
  observed: ObsidianProcessRowV1[];
  /** Owned PIDs STILL present on a verifying re-enumeration after the sweep. */
  residualPids?: number[];
  enumerationOk?: boolean;
  enumerationError?: string | null;
}

export function sweepOwnedObsidianSurvivorsV1(options?: {
  stage?: string;
  rootPid?: number | null;
  cdpPort?: number | null;
  rootCreatedAtMs?: number | null;
  teardownStartedAtMs?: number | null;
  imageName?: string;
  repoRoot?: string;
  passes?: number;
  passDelayMs?: number;
  enumerate?: (imageName?: string) => Promise<ObsidianEnumerationV1>;
  kill?: (pid: number) => Promise<TaskkillDescriptionV1 & { pid: number }>;
  sleep?: (ms: number) => Promise<void>;
  platform?: string;
}): Promise<OwnedSurvivorSweepResultV1>;

export interface OwnedHostSpawnV1 {
  pid: number;
  spawnedAtMs: number;
  label: string | null;
  cdpPort: number | null;
}

export const SPAWN_CLAIM_WINDOW_MS: number;

export function readOwnedHostSpawnsV1(options?: {
  sinceMs?: number;
  repoRoot?: string;
}): OwnedHostSpawnV1[];

/**
 * Campaign-scope ownership: PID *plus* creation instant, proven against this
 * repo root's own spawn journal. A row with no creation time is never claimed —
 * a wrong claim here force-kills a concurrent session's live lane.
 */
export function selectJournalOwnedResidueV1(options?: {
  processes?: ObsidianProcessRowV1[];
  spawns?: OwnedHostSpawnV1[];
  claimWindowMs?: number;
}): number[];

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
