import assert from "node:assert/strict";
import test from "node:test";
import {
  SAFETY_CEILING_PRESETS,
  applySafetyCeilingPreset,
} from "../src/agent/safetyCeiling";
import type { AgentSettings } from "../src/settings";

test("applying a preset writes through to the individual limits", () => {
  const settings = { ...SAFETY_CEILING_PRESETS.balanced } as AgentSettings;
  applySafetyCeilingPreset(settings, "extended");
  assert.equal(settings.maxLongRunSegments, 8);
  assert.equal(settings.maxCompletionSegments, 48);
  assert.equal(settings.overnightMaxSegments, 48);
  assert.equal(settings.orchestratorWorkerMaxSteps, 60);
  assert.equal(settings.orchestratorWorkerMaxMinutes, 25);

  // Presets are a strict superset switch: going back restores every value.
  applySafetyCeilingPreset(settings, "balanced");
  for (const [key, value] of Object.entries(SAFETY_CEILING_PRESETS.balanced)) {
    assert.deepEqual(settings[key as keyof AgentSettings], value);
  }
});

test("extended never exceeds the hard agent-step ceiling", () => {
  // The preset raises segment/worker allowances, not the absolute step cap.
  assert.equal(
    SAFETY_CEILING_PRESETS.extended.maxAgentSteps,
    SAFETY_CEILING_PRESETS.balanced.maxAgentSteps,
  );
});
