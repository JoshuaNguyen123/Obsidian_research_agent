import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import DailyUseReporter, {
  classifyToolReceiptWork,
  countIntentionalNoOpReceipts,
  countRefusalMarkers,
  countVacuousToolReceipts,
  isVacuousToolReceipt,
  nullableCounter,
  resolveRefusalBuckets,
  selectAtomicDailyUseObservation,
  shouldWriteDailyUseSummary,
  resolveToolCallCounters,
  sumNullableCounters,
  summarizeRecords,
  writeDailyUseSummaryIfAny,
} from "../e2e/reporters/dailyUseReporter";
import {
  DAILY_USE_METRICS_ANNOTATION,
  DAILY_USE_TOOL_OUTCOMES_ANNOTATION,
} from "../e2e/fixtures/dailyUseAcceptance";

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

/**
 * Reporter record building. The unit under test is `onTestEnd`, because the
 * fabricated zeros this wave removes were produced there, not in any exported
 * helper: `metrics` is null for every record without a typed
 * DailyUseScenarioId, and `metrics?.toolCalls ?? 0` turned that null into an
 * explicit observed=0 CSV row for lanes that certainly called tools.
 */
function fakeTest(options: {
  title?: string;
  project?: string;
  file?: string;
  annotations?: { type: string; description: string }[];
}): any {
  return {
    title: options.title ?? "a mission completes",
    location: { file: path.join(process.cwd(), options.file ?? "e2e/real-ai-soak.spec.ts") },
    annotations: options.annotations ?? [],
    parent: { project: () => ({ name: options.project ?? "real-ai-soak" }) },
  };
}

function fakeResult(overrides: Record<string, unknown> = {}): any {
  return { status: "passed", duration: 1_000, retry: 0, errors: [], ...overrides };
}

function recordsOf(reporter: DailyUseReporter): any[] {
  return (reporter as unknown as { records: any[] }).records;
}

function outcomesAnnotation(
  counts: Record<string, unknown>,
): { type: string; description: string } {
  return {
    type: DAILY_USE_TOOL_OUTCOMES_ANNOTATION,
    description: JSON.stringify({
      version: 1,
      coverage: "complete",
      attempted: null,
      succeeded: null,
      failed: null,
      undetermined: null,
      vacuous: null,
      intentionalNoOp: null,
      receiptsUnknown: null,
      succeededWithWork: null,
      failureBuckets: null,
      atLeast: null,
      observedEvents: 0,
      artifactIdentity: null,
      writeReceipts: null,
      ...counts,
    }),
  };
}

test("an unannotated lane records UNKNOWN tool calls, never an explicit zero", () => {
  const reporter = new DailyUseReporter();
  reporter.onTestEnd(fakeTest({}), fakeResult());
  const [record] = recordsOf(reporter);
  // The four scenario-less proof lanes land here. Zero would be a claim.
  assert.equal(record.scenarioId, null);
  assert.equal(record.toolCalls, null, "unknown tool calls must not print as 0");
  assert.equal(record.toolCallsAttempted, null);
  assert.equal(record.toolCallsFailed, null);
  assert.equal(record.toolCallsVacuous, null);
  assert.equal(record.refusalBuckets, null);
  assert.equal(record.refusalBucketsSource, null);
  // Serialization is what the CSV pipeline consumes.
  const serialized = JSON.parse(JSON.stringify(record));
  assert.equal(serialized.toolCalls, null);
  assert.notEqual(serialized.toolCalls, 0);
});

test("a folded outcomes annotation supplies real counters for a scenario-less lane", () => {
  const reporter = new DailyUseReporter();
  reporter.onTestEnd(
    fakeTest({
      annotations: [
        outcomesAnnotation({
          attempted: 41,
          succeeded: 38,
          failed: 3,
          undetermined: 0,
          vacuous: 2,
          intentionalNoOp: 1,
          succeededWithWork: 36,
          failureBuckets: { execution_failed: 3, tool_not_allowed: 0 },
          failureDetails: [
            {
              id: "2:1:read_current_file",
              toolName: "read_current_file",
              errorCode: "execution_failed",
              bucket: "execution_failed",
            },
          ],
          failureDetailsTruncated: false,
          observedEvents: 120,
          artifactIdentity: null,
          writeReceipts: null,
        }),
      ],
    }),
    fakeResult(),
  );
  const [record] = recordsOf(reporter);
  assert.equal(record.toolCallsAttempted, 41);
  assert.equal(record.toolCallsFailed, 3);
  assert.equal(record.toolCallsVacuous, 2);
  assert.equal(record.toolCallsIntentionalNoOp, 1);
  assert.equal(record.refusalBucketsSource, "outcomes");
  // A watched bucket that saw nothing is an EXPLICIT zero — unlike a mined
  // sighting, where absence is only absence.
  assert.equal(record.refusalBuckets.tool_not_allowed, 0);
  assert.equal(record.refusalBuckets.execution_failed, 3);
  // The fingerprinted DU counter is a different quantity and stays unknown.
  assert.equal(record.toolCalls, null);
  assert.equal(record.toolCallOutcomes.coverage, "complete");
  assert.deepEqual(record.toolCallOutcomes.failureDetails, [
    {
      id: "2:1:read_current_file",
      toolName: "read_current_file",
      errorCode: "execution_failed",
      bucket: "execution_failed",
    },
  ]);
  assert.equal(record.toolCallOutcomes.failureDetailsTruncated, false);
});

test("a lossy or malformed outcomes annotation stays unknown rather than becoming zero", () => {
  const reporter = new DailyUseReporter();
  reporter.onTestEnd(
    fakeTest({
      annotations: [
        {
          type: DAILY_USE_TOOL_OUTCOMES_ANNOTATION,
          description: JSON.stringify({
            version: 1,
            coverage: "lossy",
            attempted: null,
            failed: null,
            failureBuckets: null,
            atLeast: { attempted: 12, failed: 2 },
            observedEvents: 30,
            artifactIdentity: null,
            writeReceipts: null,
          }),
        },
      ],
    }),
    fakeResult(),
  );
  reporter.onTestEnd(
    fakeTest({ annotations: [{ type: DAILY_USE_TOOL_OUTCOMES_ANNOTATION, description: "{not json" }] }),
    fakeResult(),
  );
  reporter.onTestEnd(
    fakeTest({
      annotations: [
        { type: DAILY_USE_TOOL_OUTCOMES_ANNOTATION, description: JSON.stringify({ version: 2, coverage: "complete", attempted: 9 }) },
      ],
    }),
    fakeResult(),
  );
  for (const record of recordsOf(reporter)) {
    assert.equal(record.toolCallsAttempted, null);
    assert.equal(record.toolCallsFailed, null);
    assert.equal(record.refusalBuckets, null);
    assert.equal(record.toolCalls, null);
  }
  // The lossy fold is still kept for provenance, with its lower bounds intact.
  assert.equal(recordsOf(reporter)[0].toolCallOutcomes.coverage, "lossy");
  assert.deepEqual(recordsOf(reporter)[0].toolCallOutcomes.atLeast, {
    attempted: 12,
    failed: 2,
  });
  assert.equal(recordsOf(reporter)[1].toolCallOutcomes, null);
  assert.equal(recordsOf(reporter)[2].toolCallOutcomes, null);
});

test("a spec's own counters outrank the harness-wide fold", () => {
  // DU-06 folds PER PHASE and knows its own scoping; the harness-wide fold
  // spans the whole session. The spec wins, and the two are never averaged.
  const reporter = new DailyUseReporter();
  reporter.onTestEnd(
    fakeTest({
      title: "DU-06 checkers exact-SHA lifecycle",
      project: "daily-use-compound",
      file: "e2e/daily-use-compound.spec.ts",
      annotations: [
        {
          type: DAILY_USE_METRICS_ANNOTATION,
          description: JSON.stringify({
            scenarioId: "DU-06",
            modelCalls: 7,
            toolCalls: 11,
            toolCallsAttempted: 19,
            toolCallsFailed: 4,
          }),
        },
        outcomesAnnotation({ attempted: 99, failed: 40, observedEvents: 300 }),
      ],
    }),
    fakeResult(),
  );
  const [record] = recordsOf(reporter);
  assert.equal(record.scenarioId, "DU-06");
  assert.equal(record.toolCallsAttempted, 19);
  assert.equal(record.toolCallsFailed, 4);
  // The fingerprinted evidence-derived counter is untouched.
  assert.equal(record.toolCalls, 11);
  const [summary] = summarizeRecords([record]);
  assert.equal(summary.scenarioId, "DU-06");
  assert.equal(summary.taskFamily, "compound");
});

test("group summaries keep unknown tool calls unknown", () => {
  const reporter = new DailyUseReporter();
  reporter.onTestEnd(fakeTest({}), fakeResult());
  reporter.onTestEnd(fakeTest({}), fakeResult());
  const [summary] = summarizeRecords(recordsOf(reporter));
  assert.equal(summary.scenarioId, null);
  assert.equal(summary.taskFamily, "unknown");
  assert.equal(summary.toolCalls, null, "no record knew: the group total is unknown");
  assert.equal(summary.toolCallsAttempted, null);
});

test("counters come from ONE source: annotation and fold are never blended", () => {
  // Blending the annotation's `attempted` with the fold's `failed` yields a
  // ratio neither source ever measured. The annotation wins as a WHOLE when it
  // carries any counter; its own gaps stay unknown.
  const annotated = resolveToolCallCounters(
    {
      toolCallsAttempted: 19,
      toolCallsFailed: 4,
      toolCallsVacuous: null,
      toolCallsIntentionalNoOp: null,
      toolCallsUndetermined: null,
    },
    {
      version: 1,
      coverage: "complete",
      attempted: 99,
      succeeded: 50,
      failed: 40,
      undetermined: 9,
      vacuous: 7,
      intentionalNoOp: 2,
      receiptsUnknown: 0,
      succeededWithWork: 43,
      failureBuckets: {},
      failureDetails: [],
      failureDetailsTruncated: false,
      servedFromCache: null,
      transportExecuted: null,
      atLeast: null,
      observedEvents: 300,
      artifactIdentity: null,
      writeReceipts: null,
    },
  );
  assert.equal(annotated.toolCallsAttempted, 19);
  assert.equal(annotated.toolCallsFailed, 4);
  assert.equal(annotated.toolCallsVacuous, null, "the fold's 7 must not fill this gap");
  assert.equal(annotated.toolCallsUndetermined, null);

  // With no annotated counters at all, the complete fold supplies every field —
  // including undetermined, which stops `attempted - failed` from scoring an
  // interrupted call as a success.
  const folded = resolveToolCallCounters(
    {
      toolCallsAttempted: null,
      toolCallsFailed: null,
      toolCallsVacuous: null,
      toolCallsIntentionalNoOp: null,
      toolCallsUndetermined: null,
    },
    {
      version: 1,
      coverage: "complete",
      attempted: 10,
      succeeded: 6,
      failed: 1,
      undetermined: 3,
      vacuous: 1,
      intentionalNoOp: 0,
      receiptsUnknown: 0,
      succeededWithWork: 5,
      failureBuckets: {},
      failureDetails: [],
      failureDetailsTruncated: false,
      servedFromCache: null,
      transportExecuted: null,
      atLeast: null,
      observedEvents: 40,
      artifactIdentity: null,
      writeReceipts: null,
    },
  );
  assert.equal(folded.toolCallsAttempted, 10);
  assert.equal(folded.toolCallsUndetermined, 3);
  assert.equal(folded.toolCallsVacuous, 1);

  // Neither source: every field unknown, never zero.
  const nothing = resolveToolCallCounters(null, null);
  assert.deepEqual(nothing, {
    toolCallsAttempted: null,
    toolCallsFailed: null,
    toolCallsVacuous: null,
    toolCallsIntentionalNoOp: null,
    toolCallsUndetermined: null,
  });
});

test("a validation verdict is work, not an empty contract", () => {
  // Measured 2026-08-26: every compound run reported exactly 3 vacuous calls,
  // and all three were code_validate_fast/targeted/full. Their receipts carry
  // a verified readback, exitCode 0, real stdout bytes and a real duration --
  // the sandbox command ran and passed -- alongside affectedCount: 0, because
  // validating a workspace changes nothing. Scoring that as an empty contract
  // was the instrument's error and cost 15 points of measured tool-call
  // success on an otherwise perfect run.
  for (const purpose of ["validation_fast", "validation_targeted", "validation_full"]) {
    assert.equal(
      classifyToolReceiptWork({
        purpose,
        exitCode: 0,
        commitKind: "committed",
        affectedCount: 0,
        effects: { affectedCount: 0, changedFields: [] },
      }),
      "worked",
      `${purpose} with a passing command is work`,
    );
  }
});

test("the validation exemption cannot be claimed by something that did not run", () => {
  // The exemption is narrow on purpose. A verdict-only receipt must prove its
  // command actually ran and passed; anything else falls back to the delta
  // rules, so this cannot become a blanket amnesty for zero-delta successes.
  assert.equal(
    classifyToolReceiptWork({
      purpose: "validation_fast",
      exitCode: 1,
      commitKind: "committed",
      affectedCount: 0,
    }),
    "vacuous",
    "a validation with a non-zero exit does not get the exemption",
  );
  assert.equal(
    classifyToolReceiptWork({
      purpose: "validation_fast",
      commitKind: "committed",
      affectedCount: 0,
    }),
    "vacuous",
    "a validation with no exitCode at all does not get the exemption",
  );
  assert.equal(
    classifyToolReceiptWork({
      purpose: "mutation_write",
      exitCode: 0,
      commitKind: "committed",
      affectedCount: 0,
    }),
    "vacuous",
    "a non-verdict purpose is unaffected by the exemption",
  );
});

test("a real empty contract is still caught", () => {
  // The metric's whole reason for existing: a tool that WAS supposed to change
  // something and reported success without changing it.
  assert.equal(
    classifyToolReceiptWork({
      operation: "write",
      commitKind: "committed",
      bytesWritten: 0,
      bytesDeleted: 0,
      affectedCount: 0,
    }),
    "vacuous",
  );
  assert.equal(
    classifyToolReceiptWork({ commitKind: "committed", effects: { changed: false } }),
    "vacuous",
  );
  // And correct idempotent behaviour stays its own class, never lumped in.
  assert.equal(classifyToolReceiptWork({ commitKind: "no_op" }), "intentional_no_op");
  assert.equal(classifyToolReceiptWork({ commitKind: "reconciled" }), "intentional_no_op");
});

test("the REAL validation receipt shape is exempt, not a hypothetical one", () => {
  // The first version of this exemption keyed on `purpose`, which lives on the
  // nested sandboxReceipt and is not a field of the receipt these counters
  // see. It was inert: three runs after it landed still reported vacuous=3.
  // This pins the shape taken VERBATIM from a real persisted run receipt.
  assert.equal(
    classifyToolReceiptWork({
      toolName: "code_validate_fast",
      operation: "validate",
      commitKind: "committed",
      readback: { status: "verified" },
      effects: { affectedCount: 0, changedFields: [] },
      affectedCount: 0,
    }),
    "worked",
  );
});

test("a validate receipt without verified readback is not exempt", () => {
  // Proof-of-work is required; the operation name alone cannot buy the
  // exemption, or any zero-delta receipt could claim to be a validation.
  assert.equal(
    classifyToolReceiptWork({
      operation: "validate",
      commitKind: "committed",
      affectedCount: 0,
    }),
    "vacuous",
  );
  assert.equal(
    classifyToolReceiptWork({
      operation: "validate",
      commitKind: "committed",
      readback: { status: "unverified" },
      affectedCount: 0,
    }),
    "vacuous",
  );
  // And a genuine zero-byte WRITE is still an empty contract.
  assert.equal(
    classifyToolReceiptWork({
      operation: "write",
      commitKind: "committed",
      readback: { status: "verified" },
      bytesWritten: 0,
      affectedCount: 0,
    }),
    "vacuous",
  );
});
