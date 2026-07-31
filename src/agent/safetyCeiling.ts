import { MAX_AGENT_STEPS } from "../tools/constants";
import type { AgentSettings } from "../settings";

/**
 * Run limits, expressed as one choice instead of nine.
 *
 * Research depth is driven by evidence saturation rather than step counts, so
 * these numbers are safety backstops — the thing that stops a stuck run, not
 * the thing that decides how much work happens. Exposing nine numeric knobs for
 * a value most people never tune made the settings tab look like a control
 * panel; a preset keeps the capability while hiding the arithmetic.
 *
 * Deliberately kept free of any Obsidian import so it stays unit-testable.
 */
export type SafetyCeilingPreset = "balanced" | "extended" | "custom";

export interface SafetyCeilingLimits {
  maxAgentSteps: number;
  maxRunMinutes: number | null;
  maxLongRunSegments: number;
  maxCompletionSegments: number;
  overnightRunHours: number;
  overnightMaxSegments: number;
  orchestratorWorkerMaxSteps: number;
  orchestratorWorkerMaxToolCalls: number;
  orchestratorWorkerMaxMinutes: number;
}

/**
 * Choosing a preset writes these through to the individual settings, so every
 * consumer keeps reading the field it always did — the preset is a UI
 * affordance, never a second source of truth.
 */
export const SAFETY_CEILING_PRESETS: Readonly<
  Record<Exclude<SafetyCeilingPreset, "custom">, Readonly<SafetyCeilingLimits>>
> = Object.freeze({
  balanced: Object.freeze({
    maxAgentSteps: MAX_AGENT_STEPS,
    maxRunMinutes: null,
    maxLongRunSegments: 4,
    maxCompletionSegments: 24,
    overnightRunHours: 10,
    overnightMaxSegments: 24,
    orchestratorWorkerMaxSteps: 40,
    orchestratorWorkerMaxToolCalls: 40,
    orchestratorWorkerMaxMinutes: 15,
  }),
  // Longer autonomous work: more segments and a larger worker allowance. The
  // absolute per-run step ceiling is intentionally unchanged — extended means
  // "keep going across segments", not "raise the hard cap".
  extended: Object.freeze({
    maxAgentSteps: MAX_AGENT_STEPS,
    maxRunMinutes: null,
    maxLongRunSegments: 8,
    maxCompletionSegments: 48,
    overnightRunHours: 12,
    overnightMaxSegments: 48,
    orchestratorWorkerMaxSteps: 60,
    orchestratorWorkerMaxToolCalls: 60,
    orchestratorWorkerMaxMinutes: 25,
  }),
});

/** Apply a preset's limits onto a settings object in place. */
export function applySafetyCeilingPreset(
  settings: AgentSettings,
  preset: Exclude<SafetyCeilingPreset, "custom">,
): void {
  Object.assign(settings, SAFETY_CEILING_PRESETS[preset]);
}
