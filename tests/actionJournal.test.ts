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
  reconcileHistoricalCanvasPreflightJournalRecord,
  reconcilePersistedExactLifecycleJournalRecords,
  reconcilePriorExactLifecycleJournalRecords,
  resolveReceiptBackedOutputTargetPathV1,
  transitionOperationJournalRecord,
} from "../src/agent/runStore";

test("resumed new-note target requires an exact committed creation receipt", () => {
  const at = new Date("2026-08-09T08:00:00.000Z");
  let record = createOperationJournalRecord({
    operationId: "run-output:1:stream:append",
    rootRunId: "run-output",
    segmentId: "run-output",
    toolName: "append_to_current_file",
    operation: "append",
    now: at,
  });
  record = transitionOperationJournalRecord(record, "applying", {
    message: "Stream started.",
    now: at,
  });
  record = transitionOperationJournalRecord(record, "applied", {
    message: "Stream applied.",
    mutationMayHaveApplied: true,
    now: at,
  });
  record = transitionOperationJournalRecord(record, "verified", {
    message: "Readback verified.",
    receipt: {
      id: "receipt-output",
      toolName: "append_to_current_file",
      operation: "append",
      path: "Research/Verified report.md",
      message: "append Research/Verified report.md",
      createdAt: at.toISOString(),
      readback: {
        status: "verified",
        checkedAt: at.toISOString(),
        observedFingerprint: "fnv1a32:12345678",
      },
      output: {
        path: "Research/Verified report.md",
        createdPath: "Research/Verified report.md",
        partial: false,
      },
    },
    now: at,
  });
  record = transitionOperationJournalRecord(record, "committed", {
    message: "Receipt committed.",
    now: at,
  });
  const snapshot = createMissionRuntimeSnapshot({
    runId: "run-output",
    originalMission: "Create a report in a new note.",
    outputTargetPath: "Research/Verified report.md",
    operationJournal: [record],
    createdAt: at,
  });

  assert.deepEqual(resolveReceiptBackedOutputTargetPathV1(snapshot), {
    path: "Research/Verified report.md",
    observedFingerprint: "fnv1a32:12345678",
    receiptId: "receipt-output",
    operationId: "run-output:1:stream:append",
  });

  const tampered = {
    ...snapshot,
    outputTargetPath: "Private/Victim.md",
  };
  assert.equal(resolveReceiptBackedOutputTargetPathV1(tampered), null);

  const partial = {
    ...snapshot,
    operationJournal: snapshot.operationJournal.map((item) => ({
      ...item,
      receipt: item.receipt
        ? {
            ...item.receipt,
            output: {
              ...(item.receipt.output as Record<string, unknown>),
              partial: true,
            },
          }
        : undefined,
    })),
  };
  assert.equal(resolveReceiptBackedOutputTargetPathV1(partial), null);
});

test("historical Canvas preflight WAL recovery is fail-closed", async () => {
  const descriptor: ToolDescriptor = {
    ...descriptorFixture(),
    name: "create_design_canvas",
    capability: {
      system: "vault",
      resourceType: "canvas",
      action: "create",
    },
    effect: "reversible_mutation",
  };
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "canvas-action",
    runId: "run-canvas",
    toolCallId: "canvas-call",
    toolName: descriptor.name,
    target: {
      system: "vault",
      resourceType: "canvas",
      id: "Story.canvas",
      path: "Story.canvas",
    },
    relatedResources: [],
    normalizedArgs: { path: "Story.canvas" },
    preview: {
      summary: "Create Story.canvas",
      destination: "Story.canvas",
      warnings: [],
      outboundBytes: 0,
    },
    preparedAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2026-07-22T10:05:00.000Z",
  });
  let record = createOperationJournalRecord({
    operationId: "canvas-op",
    rootRunId: "run-canvas",
    segmentId: "run-canvas",
    toolName: descriptor.name,
    operation: descriptor.capability.action,
    targetPath: "Story.canvas",
    expectedPostWriteHash: `sha256:${"a".repeat(64)}`,
    preparedAction: action,
    descriptor,
    authorization: {
      preparedActionId: action.id,
      payloadFingerprint: action.payloadFingerprint,
      grantId: "canvas-grant",
    },
    now: new Date("2026-07-22T10:00:00.000Z"),
  });
  record = transitionOperationJournalRecord(record, "applying", {
    message: "Canvas preflight started.",
    now: new Date("2026-07-22T10:00:01.000Z"),
  });
  record = transitionOperationJournalRecord(record, "reconcile_required", {
    message:
      "Invalid JSON Canvas: nodes[0].x must be an integer; mutation may have applied.",
    error: "invalid_arguments: nodes[0].x must be an integer",
    mutationMayHaveApplied: true,
    now: new Date("2026-07-22T10:00:02.000Z"),
  });

  const absent = reconcileHistoricalCanvasPreflightJournalRecord(
    record,
    { status: "absent" },
    new Date("2026-07-22T10:00:03.000Z"),
  );
  assert.equal(absent.state, "failed");
  assert.equal(absent.mutationMayHaveApplied, false);
  assert.equal(
    buildOperationReconciliationInputs([absent])[0].recommendedAction,
    "safe_to_retry",
  );

  const conflicting = reconcileHistoricalCanvasPreflightJournalRecord(record, {
    status: "conflicting",
    observedFingerprint: `sha256:${"b".repeat(64)}`,
  });
  assert.equal(conflicting.state, "reconcile_required");
  assert.equal(conflicting.receipt, undefined);

  const matching = reconcileHistoricalCanvasPreflightJournalRecord(
    record,
    {
      status: "fingerprint_match",
      observedFingerprint: `sha256:${"a".repeat(64)}`,
    },
    new Date("2026-07-22T10:00:04.000Z"),
  );
  assert.equal(matching.state, "committed");
  assert.equal(matching.receipt?.commitKind, "reconciled");
  assert.equal(matching.receipt?.readback?.status, "verified");
  assert.equal(
    matching.receipt?.readback?.observedFingerprint,
    `sha256:${"a".repeat(64)}`,
  );
});

test("verified exact lifecycle retry closes an older ambiguous WAL row for the same graph node", () => {
  const preparedAction = {
    version: 1 as const,
    id: "publication-action",
    runId: "run-lifecycle",
    toolCallId: "publication-call",
    toolName: "publish_research_to_linear",
    target: {
      system: "linear" as const,
      resourceType: "issue",
      id: "issue-1",
      teamId: "team-1",
    },
    relatedResources: [],
    normalizedArgs: { issueId: "issue-1", visibility: "private" },
    preview: {
      summary: "Publish accepted research",
      destination: "Linear issue issue-1",
      warnings: [],
      outboundBytes: 128,
    },
    payloadFingerprint: `sha256:${"c".repeat(64)}`,
    idempotencyKey: "research-publication:stable-work-item",
    preparedAt: "2026-07-18T10:00:00.000Z",
    expiresAt: "2026-07-18T10:05:00.000Z",
  };
  const make = (operationId: string) =>
    createOperationJournalRecord({
      operationId,
      rootRunId: "run-lifecycle",
      segmentId: "run-lifecycle",
      nodeId: "tool-04-publish-research",
      toolName: "publish_research_to_linear",
      operation: "publish",
      preparedAction: { ...preparedAction, id: `${operationId}-action` },
      now: new Date("2026-07-18T10:00:00.000Z"),
    });
  const prior = transitionOperationJournalRecord(
    transitionOperationJournalRecord(make("prior"), "applying", {
      message: "Provider dispatch started.",
      mutationMayHaveApplied: true,
      now: new Date("2026-07-18T10:00:01.000Z"),
    }),
    "reconcile_required",
    {
      message: "Provider result was ambiguous.",
      mutationMayHaveApplied: true,
      now: new Date("2026-07-18T10:00:02.000Z"),
    },
  );
  const receipt: ActionReceipt = {
    version: 1,
    id: "receipt-reconciled",
    runId: "run-lifecycle",
    actionId: "publication-action",
    toolName: "linear_create_issue",
    operation: "publish",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: "issue-1",
      identifier: "APP-1",
    },
    message: "Verified APP-1",
    payloadFingerprint: `sha256:${"a".repeat(64)}`,
    grantId: "grant-publication",
    idempotencyKey: "research-publication:stable-work-item",
    startedAt: "2026-07-18T10:00:03.000Z",
    committedAt: "2026-07-18T10:00:04.000Z",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-18T10:00:04.000Z",
    },
  };
  let current = transitionOperationJournalRecord(make("current"), "applying", {
    message: "Retry started.",
    now: new Date("2026-07-18T10:00:03.000Z"),
  });
  current = transitionOperationJournalRecord(current, "applied", {
    message: "Retry returned.",
    mutationMayHaveApplied: true,
    now: new Date("2026-07-18T10:00:04.000Z"),
  });
  current = transitionOperationJournalRecord(current, "verified", {
    message: "Retry readback verified.",
    receipt,
    now: new Date("2026-07-18T10:00:04.000Z"),
  });
  current = transitionOperationJournalRecord(current, "committed", {
    message: "Retry committed.",
    receipt,
    now: new Date("2026-07-18T10:00:05.000Z"),
  });

  const reconciled = reconcilePriorExactLifecycleJournalRecords(
    [prior, current],
    current,
    receipt,
    new Date("2026-07-18T10:00:06.000Z"),
  );

  assert.deepEqual(reconciled.map((record) => record.state), [
    "committed",
    "committed",
  ]);
  assert.equal(reconciled[0].receipt?.id, receipt.id);

  const restarted = reconcilePersistedExactLifecycleJournalRecords(
    [prior, current],
    new Date("2026-07-18T10:00:07.000Z"),
  );
  assert.deepEqual(restarted.map((record) => record.state), [
    "committed",
    "committed",
  ]);
  assert.equal(restarted[0].receipt?.id, receipt.id);
});

test("same-node lifecycle reconciliation cannot cross exact repository or visibility identity", () => {
  const action = (visibility: "public" | "private", repository: string) => ({
    version: 1 as const,
    id: `create-${visibility}-${repository}`,
    runId: "run-github",
    toolCallId: `call-${visibility}-${repository}`,
    toolName: "github_create_repository",
    target: {
      system: "github" as const,
      resourceType: "repository",
      id: `acme/${repository}`,
      repositoryId: repository,
    },
    relatedResources: [],
    normalizedArgs: { owner: "acme", repository, visibility },
    preview: {
      summary: `Create ${visibility} repository`,
      destination: `acme/${repository}`,
      warnings: visibility === "public" ? ["internet_visible"] : [],
      outboundBytes: 0,
    },
    payloadFingerprint: `sha256:${(visibility === "public" ? "d" : "e").repeat(64)}`,
    idempotencyKey: `github:create:acme:${repository}:${visibility}`,
    preparedAt: "2026-08-09T10:00:00.000Z",
    expiresAt: "2026-08-09T10:05:00.000Z",
  });
  const make = (
    operationId: string,
    preparedAction: ReturnType<typeof action>,
  ) => createOperationJournalRecord({
    operationId,
    rootRunId: "run-github",
    segmentId: "run-github",
    nodeId: "lifecycle-github-publication",
    toolName: "github_create_repository",
    operation: "create",
    preparedAction,
    now: new Date("2026-08-09T10:00:00.000Z"),
  });
  let prior = transitionOperationJournalRecord(
    make("prior", action("private", "safe-private")),
    "applying",
    { message: "dispatch", mutationMayHaveApplied: true },
  );
  prior = transitionOperationJournalRecord(prior, "reconcile_required", {
    message: "ambiguous",
    mutationMayHaveApplied: true,
  });
  let current = transitionOperationJournalRecord(
    make("current", action("public", "different-public")),
    "applying",
    { message: "dispatch" },
  );
  const receipt = {
    version: 1 as const,
    id: "receipt-public",
    runId: "run-github",
    actionId: "create-public",
    toolName: "github_create_repository",
    operation: "create" as const,
    resource: {
      system: "github" as const,
      resourceType: "public_repository",
      id: "acme/different-public",
    },
    message: "Verified public repository.",
    payloadFingerprint: `sha256:${"f".repeat(64)}`,
    grantId: "grant-public",
    idempotencyKey: "github:create:acme:different-public:public",
    startedAt: "2026-08-09T10:00:01.000Z",
    committedAt: "2026-08-09T10:00:02.000Z",
    commitKind: "committed" as const,
    readback: { status: "verified" as const, checkedAt: "2026-08-09T10:00:02.000Z" },
  };
  current = transitionOperationJournalRecord(current, "applied", {
    message: "applied",
  });
  current = transitionOperationJournalRecord(current, "verified", {
    message: "verified",
    receipt,
  });
  current = transitionOperationJournalRecord(current, "committed", {
    message: "committed",
    receipt,
  });
  const reconciled = reconcilePriorExactLifecycleJournalRecords(
    [prior, current],
    current,
    receipt,
  );
  assert.equal(reconciled[0]?.state, "reconcile_required");
});

test("an exact lifecycle composite may re-enter its own durable reconciliation checkpoint", () => {
  const descriptor: ToolDescriptor = {
    ...descriptorFixture(),
    name: "publish_research_project_to_linear",
    capability: {
      system: "linear",
      resourceType: "project_hierarchy",
      action: "publish",
    },
    effect: "publish",
    approval: {
      allowPromptGrant: false,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: {
      preparation: "none",
      cacheable: false,
      parallelSafe: false,
    },
  };
  const intent = createOperationJournalRecord({
    operationId: "hierarchy-segment-1",
    rootRunId: "run-hierarchy",
    segmentId: "run-hierarchy",
    nodeId: "tool-05-publish_research_project_to_linear",
    toolName: descriptor.name,
    operation: descriptor.capability.action,
    inputHash: `sha256:${"a".repeat(64)}`,
    descriptor,
    now: new Date("2026-07-18T13:00:00.000Z"),
  });
  const applying = transitionOperationJournalRecord(intent, "applying", {
    message: "The composite checkpoint was persisted before nested execution.",
    now: new Date("2026-07-18T13:00:01.000Z"),
  });
  const pending = transitionOperationJournalRecord(
    applying,
    "reconcile_required",
    {
      message: "Nested provider readback is pending.",
      mutationMayHaveApplied: true,
      now: new Date("2026-07-18T13:00:02.000Z"),
    },
  );

  const reconciliation = buildOperationReconciliationInputs([pending])[0];
  assert.equal(reconciliation.mutationMayHaveApplied, true);
  assert.equal(reconciliation.recommendedAction, "safe_to_retry");

  const ordinary = {
    ...pending,
    operationId: "ordinary-external-mutation",
    toolName: "linear_create_issue",
    descriptor: descriptorFixture(),
  };
  assert.notEqual(
    buildOperationReconciliationInputs([ordinary])[0].recommendedAction,
    "safe_to_retry",
  );
});

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
  assert.equal(restored?.operationJournal[0].receipt?.runId, "run-1");
  assert.equal(restored?.operationJournal[0].receipt?.resource?.system, "linear");
  assert.equal(restored?.operationJournal[0].receipt?.readback?.status, "verified");
  assert.deepEqual(restored?.operationJournal[0].receipt?.effects?.changedFields, [
    "title",
  ]);
  assert.equal(restored?.receipts[0].runId, "run-1");
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
