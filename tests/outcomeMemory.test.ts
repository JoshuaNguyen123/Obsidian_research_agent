import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_OUTCOME_PENALTY,
  MAX_OUTCOME_RECORDS,
  PENALTY_FREE_FAILURES,
  classifyToolTargetKind,
  createToolOutcomeMemory,
  isValidToolOutcomeMemory,
  outcomePenaltyForAction,
  recordToolOutcome,
  summarizeOutcomeMemoryForPrompt,
  type ToolOutcomeMemoryV1,
} from "../src/agent/outcomeMemory";

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
    outcomePenaltyForAction(once, "code_workspace_create", "code_workspace"),
    0,
  );

  const twice = failNTimes(createToolOutcomeMemory(), PENALTY_FREE_FAILURES + 1);
  assert.ok(
    outcomePenaltyForAction(twice, "code_workspace_create", "code_workspace") > 0,
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

  const forgiving = outcomePenaltyForAction(mostlyWorks, "read_file", "vault_note");
  const harsh = outcomePenaltyForAction(alwaysFails, "read_file", "vault_note");

  assert.ok(
    forgiving < harsh,
    `a 3/63 failure rate (${forgiving}) must score better than 3/3 (${harsh})`,
  );
});

test("an unknown tool carries no penalty", () => {
  const memory = failNTimes(createToolOutcomeMemory(), 5);
  assert.equal(outcomePenaltyForAction(memory, "never_seen_tool"), 0);
  assert.equal(outcomePenaltyForAction(memory, "   "), 0);
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

  const summary = summarizeOutcomeMemoryForPrompt(memory);
  assert.ok(summary);
  assert.match(summary, /code_workspace_create on code_workspace: failed 4x with workspace_exists/);
  assert.match(summary, /web_fetch/);
  // Only tool names, target kinds, and error codes — never paths or URLs.
  assert.doesNotMatch(summary, /https?:\/\//);
  assert.doesNotMatch(summary, /\.md\b/);
});

test("no notable failures projects nothing", () => {
  assert.equal(summarizeOutcomeMemoryForPrompt(createToolOutcomeMemory()), null);

  const singleFailure = failNTimes(createToolOutcomeMemory(), PENALTY_FREE_FAILURES);
  assert.equal(summarizeOutcomeMemoryForPrompt(singleFailure), null);
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
