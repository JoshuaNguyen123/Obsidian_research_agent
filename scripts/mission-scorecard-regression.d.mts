export interface MissionScorecardRegressionResult {
  checkedRecords: number;
  skipped: boolean;
}

export function missionScorecardRecordKey(record: unknown): string;
export function assertMissionScorecardRegressions(input: {
  summary: unknown;
  baseline: unknown;
  selectedProjects?: string[];
}): MissionScorecardRegressionResult;
export function assertMissionScorecardSummaryFile(options?: {
  baselinePath?: string;
  summaryPath?: string;
  selectedProjects?: string[];
}): Promise<MissionScorecardRegressionResult>;
