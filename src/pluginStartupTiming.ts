import type { OnloadStartupTaskId } from "./onloadSchedule";

/**
 * Load-time instrument: onload entry to the core-ready event, split by the
 * immediate-phase tasks the load path awaits. Each phase name is an
 * `ONLOAD_STARTUP_TASKS` id, so the schedule map and the instrument cannot
 * name different work. The measurement itself lives in the real Obsidian
 * (`scripts/measure-startup-timing.mjs`); this module only keeps the clock.
 */
export const STARTUP_TIMING_PHASES = [
  "register_view",
  "load_settings",
  "create_semantic_index_service",
  "load_project_memory",
  "reconcile_orchestrator_projection",
  "register_settings_tab",
  "initialize_bundled_capabilities",
] as const satisfies readonly OnloadStartupTaskId[];

export type StartupTimingPhase = (typeof STARTUP_TIMING_PHASES)[number];

export interface PluginStartupTimingV1 {
  schemaVersion: 1;
  /** onload entry to the core-ready event, in milliseconds. */
  coreReadyMs: number;
  /**
   * Time between consecutive marks, keyed by the phase that ended at the
   * mark. `load_project_memory` covers the project-memory and mission-
   * projection reads, which run concurrently.
   */
  phases: Partial<Record<StartupTimingPhase, number>>;
  /** Notes directly under Agent Runs/ at load, when the vault could be listed. */
  runNoteCount: number | null;
  measuredAt: string;
}

const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createStartupTimer(now: () => number = defaultNow) {
  const startedAt = now();
  let lastMarkAt = startedAt;
  const phases: Partial<Record<StartupTimingPhase, number>> = {};
  return {
    mark(phase: StartupTimingPhase): void {
      const at = now();
      phases[phase] = round(Math.max(0, at - lastMarkAt) + (phases[phase] ?? 0));
      lastMarkAt = at;
    },
    finish(
      extra: { runNoteCount?: number | null; measuredAt?: string } = {},
    ): PluginStartupTimingV1 {
      return {
        schemaVersion: 1,
        coreReadyMs: round(Math.max(0, now() - startedAt)),
        phases: { ...phases },
        runNoteCount:
          typeof extra.runNoteCount === "number" &&
          Number.isFinite(extra.runNoteCount)
            ? Math.max(0, Math.floor(extra.runNoteCount))
            : null,
        measuredAt: extra.measuredAt ?? new Date().toISOString(),
      };
    },
  };
}

export function formatStartupTimingLine(timing: PluginStartupTimingV1): string {
  const parts = STARTUP_TIMING_PHASES.filter(
    (phase) => typeof timing.phases[phase] === "number",
  ).map((phase) => `${phase} ${timing.phases[phase]}`);
  const notes =
    timing.runNoteCount === null ? "" : `; ${timing.runNoteCount} run notes`;
  return `Agentic Researcher core ready in ${timing.coreReadyMs} ms (${parts.join(", ")}${notes})`;
}
