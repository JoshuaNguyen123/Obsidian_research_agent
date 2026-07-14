import test from "node:test";
import assert from "node:assert/strict";
import { decideAutoContinuation } from "../src/agent/autoContinuation";
import { computeProofDebt } from "../src/agent/proofDebt";
import { reflectMissionCompletion } from "../src/agent/completionReflection";

test("auto continuation recommends only an unfinished productive budget outcome", () => {
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        reasons: ["required_evidence_or_tool_missing"],
      },
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});

test("auto continuation stops on blockers, unresolved tool failures, failed acceptance, and proof", () => {
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "needs_more_work", reasons: [] },
      blockerCategory: "model",
      blockerCount: 1,
      missionPlanStatus: "blocked",
    }),
    { recommended: false, reason: "blocked" },
  );
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        reasons: ["failed_tools=web_fetch"],
      },
    }),
    { recommended: false, reason: "required_tool_failure" },
  );
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "fail", reasons: [] },
    }),
    { recommended: false, reason: "acceptance_failed" },
  );
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "pass", reasons: [] },
    }),
    { recommended: false, reason: "proof_satisfied" },
  );
  assert.deepEqual(
    decideAutoContinuation({ stopReason: "final" }),
    { recommended: false, reason: "not_budget" },
  );
});

test("auto continuation refuses when recomputed proof debt is empty or blocked", () => {
  const acceptedDebt = computeProofDebt({
    acceptance: { status: "pass", missing: [] },
    status: "complete",
  });
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "needs_more_work", reasons: [] },
      proofDebt: acceptedDebt,
    }),
    { recommended: false, reason: "proof_satisfied" },
  );

  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        reasons: [],
        missing: ["web_evidence"],
        nextAction: "keep going forever",
      },
      proofDebtSnapshot: {
        acceptance: { status: "pass", missing: [] },
        storedNextAction: "keep going forever",
      },
    }),
    { recommended: false, reason: "proof_satisfied" },
  );

  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "needs_more_work", reasons: [] },
      proofDebtSnapshot: {
        pendingApprovals: true,
        acceptance: { status: "needs_more_work", missing: ["web_evidence"] },
      },
    }),
    { recommended: false, reason: "blocked" },
  );
});

test("completion-driven auto continuation continues unpaid debt within segment budget", () => {
  const unpaidDebt = computeProofDebt({
    status: "budget",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
  });
  const reflection = reflectMissionCompletion({
    prompt: "Deep long research",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
    proofDebt: unpaidDebt,
    writeReceiptCount: 0,
  });
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        missing: ["web_evidence", "fetched_sources"],
      },
      proofDebt: unpaidDebt,
      completionDriven: true,
      reflection,
      segmentsUsed: 2,
      maxSegments: 24,
    }),
    { recommended: true, reason: "budget_exhausted" },
  );

  const doneDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const doneReflection = reflectMissionCompletion({
    prompt: "Deep long research",
    acceptance: { status: "pass", missing: [] },
    proofDebt: doneDebt,
    writeReceiptCount: 1,
  });
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "pass", missing: [] },
      proofDebt: doneDebt,
      completionDriven: true,
      reflection: doneReflection,
      segmentsUsed: 3,
      maxSegments: 24,
    }),
    { recommended: false, reason: "proof_satisfied" },
  );

  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        missing: ["web_evidence"],
      },
      proofDebt: unpaidDebt,
      completionDriven: true,
      reflection,
      segmentsUsed: 24,
      maxSegments: 24,
    }),
    { recommended: false, reason: "segment_cap" },
  );
});

test("completion-driven budget stop continues a recoverable incomplete final output", () => {
  const acceptance = {
    status: "fail",
    missing: ["final_output", "tool:web_search"],
    reasons: ["concrete_required_output_missing"],
  };
  const debt = computeProofDebt({ status: "budget", acceptance });
  const reflection = reflectMissionCompletion({
    prompt: "Continue bounded overnight research.",
    acceptance,
    proofDebt: debt,
    writeReceiptCount: 1,
  });

  assert.equal(debt.empty, false);
  assert.equal(debt.blocked, false);
  assert.equal(reflection.done, false);
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance,
      proofDebt: debt,
      completionDriven: true,
      reflection,
      segmentsUsed: 1,
      maxSegments: 2,
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});

test("completion-driven budget stop still refuses non-recoverable acceptance failures", () => {
  for (const acceptance of [
    {
      status: "fail",
      missing: ["failed_goal:delete_path"],
      reasons: ["concrete_required_output_missing"],
    },
    {
      status: "fail",
      missing: ["final_output"],
      reasons: ["broad_unscoped_mutation_blocker_missing"],
    },
    {
      status: "fail",
      missing: ["verifier:write_safety:Notes/risky.md"],
      reasons: ["verifier_checks_incomplete"],
    },
  ]) {
    const debt = computeProofDebt({ status: "budget", acceptance });
    assert.deepEqual(
      decideAutoContinuation({
        stopReason: "budget",
        acceptance,
        proofDebt: debt,
        completionDriven: true,
        reflection: {
          done: false,
          confidence: 0.2,
          reason: "acceptance_fail",
          remainingActions: [...acceptance.missing],
        },
        segmentsUsed: 1,
        maxSegments: 2,
      }),
      { recommended: false, reason: "acceptance_failed" },
    );
  }
});
