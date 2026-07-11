import test from "node:test";
import assert from "node:assert/strict";
import {
  withPreparedActionFingerprint,
  type ActionReceipt,
  type PreparedAction,
} from "../src/agent/actions";
import {
  MAX_EXTERNAL_ACTION_RECEIPTS,
  MAX_PENDING_LINEAR_RECONCILIATIONS,
  appendVerifiedExternalActionReceipt,
  createExternalActionReceiptLedgerState,
  createPendingLinearReconciliationState,
  normalizeExternalActionReceiptLedgerState,
  normalizePendingLinearReconciliationState,
  parseExternalActionReceiptLedgerState,
  parsePendingLinearReconciliationState,
  recordLinearReconciliationOutcome,
  upsertUncertainLinearReconciliation,
} from "../src/integrations/linear";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

test("pending Linear reconciliation survives a crash round-trip with its authority binding", async () => {
  const action = await actionFixture();
  const initial = createPendingLinearReconciliationState(
    new Date("2026-07-11T12:00:00.000Z"),
  );
  const uncertain = await upsertUncertainLinearReconciliation(initial, {
    expectedRevision: 0,
    action,
    grantId: "grant-queue-1",
    issueId: "issue-1",
    queueStage: "claim_comment",
    authoritySubject: { type: "schedule", id: "linear-queue" },
    at: "2026-07-11T12:02:00.000Z",
    error: {
      code: "linear_mutation_uncertain",
      message: "Request timed out after dispatch.",
    },
  });

  const restarted = await parsePendingLinearReconciliationState(
    JSON.parse(JSON.stringify(uncertain)),
  );

  assert.deepEqual(restarted, uncertain);
  assert.equal(restarted.revision, 1);
  assert.equal(restarted.pendingByActionId[action.id].grantId, "grant-queue-1");
  assert.equal(restarted.pendingByActionId[action.id].issueId, "issue-1");
  assert.deepEqual(restarted.pendingByActionId[action.id].authoritySubject, {
    type: "schedule",
    id: "linear-queue",
  });
  assert.equal(
    restarted.pendingByActionId[action.id].lastError?.code,
    "linear_mutation_uncertain",
  );
});

test("only committed or not-applied reconciliation removes pending actions", async () => {
  const action = await actionFixture();
  let state = await uncertainState(action);

  state = await recordLinearReconciliationOutcome(state, {
    expectedRevision: 1,
    actionId: action.id,
    outcome: "still_uncertain",
    at: "2026-07-11T12:03:00.000Z",
    error: { code: "linear_readback_ambiguous", message: "No conclusive match yet." },
  });
  assert.ok(state.pendingByActionId[action.id]);
  assert.equal(state.revision, 2);
  assert.equal(state.pendingByActionId[action.id].lastAttemptAt, "2026-07-11T12:03:00.000Z");

  const committed = await recordLinearReconciliationOutcome(state, {
    expectedRevision: 2,
    actionId: action.id,
    outcome: "committed",
    at: "2026-07-11T12:04:00.000Z",
  });
  assert.equal(committed.pendingByActionId[action.id], undefined);

  state = await uncertainState(action);
  const notApplied = await recordLinearReconciliationOutcome(state, {
    expectedRevision: 1,
    actionId: action.id,
    outcome: "not_applied",
    at: "2026-07-11T12:04:00.000Z",
  });
  assert.equal(notApplied.pendingByActionId[action.id], undefined);

  await assert.rejects(
    () => recordLinearReconciliationOutcome(state, {
      expectedRevision: 0,
      actionId: action.id,
      outcome: "committed",
      at: "2026-07-11T12:04:00.000Z",
    }),
    /revision conflict/,
  );
});

test("pending state fails closed on prepared-action tampering, credentials, shape drift, and caps", async () => {
  const action = await actionFixture();
  const state = await uncertainState(action);

  const tampered = JSON.parse(JSON.stringify(state));
  tampered.pendingByActionId[action.id].action.normalizedArgs.variables.input.title = "Tampered";
  await assert.rejects(
    () => parsePendingLinearReconciliationState(tampered),
    /fingerprint is invalid|tampered/,
  );
  assert.equal(await normalizePendingLinearReconciliationState(tampered), null);

  const wrongKey = JSON.parse(JSON.stringify(state));
  wrongKey.pendingByActionId["linear-action-other"] = wrongKey.pendingByActionId[action.id];
  delete wrongKey.pendingByActionId[action.id];
  await assert.rejects(
    () => parsePendingLinearReconciliationState(wrongKey),
    /map key does not match/,
  );

  const unknownKey = JSON.parse(JSON.stringify(state));
  unknownKey.pendingByActionId[action.id].credential = "must-not-persist";
  await assert.rejects(
    () => parsePendingLinearReconciliationState(unknownKey),
    /keys are invalid/,
  );

  const credentialAction = await actionFixture({
    normalizedArgs: {
      operationKey: "issues.update",
      apiKey: "linear-secret-must-not-persist",
    },
  });
  await assert.rejects(
    () => upsertUncertainLinearReconciliation(
      createPendingLinearReconciliationState(new Date("2026-07-11T12:00:00.000Z")),
      {
        expectedRevision: 0,
        action: credentialAction,
        grantId: "grant-queue-1",
        issueId: "issue-1",
        queueStage: "started_state",
        authoritySubject: { type: "schedule", id: "linear-queue" },
        at: "2026-07-11T12:02:00.000Z",
      },
    ),
    /may not persist credential field/,
  );

  const credentialValueAction = await actionFixture({
    normalizedArgs: {
      operationKey: "issues.update",
      variables: { description: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
    },
  });
  await assert.rejects(
    () => upsertUncertainLinearReconciliation(
      createPendingLinearReconciliationState(new Date("2026-07-11T12:00:00.000Z")),
      {
        expectedRevision: 0,
        action: credentialValueAction,
        grantId: "grant-queue-1",
        issueId: "issue-1",
        queueStage: "manual",
        authoritySubject: { type: "run", id: "run-1" },
        at: "2026-07-11T12:02:00.000Z",
      },
    ),
    /may not persist credential material/,
  );

  const oversized = JSON.parse(JSON.stringify(state));
  const entry = oversized.pendingByActionId[action.id];
  oversized.pendingByActionId = Object.fromEntries(
    Array.from({ length: MAX_PENDING_LINEAR_RECONCILIATIONS + 1 }, (_, index) => [
      `linear-action-${index}`,
      entry,
    ]),
  );
  await assert.rejects(
    () => parsePendingLinearReconciliationState(oversized),
    /exceeds 32 entries/,
  );
});

test("external receipt ledger round-trips, deduplicates ids, and retains fixed proof kind", () => {
  const receipt = receiptFixture();
  const initial = createExternalActionReceiptLedgerState(
    new Date("2026-07-11T12:00:00.000Z"),
  );
  const appended = appendVerifiedExternalActionReceipt(initial, {
    expectedRevision: 0,
    receipt,
    recordedAt: "2026-07-11T12:05:00.000Z",
  });
  const duplicate = appendVerifiedExternalActionReceipt(appended, {
    expectedRevision: 1,
    receipt: JSON.parse(JSON.stringify(receipt)),
    recordedAt: "2026-07-11T12:06:00.000Z",
  });
  const restarted = parseExternalActionReceiptLedgerState(
    JSON.parse(JSON.stringify(duplicate)),
  );

  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.entries.length, 1);
  assert.equal(duplicate.entries[0].proofKind, "external_action");
  assert.deepEqual(restarted, duplicate);
});

test("external ledger rejects receipt collisions and cross-domain proof upgrades", () => {
  const receipt = receiptFixture();
  const appended = appendVerifiedExternalActionReceipt(
    createExternalActionReceiptLedgerState(new Date("2026-07-11T12:00:00.000Z")),
    {
      expectedRevision: 0,
      receipt,
      recordedAt: "2026-07-11T12:05:00.000Z",
    },
  );
  assert.throws(
    () => appendVerifiedExternalActionReceipt(appended, {
      expectedRevision: 1,
      receipt: { ...receipt, message: "Different receipt under the same id." },
      recordedAt: "2026-07-11T12:06:00.000Z",
    }),
    /collided/,
  );

  assert.throws(
    () => appendVerifiedExternalActionReceipt(
      createExternalActionReceiptLedgerState(new Date("2026-07-11T12:00:00.000Z")),
      {
        expectedRevision: 0,
        receipt: {
          ...receipt,
          toolName: "append_to_current_file",
          resource: { system: "vault", resourceType: "note", id: "note-1" },
        },
        recordedAt: "2026-07-11T12:05:00.000Z",
      },
    ),
    /Only Linear or GitHub receipts/,
  );

  const changedProof = JSON.parse(JSON.stringify(appended));
  changedProof.entries[0].proofKind = "vault_write";
  assert.throws(
    () => parseExternalActionReceiptLedgerState(changedProof),
    /host-derived external_action/,
  );
  assert.equal(normalizeExternalActionReceiptLedgerState(changedProof), null);

  const unverified = {
    ...receipt,
    readback: { ...receipt.readback, status: "not_required" as const },
  };
  assert.throws(
    () => appendVerifiedExternalActionReceipt(
      createExternalActionReceiptLedgerState(new Date("2026-07-11T12:00:00.000Z")),
      {
        expectedRevision: 0,
        receipt: unverified,
        recordedAt: "2026-07-11T12:05:00.000Z",
      },
    ),
    /requires verified provider readback/,
  );
});

test("external receipt ledger strictly rejects unknown keys and over-cap persistence", () => {
  const receipt = receiptFixture();
  const appended = appendVerifiedExternalActionReceipt(
    createExternalActionReceiptLedgerState(new Date("2026-07-11T12:00:00.000Z")),
    {
      expectedRevision: 0,
      receipt,
      recordedAt: "2026-07-11T12:05:00.000Z",
    },
  );
  const unknown = JSON.parse(JSON.stringify(appended));
  unknown.entries[0].receipt.apiKey = "must-not-persist";
  assert.throws(
    () => parseExternalActionReceiptLedgerState(unknown),
    /keys are invalid/,
  );

  const oversized = JSON.parse(JSON.stringify(appended));
  oversized.entries = Array.from(
    { length: MAX_EXTERNAL_ACTION_RECEIPTS + 1 },
    (_, index) => ({
      ...oversized.entries[0],
      receipt: { ...oversized.entries[0].receipt, id: `linear-receipt-${index}` },
    }),
  );
  assert.throws(
    () => parseExternalActionReceiptLedgerState(oversized),
    /exceeds 256 entries/,
  );
});

test("external receipt append rolls off the oldest item at the fixed 256-entry bound", () => {
  const receipt = receiptFixture();
  const full = parseExternalActionReceiptLedgerState({
    schemaVersion: 1,
    revision: MAX_EXTERNAL_ACTION_RECEIPTS,
    entries: Array.from({ length: MAX_EXTERNAL_ACTION_RECEIPTS }, (_, index) => ({
      proofKind: "external_action",
      receipt: { ...receipt, id: `linear-receipt-${index}` },
      recordedAt: "2026-07-11T12:05:00.000Z",
    })),
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:05:00.000Z",
  });

  const rolled = appendVerifiedExternalActionReceipt(full, {
    expectedRevision: MAX_EXTERNAL_ACTION_RECEIPTS,
    receipt: { ...receipt, id: "linear-receipt-new" },
    recordedAt: "2026-07-11T12:06:00.000Z",
  });

  assert.equal(rolled.entries.length, MAX_EXTERNAL_ACTION_RECEIPTS);
  assert.equal(rolled.entries.some((entry) => entry.receipt.id === "linear-receipt-0"), false);
  assert.equal(rolled.entries.at(-1)?.receipt.id, "linear-receipt-new");
});

async function uncertainState(action: PreparedAction) {
  return upsertUncertainLinearReconciliation(
    createPendingLinearReconciliationState(new Date("2026-07-11T12:00:00.000Z")),
    {
      expectedRevision: 0,
      action,
      grantId: "grant-queue-1",
      issueId: "issue-1",
      queueStage: "claim_comment",
      authoritySubject: { type: "schedule", id: "linear-queue" },
      at: "2026-07-11T12:02:00.000Z",
      error: { code: "linear_mutation_uncertain", message: "Dispatch was ambiguous." },
    },
  );
}

async function actionFixture(
  overrides: Partial<Parameters<typeof withPreparedActionFingerprint>[0]> = {},
): Promise<PreparedAction> {
  return withPreparedActionFingerprint({
    version: 1,
    id: "linear-action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "linear_update_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: "issue-1",
      identifier: "PLAT-42",
      teamId: "team-1",
      projectId: "project-queue",
      revision: HASH_A,
    },
    relatedResources: [],
    normalizedArgs: {
      operationKey: "issues.update",
      variables: { id: "issue-1", input: { title: "Research ticket" } },
    },
    preview: {
      summary: "Update Linear issue PLAT-42",
      destination: "Linear issue PLAT-42",
      before: { title: "Old title" },
      after: { title: "Research ticket" },
      outboundPayload: { id: "issue-1", input: { title: "Research ticket" } },
      warnings: [],
      outboundBytes: 68,
    },
    expectedTargetRevision: HASH_A,
    idempotencyKey: "linear:issue:update:run-1:call-1:0",
    reconciliationKey: "linear:issue:update:run-1:call-1:0",
    preparedAt: "2026-07-11T12:01:00.000Z",
    expiresAt: "2026-07-11T12:11:00.000Z",
    ...overrides,
  });
}

function receiptFixture(): ActionReceipt {
  return {
    version: 1,
    id: "linear-receipt-1",
    runId: "run-1",
    actionId: "linear-action-1",
    toolName: "linear_update_issue",
    operation: "update",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: "issue-1",
      identifier: "PLAT-42",
      teamId: "team-1",
      projectId: "project-queue",
      revision: HASH_B,
    },
    relatedResources: [],
    message: "Verified update for Linear issue PLAT-42.",
    payloadFingerprint: HASH_A,
    grantId: "grant-queue-1",
    idempotencyKey: "linear:issue:update:run-1:call-1:0",
    startedAt: "2026-07-11T12:03:00.000Z",
    committedAt: "2026-07-11T12:04:00.000Z",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-11T12:04:00.000Z",
      observedRevision: HASH_B,
      observedFingerprint: HASH_B,
    },
    effects: {
      affectedCount: 1,
      changedFields: ["title"],
    },
  };
}
