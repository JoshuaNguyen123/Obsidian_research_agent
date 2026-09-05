export const OFFLINE_CORE_SCENARIO_IDS = Object.freeze([
  "chat_only",
  "current_note_append",
]);

export const OFFLINE_EXPAND_SCENARIO_IDS = Object.freeze([
  "current_note_replace_with_backup",
  "page_clear_then_write",
  "word_count_correction",
  "title_rename_plus_body",
  "citation_finalization_repair",
]);

export const OFFLINE_REQUIRED_SCENARIOS = Object.freeze([
  ...OFFLINE_CORE_SCENARIO_IDS,
  "grounded_writeback",
  "vault_recall",
  "sandbox_code_delivery",
  "notebook_execution",
  "approved_replace_backup",
  "compound_prepared_dry_run",
  "provider_timeout_recovery",
  "tool_call_recovery",
  "restart_resume",
  "capability_setup_resume",
  ...OFFLINE_EXPAND_SCENARIO_IDS,
]);

/** Exclusive-runner gate: only the scenarios the selected offline project writes. */
export function offlineRequiredScenarioIdsForProjects(projects) {
  const ids = [];
  if ((projects ?? []).includes("offline-core")) {
    ids.push(...OFFLINE_CORE_SCENARIO_IDS);
  }
  if ((projects ?? []).includes("offline-expand")) {
    ids.push(...OFFLINE_EXPAND_SCENARIO_IDS);
  }
  return ids;
}

const STATUS = new Set(["passed", "failed", "blocked"]);
const ACCEPTANCE_STATUS = new Set(["pass", "needs_more_work", "not_applicable"]);
const SOURCE_STATE = new Set(["clean_head", "dirty_worktree"]);
const FAILURE_CLASS = /^(?:none|product|model|external|harness|process):?[a-z0-9_:-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Fail-closed evidence contract for one zero-cloud installed-runtime attempt.
 * This is deliberately separate from the historical real-AI CSV: scripted
 * transport proves application mechanics, not provider/model competence.
 */
export function validateOfflineApplicationAttempt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Offline application attempt must be an object.");
  }
  if (value.version !== 1) throw new Error("Offline application attempt version must be 1.");
  if (!OFFLINE_REQUIRED_SCENARIOS.includes(value.scenarioId)) {
    throw new Error(`Unknown offline scenario '${String(value.scenarioId)}'.`);
  }
  if (!Number.isSafeInteger(value.repetition) || value.repetition < 1) {
    throw new Error("Offline attempt repetition must be a positive integer.");
  }
  if (!/^[a-f0-9]{40}$/u.test(String(value.exactHead ?? ""))) {
    throw new Error("Offline attempt exactHead must be a full 40-character commit SHA.");
  }
  if (!SOURCE_STATE.has(value.sourceState)) {
    throw new Error("Offline attempt sourceState must be clean_head or dirty_worktree.");
  }
  if (!SHA256.test(String(value.bundleSha256 ?? ""))) {
    throw new Error("Offline attempt bundleSha256 must be a lowercase SHA-256 digest.");
  }
  if (!SHA256.test(String(value.installedBundleSha256 ?? ""))) {
    throw new Error("Offline attempt installedBundleSha256 must be a lowercase SHA-256 digest.");
  }
  if (!STATUS.has(value.status)) throw new Error("Offline attempt status is invalid.");
  if (!ACCEPTANCE_STATUS.has(value.acceptanceStatus)) {
    throw new Error("Offline attempt acceptanceStatus is invalid.");
  }
  if (!FAILURE_CLASS.test(String(value.failureClass ?? ""))) {
    throw new Error("Offline attempt failureClass is invalid.");
  }
  for (const field of [
    "cloudRequestCount",
    "safetyViolationCount",
    "duplicateMutationCount",
    "mutationsPerformed",
    "mutationsWithReceipts",
    "mutationEventsObserved",
    "toolEventsObserved",
    "toolEventsFailed",
    "modelCalls",
    "providerWaitMs",
    "durationMs",
  ]) {
    if (value.status !== "passed" && (value[field] === null || value[field] === undefined)) continue;
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new Error(`Offline attempt ${field} must be a non-negative integer.`);
    }
  }
  if (knownCount(value.mutationsWithReceipts) && knownCount(value.mutationsPerformed) && value.mutationsWithReceipts > value.mutationsPerformed) {
    throw new Error("Offline attempt cannot receipt more mutations than it performed.");
  }
  if (knownCount(value.mutationEventsObserved) && knownCount(value.mutationsPerformed) && value.mutationEventsObserved > value.mutationsPerformed) {
    throw new Error("Offline attempt cannot observe more mutation events than mutations performed.");
  }
  if (knownCount(value.toolEventsFailed) && knownCount(value.toolEventsObserved) && value.toolEventsFailed > value.toolEventsObserved) {
    throw new Error("Offline attempt cannot fail more tool events than it observed.");
  }
  if (typeof value.scorecardAcceptancePassed !== "boolean") {
    throw new Error("Offline attempt scorecardAcceptancePassed must be boolean.");
  }
  if (value.scorecardTotal !== null && !isUnitInterval(value.scorecardTotal)) {
    throw new Error("Offline attempt scorecardTotal must be null or between 0 and 1.");
  }
  if (!Array.isArray(value.scorecardDimensions) || value.scorecardDimensions.some(
    (item) => !item || typeof item !== "object" || typeof item.id !== "string" || !isUnitInterval(item.score),
  )) {
    throw new Error("Offline attempt scorecardDimensions are invalid.");
  }
  if (!Array.isArray(value.artifactReadbacks) || value.artifactReadbacks.some(
    (item) => typeof item !== "string" || !item.trim(),
  )) {
    throw new Error("Offline attempt artifactReadbacks must be non-empty strings.");
  }
  return structuredClone(value);
}

export function offlineAttemptIsProofComplete(attempt) {
  const value = validateOfflineApplicationAttempt(attempt);
  const acceptanceRequired = value.acceptanceStatus !== "not_applicable";
  return Boolean(
    value.status === "passed" &&
    (!acceptanceRequired || (
      value.acceptanceStatus === "pass" &&
      value.scorecardAcceptancePassed === true &&
      Number.isFinite(value.scorecardTotal)
    )) &&
    value.cloudRequestCount === 0 &&
    value.safetyViolationCount === 0 &&
    value.duplicateMutationCount === 0 &&
    value.mutationsWithReceipts === value.mutationsPerformed &&
    value.mutationEventsObserved === value.mutationsPerformed &&
    value.bundleSha256 === value.installedBundleSha256 &&
    value.artifactReadbacks.length > 0 &&
    value.failureClass === "none"
  );
}

/**
 * Conjunctive release rule: no weighted total may hide a correctness, safety,
 * receipt, recovery, or cloud-isolation failure.
 */
export function evaluateOfflineApplicationRelease({
  attempts,
  requiredScenarioIds = OFFLINE_REQUIRED_SCENARIOS,
  requiredRepetitions = 3,
  baselineDimensions = {},
  scorecardTolerance = 0.05,
  requireCleanHead = true,
}) {
  if (!Number.isSafeInteger(requiredRepetitions) || requiredRepetitions < 1) {
    throw new Error("requiredRepetitions must be a positive integer.");
  }
  const records = Array.from(attempts ?? []).map(validateOfflineApplicationAttempt);
  const failures = [];
  const expectedKeys = new Set();
  for (const scenarioId of requiredScenarioIds) {
    if (!OFFLINE_REQUIRED_SCENARIOS.includes(scenarioId)) {
      throw new Error(`Unknown required offline scenario '${scenarioId}'.`);
    }
    for (let repetition = 1; repetition <= requiredRepetitions; repetition += 1) {
      expectedKeys.add(`${scenarioId}#${repetition}`);
    }
  }
  const seen = new Set();
  for (const attempt of records) {
    const key = `${attempt.scenarioId}#${attempt.repetition}`;
    if (!expectedKeys.has(key)) continue;
    if (seen.has(key)) failures.push(`duplicate attempt ${key}`);
    seen.add(key);
    if (!offlineAttemptIsProofComplete(attempt)) failures.push(`${key} is not proof-complete`);
    if (requireCleanHead && attempt.sourceState !== "clean_head") {
      failures.push(`${key} was produced from a dirty working tree`);
    }
    for (const dimension of attempt.scorecardDimensions) {
      const baseline = baselineDimensions[attempt.scenarioId]?.[dimension.id];
      if (Number.isFinite(baseline) && dimension.score < baseline - Math.abs(scorecardTolerance)) {
        failures.push(
          `${key} regressed ${dimension.id} from ${baseline.toFixed(4)} to ${dimension.score.toFixed(4)}`,
        );
      }
    }
  }
  for (const key of expectedKeys) {
    if (!seen.has(key)) failures.push(`missing attempt ${key}`);
  }

  const selected = records.filter((attempt) =>
    expectedKeys.has(`${attempt.scenarioId}#${attempt.repetition}`),
  );
  const proofComplete = selected.filter(offlineAttemptIsProofComplete).length;
  const totals = selected.reduce(
    (sum, attempt) => ({
      cloudRequests: sumKnownCounts(sum.cloudRequests, attempt.cloudRequestCount),
      safetyViolations: sumKnownCounts(sum.safetyViolations, attempt.safetyViolationCount),
      duplicateMutations: sumKnownCounts(sum.duplicateMutations, attempt.duplicateMutationCount),
      mutations: sumKnownCounts(sum.mutations, attempt.mutationsPerformed),
      receiptedMutations: sumKnownCounts(sum.receiptedMutations, attempt.mutationsWithReceipts),
      mutationEvents: sumKnownCounts(sum.mutationEvents, attempt.mutationEventsObserved),
      toolEvents: sumKnownCounts(sum.toolEvents, attempt.toolEventsObserved),
      failedToolEvents: sumKnownCounts(sum.failedToolEvents, attempt.toolEventsFailed),
      modelCalls: sumKnownCounts(sum.modelCalls, attempt.modelCalls),
      durationMs: sumKnownCounts(sum.durationMs, attempt.durationMs),
    }),
    {
      cloudRequests: 0,
      safetyViolations: 0,
      duplicateMutations: 0,
      mutations: 0,
      receiptedMutations: 0,
      mutationEvents: 0,
      toolEvents: 0,
      failedToolEvents: 0,
      modelCalls: 0,
      durationMs: 0,
    },
  );
  return {
    version: 1,
    semanticsVersion: 2,
    passed: failures.length === 0,
    failures,
    expectedAttempts: expectedKeys.size,
    observedAttempts: selected.length,
    proofCompleteAttempts: proofComplete,
    applicationSuccessRate: selected.length === 0 ? null : proofComplete / selected.length,
    receiptCoverage: totals.mutations === null || totals.receiptedMutations === null ? null : totals.mutations === 0 ? 1 : totals.receiptedMutations / totals.mutations,
    toolContractFriction: totals.toolEvents === null || totals.failedToolEvents === null ? null : totals.toolEvents === 0 ? 0 : totals.failedToolEvents / totals.toolEvents,
    toolCountCoverage: selected.length ? selected.filter((attempt) => knownCount(attempt.toolEventsObserved) && knownCount(attempt.toolEventsFailed)).length / selected.length : null,
    releaseEligibleSource: selected.every((attempt) => attempt.sourceState === "clean_head"),
    ...totals,
  };
}

export async function assertOfflineApplicationAttemptSummaryFile({
  filePath,
  requiredScenarioIds,
  requiredRepetitions = 1,
  requireCleanHead = true,
}) {
  const { readFile } = await import("node:fs/promises");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Offline Playwright exited green but wrote no valid attempt summary at ${filePath}: ${error?.message ?? error}`,
    );
  }
  const attempts = Array.isArray(parsed) ? parsed : parsed?.attempts;
  if (!Array.isArray(attempts)) {
    throw new Error("Offline attempt summary must be an array or an object with attempts[].");
  }
  const result = evaluateOfflineApplicationRelease({
    attempts,
    requiredScenarioIds,
    requiredRepetitions,
    requireCleanHead,
  });
  if (!result.passed) {
    throw new Error(`Offline application release gate failed: ${result.failures.join("; ")}`);
  }
  return result;
}

function isUnitInterval(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function knownCount(value) { return Number.isSafeInteger(value) && value >= 0; }
function sumKnownCounts(left, right) { return knownCount(left) && knownCount(right) ? left + right : null; }
