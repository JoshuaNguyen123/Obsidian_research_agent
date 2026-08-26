export const CELLS: Array<{
  id: string;
  project: string;
  grep: string | null;
  requiredGreens: number;
  maxAttempts: number;
}>;
export const ATTEMPT_LOG_DIR: string;
export const SCORECARD_BASELINE_RELATIVE_PATH: string;
export function porcelainWithoutAllowedHarvest(status: string): string;
export function laneHasScorecardBaselineFrom(
  baseline: { records?: unknown } | null | undefined,
  project: string,
): boolean;
export const CLASSIFICATION_CONFIRMED: "confirmed";
export const CLASSIFICATION_MECHANICAL: "mechanical";
export const CLASSIFICATION_UNCLASSIFIED: "unclassified";
export type ClassificationConfidence =
  | "confirmed"
  | "mechanical"
  | "unclassified";
export function collectMechanicalFailureClasses(logText: string): string[];
export function classifyAttemptOutcome(input: {
  exitCode: number;
  summary?: unknown;
  summaryFresh?: boolean;
  logText?: string;
}): {
  failureClass: string;
  detail: string;
  confidence: ClassificationConfidence;
  secondaryClasses: string[];
  /**
   * Present only on ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS: the required
   * variables the lane named as absent, in first-seen order.
   */
  missingEnvironment?: string[];
};
export const LEGACY_RUN_CSV_HEADER: string;
export const RUN_CSV_HEADER: string;
/**
 * Refusal buckets, key-for-key with TOOL_REFUSAL_MARKER_BUCKETS in
 * e2e/reporters/dailyUseReporter.ts (tests/proofMatrix.test.ts asserts it).
 */
export const BLOCKER_BUCKETS: ReadonlyArray<readonly [string, RegExp]>;
export function upgradeRunCsvHeader(
  text: string,
  header?: string,
): string | null;
export const TOOL_EVENT_SOURCE_SUMMARY: "summary";
export const TOOL_EVENT_SOURCE_GRAPHS: "graphs";
export const TOOL_EVENT_SOURCE_NONE: "none";
export interface SummaryToolEventTotals {
  /** Null when no record knew a real call count — unknown, never zero. */
  observed: number | null;
  failed: number | null;
  vacuous: number | null;
  intentionalNoOp: number | null;
  /** Started-and-never-terminated calls; subtracted from succeeded, not credited. */
  undetermined: number | null;
  /** Only contributed vocabulary keys; null when no record carried buckets. */
  buckets: Record<string, number> | null;
}
export function summaryToolEventTotals(
  summary: unknown,
): SummaryToolEventTotals | null;
export interface AttemptToolEvents {
  source: "summary" | "graphs" | "none";
  observed: number | null;
  failed: number | null;
  vacuous: number | null;
  intentionalNoOp: number | null;
  undetermined: number | null;
  succeeded: number | null;
  buckets: Record<string, number> | null;
}
export function resolveAttemptToolEvents(input: {
  summary?: unknown;
  summaryFresh?: boolean;
  minedCounts?: {
    observed: number;
    failed: number;
    buckets: Record<string, number> | null;
  } | null;
}): AttemptToolEvents;
export function fileMtimeMs(file: string): number | null;
/**
 * Strict attempt-window freshness: the summary exists now and is strictly
 * newer than the exact pre-spawn mtime snapshot (or was absent then). No
 * wall-clock grace — see the implementation comment.
 */
export function summaryWrittenSince(
  file: string,
  mtimeBeforeLaunchMs: number | null,
): boolean;
export function attemptLogExcerpt(
  logText: string,
  endIndex?: number | null,
): string;
export function attemptLogExcerptFrom(
  logText: string,
  startIndex?: number,
): string;
export const LANE_ASSERTION_FAILURE_CLASS: string;
export const RENDERER_DEATH_FAILURE_CLASS: string;
export const ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS: "environment_not_configured";
export function detectMissingRequiredEnvironment(logText: string): string[];
export const PROOF_MATRIX_STATE_RELATIVE_DIR: string;
export const PROOF_MATRIX_MANIFEST_RELATIVE_PATH: string;
export const PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR: string;
export const LEGACY_MANIFEST_RELATIVE_PATH: string;
export function writeJsonAtomic(filePath: string, value: unknown): void;
export function migrateLegacyManifestFile(
  legacyPath: string,
  newPath: string,
): boolean;
export const IN_FLIGHT_FAILURE_CLASS: string;
export interface ProofMatrixInFlight {
  cell: string;
  project?: string;
  attempt?: number;
  startedAt?: string | null;
  [key: string]: unknown;
}
export function markAttemptInFlight(
  manifest: ProofMatrixManifest,
  marker: ProofMatrixInFlight,
): void;
export function clearAttemptInFlight(manifest: ProofMatrixManifest): void;
export function reconcileInFlightAttempt(
  manifest: ProofMatrixManifest,
): ProofMatrixAttempt | null;
export function isEmptyScorecardHarvestOutput(output: string): boolean;

export interface ProofMatrixAttempt {
  cell: string;
  green: boolean;
  failureClass: string;
  [key: string]: unknown;
}
export type ProofMatrixCellStatus = "done" | "exhausted" | "not_run";
export interface ProofMatrixCellVerdict {
  status: ProofMatrixCellStatus;
  [key: string]: unknown;
}
export interface ProofMatrixManifest {
  attempts: ProofMatrixAttempt[];
  productClassCounts: Record<string, number>;
  harnessFailureCounts?: Record<string, number>;
  /** Per-cell verdicts; `not_run` is neither green nor red (never scored). */
  cellStatus?: Record<string, ProofMatrixCellVerdict>;
  inFlight?: unknown;
  [key: string]: unknown;
}
export const CELL_STATUS_DONE: "done";
export const CELL_STATUS_EXHAUSTED: "exhausted";
export const CELL_STATUS_NOT_RUN: "not_run";
export function cellStatusIsScored(status: string | null | undefined): boolean;
export function recordCellStatus(
  manifest: ProofMatrixManifest,
  cellId: string,
  status: ProofMatrixCellStatus,
  extra?: Record<string, unknown>,
): ProofMatrixCellVerdict;
export function cellStatusOf(
  manifest: ProofMatrixManifest,
  cellId: string,
): ProofMatrixCellStatus | null;
export const MAX_CONSECUTIVE_HARNESS_FAILURES: number;
export function isInfrastructureFailureClass(
  failureClass: string | null | undefined,
): boolean;
export function attemptConsumesBudget(
  attempt: Pick<ProofMatrixAttempt, "green" | "failureClass"> | null | undefined,
): boolean;
export function consecutiveGreens(
  manifest: ProofMatrixManifest,
  cellId: string,
): number;
export function consumedAttemptCount(
  manifest: ProofMatrixManifest,
  cellId: string,
): number;
export function harnessFailureCount(
  manifest: ProofMatrixManifest,
  cellId: string,
): number;
export function consecutiveHarnessFailures(
  manifest: ProofMatrixManifest,
  cellId: string,
): number;
export function registerProductFailure(
  manifest: ProofMatrixManifest,
  failureClass: string,
): boolean;
