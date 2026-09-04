import assert from "node:assert/strict";
import test from "node:test";

import {
  getRequiredCodeWorkflowToolNames,
} from "../src/AgentRunner";
import {
  committedToolCallsForLifecycleStagesV1,
  PROJECT_LIFECYCLE_STAGE_COMMITTED_TOOL_CALLS_V1,
} from "../src/agent/lifecycleStagePolicy";
import {
  missionCommittedWorkV1,
  missionRequiresExtendedEffortBudgetV1,
} from "../src/agent/missionEffortEscalation";
import {
  missionEffortFloorForCommittedToolCallsV1,
  resolveMissionEffortDecisionV1,
} from "../src/agent/missionEffortDecision";
import { detectProjectLifecycleStagesV1 } from "../src/agent/projectLifecycle";
import { MAX_AGENT_STEPS } from "../src/tools/constants";

const DESKTOP_CODE_PROMPT = "write a number guessing game in Python on my desktop";

test("the committed code ladder length is measured, not asserted by hand", () => {
  // The number in PROJECT_LIFECYCLE_STAGE_COMMITTED_TOOL_CALLS_V1 exists to
  // size a budget. If the real deterministic ladder grows past it, the budget
  // silently under-serves the mission again -- which is the exact failure
  // 09760d4 patched. So the table is checked against the ladder itself rather
  // than against a literal restated here.
  const ladder = getRequiredCodeWorkflowToolNames(DESKTOP_CODE_PROMPT);
  assert.deepEqual(detectProjectLifecycleStagesV1(DESKTOP_CODE_PROMPT), [
    "code_execution",
  ]);
  assert.ok(
    PROJECT_LIFECYCLE_STAGE_COMMITTED_TOOL_CALLS_V1.code_execution >=
      ladder.length,
    `code_execution commits ${ladder.length} tools (${ladder.join(", ")}) but is budgeted for ${PROJECT_LIFECYCLE_STAGE_COMMITTED_TOOL_CALLS_V1.code_execution}`,
  );
});

test("a one-stage code mission is budgeted for its ladder, not for its prompt shape", () => {
  const committed = missionCommittedWorkV1(DESKTOP_CODE_PROMPT);
  assert.deepEqual(committed.stages, ["code_execution"]);
  assert.equal(committed.toolCalls, 7);
  assert.deepEqual(committed.reasons, ["lifecycle_stages:code_execution"]);

  // This is the mission that died at four tool calls: the prompt reads as an
  // ordinary short request, so it drew `compose` (6 model / 4 tool / 3 min)
  // while committing a seven-tool ladder.
  const promptShaped = resolveMissionEffortDecisionV1({
    prompt: DESKTOP_CODE_PROMPT,
    route: "tool_required",
    outputTarget: "chat",
  });
  assert.equal(promptShaped.maxToolCalls, 4);

  const ladderSized = resolveMissionEffortDecisionV1({
    prompt: DESKTOP_CODE_PROMPT,
    route: "tool_required",
    outputTarget: "chat",
    committedToolCalls: committed.toolCalls,
    committedWorkReasons: committed.reasons,
  });
  assert.ok(
    ladderSized.maxToolCalls > committed.toolCalls,
    `a ${committed.toolCalls}-tool ladder needs more than ${ladderSized.maxToolCalls} tool calls to survive one repair`,
  );
  assert.ok(ladderSized.maxWallClockMs >= 20 * 60_000);
  assert.ok(ladderSized.maxSegments >= 2);
  assert.ok(
    ladderSized.escalationReasons.includes("committed_tool_ladder:7"),
    `the budget must say what it was sized from: ${ladderSized.escalationReasons.join(", ")}`,
  );
});

test("the ladder floor never exceeds the largest sanctioned profile", () => {
  // Naming more stages must not buy an unbounded budget.
  const huge = missionEffortFloorForCommittedToolCallsV1(10_000);
  assert.ok(huge);
  assert.equal(huge.maxToolCalls, 200);
  assert.equal(huge.maxModelCalls, MAX_AGENT_STEPS);
  // Wall clock has its own ladder ceiling, above the profile's flat 20
  // minutes: the profile grants 200 tool calls in that 20 minutes, which is
  // six seconds each, and a sandbox validation is not six seconds. Bounded all
  // the same -- naming ten thousand stages buys 45 minutes, not more.
  assert.equal(huge.maxWallClockMs, 45 * 60_000);
  assert.equal(huge.maxSegments, 3);

  const extendedTeam = resolveMissionEffortDecisionV1({
    prompt: "Do a deep research review of consensus protocols.",
    route: "grounded_workflow",
    outputTarget: "new_note",
    committedToolCalls: 10_000,
  });
  assert.equal(extendedTeam.profile, "extended_team");
  assert.equal(extendedTeam.maxToolCalls, 200);
  assert.equal(extendedTeam.maxModelCalls, MAX_AGENT_STEPS);
});

test("the ladder floor only ever raises, and a narrowed setting still clamps", () => {
  const committed = missionCommittedWorkV1(DESKTOP_CODE_PROMPT);
  const narrowed = resolveMissionEffortDecisionV1({
    prompt: DESKTOP_CODE_PROMPT,
    route: "tool_required",
    outputTarget: "chat",
    committedToolCalls: committed.toolCalls,
    // Deliberately below the hard cap, so it is a real per-mission narrowing.
    configuredMaxToolCalls: 9,
    configuredMaxModelCalls: 9,
  });
  assert.equal(narrowed.maxToolCalls, 9);
  assert.equal(narrowed.maxModelCalls, 9);

  const noCommittedWork = resolveMissionEffortDecisionV1({
    prompt: "Say hello.",
    route: "single_model_answer",
    outputTarget: "chat",
  });
  assert.equal(noCommittedWork.profile, "direct");
  assert.equal(noCommittedWork.maxModelCalls, 1);
  assert.equal(noCommittedWork.maxToolCalls, 0);
  assert.equal(noCommittedWork.maxWallClockMs, 60_000);
});

test("committed work sums the stages a compound mission actually plans", () => {
  const compound = [
    "Research a conflict-free counter and create measurable Linear work.",
    "Implement and test it on desktop, then push a private draft PR to GitHub.",
  ].join(" ");
  const committed = missionCommittedWorkV1(compound);
  assert.ok(committed.stages.length > 1);
  assert.ok(
    committed.toolCalls >=
      committedToolCallsForLifecycleStagesV1(committed.stages),
    "committed work is at least the sum of its stages",
  );
  assert.ok(
    committed.toolCalls > missionCommittedWorkV1(DESKTOP_CODE_PROMPT).toolCalls,
    "a compound pipeline commits strictly more work than one code stage",
  );
  assert.equal(missionRequiresExtendedEffortBudgetV1(compound), true);
});

test("wall clock scales with the ladder instead of flattening at one profile value", () => {
  // The measured defect: every dimension but this one grew with the ladder, so
  // a 14-step build-validate-commit-publish mission drew twice the tool calls
  // of a 7-step single-file build and exactly the same 20 minutes to spend
  // them in.
  const short = missionEffortFloorForCommittedToolCallsV1(7)!;
  const long = missionEffortFloorForCommittedToolCallsV1(14)!;
  assert.ok(
    long.maxToolCalls > short.maxToolCalls,
    "precondition: the longer ladder gets more tool calls",
  );
  assert.ok(
    long.maxWallClockMs > short.maxWallClockMs,
    `a ${long.maxToolCalls}-call ladder must not get the same ${Math.round(short.maxWallClockMs / 60_000)} minutes as a ${short.maxToolCalls}-call one`,
  );

  // Time per granted tool call must not shrink as the ladder grows: that ratio
  // collapsing is exactly what the flat ceiling did.
  const perCall = (floor: { maxWallClockMs: number; maxToolCalls: number }) =>
    floor.maxWallClockMs / floor.maxToolCalls;
  assert.ok(
    perCall(long) >= perCall(short) * 0.9,
    `${Math.round(perCall(long) / 1000)}s per call at 14 steps vs ${Math.round(perCall(short) / 1000)}s at 7`,
  );

  // Still monotonic and still bounded.
  let previous = 0;
  for (const steps of [1, 5, 10, 15, 20, 100]) {
    const floor = missionEffortFloorForCommittedToolCallsV1(steps)!;
    assert.ok(floor.maxWallClockMs >= previous, `${steps} steps regressed`);
    assert.ok(floor.maxWallClockMs <= 45 * 60_000, `${steps} steps exceeded the bound`);
    previous = floor.maxWallClockMs;
  }

  // A mission with no detected ladder is untouched by any of this.
  assert.equal(missionEffortFloorForCommittedToolCallsV1(0), null);
  assert.equal(missionEffortFloorForCommittedToolCallsV1(null), null);
});
