export interface MissionScorecardRegressionResult {
  checkedRecords: number;
  skipped: boolean;
}

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
