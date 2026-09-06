// The versioned mission-success qualification policy: `mission-success/v1`.
//
// WHY THIS IS A SECOND POLICY AND NOT AN EDIT TO THE FIRST ONE
//
// `recovery`, `acceptable90` and `target95` in scripts/reliability-campaign.mjs
// answer "did these lanes clear their fixed-attempt bar". To do that honestly
// they EXCLUDE classified harness/process attempts from the application
// denominator and tolerate an infrastructure launch-failure rate below 5%. That
// is the right shape for a lane-health gate, and their verdicts and CSV rows
// stay exactly as recorded.
//
// It is the wrong shape for an operational-completion claim, and presenting it
// as one would be the lie this module exists to prevent. This policy answers a
// different question: of every mission occurrence we PREDECLARED, how many
// actually delivered their contract? Its denominator is the predeclared cohort.
// It never shrinks — not for a harness death, not for a launch failure, not for
// an attempt nobody observed.
//
// ANTI-VACUITY
//
// This repository has shipped several instruments that read green on empty or
// absent input (check:workspace-links, the mission-scorecard step function, the
// empty-set harvest, missionGraphOnlyFinalSynthesisRemainsV1). Every check here
// is therefore paired with a POSITIVE-proof predicate: `passed` requires
// `failures.length === 0` AND `positiveProof`, where positiveProof is an
// affirmative statement about how many deliveries were actually proven. An
// empty record set, an empty cohort or an absent declaration all produce
// `passed: false` with `positiveProof: false`, and tests/qualificationCohort.test.ts
// pins each of those cases.

import {
  isInfrastructureFailureClass,
  isUnresolvedFailureClass,
} from "./product-evidence.mjs";

/**
 * Bumped when the MEANING of a count or an acceptance rule changes. A bump
 * starts a fresh cohort; it never rewrites a recorded one.
 */
export const QUALIFICATION_POLICY_VERSION = "mission-success/v1";

/**
 * Terminal delivery outcomes. Exactly one applies to each occurrence.
 *
 * `measurementInvalid` and `unresolved` are deliberately NOT failures and NOT
 * successes: counting them as failures would let a broken harness be "repaired"
 * by deleting rows, and counting them as successes is the false green. They
 * block the pass instead, which is the only reading that cannot be gamed in
 * either direction.
 */
export const QUALIFICATION_OUTCOMES = Object.freeze({
  DELIVERED: "delivered",
  NOT_DELIVERED: "not_delivered",
  NOT_LAUNCHED: "not_launched",
  MEASUREMENT_INVALID: "measurement_invalid",
  UNRESOLVED: "unresolved",
});

// ---------------------------------------------------------------------------
// Exact binomial arithmetic.
// ---------------------------------------------------------------------------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z) {
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i += 1) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n, k) {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/**
 * P(at most `failures` failures) for `trials` independent trials at success
 * probability `p`. The same tail the checked `fail_tail` in
 * docs/eval/reliability-progress-2026-09-06/analyze.py sums, in log space so
 * n = 1002 and n = 2995 stay stable.
 */
export function failureTail(trials, failures, p) {
  if (!(p > 0)) return failures >= trials ? 1 : 0;
  if (p >= 1) return 1;
  let total = 0;
  const logQ = Math.log1p(-p);
  const logP = Math.log(p);
  for (let k = 0; k <= failures; k += 1) {
    total += Math.exp(logChoose(trials, k) + k * logQ + (trials - k) * logP);
  }
  return total;
}

/**
 * One-sided Clopper-Pearson lower bound on the success probability.
 *
 * Returns null — never 0, and never an optimistic default — when the inputs
 * cannot support an estimate at all. A null bound can never satisfy the gate's
 * `>= 0.99`, so "no trials" reads as "not qualified", not as "nothing failed".
 */
export function lowerSuccessBound(trials, failures, alpha = 0.05) {
  if (!Number.isSafeInteger(trials) || !Number.isSafeInteger(failures)) return null;
  if (trials <= 0 || failures < 0 || failures > trials) return null;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 90; i += 1) {
    const mid = (lo + hi) / 2;
    if (failureTail(trials, failures, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// The deterministic predeclared cohort.
// ---------------------------------------------------------------------------

function seedHash(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatOccurrenceId(seed, workflow, ordinal) {
  return `${QUALIFICATION_POLICY_VERSION}:${seed}:${workflow}#${String(ordinal).padStart(3, "0")}`;
}

/**
 * Build the frozen occurrence list from (policy version, gate, seed, cells).
 *
 * Deterministic by construction: same inputs, same list, same order, on any
 * machine. That is what makes exact-identity resume possible and what lets the
 * evaluator detect a hand-edited declaration by simply recomputing it.
 *
 * The order is a seeded ROTATION, not a seeded shuffle: every consecutive block
 * of six occurrences contains all six workflows exactly once. A plain shuffle
 * would satisfy "interleaved" only in expectation and could still front-load one
 * cheap workflow; a rotation guarantees the mix at every prefix, so an
 * interrupted campaign is also balanced.
 */
export function buildQualificationCohort({ gate, cells, seed }) {
  if (!gate || gate.kind !== "predeclared-cohort") {
    throw new Error(
      `buildQualificationCohort requires a predeclared-cohort gate; got '${gate?.id ?? gate}'.`,
    );
  }
  const seedText = typeof seed === "string" ? seed.trim() : "";
  if (!seedText) {
    throw new Error("a qualification cohort requires an explicit predeclared seed.");
  }
  const workflowCells = Array.from(cells ?? []);
  if (workflowCells.length === 0) {
    throw new Error("a qualification cohort requires the workflow cells.");
  }
  if (workflowCells.length !== gate.workflows) {
    throw new Error(
      `gate ${gate.id} declares ${gate.workflows} workflows; got ${workflowCells.length}. ` +
      "The mix is frozen: qualify the declared population or declare a different one.",
    );
  }
  const rotations = gate.cohortSize / workflowCells.length;
  if (!Number.isSafeInteger(rotations) || rotations !== gate.occurrencesPerWorkflow) {
    throw new Error(
      `gate ${gate.id} cohort ${gate.cohortSize} does not divide evenly into ` +
      `${workflowCells.length} workflows at ${gate.occurrencesPerWorkflow} each.`,
    );
  }

  const random = mulberry32(seedHash(`${QUALIFICATION_POLICY_VERSION}:${gate.id}:${seedText}`));
  const occurrences = [];
  const ordinals = new Map(workflowCells.map((cell) => [cell.id, 0]));
  for (let rotation = 0; rotation < rotations; rotation += 1) {
    const order = workflowCells.slice();
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const cell of order) {
      const ordinal = ordinals.get(cell.id) + 1;
      ordinals.set(cell.id, ordinal);
      occurrences.push({
        occurrenceId: formatOccurrenceId(seedText, cell.id, ordinal),
        workflow: cell.id,
        project: cell.project,
        scenarioId: cell.scenarioId ?? null,
        ordinal,
        rotation: rotation + 1,
        sequence: occurrences.length + 1,
      });
    }
  }

  const workflowMix = {};
  for (const cell of workflowCells) workflowMix[cell.id] = ordinals.get(cell.id);

  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    gate: gate.id,
    seed: seedText,
    cohortSize: occurrences.length,
    maximumFailures: gate.maximumFailures,
    workflowMix,
    occurrences,
  };
}

/**
 * Stamp the build/model/artifact identity onto a cohort. Separate from
 * buildQualificationCohort because the artifact hashes are only knowable after
 * the candidate is built and installed, while the occurrence list must be
 * fixed before that.
 */
export function freezeQualificationDeclaration({
  cohort,
  model,
  headSha,
  artifactHashes,
  deadlineSecondsPerOccurrence,
  frozenAt = new Date().toISOString(),
}) {
  return {
    ...cohort,
    model,
    headSha,
    artifactHashes,
    deadlineSecondsPerOccurrence,
    frozenAt,
    confidenceLevel: 0.95,
  };
}

// ---------------------------------------------------------------------------
// Classification of one occurrence's terminal record.
// ---------------------------------------------------------------------------

function hasToolEventCoverage(events) {
  return Boolean(
    events &&
    typeof events === "object" &&
    events.source &&
    events.source !== "none" &&
    Number.isSafeInteger(events.observed) &&
    events.observed >= 0 &&
    Number.isSafeInteger(events.failed) &&
    events.failed >= 0,
  );
}

function verdict(outcome, reasons, contradictions = []) {
  return { outcome, reasons, contradictions };
}

/**
 * Classify one record. Every path to `delivered` requires POSITIVE proof of
 * every acceptance requirement; there is no default-success branch, and no
 * input shape reaches `delivered` by omission.
 */
export function classifyQualificationRecord(record, options = {}) {
  const { DELIVERED, NOT_DELIVERED, NOT_LAUNCHED, MEASUREMENT_INVALID, UNRESOLVED } =
    QUALIFICATION_OUTCOMES;
  if (!record || typeof record !== "object") {
    return verdict(MEASUREMENT_INVALID, ["no terminal record for this occurrence"]);
  }
  if (record.launched === false) {
    return verdict(NOT_LAUNCHED, ["predeclared occurrence was never dispatched"]);
  }
  if (record.launched !== true) {
    return verdict(MEASUREMENT_INVALID, ["launch state is unknown; it must be positively true"]);
  }

  const failureClass = String(record.failureClass ?? "");
  if (record.green !== true && record.green !== false) {
    return verdict(UNRESOLVED, ["started with no known terminal delivery outcome"]);
  }

  if (record.green === false) {
    if (isInfrastructureFailureClass(failureClass)) {
      return verdict(MEASUREMENT_INVALID, [
        `infrastructure failure '${failureClass}' measured nothing about the product`,
      ]);
    }
    if (isUnresolvedFailureClass(failureClass)) {
      return verdict(UNRESOLVED, ["failed with no resolved failure class"]);
    }
    return verdict(NOT_DELIVERED, [`did not deliver: ${failureClass}`]);
  }

  // green === true. Everything below is an affirmative proof requirement.
  if (!hasToolEventCoverage(record.toolEvents)) {
    return verdict(MEASUREMENT_INVALID, [
      "tool-event coverage is unknown; an unobserved delivery is not a proven delivery",
    ]);
  }

  const reasons = [];
  const contradictions = [];
  if (failureClass.startsWith("product:")) {
    contradictions.push(`recorded green while also carrying product failure '${failureClass}'`);
    reasons.push(`contradictory record: green with product failure '${failureClass}'`);
  }

  const acceptance = record.acceptance;
  if (!acceptance || typeof acceptance !== "object") {
    reasons.push("no mission acceptance record");
  } else {
    if (acceptance.acceptanceStatus !== "pass") {
      reasons.push(`acceptance status is '${acceptance.acceptanceStatus ?? "absent"}', not pass`);
    }
    if (acceptance.missionOutcome !== "accepted") {
      reasons.push(`mission outcome is '${acceptance.missionOutcome ?? "absent"}', not accepted`);
    }
    if (acceptance.scorecardAcceptancePassed !== true) {
      reasons.push("mission scorecard was not accepted");
    }
    if (!Number.isFinite(acceptance.scorecardTotal)) {
      reasons.push("mission scorecard total is unknown");
    }
    if (!(Number.isSafeInteger(acceptance.artifactProofCount) && acceptance.artifactProofCount >= 1)) {
      reasons.push("no artifact proof: an accepted mission with zero artifacts is not a delivery");
    }
  }

  const deadline = Number(options.deadlineSecondsPerOccurrence);
  if (Number.isFinite(deadline) && deadline > 0) {
    if (!Number.isFinite(Number(record.durationS))) {
      return verdict(MEASUREMENT_INVALID, [
        "duration is unknown, so deadline compliance cannot be proven",
      ], contradictions);
    }
    if (Number(record.durationS) > deadline) {
      reasons.push(`exceeded its declared ${deadline}s deadline (${record.durationS}s)`);
    }
  }

  if (record.budgetStopped === true) {
    reasons.push("stopped by a configured spending cap or an expired grant");
  }

  if (reasons.length > 0) return verdict(NOT_DELIVERED, reasons, contradictions);
  return verdict(DELIVERED, [], contradictions);
}

// ---------------------------------------------------------------------------
// Cohort evaluation.
// ---------------------------------------------------------------------------

function isHexSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value.trim().toLowerCase());
}

/**
 * Evaluate a campaign against its own frozen declaration.
 *
 * `cells` is required so the declaration can be RECOMPUTED from its own seed and
 * compared: that is what makes a hand-edited cohort (a changed denominator,
 * a reordered sequence, an added or dropped slot) detectable rather than
 * merely discouraged.
 */
export function evaluateQualificationCohort({ gate, cells, declaration, records }) {
  if (!gate || gate.kind !== "predeclared-cohort") {
    throw new Error(
      `evaluateQualificationCohort requires a predeclared-cohort gate; got '${gate?.id ?? gate}'. ` +
      "The recovery/acceptable90/target95 policies keep their own evaluator.",
    );
  }

  const failures = [];
  const contradictions = [];
  const safetyViolations = [];
  const outcomes = [];
  const decl = declaration && typeof declaration === "object" ? declaration : null;
  if (!decl) failures.push("no frozen qualification declaration was supplied");

  const declaredOccurrences = Array.isArray(decl?.occurrences) ? decl.occurrences : [];
  const declaredCount = declaredOccurrences.length;

  if (decl) {
    if (decl.policyVersion !== QUALIFICATION_POLICY_VERSION) {
      failures.push(
        `declaration is policy '${decl.policyVersion ?? "absent"}', not ${QUALIFICATION_POLICY_VERSION}`,
      );
    }
    if (decl.gate !== gate.id) {
      failures.push(`declaration pins gate '${decl.gate ?? "absent"}'; evaluating as '${gate.id}'`);
    }
    if (typeof decl.seed !== "string" || decl.seed.trim() === "") {
      failures.push("declaration has no predeclared seed; the cohort cannot be verified");
    }
    if (typeof decl.model !== "string" || decl.model.trim() === "") {
      failures.push("declaration has no frozen model identity");
    }
    if (!isHexSha(decl.headSha)) {
      failures.push("declaration has no frozen 40-character build (headSha) identity");
    }
    if (
      !decl.artifactHashes ||
      typeof decl.artifactHashes !== "object" ||
      Object.keys(decl.artifactHashes).length === 0
    ) {
      failures.push("declaration has no frozen installed artifact hashes");
    }
    if (declaredCount !== gate.cohortSize) {
      failures.push(
        `declared cohort size is ${declaredCount}; gate ${gate.id} fixes it at ${gate.cohortSize}`,
      );
    }
    // Recompute from the seed: a hand-edited cohort fails here.
    if (typeof decl.seed === "string" && decl.seed.trim() !== "") {
      try {
        const recomputed = buildQualificationCohort({ gate, cells, seed: decl.seed });
        const declaredIds = declaredOccurrences.map((entry) => entry?.occurrenceId);
        const expectedIds = recomputed.occurrences.map((entry) => entry.occurrenceId);
        if (declaredIds.length !== expectedIds.length ||
          declaredIds.some((id, index) => id !== expectedIds[index])) {
          failures.push(
            "declared cohort does not match the deterministic cohort for its own seed " +
            "(identities, order or size were changed after the freeze)",
          );
        }
        for (const [workflow, expected] of Object.entries(recomputed.workflowMix)) {
          if (decl.workflowMix?.[workflow] !== expected) {
            failures.push(
              `declared workflow mix for '${workflow}' is ${decl.workflowMix?.[workflow] ?? "absent"}; ` +
              `the frozen mix is ${expected}`,
            );
          }
        }
      } catch (error) {
        failures.push(`cohort could not be recomputed from its seed: ${String(error?.message ?? error)}`);
      }
    }
  }

  const recordList = Array.isArray(records) ? records : null;
  if (recordList === null) failures.push("no terminal records were supplied (not an array)");
  const allRecords = recordList ?? [];
  if (allRecords.length === 0) {
    failures.push("no terminal records: an unrun campaign proves nothing and cannot qualify");
  }

  const declaredById = new Map(
    declaredOccurrences
      .filter((entry) => entry && typeof entry.occurrenceId === "string")
      .map((entry) => [entry.occurrenceId, entry]),
  );

  const byId = new Map();
  const duplicated = new Set();
  const foreign = [];
  for (const record of allRecords) {
    const id = record && typeof record === "object" ? record.occurrenceId : null;
    if (typeof id !== "string" || id === "") {
      failures.push("a record carries no occurrence identity");
      continue;
    }
    if (!declaredById.has(id)) {
      foreign.push(id);
      continue;
    }
    if (byId.has(id)) duplicated.add(id);
    else byId.set(id, record);
  }
  if (duplicated.size > 0) {
    failures.push(
      `duplicate terminal records for ${duplicated.size} occurrence identity(ies) ` +
      `(${[...duplicated].slice(0, 3).join(", ")}${duplicated.size > 3 ? ", ..." : ""}); ` +
      "a failed occurrence must stay failed, never be replaced by a later green",
    );
  }
  if (foreign.length > 0) {
    failures.push(
      `${foreign.length} record(s) carry an occurrence identity that was not declared ` +
      `(foreign trial: ${foreign.slice(0, 3).join(", ")}); trials cannot be added after the freeze`,
    );
  }

  const missing = [];
  for (const occurrence of declaredOccurrences) {
    if (!byId.has(occurrence?.occurrenceId)) missing.push(occurrence?.occurrenceId);
  }
  const terminalRecords = declaredCount - missing.length;
  const incomplete = missing.length > 0 || declaredCount === 0;
  if (missing.length > 0) {
    failures.push(
      `campaign is incomplete: ${terminalRecords}/${declaredCount} declared occurrences have a ` +
      "terminal record; a partial campaign gets no partial credit",
    );
  }

  const counts = {
    declared: declaredCount,
    terminalRecords,
    delivered: 0,
    notDelivered: 0,
    notLaunched: 0,
    measurementInvalid: 0,
    unresolved: 0,
  };
  const perWorkflow = new Map(
    Object.keys(decl?.workflowMix ?? {}).map((workflow) => [
      workflow,
      { workflow, declared: decl.workflowMix[workflow], delivered: 0, recorded: 0 },
    ]),
  );

  for (const occurrence of declaredOccurrences) {
    const record = byId.get(occurrence?.occurrenceId);
    if (record) {
      if (decl?.model && record.model !== decl.model) {
        failures.push(
          `record ${occurrence.occurrenceId} was produced with model '${record.model ?? "absent"}', ` +
          `not the frozen model '${decl.model}'`,
        );
      }
      if (decl?.headSha && record.headSha !== decl.headSha) {
        failures.push(
          `record ${occurrence.occurrenceId} was produced at build '${record.headSha ?? "absent"}', ` +
          `not the frozen build '${decl.headSha}'`,
        );
      }
      if (record.workflow !== occurrence.workflow) {
        failures.push(
          `record ${occurrence.occurrenceId} reports workflow '${record.workflow ?? "absent"}' ` +
          `but that slot declares '${occurrence.workflow}'`,
        );
      }
      const violations = Array.isArray(record.safetyViolations) ? record.safetyViolations : [];
      for (const violation of violations) {
        safetyViolations.push({ occurrenceId: occurrence.occurrenceId, violation: String(violation) });
      }
      if (record.budgetStopped === true) {
        failures.push(
          `record ${occurrence.occurrenceId} reports the campaign was stopped by a spending cap or ` +
          "an expired grant; the cohort is incomplete and no cap increase may be inferred",
        );
      }
    }
    const classified = classifyQualificationRecord(record, {
      deadlineSecondsPerOccurrence: decl?.deadlineSecondsPerOccurrence,
    });
    outcomes.push({
      occurrenceId: occurrence?.occurrenceId ?? null,
      workflow: occurrence?.workflow ?? null,
      outcome: classified.outcome,
      reasons: classified.reasons,
    });
    for (const contradiction of classified.contradictions) {
      contradictions.push({ occurrenceId: occurrence?.occurrenceId ?? null, contradiction });
    }
    const bucket = perWorkflow.get(occurrence?.workflow);
    if (bucket && record) bucket.recorded += 1;
    switch (classified.outcome) {
      case QUALIFICATION_OUTCOMES.DELIVERED:
        counts.delivered += 1;
        if (bucket) bucket.delivered += 1;
        break;
      case QUALIFICATION_OUTCOMES.NOT_DELIVERED:
        counts.notDelivered += 1;
        break;
      case QUALIFICATION_OUTCOMES.NOT_LAUNCHED:
        counts.notLaunched += 1;
        break;
      case QUALIFICATION_OUTCOMES.UNRESOLVED:
        counts.unresolved += 1;
        break;
      default:
        counts.measurementInvalid += 1;
        break;
    }
  }

  // A missing record classifies as measurement_invalid above; subtract those so
  // the count reports instrument defects, not absent rows (already reported as
  // incompleteness).
  counts.measurementInvalid -= missing.length;

  if (contradictions.length > 0) {
    failures.push(
      `${contradictions.length} contradictory record(s): a run cannot be both green and a product ` +
      "failure, and the contradiction is never resolved in favour of the green",
    );
  }
  if (safetyViolations.length > 0) {
    failures.push(
      `${safetyViolations.length} safety violation(s) recorded; a safety finding blocks release ` +
      "regardless of the observed percentage",
    );
  }
  if (counts.measurementInvalid > 0) {
    failures.push(
      `${counts.measurementInvalid} occurrence(s) are measurement-invalid; a defective instrument ` +
      "cannot establish a pass and its rows must not be dropped to improve the rate",
    );
  }
  if (counts.unresolved > 0) {
    failures.push(
      `${counts.unresolved} occurrence(s) are unresolved; a started mission with no terminal event ` +
      "is never counted as successful",
    );
  }

  const observedFailures = declaredCount === 0 ? 0 : declaredCount - counts.delivered;
  if (declaredCount > 0 && observedFailures > gate.maximumFailures) {
    failures.push(
      `${observedFailures} of ${declaredCount} predeclared occurrences did not deliver; ` +
      `gate ${gate.id} allows at most ${gate.maximumFailures}`,
    );
  }

  const observedSuccessRate = declaredCount === 0 ? null : counts.delivered / declaredCount;
  const lowerBound = lowerSuccessBound(declaredCount, observedFailures);
  if (observedSuccessRate !== null && observedSuccessRate < gate.requiredObservedSuccessRate) {
    failures.push(
      `observed success ${(observedSuccessRate * 100).toFixed(3)}% is below the required ` +
      `${(gate.requiredObservedSuccessRate * 100).toFixed(3)}%`,
    );
  }
  if (lowerBound === null || lowerBound < gate.requiredLowerBound) {
    failures.push(
      `one-sided 95% lower bound ${lowerBound === null ? "is unavailable" : `${(lowerBound * 100).toFixed(3)}%`} ` +
      `is below the required ${(gate.requiredLowerBound * 100).toFixed(3)}%`,
    );
  }

  const positiveProof = Boolean(
    declaredCount > 0 &&
    declaredCount === gate.cohortSize &&
    terminalRecords === declaredCount &&
    counts.delivered > 0 &&
    counts.measurementInvalid === 0 &&
    counts.unresolved === 0 &&
    contradictions.length === 0 &&
    safetyViolations.length === 0 &&
    observedFailures <= gate.maximumFailures &&
    observedSuccessRate !== null &&
    observedSuccessRate >= gate.requiredObservedSuccessRate &&
    lowerBound !== null &&
    lowerBound >= gate.requiredLowerBound,
  );

  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    gate: gate.id,
    seed: decl?.seed ?? null,
    model: decl?.model ?? null,
    headSha: decl?.headSha ?? null,
    artifactHashes: decl?.artifactHashes ?? null,
    // `passed` is a CONJUNCTION: no failures AND affirmative proof. Either half
    // alone has produced a false green in this repository before.
    passed: failures.length === 0 && positiveProof,
    positiveProof,
    incomplete,
    failures,
    denominator: declaredCount,
    counts,
    observedSuccessRate,
    lowerBound,
    confidenceLevel: 0.95,
    confidenceMethod: "exact binomial (Clopper-Pearson), one-sided",
    contradictions,
    safetyViolations,
    missingOccurrences: missing,
    foreignRecords: foreign,
    duplicateOccurrences: [...duplicated],
    perWorkflow: [...perWorkflow.values()],
    outcomes,
  };
}

// ---------------------------------------------------------------------------
// Bridge to the proof-matrix manifest.
// ---------------------------------------------------------------------------

/**
 * True when this occurrence already has a PRODUCT-MEASURING attempt.
 *
 * `measuresProduct` is the repository's one shared predicate for that question,
 * and reusing it is what keeps three facts from disagreeing: an infrastructure
 * death spends no attempt budget, does not reset a streak, and here does not
 * close an occurrence either. Its record is retained and the SAME identity is
 * re-run — that is a repeated measurement of one predeclared mission slot, not
 * a replacement sample. Once a real red lands, the occurrence is closed and the
 * runner will never launch it again, so a failure can never be retried into a
 * green.
 */
export function occurrenceHasTerminalRecord(manifest, occurrenceId, measuresProduct) {
  return Array.from(manifest?.attempts ?? []).some(
    (attempt) => attempt?.occurrenceId === occurrenceId && measuresProduct(attempt),
  );
}

/**
 * Project proof-matrix attempt records onto qualification records.
 *
 * Only product-measuring attempts become terminal records. Retained
 * infrastructure attempts for the same identity are counted as
 * `measurementRetries` so the disclosure states how much re-running the
 * instrument needed, rather than hiding it.
 */
export function deriveQualificationRecords(manifest, declaration) {
  const attempts = Array.from(manifest?.attempts ?? []).filter(
    (attempt) => typeof attempt?.occurrenceId === "string",
  );
  const declaredById = new Map(
    (declaration?.occurrences ?? []).map((entry) => [entry.occurrenceId, entry]),
  );
  const records = [];
  const measurementRetries = {};
  for (const attempt of attempts) {
    const occurrence = declaredById.get(attempt.occurrenceId);
    if (!occurrence) {
      records.push({ ...attempt, workflow: attempt.workflow ?? null });
      continue;
    }
    if (isInfrastructureFailureClass(attempt.failureClass) && !attempt.green) {
      measurementRetries[attempt.occurrenceId] =
        (measurementRetries[attempt.occurrenceId] ?? 0) + 1;
      continue;
    }
    records.push({
      occurrenceId: attempt.occurrenceId,
      workflow: occurrence.workflow,
      model: attempt.model ?? manifest?.model ?? null,
      headSha: attempt.headSha ?? manifest?.expectedHead ?? null,
      launched: attempt.launched !== false,
      green: attempt.green,
      failureClass: attempt.failureClass,
      durationS: attempt.durationS ?? null,
      budgetStopped: attempt.budgetStopped === true,
      safetyViolations: Array.isArray(attempt.safetyViolations) ? attempt.safetyViolations : [],
      toolEvents: attempt.toolEvents ?? null,
      acceptance: attempt.acceptance ?? null,
    });
  }
  return { records, measurementRetries };
}
