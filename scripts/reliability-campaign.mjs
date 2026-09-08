export const RELIABILITY_GATES = Object.freeze({
  recovery: Object.freeze({
    id: "recovery",
    kind: "consecutive",
    infrastructureLaunchRateMaxExclusive: 0.05,
  }),
  acceptable90: Object.freeze({
    id: "acceptable90",
    kind: "fixed-attempts",
    validAttemptsPerLane: 10,
    minimumGreensPerLane: 8,
    minimumGreensOverall: 54,
    infrastructureLaunchRateMaxExclusive: 0.05,
    requireToolEventCoverage: false,
    rejectAnyProductFailure: false,
  }),
  target95: Object.freeze({
    id: "target95",
    kind: "fixed-attempts",
    validAttemptsPerLane: 20,
    minimumGreensPerLane: 18,
    minimumGreensOverall: 114,
    infrastructureLaunchRateMaxExclusive: 0.05,
    requireToolEventCoverage: true,
    rejectAnyProductFailure: true,
  }),
  // ---------------------------------------------------------------------
  // The predeclared-cohort policy (`mission-success/v1`). A THIRD kind, not
  // an edit to the two above: recovery/acceptable90/target95 keep their
  // denominators, their infrastructure allowance and their recorded verdicts
  // exactly as they are. See scripts/qualification-cohort.mjs for why the
  // denominators differ, and note that evaluateReliabilityCampaign below
  // REFUSES this kind — a cohort gate can never be evaluated by the
  // fixed-attempt evaluator that excludes harness attempts.
  // ---------------------------------------------------------------------
  qualification99: Object.freeze({
    id: "qualification99",
    kind: "predeclared-cohort",
    policyVersion: "mission-success/v1",
    cohortSize: 300,
    maximumFailures: 0,
    workflows: 6,
    occurrencesPerWorkflow: 50,
    confidenceLevel: 0.95,
    requiredLowerBound: 0.99,
    requiredObservedSuccessRate: 0.999,
    infrastructureLaunchRateMaxExclusive: 0.05,
    requireToolEventCoverage: true,
    requireArtifactProof: true,
    rejectAnyProductFailure: true,
  }),
  // Declared 2026-09-06 for a staged campaign: abort-only checkpoints at 102
  // and 300, claim made only at 504. Under the plan's DUAL criterion (lower
  // bound >= 99% AND observed >= 99.9%) this is a zero-failure design: one
  // failure gives 503/504 = 99.80% observed, which misses 99.9% even though
  // the lower bound (99.06%) survives. 504 = 84 x 6 keeps every checkpoint
  // balanced (17 / 50 / 84 per workflow). Exact one-sided 95% bound at
  // 504/0 is 0.99405.
  qualification504: Object.freeze({
    id: "qualification504",
    kind: "predeclared-cohort",
    policyVersion: "mission-success/v1",
    cohortSize: 504,
    maximumFailures: 0,
    workflows: 6,
    occurrencesPerWorkflow: 84,
    confidenceLevel: 0.95,
    requiredLowerBound: 0.99,
    requiredObservedSuccessRate: 0.999,
    infrastructureLaunchRateMaxExclusive: 0.05,
    requireToolEventCoverage: true,
    requireArtifactProof: true,
    rejectAnyProductFailure: true,
  }),
  qualification999: Object.freeze({
    id: "qualification999",
    kind: "predeclared-cohort",
    policyVersion: "mission-success/v1",
    cohortSize: 1002,
    maximumFailures: 1,
    workflows: 6,
    occurrencesPerWorkflow: 167,
    confidenceLevel: 0.95,
    requiredLowerBound: 0.99,
    requiredObservedSuccessRate: 0.999,
    infrastructureLaunchRateMaxExclusive: 0.05,
    requireToolEventCoverage: true,
    requireArtifactProof: true,
    rejectAnyProductFailure: true,
  }),
});

export function resolveReliabilityGate(value = "recovery") {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases = {
    recovery: "recovery",
    "90": "acceptable90",
    acceptable: "acceptable90",
    acceptable90: "acceptable90",
    "95": "target95",
    target: "target95",
    target95: "target95",
    "99": "qualification99",
    qualification: "qualification99",
    qualification99: "qualification99",
    "504": "qualification504",
    qualification504: "qualification504",
    "999": "qualification999",
    "99.9": "qualification999",
    qualification999: "qualification999",
  };
  const key = aliases[normalized];
  if (!key) {
    throw new Error(
      `Unknown reliability gate '${value}'. Use recovery, acceptable90, target95, ` +
      "qualification99, or qualification999.",
    );
  }
  return RELIABILITY_GATES[key];
}

export function isValidApplicationAttempt(attempt) {
  return Boolean(attempt?.green) || !/^(?:harness|process):/u.test(
    String(attempt?.failureClass ?? ""),
  );
}

function hasToolEventCoverage(attempt) {
  const events = attempt?.toolEvents;
  return Boolean(
    events &&
    events.source !== "none" &&
    Number.isSafeInteger(events.observed) &&
    events.observed >= 0 &&
    Number.isSafeInteger(events.failed) &&
    events.failed >= 0,
  );
}

export function hasGreenAcceptanceProof(attempt) {
  if (!attempt?.green) return true;
  const acceptance = attempt?.acceptance;
  return Boolean(
    acceptance &&
    acceptance.acceptanceStatus === "pass" &&
    acceptance.scorecardAcceptancePassed === true &&
    Number.isFinite(acceptance.scorecardTotal),
  );
}

/**
 * Evaluate a completed fixed-attempt campaign without reclassifying any run.
 * Infrastructure attempts stay in launch health but never enter the product
 * denominator. An observed 100% is reported only when every valid attempt was
 * green; it is deliberately not phrased as a future guarantee.
 */
export function evaluateReliabilityCampaign({ gate, cells, attempts }) {
  if (gate.kind !== "fixed-attempts") {
    throw new Error(
      "Fixed-attempt evaluation requires acceptable90 or target95. " +
      "A predeclared-cohort gate (qualification99/qualification999) must be evaluated by " +
      "evaluateQualificationCohort in scripts/qualification-cohort.mjs: this evaluator excludes " +
      "harness attempts from its denominator, which that policy forbids.",
    );
  }
  const selectedCells = Array.from(cells ?? []);
  const allAttempts = Array.from(attempts ?? []);
  const valid = allAttempts.filter(isValidApplicationAttempt);
  const infrastructure = allAttempts.filter((attempt) => !isValidApplicationAttempt(attempt));
  const failures = [];
  const lanes = [];

  for (const cell of selectedCells) {
    const laneValid = valid.filter((attempt) => attempt.cell === cell.id);
    const greens = laneValid.filter((attempt) => attempt.green).length;
    lanes.push({
      cell: cell.id,
      validAttempts: laneValid.length,
      greens,
      rate: laneValid.length === 0 ? null : greens / laneValid.length,
    });
    if (laneValid.length !== gate.validAttemptsPerLane) {
      failures.push(
        `${cell.id} has ${laneValid.length}/${gate.validAttemptsPerLane} valid attempts`,
      );
    }
    if (greens < gate.minimumGreensPerLane) {
      failures.push(
        `${cell.id} has ${greens}/${gate.validAttemptsPerLane} greens; minimum is ${gate.minimumGreensPerLane}`,
      );
    }
  }

  const greensOverall = valid.filter((attempt) => attempt.green).length;
  const expectedValid = gate.validAttemptsPerLane * selectedCells.length;
  if (valid.length !== expectedValid) {
    failures.push(`campaign has ${valid.length}/${expectedValid} valid attempts`);
  }
  if (greensOverall < gate.minimumGreensOverall) {
    failures.push(
      `campaign has ${greensOverall}/${expectedValid} greens; minimum is ${gate.minimumGreensOverall}`,
    );
  }

  const productCounts = new Map();
  for (const attempt of valid) {
    const failureClass = String(attempt?.failureClass ?? "");
    if (!failureClass.startsWith("product:")) continue;
    productCounts.set(failureClass, (productCounts.get(failureClass) ?? 0) + 1);
  }
  for (const [failureClass, count] of productCounts) {
    if (count >= 2) failures.push(`repeated product failure ${failureClass} (${count})`);
    if (gate.rejectAnyProductFailure) {
      failures.push(`target gate contains unresolved product failure ${failureClass}`);
    }
  }

  if (gate.requireToolEventCoverage) {
    const missing = valid.filter((attempt) => !hasToolEventCoverage(attempt));
    if (missing.length > 0) {
      failures.push(`${missing.length} valid attempt(s) lack tool-event coverage`);
    }
  }

  const greensWithoutAcceptanceProof = valid.filter(
    (attempt) => !hasGreenAcceptanceProof(attempt),
  );
  if (greensWithoutAcceptanceProof.length > 0) {
    failures.push(
      `${greensWithoutAcceptanceProof.length} green attempt(s) lack accepted mission and scorecard proof`,
    );
  }

  const launches = allAttempts.length;
  const infrastructureRate = launches === 0 ? 0 : infrastructure.length / launches;
  if (infrastructureRate >= gate.infrastructureLaunchRateMaxExclusive) {
    failures.push(
      `infrastructure failures are ${(infrastructureRate * 100).toFixed(1)}% of launches; must remain below 5%`,
    );
  }

  return {
    gate: gate.id,
    passed: failures.length === 0,
    failures,
    lanes,
    launches,
    infrastructureFailures: infrastructure.length,
    infrastructureRate,
    validAttempts: valid.length,
    greens: greensOverall,
    observedSuccessRate: valid.length === 0 ? null : greensOverall / valid.length,
    observedPerfectCampaign: valid.length === expectedValid && greensOverall === expectedValid,
  };
}
