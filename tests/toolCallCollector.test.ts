import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOOL_CALL_COLLECTOR_EVENT_CAP,
  TOOL_CALL_COLLECTOR_SLOT,
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
  projectToolFailureMessageV1,
  unknownToolCallOutcomeCountsV1,
  type ToolCallOutcomeEventV1,
  RECEIPT_IDENTITY_DIGEST,
  TOOL_CALL_FAILURE_MESSAGE_CAP,
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
      // This producer reported no message, which is unknown — the diagnostic
      // says so rather than inventing an empty observation.
      errorMessage: null,
      ok: false,
      operation: null,
    },
    {
      segmentIndex: 0,
      kind: "receipt",
      id: null,
      toolName: "append_to_current_file",
      errorCode: null,
      errorMessage: null,
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

/*
 * ---------------------------------------------------------------------------
 * The PAGE-SIDE PRODUCER, driven directly.
 *
 * Every test above hands the fold events a TEST built, which says nothing about
 * the only question a dead cohort needed answered: does the real producer ever
 * build an event carrying a failure MESSAGE? A 504-run qualification cohort
 * ended on `errorCode: "project_idea_brief_invalid"` — a code eight different
 * broken rules raise, each with its own sentence — and the retained record could
 * not name which rule broke, so the answer cost another twelve-minute lane run.
 *
 * The producer on the live path is NOT `normalizeMissionToolEventV1` (nothing
 * outside tests calls it). It is the function Playwright serializes into the
 * renderer inside `armToolCallCollector`, and it projected the code alone. So
 * these tests install a fake window, arm the REAL collector against it, and fire
 * realistic mission events at the handlers it actually subscribed with: a
 * hand-built `ToolCallOutcomeEventV1` would re-prove the fold and re-miss the
 * boundary, which is the shape this repo has already shipped twice.
 * ---------------------------------------------------------------------------
 */

interface FakeMissionHandlers {
  onStatus?: (message: unknown) => void;
  onTrace?: (event: unknown) => void;
  onToolDone?: (event: unknown) => void;
  onReceipt?: (receipt: unknown) => void;
  onMetric?: (event: unknown) => void;
}

interface FakeRenderer {
  page: any;
  handlers: FakeMissionHandlers;
  /** Raw page-side events, exactly as the producer pushed them. */
  events: () => any[];
  /** The free-form status/trace ring, which no failure message may reach. */
  recent: () => string[];
}

/**
 * Install a fake Obsidian window, arm the real collector against it, and return
 * the handlers it subscribed with. `evaluate` really invokes the function it is
 * handed, so the code under test is the code that runs in the renderer.
 */
async function armAgainstFakeRenderer(): Promise<FakeRenderer> {
  const captured: { handlers: FakeMissionHandlers } = { handlers: {} };
  (globalThis as Record<string, unknown>).window = {
    app: {
      plugins: {
        plugins: {
          "agentic-researcher": {
            getMissionRunSnapshot: () => ({
              isRunning: false,
              runId: "run-1",
              droppedEventCount: 0,
              providerUsageScopeId: "scope-1",
            }),
            subscribeMissionEvents: (handlers: FakeMissionHandlers) => {
              captured.handlers = handlers;
              return () => undefined;
            },
          },
        },
      },
    },
  };
  const pageErrors: unknown[] = [];
  const page = {
    isClosed: () => false,
    evaluate: async (fn: (arg: any) => unknown, arg: unknown) => {
      try {
        return await fn(arg as any);
      } catch (error) {
        // `armToolCallCollector` swallows page failures on purpose, so without
        // this a broken page-side projection would present as "no events".
        pageErrors.push(error);
        throw error;
      }
    },
  } as any;
  await armToolCallCollector(page);
  assert.deepEqual(pageErrors, [], "the page-side collector threw while arming");
  const slot = (): any => (globalThis as any).window?.[TOOL_CALL_COLLECTOR_SLOT];
  assert.ok(slot(), "arming must install the page-side collector slot");
  assert.ok(
    typeof captured.handlers.onToolDone === "function",
    "arming must subscribe the mission-event handlers under test",
  );
  return {
    page,
    handlers: captured.handlers,
    events: () => slot().segments[0].events,
    recent: () => slot().recent,
  };
}

function releaseFakeRenderer(): void {
  delete (globalThis as Record<string, unknown>).window;
  resetToolCallCollectorStateForTestsV1();
}

test("the page-side producer carries the failure MESSAGE beside the code, in both shapes", async () => {
  const renderer = await armAgainstFakeRenderer();
  try {
    // The `onTrace` shape: a tool_result whose error names the broken rule.
    renderer.handlers.onTrace?.({
      kind: "tool_result",
      id: "3:0:create_project_idea_brief:result",
      toolName: "create_project_idea_brief",
      error: {
        code: "project_idea_brief_invalid",
        message: "acceptance criterion 2 does not name a measurable check",
      },
    });
    // The `onToolDone` shape: ok:false plus the same error object.
    renderer.handlers.onToolDone?.({
      id: "3:1:code_run",
      name: "code_run",
      step: 3,
      ok: false,
      error: {
        code: "sandbox_prepare_rejected",
        message: "workspace name is already owned by another run",
      },
    });
    // The third failure-bearing kind, a standalone refusal.
    renderer.handlers.onTrace?.({
      kind: "tool_rejected",
      id: "3:2:append_to_current_file",
      toolName: "append_to_current_file",
      error: {
        code: "mission_graph_authority_blocked",
        message: "no graph-ready slot authorizes an append here",
      },
    });

    assert.deepEqual(
      renderer
        .events()
        .map((event) => [event.kind, event.errorCode, event.errorMessage]),
      [
        [
          "tool_result",
          "project_idea_brief_invalid",
          "acceptance criterion 2 does not name a measurable check",
        ],
        [
          "tool_done",
          "sandbox_prepare_rejected",
          "workspace name is already owned by another run",
        ],
        [
          "tool_rejected",
          "mission_graph_authority_blocked",
          "no graph-ready slot authorizes an append here",
        ],
      ],
    );

    // The message goes into the event object and NOWHERE else. The recent ring
    // is free-form text the harness prints when a coordinator fails to settle;
    // a message that can carry a forwarded credential must not land there.
    const ring = renderer.recent().join("\n");
    for (const sentence of [
      "does not name a measurable check",
      "already owned by another run",
      "no graph-ready slot",
    ]) {
      assert.ok(
        !ring.includes(sentence),
        `a failure message must never be logged into the status ring (${sentence})`,
      );
    }
  } finally {
    releaseFakeRenderer();
  }
});

test("a page-side failure message survives the whole path to failureDetails", async () => {
  const renderer = await armAgainstFakeRenderer();
  try {
    const sentence = "acceptance criterion 2 does not name a measurable check";
    renderer.handlers.onTrace?.({
      kind: "tool_start",
      id: "3:0:create_project_idea_brief:start",
      toolName: "create_project_idea_brief",
    });
    renderer.handlers.onTrace?.({
      kind: "tool_result",
      id: "3:0:create_project_idea_brief:result",
      toolName: "create_project_idea_brief",
      error: { code: "project_idea_brief_invalid", message: sentence },
    });
    renderer.handlers.onTrace?.({
      kind: "tool_start",
      id: "3:1:web_search:start",
      toolName: "web_search",
    });
    renderer.handlers.onToolDone?.({
      id: "3:1:web_search",
      name: "web_search",
      ok: true,
    });

    // The live diagnosis path...
    const peeked = await peekToolCallCollector(renderer.page);
    assert.equal(peeked.failureDetails?.length, 1);
    assert.equal(peeked.failureDetails?.[0]?.errorMessage, sentence);
    const diagnostics = await peekToolCallCollectorDiagnosticsV1(renderer.page);
    assert.equal(
      diagnostics.find((entry) => entry.errorCode === "project_idea_brief_invalid")
        ?.errorMessage,
      sentence,
    );

    // ...and the durable-record path, which is what a cohort keeps.
    const counts = await harvestToolCallCollector(renderer.page);
    assert.equal(counts.coverage, "complete");
    assert.equal(counts.attempted, 2);
    assert.equal(counts.failed, 1);
    assert.equal(counts.succeeded, 1);
    const detail = counts.failureDetails?.[0];
    assert.equal(detail?.id, "3:0:create_project_idea_brief");
    assert.equal(detail?.toolName, "create_project_idea_brief");
    assert.equal(detail?.errorCode, "project_idea_brief_invalid");
    assert.equal(
      detail?.errorMessage,
      sentence,
      "the cohort-ending code must arrive with the sentence that names its rule",
    );
    // The end of the path is the assertion string a lane actually prints.
    assert.match(
      JSON.stringify(counts.failureDetails),
      /does not name a measurable check/u,
    );
  } finally {
    releaseFakeRenderer();
  }
});

/**
 * Probes chosen for what each one PROVES, not for coverage: a rule sentence
 * that must survive whole, prose that merely contains the word "token" and must
 * not be mangled into noise, and the four shapes a message can smuggle across
 * the renderer boundary — a vault path, a shell command with a flag-named
 * secret, a bearer credential, a URL with a key in it — plus a stack trace that
 * must be bounded and a blank message that must read as unobserved.
 */
const MESSAGE_PROBES = [
  "acceptance criterion 2 does not name a measurable check",
  "the authority grant token is invalid",
  "failed writing Research/Private Client Note.md",
  "python3 /home/user/secrets/run_payroll.py --token abc123",
  "provider rejected Bearer sk-live-0123456789abcdef",
  "fetch failed for https://api.example.com/v1/items?api_key=abcdef123456",
  `boom\n    at Object.<anonymous>\n${"    at frame (deep stack) ".repeat(20)}`,
  "   \n\t  ",
  "",
];

test("the page-side projection is behaviorally identical to the module's projector", async () => {
  const renderer = await armAgainstFakeRenderer();
  try {
    MESSAGE_PROBES.forEach((probe, index) => {
      renderer.handlers.onToolDone?.({
        id: `9:${index}:code_run`,
        name: "code_run",
        ok: false,
        error: { code: "execution_failed", message: probe },
      });
    });
    const projected: (string | null)[] = renderer
      .events()
      .map((event) => event.errorMessage);

    // The pin: the page-side copy and the module that owns it must agree on
    // every probe. Equality alone could be satisfied by two matching mistakes,
    // so the properties that matter are named individually below.
    assert.deepEqual(
      projected,
      MESSAGE_PROBES.map((probe) => projectToolFailureMessageV1(probe)),
      "the page-side copy has drifted from projectToolFailureMessageV1",
    );

    const [rule, grant, notePath, command, bearer, url, stack, blank, empty] =
      projected;
    assert.equal(rule, MESSAGE_PROBES[0], "a rule sentence must survive whole");
    assert.equal(
      grant,
      MESSAGE_PROBES[1],
      "prose that merely says 'token' must not be mangled into noise",
    );
    assert.ok(
      !String(notePath).includes("Private Client Note") &&
        !String(notePath).includes(".md"),
      "a vault path must not cross the renderer boundary",
    );
    assert.ok(
      !String(command).includes("/home/user/secrets") &&
        !String(command).includes("abc123"),
      "a command path and its flag-named secret must not cross",
    );
    assert.ok(
      !String(bearer).includes("sk-live-0123456789abcdef"),
      "a bearer credential must not cross",
    );
    assert.ok(
      !String(url).includes("api.example.com") &&
        !String(url).includes("abcdef123456"),
      "a URL and the key inside it must not cross",
    );
    // Positive proof the redactor did not simply blank everything: each of
    // those four still names its failure.
    for (const [label, value] of [
      ["path", notePath],
      ["command", command],
      ["bearer", bearer],
      ["url", url],
    ] as const) {
      assert.ok(
        String(value).length > 0 && /[a-z]{4,}/u.test(String(value)),
        `the redacted ${label} message must still say something`,
      );
    }
    assert.ok(
      String(stack).length <= TOOL_CALL_FAILURE_MESSAGE_CAP,
      "an echoed stack trace must be bounded before it crosses",
    );
    assert.ok(!String(stack).includes("\n"), "the message must be single-line");
    assert.equal(blank, null, "a whitespace-only message is unobserved");
    assert.equal(empty, null, "an empty message is unobserved");
  } finally {
    releaseFakeRenderer();
  }
});

test("an error with no message reads as unobserved, never as an empty observation", async () => {
  const renderer = await armAgainstFakeRenderer();
  try {
    // No `message` at all: the common shape for a typed refusal.
    renderer.handlers.onToolDone?.({
      id: "4:0:web_search",
      name: "web_search",
      ok: false,
      error: { code: "execution_failed" },
    });
    // A message that redacts away to nothing must land in the same place.
    renderer.handlers.onTrace?.({
      kind: "tool_result",
      id: "4:1:web_fetch:result",
      toolName: "web_fetch",
      error: { code: "execution_failed", message: "   \n  " },
    });
    renderer.handlers.onToolDone?.({
      id: "4:2:append_to_current_file",
      name: "append_to_current_file",
      ok: true,
    });

    for (const event of renderer.events()) {
      assert.ok(
        "errorMessage" in event,
        "the field must be emitted explicitly, so null survives JSON.stringify",
      );
      assert.equal(event.errorMessage, null);
      assert.notEqual(event.errorMessage, "", "empty string is an observation");
    }

    // An unobserved message must not make an otherwise complete capture look
    // lossy, and must not cost the observation a single count.
    const counts = await harvestToolCallCollector(renderer.page);
    assert.equal(counts.coverage, "complete");
    assert.equal(counts.attempted, 3);
    assert.equal(counts.failed, 2);
    assert.equal(counts.succeeded, 1);
    assert.deepEqual(
      counts.failureDetails?.map((entry) => entry.errorMessage),
      [null, null],
    );
    assert.deepEqual(
      counts.failureDetails?.map((entry) => entry.errorCode),
      ["execution_failed", "execution_failed"],
    );
  } finally {
    releaseFakeRenderer();
  }
});

test("the page-side redaction copy is pinned to the module that owns it", () => {
  const collector = readRepoFile("e2e/fixtures/toolCallCollector.ts");
  const outcomes = readRepoFile("e2e/fixtures/toolCallOutcomes.ts");
  const start = collector.indexOf("const messageRedactions");
  const end = collector.indexOf("const push =", start);
  assert.ok(
    start > 0 && end > start,
    "the page-side message projection must exist between codeOf and push",
  );
  // Line comments go first: this block explains the redaction in prose, and a
  // lexical check that cannot tell prose from code would fire on the
  // explanation — a trap this repo has already sprung twice.
  const pageSide = collector.slice(start, end).replace(/^[ \t]*\/\/.*$/gmu, "");
  const literals =
    pageSide.match(/\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/gu) ?? [];
  // Non-vacuity: an extraction that found nothing would satisfy the loop below
  // and prove nothing. Eight redaction rules plus the whitespace collapse.
  assert.ok(
    literals.length >= 9,
    `expected the redaction table and the collapse, extracted ${literals.length}`,
  );
  for (const literal of literals) {
    assert.ok(
      outcomes.includes(literal),
      `page-side ${literal} is not a verbatim copy of a rule in toolCallOutcomes.ts`,
    );
  }
  assert.ok(
    pageSide.includes(`const messageCap = ${TOOL_CALL_FAILURE_MESSAGE_CAP};`),
    "the page-side cap must equal TOOL_CALL_FAILURE_MESSAGE_CAP",
  );
});
