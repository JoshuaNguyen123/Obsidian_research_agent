import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMissionCompletionSummaryV1,
  formatMissionCompletionSummaryBulletsV1,
  formatMissionCompletionSummaryProseV1,
  MAX_COMPLETION_SUMMARY_ITEMS,
  missionCompletionHeadlineV1,
} from "../src/agent/missionCompletionSummary";

test("a passing mission with receipts reads as done, with the change named", () => {
  const summary = buildMissionCompletionSummaryV1({
    stopReason: "write_completed",
    receipts: [
      { toolName: "append_to_current_file", operation: "append", path: "Notes/Plan.md" },
      // Same identity twice (a replayed receipt) collapses to one line.
      { toolName: "append_to_current_file", operation: "append", path: "Notes/Plan.md" },
    ],
    evidenceCount: 2,
    tools: [
      { name: "read_current_file", ok: 1, failed: 0 },
      { name: "web_search", ok: 2, failed: 0 },
      { name: "append_to_current_file", ok: 1, failed: 0 },
    ],
    acceptance: { status: "pass", missing: [] },
  });
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.changed, ["Appended to Notes/Plan.md."]);
  assert.deepEqual(summary.couldNot, ["Nothing was left undone."]);
  assert.ok(summary.did[0].startsWith("Ran web_search ×2, "), summary.did[0]);
  assert.ok(summary.did.includes("Gathered evidence from 2 sources."), summary.did.join("|"));

  const prose = formatMissionCompletionSummaryProseV1(summary);
  assert.ok(prose.startsWith("What I did: Ran web_search"), prose);
  assert.ok(prose.includes("\nWhat changed: Appended to Notes/Plan.md."), prose);
  assert.ok(prose.endsWith("What I could not do: Nothing was left undone."), prose);
  assert.equal(
    missionCompletionHeadlineV1(summary, "write_completed"),
    "Mission done: Appended to Notes/Plan.md",
  );
});

test("a needs_more_work mission names the missing proof and the stop reason", () => {
  const summary = buildMissionCompletionSummaryV1({
    stopReason: "step_budget",
    receipts: [],
    tools: [{ name: "web_fetch", ok: 1, failed: 2 }],
    acceptance: { status: "needs_more_work", missing: ["web_evidence", "tool:append_to_current_file"] },
    remainingActions: ["none"],
  });
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.changed, ["No notes were changed."]);
  assert.equal(summary.did[0], "Ran web_fetch ×3 (2 failed).");
  assert.deepEqual(summary.couldNot, [
    "Missing proof: web evidence.",
    "Missing proof: tool call append to current file.",
    "Paused at a safety limit. Ask me to continue.",
  ]);
  // A budget stop is a pause, and the headline leads with what is still owed.
  assert.equal(
    missionCompletionHeadlineV1(summary, "step_budget"),
    "Mission paused: Missing proof: web evidence",
  );
  assert.equal(
    missionCompletionHeadlineV1(summary, "unknown"),
    "Mission finished with gaps: Ran web_fetch ×3 (2 failed)",
  );
  // A parked approval has one fixed headline: nothing to summarize yet.
  assert.equal(
    missionCompletionHeadlineV1(
      buildMissionCompletionSummaryV1({ stopReason: "approval_pending" }),
      "approval_pending",
    ),
    "Mission parked: an approval expired unanswered; Continue to be asked again",
  );
});

test("a blocked mission leads the headline with the blocker", () => {
  const summary = buildMissionCompletionSummaryV1({
    stopReason: "provider_error",
    stopDetail: "HTTP 503 from the provider.",
    blockers: ["Provider returned 503 twice."],
  });
  assert.equal(summary.did[0], "Answered directly without running tools.");
  assert.equal(summary.couldNot[0], "Provider returned 503 twice.");
  assert.equal(
    missionCompletionHeadlineV1(summary, "provider_error"),
    "Mission blocked: Provider returned 503 twice",
  );
});

test("the run-note seat works from ledger counts and status alone", () => {
  const summary = buildMissionCompletionSummaryV1({
    ledgerStatus: "budget",
    receiptCount: 2,
    evidenceCount: 1,
    milestones: ["Drafted the comparison section"],
    acceptance: { status: "pass", missing: [] },
  });
  assert.deepEqual(summary.changed, ["2 verified writes (see receipts)."]);
  assert.ok(summary.did.includes("Drafted the comparison section."), summary.did.join("|"));
  assert.deepEqual(summary.couldNot, ["Paused at a budget limit; the run is resumable."]);
  const bullets = formatMissionCompletionSummaryBulletsV1(summary);
  assert.equal(bullets.length, 3);
  for (const bullet of bullets) {
    assert.ok(bullet.startsWith("- What "), bullet);
    assert.ok(!/[\r\n]/.test(bullet), bullet);
  }
});

test("every section is bounded and de-duplicated", () => {
  const receipts = Array.from({ length: 7 }, (_, index) => ({
    toolName: "create_file",
    operation: "create",
    path: `Out/${index}.md`,
  }));
  const summary = buildMissionCompletionSummaryV1({
    stopReason: "verified_complete",
    receipts,
    blockers: ["same", "same", " same "],
  });
  assert.equal(summary.changed.length, MAX_COMPLETION_SUMMARY_ITEMS + 1);
  assert.equal(summary.changed[MAX_COMPLETION_SUMMARY_ITEMS], "+4 more.");
  assert.deepEqual(summary.couldNot, ["same."]);
  assert.equal(summary.complete, false);
});
