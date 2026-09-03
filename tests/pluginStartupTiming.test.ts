import assert from "node:assert/strict";
import test from "node:test";
import { ONLOAD_STARTUP_TASKS } from "../src/onloadSchedule";
import {
  createStartupTimer,
  formatStartupTimingLine,
  STARTUP_TIMING_PHASES,
} from "../src/pluginStartupTiming";

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
