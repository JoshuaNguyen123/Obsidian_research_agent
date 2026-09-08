import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyToolFailureBucketV1,
  foldToolCallOutcomesV1,
  mergeToolCallOutcomeCountsV1,
  normalizeMissionToolEventV1,
  projectToolFailureMessageV1,
  TOOL_CALL_FAILURE_DETAIL_CAP,
  TOOL_CALL_FAILURE_MESSAGE_CAP,
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
      // This fixture's events carry codes only, and a message nobody reported
      // is null — never "" — so a reader can tell "no rule was named" from
      // "the rule was named and it was empty".
      errorMessage: null,
      bucket: "execution_failed",
    },
    {
      id: "2:1:create_file",
      toolName: "create_file",
      errorCode: "invalid_argument_path",
      errorMessage: null,
      bucket: "invalid_arguments",
    },
    {
      id: "3:1:github_create_pull_request",
      toolName: "github_create_pull_request",
      errorCode: "tool_not_allowed",
      errorMessage: null,
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

test("a terminal replay no-op joins canonical result and done events into one call", () => {
  const c = call(24, 0, "append_to_current_file");
  const counts = foldToolCallOutcomesV1([
    // The terminal replay is classified before registry execution, so it has
    // no tool_start event. Its result and done events must still share one
    // canonical call key.
    ...ok(c.base, "append_to_current_file"),
    {
      kind: "receipt",
      id: `${c.base}:intentional-no-op`,
      toolName: "append_to_current_file",
      receipt: {
        operation: "append",
        commitKind: "no_op",
        effects: { changed: false },
      },
    },
  ]);

  assert.equal(counts.attempted, 1);
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.failed, 0);
  assert.equal(counts.undetermined, 0);
  assert.equal(counts.intentionalNoOp, 1);
  assert.equal(counts.vacuous, 0);
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
      errorMessage: null,
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
    errorMessage: null,
    bucket: "other",
  });
  assert.deepEqual(Object.keys(forward.failureDetails?.[0] ?? {}).sort(), [
    "bucket",
    "errorCode",
    "errorMessage",
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
      // The message rides in the same `error` object as the code, so keeping it
      // costs no new observation — it was only ever being discarded.
      errorMessage: "boom",
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

/**
 * The cohort-ending failure, replayed through the REAL derivation path.
 *
 * A qualification cohort died on
 * `failures=[{"errorCode":"project_idea_brief_invalid", ...}]`. That code is
 * raised from eight places in src/tools/projectIdeaBriefTool.ts, each naming a
 * different broken rule, and teardown deletes the run note that held the
 * message — so the retained record could not say which rule broke, and the only
 * way to find out was another twelve-minute lane run.
 *
 * These are the two native shapes AgentRunner emits for one failed call
 * (`onToolDone` and the `:result` trace), verbatim in structure, so this test
 * exercises `normalizeMissionToolEventV1` and the fold rather than a hand-built
 * detail object.
 */
const COHORT_KILLING_RULE =
  "Web grounding references must be absolute HTTP(S) URLs without credentials.";

function cohortKillingEvents(): ToolCallOutcomeEventV1[] {
  const id = "run-2f8c1a:2:0:create_project_idea_brief";
  const error = {
    code: "project_idea_brief_invalid",
    message: COHORT_KILLING_RULE,
  };
  return [
    normalizeMissionToolEventV1(
      {
        id: `${id}:start`,
        kind: "tool_start",
        step: 2,
        toolName: "create_project_idea_brief",
        message: "Running create_project_idea_brief",
      },
      "trace",
    )!,
    normalizeMissionToolEventV1(
      {
        id,
        name: "create_project_idea_brief",
        step: 2,
        ok: false,
        message: "create_project_idea_brief failed",
        output: { attempted: true },
        error,
      },
      "tool_done",
    )!,
    normalizeMissionToolEventV1(
      {
        id: `${id}:result`,
        kind: "tool_result",
        step: 2,
        toolName: "create_project_idea_brief",
        message: "create_project_idea_brief failed",
        outputPreview: { truncated: true },
        error,
      },
      "trace",
    )!,
  ];
}

test("a failure detail names the broken rule, not just the error code family", () => {
  const counts = foldToolCallOutcomesV1(cohortKillingEvents());

  assert.equal(counts.coverage, "complete");
  assert.equal(counts.failed, 1);
  assert.deepEqual(counts.failureDetails, [
    {
      id: "run-2f8c1a:2:0:create_project_idea_brief",
      toolName: "create_project_idea_brief",
      errorCode: "project_idea_brief_invalid",
      errorMessage: COHORT_KILLING_RULE,
      bucket: "other",
    },
  ]);
  // The assertion that ends a cohort interpolates this list, so the rule has to
  // survive JSON.stringify — that string IS the diagnosis.
  assert.match(
    JSON.stringify(counts.failureDetails),
    /absolute HTTP\(S\) URLs without credentials/u,
  );
});

test("every project_idea_brief rule survives redaction and the bound intact", () => {
  // The eight sentences the cohort-killing code can carry. If redaction or
  // bounding mangled one of them, this field would name the wrong rule — which
  // is worse than naming none.
  for (const rule of [
    "groundingReferences must contain at most 50 entries.",
    "Grounding reference 1 does not match its closed contract.",
    "Grounding reference 1 has an unsupported kind.",
    "Grounding reference 1 must name a host-observed reference.",
    "Web grounding references must be absolute HTTP(S) URLs without credentials.",
    "Vault grounding references must be safe vault-relative Markdown paths.",
    "User grounding may reference only the host-owned original_mission input.",
    "Project idea arguments do not match the closed native tool contract.",
  ]) {
    assert.equal(projectToolFailureMessageV1(rule), rule);
    assert.ok(rule.length <= TOOL_CALL_FAILURE_MESSAGE_CAP);
  }
});

test("a message nobody reported stays null, and the capture stays complete", () => {
  const normalized = normalizeMissionToolEventV1(
    {
      id: "1:0:create_file",
      name: "create_file",
      step: 1,
      ok: false,
      // A typed cause with no sentence beside it. The runner emits this shape
      // whenever a refusal carries a code only.
      error: { code: "tool_not_allowed" },
    },
    "tool_done",
  );
  assert.deepEqual(normalized, {
    kind: "tool_done",
    id: "1:0:create_file",
    toolName: "create_file",
    ok: false,
    errorCode: "tool_not_allowed",
    errorMessage: null,
  });

  const counts = foldToolCallOutcomesV1([normalized!]);
  // Unobserved is null, never "": an empty string would read as "the product
  // named the rule and the rule was blank".
  assert.equal(counts.failureDetails?.[0]?.errorMessage, null);
  assert.notEqual(counts.failureDetails?.[0]?.errorMessage, "");
  // And an absent message must not make a complete observation look lossy.
  assert.equal(counts.coverage, "complete");
  assert.equal(counts.failed, 1);
  assert.equal(counts.atLeast, null);

  // Whitespace-only and non-string messages are the same non-observation.
  for (const empty of [undefined, null, "", "   ", 42, {}]) {
    assert.equal(projectToolFailureMessageV1(empty), null);
  }
});

test("a retained message is bounded, and says so when it was cut", () => {
  const long = `The brief is invalid because ${"reason ".repeat(200)}`;
  const projected = projectToolFailureMessageV1(long)!;

  assert.equal(projected.length, TOOL_CALL_FAILURE_MESSAGE_CAP);
  assert.ok(projected.endsWith("..."), "a cut message must admit it was cut");
  assert.ok(projected.startsWith("The brief is invalid because reason"));
  // Idempotent: the fold re-projects whatever a foreign producer hands it, and
  // that second pass must not keep shaving the message.
  assert.equal(projectToolFailureMessageV1(projected), projected);

  const counts = foldToolCallOutcomesV1([
    {
      kind: "tool_rejected",
      id: "4:0:create_project_idea_brief",
      toolName: "create_project_idea_brief",
      errorCode: "project_idea_brief_invalid",
      // Unbounded, exactly as a page-side collector that never learned the cap
      // would hand it over.
      errorMessage: long,
    },
  ]);
  assert.equal(
    counts.failureDetails?.[0]?.errorMessage?.length,
    TOOL_CALL_FAILURE_MESSAGE_CAP,
  );
});

test("no credential, path or URL reaches a retained failure message", () => {
  // Every class the product provably interpolates into `error.message`:
  // AgentRunner forwards arbitrary caught errors verbatim, atomicVaultWrite
  // names the vault path, and GitHubRestClient scrubs a token out of this very
  // field before building it.
  const poison = {
    bearer: "Authorization failed: Bearer sk-live-DEADBEEF-must-not-escape",
    flag: "python3 /home/user/secrets/run_payroll.py --token abc123 failed",
    assignment: "request rejected (api_key=AKIAIOSFODNN7EXAMPLE)",
    vaultPath:
      "The note changed during preparation: Research/Private Client Note.md.",
    url: "GET https://api.example.com/v1/issues?access_token=s3cr3tvalue returned 401",
    opaque: "signature mismatch for ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  } as const;
  const secrets = [
    "sk-live-DEADBEEF-must-not-escape",
    "abc123",
    "AKIAIOSFODNN7EXAMPLE",
    "Research/Private Client Note.md",
    "/home/user/secrets/run_payroll.py",
    "https://api.example.com/v1/issues?access_token=s3cr3tvalue",
    "s3cr3tvalue",
    "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ];

  const counts = foldToolCallOutcomesV1(
    Object.entries(poison).map(
      (entry, index) =>
        normalizeMissionToolEventV1(
          {
            id: `9:${index}:leaky_tool`,
            name: "leaky_tool",
            step: 9,
            ok: false,
            error: { code: "execution_failed", message: entry[1] },
          },
          "tool_done",
        )!,
    ),
  );
  const retained = JSON.stringify(counts.failureDetails);

  for (const secret of secrets) {
    assert.ok(
      !retained.includes(secret),
      `${secret} must never reach a retained failure message`,
    );
  }
  // The positive half: a projection that returned nothing would satisfy every
  // rule above and be worthless. The non-secret words of each sentence — the
  // part that names what broke — are still there.
  assert.equal(counts.failed, Object.keys(poison).length);
  for (const kept of [
    "Authorization failed",
    "python3",
    "request rejected",
    "The note changed during preparation",
    "returned 401",
    "signature mismatch for",
  ]) {
    assert.ok(retained.includes(kept), `${kept} must survive redaction`);
  }
});

test("the code and the message of one call come from the SAME report", () => {
  // One logical call reported failed on two streams with different causes: the
  // `ok:false` done arrives first, then its `tool_rejected` twin. Pairing the
  // done's code with the rejection's sentence would name a rule that never
  // broke, which is the only outcome worse than naming none.
  const counts = foldToolCallOutcomesV1([
    {
      kind: "tool_done",
      id: "5:0:create_project_idea_brief",
      toolName: "create_project_idea_brief",
      ok: false,
      errorCode: "project_idea_brief_invalid",
      errorMessage: "Grounding reference 1 has an unsupported kind.",
    },
    {
      kind: "tool_rejected",
      id: "5:0:create_project_idea_brief:graph-rejected",
      toolName: "create_project_idea_brief",
      errorCode: "mission_graph_authority_blocked",
      errorMessage: "The mission graph offered no node for this tool.",
    },
  ]);

  assert.equal(counts.failed, 1, "two reports, one logical call");
  assert.deepEqual(counts.failureDetails?.[0], {
    id: "5:0:create_project_idea_brief",
    toolName: "create_project_idea_brief",
    errorCode: "project_idea_brief_invalid",
    errorMessage: "Grounding reference 1 has an unsupported kind.",
    bucket: "other",
  });
});

test("a sentence with no typed code beside it is still the only cause we have", () => {
  const counts = foldToolCallOutcomesV1([
    {
      kind: "tool_rejected",
      id: "6:0:mystery_tool",
      toolName: "mystery_tool",
      errorCode: null,
      errorMessage: "The host withdrew the tool before it could run.",
    },
  ]);

  assert.deepEqual(counts.failureDetails?.[0], {
    id: "6:0:mystery_tool",
    toolName: "mystery_tool",
    errorCode: null,
    errorMessage: "The host withdrew the tool before it could run.",
    bucket: "other",
  });
});

test("merged segments keep each failure's message beside its code", () => {
  const left = foldToolCallOutcomesV1(cohortKillingEvents());
  const right = foldToolCallOutcomesV1([
    {
      kind: "tool_rejected",
      id: "7:0:github_create_pull_request",
      toolName: "github_create_pull_request",
      errorCode: "tool_not_allowed",
      errorMessage: "The frontier narrowed before this call was issued.",
    },
  ]);

  assert.deepEqual(
    mergeToolCallOutcomeCountsV1(left, right).failureDetails?.map(
      (detail) => detail.errorMessage,
    ),
    [
      COHORT_KILLING_RULE,
      "The frontier narrowed before this call was issued.",
    ],
  );
});
