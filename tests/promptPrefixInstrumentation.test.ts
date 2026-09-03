import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAgentMetric,
  formatPromptPrefixReuseMetric,
  formatTokenParts,
  PROMPT_PREFIX_REUSE_METRIC_NAME,
} from "../src/ui/agentViewFormatters";
import {
  mergeModelUsageAggregatesV1,
  type ModelUsageAggregateV1,
} from "../src/model/modelCallEvidence";
import {
  MISSION_PLAN_PROMPT_MARKER,
  formatMissionPlanStaticPromptV1,
} from "../src/agent/missionPlanPrompts";
import { PROMPT_PREFIX_REUSE_METRIC_NAME_V1 } from "../src/agent/runContext";

/*
 * Instrumentation for prompt-prefix reuse and provider cache hits.
 *
 * These are the numbers that say whether the byte-stable prefix work is
 * paying: the runner emits one prefix-reuse metric per agent step, and the
 * provider's cached-token count now survives aggregation instead of being
 * dropped between the model client and Run Details.
 */

test("the runner and the formatter agree on the prefix-reuse metric name", () => {
  assert.equal(PROMPT_PREFIX_REUSE_METRIC_NAME, PROMPT_PREFIX_REUSE_METRIC_NAME_V1);
});

test("prefix-reuse metric renders as a percentage with the divergence point", () => {
  const rendered = formatAgentMetric({
    kind: "run",
    name: PROMPT_PREFIX_REUSE_METRIC_NAME,
    step: 4,
    durationMs: 0,
    prefixStableChars: 8_300,
    prefixTotalChars: 10_000,
    prefixReuseRatio: 0.83,
    prefixFirstDivergentIndex: 12,
  });
  assert.equal(
    rendered,
    "Prefix reuse: step 4 reuses 83% of the previous prompt (first change at message 12)",
  );
  assert.equal(
    formatPromptPrefixReuseMetric({
      kind: "run",
      name: PROMPT_PREFIX_REUSE_METRIC_NAME,
      step: 2,
      durationMs: 0,
      prefixReuseRatio: 1,
      prefixFirstDivergentIndex: null,
    }),
    "Prefix reuse: step 2 reuses 100% of the previous prompt (pure append)",
  );
  // A generic run metric keeps its existing rendering.
  assert.equal(
    formatAgentMetric({ kind: "run", name: "run_complete", durationMs: 1500 }),
    "Timing: run 1500ms",
  );
});

test("token parts include cached prompt tokens only when the provider reported them", () => {
  assert.equal(
    formatTokenParts({
      kind: "model_chat",
      name: "agent_step",
      durationMs: 10,
      promptTokens: 1200,
      completionTokens: 40,
      totalTokens: 1240,
      cachedPromptTokens: 1100,
    }),
    "prompt tokens 1200, completion tokens 40, total tokens 1240, cached prompt tokens 1100",
  );
  // A silent provider must not read as a measured zero.
  assert.equal(
    formatTokenParts({
      kind: "model_chat",
      name: "agent_step",
      durationMs: 10,
      promptTokens: 1200,
      completionTokens: 40,
      totalTokens: 1240,
    }),
    "prompt tokens 1200, completion tokens 40, total tokens 1240",
  );
});

test("usage aggregates carry cached prompt tokens through a merge without inventing them", () => {
  const base: ModelUsageAggregateV1 = {
    schemaVersion: 1,
    modelCallCount: 3,
    successfulCallCount: 3,
    failedCallCount: 0,
    reportedTokens: 30_000,
    estimatedTokens: 0,
    retries: 0,
    wallClockMs: 9_000,
  };
  // Neither segment reported caching: the merged aggregate stays silent.
  const silent = mergeModelUsageAggregatesV1(base, base);
  assert.equal(silent.cachedPromptTokens, undefined);
  assert.equal(silent.reportedTokens, 60_000);

  // One segment reported caching: the merged aggregate carries exactly that.
  const merged = mergeModelUsageAggregatesV1(base, {
    ...base,
    cachedPromptTokens: 12_500,
  });
  assert.equal(merged.cachedPromptTokens, 12_500);
  const both = mergeModelUsageAggregatesV1(
    { ...base, cachedPromptTokens: 100 },
    { ...base, cachedPromptTokens: 250 },
  );
  assert.equal(both.cachedPromptTokens, 350);
});

test("the seeded mission-plan block carries the marker and no live state", () => {
  const block = formatMissionPlanStaticPromptV1();
  assert.ok(block.startsWith(MISSION_PLAN_PROMPT_MARKER));
  assert.doesNotMatch(block, /Active task:|Remaining tasks:|Progress score:|Next action:/);
  // Deterministic: the same bytes every time, which is what makes it a
  // cacheable prefix.
  assert.equal(block, formatMissionPlanStaticPromptV1());
});
