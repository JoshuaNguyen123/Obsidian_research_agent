import assert from "node:assert/strict";
import test from "node:test";
import { missionGrantsDesignCapability } from "../src/agent/codeDesignIntent";
import { hasCodeDeliverableIntent } from "../src/agent/codeDeliverableIntent";
import {
  analyzeCurrentNoteResetPrompt,
  hasPageContentClearIntent,
} from "../src/agent/currentNoteResetPolicy";
import { isLiteraryPrimaryTextWriteMission } from "../src/agent/evidenceIntent";
import { analyzeGeneratedOutputPrompt } from "../src/agent/generatedOutputPolicy";
import {
  hasExplicitGroundingIntentV1,
  resolveMissionEffortDecisionV1,
} from "../src/agent/missionEffortDecision";
import {
  detectExplicitActiveNoteTarget,
} from "../src/agent/noteOutputPolicy";
import {
  hasCurrentPageWritebackIntent,
  hasDeleteIntent,
  hasExplicitStreamToCurrentNoteIntent,
  hasFetchedWebSourceIntent,
  hasReplaceIntent,
  hasWebSearchIntent,
  isRecentAssistantWritebackFollowup,
} from "../src/agent/promptIntentClassifiers";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";
import { resolveAdaptiveTeamDispatchV2 } from "../src/agent/researchTeamDispatch";
import {
  isExplicitVisibleFileRenameIntent,
  isTitleOnlyIntent,
} from "../src/agent/titleIntent";
import { hasWordCountIntent } from "../src/agent/wordCountIntent";
import {
  compactDomainResearchPrompt,
  DOMAIN_RESEARCH_CASES,
  PAGE_CLEAR_DELATE,
  PAGE_CLEAR_FIRST,
  PAGE_CLEAR_THEN_REWRITE,
  TRANSFORMER_ARCHITECTURE_RESEARCH_PROMPT,
} from "./fixtures/domainResearchPrompts";
import { observeProductionRouting } from "./fixtures/routingGoldenCorpus";

test("STEM Genesis-shaped prompts route as streamed sourced writeback, not copy-last-reply", async () => {
  for (const item of DOMAIN_RESEARCH_CASES) {
    const { prompt, id } = item;
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const observed = observeProductionRouting({ prompt });
    const effort = resolveMissionEffortDecisionV1({
      prompt,
      route: observed.route,
      outputTarget: observed.noteOutput.destination,
    });
    const team = await resolveAdaptiveTeamDispatchV2({
      prompt,
      orchestratorEnabled: true,
      forceChatOnly: false,
    });

    assert.equal(isRecentAssistantWritebackFollowup(prompt), false, id);
    assert.equal(hasPageContentClearIntent(prompt), false, id);
    assert.equal(isLiteraryPrimaryTextWriteMission(prompt), false, id);
    assert.equal(hasCodeDeliverableIntent(prompt), false, id);
    assert.equal(missionGrantsDesignCapability(prompt), false, id);
    assert.equal(hasWordCountIntent(prompt), false, id);
    assert.equal(isTitleOnlyIntent(prompt), false, id);

    assert.equal(hasFetchedWebSourceIntent(prompt), true, id);
    assert.equal(hasWebSearchIntent(prompt), true, id);
    assert.equal(hasExplicitGroundingIntentV1(prompt), true, id);
    assert.equal(hasCurrentPageWritebackIntent(prompt), true, id);
    assert.equal(hasExplicitStreamToCurrentNoteIntent(prompt), true, id);
    assert.equal(detectExplicitActiveNoteTarget(prompt), true, id);
    assert.equal(isExplicitVisibleFileRenameIntent(prompt), true, id);

    assert.equal(generated.requiresGrounding, true, id);
    assert.equal(generated.target, "current_note_append", id);
    assert.equal(generated.wordTarget?.target, 1000, id);
    assert.notEqual(generated.kind, "diagram", id);

    assert.equal(observed.route, "grounded_workflow", id);
    assert.equal(observed.streamingWritebackKind, "append", id);
    assert.equal(observed.noteOutput.destination, "active_note", id);
    assert.equal(observed.noteOutput.mutation, "append", id);
    assert.equal(observed.noteOutput.delivery, "stream", id);
    assert.equal(observed.noteOutput.reason, "active_note_available", id);

    assert.equal(effort.profile, "grounded_research", id);
    assert.equal(effort.researchDepth, "grounded", id);

    assert.equal(team.useTeam, true, id);
    assert.equal(team.orchestrationMode, "adaptive_team", id);
    assert.equal(team.initialSpecialistMode, "researcher", id);
    assert.ok(team.specialistModes.includes("researcher"), id);
    assert.ok(!team.specialistModes.includes("code_builder"), id);
    assert.ok(!team.specialistModes.includes("linear_planner"), id);
  }
});

test("compact live STEM prompts keep the same sourced stream-to-page contract", async () => {
  for (const item of DOMAIN_RESEARCH_CASES) {
    const prompt = compactDomainResearchPrompt(item.topic, "e2e-marker");
    const generated = analyzeGeneratedOutputPrompt(prompt);
    const observed = observeProductionRouting({ prompt });
    const team = await resolveAdaptiveTeamDispatchV2({
      prompt,
      orchestratorEnabled: true,
      forceChatOnly: false,
    });

    assert.equal(isRecentAssistantWritebackFollowup(prompt), false, item.id);
    assert.equal(isLiteraryPrimaryTextWriteMission(prompt), false, item.id);
    assert.equal(missionGrantsDesignCapability(prompt), false, item.id);
    assert.equal(hasFetchedWebSourceIntent(prompt), true, item.id);
    assert.equal(hasCurrentPageWritebackIntent(prompt), true, item.id);
    assert.equal(generated.requiresGrounding, true, item.id);
    assert.equal(generated.target, "current_note_append", item.id);
    assert.equal(generated.wordTarget?.target, 150, item.id);
    assert.equal(observed.noteOutput.destination, "active_note", item.id);
    assert.equal(observed.noteOutput.mutation, "append", item.id);
    assert.equal(observed.noteOutput.delivery, "stream", item.id);
    assert.equal(team.useTeam, true, item.id);
    assert.ok(team.specialistModes.includes("researcher"), item.id);
  }
});

test("transformer architecture research note does not grant a design deliverable", () => {
  const prompt = TRANSFORMER_ARCHITECTURE_RESEARCH_PROMPT;
  const generated = analyzeGeneratedOutputPrompt(prompt);
  const observed = observeProductionRouting({ prompt });
  assert.equal(missionGrantsDesignCapability(prompt), false);
  assert.notEqual(generated.kind, "diagram");
  assert.equal(generated.requiresGrounding, true);
  assert.equal(hasFetchedWebSourceIntent(prompt), true);
  assert.equal(hasWebSearchIntent(prompt), true);
  assert.equal(observed.route, "grounded_workflow");
  assert.equal(observed.noteOutput.destination, "active_note");
  assert.equal(observed.noteOutput.mutation, "append");
  assert.equal(observed.noteOutput.delivery, "stream");
});

test("cite-at-least scholarly sources is fetched-web intent; literary book citations are not", () => {
  assert.equal(
    hasFetchedWebSourceIntent(
      "Cite at least 5-10 scholarly and academic sources.",
    ),
    true,
  );
  assert.equal(
    hasFetchedWebSourceIntent("Cite at least two scholarly and academic sources."),
    true,
  );
  assert.equal(hasWebSearchIntent(DOMAIN_RESEARCH_CASES[0]!.prompt), true);
  assert.equal(
    hasFetchedWebSourceIntent(
      "Write an essay. Use quotations and citations from the book.",
    ),
    false,
  );
});

test("page-clear follow-ups after a STEM draft replace the page instead of appending", () => {
  for (const prompt of [
    PAGE_CLEAR_THEN_REWRITE,
    PAGE_CLEAR_FIRST,
    PAGE_CLEAR_DELATE,
  ]) {
    assert.equal(hasPageContentClearIntent(prompt), true, prompt);
    assert.equal(isRecentAssistantWritebackFollowup(prompt), false, prompt);
    assert.equal(hasDeleteIntent(prompt), false, prompt);
    assert.equal(hasReplaceIntent(prompt), true, prompt);
    assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), true, prompt);
    assert.equal(
      analyzeGeneratedOutputPrompt(prompt).target,
      "current_note_replace",
      prompt,
    );
    assert.deepEqual(analyzeCurrentNoteResetPrompt(prompt), {
      kind: "replace_current_note",
      reason: "clear_then_write",
    });
    const observed = observeProductionRouting({ prompt });
    assert.equal(observed.noteOutput.destination, "active_note", prompt);
    assert.equal(observed.noteOutput.mutation, "replace", prompt);
    assert.equal(observed.streamingWritebackKind, "replace", prompt);
  }
});
