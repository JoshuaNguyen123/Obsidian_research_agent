const REVIEW_REPAIR_ACTION_PATTERN =
  /\b(?:address|apply|fix|handle|implement|resolve|respond to)\b/u;
const REVIEW_REPAIR_SUBJECT_PATTERN =
  /\b(?:review|feedback|changes requested|review comments?)\b/u;
const PULL_REQUEST_PATTERN = /\b(?:github|pull request|pr)\b/u;
const STRONG_REVIEW_REPAIR_SUBJECT_PATTERN =
  /\b(?:review feedback|review comments?|changes requested)\b/u;

/**
 * Detect an explicit request to repair feedback on an existing GitHub pull
 * request. Generic "review" verbs must remain clause-bound to both the repair
 * action and pull-request subject: a mission can legitimately say "review and
 * implement Linear issue ..." and mention its future GitHub publication in a
 * later sentence without becoming a PR review-repair command.
 */
export function hasExplicitGitHubReviewRepairIntentV1(
  prompt: string,
): boolean {
  const normalized = prompt.toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalized) return false;

  if (
    STRONG_REVIEW_REPAIR_SUBJECT_PATTERN.test(normalized) &&
    REVIEW_REPAIR_ACTION_PATTERN.test(normalized) &&
    PULL_REQUEST_PATTERN.test(normalized)
  ) {
    return true;
  }

  return normalized
    .split(/[.!?\n]+/u)
    .some(
      (clause) =>
        REVIEW_REPAIR_ACTION_PATTERN.test(clause) &&
        REVIEW_REPAIR_SUBJECT_PATTERN.test(clause) &&
        PULL_REQUEST_PATTERN.test(clause),
    );
}
