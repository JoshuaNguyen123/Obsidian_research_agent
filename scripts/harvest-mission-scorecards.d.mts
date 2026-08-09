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

export interface BaselineRecord {
  key: string;
  project?: string;
  [field: string]: unknown;
}

export interface BaselineMergeResult {
  records: Array<BaselineRecord>;
  added: string[];
  updated: string[];
  /**
   * Keys of existing records dropped as structurally stale. validateBaseline
   * rejects the whole file over one unparseable record, so these are removed
   * rather than carried forward, and reported as proof debt for their lane.
   */
  dropped: string[];
}

export interface BaselineMergeOptions {
  /**
   * Decides whether an existing record still parses under the current
   * dimensions. Defaults to keeping everything, so merge stays pure unless a
   * caller opts into dropping.
   */
  isCurrent?: (record: BaselineRecord) => boolean;
}

export function selectHarvestableRecords(summary: unknown): HarvestSelection;
export function mergeBaselineRecords(
  existing: ReadonlyArray<BaselineRecord>,
  harvested: ReadonlyArray<HarvestedScorecardRecord>,
  options?: BaselineMergeOptions,
): BaselineMergeResult;
