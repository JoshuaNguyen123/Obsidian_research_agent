import test from "node:test";
import assert from "node:assert/strict";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import {
  createHierarchicalMissionPlanFromV1,
  createMissionPlan,
  flattenMissionPlanTasks,
  getNextMissionPlanActionCompat,
  hierarchicalMissionPlanToV1,
  normalizeMissionPlan,
  normalizeMissionPlanLike,
  type MissionPlan,
} from "../src/agent/missionPlan";
import {
  createStaticVerifier,
  evaluateVerifierCompletion,
} from "../src/agent/verifiers";
import {
  createRecoveryState,
  decideRecoveryAction,
  shouldAttemptRecovery,
  type RecoveryState,
} from "../src/agent/recoveryEngine";
import {
  createVaultTransaction,
  markVaultMutationPrepared,
  recordVaultMutationReceipt,
  stageVaultMutation,
  summarizeVaultTransaction,
} from "../src/agent/vaultTransactions";
import { buildRuntimeContinuationMemoryBundle } from "../src/agent/continuationMemory";
import type { MissionIntent } from "../src/tools/types";

test("hierarchical mission plan helpers preserve v1 compatibility", () => {
  const v1 = createTestPlan(
    "Search the web and append a note.",
    ["web_search", "append_to_current_file"],
  );
  const v2 = createHierarchicalMissionPlanFromV1(v1);

  assert.equal(v2.version, 2);
  assert.deepEqual(v2.rootIds, ["root"]);
  assert.deepEqual(v2.nodes.root.childIds, ["task-1"]);
  assert.equal(flattenMissionPlanTasks(v2).map((task) => task.id).join(","), "task-1");
  assert.equal(getNextMissionPlanActionCompat(v2)?.toolName, "web_search");

  const normalizedLike = normalizeMissionPlanLike(JSON.parse(JSON.stringify(v2)));
  assert.equal(normalizedLike?.version, 2);

  const normalizedAsV1 = normalizeMissionPlan(JSON.parse(JSON.stringify(v2)));
  assert.equal(normalizedAsV1?.version, 1);
  assert.equal(normalizedAsV1?.tasks[0].id, "task-1");
  assert.equal(hierarchicalMissionPlanToV1(v2).tasks[0].id, v1.tasks[0].id);
  assert.deepEqual(
    hierarchicalMissionPlanToV1(v2).tasks[0].completionContract,
    v1.tasks[0].completionContract,
  );
});

test("verifier completion wraps acceptance and fails when an added verifier fails", () => {
  const plan = createTestPlan("Answer directly.", []);
  const result = evaluateVerifierCompletion({
    prompt: "Answer directly.",
    missionIntent: createIntent(false),
    requiredTools: [],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "Done.",
    plan,
    verifiers: [
      createStaticVerifier("custom_quality_gate", {
        status: "needs_more_work",
        confidence: 0.4,
        missing: ["custom_quality"],
        reasons: ["custom_quality_missing"],
        nextAction: "Address the custom quality gate.",
      }),
    ],
  });

  assert.equal(result.status, "needs_more_work");
  assert.equal(result.confidence, 0.4);
  assert.ok(result.missing.includes("custom_quality"));
  assert.equal(result.verifierResults[0].id, "mission_acceptance");
  assert.equal(result.nextAction, "Address the custom quality gate.");
});

test("recovery engine retries once, replans on repeat, then blocks at the bound", () => {
  const plan = createTestPlan("Fetch sources.", ["web_fetch"]);

  const first = decideRecoveryAction({
    plan,
    failure: { source: "web_fetch", message: "timeout" },
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  assert.equal(first.action, "retry");
  assert.equal(shouldAttemptRecovery(first), true);

  const second = decideRecoveryAction({
    plan,
    failure: { source: "web_fetch", message: "timeout" },
    state: first.state,
    now: new Date("2026-07-10T12:01:00.000Z"),
  });
  assert.equal(second.action, "replan");
  assert.equal(second.attemptsRemaining, 0);

  const third = decideRecoveryAction({
    plan,
    failure: { source: "web_fetch", message: "timeout" },
    state: second.state,
    now: new Date("2026-07-10T12:02:00.000Z"),
  });
  assert.equal(third.action, "block");
  assert.equal(shouldAttemptRecovery(third), false);
  assert.equal(third.planAdvance?.plan.status, "blocked");
});

test("vault transactions stage safe markdown mutations and require backup for replace", () => {
  let transaction = createVaultTransaction({
    id: "tx-1",
    now: new Date("2026-07-10T12:00:00.000Z"),
  });

  transaction = stageVaultMutation(transaction, {
    operation: "replace",
    path: "Notes/Current.md",
  });
  assert.equal(transaction.mutations[0].requiresBackup, true);

  assert.throws(() =>
    markVaultMutationPrepared({
      transaction,
      mutationId: "mutation-1",
    }),
  );

  transaction = markVaultMutationPrepared({
    transaction,
    mutationId: "mutation-1",
    backupPath: ".agent-backups/Current.md",
  });
  transaction = recordVaultMutationReceipt({
    transaction,
    mutationId: "mutation-1",
    receipt: {
      toolName: "replace_current_file",
      operation: "replace",
      path: "Notes/Current.md",
      backupPath: ".agent-backups/Current.md",
      bytesWritten: 12,
    },
  });

  assert.equal(transaction.status, "committed");
  assert.deepEqual(summarizeVaultTransaction(transaction), {
    id: "tx-1",
    status: "committed",
    staged: 0,
    prepared: 0,
    committed: 1,
    failed: 0,
  });
});

test("vault transactions reject unsafe paths before staging", () => {
  const transaction = createVaultTransaction({ id: "tx-unsafe" });

  assert.throws(() =>
    stageVaultMutation(transaction, {
      operation: "append",
      path: "../outside.md",
    }),
  );
});

test("continuation memory bundle summarizes bounded runtime state", () => {
  const plan = createHierarchicalMissionPlanFromV1(
    createTestPlan("Search the web and append a note.", ["web_search"]),
  );
  const recovery: RecoveryState = {
    ...createRecoveryState({
      maxAttempts: 2,
      now: new Date("2026-07-10T12:00:00.000Z"),
    }),
    maxAttempts: 2,
    attempts: [
      {
        signature: "web_fetch:timeout",
        action: "retry",
        reason: "Retry web_fetch: timeout",
        createdAt: "2026-07-10T12:00:00.000Z",
      },
    ],
    totalAttempts: 1,
    signatureCounts: {
      "web_fetch:timeout": 1,
    },
    updatedAt: "2026-07-10T12:00:00.000Z",
  };
  const bundle = buildRuntimeContinuationMemoryBundle({
    runId: "run:test",
    prompt: "Search the web and append a note.",
    plan,
    acceptance: {
      status: "needs_more_work",
      confidence: 0.55,
      missing: ["web_evidence"],
      reasons: ["required_evidence_or_tool_missing"],
      nextAction: "Gather web source evidence.",
    },
    recovery,
    notes: ["x".repeat(400)],
    now: new Date("2026-07-10T12:05:00.000Z"),
  });

  assert.equal(bundle.version, 1);
  assert.equal(bundle.plan?.remainingTaskIds.includes("task-1"), true);
  assert.equal(bundle.acceptance?.missing[0], "web_evidence");
  assert.equal(bundle.recovery?.attempts, 1);
  assert.ok(bundle.notes[0].length < 260);
});

function createTestPlan(prompt: string, allowedToolNames: string[]): MissionPlan {
  return createMissionPlan({
    runId: "run:test",
    prompt,
    missionIntent: createIntent(
      allowedToolNames.some((tool) => /append|replace|write/.test(tool)),
    ),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames,
    },
    requiredTools: allowedToolNames,
    now: new Date("2026-07-10T12:00:00.000Z"),
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
