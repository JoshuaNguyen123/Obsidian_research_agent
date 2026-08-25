export const ATTEMPT_LOG_DIR: string;
export const SCORECARD_BASELINE_RELATIVE_PATH: string;
export function porcelainWithoutAllowedHarvest(status: string): string;
export function laneHasScorecardBaselineFrom(
  baseline: { records?: unknown } | null | undefined,
  project: string,
): boolean;
export function classifyAttemptOutcome(input: {
  exitCode: number;
  summary?: unknown;
  summaryFresh?: boolean;
  logText?: string;
}): { failureClass: string; detail: string };
export function attemptLogExcerpt(
  logText: string,
  endIndex?: number | null,
): string;
export function isEmptyScorecardHarvestOutput(output: string): boolean;
