import {
  onloadTasksForPhase,
  type OnloadStartupTaskId,
} from "./onloadSchedule";

/**
 * Load-time instrument: onload entry to the core-ready event, split by the
 * immediate-phase tasks the load path awaits, plus the layout-ready tasks
 * that run afterwards (disk scans, template library, workspace cleanup).
 * Each phase name is an `ONLOAD_STARTUP_TASKS` id, so the schedule map and
 * the instrument cannot name different work. The measurement itself lives in
 * the real Obsidian (`scripts/measure-startup-timing.mjs`); this module only
 * keeps the clock.
 *
 * Observed 2026-09-03: on a cold start Obsidian's vault index is still empty
 * when plugins load, so `runNoteCount` reads 0 at core-ready and the
 * immediate-phase run-note scan is vacuous; the cost of a large Agent Runs
 * backlog shows up in the layout-ready tasks, which is why they are timed too.
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
  /** Notes directly under Agent Runs/ at core-ready, when the vault could be listed. */
  runNoteCount: number | null;
  measuredAt: string;
  /** onload entry to Obsidian's layout-ready callback; null until it fires. */
  layoutReadyAfterMs: number | null;
  /**
   * Wall time of each layout-ready task from its start to settlement
   * (fire-and-forget tasks included). `resume_latest_durable_mission` covers
   * any mission it actually starts, not only the scan.
   */
  deferred: Partial<Record<OnloadStartupTaskId, number>>;
  /** True once every layout-ready task has recorded a duration. */
  deferredSettled: boolean;
}

export function startupTimingNow(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function cloneTiming(timing: PluginStartupTimingV1): PluginStartupTimingV1 {
  return {
    ...timing,
    phases: { ...timing.phases },
    deferred: { ...timing.deferred },
  };
}

export function createStartupTimer(now: () => number = startupTimingNow) {
  const startedAt = now();
  let lastMarkAt = startedAt;
  const phases: Partial<Record<StartupTimingPhase, number>> = {};
  let timing: PluginStartupTimingV1 | null = null;
  const deferredTaskIds = onloadTasksForPhase("layout_ready");
  return {
    mark(phase: StartupTimingPhase): void {
      const at = now();
      phases[phase] = round(Math.max(0, at - lastMarkAt) + (phases[phase] ?? 0));
      lastMarkAt = at;
    },
    finish(
      extra: { runNoteCount?: number | null; measuredAt?: string } = {},
    ): PluginStartupTimingV1 {
      timing = {
        schemaVersion: 1,
        coreReadyMs: round(Math.max(0, now() - startedAt)),
        phases: { ...phases },
        runNoteCount:
          typeof extra.runNoteCount === "number" &&
          Number.isFinite(extra.runNoteCount)
            ? Math.max(0, Math.floor(extra.runNoteCount))
            : null,
        measuredAt: extra.measuredAt ?? new Date().toISOString(),
        layoutReadyAfterMs: null,
        deferred: {},
        deferredSettled: deferredTaskIds.length === 0,
      };
      return cloneTiming(timing);
    },
    markLayoutReady(): void {
      if (timing && timing.layoutReadyAfterMs === null) {
        timing.layoutReadyAfterMs = round(Math.max(0, now() - startedAt));
      }
    },
    recordDeferred(task: OnloadStartupTaskId, elapsedMs: number): void {
      if (!timing) return;
      timing.deferred[task] = round(
        Math.max(0, elapsedMs) + (timing.deferred[task] ?? 0),
      );
      timing.deferredSettled = deferredTaskIds.every(
        (id) => typeof timing?.deferred[id] === "number",
      );
    },
    /** A copy of the record, or null before core-ready. */
    snapshot(): PluginStartupTimingV1 | null {
      return timing ? cloneTiming(timing) : null;
    },
  };
}

export type StartupTimer = ReturnType<typeof createStartupTimer>;

export function formatStartupTimingLine(timing: PluginStartupTimingV1): string {
  const parts = STARTUP_TIMING_PHASES.filter(
    (phase) => typeof timing.phases[phase] === "number",
  ).map((phase) => `${phase} ${timing.phases[phase]}`);
  const notes =
    timing.runNoteCount === null ? "" : `; ${timing.runNoteCount} run notes`;
  return `Agentic Researcher core ready in ${timing.coreReadyMs} ms (${parts.join(", ")}${notes})`;
}

export function formatDeferredStartupTimingLine(
  timing: PluginStartupTimingV1,
): string {
  const parts = onloadTasksForPhase("layout_ready")
    .filter((task) => typeof timing.deferred[task] === "number")
    .map((task) => `${task} ${timing.deferred[task]}`);
  const layoutReady =
    timing.layoutReadyAfterMs === null
      ? "layout ready: not yet"
      : `layout ready ${timing.layoutReadyAfterMs} ms after onload`;
  return `Agentic Researcher layout-ready work (${layoutReady}): ${parts.join(", ") || "none recorded"}`;
}
