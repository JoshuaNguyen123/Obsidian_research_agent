/**
 * Judge the prepared Linear mutation approvals of a single-issue lane.
 *
 * WHY THIS EXISTS. Cohort 3 of the 504-mission qualification (2026-09-07) was
 * lost at occurrence 12 to "exactly one prepared Linear mutation approval":
 * the first `publish_research_to_linear` dispatch died with `linear_timeout`
 * (the product's first publish timeout in 138 calls), the product parked the
 * publication on `reconcile_required` and re-requested an exact approval for
 * the SAME prepared action, the resume settled it, and the mission finished
 * with ONE issue linked from the note. The lane read the second approval as
 * a duplicate mutation and failed a mission the product had completed.
 *
 * WHAT IS KEPT. The property the old assertion guarded is "no duplicate
 * committed effect", and it is still enforced, from both sides:
 *
 *  - exactly ONE prepared action id across every Linear approval (a second
 *    approval for a DIFFERENT prepared action is a second mutation);
 *  - a re-approval is licensed only by a preceding dispatch that failed with
 *    an AMBIGUOUS provider outcome (timeout, network, rate limit, HTTP,
 *    cancelled, partial response): one extra approval per such failure, no
 *    more. A re-approval with no failed dispatch behind it is exactly the
 *    duplicate race the product's own approval boundary describes;
 *  - the caller additionally asserts the artifact side: one issue id on the
 *    publication checkpoint and one Linear issue URL in the final note.
 *
 * Pure and JSON-only so it is unit-tested; the lane feeds it the approval
 * observations and the collector's content-free diagnostics.
 */

export const AMBIGUOUS_LINEAR_DISPATCH_ERROR_CODES: ReadonlySet<string> = new Set([
  "linear_timeout",
  "linear_network",
  "linear_rate_limited",
  "linear_http",
  "linear_cancelled",
  "linear_partial_response",
]);

export const LINEAR_ISSUE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "publish_research_to_linear",
  "linear_create_issue",
]);

export interface LinearApprovalObservationLikeV1 {
  toolName: string;
  requestId?: string | null;
  preparedActionId: string | null;
}

export interface LinearDispatchDiagnosticLikeV1 {
  kind: string;
  /** Call id (never a receipt id); tool_result and tool_done of one call share it. */
  id?: string | null;
  toolName: string | null;
  errorCode: string | null;
  ok?: boolean | null;
}

export interface LinearApprovalSequenceVerdictV1 {
  ok: boolean;
  reason: string;
  approvals: number;
  preparedActionIds: string[];
  ambiguousFailures: number;
}

/** Count failed issue-mutation dispatches whose provider outcome was ambiguous. Each call id counts once. */
export function countAmbiguousLinearDispatchFailuresV1(
  diagnostics: readonly LinearDispatchDiagnosticLikeV1[],
): number {
  const seen = new Set<string>();
  let count = 0;
  for (const event of diagnostics) {
    if (!event || typeof event.toolName !== "string") continue;
    if (!LINEAR_ISSUE_MUTATION_TOOL_NAMES.has(event.toolName)) continue;
    if (event.kind !== "tool_done" && event.kind !== "tool_result") continue;
    if (typeof event.errorCode !== "string" || !AMBIGUOUS_LINEAR_DISPATCH_ERROR_CODES.has(event.errorCode)) continue;
    // tool_result and tool_done both report the same failed call; the id is
    // the call id (never a receipt id) and de-duplicates the pair.
    const key = `${event.id ?? `${event.kind}:${count}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

export function judgeSingleIssueLinearApprovalsV1(
  approvals: readonly LinearApprovalObservationLikeV1[],
  diagnostics: readonly LinearDispatchDiagnosticLikeV1[],
): LinearApprovalSequenceVerdictV1 {
  const linear = approvals.filter((approval) => LINEAR_ISSUE_MUTATION_TOOL_NAMES.has(approval.toolName));
  const preparedActionIds = [...new Set(linear.map((approval) => approval.preparedActionId ?? ""))];
  const ambiguousFailures = countAmbiguousLinearDispatchFailuresV1(diagnostics);
  const base = { approvals: linear.length, preparedActionIds, ambiguousFailures };
  if (linear.length === 0) {
    return { ok: false, reason: "no prepared Linear mutation approval was observed", ...base };
  }
  if (preparedActionIds.length !== 1 || preparedActionIds[0] === "") {
    return {
      ok: false,
      reason: `${preparedActionIds.length} distinct prepared Linear actions were approved; the single-issue lane allows exactly one`,
      ...base,
    };
  }
  if (linear.length > 1 + ambiguousFailures) {
    return {
      ok: false,
      reason:
        `${linear.length} approvals for one prepared Linear action but only ${ambiguousFailures} ambiguous dispatch failure(s) ` +
        "preceded them; a re-approval without a failed dispatch behind it is a duplicate mutation",
      ...base,
    };
  }
  return {
    ok: true,
    reason:
      linear.length === 1
        ? "one prepared Linear action, approved once"
        : `one prepared Linear action re-approved after ${ambiguousFailures} ambiguous dispatch failure(s)`,
    ...base,
  };
}

/** Distinct Linear issue URLs a note links. */
export function linearIssueUrlsInNoteV1(note: string): string[] {
  const found = new Set<string>();
  for (const match of note.matchAll(/https?:\/\/linear\.app\/[A-Za-z0-9._-]+\/issue\/[A-Z][A-Z0-9]*-\d+/gu)) {
    found.add(match[0]);
  }
  return [...found];
}
