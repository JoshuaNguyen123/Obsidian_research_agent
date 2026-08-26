import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  summarizeToolCallCensusV1,
  type ToolCallCensusRawV1,
  type ToolCallCensusSegmentV1,
} from "../e2e/fixtures/toolCallCensus";
import { classifyToolReceiptWork } from "../e2e/reporters/dailyUseReporter";

function segment(
  overrides: Partial<ToolCallCensusSegmentV1> = {},
): ToolCallCensusSegmentV1 {
  return {
    index: 0,
    armDroppedEventCount: 0,
    armedWhileRunning: false,
    doneIds: [],
    doneFailedIds: [],
    startIds: [],
    rejectedIds: [],
    errorCodePairs: [],
    receipts: [],
    receiptsOverflowed: false,
    ...overrides,
  };
}

function raw(...segments: ToolCallCensusSegmentV1[]): ToolCallCensusRawV1 {
  return { version: 1, segments };
}

test("census algebra: attempted calls = onToolDone + standalone refusals; refusals are failures, not absences", () => {
  const summary = summarizeToolCallCensusV1(
    raw(
      segment({
        // 5 executed calls, 2 of them failed.
        doneIds: ["1:0:web_search", "1:1:web_fetch", "2:0:web_fetch", "3:0:append_to_current_file", "4:0:append_to_current_file"],
        doneFailedIds: ["3:0:append_to_current_file", "4:0:append_to_current_file"],
        startIds: ["1:0:web_search", "1:1:web_fetch", "2:0:web_fetch", "3:0:append_to_current_file", "4:0:append_to_current_file"],
        // 2 refusals that never became an onToolDone (pre-loop shapes).
        rejectedIds: ["resume-refresh-budget", "resume-refresh-unavailable"],
      }),
    ),
  );
  assert.equal(summary.coverage, "complete");
  assert.equal(summary.observed, 7);
  assert.equal(summary.executed, 5);
  assert.equal(summary.refused, 2);
  assert.equal(summary.failed, 4);
  assert.equal(summary.succeeded, 3);
});

test("census dedupe: a rejection reported on BOTH streams is one logical call", () => {
  // The main-loop authority rejection emits onToolDone{ok:false} with id
  // "5:0:append_to_current_file" AND a tool_rejected trace with id
  // "5:0:append_to_current_file:graph-rejected" (AgentRunner.ts pattern).
  const summary = summarizeToolCallCensusV1(
    raw(
      segment({
        doneIds: ["5:0:append_to_current_file"],
        doneFailedIds: ["5:0:append_to_current_file"],
        rejectedIds: ["5:0:append_to_current_file:graph-rejected"],
        errorCodePairs: [
          ["5:0:append_to_current_file", "mission_graph_authority_blocked"],
          [
            "5:0:append_to_current_file:graph-rejected",
            "mission_graph_authority_blocked",
          ],
        ],
      }),
    ),
  );
  assert.equal(summary.observed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.refused, 0);
  // The bucket counts the logical call once, not once per stream.
  assert.equal(summary.buckets?.mission_graph_authority_blocked, 1);
});

test("census numerator: a vacuous success is subtracted from succeeded; an intentional no-op is not", () => {
  const summary = summarizeToolCallCensusV1(
    raw(
      segment({
        doneIds: ["1:0:a", "2:0:b", "3:0:c"],
        receipts: [
          { operation: "write", bytesWritten: 0 },
          { operation: "write", commitKind: "no_op", effects: { changed: false } },
          { operation: "write", bytesWritten: 120 },
        ],
      }),
    ),
  );
  assert.equal(summary.observed, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.vacuous, 1);
  assert.equal(summary.intentionalNoOp, 1);
  // 3 successes - 1 vacuous = 2; the no_op replay is NOT penalized.
  assert.equal(summary.succeeded, 2);
});

test("census loss: arming mid-run after replay loss reports UNKNOWN, never a partial count", () => {
  const summary = summarizeToolCallCensusV1(
    raw(
      segment({
        armedWhileRunning: true,
        armDroppedEventCount: 4,
        doneIds: ["1:0:a", "2:0:b"],
        doneFailedIds: ["2:0:b"],
      }),
    ),
  );
  assert.equal(summary.coverage, "lossy");
  assert.equal(summary.observed, null);
  assert.equal(summary.failed, null);
  assert.equal(summary.succeeded, null);
  assert.equal(summary.buckets, null);
  // Lower bounds survive for diagnostics only.
  assert.deepEqual(summary.atLeast, { observed: 2, failed: 1 });
});

test("census loss boundaries: drops before a continuously-armed segment are harmless; unknowable arm state is loss", () => {
  // Armed while idle: later buffer drops cannot lose a live subscriber's
  // events, so this is complete even though the run dropped replay history.
  const idleArm = summarizeToolCallCensusV1(
    raw(segment({ armedWhileRunning: false, armDroppedEventCount: 7, doneIds: ["1:0:a"] })),
  );
  assert.equal(idleArm.coverage, "complete");
  // Armed mid-run with an UNKNOWN dropped count: cannot prove completeness.
  const unknownArm = summarizeToolCallCensusV1(
    raw(segment({ armedWhileRunning: true, armDroppedEventCount: null })),
  );
  assert.equal(unknownArm.coverage, "lossy");
  // Receipt projection overflow is loss regardless of arm state.
  const overflow = summarizeToolCallCensusV1(
    raw(segment({ receiptsOverflowed: true })),
  );
  assert.equal(overflow.coverage, "lossy");
});

test("census unarmed: an empty or missing collector is unknown, not zero", () => {
  const summary = summarizeToolCallCensusV1(raw());
  assert.equal(summary.coverage, "unarmed");
  assert.equal(summary.observed, null);
  assert.equal(summary.failed, null);
  assert.equal(summary.buckets, null);
});

test("census restart segments accumulate; ids repeat across segments without merging", () => {
  // Step numbers restart at 0 on a continuation, so the same raw id in two
  // segments is two DISTINCT calls — never deduped across segments.
  const summary = summarizeToolCallCensusV1(
    raw(
      segment({ index: 0, doneIds: ["1:0:append_to_current_file"] }),
      segment({
        index: 1,
        armedWhileRunning: false,
        doneIds: ["1:0:append_to_current_file"],
        doneFailedIds: ["1:0:append_to_current_file"],
      }),
    ),
  );
  assert.equal(summary.segments, 2);
  assert.equal(summary.observed, 2);
  assert.equal(summary.failed, 1);
});

test("census buckets come from the shared vocabulary; unknown codes are data; observed zeros are explicit", () => {
  const summary = summarizeToolCallCensusV1(
    raw(
      segment({
        doneIds: ["1:0:a", "2:0:b", "3:0:c"],
        doneFailedIds: ["1:0:a", "2:0:b", "3:0:c"],
        errorCodePairs: [
          ["1:0:a", "mission_graph_authority_blocked"],
          ["2:0:b", "brand_new_refusal_shape"],
          ["3:0:c", "brand_new_refusal_shape"],
        ],
      }),
    ),
  );
  assert.equal(summary.buckets?.mission_graph_authority_blocked, 1);
  // The sequencing guard: when the census observed the run, a bucket nobody
  // hit is an EXPLICIT 0 — never omitted, never null. A peer fix eliminating
  // a refusal class must show up as zero, not as missing data.
  assert.equal(summary.buckets?.tool_not_allowed, 0);
  assert.equal(summary.buckets?.execution_failed, 0);
  // A new refusal shape lands in unbucketedCodes instead of vanishing.
  assert.deepEqual(summary.unbucketedCodes, { brand_new_refusal_shape: 2 });
});

test("census receipt verdicts agree with the reporter's classifier", () => {
  const fixtures = [
    { operation: "write", effects: { changed: false } },
    { operation: "write", commitKind: "reconciled" },
    { operation: "write", bytesWritten: 64 },
    { operation: "read" },
  ];
  const summary = summarizeToolCallCensusV1(
    raw(segment({ doneIds: ["1:0:a"], receipts: fixtures })),
  );
  const expectVacuous = fixtures.filter(
    (receipt) => classifyToolReceiptWork(receipt) === "vacuous",
  ).length;
  const expectNoOp = fixtures.filter(
    (receipt) => classifyToolReceiptWork(receipt) === "intentional_no_op",
  ).length;
  const expectUnknown = fixtures.filter(
    (receipt) => classifyToolReceiptWork(receipt) === "unknown",
  ).length;
  assert.equal(summary.vacuous, expectVacuous);
  assert.equal(summary.intentionalNoOp, expectNoOp);
  assert.equal(summary.receiptsUnknown, expectUnknown);
});

// ---------------------------------------------------------------------------
// Source-level guards (repo convention: one shared seat, no re-inlining).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CENSUS_LANE_SPECS = [
  "e2e/daily-use-research.spec.ts",
  "e2e/real-ai-soak.spec.ts",
  "e2e/desktop-code-delivery-real-live.spec.ts",
  "e2e/interrupted-continuation-live.spec.ts",
];

test("census guard: lane specs subscribe through the census fixture, never directly", () => {
  for (const spec of CENSUS_LANE_SPECS) {
    const source = readFileSync(path.join(REPO_ROOT, spec), "utf8");
    assert.ok(
      !source.includes("subscribeMissionEvents"),
      `${spec} must not call subscribeMissionEvents directly — the census fixture is the single subscription seat for proof lanes.`,
    );
    assert.ok(
      source.includes("recordToolCallCensusAfterEach"),
      `${spec} must register recordToolCallCensusAfterEach so its rows carry tool-call counters.`,
    );
  }
  // Allowlisted direct taps: the census itself and the DU-06 diagnostic tap.
  const census = readFileSync(
    path.join(REPO_ROOT, "e2e/fixtures/toolCallCensus.ts"),
    "utf8",
  );
  assert.ok(census.includes("subscribeMissionEvents"));
});

test("census guard: the harness arms and harvests the census at its lifecycle seams", () => {
  const harness = readFileSync(
    path.join(REPO_ROOT, "e2e/fixtures/realAiHarness.ts"),
    "utf8",
  );
  assert.ok(
    harness.includes("armToolCallCensus"),
    "realAiHarness must arm the census in setup and re-arm it after restartCorePlugin.",
  );
  assert.ok(
    harness.includes("harvestToolCallCensus"),
    "realAiHarness must harvest the census in beforeClose.",
  );
});

test("census guard: nullable count helpers live in one shared module", () => {
  for (const script of [
    "scripts/run-proof-matrix.mjs",
    "scripts/run-targeted-protected-release.mjs",
  ]) {
    const source = readFileSync(path.join(REPO_ROOT, script), "utf8");
    assert.ok(
      !/function\s+(?:nullableCount|sumNullable)\s*\(/u.test(source),
      `${script} must import nullableCount/sumNullable from scripts/honest-counts.mjs instead of re-declaring them.`,
    );
  }
});
