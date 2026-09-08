import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySafeFailureRetry,
  createSafeFailureRetryState,
  decideSafeFailureRetry,
  shouldAutoRetrySafeFailure,
} from "../src/agent/safeFailureRetry";
import { decideRecoveryAction } from "../src/agent/recoveryEngine";
import { createMissionPlan, type MissionPlan } from "../src/agent/missionPlan";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import type { MissionIntent } from "../src/tools/types";

test("a code that names arguments as the fault is an argument failure in any spelling", () => {
  // The blob regex only ever knew `invalid_argument(s)`, so validators that
  // wrote the reverse word order fell through to `other` and escalated: no
  // auto-retry, no argument-specific handling, on a failure that applied
  // nothing. Every code below is a real one in this repo.
  for (const code of [
    "linear_queue_vault_arguments_invalid",
    "github_publication_arguments_invalid",
    "git_argument_invalid",
    "github_repository_invalid_argument",
  ]) {
    const classification = classifySafeFailureRetry({
      source: "create_thing",
      code,
      message: "The supplied value is invalid.",
    });
    assert.equal(classification.safeToAutoRetry, true, code);
    assert.ok(
      classification.kind === "schema" ||
        classification.kind === "invalid_tool_args",
      `${code} -> ${classification.kind}`,
    );
  }

  // A refusal that merely ends in `_invalid` still gets no silent retry.
  for (const code of ["authority_grant_invalid", "diff_readback_invalid"]) {
    const classification = classifySafeFailureRetry({
      source: "create_thing",
      code,
      message: "The host refused the call.",
    });
    assert.equal(classification.kind, "other", code);
    assert.equal(classification.safeToAutoRetry, false, code);
  }
});

test("schema and invalid tool args are safe to auto-retry", () => {
  const schema = classifySafeFailureRetry({
    source: "model",
    code: "invalid_arguments",
    message: "schema correction required for path",
  });
  assert.equal(schema.safeToAutoRetry, true);
  assert.ok(schema.kind === "schema" || schema.kind === "invalid_tool_args");

  const model = classifySafeFailureRetry({
    source: "model",
    category: "network",
    message: "Request timed out after 30000ms.",
  });
  assert.equal(model.safeToAutoRetry, true);
  assert.equal(model.kind, "model_transient");
});

test("credentials approvals and partial writes are never auto-retried", () => {
  for (const failure of [
    { message: "missing_api_key", category: "missing_api_key" },
    { message: "approval denied for replace_current_file", code: "approval" },
    { message: "partial_write_no_safe_retry after note apply" },
    { source: "web_fetch", message: "timeout" },
  ]) {
    const classified = classifySafeFailureRetry(failure);
    assert.equal(
      classified.safeToAutoRetry,
      false,
      `expected unsafe: ${JSON.stringify(failure)}`,
    );
  }
});

test("decideSafeFailureRetry auto-retries then blocks at the bound", () => {
  const first = decideSafeFailureRetry({
    failure: {
      source: "model",
      code: "invalid_arguments",
      message: "Expected string path",
    },
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
  assert.equal(first.action, "auto_retry");
  assert.equal(shouldAutoRetrySafeFailure(first), true);
  assert.match(first.progressLine, /retrying automatically/i);

  const second = decideSafeFailureRetry({
    failure: {
      source: "model",
      code: "invalid_arguments",
      message: "Expected string path",
    },
    state: first.state,
    now: new Date("2026-07-22T12:01:00.000Z"),
  });
  assert.equal(second.action, "auto_retry");

  const third = decideSafeFailureRetry({
    failure: {
      source: "model",
      code: "invalid_arguments",
      message: "Expected string path",
    },
    state: second.state,
    now: new Date("2026-07-22T12:02:00.000Z"),
  });
  assert.equal(third.action, "block");
  assert.equal(shouldAutoRetrySafeFailure(third), false);
  assert.match(third.progressLine, /Next:/);
});

test("recovery engine surfaces safe auto-retry without consuming plan recovery budget", () => {
  const plan = createTestPlan("Fetch sources.", ["web_fetch"]);

  let safeState = createSafeFailureRetryState(2);
  const first = decideRecoveryAction({
    plan,
    failure: {
      source: "model",
      message: "invalid tool call",
      code: "invalid_arguments",
      retryable: true,
    },
    safeFailureState: safeState,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
  assert.equal(first.action, "retry");
  assert.equal(first.safeAutoRetry, true);
  assert.match(first.progressLine, /retrying automatically/i);
  safeState = first.safeFailureState ?? safeState;

  const toolTimeout = decideRecoveryAction({
    plan,
    failure: { source: "web_fetch", message: "timeout", retryable: true },
    safeFailureState: safeState,
    now: new Date("2026-07-22T12:01:00.000Z"),
  });
  assert.equal(toolTimeout.action, "retry");
  assert.equal(toolTimeout.safeAutoRetry, false);
  assert.match(toolTimeout.progressLine, /Retrying web_fetch/i);
});

function createTestPlan(prompt: string, allowedToolNames: string[]): MissionPlan {
  return createMissionPlan({
    runId: "run:safe-retry",
    prompt,
    missionIntent: createIntent(false),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames,
    },
    requiredTools: allowedToolNames,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
}

function createIntent(requireWriteCompletion: boolean): MissionIntent {
  return {
    mode: requireWriteCompletion ? "note_output" : "vault_context_answer",
    vaultContext: false,
    noteOutput: requireWriteCompletion,
    explicitPersistence: requireWriteCompletion,
    explicitMutation: requireWriteCompletion,
    explicitDelete: false,
    allowAutonomousWrite: requireWriteCompletion,
    requireWriteCompletion,
    autonomyScope: deriveAutonomyScope("append to current note", {
      noteOutput: requireWriteCompletion,
      explicitPersistence: requireWriteCompletion,
      explicitMutation: requireWriteCompletion,
    }),
  };
}
