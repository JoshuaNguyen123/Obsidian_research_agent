export interface OfflineScorecardDimensionV1 {
  id: string;
  score: number;
}

export interface OfflineApplicationAttemptV1 {
  version: 1;
  scenarioId: string;
  repetition: number;
  exactHead: string;
  sourceState: "clean_head" | "dirty_worktree";
  bundleSha256: string;
  installedBundleSha256: string;
  status: "passed" | "failed" | "blocked";
  acceptanceStatus: "pass" | "needs_more_work" | "not_applicable";
  scorecardAcceptancePassed: boolean;
  scorecardTotal: number | null;
  scorecardDimensions: OfflineScorecardDimensionV1[];
  artifactReadbacks: string[];
  failureClass: string;
  cloudRequestCount: number | null;
  safetyViolationCount: number | null;
  duplicateMutationCount: number | null;
  mutationsPerformed: number | null;
  mutationsWithReceipts: number | null;
  mutationEventsObserved: number | null;
  toolEventsObserved: number | null;
  toolEventsFailed: number | null;
  modelCalls: number | null;
  providerWaitMs: number | null;
  durationMs: number | null;
}

export const OFFLINE_CORE_SCENARIO_IDS: readonly string[];
export const OFFLINE_EXPAND_SCENARIO_IDS: readonly string[];
export const OFFLINE_REQUIRED_SCENARIOS: readonly string[];
export function offlineRequiredScenarioIdsForProjects(
  projects: readonly string[],
): string[];
export function validateOfflineApplicationAttempt(value: unknown): OfflineApplicationAttemptV1;
export function offlineAttemptIsProofComplete(value: unknown): boolean;
export function evaluateOfflineApplicationRelease(input: {
  attempts: readonly unknown[];
  requiredScenarioIds?: readonly string[];
  requiredRepetitions?: number;
  baselineDimensions?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  scorecardTolerance?: number;
  requireCleanHead?: boolean;
}): {
  version: 1;
  semanticsVersion: 2;
  passed: boolean;
  failures: string[];
  expectedAttempts: number;
  observedAttempts: number;
  proofCompleteAttempts: number;
  applicationSuccessRate: number | null;
  receiptCoverage: number | null;
  toolContractFriction: number | null;
  toolCountCoverage: number | null;
  releaseEligibleSource: boolean;
  cloudRequests: number | null;
  safetyViolations: number | null;
  duplicateMutations: number | null;
  mutations: number | null;
  receiptedMutations: number | null;
  mutationEvents: number | null;
  toolEvents: number | null;
  failedToolEvents: number | null;
  modelCalls: number | null;
  durationMs: number | null;
};
export function assertOfflineApplicationAttemptSummaryFile(input: {
  filePath: string;
  requiredScenarioIds: readonly string[];
  requiredRepetitions?: number;
  requireCleanHead?: boolean;
}): Promise<ReturnType<typeof evaluateOfflineApplicationRelease>>;
