import assert from "node:assert/strict";
import test from "node:test";

import {
  matchLinearIssueByTitle,
  needsLinearCreateReconciliationRecovery,
  recoverLinearCreateAfterReconciliation,
} from "../src/agent/linearReconcileRecover";

test("needsLinearCreateReconciliationRecovery detects uncertain create blockers", () => {
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_create_issue",
      ok: false,
      mutationState: "may_have_applied",
      errorCode: "mutation_reconciliation_required",
    }),
    true,
  );
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_create_issue",
      ok: false,
      mutationState: "may_have_applied",
      errorCode: "linear_mutation_uncertain",
    }),
    true,
  );
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_create_issue",
      ok: false,
      mutationState: "may_have_applied",
      errorCode: "linear_readback_failed",
    }),
    true,
  );
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_create_issue",
      ok: false,
      reconcileOutcome: "still_uncertain",
    }),
    true,
  );
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_create_issue",
      ok: true,
      mutationState: "applied",
    }),
    false,
  );
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_create_issue",
      ok: false,
      mutationState: "not_applied",
      errorCode: "linear_mutation_uncertain",
    }),
    false,
  );
  assert.equal(
    needsLinearCreateReconciliationRecovery({
      toolName: "linear_update_issue",
      ok: false,
      mutationState: "may_have_applied",
      errorCode: "mutation_reconciliation_required",
    }),
    false,
  );
});

test("matchLinearIssueByTitle prefers exact title and fails closed on ambiguity", () => {
  const exact = matchLinearIssueByTitle(
    [
      {
        title: "Flow real abc",
        id: "iss-1",
        url: "https://linear.app/team/issue/APP-1",
        identifier: "APP-1",
      },
      {
        title: "Flow real abc extra",
        id: "iss-2",
        url: "https://linear.app/team/issue/APP-2",
      },
    ],
    "Flow real abc",
  );
  assert.equal(exact.found, true);
  assert.equal(exact.issueId, "iss-1");
  assert.equal(exact.identifier, "APP-1");

  const none = matchLinearIssueByTitle(
    [{ title: "Other", id: "iss-9", url: "https://linear.app/team/issue/APP-9" }],
    "Flow real abc",
  );
  assert.equal(none.found, false);

  const ambiguous = matchLinearIssueByTitle(
    [
      {
        title: "Flow real abc",
        id: "iss-1",
        url: "https://linear.app/team/issue/APP-1",
      },
      {
        title: "Flow real abc",
        id: "iss-2",
        url: "https://linear.app/team/issue/APP-2",
      },
    ],
    "Flow real abc",
  );
  assert.equal(ambiguous.found, false);
  assert.match(String(ambiguous.reason), /Ambiguous/i);
});

test("recoverLinearCreateAfterReconciliation recovers create→reconcile via title search", async () => {
  const calls: Array<{ title: string; teamId?: string }> = [];
  const result = await recoverLinearCreateAfterReconciliation({
    title: "Flow real marker-1",
    teamId: "team-abc",
    errorCode: "mutation_reconciliation_required",
    searchByTitle: async (query) => {
      calls.push(query);
      return {
        found: true,
        issueId: "issue-uuid-1",
        issueUrl: "https://linear.app/app/issue/APP-42",
        identifier: "APP-42",
      };
    },
  });

  assert.deepEqual(calls, [{ title: "Flow real marker-1", teamId: "team-abc" }]);
  assert.equal(result.recovered, true);
  assert.deepEqual(result.receipt, {
    ok: true,
    issueId: "issue-uuid-1",
    issueUrl: "https://linear.app/app/issue/APP-42",
    identifier: "APP-42",
    recoveredBy: "title_search",
  });
});

test("recoverLinearCreateAfterReconciliation fails closed when title search finds nothing", async () => {
  const result = await recoverLinearCreateAfterReconciliation({
    title: "Flow real missing",
    teamId: "team-abc",
    errorCode: "linear_mutation_uncertain",
    searchByTitle: async () => ({ found: false }),
  });

  assert.equal(result.recovered, false);
  assert.equal(result.receipt, undefined);
  assert.match(String(result.reason), /not found/i);
  assert.match(String(result.reason), /refusing to invent/i);
  assert.match(String(result.reason), /linear_mutation_uncertain/);
});

test("recoverLinearCreateAfterReconciliation fails closed on empty title or bad URL", async () => {
  const empty = await recoverLinearCreateAfterReconciliation({
    title: "   ",
    searchByTitle: async () => {
      throw new Error("should not search");
    },
  });
  assert.equal(empty.recovered, false);
  assert.match(String(empty.reason), /title is empty/i);

  const badUrl = await recoverLinearCreateAfterReconciliation({
    title: "Flow real bad-url",
    searchByTitle: async () => ({
      found: true,
      issueUrl: "https://example.com/not-linear",
    }),
  });
  assert.equal(badUrl.recovered, false);
  assert.match(String(badUrl.reason), /non-Linear URL/i);
});

test("recoverLinearCreateAfterReconciliation fails closed when search throws", async () => {
  const result = await recoverLinearCreateAfterReconciliation({
    title: "Flow real boom",
    searchByTitle: async () => {
      throw new Error("provider timeout");
    },
  });
  assert.equal(result.recovered, false);
  assert.match(String(result.reason), /provider timeout/);
});
