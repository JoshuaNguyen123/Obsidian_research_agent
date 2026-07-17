import assert from "node:assert/strict";
import test from "node:test";

import { DAILY_USE_ACCEPTANCE_V1 } from "../src/agent/dailyUseAcceptance";
import {
  createDailyUseRunMetricsV1,
  fingerprintDailyUseRunMetricsV1,
} from "../src/agent/dailyUseRunMetrics";

test("DailyUseRunMetricsV1 records redacted counters and exact missing acceptance criteria", () => {
  const metrics = createDailyUseRunMetricsV1({
    scenarioId: "DU-03",
    releaseSha: "a".repeat(40),
    observed: {
      artifacts: ["code:source_files", "code:tests"],
      proofs: ["code:trusted_repository"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
    modelCalls: 4,
    toolCalls: 11,
    continuations: 1,
    approvals: 0,
    observedAt: "2026-07-16T17:00:00.000Z",
  });
  assert.equal(metrics.acceptanceStatus, "needs_more_work");
  assert.ok(metrics.missingAcceptanceCriteria.includes("code:readme"));
  assert.ok(metrics.missingAcceptanceCriteria.includes("approval:sandbox_execution"));
  assert.equal(metrics.artifactProofCount, 2);
  assert.equal(metrics.toolCalls, 11);
  assert.doesNotMatch(JSON.stringify(metrics), /token|password|prompt/iu);
});

test("DailyUseRunMetricsV1 fingerprint excludes observation time", () => {
  const contract = DAILY_USE_ACCEPTANCE_V1["DU-01"];
  const observed = {
    artifacts: contract.requestedArtifacts,
    proofs: contract.requiredProofs,
    approvals: contract.approvalBoundaries,
    bindings: contract.finalBindings,
    cleanup: contract.cleanupObligations,
  };
  const first = createDailyUseRunMetricsV1({
    scenarioId: "DU-01",
    observed,
    observedAt: "2026-07-16T17:00:00.000Z",
  });
  const second = createDailyUseRunMetricsV1({
    scenarioId: "DU-01",
    observed,
    observedAt: "2026-07-16T17:01:00.000Z",
  });
  assert.equal(first.acceptanceStatus, "pass");
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, fingerprintDailyUseRunMetricsV1(first));
});
