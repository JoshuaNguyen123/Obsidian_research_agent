import test from "node:test";
import assert from "node:assert/strict";
import { reflectMissionCompletion } from "../src/agent/completionReflection";
import { computeProofDebt } from "../src/agent/proofDebt";

test("reflectMissionCompletion is done only when acceptance and proof are clear", () => {
  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const done = reflectMissionCompletion({
    prompt: "Deep research on batteries",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 1,
  });
  assert.equal(done.done, true);
  assert.equal(done.remainingActions.length, 0);
  assert.ok(done.confidence >= 0.9);
});

test("reflectMissionCompletion stays open for unpaid debt, WAL, conflicts, or write goals", () => {
  const unpaid = computeProofDebt({
    status: "budget",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
  });
  const unpaidReflection = reflectMissionCompletion({
    prompt: "Deep research",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
    proofDebt: unpaid,
    writeReceiptCount: 0,
  });
  assert.equal(unpaidReflection.done, false);
  assert.ok(unpaidReflection.remainingActions.length > 0);

  const walDebt = computeProofDebt({
    status: "blocked",
    acceptance: { status: "pass", missing: [] },
    operationJournal: [
      { state: "reconcile_required", operationId: "op-1", toolName: "append_to_current_file" },
    ],
  });
  const walReflection = reflectMissionCompletion({
    prompt: "Write note",
    acceptance: { status: "pass", missing: [] },
    proofDebt: walDebt,
    writeReceiptCount: 1,
  });
  assert.equal(walReflection.done, false);
  assert.match(walReflection.reason, /wal_reconcile/);

  const conflictDebt = computeProofDebt({
    status: "paused",
    acceptance: { status: "pass", missing: [] },
    openConflicts: [
      { id: "c1", status: "open", summary: "A vs B" },
    ],
  });
  const conflictReflection = reflectMissionCompletion({
    prompt: "Research",
    acceptance: { status: "pass", missing: [] },
    proofDebt: conflictDebt,
    writeReceiptCount: 1,
  });
  assert.equal(conflictReflection.done, false);
  assert.match(conflictReflection.reason, /conflict/);

  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const pendingWrite = reflectMissionCompletion({
    prompt: "Append summary",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 0,
    pendingGoalIds: ["append_current_note"],
  });
  assert.equal(pendingWrite.done, false);
  assert.match(pendingWrite.reason, /pending_write/);
});
