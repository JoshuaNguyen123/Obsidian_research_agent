export const CELLS: Array<{
  id: string;
  project: string;
  scenarioId: string;
  grep: string | null;
  requiredGreens: number;
  maxAttempts: number;
}>;
export const DEFAULT_PROOF_MATRIX_MODEL: string;
export const PROOF_MATRIX_MODEL: string;
export const ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS: "harness:acceptance_proof_missing";
export function resolveProofMatrixModel(args?: string[]): string;
export const ATTEMPT_LOG_DIR: string;
export const SCORECARD_BASELINE_RELATIVE_PATH: string;
export function normalizeGitCommandOutput(
  output: string,
  options?: { preserveLeading?: boolean },
): string;
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
  /**
   * Present only on HARNESS_CLEANUP_FAILURE_CLASS: which lane reported passing
   * assertions, and what its mandatory cleanup said when it failed.
   */
  cleanupFailure?: { lane: string; detail: string };
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
/** Mirror of TOOL_CALL_FAILURE_DETAIL_CAP; a source test pins the two equal. */
export const PROOF_MATRIX_FAILURE_DETAIL_CAP: number;
/**
 * One retained failed call, as this roll-up re-shapes it. Structurally the same
 * fields as ToolCallFailureDetailV1 in e2e/fixtures/toolCallOutcomes.ts, and it
 * must STAY the same: a field this type omits is a field the roll-up silently
 * drops on its way into the manifest.
 */
export interface ProofMatrixFailureDetail {
  id: string;
  toolName: string | null;
  errorCode: string | null;
  /** The product's failure sentence, already redacted upstream; null = unobserved. */
  errorMessage: string | null;
  bucket: string;
}
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
  failureDetails: ProofMatrixFailureDetail[] | null;
  /** True once details were dropped — by a record's own fold, or by the cap. */
  failureDetailsTruncated: boolean | null;
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
  failureDetails: ProofMatrixFailureDetail[] | null;
  failureDetailsTruncated: boolean | null;
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
export interface AttemptAcceptanceSummary {
  missionOutcome: "accepted" | "needs_more_work" | "unknown";
  acceptanceStatus: "pass" | "needs_more_work" | "unknown";
  scorecardTotal: number | null;
  scorecardAcceptancePassed: boolean | null;
  retries: number | null;
  artifactProofCount: number | null;
  cleanupProofCount: number | null;
}
export function summarizeAttemptAcceptance(
  summary: unknown,
  summaryFresh: boolean,
  expectedScenarioId?: string | null,
): AttemptAcceptanceSummary;
export interface AttemptUsageSummary {
  modelCalls: number | null;
  reportedTokens: number | null;
  cachedPromptTokens: number | null;
  promptPrefixReuseAvg: number | null;
}
export function summarizeAttemptUsage(
  summary: unknown,
  summaryFresh: boolean,
  expectedScenarioId?: string | null,
): AttemptUsageSummary;
export function usageCsvCells(
  usage: AttemptUsageSummary | null | undefined,
): Array<string | number>;
export interface CampaignAttemptVerdict {
  green: boolean;
  failureClass: string;
  failureDetail: string;
  confidence: ClassificationConfidence;
  secondaryClasses: string[];
  acceptance: AttemptAcceptanceSummary;
}
export function resolveCampaignAttemptVerdict(
  input: CampaignAttemptVerdict,
): CampaignAttemptVerdict;
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
/**
 * Every product assertion passed; only mandatory harness cleanup failed. Loud
 * and still a failure, but harness evidence — never counted as a product red.
 */
export const HARNESS_CLEANUP_FAILURE_CLASS: "harness:cleanup_failed";
/**
 * A previous attempt's Obsidian was still on the machine, so this attempt was
 * never launched. `harness:` prefixed, so budget-exempt and streak-preserving
 * through the one shared predicate.
 */
export const OBSIDIAN_RESIDUE_FAILURE_CLASS: "harness:obsidian_residue_blocked";
/**
 * The model provider refused to serve the run — quota, monthly cap, or rate
 * limit. The product was never exercised, so it is not a product red.
 */
export const PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS: "harness:provider_quota_exhausted";
export const SANDBOX_UNAVAILABLE_FAILURE_CLASS: "harness:sandbox_unavailable";
export function detectSandboxNoVerdict(
  logText: string,
): { detail: string; index: number } | null;
export function detectProviderQuotaExhaustion(
  logText: string,
): { detail: string; index: number } | null;
export function detectLaneCleanupFailure(
  logText: string,
): { lane: string; detail: string; index: number } | null;
export function detectMissingRequiredEnvironment(logText: string): string[];
export const PROOF_MATRIX_STATE_RELATIVE_DIR: string;
export const PROOF_MATRIX_MANIFEST_RELATIVE_PATH: string;
export const PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR: string;
export const LEGACY_MANIFEST_RELATIVE_PATH: string;
export function writeJsonAtomic(filePath: string, value: unknown): void;
export function initializeAttemptLogFile(
  filePath: string,
  metadata: {
    campaignStartedAt: string;
    attemptStartedAt: string;
    expectedHead: string;
    model: string;
    cell: string;
    project: string;
    attempt: number;
  },
): void;
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

/** The four artifacts sync:test-vault installs. `data.json` is never included. */
export const QUALIFICATION_ARTIFACT_FILES: readonly string[];
/** Per-occurrence wall-clock deadline; exceeding it is a delivery failure. */
export const QUALIFICATION_DEADLINE_SECONDS: number;
/** sha256 per built artifact; a missing artifact hashes to null, never "". */
export function qualificationArtifactHashes(
  root?: string,
): Record<string, string | null>;

export declare const SPENDING_LIMIT_BYPASS_CONDITION: "spending_limit_bypass";
export declare const CONFIGURED_BUDGET_EXHAUSTED_MARKER: RegExp;
export declare function evaluateAttemptSafetyV1(input: {
  attemptLogText: string | null | undefined;
  green: boolean | null | undefined;
}): {
  budgetStopped: boolean;
  safetyEvaluated: string[];
  safetyViolations: string[];
};

export declare function classifyPreexistingWorkspacesV1(
  entries: readonly (string | null | undefined)[] | null | undefined,
  allowValue: string | null | undefined,
): { accepted: string[]; refused: string[]; allowed: string[] };
