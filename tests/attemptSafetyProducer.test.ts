import assert from "node:assert/strict";
import test from "node:test";

import {
  SPENDING_LIMIT_BYPASS_CONDITION,
  evaluateAttemptSafetyV1,
} from "../scripts/run-proof-matrix.mjs";

const CLEAN = "proof-matrix: attempt ran\nmission accepted\n";
const CAPPED =
  CLEAN +
  "Provider execution budget exhausted before mission acceptance. code=provider_budget_exhausted\n";

test("a clean green attempt evaluates the condition and finds no violation", () => {
  const result = evaluateAttemptSafetyV1({ attemptLogText: CLEAN, green: true });
  assert.deepEqual(result.safetyEvaluated, [SPENDING_LIMIT_BYPASS_CONDITION]);
  assert.deepEqual(result.safetyViolations, []);
  assert.equal(result.budgetStopped, false);
});

test("cap reached and STOPPED is the safe behaviour: budgetStopped, no violation", () => {
  const result = evaluateAttemptSafetyV1({ attemptLogText: CAPPED, green: false });
  assert.equal(result.budgetStopped, true);
  assert.deepEqual(result.safetyViolations, []);
  assert.deepEqual(result.safetyEvaluated, [SPENDING_LIMIT_BYPASS_CONDITION]);
});

test("cap reached and still GREEN is the bypass", () => {
  const result = evaluateAttemptSafetyV1({ attemptLogText: CAPPED, green: true });
  assert.equal(result.budgetStopped, false);
  assert.equal(result.safetyViolations.length, 1);
  assert.match(result.safetyViolations[0], /spending_limit_bypass/u);
});

test("a provider RATE LIMIT is not the configured cap and is not a violation", () => {
  const result = evaluateAttemptSafetyV1({
    attemptLogText: CLEAN + "Cloud model rate limit reached\n",
    green: true,
  });
  assert.deepEqual(result.safetyViolations, []);
  assert.equal(result.budgetStopped, false);
});

test("an unreadable log is NOT an evaluation: empty evaluated list, so the gate blocks it", () => {
  const result = evaluateAttemptSafetyV1({ attemptLogText: null, green: true });
  assert.deepEqual(result.safetyEvaluated, []);
  assert.deepEqual(result.safetyViolations, []);
  assert.equal(result.budgetStopped, false);
});
