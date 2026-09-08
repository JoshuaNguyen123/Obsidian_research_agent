import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateReliabilityCampaign,
  resolveReliabilityGate,
} from "../scripts/reliability-campaign.mjs";

const cells = Array.from({ length: 6 }, (_, index) => ({ id: `lane-${index + 1}` }));

function attempt(
  cell: string,
  green: boolean,
  failureClass = green ? "none" : "model:failed",
  covered = true,
) {
  return {
    cell,
    green,
    failureClass,
    toolEvents: covered
      ? { source: "summary", observed: 2, failed: green ? 0 : 1 }
      : { source: "none", observed: null, failed: null },
    acceptance: {
      acceptanceStatus: green ? "pass" : "needs_more_work",
      scorecardAcceptancePassed: green,
      scorecardTotal: green ? 0.94 : 0.4,
    },
  };
}

function campaign(perLane: number, greensPerLane: number, covered = true) {
  return cells.flatMap((cell) =>
    Array.from({ length: perLane }, (_, index) =>
      attempt(cell.id, index < greensPerLane, undefined, covered)
    )
  );
}

test("90% gate requires 54/60 overall and at least 8/10 in every lane", () => {
  const gate = resolveReliabilityGate("90");
  const passing = campaign(10, 9);
  assert.equal(
    evaluateReliabilityCampaign({ gate, cells, attempts: passing }).passed,
    true,
  );

  const laneFloorFailure = [
    ...campaign(10, 9).filter((entry) => entry.cell !== "lane-1"),
    ...Array.from({ length: 10 }, (_, index) => attempt("lane-1", index < 7)),
  ];
  const result = evaluateReliabilityCampaign({ gate, cells, attempts: laneFloorFailure });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.includes("lane-1 has 7/10")));
});

test("infrastructure attempts are rerun and must remain below five percent of launches", () => {
  const gate = resolveReliabilityGate("acceptable90");
  const valid = campaign(10, 9);
  const oneHarnessDeath = attempt("lane-1", false, "harness:renderer_death");
  const passing = evaluateReliabilityCampaign({
    gate,
    cells,
    attempts: [...valid, oneHarnessDeath],
  });
  assert.equal(passing.validAttempts, 60);
  assert.equal(passing.infrastructureFailures, 1);
  assert.equal(passing.passed, true);

  const fourHarnessDeaths = Array.from({ length: 4 }, () => oneHarnessDeath);
  const failing = evaluateReliabilityCampaign({
    gate,
    cells,
    attempts: [...valid, ...fourHarnessDeaths],
  });
  assert.equal(failing.passed, false);
  assert.ok(failing.failures.some((failure) => failure.includes("infrastructure failures")));
});

test("95% gate requires 114/120, 18/20 per lane, tool coverage, and no product reds", () => {
  const gate = resolveReliabilityGate("target95");
  const passing = evaluateReliabilityCampaign({
    gate,
    cells,
    attempts: campaign(20, 19),
  });
  assert.equal(passing.passed, true);
  assert.equal(passing.greens, 114);

  const missingCoverage = campaign(20, 19);
  missingCoverage[0] = attempt("lane-1", true, "none", false);
  assert.ok(
    evaluateReliabilityCampaign({ gate, cells, attempts: missingCoverage })
      .failures.some((failure) => failure.includes("lack tool-event coverage")),
  );

  const productRed = campaign(20, 19);
  productRed[19] = attempt("lane-1", false, "product:writeback_unproven");
  assert.ok(
    evaluateReliabilityCampaign({ gate, cells, attempts: productRed })
      .failures.some((failure) => failure.includes("unresolved product failure")),
  );
});

test("100% is labelled only as an observed perfect campaign", () => {
  const gate = resolveReliabilityGate("95");
  const result = evaluateReliabilityCampaign({
    gate,
    cells,
    attempts: campaign(20, 20),
  });
  assert.equal(result.passed, true);
  assert.equal(result.observedPerfectCampaign, true);
  assert.equal(result.observedSuccessRate, 1);
});

test("a green exit without accepted mission and scorecard proof is not campaign evidence", () => {
  const gate = resolveReliabilityGate("90");
  const attempts = campaign(10, 9);
  attempts[0] = {
    ...attempts[0],
    acceptance: {
      acceptanceStatus: "unknown",
      scorecardAcceptancePassed: false,
      scorecardTotal: 0,
    },
  };
  const result = evaluateReliabilityCampaign({ gate, cells, attempts });
  assert.equal(result.passed, false);
  assert.ok(
    result.failures.some((failure) => failure.includes("lack accepted mission and scorecard proof")),
  );
});

// ---------------------------------------------------------------------------
// The predeclared-cohort gates (mission-success/v1). These are a THIRD kind,
// added without touching recovery/acceptable90/target95 semantics.
// ---------------------------------------------------------------------------

test("the 99/99.9 qualification gates resolve with their frozen thresholds", () => {
  const gate99 = resolveReliabilityGate("qualification99");
  assert.equal(gate99.kind, "predeclared-cohort");
  assert.equal(gate99.policyVersion, "mission-success/v1");
  assert.equal(gate99.cohortSize, 300);
  assert.equal(gate99.maximumFailures, 0);
  assert.equal(gate99.workflows, 6);
  assert.equal(gate99.occurrencesPerWorkflow, 50);
  assert.equal(gate99.requiredLowerBound, 0.99);
  assert.equal(gate99.requiredObservedSuccessRate, 0.999);

  const gate999 = resolveReliabilityGate("qualification999");
  assert.equal(gate999.cohortSize, 1002);
  assert.equal(gate999.maximumFailures, 1);
  assert.equal(gate999.occurrencesPerWorkflow, 167);
  assert.equal(gate999.cohortSize, Number(gate999.workflows) * Number(gate999.occurrencesPerWorkflow));

  assert.equal(resolveReliabilityGate("99").id, "qualification99");
  assert.equal(resolveReliabilityGate("999").id, "qualification999");
  assert.equal(resolveReliabilityGate("99.9").id, "qualification999");
  assert.throws(() => resolveReliabilityGate("99.99"), /Unknown reliability gate/u);
});

test("the existing recovery/90/95 gates are untouched by the new policy", () => {
  const recovery = resolveReliabilityGate("recovery");
  assert.equal(recovery.kind, "consecutive");
  assert.equal(recovery.infrastructureLaunchRateMaxExclusive, 0.05);

  const acceptable90 = resolveReliabilityGate("90");
  assert.equal(acceptable90.kind, "fixed-attempts");
  assert.equal(acceptable90.validAttemptsPerLane, 10);
  assert.equal(acceptable90.minimumGreensPerLane, 8);
  assert.equal(acceptable90.minimumGreensOverall, 54);
  assert.equal(acceptable90.requireToolEventCoverage, false);
  assert.equal(acceptable90.rejectAnyProductFailure, false);

  const target95 = resolveReliabilityGate("95");
  assert.equal(target95.validAttemptsPerLane, 20);
  assert.equal(target95.minimumGreensPerLane, 18);
  assert.equal(target95.minimumGreensOverall, 114);
  assert.equal(target95.requireToolEventCoverage, true);
  assert.equal(target95.rejectAnyProductFailure, true);

  // No cohort field leaked onto a lane gate: the two policies stay separate.
  for (const gate of [recovery, acceptable90, target95]) {
    assert.equal(gate.cohortSize, undefined);
    assert.equal(gate.requiredLowerBound, undefined);
  }
});

test("a cohort gate CANNOT be laundered through the fixed-attempt evaluator", () => {
  // The lane evaluator excludes harness attempts from its denominator. The
  // cohort policy forbids exactly that, so passing one to the other must throw
  // rather than quietly produce a number under the wrong counting rules.
  for (const id of ["qualification99", "qualification504", "qualification999", "recovery"]) {
    assert.throws(
      () =>
        evaluateReliabilityCampaign({
          gate: resolveReliabilityGate(id),
          cells,
          attempts: campaign(10, 10),
        }),
      /Fixed-attempt evaluation requires/u,
    );
  }
});

test("qualification504 is a balanced, zero-failure, predeclared cohort gate", () => {
  const gate = resolveReliabilityGate("qualification504");
  assert.equal(gate.kind, "predeclared-cohort");
  assert.equal(gate.cohortSize, 504);
  assert.equal(gate.workflows, 6);
  assert.equal(gate.occurrencesPerWorkflow, 84);
  assert.equal(gate.cohortSize, gate.workflows * gate.occurrencesPerWorkflow);
  // One failure gives 503/504 = 99.80% observed, below the 99.9% target, so
  // the gate must not advertise a tolerance the observed criterion rejects.
  assert.equal(gate.maximumFailures, 0);
  assert.equal(gate.requiredObservedSuccessRate, 0.999);
  assert.equal(gate.requiredLowerBound, 0.99);
  assert.equal(resolveReliabilityGate("504").id, "qualification504");
});
