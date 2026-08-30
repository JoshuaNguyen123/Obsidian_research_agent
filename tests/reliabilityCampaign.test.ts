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
