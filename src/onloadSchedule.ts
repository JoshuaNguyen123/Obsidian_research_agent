/**
 * Pure onload schedule for Agentic Researcher.
 *
 * View registration, settings, and command surfaces stay immediate so a
 * persisted pane can render. The table is the scheduling decision; main.ts
 * only executes it.
 *
 * Honest about the immediate phase: `load_settings` reads plugin data and up
 * to two legacy data.json files, `load_project_memory` reads four memory
 * JSON files, `hydrate_mission_projection` scans `Agent Runs/` for the
 * latest resumable run, and `initialize_bundled_capabilities` kicks off the
 * fire-and-forget sandbox boundary probe (a child process on hosts with a
 * provisioned provider). Only the template library, workspace cleanup, the
 * Agent Runs, `.agent-backups/` and expired-source-cache sweeps, the
 * semantic-index flush, durable resume, and companion reconciliation wait for
 * workspace layout-ready.
 */
export type OnloadSchedulePhase = "immediate" | "layout_ready";

export const ONLOAD_STARTUP_TASKS = {
  register_view: "immediate",
  register_companion_reconcile_event: "immediate",
  load_settings: "immediate",
  create_semantic_index_service: "immediate",
  update_last_active_markdown_file: "immediate",
  load_project_memory: "immediate",
  hydrate_mission_projection: "immediate",
  reconcile_orchestrator_projection: "immediate",
  register_workspace_vault_events: "immediate",
  register_ribbon_and_commands: "immediate",
  register_settings_tab: "immediate",
  mark_core_ready: "immediate",
  initialize_bundled_capabilities: "immediate",
  refresh_agent_view: "immediate",
  start_mission_scheduler: "immediate",
  restart_linear_queue_runtime: "immediate",
  initialize_template_library: "layout_ready",
  cleanup_old_workspaces: "layout_ready",
  sweep_agent_runs_retention: "layout_ready",
  sweep_agent_backups_retention: "layout_ready",
  sweep_expired_source_cache: "layout_ready",
  schedule_semantic_index_flush: "layout_ready",
  resume_latest_durable_mission: "layout_ready",
  schedule_companion_mission_reconciliation: "layout_ready",
} as const satisfies Record<string, OnloadSchedulePhase>;

export type OnloadStartupTaskId = keyof typeof ONLOAD_STARTUP_TASKS;

export function onloadSchedulePhaseFor(
  task: OnloadStartupTaskId,
): OnloadSchedulePhase {
  return ONLOAD_STARTUP_TASKS[task];
}

export function onloadTasksForPhase(
  phase: OnloadSchedulePhase,
): readonly OnloadStartupTaskId[] {
  return (Object.keys(ONLOAD_STARTUP_TASKS) as OnloadStartupTaskId[]).filter(
    (task) => ONLOAD_STARTUP_TASKS[task] === phase,
  );
}

export function countOnloadTasks(phase: OnloadSchedulePhase): number {
  return onloadTasksForPhase(phase).length;
}
