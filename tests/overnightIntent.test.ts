import assert from "node:assert/strict";
import test from "node:test";
import { classifyOvernightMissionIntent } from "../src/agent/overnightIntent";

test("overnight intent requires explicit durable work language", () => {
  assert.deepEqual(classifyOvernightMissionIntent("Research this topic overnight.", 10), {
    requested: true,
    durationHours: 10,
    reason: "overnight_keyword",
  });
  assert.equal(
    classifyOvernightMissionIntent("This social change did not happen overnight.").requested,
    false,
  );
  assert.equal(
    classifyOvernightMissionIntent("Do not run this overnight.").requested,
    false,
  );
  for (const prompt of [
    "Do not research overnight.",
    "Never work overnight; just explain the tradeoffs.",
    "The agent did not work overnight; diagnose why.",
    "Research why the prior agent worked overnight.",
    "Research health effects of working overnight.",
    "Research overnight oats and summarize the recipes.",
  ]) {
    assert.equal(
      classifyOvernightMissionIntent(prompt).requested,
      false,
      prompt,
    );
  }
  assert.equal(
    classifyOvernightMissionIntent("Research MCP servers overnight.").requested,
    true,
  );
});

test("overnight intent parses explicit 8-12 hour requests and clamps the cap", () => {
  assert.deepEqual(
    classifyOvernightMissionIntent("Run this co-researcher for 11 hours."),
    {
      requested: true,
      durationHours: 11,
      reason: "explicit_duration",
    },
  );
  assert.equal(
    classifyOvernightMissionIntent("Research this for 18 hours.").durationHours,
    12,
  );
  assert.equal(
    classifyOvernightMissionIntent("Run this agent for 8-12 hours.", 10).durationHours,
    10,
  );
  assert.equal(
    classifyOvernightMissionIntent("Research this for 2 hours.").requested,
    false,
  );
  for (const prompt of [
    "Study how 8 hours of sleep affects memory.",
    "Research health effects of working for 12 hours a day.",
    "Do not research this for 8 hours; answer now.",
    "Never run this for 12 hours.",
    "Analyze whether an agent can run for 8 hours.",
  ]) {
    assert.equal(
      classifyOvernightMissionIntent(prompt).requested,
      false,
      prompt,
    );
  }
  assert.deepEqual(
    classifyOvernightMissionIntent("Can you research MCP servers for 9 hours?"),
    {
      requested: true,
      durationHours: 9,
      reason: "explicit_duration",
    },
  );
  assert.deepEqual(
    classifyOvernightMissionIntent("Research AI for 8 hours."),
    {
      requested: true,
      durationHours: 8,
      reason: "explicit_duration",
    },
  );
  assert.equal(
    classifyOvernightMissionIntent("Run this agent for 8–12 hours.", 10)
      .durationHours,
    10,
  );
});
