import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAutoContinuationSuppressionReason,
  decideAutoContinuation,
  formatAutoContinuationSuppressionReason,
  suppressedBudgetContinuationDecisionV1,
  type AutoContinuationReason,
} from "../src/agent/autoContinuation";

const REASONS: AutoContinuationReason[] = [
  "not_budget",
  "budget_exhausted",
  "proof_satisfied",
  "blocked",
  "acceptance_failed",
  "required_tool_failure",
  "segment_cap",
  "effect_class_blocked",
  "no_progress",
];

test("every auto-continuation reason has user-readable suppression copy", () => {
  for (const reason of REASONS) {
    const copy = formatAutoContinuationSuppressionReason(reason);
    assert.equal(typeof copy, "string");
    assert.ok(copy.length > 8, reason);
    if (reason !== "budget_exhausted") {
      assert.match(copy, /Continue is off/i);
    }
  }
});

test("attachSuppressionReason leaves recommended continues and non-budget stops unchanged", () => {
  const recommended = decideAutoContinuation({
    stopReason: "budget",
    acceptance: {
      status: "needs_more_work",
      reasons: ["required_evidence_or_tool_missing"],
    },
  });
  assert.deepEqual(recommended, { recommended: true, reason: "budget_exhausted" });
  assert.deepEqual(
    attachAutoContinuationSuppressionReason(recommended, "budget"),
    recommended,
  );

  const notBudget = decideAutoContinuation({ stopReason: "final" });
  assert.deepEqual(notBudget, { recommended: false, reason: "not_budget" });
  assert.deepEqual(
    attachAutoContinuationSuppressionReason(notBudget, "final"),
    notBudget,
  );
});

test("a budget stop that refuses Continue exposes a user-readable suppression reason", () => {
  const refused = decideAutoContinuation({
    stopReason: "budget",
    acceptance: { status: "needs_more_work", reasons: [] },
    blockerCategory: "safety_policy",
    blockerCount: 1,
  });
  assert.deepEqual(refused, { recommended: false, reason: "blocked" });

  const withWhy = attachAutoContinuationSuppressionReason(refused, "budget");
  assert.equal(withWhy.recommended, false);
  assert.equal(withWhy.reason, "blocked");
  assert.equal(
    withWhy.suppressionReason,
    "Continue is off because a blocker is still open.",
  );
});

test("suppressed budget terminals mint a first-class Continue-is-off decision", () => {
  const decision = suppressedBudgetContinuationDecisionV1({
    stopReason: "budget",
    suppressAutoContinuation: true,
    reason: "compound_research_closure_exhausted after 1 reserved publication turn(s)",
  });
  assert.ok(decision);
  assert.equal(decision.recommended, false);
  assert.equal(decision.reason, "blocked");
  assert.match(decision.suppressionReason ?? "", /Continue is off/i);
  assert.match(
    decision.suppressionReason ?? "",
    /compound_research_closure_exhausted/,
  );

  assert.equal(
    suppressedBudgetContinuationDecisionV1({
      stopReason: "budget",
      suppressAutoContinuation: false,
      reason: "anything",
    }),
    null,
  );
  assert.equal(
    suppressedBudgetContinuationDecisionV1({
      stopReason: "final",
      suppressAutoContinuation: true,
      reason: "anything",
    }),
    null,
  );
});
