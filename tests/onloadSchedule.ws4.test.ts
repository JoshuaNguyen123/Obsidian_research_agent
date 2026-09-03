import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  countOnloadTasks,
  ONLOAD_STARTUP_TASKS,
  onloadSchedulePhaseFor,
  onloadTasksForPhase,
} from "../src/onloadSchedule";

const DEFERRED_TASKS = [
  "initialize_template_library",
  "cleanup_old_workspaces",
  "sweep_agent_runs_retention",
  "schedule_semantic_index_flush",
  "resume_latest_durable_mission",
  "schedule_companion_mission_reconciliation",
] as const;

test("onload schedule defers six disk and companion tasks", () => {
  assert.equal(countOnloadTasks("layout_ready"), 6);
  assert.deepEqual(onloadTasksForPhase("layout_ready"), [...DEFERRED_TASKS]);
  for (const task of DEFERRED_TASKS) {
    assert.equal(onloadSchedulePhaseFor(task), "layout_ready");
  }
  assert.equal(ONLOAD_STARTUP_TASKS.register_view, "immediate");
  assert.equal(ONLOAD_STARTUP_TASKS.load_settings, "immediate");
  assert.equal(ONLOAD_STARTUP_TASKS.initialize_bundled_capabilities, "immediate");
  assert.ok(countOnloadTasks("immediate") > countOnloadTasks("layout_ready"));
});

test("main.ts executes deferred onload work only after layout ready", () => {
  const source = readFileSync(
    path.join(process.cwd(), "main.ts"),
    "utf8",
  );
  const onloadStart = source.indexOf("async onload()");
  const layoutReady = source.indexOf("this.app.workspace.onLayoutReady", onloadStart);
  const deferredRunner = source.indexOf("runDeferredOnloadWork", layoutReady);
  assert.ok(onloadStart > 0, "onload method missing");
  assert.ok(layoutReady > onloadStart, "onLayoutReady missing from onload");
  assert.ok(deferredRunner > layoutReady, "deferred runner is not scheduled on layout ready");

  const onloadBody = source.slice(onloadStart, layoutReady);
  assert.doesNotMatch(onloadBody, /cleanupOldWorkspaces\(/u);
  assert.doesNotMatch(onloadBody, /sweepAgentRunsRetentionBestEffort\(/u);
  assert.doesNotMatch(onloadBody, /ensureAgentTemplateLibrary\(/u);
  assert.doesNotMatch(onloadBody, /scheduleSemanticIndexFlush\(/u);
  assert.match(
    source.slice(layoutReady, layoutReady + 400),
    /runDeferredOnloadWork/u,
  );
  const deferredFn = source.slice(source.indexOf("executeDeferredOnloadTask"));
  assert.match(deferredFn, /cleanupOldWorkspaces\(7\)/u);
  assert.match(deferredFn, /sweepAgentRunsRetentionBestEffort\(/u);
  assert.match(deferredFn, /ensureAgentTemplateLibrary\(/u);
  assert.match(deferredFn, /scheduleSemanticIndexFlush\(5_000\)/u);
  assert.match(deferredFn, /scheduleCompanionMissionReconciliation\(3_000\)/u);
});
