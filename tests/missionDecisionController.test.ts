import test from "node:test";
import assert from "node:assert/strict";
import {
  createMissionDecisionControllerV1,
  promptFingerprintV1,
  type MissionDecisionTraceV1,
} from "../src/decisions/missionDecisionController";
import {
  DECISION_EVIDENCE_CLAUSES_V1,
  MISSION_DECISION_TEMPLATE_VERSION_V1,
  type MutationFootprintV1,
} from "../src/decisions/missionDecisionAssessment";
import type { DecisionRequestV1, DecisionResultV1 } from "../src/decisions/decisionClient";
import type { DecisionCallRecordV1, DecisionRuntimeV1 } from "../src/decisions/decisionRuntime";
import type { DecisionModelModeV1 } from "../src/decisions/decisionSettings";

type Answers = Extract<DecisionResultV1, { status: "answered" }>["answers"];

const PROMPT =
  "Write a short note on why the Roman Empire fell, and back every claim up with what's out there.";

const STILL: MutationFootprintV1 = {
  allowAutonomousWrite: true,
  explicitMutation: true,
  explicitDelete: false,
  requireWriteCompletion: true,
  noteOutput: true,
  write: true,
  destructive: false,
};

function answered(answers: Partial<Answers>): DecisionResultV1 {
  return {
    status: "answered",
    purpose: "mission_assessment",
    templateVersion: MISSION_DECISION_TEMPLATE_VERSION_V1,
    inputFingerprint: "sha256:controller",
    requestedModel: "typesafe/jev-1.13",
    reportedModel: "typesafe/jev-1.13",
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
    durationMs: 90,
  };
}

function choice(value: string, probability: number) {
  return {
    type: "choice" as const,
    choice: value,
    confidence: probability,
    probabilities: { [value]: probability, other: 1 - probability },
  };
}

const CONFIDENT = answered({
  route: choice("note_output", 0.93),
  web_evidence: { type: "noul", noul: 0.97 },
  vault_evidence: { type: "noul", noul: 0.04 },
  research_mode: choice("deep_web", 0.9),
  effort_tier: choice("standard", 0.85),
  risk: choice("low", 0.8),
  freshness: choice("stable", 0.8),
} as Partial<Answers>);

function fakeRuntime(
  effective: DecisionModelModeV1,
  result: DecisionResultV1 = CONFIDENT,
): DecisionRuntimeV1 & { asked: DecisionRequestV1[] } {
  const asked: DecisionRequestV1[] = [];
  const records: DecisionCallRecordV1[] = [];
  return {
    asked,
    configuredMode: effective,
    model: "typesafe/jev-1.13",
    componentMode: (component) => ({
      component,
      configured: effective,
      effective,
      heldInShadowBecause: null,
    }),
    async decide(_component, request) {
      asked.push(request);
      records.push({
        version: 1,
        id: `decision-test-${asked.length}`,
        component: "mission_routing",
        purpose: request.purpose,
        mode: effective,
        model: "typesafe/jev-1.13",
        reportedModel: "typesafe/jev-1.13",
        templateVersion: request.templateVersion,
        inputFingerprint: `sha256:${asked.length}`,
        outcome: "answered",
        fallbackReason: null,
        durationMs: 90,
        cost: 0.0001,
        inputTokens: 10,
        outputTokens: 2,
        httpStatus: 200,
        at: "2026-09-28T00:00:00.000Z",
      });
      return result;
    },
    records: () => records,
  };
}

function controllerFor(runtime: DecisionRuntimeV1 | null) {
  const traces: MissionDecisionTraceV1[] = [];
  const controller = createMissionDecisionControllerV1({
    runtime,
    getAbortSignal: () => undefined,
    onTrace: (event) => traces.push(event),
  });
  return { controller, traces };
}

test("with no runtime the controller is Off and never asks", async () => {
  const { controller } = controllerFor(null);
  assert.equal(controller.mode, "off");
  assert.equal(await controller.assessForRouting({ prompt: PROMPT, hasActiveNote: true }), null);
  const evidence = controller.applyEvidenceContract({
    prompt: PROMPT,
    lexical: { web: false, vault: false },
    mutationFootprint: () => STILL,
  });
  assert.equal(evidence.prompt, PROMPT);
  assert.equal(evidence.contract, null);
  assert.equal(controller.ledger(), null);
});

test("Enabled asks once per routing prompt and aliases the augmented prompt to the same answer", async () => {
  const runtime = fakeRuntime("enabled");
  const { controller } = controllerFor(runtime);
  const assessment = await controller.assessForRouting({ prompt: PROMPT, hasActiveNote: true });
  assert.ok(assessment);
  await controller.assessForRouting({ prompt: PROMPT, hasActiveNote: true });
  assert.equal(runtime.asked.length, 1, "the same prompt is never asked twice");

  const evidence = controller.applyEvidenceContract({
    prompt: PROMPT,
    lexical: { web: false, vault: false },
    mutationFootprint: () => STILL,
  });
  assert.ok(evidence.contract?.web);
  assert.ok(evidence.prompt.endsWith(DECISION_EVIDENCE_CLAUSES_V1.web));

  // Later stages read the augmented prompt; they get the same assessment and
  // never start a second question.
  const assists = controller.researchAssists({}, {});
  const mode = await assists.modeAssist?.({ prompt: evidence.prompt } as never);
  assert.equal(mode?.mode, "deep_web");
  assert.equal(runtime.asked.length, 1);

  const ledger = controller.ledger();
  assert.equal(ledger?.records.length, 1);
  assert.equal(ledger?.missionContract?.promptFingerprint, promptFingerprintV1(PROMPT));
  assert.ok(ledger?.missionContract?.evidenceContract);
});

test("Shadow never changes the prompt, the route, or the research assists", async () => {
  const runtime = fakeRuntime("shadow");
  const { controller, traces } = controllerFor(runtime);
  assert.equal(await controller.assessForRouting({ prompt: PROMPT, hasActiveNote: true }), null);
  const evidence = controller.applyEvidenceContract({
    prompt: PROMPT,
    lexical: { web: false, vault: false },
    mutationFootprint: () => STILL,
  });
  assert.equal(evidence.prompt, PROMPT);
  assert.equal(evidence.contract, null);
  assert.equal(
    controller.routedIntent({ prompt: PROMPT, regexIntent: {} as never, wordTarget: null }),
    null,
  );
  const fallbackMode = async () => ({ mode: "none" as const });
  const assists = controller.researchAssists({ modeAssist: fallbackMode as never });
  assert.equal(assists.modeAssist, fallbackMode, "Shadow hands back the existing assist");
  assert.equal(assists.answersWithoutUtilityModel, false);

  controller.recordBaseline(PROMPT, {
    routerMode: "authority",
    route: "note_output",
    lexicalWeb: false,
    lexicalVault: false,
    researchMode: "none",
    effortTier: null,
    risk: null,
    freshness: null,
  });
  await controller.settle(1_000);
  const ledger = controller.ledger();
  assert.equal(ledger?.shadowComparisons?.length, 1);
  const comparison = ledger?.shadowComparisons?.[0] as {
    agreement: Record<string, boolean | null>;
    evidenceContractWouldApply: string | null;
  };
  assert.equal(comparison.agreement.web, false, "Jev heard a web request the words did not name");
  assert.equal(comparison.evidenceContractWouldApply, "applied");
  assert.ok(traces.some((trace) => /Jev shadow comparison: \d+ agreed, \d+ differed/u.test(trace.message)));
});

test("a continuation reuses the persisted contract, keeps the earlier records, and never asks", async () => {
  const first = fakeRuntime("enabled");
  const earlier = controllerFor(first).controller;
  await earlier.assessForRouting({ prompt: PROMPT, hasActiveNote: true });
  const applied = earlier.applyEvidenceContract({
    prompt: PROMPT,
    lexical: { web: false, vault: false },
    mutationFootprint: () => STILL,
  });
  const persisted = JSON.parse(JSON.stringify(earlier.ledger()));

  const second = fakeRuntime("enabled");
  const { controller, traces } = controllerFor(second);
  controller.restore(persisted, applied.prompt);
  assert.equal(
    await controller.assessForRouting({ prompt: applied.prompt, hasActiveNote: true }),
    null,
    "continuations never ask again",
  );
  const assists = controller.researchAssists({});
  const mode = await assists.modeAssist?.({ prompt: applied.prompt } as never);
  assert.equal(mode?.mode, "deep_web", "the persisted assessment still answers research mode");
  assert.equal(second.asked.length, 0);
  assert.ok(traces.some((trace) => trace.message.includes("no new decision call")));

  const ledger = controller.ledger();
  assert.equal(ledger?.records.length, 1, "the earlier segment's record survives");
  assert.deepEqual(ledger?.missionContract?.evidenceContract, persisted.missionContract.evidenceContract);
});

test("a persisted contract from another template version is not reused", async () => {
  const runtime = fakeRuntime("enabled");
  const { controller } = controllerFor(runtime);
  controller.restore(
    {
      version: 1,
      records: [],
      missionContract: {
        version: 1,
        promptFingerprint: promptFingerprintV1(PROMPT),
        inputFingerprint: "sha256:old",
        templateVersion: "mission-assessment.older",
        thresholdsVersion: "mission-thresholds.provisional.v1",
        mode: "enabled",
        assessment: { version: 1 },
        evidenceContract: null,
      },
    },
    PROMPT,
  );
  const assists = controller.researchAssists({ modeAssist: async () => ({ mode: "none" }) });
  const mode = await assists.modeAssist?.({ prompt: PROMPT } as never);
  assert.equal(mode?.mode, "none", "the existing classifier decides");
  assert.equal(runtime.asked.length, 0);
});

test("a Lead that withholds the research-mode assist keeps withholding it", () => {
  const { controller } = controllerFor(fakeRuntime("enabled"));
  const assists = controller.researchAssists(
    { modeAssist: async () => ({ mode: "deep_web" as const }) },
    { allowModeAssist: false },
  );
  assert.equal(assists.modeAssist, undefined);
  assert.ok(assists.effortAssist);
});
