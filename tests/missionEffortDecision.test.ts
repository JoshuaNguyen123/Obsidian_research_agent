import assert from "node:assert/strict";
import test from "node:test";
import {
  escalateMissionEffortDecisionForResearchV1,
  resolveMissionEffortDecisionV1,
} from "../src/agent/missionEffortDecision";
import { detectProjectLifecycleStagesV1 } from "../src/agent/projectLifecycle";
import { missionRequiresExtendedEffortBudgetV1 } from "../src/agent/missionEffortEscalation";
import { buildByokPhaseAResearchPrompt } from "../e2e/fixtures/byokAutonomousJourneyPrompt";

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
  // Configured values now take effect in either direction; 100 > compose
  // default (6) so the configured value wins.
  assert.equal(decision.maxModelCalls, 100);
  assert.equal(decision.maxToolCalls, 4);
  // 60-minute configured run time raises the compose default of 3 minutes.
  assert.equal(decision.maxWallClockMs, 60 * 60_000);
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

// A code-delivery mission commits the whole workspace ladder — sandbox status,
// workspace create, file create, fast/targeted/full validation, directory
// export — before any repair. Escalating only on multi-stage prompts left that
// mission on the compose budget: 4 tool calls and a 3-minute wall clock, which
// killed it mid-validation and left a continuation the reconciler refused.
const DESKTOP_CODE_PROMPT =
  "write a number guessing game in Python on my desktop";
const CODE_LADDER_TOOL_COUNT = 7;

test("a single detected code stage escalates out of the compose budget", () => {
  assert.equal(
    missionRequiresExtendedEffortBudgetV1(DESKTOP_CODE_PROMPT),
    true,
    "one code_execution stage must escalate on its own",
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(DESKTOP_CODE_PROMPT),
    ["code_execution"],
    "the guard must still fire on a genuinely single-stage prompt",
  );

  const starved = resolveMissionEffortDecisionV1({
    prompt: DESKTOP_CODE_PROMPT,
    route: "mission",
    outputTarget: "chat",
    configuredMaxRunMinutes: 35,
  });
  const escalated = resolveMissionEffortDecisionV1({
    prompt: DESKTOP_CODE_PROMPT,
    route: "mission",
    outputTarget: "chat",
    configuredMaxRunMinutes: 35,
    forceExtendedTeam: missionRequiresExtendedEffortBudgetV1(
      DESKTOP_CODE_PROMPT,
    ),
  });

  // The regression this pins: the un-escalated budget cannot even reach the
  // export receipt the lane requires.
  assert.ok(
    starved.maxToolCalls < CODE_LADDER_TOOL_COUNT,
    `compose was expected to starve the ladder, got ${starved.maxToolCalls}`,
  );
  assert.ok(
    escalated.maxToolCalls >= CODE_LADDER_TOOL_COUNT,
    `escalated tool budget ${escalated.maxToolCalls} cannot run the ${CODE_LADDER_TOOL_COUNT}-tool ladder`,
  );
  assert.ok(
    escalated.maxWallClockMs >= 10 * 60_000,
    `escalated wall clock ${escalated.maxWallClockMs} is below the observed 7.7-minute success`,
  );
  assert.ok(
    escalated.maxModelCalls >= starved.maxModelCalls &&
      escalated.maxToolCalls >= starved.maxToolCalls &&
      escalated.maxWallClockMs >= starved.maxWallClockMs,
    "escalation must never lower a budget",
  );
});

test("escalation still respects the caller's configured ceilings", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt: DESKTOP_CODE_PROMPT,
    route: "mission",
    outputTarget: "chat",
    configuredMaxModelCalls: 9,
    configuredMaxToolCalls: 9,
    configuredMaxRunMinutes: 2,
    forceExtendedTeam: true,
  });
  assert.equal(decision.maxModelCalls, 9);
  assert.equal(decision.maxToolCalls, 9);
  assert.equal(decision.maxWallClockMs, 2 * 60_000);
});

test("a prompt with no code stage keeps the cheap budget", () => {
  assert.equal(
    missionRequiresExtendedEffortBudgetV1(
      "summarize the note I have open in three bullets",
    ),
    false,
  );
});

// The BYOK journey's Phase A detects only ["accepted_research"], so the
// lifecycle half of the guard never fired. It drew grounded_research's 12 tool
// calls, spent nine of them gathering evidence, and could not add
// publish_research_to_linear at all: "the host envelope is exhausted and its
// nonterminal continuation node lacks enough reserved budget". Its lane asks
// for maxAgentSteps 160 and still got 12, because a configured ceiling only
// ever lowers a profile default.
const PUBLICATION_LADDER_TOOL_COUNT = 12;

test("explicit research-publication intent escalates past the grounded budget", () => {
  const phaseA = buildByokPhaseAResearchPrompt({
    marker: "effort-budget-regression",
    profileKey: "profile-key",
    validationProfileKey: "validation-profile-key",
  });
  assert.deepEqual(
    detectProjectLifecycleStagesV1(phaseA),
    ["accepted_research"],
    "the lifecycle half of the guard must still not fire on this prompt",
  );
  assert.equal(
    missionRequiresExtendedEffortBudgetV1(phaseA),
    true,
    "publication intent must escalate even with a single detected stage",
  );

  const starved = resolveMissionEffortDecisionV1({
    prompt: phaseA,
    route: "grounded_workflow",
    outputTarget: "new_note",
    configuredMaxModelCalls: 160,
    configuredMaxToolCalls: 160,
    configuredMaxRunMinutes: 90,
  });
  const escalated = resolveMissionEffortDecisionV1({
    prompt: phaseA,
    route: "grounded_workflow",
    outputTarget: "new_note",
    configuredMaxModelCalls: 160,
    configuredMaxToolCalls: 160,
    configuredMaxRunMinutes: 90,
    forceExtendedTeam: missionRequiresExtendedEffortBudgetV1(phaseA),
  });

  assert.equal(
    starved.maxToolCalls,
    160,
    "with ceiling math fixed, configured 160 overrides the grounded default of 12",
  );
  assert.ok(
    escalated.maxToolCalls > PUBLICATION_LADDER_TOOL_COUNT,
    `escalated tool budget ${escalated.maxToolCalls} still cannot outrun evidence gathering`,
  );
  assert.ok(
    escalated.maxModelCalls >= starved.maxModelCalls &&
      escalated.maxWallClockMs >= starved.maxWallClockMs,
    "escalation must never lower a budget",
  );
});

test("plain research without publication intent keeps the grounded budget", () => {
  const prompt =
    "Research agent orchestration using current sources and citations.";
  assert.equal(missionRequiresExtendedEffortBudgetV1(prompt), false);
  const decision = resolveMissionEffortDecisionV1({
    prompt,
    route: "grounded_workflow",
    outputTarget: "new_note",
    forceExtendedTeam: missionRequiresExtendedEffortBudgetV1(prompt),
  });
  assert.equal(decision.profile, "grounded_research");
});

// --- P3: ceiling math regression pins ---

test("grounded + configured 160 → tools follow configured", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt:
      "Research the latest sources on transformer architectures and write a note.",
    route: "grounded_workflow",
    outputTarget: "new_note",
    configuredMaxModelCalls: 160,
    configuredMaxToolCalls: 160,
    configuredMaxRunMinutes: 35,
  });
  assert.equal(decision.profile, "grounded_research");
  // Configured 160 > grounded default (16/12); it must win.
  assert.equal(decision.maxModelCalls, 160);
  assert.equal(decision.maxToolCalls, 160);
  assert.equal(decision.maxWallClockMs, 35 * 60_000);
});

test("configured 8 on a grounded profile → 8", () => {
  const decision = resolveMissionEffortDecisionV1({
    prompt:
      "Fact-check this claim using current sources and provide citations.",
    route: "grounded_workflow",
    outputTarget: "chat",
    configuredMaxModelCalls: 8,
    configuredMaxToolCalls: 8,
    configuredMaxRunMinutes: 7,
  });
  assert.equal(decision.profile, "grounded_research");
  // Configured 8 < grounded defaults (16/12); it still wins (acts as a ceiling).
  assert.equal(decision.maxModelCalls, 8);
  assert.equal(decision.maxToolCalls, 8);
  assert.equal(decision.maxWallClockMs, 7 * 60_000);
});

test("escalation floor + lower configured still clamps", () => {
  // A compose decision with a very low configured cap escalates to grounded,
  // but the configured lower ceiling still constrains the escalated budget.
  const decision = resolveMissionEffortDecisionV1({
    prompt: TRANSFORMER_BRIEF_PROMPT,
    route: "single_model_writeback",
    outputTarget: "new_note",
    configuredMaxModelCalls: 4,
    configuredMaxToolCalls: 3,
    configuredMaxRunMinutes: 2,
  });
  assert.equal(decision.profile, "compose");
  assert.equal(decision.maxModelCalls, 4);
  assert.equal(decision.maxToolCalls, 3);
  const escalated = escalateMissionEffortDecisionForResearchV1(decision, {
    researchContractAttached: true,
    configuredMaxModelCalls: 4,
    configuredMaxToolCalls: 3,
    configuredMaxRunMinutes: 2,
  });
  assert.equal(escalated.profile, "grounded_research");
  // Grounded floor is (16/12/10min), but configured ceiling is (4/3/2min).
  // The configured lower value must still clamp after escalation.
  assert.equal(escalated.maxModelCalls, 4);
  assert.equal(escalated.maxToolCalls, 3);
  assert.equal(escalated.maxWallClockMs, 2 * 60_000);
});
