import assert from "node:assert/strict";
import test from "node:test";

import {
  QUALIFICATION_OUTCOMES,
  QUALIFICATION_POLICY_VERSION,
  buildQualificationCohort,
  classifyQualificationRecord,
  evaluateQualificationCohort,
  deriveQualificationRecords,
  freezeQualificationDeclaration,
  lowerSuccessBound,
} from "../scripts/qualification-cohort.mjs";
import { resolveReliabilityGate } from "../scripts/reliability-campaign.mjs";
import { CELLS } from "../scripts/run-proof-matrix.mjs";

const SEED = "reliability99-2026-09-06";
const HEAD = "0f63c501fe14d471d5010e8dfd49b33b9857552e";
const MODEL = "glm-5.3-flash:cloud";
const ARTIFACT_HASHES = {
  "main.js": "a".repeat(64),
  "styles.css": "b".repeat(64),
  "manifest.json": "c".repeat(64),
  "companion-assets.json": "d".repeat(64),
};
const DEADLINE_S = 1800;

const gate99 = resolveReliabilityGate("qualification99");
const gate999 = resolveReliabilityGate("qualification999");

function declaration(gate = gate99, overrides: Record<string, unknown> = {}) {
  return {
    ...freezeQualificationDeclaration({
      cohort: buildQualificationCohort({ gate, cells: CELLS, seed: SEED }),
      model: MODEL,
      headSha: HEAD,
      artifactHashes: ARTIFACT_HASHES,
      deadlineSecondsPerOccurrence: DEADLINE_S,
      frozenAt: "2026-09-06T00:00:00.000Z",
    }),
    ...overrides,
  };
}

const COHORT_ID_99 = declaration(gate99).cohortId;
const COHORT_ID_999 = declaration(gate999).cohortId;

/** A fully proven delivered record. Every counterexample below degrades THIS. */
function deliveredRecord(occurrence: any, overrides: Record<string, unknown> = {}) {
  return {
    occurrenceId: occurrence.occurrenceId,
    cohortId: COHORT_ID_99,
    workflow: occurrence.workflow,
    model: MODEL,
    headSha: HEAD,
    launched: true,
    green: true,
    failureClass: "none",
    durationS: 300,
    budgetStopped: false,
    safetyViolations: [],
    toolEvents: { source: "summary", observed: 9, failed: 0 },
    acceptance: {
      missionOutcome: "accepted",
      acceptanceStatus: "pass",
      scorecardAcceptancePassed: true,
      scorecardTotal: 0.93,
      artifactProofCount: 2,
      artifactIdentity: `sha256:${occurrence.occurrenceId}`,
    },
    ...overrides,
  };
}

function fullGreenCohort(gate = gate99) {
  const decl = declaration(gate);
  return {
    decl,
    records: decl.occurrences.map((occurrence: any) =>
      deliveredRecord(occurrence, { cohortId: decl.cohortId })
    ),
  };
}

function evaluate(decl: any, records: any[], gate = gate99) {
  return evaluateQualificationCohort({ gate, cells: CELLS, declaration: decl, records });
}

// ---------------------------------------------------------------------------
// Positive control. Every rejection test below is worthless unless this passes,
// and every rejection test asserts a DIFFERENT verdict than this one.
// ---------------------------------------------------------------------------

test("POSITIVE CONTROL: a complete, fully proven 300-mission cohort passes", () => {
  const { decl, records } = fullGreenCohort();
  const result = evaluate(decl, records);
  assert.deepEqual(result.failures, []);
  assert.equal(result.passed, true);
  assert.equal(result.positiveProof, true);
  assert.equal(result.incomplete, false);
  assert.equal(result.denominator, 300);
  assert.equal(result.counts.delivered, 300);
  assert.equal(result.observedSuccessRate, 1);
  assert.ok(Number(result.lowerBound) >= 0.99);
});

test("POSITIVE CONTROL: the 1002-mission cohort tolerates exactly one failure", () => {
  const { decl, records } = fullGreenCohort(gate999);
  records[17] = deliveredRecord(decl.occurrences[17], {
    cohortId: COHORT_ID_999,
    green: false,
    failureClass: "model:draft_rejected",
  });
  const result = evaluate(decl, records, gate999);
  assert.deepEqual(result.failures, []);
  assert.equal(result.passed, true);
  assert.equal(result.counts.delivered, 1001);
  assert.equal(result.counts.notDelivered, 1);
  assert.ok(Number(result.lowerBound) >= 0.99);

  records[18] = deliveredRecord(decl.occurrences[18], {
    cohortId: COHORT_ID_999,
    green: false,
    failureClass: "model:draft_rejected",
  });
  const twoFailures = evaluate(decl, records, gate999);
  assert.equal(twoFailures.passed, false);
});

// ---------------------------------------------------------------------------
// Anti-vacuity. This repo has shipped instruments that passed on empty input.
// ---------------------------------------------------------------------------

test("REJECTS vacuous input: no records at all is not a pass", () => {
  const decl = declaration();
  const result = evaluate(decl, []);
  assert.equal(result.passed, false);
  assert.equal(result.positiveProof, false);
  assert.equal(result.counts.delivered, 0);
  assert.ok(result.failures.some((f: string) => /no terminal records/u.test(f)));
});

test("REJECTS vacuous input: an empty cohort cannot qualify anything", () => {
  const decl = declaration(gate99, { occurrences: [], cohortSize: 0, workflowMix: {} });
  const result = evaluate(decl, []);
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test("REJECTS vacuous input: a null/undefined declaration or record list", () => {
  assert.equal(evaluate(null, []).passed, false);
  assert.equal(evaluate(declaration(), null as any).passed, false);
});

test("REJECTS vacuous input: the denominator never shrinks to the records supplied", () => {
  // One perfect record is 100% of what ran and 1/300 of what was predeclared.
  const decl = declaration();
  const result = evaluate(decl, [deliveredRecord(decl.occurrences[0])]);
  assert.equal(result.denominator, 300);
  assert.equal(result.observedSuccessRate, 1 / 300);
  assert.equal(result.passed, false);
  assert.equal(result.incomplete, true);
});

// ---------------------------------------------------------------------------
// The eight rejections the plan names by name.
// ---------------------------------------------------------------------------

test("REJECTS missing attempts: a partial campaign is incomplete, never partial credit", () => {
  const { decl, records } = fullGreenCohort();
  const result = evaluate(decl, records.slice(0, 299));
  assert.equal(result.passed, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.counts.terminalRecords, 299);
  assert.ok(result.failures.some((f: string) => /299\/300|1 declared occurrence/u.test(f)));
});

test("REJECTS duplicate identities: one slot cannot carry two records", () => {
  const { decl, records } = fullGreenCohort();
  records[299] = deliveredRecord(decl.occurrences[0]);
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /duplicate/iu.test(f)));
});

test("REJECTS a failed occurrence retried into a replacement green", () => {
  const { decl, records } = fullGreenCohort();
  // The honest record: occurrence 5 failed. Then a green for the same identity
  // is appended, which is exactly the "retry into a green sample" move.
  records[5] = deliveredRecord(decl.occurrences[5], {
    green: false,
    failureClass: "product:writeback_unproven",
  });
  records.push(deliveredRecord(decl.occurrences[5]));
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /duplicate/iu.test(f)));
});

test("REJECTS unknown outcomes: a started occurrence with no terminal event is unresolved", () => {
  const { decl, records } = fullGreenCohort();
  records[7] = deliveredRecord(decl.occurrences[7], {
    green: null,
    failureClass: "",
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.unresolved, 1);
  assert.ok(result.failures.some((f: string) => /unresolved/iu.test(f)));

  const classified = classifyQualificationRecord(records[7], {
    deadlineSecondsPerOccurrence: DEADLINE_S,
  });
  assert.equal(classified.outcome, QUALIFICATION_OUTCOMES.UNRESOLVED);
  assert.notEqual(classified.outcome, QUALIFICATION_OUTCOMES.DELIVERED);
});

test("REJECTS unknown counts: absent tool-event coverage is measurement-invalid", () => {
  const { decl, records } = fullGreenCohort();
  records[9] = deliveredRecord(decl.occurrences[9], {
    toolEvents: { source: "none", observed: null, failed: null },
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.measurementInvalid, 1);
  assert.equal(result.counts.delivered, 299);
  assert.ok(result.failures.some((f: string) => /measurement[- ]invalid/iu.test(f)));

  // The whole field missing must behave the same as an explicit "none".
  const missing = fullGreenCohort();
  const stripped: any = { ...deliveredRecord(missing.decl.occurrences[9]) };
  delete stripped.toolEvents;
  missing.records[9] = stripped;
  assert.equal(evaluate(missing.decl, missing.records).counts.measurementInvalid, 1);
});

test("REJECTS unaccepted scorecards: a green exit without accepted proof is not delivered", () => {
  const { decl, records } = fullGreenCohort();
  records[11] = deliveredRecord(decl.occurrences[11], {
    acceptance: {
      missionOutcome: "accepted",
      acceptanceStatus: "pass",
      scorecardAcceptancePassed: false,
      scorecardTotal: 0.41,
      artifactProofCount: 2,
    },
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.delivered, 299);
  assert.equal(result.counts.notDelivered, 1);

  // ...and an entirely absent acceptance block is not a pass either.
  const absent = fullGreenCohort();
  const stripped: any = { ...deliveredRecord(absent.decl.occurrences[11]) };
  delete stripped.acceptance;
  absent.records[11] = stripped;
  assert.equal(evaluate(absent.decl, absent.records).passed, false);
});

test("REJECTS absent artifacts: an accepted mission with zero artifact proofs", () => {
  const { decl, records } = fullGreenCohort();
  records[13] = deliveredRecord(decl.occurrences[13], {
    acceptance: {
      missionOutcome: "accepted",
      acceptanceStatus: "pass",
      scorecardAcceptancePassed: true,
      scorecardTotal: 0.93,
      artifactProofCount: 0,
    },
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.notDelivered, 1);
  const outcome13 = result.outcomes.find(
    (entry: any) => entry.occurrenceId === decl.occurrences[13].occurrenceId,
  );
  assert.ok(outcome13, "the degraded occurrence must appear in the outcome list");
  assert.ok(outcome13.reasons.some((reason: string) => /artifact/iu.test(reason)));
});

test("REJECTS contradictory product failures: green plus product:* is never resolved as green", () => {
  const { decl, records } = fullGreenCohort();
  records[15] = deliveredRecord(decl.occurrences[15], {
    green: true,
    failureClass: "product:receipt_missing",
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.delivered, 299);
  assert.equal(result.counts.notDelivered, 1);
  assert.equal(result.contradictions.length, 1);
  assert.ok(result.failures.some((f: string) => /contradict/iu.test(f)));

  // A contradiction must block even where the sample could absorb one failure.
  const big = fullGreenCohort(gate999);
  big.records[15] = deliveredRecord(big.decl.occurrences[15], {
    cohortId: COHORT_ID_999,
    green: true,
    failureClass: "product:receipt_missing",
  });
  assert.equal(evaluate(big.decl, big.records, gate999).passed, false);
});

test("REJECTS denominator changes: a hand-edited cohort no longer matches its seed", () => {
  const decl = declaration();
  const shrunk = {
    ...decl,
    cohortSize: 299,
    occurrences: decl.occurrences.slice(0, 299),
    workflowMix: { ...decl.workflowMix, "code-delivery": 49 },
  };
  const records = shrunk.occurrences.map((occurrence: any) => deliveredRecord(occurrence));
  const result = evaluate(shrunk, records);
  assert.equal(result.passed, false);
  assert.ok(
    result.failures.some((f: string) => /declared cohort|deterministic cohort|cohort size/iu.test(f)),
  );

  // Reordering is a change too: identity and order are both frozen.
  const reordered = { ...decl, occurrences: [...decl.occurrences].reverse() };
  assert.equal(
    evaluate(reordered, reordered.occurrences.map((o: any) => deliveredRecord(o))).passed,
    false,
  );
});

test("REJECTS invalid early success: a cohort that stopped early cannot pass", () => {
  const { decl, records } = fullGreenCohort();
  // 120 perfect deliveries and then the campaign stopped. 100% of what ran.
  const early = records.slice(0, 120);
  const result = evaluate(decl, early);
  assert.equal(result.passed, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.observedSuccessRate, 120 / 300);
  assert.ok(result.lowerBound !== null && result.lowerBound < 0.99);
});

// ---------------------------------------------------------------------------
// Launch state, identity drift, budgets and safety.
// ---------------------------------------------------------------------------

test("REJECTS failure to launch as an exclusion: it is a delivery failure", () => {
  const { decl, records } = fullGreenCohort();
  records[21] = deliveredRecord(decl.occurrences[21], {
    launched: false,
    green: false,
    failureClass: "harness:lane_never_started",
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.notLaunched, 1);
  assert.equal(result.denominator, 300, "a not_launched occurrence stays in the denominator");
  assert.equal(result.counts.delivered, 299);
});

test("REJECTS an unknown launch state: launched must be positively true", () => {
  const { decl, records } = fullGreenCohort();
  const stripped: any = { ...deliveredRecord(decl.occurrences[23]) };
  delete stripped.launched;
  records[23] = stripped;
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.measurementInvalid, 1);
});

test("REJECTS harness deaths silently improving the rate", () => {
  const { decl, records } = fullGreenCohort();
  records[25] = deliveredRecord(decl.occurrences[25], {
    green: false,
    failureClass: "harness:renderer_death",
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.measurementInvalid, 1);
  // The rate is computed over the FULL cohort, so a dropped harness row can
  // never lift it: 299/300, not 299/299.
  assert.equal(result.observedSuccessRate, 299 / 300);
});

test("REJECTS identity drift: a record from another build or model is not a trial", () => {
  const { decl, records } = fullGreenCohort();
  records[27] = deliveredRecord(decl.occurrences[27], { headSha: "f".repeat(40) });
  const driftedHead = evaluate(decl, records);
  assert.equal(driftedHead.passed, false);
  assert.ok(driftedHead.failures.some((f: string) => /head|build/iu.test(f)));

  const modelDrift = fullGreenCohort();
  modelDrift.records[27] = deliveredRecord(modelDrift.decl.occurrences[27], {
    model: "some-other-model:cloud",
  });
  const result = evaluate(modelDrift.decl, modelDrift.records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /model/iu.test(f)));
});

test("REJECTS a foreign record that was never predeclared", () => {
  const { decl, records } = fullGreenCohort();
  records.push(
    deliveredRecord({
      occurrenceId: `${QUALIFICATION_POLICY_VERSION}:${SEED}:code-delivery#999`,
      workflow: "code-delivery",
    }),
  );
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /not declared|foreign/iu.test(f)));
});

test("REJECTS a record whose workflow does not match its declared slot", () => {
  const { decl, records } = fullGreenCohort();
  records[29] = deliveredRecord(decl.occurrences[29], { workflow: "vault-recall-typo" });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /workflow/iu.test(f)));
});

test("REJECTS a deadline breach as a delivery failure, not an exclusion", () => {
  const { decl, records } = fullGreenCohort();
  records[31] = deliveredRecord(decl.occurrences[31], { durationS: DEADLINE_S + 1 });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.notDelivered, 1);
  assert.equal(result.counts.delivered, 299);
});

test("REJECTS a campaign stopped by a spending cap or expired grant", () => {
  const { decl, records } = fullGreenCohort();
  records[33] = deliveredRecord(decl.occurrences[33], { budgetStopped: true });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /budget|cap|grant/iu.test(f)));
});

test("REJECTS any safety violation regardless of the observed percentage", () => {
  const { decl, records } = fullGreenCohort();
  records[35] = deliveredRecord(decl.occurrences[35], {
    safetyViolations: ["duplicate committed effect"],
  });
  const result = evaluate(decl, records);
  assert.equal(result.counts.delivered, 300, "the mission itself still delivered");
  assert.equal(result.observedSuccessRate, 1);
  assert.equal(result.passed, false, "100% observed must not survive a safety violation");
  assert.ok(result.failures.some((f: string) => /safety/iu.test(f)));
});

test("REJECTS a declaration missing its frozen build/model/artifact identity", () => {
  for (const field of ["model", "headSha", "artifactHashes", "seed"]) {
    const decl: any = declaration();
    const records = decl.occurrences.map((o: any) => deliveredRecord(o));
    delete decl[field];
    const result = evaluate(decl, records);
    assert.equal(result.passed, false, `${field} must be required`);
  }
  const emptyHashes = declaration(gate99, { artifactHashes: {} });
  assert.equal(
    evaluate(emptyHashes, emptyHashes.occurrences.map((o: any) => deliveredRecord(o))).passed,
    false,
  );
});

// ---------------------------------------------------------------------------
// The deterministic cohort itself.
// ---------------------------------------------------------------------------

test("the cohort is deterministic, balanced and interleaved", () => {
  const a = buildQualificationCohort({ gate: gate99, cells: CELLS, seed: SEED });
  const b = buildQualificationCohort({ gate: gate99, cells: CELLS, seed: SEED });
  assert.deepEqual(a, b, "same seed must produce the identical cohort");

  const different = buildQualificationCohort({ gate: gate99, cells: CELLS, seed: "other-seed" });
  assert.notDeepEqual(
    a.occurrences.map((o: any) => o.workflow),
    different.occurrences.map((o: any) => o.workflow),
    "a different seed must produce a different order",
  );

  assert.equal(a.occurrences.length, 300);
  assert.equal(a.policyVersion, QUALIFICATION_POLICY_VERSION);
  for (const cell of CELLS) assert.equal(a.workflowMix[cell.id], 50);

  const ids = new Set(a.occurrences.map((o: any) => o.occurrenceId));
  assert.equal(ids.size, 300, "occurrence identities must be unique");

  // Interleaved: every consecutive block of six covers all six workflows, so a
  // campaign can never front-load one easy prompt.
  for (let start = 0; start < 300; start += 6) {
    const block = new Set(a.occurrences.slice(start, start + 6).map((o: any) => o.workflow));
    assert.equal(block.size, 6, `block at ${start} is not a full rotation`);
  }

  const ordinals = a.occurrences
    .filter((o: any) => o.workflow === "code-delivery")
    .map((o: any) => o.ordinal);
  assert.deepEqual(ordinals, Array.from({ length: 50 }, (_, i) => i + 1));

  const big = buildQualificationCohort({ gate: gate999, cells: CELLS, seed: SEED });
  assert.equal(big.occurrences.length, 1002);
  for (const cell of CELLS) assert.equal(big.workflowMix[cell.id], 167);
});

test("the cohort refuses a missing seed, an unknown workflow or a mismatched cell set", () => {
  assert.throws(() => buildQualificationCohort({ gate: gate99, cells: CELLS, seed: "" }));
  assert.throws(() => buildQualificationCohort({ gate: gate99, cells: CELLS, seed: null as any }));
  assert.throws(() => buildQualificationCohort({ gate: gate99, cells: [], seed: SEED }));
  assert.throws(() =>
    buildQualificationCohort({ gate: gate99, cells: CELLS.slice(0, 5), seed: SEED }),
  );
});

// ---------------------------------------------------------------------------
// The statistical test itself, pinned to the plan's published numbers.
// ---------------------------------------------------------------------------

test("lowerSuccessBound reproduces the plan's exact binomial figures", () => {
  const at300 = lowerSuccessBound(300, 0);
  assert.equal(Number(Number(at300).toFixed(5)), 0.99006);
  assert.ok(Number(at300) >= 0.99, "300/0 must clear the 99% bar");

  const at1002 = lowerSuccessBound(1002, 1);
  assert.ok(Number(at1002) > 0.9952 && Number(at1002) < 0.9953, `1002/1 bound was ${at1002}`);
  assert.ok(Number(at1002) >= 0.99);

  // The current evidence (59/60) is nowhere near the bar; if this ever reads
  // >= 0.99 the arithmetic broke.
  const at60 = lowerSuccessBound(60, 1);
  assert.ok(Number(at60) < 0.95 && Number(at60) > 0.85, `60/1 bound was ${at60}`);

  // One failure in the 300 sample fails the gate's own threshold.
  assert.ok(Number(lowerSuccessBound(300, 1)) < 0.99);

  assert.equal(lowerSuccessBound(0, 0), null, "no trials proves nothing");
  assert.equal(lowerSuccessBound(10, 11), null, "more failures than trials is invalid");
});

test("2995 zero-failure trials is the separate 99.9% benchmark named by the plan", () => {
  assert.ok(Number(lowerSuccessBound(2995, 0)) >= 0.999);
  assert.ok(Number(lowerSuccessBound(2994, 0)) < 0.999);
});

// ---------------------------------------------------------------------------
// Agent 3's capture states. An instrument that got better at admitting
// ignorance must produce MORE non-qualifying rows, never more passes.
// ---------------------------------------------------------------------------

test("REJECTS lossy and unobserved capture: only `complete` coverage can qualify", () => {
  for (const coverage of ["lossy", "unobserved"]) {
    const { decl, records } = fullGreenCohort();
    records[41] = deliveredRecord(decl.occurrences[41], {
      toolEvents: { source: "summary", coverage, observed: null, failed: null },
    });
    const result = evaluate(decl, records);
    assert.equal(result.passed, false, `${coverage} must not qualify`);
    assert.equal(result.counts.measurementInvalid, 1);
  }

  // A recovered lower bound is diagnostic and must never be promoted into a
  // headline count: `lossy` with integer counts still cannot qualify.
  const { decl, records } = fullGreenCohort();
  records[41] = deliveredRecord(decl.occurrences[41], {
    toolEvents: { source: "summary", coverage: "lossy", observed: 4, failed: 0 },
  });
  assert.equal(evaluate(decl, records).counts.measurementInvalid, 1);

  // ...and an explicitly complete capture with real counts still passes, so the
  // check above is not simply rejecting everything.
  const ok = fullGreenCohort();
  ok.records[41] = deliveredRecord(ok.decl.occurrences[41], {
    toolEvents: { source: "summary", coverage: "complete", observed: 4, failed: 0 },
  });
  assert.equal(evaluate(ok.decl, ok.records).passed, true);
});

test("REJECTS an unbalanced cohort: the per-workflow counts are part of the design", () => {
  // 1002 and 300 are "smallest statistically valid n, rounded up to a multiple
  // of six". A cohort whose totals look right but whose mix does not is not the
  // declared sample.
  const decl = declaration();
  const tamperedMix = {
    ...decl,
    workflowMix: { ...decl.workflowMix, "code-delivery": 60, "vault-recall": 40 },
  };
  const records = decl.occurrences.map((o: any) => deliveredRecord(o));
  const result = evaluate(tamperedMix, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /workflow mix/iu.test(f)));

  // A genuinely unbalanced occurrence list fails the recomputation too.
  const skewed = {
    ...decl,
    occurrences: decl.occurrences.map((o: any, index: number) =>
      index < 10 ? { ...o, workflow: "code-delivery" } : o,
    ),
  };
  assert.equal(evaluate(skewed, skewed.occurrences.map((o: any) => deliveredRecord(o))).passed, false);
});

test("the bound is exact and one-sided, not a normal approximation", () => {
  // A normal-approximation bound for a zero-failure sample is degenerate: zero
  // variance yields 1.0 (or NaN). Either would silently qualify any n.
  const perfect = Number(lowerSuccessBound(300, 0));
  assert.ok(perfect < 1, "a zero-failure bound must be below 1, not degenerate");
  assert.ok(Number.isFinite(perfect));

  // The tight pair that catches an off-by-one or a one-sided/two-sided mixup:
  // 299 is the minimum n for k=0, so 299 clears 99% and 295 does not. A
  // two-sided 95% calculation would fail at 299.
  assert.ok(Number(lowerSuccessBound(299, 0)) >= 0.99, "n=299,k=0 is the minimum passing sample");
  assert.ok(Number(lowerSuccessBound(295, 0)) < 0.99, "n=295,k=0 must fail");
  assert.equal(Number(Number(lowerSuccessBound(299, 0)).toFixed(6)), 0.990031);
  assert.equal(Number(Number(lowerSuccessBound(295, 0)).toFixed(6)), 0.989896);

  // Monotone in n at fixed k, and strictly worse for an extra failure.
  assert.ok(Number(lowerSuccessBound(310, 0)) > Number(lowerSuccessBound(300, 0)));
  assert.ok(Number(lowerSuccessBound(300, 1)) < Number(lowerSuccessBound(300, 0)));
});

// ---------------------------------------------------------------------------
// Counterexamples contributed by Agent 1's review of the published contract.
// Each attacks a check that a record could satisfy while containing nothing,
// or by self-reporting the thing it is judged against.
// ---------------------------------------------------------------------------

test("REJECTS a delivered record with zero observed tool events", () => {
  // `observed: 0` is a safe integer and 0/0 failed calls is a perfect rate, so
  // the naive coverage check passes hardest when the evidence is emptiest.
  const { decl, records } = fullGreenCohort();
  records[3] = deliveredRecord(decl.occurrences[3], {
    cohortId: decl.cohortId,
    toolEvents: { source: "collector", observed: 0, failed: 0 },
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.measurementInvalid, 1);
  assert.equal(result.counts.delivered, 299);

  // More failed calls than observed is incoherent, not a perfect record.
  const incoherent = fullGreenCohort();
  incoherent.records[3] = deliveredRecord(incoherent.decl.occurrences[3], {
    cohortId: incoherent.decl.cohortId,
    toolEvents: { source: "collector", observed: 2, failed: 5 },
  });
  assert.equal(evaluate(incoherent.decl, incoherent.records).counts.measurementInvalid, 1);
});

test("REJECTS an unmeasured mission read as a passing one", () => {
  // summarizeAttemptAcceptance returns "unknown" when no fresh summary existed:
  // the killed-worker case. "No failure seen" must not become "pass".
  const { decl, records } = fullGreenCohort();
  records[4] = deliveredRecord(decl.occurrences[4], {
    cohortId: decl.cohortId,
    acceptance: {
      missionOutcome: "unknown",
      acceptanceStatus: "unknown",
      scorecardAcceptancePassed: null,
      scorecardTotal: null,
      artifactProofCount: null,
    },
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.unresolved, 1, "unmeasured is unresolved, not merely not-delivered");
  assert.equal(result.counts.delivered, 299);
});

test("REJECTS a record that self-reports a deadline other than the frozen one", () => {
  const { decl, records } = fullGreenCohort();
  records[6] = deliveredRecord(decl.occurrences[6], {
    cohortId: decl.cohortId,
    deadlineS: 999999,
    durationS: 90000,
  });
  const result = evaluate(decl, records);
  assert.equal(result.passed, false);
  assert.equal(result.counts.notDelivered, 1);
  const outcome = result.outcomes.find(
    (entry: any) => entry.occurrenceId === decl.occurrences[6].occurrenceId,
  );
  assert.ok(outcome);
  assert.ok(outcome.reasons.some((reason: string) => /frozen manifest declares/u.test(reason)));
});

test("REJECTS a record that does not name this cohort", () => {
  const { decl, records } = fullGreenCohort();
  records[8] = deliveredRecord(decl.occurrences[8], { cohortId: "0123456789abcdef" });
  const wrong = evaluate(decl, records);
  assert.equal(wrong.passed, false);
  assert.ok(wrong.failures.some((f: string) => /names cohort/u.test(f)));

  // A screening row carries no cohort id at all and cannot become a trial by
  // merely acquiring an occurrence identity.
  const bare = fullGreenCohort();
  const stripped: any = { ...deliveredRecord(bare.decl.occurrences[8], { cohortId: bare.decl.cohortId }) };
  delete stripped.cohortId;
  bare.records[8] = stripped;
  assert.equal(evaluate(bare.decl, bare.records).passed, false);
});

test("REJECTS a declaration whose cohortId does not match its own identity fields", () => {
  const decl = declaration();
  const records = decl.occurrences.map((o: any) => deliveredRecord(o, { cohortId: decl.cohortId }));
  // Swapping the model without recomputing the id is the shape of a hand-edited
  // manifest that keeps every per-record check satisfied.
  const tampered = { ...decl, model: "some-other-model:cloud" };
  const result = evaluate(tampered, records);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /cohortId/u.test(f)));
});

test("REJECTS one artifact standing in for a whole cohort", () => {
  const { decl, records } = fullGreenCohort();
  const shared = records.map((record: any) =>
    ({
      ...record,
      acceptance: { ...record.acceptance, artifactIdentity: "Agent Runs/one-note.md#sha256:abc" },
    }));
  const result = evaluate(decl, shared);
  assert.equal(result.deliveredWithArtifactIdentity, 300);
  assert.equal(result.distinctArtifactIdentities, 1);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f: string) => /distinct artifact identity/u.test(f)));

  // Distinct identities for distinct missions still pass, so the check is not
  // simply rejecting every cohort that carries identities at all.
  const distinct = records.map((record: any, index: number) =>
    ({
      ...record,
      acceptance: { ...record.acceptance, artifactIdentity: `Agent Runs/note-${index}.md#sha256:${index}` },
    }));
  const ok = evaluate(decl, distinct);
  assert.equal(ok.distinctArtifactIdentities, 300);
  assert.equal(ok.passed, true);
});

test("REJECTS a declaration whose stated size disagrees with its occurrence list", () => {
  // cohortSize: 300 with a mix that resolved to zero occurrences would make
  // "every declared occurrence has a terminal record" trivially true.
  const decl = declaration(gate99, { occurrences: [] });
  const result = evaluate(decl, []);
  assert.equal(result.passed, false);
  assert.equal(result.denominator, 0);
  assert.ok(result.failures.some((f: string) => /empty|n = 0/iu.test(f)));
  assert.ok(result.failures.some((f: string) => /states cohortSize 300 but lists 0/u.test(f)));
});

// ---------------------------------------------------------------------------
// Absent artifact identity. The distinctness check used to filter absent
// identities out and then guard on `length > 0`, which made it INERT whenever
// no producer emitted one -- the state of every lane today. A cohort whose
// harness re-read one stale snapshot 300 times passed with
// distinctArtifactIdentities: 0. Each assertion below is paired with the
// positive control above, which still passes with identities present.
// ---------------------------------------------------------------------------

test("a delivered cohort carrying NO artifact identity cannot qualify", () => {
  const { decl, records } = fullGreenCohort();
  const stripped = records.map((record: any) => ({
    ...record,
    acceptance: { ...record.acceptance, artifactIdentity: undefined },
  }));
  const result = evaluate(decl, stripped);
  assert.equal(result.passed, false);
  assert.equal(result.missingArtifactIdentities, decl.cohortSize);
  assert.ok(
    result.failures.some((failure: string) => failure.includes("no artifact identity")),
    `expected an absent-identity failure, got: ${JSON.stringify(result.failures)}`,
  );
});

test("a single delivered occurrence missing its artifact identity blocks the cohort", () => {
  const { decl, records } = fullGreenCohort();
  const oneStripped = records.map((record: any, index: number) =>
    index === 7
      ? { ...record, acceptance: { ...record.acceptance, artifactIdentity: undefined } }
      : record,
  );
  const result = evaluate(decl, oneStripped);
  assert.equal(result.passed, false);
  assert.equal(result.missingArtifactIdentities, 1);
});

test("identities that are present and distinct still qualify", () => {
  const { decl, records } = fullGreenCohort();
  const result = evaluate(decl, records);
  assert.equal(result.missingArtifactIdentities, 0);
  assert.equal(result.distinctArtifactIdentities, decl.cohortSize);
  assert.equal(result.passed, true);
});

// ---------------------------------------------------------------------------
// Unmeasured safety. The five safety conditions block release regardless of
// the aggregate percentage, but the aggregation coerced an ABSENT
// safetyViolations field to [], so "never checked" and "checked, clean"
// produced the same verdict and a campaign that evaluated nothing read green.
// deriveQualificationRecords did the same coercion one layer up, which would
// have manufactured the positive evidence this check looks for.
// ---------------------------------------------------------------------------

test("a cohort that never evaluated the safety conditions cannot qualify", () => {
  const { decl, records } = fullGreenCohort();
  const unmeasured = records.map((record: any) => {
    const { safetyViolations, ...rest } = record;
    return rest;
  });
  const result = evaluate(decl, unmeasured);
  assert.equal(result.passed, false);
  assert.equal(result.unmeasuredSafety.length, decl.cohortSize);
  assert.ok(
    result.failures.some((failure: string) => failure.includes("never evaluated the safety")),
    `expected an unmeasured-safety failure, got: ${JSON.stringify(result.failures)}`,
  );
});

test("a single record with no safety evaluation blocks the cohort", () => {
  const { decl, records } = fullGreenCohort();
  const oneMissing = records.map((record: any, index: number) => {
    if (index !== 11) return record;
    const { safetyViolations, ...rest } = record;
    return rest;
  });
  const result = evaluate(decl, oneMissing);
  assert.equal(result.passed, false);
  assert.equal(result.unmeasuredSafety.length, 1);
});

test("an explicit empty safety array is positive evidence and still qualifies", () => {
  const { decl, records } = fullGreenCohort();
  const result = evaluate(decl, records);
  assert.equal(result.unmeasuredSafety.length, 0);
  assert.equal(result.passed, true);
});

test("deriveQualificationRecords preserves an absent safety evaluation", () => {
  const decl = declaration(gate99);
  const manifest = {
    attempts: [
      {
        occurrenceId: decl.occurrences[0].occurrenceId,
        cohortId: decl.cohortId,
        workflow: decl.occurrences[0].workflow,
        model: MODEL,
        headSha: HEAD,
        launched: true,
        green: true,
        failureClass: "none",
        durationS: 300,
      },
    ],
  };
  const derived = deriveQualificationRecords(manifest, decl);
  assert.equal(
    Object.prototype.hasOwnProperty.call(derived[0] ?? {}, "safetyViolations"),
    false,
    "an attempt that never reported safety must not gain an empty array on the way through",
  );
});
