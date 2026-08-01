export interface HarvestedScorecardRecord {
  key: string;
  project: string;
  scenarioId: string;
  file: string;
  title: string;
  scorecard: unknown;
}

export interface HarvestSelection {
  harvestable: HarvestedScorecardRecord[];
  /** Human-readable reason per record that was deliberately not harvested. */
  skipped: string[];
}

export interface BaselineMergeResult {
  records: Array<{ key: string; project?: string; [field: string]: unknown }>;
  added: string[];
  updated: string[];
}

export function selectHarvestableRecords(summary: unknown): HarvestSelection;
export function mergeBaselineRecords(
  existing: ReadonlyArray<{ key: string; [field: string]: unknown }>,
  harvested: ReadonlyArray<HarvestedScorecardRecord>,
): BaselineMergeResult;
