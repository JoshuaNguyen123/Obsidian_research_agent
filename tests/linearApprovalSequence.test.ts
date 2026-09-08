import assert from "node:assert/strict";
import test from "node:test";

import {
  countAmbiguousLinearDispatchFailuresV1,
  judgeSingleIssueLinearApprovalsV1,
  linearIssueUrlsInNoteV1,
} from "../e2e/fixtures/linearApprovalSequence";

// The cohort-3 shape (2026-09-07, occurrence 12): one prepared action, the
// first dispatch timed out, the product re-requested the exact approval and
// settled with one issue.
const ACTION = "research-publication-preview-9faceb140344bdd9edf1b33d";
const approval = (requestId: string, preparedActionId: string | null = ACTION, toolName = "publish_research_to_linear") => ({
  toolName,
  requestId,
  preparedActionId,
});
const timeout = (id: string) => [
  { kind: "tool_result", id, toolName: "publish_research_to_linear", errorCode: "linear_timeout", ok: null },
  { kind: "tool_done", id, toolName: "publish_research_to_linear", errorCode: "linear_timeout", ok: false },
];

test("one prepared action approved once, no failures: ok", () => {
  const verdict = judgeSingleIssueLinearApprovalsV1([approval("approval-1")], []);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.approvals, 1);
  assert.deepEqual(verdict.preparedActionIds, [ACTION]);
});

test("the cohort-3 shape: same action re-approved after one ambiguous dispatch failure is ok", () => {
  const verdict = judgeSingleIssueLinearApprovalsV1(
    [approval("approval-1"), approval("approval-2")],
    [
      { kind: "tool_start", id: "run:5:0:publish_research_to_linear", toolName: "publish_research_to_linear", errorCode: null },
      ...timeout("run:5:0:publish_research_to_linear"),
      { kind: "tool_done", id: "run:9:0:publish_research_to_linear", toolName: "publish_research_to_linear", errorCode: null, ok: true },
    ],
  );
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.ambiguousFailures, 1, "tool_result and tool_done of one call count once");
});

test("a re-approval with NO failed dispatch behind it is the duplicate race and is refused", () => {
  const verdict = judgeSingleIssueLinearApprovalsV1([approval("approval-1"), approval("approval-2")], []);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /re-approval without a failed dispatch/u);
});

test("two DIFFERENT prepared actions are two mutations even with a timeout between them", () => {
  const verdict = judgeSingleIssueLinearApprovalsV1(
    [approval("approval-1"), approval("approval-2", "research-publication-preview-other")],
    timeout("run:5:0:publish_research_to_linear"),
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /2 distinct prepared Linear actions/u);
});

test("more re-approvals than ambiguous failures is refused; a non-ambiguous error licenses nothing", () => {
  const three = judgeSingleIssueLinearApprovalsV1(
    [approval("a1"), approval("a2"), approval("a3")],
    timeout("run:5:0:publish_research_to_linear"),
  );
  assert.equal(three.ok, false);
  const notFound = judgeSingleIssueLinearApprovalsV1(
    [approval("a1"), approval("a2")],
    [{ kind: "tool_done", id: "run:5:0:publish_research_to_linear", toolName: "publish_research_to_linear", errorCode: "linear_not_found", ok: false }],
  );
  assert.equal(notFound.ok, false, "linear_not_found is a definite outcome, not an ambiguous one");
  assert.equal(countAmbiguousLinearDispatchFailuresV1([
    { kind: "tool_done", id: "x", toolName: "linear_search_issues", errorCode: "linear_timeout", ok: false },
  ]), 0, "a timed-out READ licenses no mutation re-approval");
});

test("no Linear approval at all is refused, and a missing prepared action id is refused", () => {
  assert.equal(judgeSingleIssueLinearApprovalsV1([], []).ok, false);
  assert.equal(judgeSingleIssueLinearApprovalsV1([approval("a1", null)], []).ok, false);
  assert.equal(
    judgeSingleIssueLinearApprovalsV1([approval("a1", ACTION, "publish_verified_code_to_github")], []).ok,
    false,
    "a GitHub approval is not a Linear approval",
  );
});

test("the note-side check counts distinct Linear issue URLs", () => {
  const note = [
    "See https://linear.app/application-testing-dumping/issue/APP-549/flow-real-x and again",
    "https://linear.app/application-testing-dumping/issue/APP-549/flow-real-x.",
  ].join("\n");
  assert.deepEqual(linearIssueUrlsInNoteV1(note), ["https://linear.app/application-testing-dumping/issue/APP-549"]);
  assert.equal(linearIssueUrlsInNoteV1(note + " https://linear.app/t/issue/APP-548/dup").length, 2);
  assert.deepEqual(linearIssueUrlsInNoteV1("no links here"), []);
});
