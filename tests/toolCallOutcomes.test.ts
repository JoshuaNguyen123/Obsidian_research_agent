import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyToolFailureBucketV1,
  foldToolCallOutcomesV1,
  mergeToolCallOutcomeCountsV1,
  normalizeMissionToolEventV1,
  TOOL_CALL_FAILURE_DETAIL_CAP,
  TOOL_CALL_FAILURE_BUCKET_KEYS,
  toolCallOutcomeAcceptanceCountersV1,
  unknownToolCallOutcomeCountsV1,
  type ToolCallOutcomeEventV1,
} from "../e2e/fixtures/toolCallOutcomes";

/**
 * A synthetic stream with KNOWN outcomes. Every count these tests assert is
 * arithmetic over this fixture, so a regression in the fold shows up as an
 * exact-number mismatch rather than a plausible-looking drift.
 *
 * Call ids follow the runner's real convention (`${step}:${index}:${name}`),
 * with traces suffixed `:start` / `:result` and refusals suffixed further.
 */
function call(
  step: number,
  index: number,
  name: string,
): { base: string; start: ToolCallOutcomeEventV1 } {
  const base = `${step}:${index}:${name}`;
  return {
    base,
    start: { kind: "tool_start", id: `${base}:start`, toolName: name },
  };
}

function ok(base: string, name: string): ToolCallOutcomeEventV1[] {
  return [
    { kind: "tool_done", id: base, toolName: name, ok: true, errorCode: null },
    { kind: "tool_result", id: `${base}:result`, toolName: name, errorCode: null },
  ];
}

function failed(
  base: string,
  name: string,
  code: string,
): ToolCallOutcomeEventV1[] {
  return [
    { kind: "tool_done", id: base, toolName: name, ok: false, errorCode: code },
    { kind: "tool_result", id: `${base}:result`, toolName: name, errorCode: code },
  ];
}

/**
 * Two successes, two failures (distinct buckets), one standalone refusal,
 * and one call that started and never finished.
 */
function knownStream(): ToolCallOutcomeEventV1[] {
  const a = call(1, 0, "web_search");
  const b = call(1, 1, "read_current_file");
  const c = call(2, 0, "append_to_current_file");
  const d = call(2, 1, "create_file");
  const e = call(3, 0, "linear_create_issue");
  return [
    a.start,
    ...ok(a.base, "web_search"),
    b.start,
    ...ok(b.base, "read_current_file"),
    c.start,
    ...failed(c.base, "append_to_current_file", "execution_failed"),
    d.start,
    ...failed(d.base, "create_file", "invalid_argument_path"),
    // Standalone refusal: never entered execution, so no start and no done.
    {
      kind: "tool_rejected",
      id: "3:1:github_create_pull_request",
      toolName: "github_create_pull_request",
      errorCode: "tool_not_allowed",
    },
    // Started, never terminated (the run was cut off mid-call).
    e.start,
  ];
}

test("a known stream folds to exact counts, and attempted includes failures", () => {
  const counts = foldToolCallOutcomesV1(knownStream());

  assert.equal(counts.coverage, "complete");
  // 4 executed + 1 refused + 1 unterminated = 6 distinct logical calls.
  assert.equal(counts.attempted, 6);
  assert.equal(counts.succeeded, 2);
  assert.equal(counts.failed, 3);
  assert.equal(counts.undetermined, 1);
  // The invariant the whole fold rests on.
  assert.equal(
    counts.succeeded! + counts.failed! + counts.undetermined!,
    counts.attempted,
  );
  assert.deepEqual(counts.failureBuckets, {
    tool_not_allowed: 1,
    // Host-caused off-frontier refusals split out of tool_not_allowed. Like
    // every other bucket, an untouched one is an EXPLICIT 0, never absent.
    frontier_narrowed_mid_response: 0,
    frontier_withheld_since_earlier_step: 0,
    mission_graph_authority_blocked: 0,
    invalid_arguments: 1,
    execution_failed: 1,
    authority_grant_invalid: 0,
    tool_failure_terminal: 0,
    other: 0,
  });
  assert.deepEqual(counts.failureDetails, [
    {
      id: "2:0:append_to_current_file",
      toolName: "append_to_current_file",
      errorCode: "execution_failed",
      bucket: "execution_failed",
    },
    {
      id: "2:1:create_file",
      toolName: "create_file",
      errorCode: "invalid_argument_path",
      bucket: "invalid_arguments",
    },
    {
      id: "3:1:github_create_pull_request",
      toolName: "github_create_pull_request",
      errorCode: "tool_not_allowed",
      bucket: "tool_not_allowed",
    },
  ]);
  assert.equal(counts.failureDetailsTruncated, false);
});

test("a failed call is counted as attempted AND failed, never dropped", () => {
  const c = call(2, 0, "append_to_current_file");
  const counts = foldToolCallOutcomesV1([
    c.start,
    ...failed(c.base, "append_to_current_file", "execution_failed"),
  ]);

  assert.equal(counts.attempted, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.succeeded, 0);
  // This is the whole point: evidenceFromToolResult would have yielded
  // nothing at all for this call, so both numbers would have been 0.
  assert.equal(counts.failureBuckets?.execution_failed, 1);
});

test("an ok:false done and its tool_rejected twin are ONE failed call", () => {
  const c = call(5, 0, "append_to_current_file");
  const counts = foldToolCallOutcomesV1([
    c.start,
    {
      kind: "tool_done",
      id: c.base,
      toolName: "append_to_current_file",
      ok: false,
      errorCode: "mission_graph_authority_blocked",
    },
    {
      kind: "tool_rejected",
      id: `${c.base}:graph-rejected`,
      toolName: "append_to_current_file",
      errorCode: "mission_graph_authority_blocked",
    },
  ]);

  assert.equal(counts.attempted, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.failureBuckets?.mission_graph_authority_blocked, 1);
});

test("a vacuous success is attempted+succeeded but never counts as work", () => {
  const c = call(1, 0, "append_to_current_file");
  const counts = foldToolCallOutcomesV1([
    c.start,
    ...ok(c.base, "append_to_current_file"),
    {
      kind: "receipt",
      id: "receipt-1",
      toolName: "append_to_current_file",
      receipt: { operation: "append", effects: { changed: false } },
    },
  ]);

  assert.equal(counts.attempted, 1);
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.failed, 0);
  assert.equal(counts.vacuous, 1);
  assert.equal(counts.intentionalNoOp, 0);
  // The user's numerator excludes it: called, returned ok, did no work.
  assert.equal(counts.succeededWithWork, 0);
});

test("a real success keeps its work credit", () => {
  const c = call(1, 0, "append_to_current_file");
  const counts = foldToolCallOutcomesV1([
    c.start,
    ...ok(c.base, "append_to_current_file"),
    {
      kind: "receipt",
      id: "receipt-1",
      toolName: "append_to_current_file",
      receipt: { operation: "append", effects: { changed: true } },
    },
  ]);

  assert.equal(counts.vacuous, 0);
  assert.equal(counts.succeededWithWork, 1);
});

test("intentional no-ops are their own bucket, not vacuous, and keep work credit", () => {
  const c = call(1, 0, "create_file");
  const counts = foldToolCallOutcomesV1([
    c.start,
    ...ok(c.base, "create_file"),
    {
      kind: "receipt",
      id: "r-noop",
      toolName: "create_file",
      receipt: { operation: "create", commitKind: "no_op" },
    },
    {
      kind: "receipt",
      id: "r-reconciled",
      toolName: "create_file",
      receipt: { operation: "create", commitKind: "reconciled" },
    },
  ]);

  assert.equal(counts.intentionalNoOp, 2);
  assert.equal(counts.vacuous, 0);
  // A correct idempotent replay is not a failure to do work.
  assert.equal(counts.succeededWithWork, 1);
});

test("a receipt with no usable work signal is unknown, never guessed", () => {
  const c = call(1, 0, "read_current_file");
  const counts = foldToolCallOutcomesV1([
    c.start,
    ...ok(c.base, "read_current_file"),
    {
      kind: "receipt",
      id: "r-read",
      toolName: "read_current_file",
      receipt: { operation: "read" as unknown },
    },
  ]);

  assert.equal(counts.receiptsUnknown, 1);
  assert.equal(counts.vacuous, 0);
  assert.equal(counts.intentionalNoOp, 0);
});

test("an unobserved stream yields null everywhere, never zero", () => {
  const counts = foldToolCallOutcomesV1([]);

  assert.equal(counts.coverage, "unobserved");
  assert.equal(counts.attempted, null);
  assert.equal(counts.succeeded, null);
  assert.equal(counts.failed, null);
  assert.equal(counts.vacuous, null);
  assert.equal(counts.intentionalNoOp, null);
  assert.equal(counts.failureBuckets, null);
  assert.equal(counts.observedEvents, 0);
});

test("null survives JSON serialization distinctly from 0", () => {
  const unknown = JSON.parse(JSON.stringify(foldToolCallOutcomesV1([])));
  const zeroish = JSON.parse(
    JSON.stringify(
      foldToolCallOutcomesV1([
        { kind: "tool_start", id: "1:0:web_search:start", toolName: "web_search" },
      ]),
    ),
  );

  // Unknown: the key is PRESENT and null (not dropped as undefined).
  assert.ok("failed" in unknown);
  assert.strictEqual(unknown.failed, null);
  assert.notStrictEqual(unknown.failed, 0);
  // Observed-but-none: a real, explicit zero.
  assert.strictEqual(zeroish.failed, 0);
  assert.strictEqual(zeroish.attempted, 1);
  assert.strictEqual(zeroish.undetermined, 1);
});

test("a lossy capture reports null headlines with lower bounds beside them", () => {
  const counts = foldToolCallOutcomesV1(knownStream(), { coverage: "lossy" });

  assert.equal(counts.coverage, "lossy");
  assert.equal(counts.attempted, null);
  assert.equal(counts.failed, null);
  assert.equal(counts.failureBuckets, null);
  assert.deepEqual(counts.atLeast, { attempted: 6, failed: 3 });
});

test("the fold is order-independent", () => {
  const stream = knownStream();
  const forward = foldToolCallOutcomesV1(stream);
  const reversed = foldToolCallOutcomesV1([...stream].reverse());
  // A rotation puts the standalone refusal before every call it could have
  // been mistaken for.
  const rotated = foldToolCallOutcomesV1([
    ...stream.slice(7),
    ...stream.slice(0, 7),
  ]);

  assert.deepEqual(reversed, forward);
  assert.deepEqual(rotated, forward);
});

test("the fold is idempotent for duplicate event ids", () => {
  const stream = knownStream();
  const once = foldToolCallOutcomesV1(stream);
  const twice = foldToolCallOutcomesV1([...stream, ...stream]);

  assert.equal(twice.attempted, once.attempted);
  assert.equal(twice.succeeded, once.succeeded);
  assert.equal(twice.failed, once.failed);
  assert.equal(twice.vacuous, once.vacuous);
  assert.deepEqual(twice.failureBuckets, once.failureBuckets);
  // Only the raw sighting count moves, and it is not a tool-call counter.
  assert.equal(twice.observedEvents, once.observedEvents);
});

test("a replayed prefix merged with the live tail counts each call once", () => {
  const stream = knownStream();
  const replayed = foldToolCallOutcomesV1(stream.slice(0, 6));
  const live = foldToolCallOutcomesV1(stream);
  // The collector's real shape: replay yields the prefix, the live
  // subscription yields everything, and de-dup by id keeps the union exact.
  const union = foldToolCallOutcomesV1([...stream.slice(0, 6), ...stream]);

  assert.equal(union.attempted, live.attempted);
  assert.equal(union.failed, live.failed);
  assert.ok(replayed.attempted! <= live.attempted!);
});

test("unknown error codes land in `other` instead of vanishing", () => {
  assert.equal(classifyToolFailureBucketV1("tool_not_allowed"), "tool_not_allowed");
  assert.equal(
    classifyToolFailureBucketV1("mission_graph_authority_blocked"),
    "mission_graph_authority_blocked",
  );
  assert.equal(classifyToolFailureBucketV1("invalid_argument_path"), "invalid_arguments");
  assert.equal(classifyToolFailureBucketV1("execution_failed"), "execution_failed");
  assert.equal(classifyToolFailureBucketV1("tool_failure_repeated"), "tool_failure_terminal");
  assert.equal(classifyToolFailureBucketV1("a_brand_new_refusal"), "other");
  assert.equal(classifyToolFailureBucketV1(null), "other");
  assert.equal(classifyToolFailureBucketV1(""), "other");

  const counts = foldToolCallOutcomesV1([
    {
      kind: "tool_rejected",
      id: "9:9:mystery_tool",
      toolName: "mystery_tool",
      errorCode: "a_brand_new_refusal",
    },
  ]);
  assert.equal(counts.failureBuckets?.other, 1);
  assert.equal(counts.failed, 1);
  assert.deepEqual(counts.failureDetails, [
    {
      id: "9:9:mystery_tool",
      toolName: "mystery_tool",
      errorCode: "a_brand_new_refusal",
      bucket: "other",
    },
  ]);
});

test("failed-call diagnostics are content-free, deterministic, and bounded", () => {
  const events: ToolCallOutcomeEventV1[] = Array.from(
    { length: TOOL_CALL_FAILURE_DETAIL_CAP + 3 },
    (_, index) => ({
      kind: "tool_rejected",
      id: `${String(index).padStart(2, "0")}:mystery_tool`,
      toolName: "mystery_tool",
      errorCode: null,
    }),
  );
  const forward = foldToolCallOutcomesV1(events);
  const reversed = foldToolCallOutcomesV1([...events].reverse());

  assert.equal(forward.failed, TOOL_CALL_FAILURE_DETAIL_CAP + 3);
  assert.equal(forward.failureDetails?.length, TOOL_CALL_FAILURE_DETAIL_CAP);
  assert.equal(forward.failureDetailsTruncated, true);
  assert.deepEqual(reversed.failureDetails, forward.failureDetails);
  assert.deepEqual(forward.failureDetails?.[0], {
    id: "00:mystery_tool",
    toolName: "mystery_tool",
    errorCode: null,
    bucket: "other",
  });
  assert.deepEqual(Object.keys(forward.failureDetails?.[0] ?? {}).sort(), [
    "bucket",
    "errorCode",
    "id",
    "toolName",
  ]);
});

test("every emitted bucket key is present when coverage is complete", () => {
  const counts = foldToolCallOutcomesV1([
    { kind: "tool_start", id: "1:0:web_search:start", toolName: "web_search" },
  ]);

  assert.deepEqual(
    Object.keys(counts.failureBuckets ?? {}).sort(),
    [...TOOL_CALL_FAILURE_BUCKET_KEYS].sort(),
  );
});

test("normalization maps the three native event shapes and rejects the rest", () => {
  assert.deepEqual(
    normalizeMissionToolEventV1(
      {
        id: "1:0:web_search:start",
        kind: "tool_start",
        toolName: "web_search",
        message: "Running web_search",
      },
      "trace",
    ),
    { kind: "tool_start", id: "1:0:web_search:start", toolName: "web_search" },
  );
  assert.deepEqual(
    normalizeMissionToolEventV1(
      {
        id: "1:0:create_file",
        name: "create_file",
        step: 1,
        ok: false,
        error: { code: "execution_failed", message: "boom" },
      },
      "tool_done",
    ),
    {
      kind: "tool_done",
      id: "1:0:create_file",
      toolName: "create_file",
      ok: false,
      errorCode: "execution_failed",
    },
  );
  // Non-tool traces and unusable events say nothing about a call.
  assert.equal(
    normalizeMissionToolEventV1({ id: "x", kind: "planning" }, "trace"),
    null,
  );
  assert.equal(normalizeMissionToolEventV1({ kind: "tool_start" }, "trace"), null);
  assert.equal(normalizeMissionToolEventV1(null, "trace"), null);
});

test("receipt normalization projects bounded work signals and drops payload text", () => {
  const normalized = normalizeMissionToolEventV1(
    {
      id: "r-1",
      toolName: "append_to_current_file",
      operation: "append",
      path: "Vault/Secret Note.md",
      content: "sensitive body text",
      bytesWritten: 0,
      commitKind: "no_op",
      effects: { changed: false, path: "Vault/Secret Note.md" },
    },
    "receipt",
  );

  assert.equal(normalized?.kind, "receipt");
  const receipt = (normalized as unknown as {
    receipt: Record<string, unknown>;
  }).receipt;
  assert.deepEqual(Object.keys(receipt).sort(), [
    "affectedCount",
    "bytesDeleted",
    "bytesWritten",
    "commitKind",
    "effects",
    "exitCode",
    "operation",
    "purpose",
    "readback",
  ]);
  assert.deepEqual(receipt.effects, { changed: false });
  assert.ok(!JSON.stringify(normalized).includes("Secret Note"));
  assert.ok(!JSON.stringify(normalized).includes("sensitive body text"));
});

test("validation receipt projection preserves bounded verdict proof and counts it as work", () => {
  const normalized = normalizeMissionToolEventV1(
    {
      id: "validation-receipt",
      toolName: "code_validate_full",
      operation: "validate",
      purpose: "validation_full",
      exitCode: 0,
      affectedCount: 0,
      readback: {
        status: "verified",
        path: "C:/private/workspace",
        output: "must not escape",
      },
    },
    "receipt",
  );
  assert.equal(normalized?.kind, "receipt");
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /private|must not escape/u);
  assert.match(serialized, /validation_full/u);
  assert.match(serialized, /verified/u);

  const counts = foldToolCallOutcomesV1([
    { kind: "tool_start", id: "run-a:1:0:code_validate_full", toolName: "code_validate_full" },
    { kind: "tool_result", id: "run-a:1:0:code_validate_full", toolName: "code_validate_full", errorCode: null },
    { kind: "tool_done", id: "run-a:1:0:code_validate_full", toolName: "code_validate_full", ok: true, errorCode: null },
    normalized!,
  ]);
  assert.equal(counts.coverage, "complete");
  assert.equal(counts.succeededWithWork, 1);
  assert.equal(counts.vacuous, 0);
});

test("merging segments sums complete counts and degrades to lossy on contact", () => {
  const first = foldToolCallOutcomesV1(knownStream().slice(0, 6));
  const second = foldToolCallOutcomesV1(knownStream().slice(6));
  const merged = mergeToolCallOutcomeCountsV1(first, second);

  assert.equal(merged.coverage, "complete");
  assert.equal(merged.attempted, first.attempted! + second.attempted!);
  assert.equal(merged.failed, first.failed! + second.failed!);

  const lossy = foldToolCallOutcomesV1(knownStream(), { coverage: "lossy" });
  const contaminated = mergeToolCallOutcomeCountsV1(first, lossy);
  assert.equal(contaminated.coverage, "lossy");
  assert.equal(contaminated.attempted, null);
  assert.ok(contaminated.atLeast!.attempted >= lossy.atLeast!.attempted);

  // An unobserved segment contributes nothing and erases nothing.
  assert.deepEqual(
    mergeToolCallOutcomeCountsV1(first, unknownToolCallOutcomeCountsV1()),
    first,
  );
});

test("the acceptance projection passes unknown through as null", () => {
  const known = toolCallOutcomeAcceptanceCountersV1(
    foldToolCallOutcomesV1(knownStream()),
  );
  assert.equal(known.toolCallsAttempted, 6);
  assert.equal(known.toolCallsFailed, 3);
  assert.equal(known.toolCallsVacuous, 0);
  assert.equal(known.refusalBuckets?.tool_not_allowed, 1);

  const unknown = toolCallOutcomeAcceptanceCountersV1(
    unknownToolCallOutcomeCountsV1(),
  );
  assert.deepEqual(unknown, {
    toolCallsAttempted: null,
    toolCallsFailed: null,
    toolCallsVacuous: null,
    toolCallsIntentionalNoOp: null,
    refusalBuckets: null,
  });
});
