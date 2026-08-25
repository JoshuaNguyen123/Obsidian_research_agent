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
export function attemptLogExcerptFrom(
  logText: string,
  startIndex?: number,
): string;
export const LANE_ASSERTION_FAILURE_CLASS: string;
export const RENDERER_DEATH_FAILURE_CLASS: string;
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
export interface ProofMatrixManifest {
  attempts: ProofMatrixAttempt[];
  productClassCounts: Record<string, number>;
  harnessFailureCounts?: Record<string, number>;
  inFlight?: unknown;
  [key: string]: unknown;
}
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
