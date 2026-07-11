import test from "node:test";
import assert from "node:assert/strict";
import {
  withPreparedActionFingerprint,
  type ActionReceipt,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  buildOperationReconciliationInputs,
  normalizeMissionRuntimeSnapshot,
  transitionOperationJournalRecord,
} from "../src/agent/runStore";

test("action journal v2 round-trips prepared authority and canonical receipt", async () => {
  const descriptor = descriptorFixture();
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: descriptor.name,
    target: {
      system: "linear",
      resourceType: "issue",
      id: "new:call-1",
      teamId: "team-1",
    },
    relatedResources: [],
    normalizedArgs: { title: "Research follow-up" },
    preview: {
      summary: "Create issue",
      destination: "Linear team team-1",
      outboundPayload: { title: "Research follow-up" },
      warnings: [],
      outboundBytes: 24,
    },
    idempotencyKey: "run-1:call-1",
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  });
  const authorization = {
    preparedActionId: action.id,
    payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-1",
  };
  const receipt: ActionReceipt = {
    version: 1,
    id: "receipt-1",
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation: "create",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: "issue-123",
      identifier: "RES-123",
      teamId: "team-1",
    },
    message: "Created RES-123",
    payloadFingerprint: action.payloadFingerprint,
    grantId: authorization.grantId,
    idempotencyKey: action.idempotencyKey,
    startedAt: "2026-07-11T12:00:01.000Z",
    committedAt: "2026-07-11T12:00:03.000Z",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-11T12:00:02.000Z",
      observedRevision: "updated-at-1",
    },
    effects: { affectedCount: 1, changedFields: ["title"] },
  };

  let journal = createOperationJournalRecord({
    operationId: "operation-1",
    rootRunId: "run-1",
    segmentId: "run-1",
    toolName: action.toolName,
    operation: descriptor.capability.action,
    inputHash: action.payloadFingerprint,
    preparedAction: action,
    descriptor,
    authorization,
    now: new Date("2026-07-11T12:00:00.000Z"),
  });
  journal = transitionOperationJournalRecord(journal, "applying", {
    message: "Provider request starting.",
    now: new Date("2026-07-11T12:00:01.000Z"),
  });
  journal = transitionOperationJournalRecord(journal, "applied", {
    message: "Provider returned.",
    mutationMayHaveApplied: true,
    now: new Date("2026-07-11T12:00:03.000Z"),
  });
  assert.equal(
    buildOperationReconciliationInputs([journal])[0].recommendedAction,
    "provider_reconcile",
  );
  journal = transitionOperationJournalRecord(journal, "verified", {
    message: "Receipt verified.",
    receipt,
    now: new Date("2026-07-11T12:00:04.000Z"),
  });
  journal = transitionOperationJournalRecord(journal, "committed", {
    message: "Durably committed.",
    receipt,
    now: new Date("2026-07-11T12:00:05.000Z"),
  });

  const restored = normalizeMissionRuntimeSnapshot(
    JSON.parse(
      JSON.stringify(
        createMissionRuntimeSnapshot({
          runId: "run-1",
          originalMission: "Create a Linear issue.",
          operationJournal: [journal],
          receipts: [receipt],
          createdAt: new Date("2026-07-11T12:00:00.000Z"),
        }),
      ),
    ),
  );

  assert.equal(restored?.version, 2);
  assert.equal(restored?.operationJournal[0].version, 2);
  assert.equal(
    restored?.operationJournal[0].preparedAction?.payloadFingerprint,
    action.payloadFingerprint,
  );
  assert.equal(restored?.operationJournal[0].descriptor?.effect, "reversible_mutation");
  assert.equal(restored?.operationJournal[0].authorization?.grantId, "grant-1");
  assert.equal(restored?.operationJournal[0].receipt?.resource?.system, "linear");
  assert.equal(restored?.operationJournal[0].receipt?.readback?.status, "verified");
  assert.deepEqual(restored?.operationJournal[0].receipt?.effects?.changedFields, [
    "title",
  ]);
  assert.equal(restored?.receipts[0].resource?.id, "issue-123");
});

test("runtime v2 migrates legacy action journal v1 records to journal v2", () => {
  const snapshot = createMissionRuntimeSnapshot({
    runId: "run-legacy-journal",
    originalMission: "Resume a legacy mutation.",
    createdAt: new Date("2026-07-11T12:00:00.000Z"),
  });
  const restored = normalizeMissionRuntimeSnapshot({
    ...snapshot,
    operationJournal: [
      {
        version: 1,
        operationId: "legacy-op",
        rootRunId: "run-legacy-journal",
        segmentId: "run-legacy-journal",
        toolName: "append_to_current_file",
        operation: "append",
        targetPath: "Current.md",
        inputHash: "fnv1a32:12345678",
        state: "applying",
        mutationMayHaveApplied: true,
        createdAt: "2026-07-11T12:00:00.000Z",
        updatedAt: "2026-07-11T12:00:01.000Z",
        transitions: [
          {
            state: "applying",
            at: "2026-07-11T12:00:01.000Z",
            message: "Legacy execution started.",
          },
        ],
      },
    ],
  });

  assert.equal(restored?.version, 2);
  assert.equal(restored?.operationJournal[0].version, 2);
  assert.equal(restored?.operationJournal[0].operationId, "legacy-op");
  assert.equal(restored?.operationJournal[0].preparedAction, undefined);
});

function descriptorFixture(): ToolDescriptor {
  return {
    version: 1,
    name: "linear_create_issue",
    capability: { system: "linear", resourceType: "issue", action: "create" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead", "researcher"],
    receiptKind: "external_action",
  };
}
