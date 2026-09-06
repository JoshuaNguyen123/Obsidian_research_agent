import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOOL_CALL_COLLECTOR_EVENT_CAP,
  armToolCallCollector,
  collectedToolCallCountsForTestV1,
  harvestToolCallCollector,
  peekToolCallCollector,
  peekToolCallCollectorDiagnosticsV1,
  resetToolCallCollectorStateForTestsV1,
  summarizeCollectedToolCallsV1,
  type ToolCallCollectorRawV1,
  type ToolCallCollectorSegmentV1,
} from "../e2e/fixtures/toolCallCollector";
import {
  foldToolCallOutcomesV1,
  unknownToolCallOutcomeCountsV1,
  type ToolCallOutcomeEventV1,
  RECEIPT_IDENTITY_DIGEST,
} from "../e2e/fixtures/toolCallOutcomes";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** One succeeded call, one failed call, one write receipt. */
function callPair(step: number): ToolCallOutcomeEventV1[] {
  return [
    { kind: "tool_start", id: `${step}:0:append_to_current_file`, toolName: "append_to_current_file" },
    {
      kind: "tool_done",
      id: `${step}:0:append_to_current_file`,
      toolName: "append_to_current_file",
      ok: true,
      errorCode: null,
    },
    {
      kind: "receipt",
      id: `receipt-${step}`,
      toolName: "append_to_current_file",
      receipt: { operation: "append", bytesWritten: 42 },
    },
    { kind: "tool_start", id: `${step}:1:web_search`, toolName: "web_search" },
    {
      kind: "tool_done",
      id: `${step}:1:web_search`,
      toolName: "web_search",
      ok: false,
      errorCode: "execution_failed",
    },
  ];
}

function segment(
  index: number,
  events: ToolCallOutcomeEventV1[],
  overrides: Partial<ToolCallCollectorSegmentV1> = {},
): ToolCallCollectorSegmentV1 {
  return {
    index,
    armDroppedEventCount: 0,
    armedWhileRunning: false,
    overflowed: false,
    // Each arm here models a DISTINCT coordinator start, which is what
    // `restartCorePlugin` actually produces: the disable/enable cycle destroys
    // the coordinator, so the resumed run is a new id namespace. Two arms
    // against the SAME start (a replayed prefix) and the anonymous/ambiguous
    // case are covered in tests/toolCallCollectorAttribution.test.ts.
    coordinatorStartId: `scope-${index}`,
    runId: `run-${index}`,
    events,
    ...overrides,
  };
}

function raw(...segments: ToolCallCollectorSegmentV1[]): ToolCallCollectorRawV1 {
  return { version: 1, segments };
}

test("a never-armed collector reports unknown everywhere, never zero", () => {
  for (const input of [null, undefined, raw(), { version: 1 } as any]) {
    const counts = summarizeCollectedToolCallsV1(input as ToolCallCollectorRawV1);
    assert.equal(counts.coverage, "unobserved");
    assert.equal(counts.attempted, null);
    assert.equal(counts.failed, null);
    assert.equal(counts.succeeded, null);
    assert.equal(counts.vacuous, null);
    assert.equal(counts.failureBuckets, null);
    // The serialized form is what reaches the CSV pipeline: null must survive
    // JSON.stringify distinctly from 0.
    const serialized = JSON.parse(JSON.stringify(counts));
    assert.equal(serialized.attempted, null);
    assert.notEqual(serialized.attempted, 0);
  }
});

test("a single complete segment delegates verbatim to the shared fold", () => {
  const events = callPair(1);
  const counts = summarizeCollectedToolCallsV1(raw(segment(0, events)));
  // The collector adds NO judgment of its own: the answer must equal the
  // primitive's answer for the same stream. A second counting authority here
  // is exactly the drift this seam exists to prevent.
  assert.deepEqual(counts, foldToolCallOutcomesV1(events));
  assert.equal(counts.coverage, "complete");
  assert.equal(counts.attempted, 2);
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.succeededWithWork, 1);
  assert.equal(counts.failureBuckets?.execution_failed, 1);
  assert.equal(counts.failureBuckets?.tool_not_allowed, 0, "a watched bucket that saw nothing is an EXPLICIT zero");
});

test("a plugin restart adds a segment and counting continues across it", () => {
  // The interrupted-continuation lane: segment 0 saw the pre-kill mission,
  // segment 1 armed against the new coordinator with replay and saw the
  // resumed run from its start (armedWhileRunning=false at re-arm time, or
  // running with a zero drop count).
  const restarted = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1)),
      segment(1, callPair(2), { armedWhileRunning: true, armDroppedEventCount: 0 }),
    ),
  );
  assert.equal(restarted.coverage, "complete");
  assert.equal(restarted.attempted, 4, "both segments' calls are counted");
  assert.equal(restarted.succeeded, 2);
  assert.equal(restarted.failed, 2);
  assert.equal(restarted.failureBuckets?.execution_failed, 2);
  // Segments are folded SEPARATELY, so a resumed run that re-issues the same
  // step:index ids cannot silently collapse two real calls into one.
  const reusedIds = summarizeCollectedToolCallsV1(
    raw(segment(0, callPair(1)), segment(1, callPair(1))),
  );
  assert.equal(reusedIds.attempted, 4);
});

test("a partial restart capture reports UNKNOWN, never a short count", () => {
  // Re-armed mid-run against a coordinator that had ALREADY dropped events:
  // replay can no longer supply the prefix, so the segment cannot prove it is
  // complete. One lossy segment degrades the whole answer.
  const dropped = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1)),
      segment(1, callPair(2), { armedWhileRunning: true, armDroppedEventCount: 3 }),
    ),
  );
  assert.equal(dropped.coverage, "lossy");
  assert.equal(dropped.attempted, null, "a partial count must be unknown, not a wrong number");
  assert.equal(dropped.failed, null);
  assert.equal(dropped.succeeded, null);
  assert.equal(dropped.failureBuckets, null);
  // The lower bounds stay visible as diagnostics only.
  assert.deepEqual(dropped.atLeast, { attempted: 4, failed: 2 });

  // A snapshot that would not say how many events it dropped is equally unknown.
  const unknownDrop = summarizeCollectedToolCallsV1(
    raw(segment(0, callPair(1), { armedWhileRunning: true, armDroppedEventCount: null })),
  );
  assert.equal(unknownDrop.coverage, "lossy");
  assert.equal(unknownDrop.attempted, null);

  // Overflowing the per-segment cap is the same class of failure.
  const overflowed = summarizeCollectedToolCallsV1(
    raw(segment(0, callPair(1), { overflowed: true })),
  );
  assert.equal(overflowed.coverage, "lossy");
  assert.equal(overflowed.attempted, null);
  assert.ok(TOOL_CALL_COLLECTOR_EVENT_CAP > 1_000, "the cap must sit far above any real lane");
});

test("drops AFTER a segment armed lose nothing: it was already listening", () => {
  // armedWhileRunning=false means the collector was subscribed before the run
  // started, so every live event reached it whatever the buffer later did.
  const counts = summarizeCollectedToolCallsV1(
    raw(segment(0, callPair(1), { armedWhileRunning: false, armDroppedEventCount: 9 })),
  );
  assert.equal(counts.coverage, "complete");
  assert.equal(counts.attempted, 2);
});

test("several harnesses in one test merge; unknown harvests are absorbed", () => {
  const first = foldToolCallOutcomesV1(callPair(1));
  const second = foldToolCallOutcomesV1(callPair(2));
  const unknown = unknownToolCallOutcomeCountsV1("unobserved");
  const merged = collectedToolCallCountsForTestV1([unknown, first, unknown, second]);
  assert.equal(merged.coverage, "complete");
  assert.equal(merged.attempted, 4);
  assert.equal(merged.failed, 2);
  // Nothing harvested at all stays unknown rather than becoming an empty zero.
  const nothing = collectedToolCallCountsForTestV1([]);
  assert.equal(nothing.coverage, "unobserved");
  assert.equal(nothing.attempted, null);
  // One lossy harvest contaminates the merge, by the primitive's rule.
  const lossy = foldToolCallOutcomesV1(callPair(3), { coverage: "lossy" });
  const contaminated = collectedToolCallCountsForTestV1([first, lossy]);
  assert.equal(contaminated.coverage, "lossy");
  assert.equal(contaminated.attempted, null);
});

/**
 * Source guard. The point of this wave is ONE instrumentation seat and ONE
 * counting authority; a lane that re-rolls either is how "two subsystems
 * disagree" gets re-introduced. These assertions fail on re-inlining, not on
 * behavior, which is the only way to catch it before a live campaign does.
 */
const WIRED_LANE_SPECS = [
  "e2e/real-ai-soak.spec.ts",
  "e2e/desktop-code-delivery-real-live.spec.ts",
  "e2e/interrupted-continuation-live.spec.ts",
  "e2e/notebook-execution-live.spec.ts",
  "e2e/daily-use-research.spec.ts",
];

test("every wired lane reaches the counters through the shared collector seam", () => {
  for (const relative of WIRED_LANE_SPECS) {
    const source = readRepoFile(relative);
    // assert.ok, not assert.match: a failing match dumps the whole spec file
    // into the report, which buries the one line that matters.
    assert.ok(
      /from "\.\/fixtures\/toolCallCollector"/u.test(source),
      `${relative} must import the shared tool-call collector`,
    );
    assert.ok(
      /recordToolCallOutcomesAfterEach\(\)/u.test(source),
      `${relative} must register the shared afterEach recorder`,
    );
    assert.ok(
      !/subscribeMissionEvents/u.test(source),
      `${relative} must not roll its own mission-event subscription`,
    );
    assert.ok(
      !/foldToolCallOutcomesV1|classifyToolReceiptWork|TOOL_REFUSAL_MARKER_BUCKETS/u.test(
        source,
      ),
      `${relative} must not classify tool outcomes itself`,
    );
  }
});

test("the mission-event subscription and the fold each have exactly one seat", () => {
  // daily-use-compound is the single grandfathered exception: its collector
  // predates this seam and ALSO harvests the DU-06 fast-validation diagnostic
  // from the same subscription. It still folds through the shared primitive,
  // which is the property that matters, and its explicit annotation outranks
  // the harness-wide fold in the reporter.
  const collector = readRepoFile("e2e/fixtures/toolCallCollector.ts");
  assert.ok(/subscribeMissionEvents/u.test(collector));
  assert.ok(/foldToolCallOutcomesV1/u.test(collector));
  // The collector must not grow its own counting: every judgment stays in
  // e2e/fixtures/toolCallOutcomes.ts.
  assert.ok(
    !/classifyToolReceiptWork|TOOL_REFUSAL_MARKER_BUCKETS/u.test(collector),
    "the collector must delegate receipt/bucket classification to the primitive",
  );

  const harness = readRepoFile("e2e/fixtures/realAiHarness.ts");
  assert.ok(
    /armToolCallCollector/u.test(harness),
    "the harness is the single arming seat",
  );
  assert.ok(/harvestToolCallCollector/u.test(harness));
  assert.ok(
    !/subscribeMissionEvents/u.test(harness),
    "the harness must arm through the collector, not subscribe directly",
  );
});

test("scripts share one nullable-count seat instead of re-inlining it", () => {
  for (const relative of [
    "scripts/run-proof-matrix.mjs",
    "scripts/run-targeted-protected-release.mjs",
  ]) {
    const source = readRepoFile(relative);
    assert.ok(
      /from "\.\/honest-counts\.mjs"/u.test(source),
      `${relative} must import the shared nullable-count helpers`,
    );
    assert.ok(
      !/function nullableCount\s*\(/u.test(source),
      `${relative} must not re-inline nullableCount`,
    );
  }
});

test("instrumentation can never fail a lane: a dead page harvests to unknown", async () => {
  resetToolCallCollectorStateForTestsV1();
  // A renderer that died mid-teardown, a closed page, an un-armable plugin:
  // every one of these must cost a row of missing data, not a thrown teardown
  // (nativeObsidianHarness rethrows a failing beforeClose out of close()).
  const dead = {
    isClosed: () => false,
    evaluate: () =>
      Promise.reject(new Error("Target page, context or browser has been closed")),
  } as any;
  await armToolCallCollector(dead);
  const counts = await harvestToolCallCollector(dead);
  assert.equal(counts.coverage, "unobserved");
  assert.equal(counts.attempted, null);
  resetToolCallCollectorStateForTestsV1();
});

test("a live peek reports exact counters without consuming the collector", async () => {
  const captured = raw(segment(0, callPair(1)));
  let reads = 0;
  const page = {
    evaluate: async () => {
      reads += 1;
      return captured;
    },
  } as any;
  const first = await peekToolCallCollector(page);
  const second = await peekToolCallCollector(page);
  assert.deepEqual(first, foldToolCallOutcomesV1(callPair(1)));
  assert.deepEqual(second, first);
  assert.equal(
    reads,
    2,
    "peek must leave the page-side slot available for teardown harvest",
  );
});

test("collector diagnostics expose only bounded event metadata", async () => {
  const captured = raw(
    segment(0, [
      {
        kind: "tool_done",
        id: "2:0:append_to_current_file",
        toolName: "append_to_current_file",
        ok: false,
        errorCode: "mission_graph_authority_blocked",
      },
      {
        kind: "receipt",
        id: "receipt-private-id",
        toolName: "append_to_current_file",
        receipt: {
          operation: "append",
          bytesWritten: 12,
          path: "must-not-escape.md",
        } as any,
      },
    ]),
  );
  const page = { evaluate: async () => captured } as any;

  assert.deepEqual(await peekToolCallCollectorDiagnosticsV1(page), [
    {
      segmentIndex: 0,
      kind: "tool_done",
      id: "2:0:append_to_current_file",
      toolName: "append_to_current_file",
      errorCode: "mission_graph_authority_blocked",
      ok: false,
      operation: null,
    },
    {
      segmentIndex: 0,
      kind: "receipt",
      id: null,
      toolName: "append_to_current_file",
      errorCode: null,
      ok: null,
      operation: "append",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(await peekToolCallCollectorDiagnosticsV1(page)),
    /must-not-escape|receipt-private-id/u,
  );
});

test("collector retains only bounded validation-verdict receipt fields", () => {
  const collector = readRepoFile("e2e/fixtures/toolCallCollector.ts");
  assert.match(collector, /receipt\?\.readback\?\.status === "verified"/u);
  assert.match(collector, /receipt\?\.purpose === "validation_fast"/u);
  assert.match(collector, /Number\.isSafeInteger\(receipt\?\.exitCode\)/u);
  // The digest allowlist is copied into the page because page.evaluate cannot
  // import; the copy must stay byte-identical to the module's regex.
  assert.ok(
    collector.includes(RECEIPT_IDENTITY_DIGEST.source),
    "the page-side digest allowlist must be a verbatim copy of RECEIPT_IDENTITY_DIGEST",
  );
  assert.match(collector, /digestOf\(receipt\?\.readback\?\.observedRevision\)/u);
  assert.match(collector, /digestOf\(receipt\?\.readback\?\.observedFingerprint\)/u);
  assert.doesNotMatch(
    collector,
    /receipt:\s*\{[^}]*\b(?:path|content|output|command)\s*:/su,
    "the page-side projection must not expose paths, payloads, or command output",
  );
});

test("harvests are keyed per test, so no spec can inherit another spec's counts", () => {
  // Playwright reuses one worker across spec files, and startRealAiHarness arms
  // for every lane — including the many specs that never register the recorder.
  // A flat module-level accumulator would annotate their harvests onto a later
  // spec's first test. Guarded at the source, because the failure is invisible
  // until a live campaign prints a wrong number.
  const collector = readRepoFile("e2e/fixtures/toolCallCollector.ts");
  assert.ok(
    /harvestsByTest\s*=\s*new Map</u.test(collector),
    "harvests must be keyed by test identity",
  );
  assert.ok(
    !/let\s+pendingHarvests/u.test(collector),
    "a flat, worker-global harvest accumulator leaks across spec files",
  );
  assert.ok(
    /harvestsByTest\.delete\(key\)/u.test(collector),
    "the recorder must consume its own entry so a retry cannot double count",
  );
});
