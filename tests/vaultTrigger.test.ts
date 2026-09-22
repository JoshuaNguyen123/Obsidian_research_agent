import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VAULT_TRIGGER_AGE_MS,
  readVaultTrigger,
  shouldDispatchVaultTrigger,
  vaultTriggerStatusFromStopReason,
} from "../src/agent/vaultTrigger";

const NOW = 1_800_000_000_000;

function input(overrides: Partial<Parameters<typeof shouldDispatchVaultTrigger>[0]> = {}) {
  return {
    path: "Projects/Plan.md",
    frontmatter: {
      agent_mission: "Summarize the meeting notes below into three bullets.",
      agent_mission_status: "pending",
    },
    enabled: true,
    exclusionRoots: ["Agent Memory"],
    running: false,
    modifiedAtMs: NOW - 10_000,
    nowMs: NOW,
    noteIsActive: true,
    windowFocused: true,
    ...overrides,
  };
}

test("a pending trigger on a recent, active note dispatches its prompt", () => {
  assert.deepEqual(shouldDispatchVaultTrigger(input()), {
    dispatch: true,
    prompt: "Summarize the meeting notes below into three bullets.",
  });
  // An absent status is treated as pending: the user just wrote the key.
  assert.equal(
    shouldDispatchVaultTrigger(
      input({ frontmatter: { agent_mission: "Summarize this note in one line." } }),
    ).dispatch,
    true,
  );
});

test("the status flip is the idempotency key: running, done, and unknown never re-trigger", () => {
  for (const status of ["running", "done", "blocked", "failed", "RUNNING ", "whatever"]) {
    const decision = shouldDispatchVaultTrigger(
      input({ frontmatter: { agent_mission: "Summarize this note in one line.", agent_mission_status: status } }),
    );
    assert.deepEqual(decision, { dispatch: false, reason: "status_not_pending" }, status);
  }
});

test("disabled, non-markdown, agent-owned, and running states refuse by name", () => {
  assert.deepEqual(shouldDispatchVaultTrigger(input({ enabled: false })), {
    dispatch: false,
    reason: "disabled",
  });
  assert.deepEqual(shouldDispatchVaultTrigger(input({ path: "data/plan.canvas" })), {
    dispatch: false,
    reason: "not_markdown",
  });
  assert.deepEqual(shouldDispatchVaultTrigger(input({ frontmatter: { title: "x" } })), {
    dispatch: false,
    reason: "no_trigger",
  });
  assert.deepEqual(
    shouldDispatchVaultTrigger(input({ frontmatter: { agent_mission: "go" } })),
    { dispatch: false, reason: "prompt_too_short" },
  );
  for (const path of ["Agent Runs/run-1.md", "Agent Memory/notes.md", ".agent-backups/x.md"]) {
    assert.deepEqual(
      shouldDispatchVaultTrigger(input({ path })),
      { dispatch: false, reason: "excluded_path" },
      path,
    );
  }
  assert.deepEqual(shouldDispatchVaultTrigger(input({ running: true })), {
    dispatch: false,
    reason: "mission_running",
  });
});

test("triggers are attended: stale or absent-user notes do not launch work", () => {
  assert.deepEqual(
    shouldDispatchVaultTrigger(input({ modifiedAtMs: NOW - MAX_VAULT_TRIGGER_AGE_MS - 1 })),
    { dispatch: false, reason: "stale" },
  );
  assert.deepEqual(shouldDispatchVaultTrigger(input({ modifiedAtMs: null })), {
    dispatch: false,
    reason: "stale",
  });
  assert.deepEqual(
    shouldDispatchVaultTrigger(input({ noteIsActive: false, windowFocused: false })),
    { dispatch: false, reason: "unattended" },
  );
  // Either presence signal is enough.
  assert.equal(
    shouldDispatchVaultTrigger(input({ noteIsActive: false, windowFocused: true })).dispatch,
    true,
  );
  assert.equal(
    shouldDispatchVaultTrigger(input({ noteIsActive: true, windowFocused: false })).dispatch,
    true,
  );
});

test("the prompt is normalized and bounded, and statuses map from the stop reason", () => {
  const trigger = readVaultTrigger({
    agent_mission: "  Summarize\n  this   note  ",
    agent_mission_status: " Pending ",
  });
  assert.deepEqual(trigger, {
    prompt: "Summarize this note",
    status: "pending",
    rawStatus: "pending",
  });
  assert.equal(readVaultTrigger({ agent_mission: 42 }), null);
  assert.equal(readVaultTrigger(null), null);
  assert.equal(vaultTriggerStatusFromStopReason("write_completed"), "done");
  assert.equal(vaultTriggerStatusFromStopReason("final"), "done");
  assert.equal(vaultTriggerStatusFromStopReason("budget"), "blocked");
  assert.equal(vaultTriggerStatusFromStopReason("clarifying_question"), "blocked");
  assert.equal(vaultTriggerStatusFromStopReason("error"), "failed");
  assert.equal(vaultTriggerStatusFromStopReason(null), "failed");
});
