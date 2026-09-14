import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveRunStopDetailV1 } from "../src/AgentRunner";

/**
 * A terminal error must say what it was.
 *
 * On 2026-09-14 a real-web mission stopped at step 11 of 18 with
 * `stopReason: "error"` and `stopDetail: "not_budget"` after fifteen successful
 * tool calls. "not_budget" is the auto-continuation decision — it means "this
 * stop is not a budget pause" — and it had been backfilled into the detail slot
 * because the error path supplied none. The run could not be diagnosed from its
 * artifacts at all: the one fact that mattered was absent, and something that
 * read like a cause stood in its place.
 */
test("an absent stop detail stays absent instead of borrowing a continuation reason", () => {
  assert.equal(resolveRunStopDetailV1(null, "not_budget"), null);
  assert.equal(resolveRunStopDetailV1(undefined, "not_budget"), null);
  assert.equal(resolveRunStopDetailV1("", "not_budget"), null);
  assert.equal(resolveRunStopDetailV1("   ", "not_budget"), null);
  assert.equal(resolveRunStopDetailV1(undefined, undefined), null);
});

test("an explicit detail always wins", () => {
  assert.equal(
    resolveRunStopDetailV1("required read tools were not requested", "not_budget"),
    "required read tools were not requested",
  );
  assert.equal(
    resolveRunStopDetailV1("fetched_sources:2/3", "budget_exhausted"),
    "fetched_sources:2/3",
  );
});

test("an informative continuation reason is still reported when nothing else is", () => {
  assert.equal(
    resolveRunStopDetailV1(null, "budget_exhausted"),
    "budget_exhausted",
  );
});

/**
 * Source-level guard. Four call sites built a message, showed it to the user,
 * recorded it as a ledger blocker, and then ended the run without passing it —
 * which is how the detail slot came to be empty in the first place. A fifth
 * would reopen the same hole.
 */
test("no terminal error ends a run without saying why", () => {
  const source = readFileSync("src/AgentRunner.ts", "utf8");
  const silent = [
    ...source.matchAll(/finishRun\(\s*"error"\s*,[^)]*?\)/gu),
  ].filter((match) => {
    // stopReason, step, maxSteps and then a reason: fewer than four arguments
    // means the run reports no reason at all.
    const args = match[0]
      .slice(match[0].indexOf("(") + 1, match[0].lastIndexOf(")"))
      .split(",");
    return args.length < 4;
  });
  assert.deepEqual(
    silent.map((match) => match[0]),
    [],
    "every finishRun(\"error\", ...) must pass the message it already built",
  );
});

test("the error stop assembles the same evidence the budget stop does", () => {
  const source = readFileSync("src/AgentRunner.ts", "utf8");
  // The error branch of the stopDetail ladder must carry acceptance debt and
  // graph state, not just an optional nextAction.
  const errorBranch = /effectiveStopReason === "error"[\s\S]{0,900}?unreported_terminal_error/u.exec(
    source,
  );
  assert.ok(errorBranch, "the error branch must have a detail ladder");
  assert.ok(
    errorBranch[0].includes("acceptanceMissingForStop"),
    "a terminal error must report what acceptance still wanted",
  );
  assert.ok(
    errorBranch[0].includes("mission_graph_incomplete"),
    "a terminal error must report whether the graph agreed",
  );
});
