import assert from "node:assert/strict";
import test from "node:test";
import {
  escalateMissionEffortDecisionForResearchV1,
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

const TRANSFORMER_BRIEF_PROMPT =
  "Can you write me a brief including diagrams, explaining in depth the transformer architecture and its importance?";

test("a compose mission that planning turns research-bearing is floored to the grounded budget", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: TRANSFORMER_BRIEF_PROMPT,
    route: "single_model_writeback",
    outputTarget: "new_note",
  });
  // The prompt has no explicit grounding words, so the regex decision picks
  // compose — the exact shape that starved when a model-based assist attached
  // a 3-source research contract afterward.
  assert.equal(decision.profile, "compose");
  const escalated = escalateMissionEffortDecisionForResearchV1(decision, {
    researchContractAttached: true,
  });
  assert.equal(escalated.profile, "grounded_research");
  assert.equal(escalated.researchDepth, "grounded");
  assert.ok(escalated.maxModelCalls >= 16);
  assert.ok(escalated.maxToolCalls >= 12);
  assert.ok(escalated.maxWallClockMs >= 10 * 60_000);
  assert.ok(
    escalated.escalationReasons.includes(
      "research_contract_attached_after_planning",
    ),
  );
});

test("escalation without a research contract is an identity", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: TRANSFORMER_BRIEF_PROMPT,
    route: "single_model_writeback",
    outputTarget: "new_note",
  });
  const untouched = escalateMissionEffortDecisionForResearchV1(decision, {
    researchContractAttached: false,
  });
  assert.equal(untouched, decision);
});

test("escalation never lowers an already grounded or extended decision", () => {
  const grounded = resolveMissionEffortDecisionV1({
    prompt: "Compare the latest sources on transformer architectures.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  });
  assert.equal(grounded.profile, "grounded_research");
  assert.equal(
    escalateMissionEffortDecisionForResearchV1(grounded, {
      researchContractAttached: true,
    }),
    grounded,
  );

  const extended = resolveMissionEffortDecisionV1({
    prompt: "Perform deep research on transformer architectures.",
    route: "grounded_workflow",
    outputTarget: "new_note",
  });
  assert.equal(extended.profile, "extended_team");
  assert.equal(
    escalateMissionEffortDecisionForResearchV1(extended, {
      researchContractAttached: true,
    }),
    extended,
  );
});

test("escalation still honors configured settings ceilings", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: TRANSFORMER_BRIEF_PROMPT,
    route: "single_model_writeback",
    outputTarget: "new_note",
    configuredMaxModelCalls: 10,
    configuredMaxToolCalls: 8,
    configuredMaxRunMinutes: 5,
  });
  const escalated = escalateMissionEffortDecisionForResearchV1(decision, {
    researchContractAttached: true,
    configuredMaxModelCalls: 10,
    configuredMaxToolCalls: 8,
    configuredMaxRunMinutes: 5,
  });
  assert.equal(escalated.profile, "grounded_research");
  assert.equal(escalated.maxModelCalls, 10);
  assert.equal(escalated.maxToolCalls, 8);
  assert.equal(escalated.maxWallClockMs, 5 * 60_000);
});

test("escalation keeps the larger of the current and grounded budgets", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: TRANSFORMER_BRIEF_PROMPT,
    route: "single_model_writeback",
    outputTarget: "new_note",
  });
  const inflated = {
    ...decision,
    maxModelCalls: 40,
    maxToolCalls: 30,
    maxWallClockMs: 30 * 60_000,
  };
  const escalated = escalateMissionEffortDecisionForResearchV1(inflated, {
    researchContractAttached: true,
  });
  assert.equal(escalated.maxModelCalls, 40);
  assert.equal(escalated.maxToolCalls, 30);
  assert.equal(escalated.maxWallClockMs, 30 * 60_000);
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
