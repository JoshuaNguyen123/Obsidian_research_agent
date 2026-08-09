import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveMissionEffortDecisionV1,
} from "../src/agent/missionEffortDecision";

const ORCHESTRATION_GUIDE_PROMPT =
  "I want you to write me an in depth guide/report to agent orchestration. What is it, why is it important, and then finally how to execute agent orcehstration sucessfully.";

test("in-depth writing selects Compose without inventing research", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: ORCHESTRATION_GUIDE_PROMPT,
    route: "single_model_writeback",
    outputTarget: "new_note",
    configuredMaxModelCalls: 100,
    configuredMaxRunMinutes: 60,
  });
  assert.equal(decision.profile, "compose");
  assert.equal(decision.outputDepth, "in_depth");
  assert.equal(decision.researchDepth, "none");
  assert.equal(decision.outputTarget, "new_note");
  assert.equal(decision.maxModelCalls, 6);
  assert.equal(decision.maxToolCalls, 4);
  assert.equal(decision.maxWallClockMs, 3 * 60_000);
  assert.deepEqual(decision.finalizationReserve.requiredActions, [
    "write_output",
    "read_back_output",
    "render_result",
  ]);
});

test("sources and citations select Grounded research", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt:
      "Write an in-depth guide to agent orchestration using current sources and citations.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  });
  assert.equal(decision.profile, "grounded_research");
  assert.equal(decision.outputDepth, "in_depth");
  assert.equal(decision.researchDepth, "grounded");
  assert.equal(decision.maxModelCalls, 16);
  assert.equal(decision.maxToolCalls, 12);
});

test("named parallel vault evidence plus verified writeback uses the Grounded time budget", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt:
      "In one step, use parallel vault reads to read both A.md and B.md, then append a two-bullet synthesis to the current note.",
    route: "vault_context_answer",
    outputTarget: "active_note",
  });
  assert.equal(decision.profile, "grounded_research");
  assert.equal(decision.researchDepth, "grounded");
  assert.equal(decision.maxWallClockMs, 10 * 60_000);
});

test("short tool-bearing routes never inherit the no-tool Direct budget", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: "Summarize this note.",
    route: "grounded_workflow",
    outputTarget: "active_note",
  });
  assert.equal(decision.profile, "compose");
  assert.equal(decision.maxToolCalls, 4);
});

test("short Chat answers retain the one-call Direct ceiling", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: "What is 2+2?",
    route: "single_model_answer",
    outputTarget: "chat",
  });
  assert.equal(decision.profile, "direct");
  assert.equal(decision.maxModelCalls, 1);
  assert.equal(decision.maxToolCalls, 0);
});

test("extended research requires explicit research language and honors lower ceilings", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt:
      "Perform deep research and a systematic review of agent orchestration.",
    route: "grounded_workflow",
    outputTarget: "new_note",
    configuredMaxModelCalls: 5,
    configuredMaxToolCalls: 7,
    configuredMaxRunMinutes: 4,
  });
  assert.equal(decision.profile, "extended_team");
  assert.equal(decision.researchDepth, "extended");
  assert.equal(decision.maxModelCalls, 5);
  assert.equal(decision.maxToolCalls, 7);
  assert.equal(decision.maxWallClockMs, 4 * 60_000);
  assert.equal(decision.maxSegments, 3);
});
