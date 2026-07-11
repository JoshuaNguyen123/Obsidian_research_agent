import test from "node:test";
import assert from "node:assert/strict";
import {
  getDueMissions,
  normalizeScheduledMissions,
  type ScheduledMission,
} from "../src/agent/missionScheduler";

test("mission scheduler selects due hourly daily and weekly missions", () => {
  const now = new Date("2026-07-08T15:00:00.000Z");
  const schedules: ScheduledMission[] = [
    {
      id: "hourly",
      prompt: "hourly",
      cadence: "hourly",
      enabled: true,
      lastRunAt: "2026-07-08T13:30:00.000Z",
      lastRunId: null,
    },
    {
      id: "daily",
      prompt: "daily",
      cadence: "daily",
      hourLocal: now.getHours(),
      enabled: true,
      lastRunAt: "2026-07-07T12:00:00.000Z",
      lastRunId: null,
    },
    {
      id: "disabled",
      prompt: "disabled",
      cadence: "hourly",
      enabled: false,
      lastRunAt: null,
      lastRunId: null,
    },
  ];

  assert.deepEqual(
    getDueMissions(schedules, now).map((mission) => mission.id),
    ["hourly", "daily"],
  );
});

test("scheduled mission normalization drops invalid entries", () => {
  const normalized = normalizeScheduledMissions([
    {
      id: "ok",
      prompt: "Run",
      cadence: "weekly",
      enabled: true,
      lastOutcome: "write_completed",
    },
    { id: "bad", prompt: "", cadence: "daily" },
    { prompt: "No cadence" },
  ]);

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, "ok");
  assert.equal(normalized[0].cadence, "weekly");
  assert.equal(normalized[0].lastOutcome, "write_completed");
});

test("continuous research schedules require pinned targets and preserve retry state", () => {
  const normalized = normalizeScheduledMissions([
    {
      id: "continuous-ready",
      prompt: "Check source deltas",
      cadence: "hourly",
      enabled: true,
      mode: "continuous_research",
      pinnedTargetIds: ["market-watch"],
      consecutiveFailures: 0,
      lastSourceHashes: { source: "hash-1" },
    },
    {
      id: "continuous-unpinned",
      prompt: "Check source deltas",
      cadence: "hourly",
      enabled: true,
      mode: "continuous_research",
      pinnedTargetIds: [],
    },
  ]);
  const due = getDueMissions(
    normalized,
    new Date("2026-07-08T15:00:00.000Z"),
  );
  assert.deepEqual(due.map((mission) => mission.id), ["continuous-ready"]);
  assert.deepEqual(normalized[0].lastSourceHashes, { source: "hash-1" });
});
