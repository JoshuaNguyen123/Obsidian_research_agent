import test from "node:test";
import assert from "node:assert/strict";
import {
  DECISION_EVIDENCE_CLAUSES_V1,
  MISSION_DECISION_TEMPLATE_VERSION_V1,
  buildMissionDecisionRequestV1,
  compareMissionDecisionWithBaselineV1,
  createDecisionResearchAssistsV1,
  decideEvidenceContractV1,
  hasDecisionEvidenceClauseV1,
  interpretMissionDecisionV1,
  routedIntentFromAssessmentV1,
  type MissionDecisionAssessmentV1,
  type MutationFootprintV1,
} from "../src/decisions/missionDecisionAssessment";
import { DECISION_LIMITS_V1, checkDecisionRequestBoundsV1, type DecisionResultV1 } from "../src/decisions/decisionClient";
import {
  applyDefaultActiveNoteWriteback,
  classifyMissionIntent,
  getAllowedToolNamesForTests,
} from "../src/AgentRunner";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import { requiresVaultEvidenceProof, requiresWebEvidenceProof } from "../src/agent/evidenceIntent";
import {
  allowsResearchModeAssistActivation,
  createResearchPlan,
  parseExplicitResearchSourceCount,
  researchLadderToolNamesForPromptV1,
} from "../src/agent/researchPlan";
import { evaluateMissionAcceptance } from "../src/agent/missionAcceptance";
import { observeProductionRouting } from "./fixtures/routingGoldenCorpus";
import type { RoutedMissionIntent } from "../src/agent/missionRouter";

type Answers = Extract<DecisionResultV1, { status: "answered" }>["answers"];

function answered(answers: Partial<Answers>): DecisionResultV1 {
  return {
    status: "answered",
    purpose: "mission_assessment",
    templateVersion: MISSION_DECISION_TEMPLATE_VERSION_V1,
    inputFingerprint: "sha256:test",
    requestedModel: "typesafe/jev-1.13",
    reportedModel: "typesafe/jev-1.13-20260917",
    responseId: "gen-1",
    answers: {
      route: null,
      web_evidence: null,
      vault_evidence: null,
      research_mode: null,
      effort_tier: null,
      risk: null,
      freshness: null,
      ...answers,
    } as Answers,
    invalidAnswers: [],
    usage: null,
    durationMs: 120,
  };
}

function choice(value: string, probability: number, others: Record<string, number> = {}) {
  return {
    type: "choice" as const,
    choice: value,
    confidence: probability,
    probabilities: { [value]: probability, ...others },
  };
}

const webYes = { web_evidence: { type: "noul" as const, noul: 0.96 } };

function assessmentFor(answers: Partial<Answers>): MissionDecisionAssessmentV1 {
  return interpretMissionDecisionV1(answered(answers));
}

function footprint(prompt: string): MutationFootprintV1 {
  const intent = classifyMissionIntent(prompt, { hasActiveMarkdownNote: true });
  return {
    allowAutonomousWrite: intent.allowAutonomousWrite,
    explicitMutation: intent.explicitMutation,
    explicitDelete: intent.explicitDelete,
    requireWriteCompletion: intent.requireWriteCompletion,
    noteOutput: intent.noteOutput,
    write: intent.autonomyScope.write,
    destructive: intent.autonomyScope.destructive,
  };
}

function lexical(prompt: string) {
  const intent = classifyMissionIntent(prompt, { hasActiveMarkdownNote: true });
  return {
    web: requiresWebEvidenceProof(prompt, intent),
    vault: requiresVaultEvidenceProof(prompt, intent),
  };
}

const CATALOG = [
  "read_current_file",
  "append_to_current_file",
  "replace_current_file",
  "edit_current_section",
  "delete_path",
  "move_path",
  "create_file",
  "search_markdown_files",
  "semantic_search_notes",
  "read_markdown_files",
  "web_search",
  "web_fetch",
  "count_words",
];

const WRITE_TOOLS = new Set([
  "append_to_current_file",
  "replace_current_file",
  "edit_current_section",
  "delete_path",
  "move_path",
  "create_file",
]);

function offeredTools(prompt: string): string[] {
  const registry = new DefaultToolRegistry(
    CATALOG.map((name) => ({
      name,
      description: name,
      parameters: { type: "object" as const, properties: {} },
      execute: async () => ({ ok: true }),
    })),
  );
  const missionIntent = applyDefaultActiveNoteWriteback({
    prompt,
    missionIntent: classifyMissionIntent(prompt, { hasActiveMarkdownNote: true }),
    toolContext: {
      settings: { streamWritebackMode: "all_current_note_content_writes" },
      getCurrentMarkdownFile: () => ({ path: "Current.md", extension: "md" }) as never,
    } as never,
    enableStreaming: true,
    forceChatOnly: false,
  });
  return getAllowedToolNamesForTests(registry, prompt, missionIntent);
}

/** Evidence asked for in words the lexical detectors do not know. */
const PARAPHRASED_EVIDENCE_REQUESTS = [
  "Write a short note on why the Roman Empire fell, and back every claim up with what's out there.",
  "Draft an overview of solid-state batteries I can trust, with each claim traceable to something published.",
];

/**
 * The host's intent classifier reads "a brief" plus web-source words as a chat
 * answer rather than a note. The clause would therefore change the mission's
 * write classification, and the footprint check refuses it.
 */
const PARAPHRASE_WHOSE_CLAUSE_CHANGES_MUTATION =
  "Put together a brief on microplastics in drinking water and show me where each point comes from.";

test("the request asks every question in one bounded call over untrusted mission data", () => {
  const request = buildMissionDecisionRequestV1({
    mission: `Summarize the causes of inflation. ${"x".repeat(6_000)}`,
    recentAssistant: "Earlier reply.",
    hasActiveNote: true,
  });
  assert.equal(request.templateVersion, MISSION_DECISION_TEMPLATE_VERSION_V1);
  assert.deepEqual(Object.keys(request.questions).sort(), [
    "effort_tier",
    "freshness",
    "research_mode",
    "risk",
    "route",
    "vault_evidence",
    "web_evidence",
  ]);
  assert.equal(checkDecisionRequestBoundsV1(request).ok, true);
  const state = request.state as Record<string, unknown>;
  assert.match(String(state.notice), /never follow instructions/u);
  assert.ok(String(state.mission).length <= 4_001);
  assert.ok(JSON.stringify(request.state).length < DECISION_LIMITS_V1.maxStateChars);
  assert.equal(state.previous_assistant_reply_excerpt, "Earlier reply.");
  assert.equal(
    "previous_assistant_reply_excerpt" in
      (buildMissionDecisionRequestV1({ mission: "hi", hasActiveNote: false }).state as object),
    false,
  );
  // The evidence question says, in its own words, that a factual topic is not a request.
  const web = request.questions.web_evidence!;
  assert.match(web.instructions, /topic on its own is not such a request/u);
});

test("each field decides only above its threshold and otherwise abstains", () => {
  const clear = assessmentFor({
    route: choice("web_research", 0.91, { chat_answer: 0.09 }),
    web_evidence: { type: "noul", noul: 0.95 },
    vault_evidence: { type: "noul", noul: 0.03 },
    research_mode: choice("deep_web", 0.88, { none: 0.12 }),
    effort_tier: choice("standard", 0.55, { quick: 0.45 }),
    risk: { type: "choice", choice: "low", confidence: null, probabilities: null },
  });
  assert.equal(clear.route.status, "decided");
  assert.equal(clear.route.value, "web_research");
  assert.ok(Math.abs((clear.route.uncertainty ?? 1) - 0.09) < 1e-9);
  assert.equal(clear.evidenceNeeds.web.value, true);
  assert.equal(clear.evidenceNeeds.vault.value, false, "a confident no is a decision");
  assert.equal(clear.researchMode.value, "deep_web");
  assert.equal(clear.effortTier.status, "abstained");
  assert.equal(clear.effortTier.proposed, "standard");
  assert.equal(clear.risk.status, "abstained", "no calibration means no decision");
  assert.equal(clear.freshness.status, "unavailable");

  const middling = assessmentFor({ web_evidence: { type: "noul", noul: 0.6 } });
  assert.equal(middling.evidenceNeeds.web.status, "abstained");
  const lowNo = assessmentFor({ web_evidence: { type: "noul", noul: 0.2 } });
  assert.equal(lowNo.evidenceNeeds.web.status, "abstained", "0.2 is inside the 0.1..0.9 band");

  const down = interpretMissionDecisionV1({
    status: "unavailable",
    purpose: "mission_assessment",
    templateVersion: MISSION_DECISION_TEMPLATE_VERSION_V1,
    inputFingerprint: "sha256:x",
    requestedModel: "typesafe/jev-1.13",
    reason: "timeout",
    httpStatus: null,
    detail: "",
    durationMs: 2_000,
  });
  assert.equal(down.status, "unavailable");
  assert.equal(down.fallbackReason, "timeout");
  assert.equal(down.route.status, "unavailable");
});

test("the router adapter takes mutation and execution from the deterministic intent", () => {
  const regex: RoutedMissionIntent = {
    mode: "vault_write",
    writeScope: "current_note_append",
    needsWebEvidence: false,
    needsVaultContext: false,
    needsCodeExecution: false,
    wordTarget: null,
    confidence: 0.5,
    rationale: "regex",
  };
  const assessment = assessmentFor({
    route: choice("code_workflow", 0.95),
    ...webYes,
  });
  const routed = routedIntentFromAssessmentV1({
    assessment,
    regexIntent: regex,
    prompt: "Write about bread, and back it up with what's out there.",
    wordTarget: 300,
    model: "typesafe/jev-1.13",
  })!;
  assert.equal(routed.mode, "code_workflow");
  assert.equal(routed.writeScope, "current_note_append", "never from the decision model");
  assert.equal(routed.needsCodeExecution, false, "never from the decision model");
  assert.equal(routed.needsWebEvidence, true);
  assert.equal(routed.wordTarget, 300);
  assert.equal(routed.confidence, 0.95);
  assert.match(routed.rationale, /^Decision model typesafe\/jev-1\.13-20260917: route=code_workflow p=0\.95/u);

  const noWeb = routedIntentFromAssessmentV1({
    assessment,
    regexIntent: regex,
    prompt: "Write about bread; do not use the web.",
    wordTarget: null,
    model: "typesafe/jev-1.13",
  })!;
  assert.equal(noWeb.needsWebEvidence, false, "an explicit prohibition outranks the decision");

  const abstained = routedIntentFromAssessmentV1({
    assessment: assessmentFor({ route: choice("web_research", 0.6, { chat_answer: 0.4 }) }),
    regexIntent: regex,
    prompt: "x",
    wordTarget: null,
    model: "m",
  });
  assert.equal(abstained, null, "an uncertain route leaves the existing router in charge");
});

test("paraphrased evidence requests are invisible to the lexical detectors", () => {
  for (const prompt of PARAPHRASED_EVIDENCE_REQUESTS) {
    assert.deepEqual(lexical(prompt), { web: false, vault: false }, prompt);
  }
});

test("a confident semantic evidence request becomes the same contract the words would make", () => {
  const assessment = assessmentFor(webYes);
  for (const prompt of PARAPHRASED_EVIDENCE_REQUESTS) {
    const decision = decideEvidenceContractV1({
      prompt,
      assessment,
      lexical: lexical(prompt),
      mutationFootprint: footprint,
    });
    assert.equal(decision.reason, "applied", prompt);
    assert.equal(decision.contract?.web, true);
    assert.equal(decision.contract?.vault, false);
    assert.ok(decision.prompt.endsWith(DECISION_EVIDENCE_CLAUSES_V1.web));
    assert.equal(hasDecisionEvidenceClauseV1(decision.prompt), true);
    const augmented = decision.prompt;
    const intent = classifyMissionIntent(augmented, { hasActiveMarkdownNote: true });

    // Acceptance: the web-evidence proof is now owed.
    assert.equal(requiresWebEvidenceProof(augmented, intent), true);
    const acceptance = evaluateMissionAcceptance({
      prompt: augmented,
      missionIntent: intent,
      requiredTools: [],
      successfulTools: [],
      failedTools: [],
      evidence: [],
      receipts: [],
      operationGoals: {},
    });
    assert.ok(acceptance.missing.includes("web_evidence"), prompt);

    // Planning: exactly as for a literal "cite web sources" prompt, the
    // research-mode assist is now allowed to plan, and the plan it would make
    // (the decision model's own deep_web) carries a fetched-source floor.
    const routing = observeProductionRouting({ prompt: augmented });
    assert.equal(allowsResearchModeAssistActivation(prompt, classifyMissionIntent(prompt, { hasActiveMarkdownNote: true })), false);
    assert.equal(allowsResearchModeAssistActivation(augmented, intent), true);
    const plan = createResearchPlan({
      prompt: augmented,
      missionIntent: intent,
      runPlan: { route: routing.route, slowPathReason: "needs_web_sources" },
      modeOverride: "deep_web",
    });
    assert.equal(plan?.mode, "deep_web", prompt);
    assert.ok((plan?.sourceRequirements.minFetchedSources ?? 0) >= 1);
    // Graph prerequisites: the runner sizes the ladder from the plan and from
    // requiresWebEvidenceProof, both of which now read the contract.
    const requiredGraphFetchCount = Math.max(
      plan!.sourceRequirements.minFetchedSources,
      requiresWebEvidenceProof(augmented, intent) ? (parseExplicitResearchSourceCount(augmented) ?? 1) : 0,
    );
    const ladder = researchLadderToolNamesForPromptV1(augmented, requiredGraphFetchCount);
    assert.equal(ladder[0], "web_search");
    assert.ok(ladder.includes("web_fetch"));
    assert.deepEqual(researchLadderToolNamesForPromptV1(prompt, 0), []);

    // Tool exposure: web tools are offered, and no write tool changes.
    const before = offeredTools(prompt);
    const after = offeredTools(augmented);
    assert.ok(after.includes("web_search") || after.includes("web_fetch"), prompt);
    assert.deepEqual(
      after.filter((name) => WRITE_TOOLS.has(name)).sort(),
      before.filter((name) => WRITE_TOOLS.has(name)).sort(),
      `write tools changed for: ${prompt}`,
    );

    // Routing: note output destination and mutation are unchanged.
    const baseRouting = observeProductionRouting({ prompt });
    assert.equal(routing.noteOutput.destination, baseRouting.noteOutput.destination);
    assert.equal(routing.noteOutput.mutation, baseRouting.noteOutput.mutation);
    assert.deepEqual(footprint(augmented), footprint(prompt));
  }
});

test("a vault clause that would turn a note-writing mission into a chat answer is refused", () => {
  // Vault vocabulary moves the host's intent classifier from note_output to
  // vault_context_answer, which would silently drop the note the user asked
  // for. The footprint check refuses it; the vault need still reaches the
  // router as read-only context through the routed intent.
  const prompt = "Pull together what I've already jotted down about sleep hygiene into a summary.";
  const before = lexical(prompt);
  assert.equal(before.vault, false);
  const decision = decideEvidenceContractV1({
    prompt,
    assessment: assessmentFor({ vault_evidence: { type: "noul", noul: 0.97 } }),
    lexical: before,
    mutationFootprint: footprint,
  });
  assert.equal(decision.reason, "changed_mutation");
  assert.equal(decision.contract, null);
  assert.equal(decision.prompt, prompt);
});

test("explicit constraints always outrank a semantic evidence request", () => {
  const assessment = assessmentFor(webYes);
  const cases: Array<[string, string]> = [
    ["Write about tides and back it up with what's out there, but do not use the web.", "explicit_no_web"],
    ["Just answer in chat, don't write to my note: why is the sky blue, and how do we know?", "explicit_chat_only"],
    ["Use web_fetch exactly once on https://example.com/a and do not search.", "exact_fetch_only"],
    ["Write an essay on Hamlet's indecision with quotes from the text to back it up.", "literary_primary_text"],
    ["How many words is this note, and can you back that up?", "word_count_request"],
    ["Write a Python script that downloads the dataset and back the approach up with what's out there.", "code_mission"],
  ];
  for (const [prompt, reason] of cases) {
    const decision = decideEvidenceContractV1({
      prompt,
      assessment,
      lexical: lexical(prompt),
      mutationFootprint: footprint,
    });
    assert.equal(decision.contract, null, prompt);
    assert.equal(decision.prompt, prompt, "the routing prompt is untouched");
    if (decision.reason !== "already_explicit") {
      assert.equal(decision.reason, reason, prompt);
    }
  }
});

test("exact source counts stay under the deterministic parser", () => {
  const prompt =
    "Write a brief on coral bleaching using exactly 2 sources, and back every claim with what's out there.";
  const decision = decideEvidenceContractV1({
    prompt,
    assessment: assessmentFor(webYes),
    lexical: lexical(prompt),
    mutationFootprint: footprint,
  });
  const augmented = decision.prompt;
  assert.equal(parseExplicitResearchSourceCount(augmented), 2);
  const intent = classifyMissionIntent(augmented, { hasActiveMarkdownNote: true });
  const plan = createResearchPlan({
    prompt: augmented,
    missionIntent: intent,
    runPlan: { route: "grounded_workflow", slowPathReason: "needs_web_sources" },
    modeOverride: "deep_web",
  });
  assert.equal(plan?.sourceRequirements.minFetchedSources, 2);
});

test("a real clause that would change the write classification is refused", () => {
  const prompt = PARAPHRASE_WHOSE_CLAUSE_CHANGES_MUTATION;
  assert.deepEqual(lexical(prompt), { web: false, vault: false });
  const decision = decideEvidenceContractV1({
    prompt,
    assessment: assessmentFor(webYes),
    lexical: lexical(prompt),
    mutationFootprint: footprint,
  });
  assert.equal(decision.reason, "changed_mutation");
  assert.equal(decision.prompt, prompt);
});

test("a clause that would change any mutation classification is refused", () => {
  let calls = 0;
  const decision = decideEvidenceContractV1({
    prompt: PARAPHRASED_EVIDENCE_REQUESTS[0]!,
    assessment: assessmentFor(webYes),
    lexical: { web: false, vault: false },
    mutationFootprint: (prompt) => ({
      ...footprint(prompt),
      explicitDelete: prompt.includes("Evidence requested") ? (calls += 1) > 0 : false,
    }),
  });
  assert.equal(decision.reason, "changed_mutation");
  assert.equal(decision.contract, null);
});

test("no request, an abstention, or an outage leaves the prompt untouched", () => {
  const prompt = PARAPHRASED_EVIDENCE_REQUESTS[1]!;
  for (const assessment of [
    assessmentFor({ web_evidence: { type: "noul", noul: 0.1 } }),
    assessmentFor({ web_evidence: { type: "noul", noul: 0.7 } }),
    interpretMissionDecisionV1({
      status: "unavailable",
      purpose: "mission_assessment",
      templateVersion: MISSION_DECISION_TEMPLATE_VERSION_V1,
      inputFingerprint: "sha256:x",
      requestedModel: "typesafe/jev-1.13",
      reason: "network",
      httpStatus: null,
      detail: "",
      durationMs: 1,
    }),
  ]) {
    const decision = decideEvidenceContractV1({
      prompt,
      assessment,
      lexical: lexical(prompt),
      mutationFootprint: footprint,
    });
    assert.equal(decision.contract, null);
    assert.equal(decision.prompt, prompt);
    assert.equal(decision.reason, "not_requested");
  }
});

test("research assists use decided fields and fall back per field to the existing classifier", async () => {
  const events: string[] = [];
  let fallbackModeCalls = 0;
  let fallbackEffortCalls = 0;
  const decided = assessmentFor({
    research_mode: choice("deep_hybrid", 0.9),
    effort_tier: choice("deep", 0.85),
    risk: choice("high", 0.8),
    freshness: choice("required", 0.9),
  });
  const partial = assessmentFor({
    research_mode: choice("deep_web", 0.5, { none: 0.5 }),
    effort_tier: choice("quick", 0.92),
  });
  const table = new Map([
    ["decided", decided],
    ["partial", partial],
  ]);
  const assists = createDecisionResearchAssistsV1({
    assessmentFor: async (prompt) => table.get(prompt) ?? null,
    fallbackModeAssist: async () => {
      fallbackModeCalls += 1;
      return { mode: "deep_web", sourceFloor: 3 };
    },
    fallbackEffortAssist: async () => {
      fallbackEffortCalls += 1;
      return { tier: "extended", risk: "low", freshness: "none" };
    },
    onDecision: (event) => events.push(`${event.question}:${event.source}`),
  });
  assert.deepEqual(await assists.modeAssist({ prompt: "decided" }), { mode: "deep_hybrid" });
  assert.deepEqual(await assists.effortAssist({ prompt: "decided", mode: "deep_web" }), {
    tier: "deep",
    risk: "high",
    freshness: "required",
  });
  assert.equal(fallbackModeCalls, 0);
  assert.equal(fallbackEffortCalls, 0, "a complete decision replaces the utility call");

  assert.deepEqual(await assists.modeAssist({ prompt: "partial" }), { mode: "deep_web", sourceFloor: 3 });
  assert.deepEqual(await assists.effortAssist({ prompt: "partial", mode: "deep_web" }), {
    tier: "quick",
    risk: "low",
    freshness: "none",
  });
  assert.equal(fallbackModeCalls, 1);
  assert.equal(fallbackEffortCalls, 1);
  assert.deepEqual(events, [
    "research_mode:decision_model",
    "effort:decision_model",
    "research_mode:existing_classifier",
    "effort:decision_model",
  ]);

  const bare = createDecisionResearchAssistsV1({ assessmentFor: async () => null });
  assert.equal(await bare.modeAssist({ prompt: "x" }), null);
  assert.equal(await bare.effortAssist({ prompt: "x", mode: "deep_web" }), null);
});

test("shadow comparison records agreement only on decided fields", () => {
  const comparison = compareMissionDecisionWithBaselineV1(
    assessmentFor({
      route: choice("web_research", 0.9),
      ...webYes,
      research_mode: choice("deep_web", 0.6, { none: 0.4 }),
    }),
    {
      routerMode: "authority",
      route: "chat_answer",
      lexicalWeb: false,
      lexicalVault: false,
      researchMode: "none",
      effortTier: null,
      risk: null,
      freshness: null,
    },
  );
  assert.equal(comparison.agreement.route, false);
  assert.equal(comparison.agreement.web, false);
  assert.equal(comparison.agreement.researchMode, null);
  assert.equal(comparison.agreement.effortTier, null);
  assert.equal(comparison.decision.webProbability, 0.96);
});
