import test from "node:test";
import assert from "node:assert/strict";
import {
  decideAutoContinuation,
  resolvePendingToolsForAutoContinuation,
} from "../src/agent/autoContinuation";
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

test("set-loose compound budget continues past stale narrative blockerCategory", () => {
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        reasons: ["set_loose_delivery_unpaid=github_private_repo_or_pr_url"],
        missing: ["set_loose_delivery:github_private_repo_or_pr_url"],
      },
      blockerCategory: "safety_policy",
      blockerCount: 1,
      compoundLifecycleDetected: true,
      completionDriven: true,
      reflection: {
        done: false,
        confidence: 0,
        reason: "note_reflection_unpaid",
        remainingActions: ["append_to_current_file"],
      },
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});

test("set-loose unpaid delivery continues past failed_tools=workspace_exists noise", () => {
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: {
        status: "needs_more_work",
        reasons: ["failed_tools=code_workspace_create"],
        missing: ["set_loose_delivery:private_github_publication"],
      },
      blockerCategory: "safety_policy",
      blockerCount: 1,
      compoundLifecycleDetected: true,
      completionDriven: true,
      reflection: {
        done: false,
        confidence: 0,
        reason: "github_unpaid",
        remainingActions: ["github_create_private_repository"],
      },
      pendingToolNames: [
        "github_create_private_repository",
        "publish_verified_code_to_github",
      ],
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
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

test("completion-driven continue when acceptance still owes despite empty debt", () => {
  const staleEmptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  assert.equal(staleEmptyDebt.empty, true);

  const acceptance = {
    status: "needs_more_work",
    missing: ["web_evidence", "fetched_sources"],
    reasons: ["required_evidence_or_tool_missing"],
  };
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance,
      proofDebt: staleEmptyDebt,
      completionDriven: true,
      reflection: {
        done: true,
        confidence: 0.9,
        reason: "stale_empty_debt",
        remainingActions: [],
      },
      segmentsUsed: 1,
      maxSegments: 8,
    }),
    { recommended: true, reason: "budget_exhausted" },
  );

  // Non-completion path still lets empty debt override narrative acceptance.
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance,
      proofDebt: staleEmptyDebt,
      completionDriven: false,
    }),
    { recommended: false, reason: "proof_satisfied" },
  );
});

test("completion-driven null debt stops when acceptance already passed", () => {
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance: { status: "pass", missing: [] },
      completionDriven: true,
      reflection: {
        done: true,
        confidence: 1,
        reason: "done",
        remainingActions: [],
      },
      segmentsUsed: 1,
      maxSegments: 8,
    }),
    { recommended: false, reason: "proof_satisfied" },
  );
});

test("resolvePendingToolsForAutoContinuation prefers Bound required writes", () => {
  assert.deepEqual(
    resolvePendingToolsForAutoContinuation({
      debtPendingToolNames: ["append_to_current_file"],
      pendingRequiredWrites: ["replace_current_file"],
    }),
    ["replace_current_file"],
  );
  assert.deepEqual(
    resolvePendingToolsForAutoContinuation({
      debtPendingToolNames: ["web_search"],
      pendingRequiredWrites: ["append_to_current_file"],
    }),
    ["web_search"],
  );
  assert.deepEqual(
    resolvePendingToolsForAutoContinuation({
      debtPendingToolNames: ["web_fetch"],
      pendingRequiredWrites: [],
    }),
    ["web_fetch"],
  );
});

test("Bound pending tool without grant is effect_class_blocked", () => {
  const acceptance = {
    status: "needs_more_work" as const,
    missing: ["tool:replace_current_file"],
  };
  const debt = computeProofDebt({ status: "budget", acceptance });
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance,
      proofDebt: debt,
      completionDriven: true,
      reflection: {
        done: false,
        confidence: 0.4,
        reason: "bound_write_pending",
        remainingActions: ["replace_current_file"],
      },
      segmentsUsed: 1,
      maxSegments: 8,
      pendingToolNames: ["replace_current_file"],
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
    }),
    { recommended: false, reason: "effect_class_blocked" },
  );
});

test("Bound pending tool with matching grant continues under automatic", () => {
  const acceptance = {
    status: "needs_more_work" as const,
    missing: ["tool:replace_current_file"],
  };
  const debt = computeProofDebt({ status: "budget", acceptance });
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance,
      proofDebt: debt,
      completionDriven: true,
      reflection: {
        done: false,
        confidence: 0.4,
        reason: "bound_write_pending",
        remainingActions: ["replace_current_file"],
      },
      segmentsUsed: 1,
      maxSegments: 8,
      pendingToolNames: ["replace_current_file"],
      autonomyProfile: "automatic",
      hasMatchingGrant: true,
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});

test("Soft pending tool continues without grant under automatic", () => {
  const acceptance = {
    status: "needs_more_work" as const,
    missing: ["web_evidence", "fetched_sources"],
  };
  const debt = computeProofDebt({ status: "budget", acceptance });
  assert.deepEqual(
    decideAutoContinuation({
      stopReason: "budget",
      acceptance,
      proofDebt: debt,
      completionDriven: true,
      reflection: {
        done: false,
        confidence: 0.4,
        reason: "soft_research_pending",
        remainingActions: ["web_search"],
      },
      segmentsUsed: 1,
      maxSegments: 8,
      pendingToolNames: ["web_search"],
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
    }),
    { recommended: true, reason: "budget_exhausted" },
  );
});
