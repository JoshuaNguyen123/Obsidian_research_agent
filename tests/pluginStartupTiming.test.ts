import assert from "node:assert/strict";
import test from "node:test";
import { ONLOAD_STARTUP_TASKS } from "../src/onloadSchedule";
import {
  createStartupTimer,
  formatDeferredStartupTimingLine,
  formatStartupTimingLine,
  STARTUP_TIMING_PHASES,
} from "../src/pluginStartupTiming";
import { onloadTasksForPhase } from "../src/onloadSchedule";

test("startup timer attributes elapsed time to the phase that ended at each mark", () => {
  let clock = 100;
  const timer = createStartupTimer(() => clock);
  clock += 12.34;
  timer.mark("register_view");
  clock += 7;
  timer.mark("load_settings");
  clock += 0.5;
  timer.mark("load_project_memory");
  clock += 30;
  const timing = timer.finish({ runNoteCount: 200.7, measuredAt: "2026-09-03T10:00:00.000Z" });

  assert.equal(timing.schemaVersion, 1);
  assert.deepEqual(timing.phases, {
    register_view: 12.3,
    load_settings: 7,
    load_project_memory: 0.5,
  });
  assert.equal(timing.coreReadyMs, 49.8);
  assert.equal(timing.runNoteCount, 200);
  assert.equal(timing.measuredAt, "2026-09-03T10:00:00.000Z");
  assert.equal(
    formatStartupTimingLine(timing),
    "Agentic Researcher core ready in 49.8 ms (register_view 12.3, load_settings 7, load_project_memory 0.5; 200 run notes)",
  );
});

test("an unlisted vault reads as unknown, and a backwards clock never goes negative", () => {
  let clock = 50;
  const timer = createStartupTimer(() => clock);
  clock -= 5;
  timer.mark("register_view");
  const timing = timer.finish();
  assert.equal(timing.phases.register_view, 0);
  assert.equal(timing.coreReadyMs, 0);
  assert.equal(timing.runNoteCount, null);
  assert.match(formatStartupTimingLine(timing), /core ready in 0 ms \(register_view 0\)$/);
});

test("every timed phase is an immediate-phase startup task", () => {
  // The schedule map is the single list of load-path work; a phase that is
  // not an immediate task would measure work the map says never blocks load.
  for (const phase of STARTUP_TIMING_PHASES) {
    assert.equal(ONLOAD_STARTUP_TASKS[phase], "immediate", phase);
  }
});

test("layout-ready tasks record into the same timing record and settle once all are in", () => {
  let clock = 0;
  const timer = createStartupTimer(() => clock);
  assert.equal(timer.snapshot(), null, "nothing to report before core-ready");
  clock = 100;
  timer.mark("register_view");
  const finished = timer.finish({ measuredAt: "2026-09-03T10:00:00.000Z" });
  assert.equal(finished.layoutReadyAfterMs, null);
  assert.deepEqual(finished.deferred, {});
  assert.equal(finished.deferredSettled, false);

  clock = 640;
  timer.markLayoutReady();
  clock = 700;
  timer.markLayoutReady();
  const tasks = onloadTasksForPhase("layout_ready");
  tasks.forEach((task, index) => timer.recordDeferred(task, 10 * (index + 1)));
  const snapshot = timer.snapshot();
  assert.ok(snapshot);
  assert.equal(snapshot.layoutReadyAfterMs, 640, "the first layout-ready mark wins");
  assert.equal(snapshot.deferredSettled, true);
  assert.equal(snapshot.deferred[tasks[0]], 10);
  assert.equal(snapshot.deferred[tasks[tasks.length - 1]], 10 * tasks.length);
  // The finish() return value was a copy: later deferred records do not leak
  // into it, and the snapshot is a copy too.
  assert.deepEqual(finished.deferred, {});
  snapshot.deferred[tasks[0]] = 999;
  assert.equal(timer.snapshot()?.deferred[tasks[0]], 10);
  assert.match(
    formatDeferredStartupTimingLine(timer.snapshot() ?? finished),
    /^Agentic Researcher layout-ready work \(layout ready 640 ms after onload\): initialize_template_library 10, /,
  );
  assert.match(
    formatDeferredStartupTimingLine(finished),
    /layout ready: not yet\): none recorded$/,
  );
});
