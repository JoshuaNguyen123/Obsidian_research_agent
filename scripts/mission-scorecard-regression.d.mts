export interface MissionScorecardRegressionResult {
  checkedRecords: number;
  skipped: boolean;
  /**
   * Present only on a skip, naming which one: "empty_baseline" when no lane
   * carries a record, "no_run_summary" when nothing has run on this machine.
   */
  reason?: string;
  /** Records validated when no run was available to compare against. */
  validatedBaselineRecords?: number;
}

export const DEFAULT_MISSION_SCORECARD_BASELINE_PATH: string;
export const DEFAULT_DAILY_USE_SUMMARY_PATH: string;
export const MISSION_SCORECARD_EXEMPT_PROJECTS: ReadonlySet<string>;
export const PROOF_CLASS_ENFORCED_PROJECTS: ReadonlySet<string>;
export const DIMENSION_IDS: readonly string[];

export function missionScorecardRecordKey(record: unknown): string;
export function missionScorecardExecutionKey(record: unknown): string;
export function assertMissionScorecardRegressions(input: {
  summary: unknown;
  baseline: unknown;
  selectedProjects?: string[];
  executedTests?: Array<{ project: string; file: string; title: string }>;
}): MissionScorecardRegressionResult;
export function assertMissionScorecardSummaryFile(options?: {
  baselinePath?: string;
  summaryPath?: string;
  selectedProjects?: string[];
  executedTests?: Array<{ project: string; file: string; title: string }>;
}): Promise<MissionScorecardRegressionResult>;

export function baselineRecordIsCurrent(record: unknown): boolean;
