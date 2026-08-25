import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyToolReceiptWork,
  countIntentionalNoOpReceipts,
  countRefusalMarkers,
  countVacuousToolReceipts,
  isVacuousToolReceipt,
  nullableCounter,
  resolveRefusalBuckets,
  selectAtomicDailyUseObservation,
  shouldWriteDailyUseSummary,
  sumNullableCounters,
  writeDailyUseSummaryIfAny,
} from "../e2e/reporters/dailyUseReporter";

test("daily-use reporter preserves the prior summary for listing and zero-test selections", () => {
  assert.equal(shouldWriteDailyUseSummary(0), false);
  assert.equal(shouldWriteDailyUseSummary(1), true);
  assert.equal(shouldWriteDailyUseSummary(-1), false);
});

test("daily-use reporter leaves the prior summary bytes untouched when no tests run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daily-use-summary-"));
  const outputPath = path.join(root, "daily-use-run-summary.json");
  const prior = '{"version":1,"status":"passed","records":[{"title":"prior"}]}\n';
  try {
    await writeFile(outputPath, prior, "utf8");
    assert.equal(
      await writeDailyUseSummaryIfAny(outputPath, 0, {
        version: 1,
        status: "passed",
        records: [],
      }),
      false,
    );
    assert.equal(await readFile(outputPath, "utf8"), prior);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daily-use reporter never unions complementary retry proof", () => {
  const first = {
    status: "failed",
    retry: 0,
    acceptanceStatus: "needs_more_work" as const,
    missingAcceptanceCriteria: ["proof:b"],
    observed: {
      artifacts: ["artifact:a"],
      proofs: ["proof:a"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
  };
  const second = {
    status: "failed",
    retry: 1,
    acceptanceStatus: "needs_more_work" as const,
    missingAcceptanceCriteria: ["proof:a"],
    observed: {
      artifacts: [],
      proofs: ["proof:b"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
  };

  const selected = selectAtomicDailyUseObservation([first, second]);
  assert.equal(selected, first);
  assert.deepEqual(selected?.observed?.proofs, ["proof:a"]);
});

test("daily-use reporter prefers one complete passed attempt", () => {
  const partial = {
    status: "failed",
    retry: 0,
    acceptanceStatus: "needs_more_work" as const,
    missingAcceptanceCriteria: ["cleanup:verified"],
    observed: {
      artifacts: ["artifact:a"],
      proofs: ["proof:a"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
  };
  const complete = {
    ...partial,
    status: "passed",
    retry: 1,
    acceptanceStatus: "pass" as const,
    missingAcceptanceCriteria: [],
  };
  assert.equal(
    selectAtomicDailyUseObservation([partial, complete]),
    complete,
  );
});

// ---------------------------------------------------------------------------
// Success/uncertainty wave (2026-08-25): failed/vacuous tool-call counting
// and refusal buckets. Unknown is data here, never a silent zero.
// ---------------------------------------------------------------------------

test("refusal markers are counted per bucket from error text; zero buckets are omitted", () => {
  const buckets = countRefusalMarkers([
    "step 4: mission_graph_authority_blocked while calling linear_update_issue",
    "retry: Mission_Graph_Authority_Blocked again, then tool_not_allowed",
    "tool_failure_repeated after tool_failure_terminal",
    "argument check: invalid_arguments rejected the payload",
  ]);
  assert.deepEqual(buckets, {
    mission_graph_authority_blocked: 2,
    tool_not_allowed: 1,
    tool_failure_terminal: 2,
    invalid_arguments: 1,
  });
  assert.deepEqual(countRefusalMarkers(["clean failure text"]), {});
});

test("refusal bucket provenance: annotation wins, error text is mined, nothing stays null", () => {
  const annotated = { mission_graph_authority_blocked: 4 };
  assert.deepEqual(resolveRefusalBuckets(annotated, ["tool_not_allowed"]), {
    buckets: annotated,
    source: "annotation",
  });
  assert.deepEqual(resolveRefusalBuckets(null, ["saw tool_not_allowed twice: tool_not_allowed"]), {
    buckets: { tool_not_allowed: 2 },
    source: "error_messages",
  });
  // A record with neither annotation nor error text was never inspected:
  // null (unknown), NOT an empty object pretending zero refusals happened.
  assert.deepEqual(resolveRefusalBuckets(null, []), { buckets: null, source: null });
  assert.deepEqual(resolveRefusalBuckets(null, [""]), { buckets: null, source: null });
});

test("a vacuous success is a mutation receipt that explicitly reports zero delta", () => {
  // The empty-contract shape: a write that reported success and zero bytes.
  assert.equal(isVacuousToolReceipt({ operation: "write", bytesWritten: 0 }), true);
  assert.equal(
    isVacuousToolReceipt({ operation: "replace", bytesWritten: 0, bytesDeleted: 0, affectedCount: 0 }),
    true,
  );
  // Real work in ANY delta field is not vacuous.
  assert.equal(isVacuousToolReceipt({ operation: "write", bytesWritten: 12 }), false);
  assert.equal(
    isVacuousToolReceipt({ operation: "replace", bytesWritten: 0, bytesDeleted: 40 }),
    false,
  );
  assert.equal(isVacuousToolReceipt({ operation: "update", affectedCount: 3 }), false);
  // A receipt with NO delta fields is unknown, not vacuous: read-style
  // operations never report deltas and must never be counted as empty work.
  assert.equal(isVacuousToolReceipt({ operation: "read" }), false);
  assert.equal(isVacuousToolReceipt({ operation: "write" }), false);
  assert.equal(isVacuousToolReceipt(null), false);
  assert.equal(isVacuousToolReceipt(undefined), false);
  assert.equal(
    countVacuousToolReceipts([
      { operation: "write", bytesWritten: 0 },
      { operation: "write", bytesWritten: 100 },
      { operation: "read" },
      null,
      { operation: "update", affectedCount: 0 },
    ]),
    2,
  );
});

test("enriched receipts outrank legacy deltas, and intentional no-ops are never vacuous", () => {
  // effects.changed is the authoritative signal when present.
  assert.equal(
    classifyToolReceiptWork({ operation: "write", effects: { changed: false } }),
    "vacuous",
  );
  assert.equal(
    classifyToolReceiptWork({ operation: "write", effects: { changed: true } }),
    "worked",
  );
  // effects.changed even overrides contradictory legacy deltas: the enriched
  // attestation is what the receipt-delta-integrity wave verifies.
  assert.equal(
    classifyToolReceiptWork({ operation: "write", bytesWritten: 0, effects: { changed: true } }),
    "worked",
  );
  // commitKind no_op/reconciled = the tool CHOSE to do nothing (idempotent
  // replay): correct behavior, its own class, never lumped with vacuous.
  assert.equal(
    classifyToolReceiptWork({ operation: "write", commitKind: "no_op", effects: { changed: false } }),
    "intentional_no_op",
  );
  assert.equal(
    classifyToolReceiptWork({ operation: "write", commitKind: "reconciled", bytesWritten: 0 }),
    "intentional_no_op",
  );
  // Other commitKind values fall through to the effects/delta signals.
  assert.equal(
    classifyToolReceiptWork({ operation: "write", commitKind: "applied", effects: { changed: false } }),
    "vacuous",
  );
  // A malformed effects object falls back to legacy deltas; nothing usable
  // stays unknown.
  assert.equal(
    classifyToolReceiptWork({ operation: "write", effects: { changed: "yes" }, bytesWritten: 0 }),
    "vacuous",
  );
  assert.equal(classifyToolReceiptWork({ operation: "write", effects: {} }), "unknown");
  const receipts = [
    { operation: "write", commitKind: "no_op" },
    { operation: "write", commitKind: "reconciled" },
    { operation: "write", effects: { changed: false } },
    { operation: "write", effects: { changed: true } },
  ];
  assert.equal(countIntentionalNoOpReceipts(receipts), 2);
  assert.equal(countVacuousToolReceipts(receipts), 1);
});

test("nullable counters never coerce unknown into zero", () => {
  assert.equal(nullableCounter(5), 5);
  assert.equal(nullableCounter(0), 0);
  assert.equal(nullableCounter(-1), null);
  assert.equal(nullableCounter(1.5), null);
  assert.equal(nullableCounter(undefined), null);
  assert.equal(nullableCounter(null), null);
  assert.equal(nullableCounter("3"), null);
  // Aggregation: null only when EVERY input is null; otherwise the sum of
  // the known values is an explicit lower bound.
  assert.equal(sumNullableCounters([null, null]), null);
  assert.equal(sumNullableCounters([]), null);
  assert.equal(sumNullableCounters([2, null, 3]), 5);
  assert.equal(sumNullableCounters([0, null]), 0, "a known zero is zero, not unknown");
});
