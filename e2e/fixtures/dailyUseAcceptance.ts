import type { TestInfo } from "@playwright/test";

import {
  DAILY_USE_ACCEPTANCE_V1,
  evaluateDailyUseAcceptanceV1,
  type DailyUseObservedAcceptanceV1,
  type DailyUseScenarioId,
} from "../../src/agent/dailyUseAcceptance";
import { createDailyUseRunMetricsV1 } from "../../src/agent/dailyUseRunMetrics";

export const DAILY_USE_OBSERVED_ANNOTATION = "daily-use-observed-v1";
export const DAILY_USE_METRICS_ANNOTATION = "daily-use-metrics-v1";

export async function recordDailyUseAcceptance(
  testInfo: TestInfo,
  scenarioId: DailyUseScenarioId,
  observed: DailyUseObservedAcceptanceV1,
  counters: {
    modelCalls?: number;
    toolCalls?: number;
    continuations?: number;
    approvals?: number;
  } = {},
  options: { requireComplete?: boolean } = {},
) {
  const normalized = normalizeObserved(observed);
  const evaluation = evaluateDailyUseAcceptanceV1(
    DAILY_USE_ACCEPTANCE_V1[scenarioId],
    normalized,
  );
  const releaseSha = process.env.E2E_RELEASE_COMMIT_SHA?.trim() || null;
  const metrics = createDailyUseRunMetricsV1({
    scenarioId,
    releaseSha,
    observed: normalized,
    ...counters,
    observedAt: new Date().toISOString(),
  });
  testInfo.annotations.push({
    type: DAILY_USE_OBSERVED_ANNOTATION,
    description: JSON.stringify(normalized),
  });
  testInfo.annotations.push({
    type: DAILY_USE_METRICS_ANNOTATION,
    description: JSON.stringify(metrics),
  });
  await testInfo.attach(`daily-use-${scenarioId.toLowerCase()}-metrics`, {
    body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
  if (options.requireComplete && evaluation.status !== "pass") {
    throw new Error(
      `${scenarioId} acceptance is incomplete: ${evaluation.missing.join(", ")}`,
    );
  }
  return { evaluation, metrics };
}

export function completeObservedAcceptance(
  scenarioId: DailyUseScenarioId,
): DailyUseObservedAcceptanceV1 {
  const contract = DAILY_USE_ACCEPTANCE_V1[scenarioId];
  return {
    artifacts: [...contract.requestedArtifacts],
    proofs: [...contract.requiredProofs],
    approvals: [...contract.approvalBoundaries],
    bindings: [...contract.finalBindings],
    cleanup: [...contract.cleanupObligations],
  };
}

function normalizeObserved(
  value: DailyUseObservedAcceptanceV1,
): DailyUseObservedAcceptanceV1 {
  const unique = (items: readonly string[]) => [...new Set(items)].sort();
  return {
    artifacts: unique(value.artifacts),
    proofs: unique(value.proofs),
    approvals: unique(value.approvals),
    bindings: unique(value.bindings),
    cleanup: unique(value.cleanup),
  };
}
