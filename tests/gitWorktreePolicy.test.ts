import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrchestratorBranchName,
  evaluateWorktreePromotion,
  isPathInsideRoot,
} from "../src/orchestrator/gitWorktreePolicy";

const GREEN = {
  baseWasClean: true,
  baseIsClean: true,
  baseBranch: "main",
  currentBranch: "main",
  baseSha: "abc1234",
  currentSha: "abc1234",
  validationPassed: true,
  integrationConflict: false,
  approvalGranted: true,
  proofBlocked: false,
};

test("green unchanged checkout permits guarded promotion", () => {
  assert.deepEqual(evaluateWorktreePromotion(GREEN), { allow: true });
});

test("dirty changed conflicted or unapproved checkout blocks promotion", () => {
  const cases: Array<[keyof typeof GREEN, unknown, string]> = [
    ["baseWasClean", false, "base_checkout_was_dirty"],
    ["baseIsClean", false, "base_checkout_became_dirty"],
    ["currentBranch", "feature", "base_branch_changed"],
    ["currentSha", "def5678", "base_head_changed"],
    ["integrationConflict", true, "integration_conflict"],
    ["validationPassed", false, "integration_validation_failed"],
    ["approvalGranted", false, "orchestrator_approval_required"],
    ["proofBlocked", true, "orchestrator_proof_blocked"],
  ];
  for (const [key, value, blocker] of cases) {
    const decision = evaluateWorktreePromotion({ ...GREEN, [key]: value });
    assert.equal(decision.allow, false);
    assert.equal(decision.blocker, blocker);
  }
});

test("detached HEAD never qualifies for automatic promotion", () => {
  assert.deepEqual(
    evaluateWorktreePromotion({
      ...GREEN,
      baseBranch: "HEAD",
      currentBranch: "HEAD",
    }),
    { allow: false, blocker: "base_checkout_detached" },
  );
});

test("worktree branches and paths are deterministic and contained", () => {
  assert.equal(
    buildOrchestratorBranchName("agent", "run:123", "Template Catalog"),
    "codex/agent-run-123-Template-Catalog",
  );
  assert.equal(
    buildOrchestratorBranchName("orchestrator", "run:123"),
    "codex/orchestrator-run-123",
  );
  assert.equal(isPathInsideRoot("C:\\tmp\\root", "C:\\tmp\\root\\task", "\\"), true);
  assert.equal(isPathInsideRoot("C:\\tmp\\root", "C:\\tmp\\root-escape", "\\"), false);
});
