import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  MAX_OUTCOME_PENALTY,
  MAX_OUTCOME_RECORDS,
  PENALTY_FREE_FAILURES,
  classifyToolTargetKind,
  createToolOutcomeMemory,
  isValidToolOutcomeMemory,
  isNotablyFailing,
  outcomeRecencyWeight,
  outcomePenaltyForAction,
  recordToolOutcome,
  summarizeOutcomeMemoryForPrompt,
  type ToolOutcomeMemoryV1,
} from "../src/agent/outcomeMemory";

/**
 * Observation clock for the fixtures below, two days after the newest one they
 * record. Recency weighting means every assertion about penalties or the prompt
 * projection is relative to *when it is read*, so these pin the read instant
 * rather than silently measuring the distance from a hardcoded July date to
 * whatever today happens to be.
 */
const JUST_AFTER = new Date("2026-07-12T00:00:00.000Z");

function failNTimes(
  memory: ToolOutcomeMemoryV1,
  count: number,
  options: {
    toolName?: string;
    errorCode?: string;
    targetKind?: "code_workspace" | "vault_note" | "none";
    startMinute?: number;
  } = {},
): ToolOutcomeMemoryV1 {
  let next = memory;
  for (let index = 0; index < count; index += 1) {
    const minute = (options.startMinute ?? 0) + index;
    next = recordToolOutcome(next, {
      toolName: options.toolName ?? "code_workspace_create",
      ok: false,
      errorCode: options.errorCode ?? "workspace_exists",
      targetKind: options.targetKind ?? "code_workspace",
      observedAt: `2026-07-${String(10 + Math.floor(minute / 60)).padStart(2, "0")}T00:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  return next;
}

test("repeated identical failures collapse onto one record", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 5);

  assert.equal(memory.records.length, 1);
  assert.equal(memory.records[0]?.failures, 5);
  assert.equal(memory.records[0]?.successes, 0);
  assert.equal(memory.records[0]?.errorCode, "workspace_exists");
});

test("first and last seen bracket the observations", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 3);

  assert.equal(memory.records[0]?.firstSeen, "2026-07-10T00:00:00.000Z");
  assert.equal(memory.records[0]?.lastSeen, "2026-07-10T00:02:00.000Z");
});

test("out-of-order observations do not move lastSeen backwards", () => {
  let memory = recordToolOutcome(createToolOutcomeMemory(), {
    toolName: "web_fetch",
    ok: false,
    errorCode: "timeout",
    targetKind: "web_resource",
    observedAt: "2026-07-20T00:00:00.000Z",
  });
  memory = recordToolOutcome(memory, {
    toolName: "web_fetch",
    ok: false,
    errorCode: "timeout",
    targetKind: "web_resource",
    observedAt: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(memory.records[0]?.lastSeen, "2026-07-20T00:00:00.000Z");
  assert.equal(memory.records[0]?.firstSeen, "2026-07-01T00:00:00.000Z");
});

test("different error codes are tracked as different failure modes", () => {
  let memory = failNTimes(createToolOutcomeMemory(), 2);
  memory = failNTimes(memory, 2, { errorCode: "permission_denied" });

  assert.equal(memory.records.length, 2);
});

test("penalty is zero until failures form a pattern", () => {
  const once = failNTimes(createToolOutcomeMemory(), PENALTY_FREE_FAILURES);
  assert.equal(
    outcomePenaltyForAction(once, "code_workspace_create", "code_workspace", JUST_AFTER),
    0,
  );

  const twice = failNTimes(createToolOutcomeMemory(), PENALTY_FREE_FAILURES + 1);
  assert.ok(
    outcomePenaltyForAction(twice, "code_workspace_create", "code_workspace", JUST_AFTER) > 0,
  );
});

test("penalty grows monotonically with repeated failures and stays bounded", () => {
  let previous = -1;
  for (const count of [2, 3, 5, 8, 13, 40, 200]) {
    const memory = failNTimes(createToolOutcomeMemory(), count);
    const penalty = outcomePenaltyForAction(
      memory,
      "code_workspace_create",
      "code_workspace",
      JUST_AFTER,
    );

    assert.ok(
      penalty >= previous,
      `penalty must not decrease: ${count} failures gave ${penalty}, previous ${previous}`,
    );
    assert.ok(penalty <= MAX_OUTCOME_PENALTY);
    previous = penalty;
  }
});

test("a mostly-successful tool is penalized far less than a mostly-failing one", () => {
  let mostlyWorks = failNTimes(createToolOutcomeMemory(), 3, {
    toolName: "read_file",
    targetKind: "vault_note",
  });
  for (let index = 0; index < 60; index += 1) {
    mostlyWorks = recordToolOutcome(mostlyWorks, {
      toolName: "read_file",
      ok: true,
      targetKind: "vault_note",
      observedAt: "2026-07-11T00:00:00.000Z",
    });
  }

  const alwaysFails = failNTimes(createToolOutcomeMemory(), 3, {
    toolName: "read_file",
    targetKind: "vault_note",
  });

  // This is the test that detonated. Unpinned, it read the wall clock, and
  // three failures dated 2026-07-10 decay under PENALTY_FREE_FAILURES at about
  // 47.5 days -- so it passed for weeks and then failed mid-session when that
  // boundary was crossed, with nothing about the code having changed.
  const forgiving = outcomePenaltyForAction(
    mostlyWorks,
    "read_file",
    "vault_note",
    JUST_AFTER,
  );
  const harsh = outcomePenaltyForAction(
    alwaysFails,
    "read_file",
    "vault_note",
    JUST_AFTER,
  );

  assert.ok(
    forgiving < harsh,
    `a 3/63 failure rate (${forgiving}) must score better than 3/3 (${harsh})`,
  );
});

test("an unknown tool carries no penalty", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 5);
  assert.equal(
    outcomePenaltyForAction(memory, "never_seen_tool", "none", JUST_AFTER),
    0,
  );
  assert.equal(outcomePenaltyForAction(memory, "   ", "none", JUST_AFTER), 0);
});

test("records are capped and evicted by least-recently-seen", () => {
  let memory = createToolOutcomeMemory();
  for (let index = 0; index < MAX_OUTCOME_RECORDS + 25; index += 1) {
    memory = recordToolOutcome(memory, {
      toolName: `tool_${index}`,
      ok: false,
      errorCode: "boom",
      targetKind: "none",
      // Later index => later timestamp, so low indexes are the stale ones.
      observedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    });
  }

  assert.equal(memory.records.length, MAX_OUTCOME_RECORDS);
  const names = new Set(memory.records.map((record) => record.toolName));
  assert.equal(names.has("tool_0"), false, "the stalest record must be evicted");
  assert.equal(
    names.has(`tool_${MAX_OUTCOME_RECORDS + 24}`),
    true,
    "the newest record must be retained",
  );
});

test("fingerprints survive a serialize/deserialize round trip", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 4);
  const roundTripped = JSON.parse(JSON.stringify(memory)) as ToolOutcomeMemoryV1;

  assert.deepEqual(roundTripped, memory);
  assert.equal(isValidToolOutcomeMemory(roundTripped), true);
});

test("a tampered record is rejected", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 4);
  const tampered: ToolOutcomeMemoryV1 = {
    version: 1,
    records: [{ ...memory.records[0]!, toolName: "swapped_tool" }],
  };

  assert.equal(isValidToolOutcomeMemory(tampered), false);
});

test("counter growth does not invalidate the identity fingerprint", () => {
  const four = failNTimes(createToolOutcomeMemory(), 4);
  const five = failNTimes(createToolOutcomeMemory(), 5);

  assert.notEqual(four.records[0]?.failures, five.records[0]?.failures);
  assert.equal(four.records[0]?.fingerprint, five.records[0]?.fingerprint);
  assert.equal(isValidToolOutcomeMemory(five), true);
});

test("the prompt projection lists failures without leaking vault structure", () => {
  let memory = failNTimes(createToolOutcomeMemory(), 4);
  memory = failNTimes(memory, 2, {
    toolName: "web_fetch",
    errorCode: "timeout",
    targetKind: "none",
    startMinute: 100,
  });

  const summary = summarizeOutcomeMemoryForPrompt(memory, 8, JUST_AFTER);
  assert.ok(summary);
  assert.match(summary, /code_workspace_create on code_workspace: failed 4x with workspace_exists/);
  assert.match(summary, /web_fetch/);
  // Only tool names, target kinds, and error codes — never paths or URLs.
  assert.doesNotMatch(summary, /https?:\/\//);
  assert.doesNotMatch(summary, /\.md\b/);
});

test("no notable failures projects nothing", () => {
  assert.equal(summarizeOutcomeMemoryForPrompt(createToolOutcomeMemory(), 8, JUST_AFTER), null);

  const singleFailure = failNTimes(createToolOutcomeMemory(), PENALTY_FREE_FAILURES);
  assert.equal(summarizeOutcomeMemoryForPrompt(singleFailure, 8, JUST_AFTER), null);
});

test("malformed observations are ignored rather than stored", () => {
  const empty = createToolOutcomeMemory();

  assert.deepEqual(
    recordToolOutcome(empty, {
      toolName: "  ",
      ok: false,
      observedAt: "2026-07-10T00:00:00.000Z",
    }),
    empty,
  );
  assert.deepEqual(
    recordToolOutcome(empty, {
      toolName: "read_file",
      ok: false,
      observedAt: "not-a-timestamp",
    }),
    empty,
  );
});

test("target kinds are classified from tool name and argument shape", () => {
  assert.equal(
    classifyToolTargetKind("code_workspace_create", { path: "src/a.ts" }),
    "code_workspace",
  );
  assert.equal(classifyToolTargetKind("github_create_repo"), "external_service");
  assert.equal(classifyToolTargetKind("linear_create_issue"), "external_service");
  assert.equal(
    classifyToolTargetKind("publish_research_to_github"),
    "external_service",
  );
  assert.equal(classifyToolTargetKind("web_fetch", { url: "x" }), "web_resource");
  assert.equal(classifyToolTargetKind("create_folder"), "vault_folder");
  assert.equal(classifyToolTargetKind("read_file", { path: "a.md" }), "vault_note");
  assert.equal(classifyToolTargetKind("append_to_current_file"), "vault_note");
  assert.equal(classifyToolTargetKind("count_words"), "none");
  assert.equal(classifyToolTargetKind("  "), "none");
});

test("classification never depends on argument values, only their shape", () => {
  // The same tool pointed at two different notes must produce one record, so
  // the memory generalizes and no path can reach the prompt projection.
  const first = classifyToolTargetKind("read_file", { path: "Private/Diary.md" });
  const second = classifyToolTargetKind("read_file", { path: "Work/Notes.md" });
  assert.equal(first, second);
});

test("a failure with no error code is recorded as unknown, not dropped", () => {
  const memory = recordToolOutcome(createToolOutcomeMemory(), {
    toolName: "read_file",
    ok: false,
    observedAt: "2026-07-10T00:00:00.000Z",
  });

  assert.equal(memory.records[0]?.errorCode, "unknown");
  assert.equal(memory.records[0]?.targetKind, "none");
});

/*
 * Recency weighting and the shared failing-record predicate.
 *
 * Before these, the ledger could not forget and its two readers disagreed: the
 * ranking penalty scaled by failure ratio while the prompt projection filtered
 * on the raw failure count, so an approach that failed three times and
 * succeeded three hundred was still announced to the model as one to avoid.
 */

const HALF_LIFE_LATER = new Date("2026-08-09T00:00:00.000Z");
const THREE_HALF_LIVES_LATER = new Date("2026-10-08T00:00:00.000Z");

test("an observation's weight halves once per half-life", () => {
  const seen = "2026-07-10T00:00:00.000Z";

  assert.equal(outcomeRecencyWeight(seen, new Date(seen)), 1);
  assert.ok(Math.abs(outcomeRecencyWeight(seen, HALF_LIFE_LATER) - 0.5) < 0.02);
  assert.ok(
    Math.abs(outcomeRecencyWeight(seen, THREE_HALF_LIVES_LATER) - 0.125) < 0.02,
  );
});

test("a clock that disagrees never silently discounts a record", () => {
  // Unparseable and future timestamps weigh 1 rather than 0: a skewed clock
  // must not quietly erase real observed history.
  assert.equal(outcomeRecencyWeight("not-a-date", JUST_AFTER), 1);
  assert.equal(
    outcomeRecencyWeight("2027-01-01T00:00:00.000Z", JUST_AFTER),
    1,
  );
});

test("stale failures decay out of both the penalty and the prompt", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 6);

  const fresh = outcomePenaltyForAction(
    memory,
    "code_workspace_create",
    "code_workspace",
    JUST_AFTER,
  );
  const stale = outcomePenaltyForAction(
    memory,
    "code_workspace_create",
    "code_workspace",
    THREE_HALF_LIVES_LATER,
  );

  assert.ok(fresh > 0);
  assert.ok(stale < fresh);
  // Six failures weighed at ~1/8 fall back under the pattern threshold, which
  // is the point: a fix that landed months ago stops being charged forever.
  assert.equal(stale, 0);
  assert.equal(
    summarizeOutcomeMemoryForPrompt(memory, 8, THREE_HALF_LIVES_LATER),
    null,
  );
});

test("a mostly-successful approach is never announced as one to avoid", () => {
  let memory = failNTimes(createToolOutcomeMemory(), 3, {
    toolName: "web_fetch",
    errorCode: "timeout",
    targetKind: "none",
  });
  for (let index = 0; index < 300; index += 1) {
    memory = recordToolOutcome(memory, {
      toolName: "web_fetch",
      ok: true,
      targetKind: "none",
      observedAt: "2026-07-11T00:00:00.000Z",
    });
  }

  assert.equal(summarizeOutcomeMemoryForPrompt(memory, 8, JUST_AFTER), null);

  const failing = memory.records.find(
    (record) => record.toolName === "web_fetch" && record.errorCode === "timeout",
  );
  assert.ok(failing);
  assert.equal(isNotablyFailing(memory, failing, JUST_AFTER), false);

  // The same three failures with nothing to offset them stay notable.
  const unrelieved = failNTimes(createToolOutcomeMemory(), 3, {
    toolName: "web_fetch",
    errorCode: "timeout",
    targetKind: "none",
  });
  assert.ok(summarizeOutcomeMemoryForPrompt(unrelieved, 8, JUST_AFTER));
});

test("the prompt reports raw observed counts even though it selects on weighted ones", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 4);
  const summary = summarizeOutcomeMemoryForPrompt(memory, 8, JUST_AFTER);

  assert.ok(summary);
  // Selection is recency-weighted; the sentence still tells the truth about
  // what was actually observed rather than reporting a decayed fraction.
  assert.match(summary, /failed 4x/);
});

test("both readers derive their counts from the shared helper", () => {
  // Source-level guard. The regression this blocks is re-inlining a raw-count
  // filter into the prompt projection, which is exactly how the two readers
  // drifted apart the first time.
  const source = readFileSync(
    new URL("../src/agent/outcomeMemory.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\.filter\(\s*\(record\)\s*=>\s*record\.failures/);
  assert.equal(
    source.split("weightedOutcomeCounts(").length - 1 >= 2,
    true,
    "penalty, prompt selection, and the notable predicate must all read the shared helper",
  );
});
