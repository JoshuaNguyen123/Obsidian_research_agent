import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DAILY_USE_ACCEPTANCE_V1,
  evaluateDailyUseAcceptanceV1,
} from "../src/agent/dailyUseAcceptance";

describe("DailyUseAcceptanceV1", () => {
  it("defines stable, complete contracts for DU-01 through DU-06", () => {
    assert.deepEqual(Object.keys(DAILY_USE_ACCEPTANCE_V1), [
      "DU-01",
      "DU-02",
      "DU-03",
      "DU-04",
      "DU-05",
      "DU-06",
    ]);
    for (const [scenarioId, contract] of Object.entries(DAILY_USE_ACCEPTANCE_V1)) {
      assert.equal(contract.version, 1);
      assert.equal(contract.scenarioId, scenarioId);
      assert.ok(contract.requestedArtifacts.length > 0);
      assert.ok(contract.requiredProofs.length > 0);
    }
  });

  it("reports missing proof categories and passes only the exact contract", () => {
    const contract = DAILY_USE_ACCEPTANCE_V1["DU-04"];
    const incomplete = evaluateDailyUseAcceptanceV1(contract, {
      artifacts: ["linear:issue"],
      proofs: [],
      approvals: [],
      bindings: [],
      cleanup: [],
    });
    assert.equal(incomplete.status, "needs_more_work");
    assert.ok(incomplete.missing.includes("vault:linear_lineage"));
    assert.ok(incomplete.missing.includes("approval:linear_issue_create"));

    assert.deepEqual(
      evaluateDailyUseAcceptanceV1(contract, {
        artifacts: contract.requestedArtifacts,
        proofs: contract.requiredProofs,
        approvals: contract.approvalBoundaries,
        bindings: contract.finalBindings,
        cleanup: contract.cleanupObligations,
      }),
      { status: "pass", missing: [] },
    );
  });

  it("requires transport-free cache reuse evidence for DU-02", () => {
    const contract = DAILY_USE_ACCEPTANCE_V1["DU-02"];
    assert.ok(contract.requiredProofs.includes("research:cache_reuse"));
    const observed = {
      artifacts: contract.requestedArtifacts,
      proofs: contract.requiredProofs.filter(
        (proof) => proof !== "research:cache_reuse",
      ),
      approvals: contract.approvalBoundaries,
      bindings: contract.finalBindings,
      cleanup: contract.cleanupObligations,
    };
    assert.deepEqual(evaluateDailyUseAcceptanceV1(contract, observed), {
      status: "needs_more_work",
      missing: ["research:cache_reuse"],
    });
  });
});
