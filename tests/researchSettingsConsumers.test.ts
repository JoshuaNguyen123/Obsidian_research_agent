import assert from "node:assert/strict";
import test from "node:test";
import { createResearchPlan } from "../src/agent/researchPlan";
import { researchPlanSettingOverrides } from "../src/AgentRunner";
import type { MissionIntent } from "../src/tools/types";
import type { RunPlan } from "../src/agent/runPlan";

const MISSION_INTENT = {
  explicitMutation: false,
  requireWriteCompletion: false,
  explicitDelete: false,
} as unknown as MissionIntent;

const RUN_PLAN = {
  route: "deep_research",
  slowPathReason: "needs_web_sources",
} as unknown as Pick<RunPlan, "route" | "slowPathReason">;

const DEEP_PROMPT = "Deep research the effect of onboarding validation on retention.";

function planFor(overrides: Parameters<typeof createResearchPlan>[0] extends never ? never : Record<string, unknown>) {
  return createResearchPlan({
    prompt: DEEP_PROMPT,
    missionIntent: MISSION_INTENT,
    runPlan: RUN_PLAN,
    ...overrides,
  } as Parameters<typeof createResearchPlan>[0]);
}

test("the configured source floor applies when the prompt names no count", () => {
  assert.equal(planFor({})?.sourceRequirements.minFetchedSources, 3);
  assert.equal(
    planFor({ defaultMinFetchedSources: 6 })?.sourceRequirements.minFetchedSources,
    6,
  );
});

test("an explicit count in the prompt always beats the configured floor", () => {
  // A user who says "two sources" means two, whatever the setting says.
  const plan = createResearchPlan({
    prompt: "Deep research quantum batteries using two sources.",
    missionIntent: MISSION_INTENT,
    runPlan: RUN_PLAN,
    defaultMinFetchedSources: 8,
  });
  assert.equal(plan?.sourceRequirements.minFetchedSources, 2);
});

test("the model's source judgment also outranks the configured floor", () => {
  const plan = planFor({ sourceFloorOverride: 5, defaultMinFetchedSources: 8 });
  assert.equal(plan?.sourceRequirements.minFetchedSources, 5);
});

test("the configured floor is clamped to the supported range", () => {
  assert.equal(planFor({ defaultMinFetchedSources: 0 })?.sourceRequirements.minFetchedSources, 1);
  assert.equal(planFor({ defaultMinFetchedSources: 99 })?.sourceRequirements.minFetchedSources, 8);
  assert.equal(
    planFor({ defaultMinFetchedSources: Number.NaN })?.sourceRequirements.minFetchedSources,
    3,
  );
});

test("the effort ceiling caps the selected tier without ever raising it", () => {
  const uncapped = planFor({});
  const capped = planFor({ researchEffortCeiling: "quick" });
  assert.ok(uncapped?.effort);
  assert.equal(capped?.effort?.tier, "quick");

  // A ceiling above the tier the prompt warranted changes nothing.
  const raised = planFor({ researchEffortCeiling: "extended" });
  assert.equal(raised?.effort?.tier, uncapped?.effort?.tier);
});

test("a capped plan carries a smaller budget than an uncapped one", () => {
  const uncapped = planFor({});
  const capped = planFor({ researchEffortCeiling: "quick" });
  assert.ok(
    (capped?.effort?.budget.maxToolCallsPerSegment ?? 0) <=
      (uncapped?.effort?.budget.maxToolCallsPerSegment ?? 0),
  );
});

test("setting overrides omit unset values so plan defaults are untouched", () => {
  // An unset setting must be indistinguishable from the behaviour before these
  // settings existed, which means omitting the key rather than passing a value.
  assert.deepEqual(researchPlanSettingOverrides(undefined), {});
  assert.deepEqual(researchPlanSettingOverrides({}), {});
  assert.deepEqual(
    researchPlanSettingOverrides({ researchEffortCeiling: "deep" }),
    { researchEffortCeiling: "deep" },
  );
  assert.deepEqual(
    researchPlanSettingOverrides({ defaultMinFetchedSources: 5 }),
    { defaultMinFetchedSources: 5 },
  );
});

test("the top tier is not passed as a ceiling because it constrains nothing", () => {
  // Passing "extended" would mark every plan constrained for no reason.
  assert.deepEqual(researchPlanSettingOverrides({ researchEffortCeiling: "extended" }), {});
});

test("an unrecognized persisted ceiling is ignored rather than trusted", () => {
  assert.deepEqual(
    researchPlanSettingOverrides({
      researchEffortCeiling: "turbo" as never,
    }),
    {},
  );
});
