import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BYOK_01_ACCEPTANCE_TOKENS,
  DAILY_USE_ACCEPTANCE_V1,
  DESKTOP_01_ACCEPTANCE_TOKENS,
  evaluateDailyUseAcceptanceV1,
  FLOW_REAL_01_ACCEPTANCE_TOKENS,
} from "../src/agent/dailyUseAcceptance";

describe("DailyUseAcceptanceV1", () => {
  it("defines stable, complete contracts for the daily-use, BYOK, and Desktop journeys", () => {
    assert.deepEqual(Object.keys(DAILY_USE_ACCEPTANCE_V1), [
      "DU-01",
      "DU-02",
      "DU-03",
      "DU-04",
      "DU-05",
      "DU-06",
      "BYOK-01",
      "DESKTOP-01",
      "FLOW-REAL-01",
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

  it("keeps the BYOK autonomy proof scoped to one issue and one retained IDE export", () => {
    const contract = DAILY_USE_ACCEPTANCE_V1["BYOK-01"];
    assert.ok(contract.requestedArtifacts.includes("linear:implementation_issue"));
    assert.ok(contract.requestedArtifacts.includes("code:ide_readable_export"));
    assert.equal(contract.requestedArtifacts.includes("linear:initiative"), false);
    assert.equal(contract.requestedArtifacts.includes("linear:project"), false);
    assert.ok(contract.cleanupObligations.includes("cleanup:retained_export_verified"));
    assert.deepEqual(contract.requestedArtifacts, BYOK_01_ACCEPTANCE_TOKENS.artifacts);
    assert.deepEqual(contract.requiredProofs, BYOK_01_ACCEPTANCE_TOKENS.proofs);
    assert.deepEqual(contract.approvalBoundaries, BYOK_01_ACCEPTANCE_TOKENS.approvals);
    assert.deepEqual(contract.finalBindings, BYOK_01_ACCEPTANCE_TOKENS.bindings);
    assert.deepEqual(contract.cleanupObligations, BYOK_01_ACCEPTANCE_TOKENS.cleanup);
    assert.ok(
      contract.finalBindings.includes("binding:durable_workspace_identity"),
    );
    assert.ok(contract.requiredProofs.includes("idempotency:no_duplicates"));
    assert.equal(
      new Set<string>(contract.requiredProofs).has("resume:no_duplicates"),
      false,
    );
  });

  it("keeps FLOW-REAL-01 on the single-issue chain rather than folding it into DU-06", () => {
    const contract = DAILY_USE_ACCEPTANCE_V1["FLOW-REAL-01"];
    // The whole reason this contract exists: the lane publishes exactly one
    // issue through publish_research_to_linear and never builds a hierarchy,
    // so requiring DU-06's initiative/project would force the lane to record
    // artifacts it does not create. Membership is checked before the
    // deep-equals below, which narrow these to their literal tuple types.
    assert.equal(contract.requestedArtifacts.includes("linear:initiative"), false);
    assert.equal(contract.requestedArtifacts.includes("linear:project"), false);
    assert.equal(contract.requiredProofs.includes("linear:hierarchy_readback"), false);
    assert.ok(DAILY_USE_ACCEPTANCE_V1["DU-06"].requestedArtifacts.includes("linear:initiative"));
    // Unattended set-loose: no approval stops, and cleanup runs after the
    // acceptance record, so both stay empty rather than being asserted unseen.
    assert.deepEqual(contract.approvalBoundaries, []);
    assert.deepEqual(contract.cleanupObligations, []);
    assert.deepEqual(contract.requestedArtifacts, FLOW_REAL_01_ACCEPTANCE_TOKENS.artifacts);
    assert.deepEqual(contract.requiredProofs, FLOW_REAL_01_ACCEPTANCE_TOKENS.proofs);
    assert.deepEqual(contract.finalBindings, FLOW_REAL_01_ACCEPTANCE_TOKENS.bindings);
  });

  it("uses an idempotency contract rather than an unexercised resume claim", () => {
    for (const contract of Object.values(DAILY_USE_ACCEPTANCE_V1)) {
      assert.equal(
        contract.requiredProofs.includes("resume:no_duplicates"),
        false,
        contract.scenarioId,
      );
    }
    assert.ok(
      DAILY_USE_ACCEPTANCE_V1["DU-06"].requiredProofs.includes(
        "idempotency:no_duplicates",
      ),
    );
  });

  it("keeps scratch Desktop delivery separate from repository-based DU-03", () => {
    const contract = DAILY_USE_ACCEPTANCE_V1["DESKTOP-01"];
    assert.deepEqual(
      contract.requestedArtifacts,
      DESKTOP_01_ACCEPTANCE_TOKENS.artifacts,
    );
    assert.deepEqual(
      contract.requiredProofs,
      DESKTOP_01_ACCEPTANCE_TOKENS.proofs,
    );
    assert.deepEqual(
      contract.approvalBoundaries,
      DESKTOP_01_ACCEPTANCE_TOKENS.approvals,
    );
    assert.deepEqual(
      contract.finalBindings,
      DESKTOP_01_ACCEPTANCE_TOKENS.bindings,
    );
    assert.deepEqual(
      contract.cleanupObligations,
      DESKTOP_01_ACCEPTANCE_TOKENS.cleanup,
    );
    assert.equal(
      new Set<string>(contract.requiredProofs).has("code:trusted_repository"),
      false,
    );
    assert.equal(
      new Set<string>(contract.requestedArtifacts).has("git:local_commit"),
      false,
    );
    assert.ok(contract.cleanupObligations.includes("cleanup:desktop_export"));
    assert.ok(contract.cleanupObligations.includes("cleanup:scratch_workspace"));
  });

  it("fails BYOK-01 when any one runtime observation token is absent", () => {
    const contract = DAILY_USE_ACCEPTANCE_V1["BYOK-01"];
    const complete = {
      artifacts: [...BYOK_01_ACCEPTANCE_TOKENS.artifacts],
      proofs: [...BYOK_01_ACCEPTANCE_TOKENS.proofs],
      approvals: [...BYOK_01_ACCEPTANCE_TOKENS.approvals],
      bindings: [...BYOK_01_ACCEPTANCE_TOKENS.bindings],
      cleanup: [...BYOK_01_ACCEPTANCE_TOKENS.cleanup],
    };
    for (const category of Object.keys(complete) as Array<
      keyof typeof complete
    >) {
      for (const token of complete[category]) {
        const observed = {
          ...complete,
          [category]: complete[category].filter(
            (candidate) => candidate !== token,
          ),
        };
        assert.deepEqual(
          evaluateDailyUseAcceptanceV1(contract, observed),
          { status: "needs_more_work", missing: [token] },
          `${category}:${token}`,
        );
      }
    }
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
