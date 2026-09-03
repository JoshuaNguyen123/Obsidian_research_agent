import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAutoContinuationSuppressionReason,
  suppressedBudgetContinuationDecisionV1,
} from "../src/agent/autoContinuation";
import {
  continuationDecisionFromCompleteEvent,
  continuationSuppressionSentence,
  continuationSuppressionSentenceFromCompleteEvent,
} from "../src/ui/continuationSuppressionCopy";

test("recommended continues hide the suppression sentence", () => {
  assert.equal(
    continuationSuppressionSentence({
      recommended: true,
      reason: "budget_exhausted",
      suppressionReason: "Continue is off because a blocker is still open.",
    }),
    null,
  );
  assert.equal(continuationSuppressionSentence({ recommended: true }), null);
  assert.equal(continuationSuppressionSentence(null), null);
  assert.equal(continuationSuppressionSentence(undefined), null);
});

test("refused continue prefers the explicit suppressionReason", () => {
  const sentence = "Continue is off: compound research closure is spent.";
  assert.equal(
    continuationSuppressionSentence({
      recommended: false,
      reason: "blocked",
      suppressionReason: sentence,
    }),
    sentence,
  );
});

test("refused continue without a sentence returns null", () => {
  assert.equal(continuationSuppressionSentence({ recommended: false }), null);
  assert.equal(
    continuationSuppressionSentence({
      recommended: false,
      reason: "proof_satisfied",
    }),
    null,
  );
  assert.equal(
    continuationSuppressionSentence({
      recommended: false,
      suppressionReason: "   ",
    }),
    null,
  );
});

test("complete-event view type reads nested autoContinuation first", () => {
  const decision = continuationDecisionFromCompleteEvent({
    stopReason: "budget",
    autoContinueRecommended: true,
    autoContinueReason: "budget_exhausted",
    autoContinuation: {
      recommended: false,
      reason: "blocked",
      suppressionReason: "Continue is off because a blocker is still open.",
    },
  });
  assert.deepEqual(decision, {
    recommended: false,
    reason: "blocked",
    suppressionReason: "Continue is off because a blocker is still open.",
  });
  assert.equal(
    continuationSuppressionSentence(decision),
    "Continue is off because a blocker is still open.",
  );
});

test("budget refusal without suppressionReason uses the format helper", () => {
  assert.equal(
    continuationSuppressionSentenceFromCompleteEvent({
      stopReason: "budget",
      autoContinueRecommended: false,
      autoContinueReason: "segment_cap",
    }),
    "Continue is off because the configured segment cap is spent.",
  );
  assert.equal(
    continuationSuppressionSentenceFromCompleteEvent({
      stopReason: "budget",
      autoContinueRecommended: false,
      autoContinueReason: "proof_satisfied",
    }),
    formatAutoContinuationSuppressionReason("proof_satisfied"),
  );
});

test("non-budget stops do not invent a Continue-is-off sentence", () => {
  assert.equal(
    continuationSuppressionSentenceFromCompleteEvent({
      stopReason: "final",
      autoContinueRecommended: false,
      autoContinueReason: "not_budget",
    }),
    null,
  );
  assert.equal(
    continuationSuppressionSentenceFromCompleteEvent({
      stopReason: "error",
      autoContinueRecommended: false,
      autoContinueReason: "not_budget",
    }),
    null,
  );
  assert.equal(
    continuationSuppressionSentenceFromCompleteEvent({
      autoContinueRecommended: true,
      autoContinueReason: "budget_exhausted",
    }),
    null,
  );
});

test("WS-3 suppressed budget decision renders its official sentence", () => {
  const decision = suppressedBudgetContinuationDecisionV1({
    stopReason: "budget",
    suppressAutoContinuation: true,
    reason:
      "compound_research_closure_exhausted after 1 reserved publication turn(s)",
  });
  assert.ok(decision);
  assert.equal(
    continuationSuppressionSentence(decision),
    "Continue is off: compound_research_closure_exhausted after 1 reserved publication turn(s)",
  );
});
