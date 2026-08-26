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

export function selectOwnedObsidianPidsV1(options?: {
  processes?: ObsidianProcessRowV1[];
  rootPid?: number | null;
  cdpPort?: number | null;
  rootCreatedAtMs?: number | null;
}): number[];

export function sweepOwnedObsidianSurvivorsV1(options?: {
  stage?: string;
  rootPid?: number | null;
  cdpPort?: number | null;
  rootCreatedAtMs?: number | null;
  imageName?: string;
  repoRoot?: string;
}): Promise<{
  swept: number;
  killedPids: number[];
  observed: ObsidianProcessRowV1[];
}>;

export function summarizeRecentHostDeathV1(
  sinceMs: number,
  repoRoot?: string,
): string | null;
