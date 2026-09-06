import assert from "node:assert/strict";
import test from "node:test";

import {
  armToolCallCollector,
  collectedToolCallCountsForTestV1,
  drainArmedToolCallCollectorsV1,
  harvestToolCallCollector,
  resetToolCallCollectorStateForTestsV1,
  summarizeCollectedToolCallsV1,
  type ToolCallCollectorRawV1,
  type ToolCallCollectorSegmentV1,
} from "../e2e/fixtures/toolCallCollector";
import {
  foldToolCallOutcomesV1,
  mergeToolCallOutcomeCountsV1,
  unknownToolCallOutcomeCountsV1,
  type ToolCallOutcomeEventV1,
} from "../e2e/fixtures/toolCallOutcomes";

/**
 * Capture-loss reproductions for the reliability-99 evidence lane.
 *
 * Every assertion here is paired with a POSITIVE-PROOF case: the honest answer
 * for lost capture is `lossy`/`unobserved`, and an instrument that can only
 * produce those is useless. So each loss case sits beside a case that must
 * still report exact `complete` counts, and each "unknown" case sits beside a
 * case proving the same code path can still produce a number.
 */

/** One succeeded call, one failed call. */
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
    coordinatorStartId: `scope-${index}`,
    runId: `run-${index}`,
    events,
    ...overrides,
  };
}

function raw(...segments: ToolCallCollectorSegmentV1[]): ToolCallCollectorRawV1 {
  return { version: 1, segments };
}

// --------------------------------------------------------------------------
// 1. Deduplication across two arms of the SAME coordinator start.
// --------------------------------------------------------------------------

test("two arms against ONE coordinator start count each call once", () => {
  // `armToolCallCollector` subscribes with `replay: true`. Arming twice without
  // a plugin restart therefore replays the prefix segment 0 already recorded.
  // Folding the segments separately and summing DOUBLE COUNTS every call the
  // replay repeated.
  const replayed = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1), { coordinatorStartId: "scope-a" }),
      segment(1, callPair(1), { coordinatorStartId: "scope-a", armedWhileRunning: true }),
    ),
  );
  assert.equal(replayed.coverage, "complete");
  assert.equal(replayed.attempted, 2, "one coordinator start is one id namespace");
  assert.equal(replayed.succeeded, 1);
  assert.equal(replayed.failed, 1);

  // POSITIVE PROOF the grouping is not just collapsing everything: a real
  // plugin restart is a DIFFERENT coordinator start, so re-issued
  // `step:index:name` ids stay two distinct calls.
  const restarted = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1), { coordinatorStartId: "scope-a" }),
      segment(1, callPair(1), { coordinatorStartId: "scope-b" }),
    ),
  );
  assert.equal(restarted.coverage, "complete");
  assert.equal(restarted.attempted, 4, "distinct coordinator starts keep distinct calls");
  assert.equal(restarted.failed, 2);
});

test("a multi-segment capture that cannot name its coordinator is unknown", () => {
  // Two segments with events and no identity: they may be one namespace
  // (double count) or two (short count) and the capture cannot tell. Unknown.
  const anonymous = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1), { coordinatorStartId: null }),
      segment(1, callPair(2), { coordinatorStartId: null }),
    ),
  );
  assert.equal(anonymous.coverage, "lossy");
  assert.equal(anonymous.attempted, null);
  assert.deepEqual(anonymous.atLeast, { attempted: 4, failed: 2 });

  // POSITIVE PROOF: a SINGLE anonymous segment has nothing to disambiguate
  // against and still reports exact counts, so this guard cannot be satisfied
  // by simply refusing to count.
  const single = summarizeCollectedToolCallsV1(
    raw(segment(0, callPair(1), { coordinatorStartId: null })),
  );
  assert.equal(single.coverage, "complete");
  assert.equal(single.attempted, 2);

  // An anonymous segment that observed NOTHING cannot double count anything,
  // so it must not poison a segment that did observe.
  const emptyAnonymous = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1), { coordinatorStartId: "scope-a" }),
      segment(1, [], { coordinatorStartId: null }),
    ),
  );
  assert.equal(emptyAnonymous.coverage, "complete");
  assert.equal(emptyAnonymous.attempted, 2);
});

// --------------------------------------------------------------------------
// 2. A harvest that THREW on an armed page is lost capture, not "nothing".
// --------------------------------------------------------------------------

test("a failed harvest on an ARMED page degrades the answer to lossy", async () => {
  resetToolCallCollectorStateForTestsV1();
  let armed = false;
  const page = {
    isClosed: () => false,
    evaluate: async () => {
      if (!armed) {
        armed = true;
        return true;
      }
      throw new Error("Target page, context or browser has been closed");
    },
  } as any;
  await armToolCallCollector(page);
  const counts = await harvestToolCallCollector(page);
  assert.equal(
    counts.coverage,
    "lossy",
    "we know we were capturing and we lost it; that is not the same as never listening",
  );

  // The merge must NOT absorb it. This is the false-green shape: one dead
  // harness beside one good one previously reported `complete`.
  const good = foldToolCallOutcomesV1(callPair(1));
  const merged = collectedToolCallCountsForTestV1([good, counts]);
  assert.equal(merged.coverage, "lossy");
  assert.equal(merged.attempted, null);

  // POSITIVE PROOF: a page that was never armable is still `unobserved`, and a
  // genuinely empty harvest list is still absorbed, so this does not turn every
  // lane lossy.
  resetToolCallCollectorStateForTestsV1();
  const neverArmable = {
    isClosed: () => false,
    evaluate: async () => {
      throw new Error("no plugin here");
    },
  } as any;
  await armToolCallCollector(neverArmable);
  const unarmed = await harvestToolCallCollector(neverArmable);
  assert.equal(unarmed.coverage, "unobserved");
  assert.equal(
    collectedToolCallCountsForTestV1([good, unarmed]).coverage,
    "complete",
  );
  resetToolCallCollectorStateForTestsV1();
});

// --------------------------------------------------------------------------
// 3. An armed page destroyed without a harvest (owned-process relaunch).
// --------------------------------------------------------------------------

test("an armed page that closed unharvested reports lost capture", async () => {
  resetToolCallCollectorStateForTestsV1();
  let closed = false;
  const page = {
    isClosed: () => closed,
    evaluate: async () => true,
  } as any;
  await armToolCallCollector(page);
  // relaunchOwnedProcess destroys the renderer; window.__agenticToolCallCollectorV1
  // and every segment in it go with it.
  closed = true;
  const drained = await drainArmedToolCallCollectorsV1();
  assert.equal(drained.length, 1);
  assert.equal(
    drained[0]!.coverage,
    "lossy",
    "a destroyed armed capture is lost data, not absent data",
  );

  // POSITIVE PROOF: a page still open is harvested normally and yields counts.
  resetToolCallCollectorStateForTestsV1();
  const live = {
    isClosed: () => false,
    evaluate: async (_fn: unknown, arg: any) =>
      arg?.consumeSlot === undefined ? true : raw(segment(0, callPair(1))),
  } as any;
  await armToolCallCollector(live);
  const harvested = await drainArmedToolCallCollectorsV1();
  assert.equal(harvested.length, 1);
  assert.equal(harvested[0]!.coverage, "complete");
  assert.equal(harvested[0]!.attempted, 2);
  resetToolCallCollectorStateForTestsV1();
});

// --------------------------------------------------------------------------
// 4. A declared-lossy fold that saw nothing must stay lossy.
// --------------------------------------------------------------------------

test("a lossy capture with zero events is lossy, not unobserved", () => {
  const empty = foldToolCallOutcomesV1([], { coverage: "lossy" });
  assert.equal(
    empty.coverage,
    "lossy",
    "the caller PROVED the capture was holed; an empty result does not un-prove it",
  );
  assert.deepEqual(empty.atLeast, { attempted: 0, failed: 0 });

  // The whole point: merged with a complete segment it must contaminate.
  const merged = mergeToolCallOutcomeCountsV1(foldToolCallOutcomesV1(callPair(1)), empty);
  assert.equal(merged.coverage, "lossy");
  assert.equal(merged.attempted, null);

  // POSITIVE PROOF: an undeclared empty stream is still `unobserved` and is
  // still absorbed by the merge.
  const unobserved = foldToolCallOutcomesV1([]);
  assert.equal(unobserved.coverage, "unobserved");
  assert.equal(
    mergeToolCallOutcomeCountsV1(foldToolCallOutcomesV1(callPair(1)), unobserved).coverage,
    "complete",
  );
});

test("a restart segment that armed after drops and saw nothing still degrades", () => {
  // The exact live shape: segment 0 saw the pre-restart mission, segment 1
  // re-armed against a coordinator that had already dropped events and then
  // observed nothing because the resume finished first. Previously this
  // reported `complete` from segment 0 alone.
  const counts = summarizeCollectedToolCallsV1(
    raw(
      segment(0, callPair(1), { coordinatorStartId: "scope-a" }),
      segment(1, [], {
        coordinatorStartId: "scope-b",
        armedWhileRunning: true,
        armDroppedEventCount: 4,
      }),
    ),
  );
  assert.equal(counts.coverage, "lossy");
  assert.equal(counts.attempted, null);
  assert.deepEqual(counts.atLeast, { attempted: 2, failed: 1 });
});

// --------------------------------------------------------------------------
// 5. Actual transport versus cached fallback.
// --------------------------------------------------------------------------

test("cached serves and real transports are counted apart, and unknown stays null", () => {
  const events: ToolCallOutcomeEventV1[] = [
    ...callPair(1),
    { kind: "tool_execution", toolName: "web_fetch", step: 1, servedFromCache: true },
    { kind: "tool_execution", toolName: "web_search", step: 1, servedFromCache: false },
    { kind: "tool_execution", toolName: "web_fetch", step: 2, servedFromCache: true },
  ];
  const counts = foldToolCallOutcomesV1(events);
  assert.equal(counts.coverage, "complete");
  assert.equal(counts.servedFromCache, 2);
  assert.equal(counts.transportExecuted, 1);
  // A cached serve is still an attempted call; cache is a claim about
  // transport, never about outcome.
  assert.equal(counts.attempted, 2);

  // Unknown, never zero: a stream with no execution metrics proves nothing
  // about transport.
  const noMetrics = foldToolCallOutcomesV1(callPair(1));
  assert.equal(noMetrics.servedFromCache, null);
  assert.equal(noMetrics.transportExecuted, null);

  // A segment armed mid-run replays metrics, which carry no id and cannot be
  // de-duplicated, so its retrieval counters are unknown -- and unknown
  // propagates through the merge instead of being read as zero.
  const midRun = summarizeCollectedToolCallsV1(
    raw(
      segment(0, events, { coordinatorStartId: "scope-a" }),
      segment(1, callPair(2), {
        coordinatorStartId: "scope-b",
        armedWhileRunning: true,
        armDroppedEventCount: 0,
      }),
    ),
  );
  assert.equal(midRun.coverage, "complete", "call counting still works across the restart");
  assert.equal(midRun.attempted, 4);
  assert.equal(midRun.servedFromCache, null, "an unknown side must not be summed as zero");
  assert.equal(midRun.transportExecuted, null);
});

test("unknown counts include the retrieval counters and survive JSON", () => {
  const unknown = unknownToolCallOutcomeCountsV1("lossy");
  assert.equal(unknown.servedFromCache, null);
  assert.equal(unknown.transportExecuted, null);
  const parsed = JSON.parse(JSON.stringify(unknown));
  assert.ok("servedFromCache" in parsed, "null must be emitted explicitly, not dropped");
  assert.ok("transportExecuted" in parsed);
  assert.equal(parsed.servedFromCache, null);
});

test("execution metrics alone are a HOLED capture, never a complete zero", () => {
  // Regression found by Agent 2's review of 6ad4f0f. Counting execution
  // sightings as observed events lifted a metric-only stream past the
  // unknown-counts branch, so it reported `complete, attempted: 0` while its
  // own `transportExecuted: 1` said a tool had actually run. A row that
  // contradicts itself is worse than a missing row: a completeness predicate
  // accepts it.
  //
  // Reachable when a segment armed late or lost its trace subscription while
  // metrics survived.
  const metricsOnly = foldToolCallOutcomesV1([
    { kind: "tool_execution", toolName: "web_search", step: 1, servedFromCache: false },
    { kind: "tool_execution", toolName: "web_fetch", step: 2, servedFromCache: true },
  ]);
  assert.notEqual(metricsOnly.coverage, "complete");
  assert.equal(metricsOnly.coverage, "lossy");
  assert.equal(metricsOnly.attempted, null);
  assert.equal(metricsOnly.failed, null);
  assert.equal(metricsOnly.failureBuckets, null, "no explicit zero buckets to satisfy a gate");
  assert.equal(metricsOnly.observedEvents, 2, "the sightings are still reported as seen");

  // It must not launder itself through the merge either.
  const merged = mergeToolCallOutcomeCountsV1(
    metricsOnly,
    unknownToolCallOutcomeCountsV1("unobserved"),
  );
  assert.equal(merged.coverage, "lossy");
  assert.equal(merged.attempted, null);

  // ANTI-VACUITY PAIRING: this must not be satisfied by making everything
  // lossy. A real call stream WITH an execution metric still counts exactly.
  const realStream = foldToolCallOutcomesV1([
    { kind: "tool_start", id: "1:0:web_search", toolName: "web_search" },
    { kind: "tool_done", id: "1:0:web_search", toolName: "web_search", ok: true, errorCode: null },
    { kind: "tool_execution", toolName: "web_search", step: 1, servedFromCache: false },
  ]);
  assert.equal(realStream.coverage, "complete");
  assert.equal(realStream.attempted, 1);
  assert.equal(realStream.succeeded, 1);
  assert.equal(realStream.transportExecuted, 1);

  // And a genuinely empty stream is still `unobserved`, not upgraded to lossy.
  assert.equal(foldToolCallOutcomesV1([]).coverage, "unobserved");
});
