import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLinearOperationId,
  createLinearMutationJournalRecord,
  reconcileLinearMutation,
  transitionLinearMutationJournalRecord,
  type LinearMutationJournalRecord,
} from "../src/integrations/linear";

const PRE_HASH = `sha256:${"1".repeat(64)}`;
const POST_HASH = `sha256:${"2".repeat(64)}`;
const PAYLOAD_HASH = `sha256:${"3".repeat(64)}`;

test("mutation intents require a target identity and canonical hashes", () => {
  assert.throws(
    () => makeRecord({ resourceId: undefined }),
    /resource id or client resource id/,
  );
  assert.throws(
    () => makeRecord({ payloadHash: "not-a-hash" }),
    /payloadHash/,
  );

  const record = makeRecord({
    resourceId: undefined,
    clientResourceId: "client-issue-1",
    payloadHash: PAYLOAD_HASH.toUpperCase(),
  });
  assert.equal(record.payloadHash, PAYLOAD_HASH);
  assert.equal(record.state, "intent_recorded");
  assert.equal(record.mutationMayHaveApplied, false);
});

test("journal transitions are explicit and mark dispatched uncertainty", () => {
  const intent = makeRecord();
  const applying = transitionLinearMutationJournalRecord(intent, "applying", {
    now: new Date("2026-07-11T01:00:01.000Z"),
  });
  const reconcile = transitionLinearMutationJournalRecord(
    applying,
    "reconcile_required",
    {
      mutationMayHaveApplied: true,
      now: new Date("2026-07-11T01:00:02.000Z"),
    },
  );

  assert.equal(applying.mutationMayHaveApplied, false);
  assert.equal(reconcile.mutationMayHaveApplied, true);
  assert.equal(reconcile.updatedAt, "2026-07-11T01:00:02.000Z");
  assert.throws(
    () => transitionLinearMutationJournalRecord(intent, "committed"),
    /Invalid Linear mutation transition/,
  );
});

test("readback of the expected post-state commits the observed result", () => {
  const record = makeRecord({ expectedPostHash: POST_HASH });

  assert.equal(
    reconcileLinearMutation(record, {
      found: true,
      snapshotHash: POST_HASH,
    }).action,
    "commit_observed_result",
  );
});

test("unchanged preconditions are only auto-retryable before dispatch", () => {
  const intent = makeRecord();
  assert.equal(
    reconcileLinearMutation(intent, {
      found: true,
      snapshotHash: PRE_HASH,
    }).action,
    "safe_to_retry",
  );

  const applying = transitionLinearMutationJournalRecord(intent, "applying");
  const uncertain = transitionLinearMutationJournalRecord(
    applying,
    "reconcile_required",
    { mutationMayHaveApplied: true },
  );
  assert.equal(
    reconcileLinearMutation(uncertain, {
      found: true,
      snapshotHash: PRE_HASH,
    }).action,
    "reapprove_retry",
  );
});

test("absence reconciles deletes but pauses ambiguous non-delete mutations", () => {
  const deleteIntent = makeRecord({
    operationKey: "issues.delete_permanently",
    expectedAbsent: true,
    expectedPostHash: undefined,
  });
  const applyingDelete = transitionLinearMutationJournalRecord(
    deleteIntent,
    "applying",
  );
  const uncertainDelete = transitionLinearMutationJournalRecord(
    applyingDelete,
    "reconcile_required",
    { mutationMayHaveApplied: true },
  );
  assert.equal(
    reconcileLinearMutation(uncertainDelete, { found: false }).action,
    "commit_observed_result",
  );

  const applyingUpdate = transitionLinearMutationJournalRecord(
    makeRecord(),
    "applying",
  );
  const uncertainUpdate = transitionLinearMutationJournalRecord(
    applyingUpdate,
    "reconcile_required",
    { mutationMayHaveApplied: true },
  );
  assert.equal(
    reconcileLinearMutation(uncertainUpdate, { found: false }).action,
    "wait_and_recheck",
  );
});

test("unknown observed state requires manual review and commits stay terminal", () => {
  const record = makeRecord({ expectedPostHash: POST_HASH });
  assert.equal(
    reconcileLinearMutation(record, {
      found: true,
      snapshotHash: `sha256:${"4".repeat(64)}`,
    }).action,
    "manual_review",
  );

  const applying = transitionLinearMutationJournalRecord(record, "applying");
  const applied = transitionLinearMutationJournalRecord(applying, "applied");
  const verified = transitionLinearMutationJournalRecord(applied, "verified");
  const committed = transitionLinearMutationJournalRecord(verified, "committed");
  assert.equal(
    reconcileLinearMutation(committed, { found: false }).action,
    "already_committed",
  );
});

test("operation ids are deterministic, sanitized, and bounded", () => {
  const operationId = buildLinearOperationId({
    resourceType: "issue",
    verb: "create ticket\nnow",
    runId: `run/${"a".repeat(120)}`,
    taskId: "task 42",
    sequence: -5,
  });

  assert.match(
    operationId,
    /^linear:issue:create-ticket-now:run-[a]+:task-42:0$/,
  );
  assert.ok(operationId.length <= 240);
});

test("node-scoped operation ids stay stable across segment runIds", () => {
  const first = buildLinearOperationId({
    resourceType: "issue",
    verb: "create",
    runId: "segment-run-1",
    taskId: "segment-run-1:3:0:linear_create_issue",
    nodeScope: {
      rootMissionId: "root-mission-a",
      nodeId: "linear-publish",
      toolName: "linear_create_issue",
    },
  });
  const retried = buildLinearOperationId({
    resourceType: "issue",
    verb: "create",
    runId: "segment-run-2",
    taskId: "segment-run-2:1:0:linear_create_issue",
    nodeScope: {
      rootMissionId: "root-mission-a",
      nodeId: "linear-publish",
      toolName: "linear_create_issue",
    },
  });
  const legacy = buildLinearOperationId({
    resourceType: "issue",
    verb: "create",
    runId: "segment-run-2",
    taskId: "segment-run-2:1:0:linear_create_issue",
  });

  assert.equal(first, retried);
  assert.match(
    first,
    /^linear:issue:create:node:root-mission-a:linear-publish:linear_create_issue:0$/,
  );
  assert.notEqual(retried, legacy);
  assert.ok(first.length <= 240);
  assert.ok(legacy.length <= 240);
});

test("incomplete node scope falls back to the legacy runId:taskId shape", () => {
  const fallback = buildLinearOperationId({
    resourceType: "issue",
    verb: "create",
    runId: "run-legacy",
    taskId: "run-legacy:2:0:linear_create_issue",
    nodeScope: {
      rootMissionId: "root-mission-a",
      nodeId: "",
      toolName: "linear_create_issue",
    },
  });
  assert.equal(
    fallback,
    buildLinearOperationId({
      resourceType: "issue",
      verb: "create",
      runId: "run-legacy",
      taskId: "run-legacy:2:0:linear_create_issue",
    }),
  );
});

test("node-scoped operation ids remain bounded at 240 characters", () => {
  const operationId = buildLinearOperationId({
    resourceType: "issue",
    verb: "create ticket\nnow",
    runId: `run/${"a".repeat(120)}`,
    taskId: "task 42",
    sequence: 9,
    nodeScope: {
      rootMissionId: `root/${"b".repeat(120)}`,
      nodeId: `node ${"c".repeat(80)}`,
      toolName: "linear_create_issue",
    },
  });
  assert.ok(operationId.length <= 240);
  assert.match(operationId, /^linear:issue:create-ticket-now:node:/);
});

function makeRecord(
  overrides: Partial<Parameters<typeof createLinearMutationJournalRecord>[0]> = {},
): LinearMutationJournalRecord {
  return createLinearMutationJournalRecord({
    operationId: "linear:issue:update:run-1:task-1:0",
    operationKey: "issues.update",
    resourceType: "issue",
    resourceId: "issue-1",
    payloadHash: PAYLOAD_HASH,
    preconditionHash: PRE_HASH,
    expectedPostHash: POST_HASH,
    now: new Date("2026-07-11T01:00:00.000Z"),
    ...overrides,
  });
}
