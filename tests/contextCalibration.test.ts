import assert from "node:assert/strict";
import test from "node:test";
import {
  CALIBRATION_SMOOTHING,
  MAX_CHARS_PER_TOKEN,
  MIN_CHARS_PER_TOKEN,
  MIN_SAMPLES_FOR_CALIBRATION,
  calibratedMaxPromptChars,
  createContextCalibration,
  formatContextCalibrationForRunDetails,
  observeModelCall,
  observeModelCallEvidence,
} from "../src/agent/contextCalibration";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  createRunContextBudget,
} from "../src/agent/runContext";

const BUDGET = createRunContextBudget(49_152);

function observeMany(
  ratio: number,
  count: number,
  promptTokens = 1_000,
) {
  let state = createContextCalibration();
  for (let index = 0; index < count; index += 1) {
    state = observeModelCall(state, {
      promptChars: promptTokens * ratio,
      promptTokens,
      tokenUsageReported: true,
    });
  }
  return state;
}

test("starts at the documented 4.0 assumption and is not calibrated", () => {
  const state = createContextCalibration();
  assert.equal(state.charsPerToken, CHARS_PER_TOKEN_ESTIMATE);
  assert.equal(state.samples, 0);
  assert.equal(state.calibrated, false);
});

test("a provider that never reports usage preserves today's behavior exactly", () => {
  let state = createContextCalibration();
  for (let index = 0; index < 10; index += 1) {
    state = observeModelCall(state, {
      promptChars: 40_000,
      promptTokens: 0,
      tokenUsageReported: false,
    });
  }

  assert.equal(state.samples, 0);
  assert.equal(state.calibrated, false);
  assert.equal(state.charsPerToken, CHARS_PER_TOKEN_ESTIMATE);

  const resolved = calibratedMaxPromptChars(BUDGET, state);
  assert.equal(resolved.maxPromptChars, BUDGET.maxPromptChars);
  assert.equal(resolved.source, "assumed_ratio");
  assert.equal(resolved.deltaChars, 0);
});

test("the budget is untouched until the minimum sample count is reached", () => {
  const belowThreshold = observeMany(2.5, MIN_SAMPLES_FOR_CALIBRATION - 1);
  assert.equal(belowThreshold.calibrated, false);
  assert.equal(
    calibratedMaxPromptChars(BUDGET, belowThreshold).maxPromptChars,
    BUDGET.maxPromptChars,
  );

  const atThreshold = observeMany(2.5, MIN_SAMPLES_FOR_CALIBRATION);
  assert.equal(atThreshold.calibrated, true);
});

test("a JSON-heavy run converges toward its real ratio and tightens the ceiling", () => {
  const state = observeMany(2.5, 8);

  assert.ok(
    Math.abs(state.charsPerToken - 2.5) < 0.05,
    `expected convergence near 2.5, got ${state.charsPerToken}`,
  );

  const resolved = calibratedMaxPromptChars(BUDGET, state);
  assert.equal(resolved.source, "calibrated_ratio");
  // The whole point of G1: a tool-payload-heavy run must compact EARLIER than
  // the 4.0 assumption allows, not later.
  assert.ok(
    resolved.maxPromptChars < BUDGET.maxPromptChars,
    "a sub-4.0 measured ratio must lower the character ceiling",
  );
  assert.ok(resolved.deltaChars < 0);
});

test("a prose-heavy run widens the ceiling instead of compacting early", () => {
  const state = observeMany(5.5, 8);
  const resolved = calibratedMaxPromptChars(BUDGET, state);

  assert.ok(resolved.maxPromptChars > BUDGET.maxPromptChars);
  assert.ok(resolved.deltaChars > 0);
});

test("the first accepted sample seeds the average rather than smoothing against 4.0", () => {
  const seeded = observeMany(2.5, 1);
  // Smoothing sample one against the placeholder would land at
  // 4 + 0.3 * (2.5 - 4) = 3.55 and bias every later reading upward.
  assert.equal(seeded.charsPerToken, 2.5);
  assert.notEqual(
    seeded.charsPerToken,
    CHARS_PER_TOKEN_ESTIMATE +
      CALIBRATION_SMOOTHING * (2.5 - CHARS_PER_TOKEN_ESTIMATE),
  );
});

test("out-of-band ratios are dropped rather than smoothed into the budget", () => {
  const seeded = observeMany(3, 4);

  // 0.5 chars/token and 40 chars/token are both impossible for text; they mean
  // the char count and the token count describe different payloads.
  const afterTooDense = observeModelCall(seeded, {
    promptChars: 500,
    promptTokens: 1_000,
    tokenUsageReported: true,
  });
  const afterTooSparse = observeModelCall(seeded, {
    promptChars: 40_000,
    promptTokens: 1_000,
    tokenUsageReported: true,
  });

  assert.deepEqual(afterTooDense, seeded);
  assert.deepEqual(afterTooSparse, seeded);
});

test("degenerate and non-finite samples never corrupt the state", () => {
  const seeded = observeMany(3, 4);

  for (const sample of [
    { promptChars: 0, promptTokens: 100 },
    { promptChars: 100, promptTokens: 0 },
    { promptChars: -100, promptTokens: 100 },
    { promptChars: Number.NaN, promptTokens: 100 },
    { promptChars: Number.POSITIVE_INFINITY, promptTokens: 100 },
  ]) {
    assert.deepEqual(
      observeModelCall(seeded, { ...sample, tokenUsageReported: true }),
      seeded,
      `sample ${JSON.stringify(sample)} should have been rejected`,
    );
  }
});

test("the smoothed ratio always stays inside the observed band", () => {
  for (const ratio of [MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN]) {
    const state = observeMany(ratio, 12);
    assert.ok(state.charsPerToken >= MIN_CHARS_PER_TOKEN);
    assert.ok(state.charsPerToken <= MAX_CHARS_PER_TOKEN);
  }
});

test("failed calls contribute no sample", () => {
  const state = createContextCalibration();
  const afterError = observeModelCallEvidence(
    state,
    { promptTokens: 1_000, tokenUsageReported: true, outcome: "error" },
    2_500,
  );
  const afterExhausted = observeModelCallEvidence(
    state,
    {
      promptTokens: 1_000,
      tokenUsageReported: true,
      outcome: "budget_exhausted",
    },
    2_500,
  );

  assert.deepEqual(afterError, state);
  assert.deepEqual(afterExhausted, state);

  const afterSuccess = observeModelCallEvidence(
    state,
    { promptTokens: 1_000, tokenUsageReported: true, outcome: "success" },
    2_500,
  );
  assert.equal(afterSuccess.samples, 1);
  assert.equal(afterSuccess.charsPerToken, 2.5);
});

test("the Run Details projection reports state without leaking prompt content", () => {
  const pending = formatContextCalibrationForRunDetails(
    createContextCalibration(),
    BUDGET,
  );
  assert.match(pending, /context_calibration=pending/);
  assert.match(pending, /chars_per_token=4\.00 \(assumed\)/);

  const active = formatContextCalibrationForRunDetails(
    observeMany(2.5, 8),
    BUDGET,
  );
  assert.match(active, /context_calibration=active/);
  assert.match(active, /tightened/);
});
