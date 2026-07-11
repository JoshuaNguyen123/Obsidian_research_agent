export interface WorktreePromotionCheck {
  baseWasClean: boolean;
  baseIsClean: boolean;
  baseBranch: string;
  currentBranch: string;
  baseSha: string;
  currentSha: string;
  validationPassed: boolean;
  integrationConflict: boolean;
  approvalGranted: boolean;
  proofBlocked: boolean;
}

export interface WorktreePromotionDecision {
  allow: boolean;
  blocker?: string;
}

export function evaluateWorktreePromotion(
  input: WorktreePromotionCheck,
): WorktreePromotionDecision {
  if (!input.approvalGranted) {
    return { allow: false, blocker: "orchestrator_approval_required" };
  }
  if (!input.baseWasClean) {
    return { allow: false, blocker: "base_checkout_was_dirty" };
  }
  if (!input.baseIsClean) {
    return { allow: false, blocker: "base_checkout_became_dirty" };
  }
  if (input.baseBranch === "HEAD" || input.currentBranch === "HEAD") {
    return { allow: false, blocker: "base_checkout_detached" };
  }
  if (input.baseBranch !== input.currentBranch) {
    return { allow: false, blocker: "base_branch_changed" };
  }
  if (input.baseSha !== input.currentSha) {
    return { allow: false, blocker: "base_head_changed" };
  }
  if (input.integrationConflict) {
    return { allow: false, blocker: "integration_conflict" };
  }
  if (!input.validationPassed) {
    return { allow: false, blocker: "integration_validation_failed" };
  }
  if (input.proofBlocked) {
    return { allow: false, blocker: "orchestrator_proof_blocked" };
  }
  return { allow: true };
}

export function buildOrchestratorBranchName(
  kind: "agent" | "orchestrator",
  runId: string,
  taskId?: string,
): string {
  const run = safeGitRefPart(runId).slice(0, 40) || "run";
  const task = taskId ? safeGitRefPart(taskId).slice(0, 40) : "";
  return kind === "agent"
    ? `codex/agent-${run}-${task || "task"}`
    : `codex/orchestrator-${run}`;
}

export function safeGitRefPart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^-+|-+$/g, "")
    .replace(/\.lock$/i, "-lock");
}

export function isPathInsideRoot(
  root: string,
  candidate: string,
  separator: string,
): boolean {
  const normalizedRoot = stripTrailingSeparators(root, separator);
  const normalizedCandidate = stripTrailingSeparators(candidate, separator);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${separator}`)
  );
}

function stripTrailingSeparators(value: string, separator: string): string {
  let output = value;
  while (output.endsWith(separator) && output.length > separator.length) {
    output = output.slice(0, -separator.length);
  }
  return output;
}
