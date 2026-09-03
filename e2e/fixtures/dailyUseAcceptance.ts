import type { TestInfo } from "@playwright/test";

import {
  DAILY_USE_ACCEPTANCE_V1,
  evaluateDailyUseAcceptanceV1,
  type DailyUseObservedAcceptanceV1,
  type DailyUseScenarioId,
} from "../../src/agent/dailyUseAcceptance";
import { createDailyUseRunMetricsV1 } from "../../src/agent/dailyUseRunMetrics";
import type { MissionScorecardV1 } from "../../src/agent/missionScorecard";

export const DAILY_USE_OBSERVED_ANNOTATION = "daily-use-observed-v1";
export const DAILY_USE_METRICS_ANNOTATION = "daily-use-metrics-v1";
export const DAILY_USE_SCORECARD_ANNOTATION = "daily-use-scorecard-v1";
export const E2E_PROOF_CLASS_ANNOTATION = "e2e-proof-class-v1";
/**
 * Folded tool-call outcome counts from the shared collector seam
 * (e2e/fixtures/toolCallCollector.ts). Parsed by the reporter
 * UNCONDITIONALLY — unlike the metrics annotation it must also work for any
 * future or targeted lane that has not yet been assigned a scenario contract;
 * such records would otherwise carry no tool-call counters at all.
 */
export const DAILY_USE_TOOL_OUTCOMES_ANNOTATION = "daily-use-tool-outcomes-v1";

export type E2EProofClassV1 = "mission" | "contract";

export function recordE2EProofClass(
  testInfo: TestInfo,
  proofClass: E2EProofClassV1,
): void {
  testInfo.annotations.push({
    type: E2E_PROOF_CLASS_ANNOTATION,
    description: proofClass,
  });
}

export async function recordDailyUseAcceptance(
  testInfo: TestInfo,
  scenarioId: DailyUseScenarioId,
  observed: DailyUseObservedAcceptanceV1,
  counters: {
    modelCalls?: number;
    toolCalls?: number;
    continuations?: number;
    approvals?: number;
    missionScorecard?: MissionScorecardV1 | null;
    /**
     * ATTEMPTED tool calls — the denominator for tool-call success. Supply it
     * by folding the mission event stream through
     * `foldToolCallOutcomesV1` (e2e/fixtures/toolCallOutcomes.ts), which is
     * the only counter that sees failed calls at all: `toolCalls` above is
     * fed from missionEvidence, and evidenceFromToolResult drops every
     * `!result.ok`. Leave undefined when the spec did not observe the
     * stream — the reporter records null (unknown), never zero.
     */
    toolCallsAttempted?: number | null;
    /**
     * Failed-tool-call count when the spec's own trace observation can
     * distinguish failures (tool_result with error / onToolDone ok:false /
     * tool_rejected). Leave undefined when it cannot: the reporter records
     * null (unknown), never zero. The counters most specs feed today
     * (missionEvidence lengths) count SUCCESSFUL calls only and carry no
     * failure signal.
     */
    toolCallsFailed?: number | null;
    /**
     * "Called but did no work" count — vacuous successes detected from
     * receipts via countVacuousToolReceipts (zero-delta mutation receipts).
     * Same unknown-≠-zero rule as toolCallsFailed.
     */
    toolCallsVacuous?: number | null;
    /**
     * Intentional no-ops (commitKind no_op/reconciled on enriched receipts,
     * see countIntentionalNoOpReceipts): correct idempotent behavior,
     * tracked separately from vacuous.
     */
    toolCallsIntentionalNoOp?: number | null;
    /** Refusal counts keyed by the proof matrix's six bucket names. */
    refusalBuckets?: Record<string, number> | null;
    /**
     * The run's durable provider usage (the coordinator/ledger
     * `providerUsage` aggregate). Only `reportedTokens` and
     * `cachedPromptTokens` are carried into the summary; null or absent
     * means the lane did not observe usage (unknown, never zero).
     */
    providerUsage?: {
      reportedTokens?: number | null;
      cachedPromptTokens?: number | null;
    } | null;
    /** Mean per-step prompt-prefix reuse ratio (0..1) when the lane measured it. */
    promptPrefixReuseAvg?: number | null;
  } = {},
  options: { requireComplete?: boolean } = {},
) {
  recordE2EProofClass(testInfo, "mission");
  const normalized = normalizeObserved(observed);
  const evaluation = evaluateDailyUseAcceptanceV1(
    DAILY_USE_ACCEPTANCE_V1[scenarioId],
    normalized,
  );
  const releaseSha = process.env.E2E_RELEASE_COMMIT_SHA?.trim() || null;
  const {
    missionScorecard = null,
    toolCallsAttempted = null,
    toolCallsFailed = null,
    toolCallsVacuous = null,
    toolCallsIntentionalNoOp = null,
    refusalBuckets = null,
    providerUsage = null,
    promptPrefixReuseAvg = null,
    ...metricCounters
  } = counters;
  const metrics = createDailyUseRunMetricsV1({
    scenarioId,
    releaseSha,
    observed: normalized,
    ...metricCounters,
    observedAt: new Date().toISOString(),
  });
  testInfo.annotations.push({
    type: DAILY_USE_OBSERVED_ANNOTATION,
    description: JSON.stringify(normalized),
  });
  testInfo.annotations.push({
    type: DAILY_USE_METRICS_ANNOTATION,
    description: JSON.stringify({
      ...metrics,
      // Appended OUTSIDE createDailyUseRunMetricsV1 (its schema is fixed in
      // src/): unknown counts serialize as null so the reporter can keep
      // unknown ≠ zero explicit.
      toolCallsAttempted,
      toolCallsFailed,
      toolCallsVacuous,
      toolCallsIntentionalNoOp,
      ...(refusalBuckets ? { refusalBuckets } : {}),
      // Cost/latency instruments (2026-09-03): provider token usage and the
      // prompt-prefix reuse ratio. Null when the lane did not measure them.
      providerUsage: providerUsage
        ? {
            reportedTokens: providerUsage.reportedTokens ?? null,
            cachedPromptTokens: providerUsage.cachedPromptTokens ?? null,
          }
        : null,
      promptPrefixReuseAvg,
    }),
  });
  if (missionScorecard) {
    testInfo.annotations.push({
      type: DAILY_USE_SCORECARD_ANNOTATION,
      description: JSON.stringify(missionScorecard),
    });
  }
  await testInfo.attach(`daily-use-${scenarioId.toLowerCase()}-metrics`, {
    body: Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
  if (missionScorecard) {
    await testInfo.attach(
      `daily-use-${scenarioId.toLowerCase()}-mission-scorecard`,
      {
        body: Buffer.from(
          `${JSON.stringify(missionScorecard, null, 2)}\n`,
          "utf8",
        ),
        contentType: "application/json",
      },
    );
  }
  if (options.requireComplete && evaluation.status !== "pass") {
    throw new Error(
      `${scenarioId} acceptance is incomplete: ${evaluation.missing.join(", ")}`,
    );
  }
  return { evaluation, metrics };
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
