import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePreparedExternalActionHandoffV1,
  PreparedExternalActionHandoffErrorV1,
} from "../packages/core-api/src/preparedExternalActionHandoffV1";
import {
  buildMissionCapabilityEnvelopeV1,
  parseMissionGraphV3,
  type MissionGraphV3,
} from "../packages/headless-runtime/src/missionGraphV3";
import {
  createLinearIssueReadbackExecutorV1,
  type LinearIssueReadbackV1,
} from "../packages/headless-runtime/src/installedDomainExecutors";
import {
  buildBackgroundAuthorizationV1,
  HeadlessMissionWorkerV1,
  prepareCompanionJobV1,
  type CompanionReceiptV1,
} from "../packages/headless-runtime/src/backgroundContinuation";
import type { SecretStoreV1 } from "../packages/core-api/src/secretStoreV1";
import {
  withPreparedActionFingerprint,
  type PreparedAction,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  consumeAuthorityGrant,
  createOneShotGrant,
  type AuthorityGrantV1,
} from "../src/agent/authority";
import {
  buildPreparedLinearIssueStateUpdateHandoffV1,
  PreparedExternalActionHostErrorV1,
} from "../src/agent/preparedExternalActionHandoff";
import { canonicalMissionGraphId } from "../src/agent/missionGraphIds";
import {
  attachPreparedExternalActionHandoff,
  attachExternalActionDispatchAttemptV1,
  buildOperationReconciliationInputs,
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  formatMissionRuntimeSnapshotBlock,
  normalizeMissionRuntimeSnapshot,
  markExternalActionJobSubmittedV1,
  readMissionRuntimeSnapshotByExternalActionLineageV1,
  reconcileExternalActionDispatchAttemptV1,
  transitionOperationJournalRecord,
} from "../src/agent/runStore";
import type { ToolExecutionContext } from "../src/tools/types";

const T0 = "2026-07-13T12:00:00.000Z";
const T1 = "2026-07-13T12:00:01.000Z";
const T2 = "2026-07-13T12:00:02.000Z";
const T3 = "2026-07-13T12:00:03.000Z";
const EXPIRES = "2026-07-13T12:05:00.000Z";
const AFTER_EXPIRES = "2026-07-13T12:06:00.000Z";
const PRECONDITION = `sha256:${"a".repeat(64)}`;

test("builds a secret-free Linear state handoff from exact graph and consumed authority", async () => {
  const fixture = await createFixture();
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  });

  assert.equal(handoff.operation, "linear_issue_state_update_v1");
  assert.equal(handoff.payload.issueId, "issue-42");
  assert.equal(handoff.payload.stateId, "state-done");
  assert.equal(handoff.preparedActionFingerprint, fixture.preparedAction.payloadFingerprint);
  assert.equal(handoff.authority.authorityFingerprint, fixture.consumedGrant.authorityFingerprint);
  assert.equal(handoff.authority.consumedAt, T2);
  assert.equal(handoff.binding.id, "linear-issue-binding");
  assert.deepEqual(parsePreparedExternalActionHandoffV1(handoff), handoff);
  assert.equal(JSON.stringify(handoff).includes("linear-secret-value"), false);
});

test("binds an ISO timestamp run id to its canonical MissionGraph id", async () => {
  const runId = "run-2026-07-13T09-33-17.390Z-CCD8A4943825";
  const fixture = await createFixture(runId);
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  });

  assert.equal(handoff.missionId, canonicalMissionGraphId(runId));
  assert.equal(
    handoff.preparedActionFingerprint,
    fixture.preparedAction.payloadFingerprint,
  );
});

test("finds exactly one uppercase-run core WAL by canonical mission, job, and handoff", async () => {
  const runId = "run-2026-07-13T09-33-17.390Z-CCD8A4943825";
  const fixture = await createFixture(runId);
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  });
  const jobId = "companion-job-uppercase-run-42";
  let journal = createOperationJournalRecord({
    operationId: fixture.preparedAction.idempotencyKey!,
    rootRunId: runId,
    segmentId: runId,
    nodeId: fixture.nodeId,
    toolName: fixture.descriptor.name,
    operation: "update",
    inputHash: fixture.preparedAction.payloadFingerprint,
    preparedAction: fixture.preparedAction,
    descriptor: fixture.descriptor,
    authorization: {
      preparedActionId: fixture.preparedAction.id,
      payloadFingerprint: fixture.preparedAction.payloadFingerprint,
      grantId: fixture.consumedGrant.id,
    },
    now: new Date(T3),
  });
  journal = await attachPreparedExternalActionHandoff(
    journal,
    handoff,
    new Date(T3),
  );
  journal = attachExternalActionDispatchAttemptV1(
    journal,
    jobId,
    new Date(T3),
  );
  const snapshot = createMissionRuntimeSnapshot({
    runId,
    originalMission: "Update the exact Linear issue in the background.",
    status: "running",
    missionGraphRef: {
      version: 1,
      missionId: fixture.graph.missionId,
      path: `Agent Runs/Mission Graphs/${fixture.graph.missionId}.md`,
      storeRevision: 1,
      graphRevision: fixture.graph.revision,
      recordFingerprint: `sha256:${"f".repeat(64)}`,
      journalHeadFingerprint: fixture.graph.journalHeadFingerprint,
    },
    operationJournal: [journal],
    createdAt: new Date(T3),
  });
  const markdown = `# Agent Run ${runId}\n\n${formatMissionRuntimeSnapshotBlock(snapshot)}`;
  const runtimePath = `Agent Runs/${runId}.md`;
  const runtime = createRuntimeLookupContext(
    new Map([[runtimePath, markdown]]),
  );
  const lookup = {
    missionId: fixture.graph.missionId,
    jobId,
    handoffFingerprint: handoff.fingerprint,
    hostRuntimeRunId: runId,
  };

  const stored = await readMissionRuntimeSnapshotByExternalActionLineageV1(
    runtime.context,
    lookup,
  );
  assert.equal(stored.path, runtimePath);
  assert.equal(stored.snapshot.runId, runId);

  await assert.rejects(
    readMissionRuntimeSnapshotByExternalActionLineageV1(runtime.context, {
      ...lookup,
      jobId: "companion-job-no-match",
    }),
    /persisted host runtime does not match the exact companion mission, job, and handoff lineage/u,
  );

  runtime.files.set("Agent Runs/duplicate-lineage.md", markdown);
  await assert.rejects(
    readMissionRuntimeSnapshotByExternalActionLineageV1(
      runtime.context,
      { ...lookup, hostRuntimeRunId: null },
    ),
    /Multiple core ActionJournals match the exact companion lineage/u,
  );

  runtime.files.delete("Agent Runs/duplicate-lineage.md");
  for (let index = 0; index < 300; index += 1) {
    runtime.files.set(
      `Agent Runs/newer-decoy-${String(index).padStart(3, "0")}.md`,
      `# Decoy ${index}`,
    );
  }
  const olderThanLegacyScanCap =
    await readMissionRuntimeSnapshotByExternalActionLineageV1(
      runtime.context,
      lookup,
    );
  assert.equal(olderThanLegacyScanCap.path, runtimePath);
});

test("rejects payload, grant, descriptor, and graph scope widening", async () => {
  const fixture = await createFixture();
  const base = {
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  };

  const widenedAction = await actionFixture({
    variables: {
      id: "issue-42",
      input: { stateId: "state-done", title: "Unapproved title" },
    },
    changedFields: ["stateId", "title"],
  });
  await assert.rejects(
    buildPreparedLinearIssueStateUpdateHandoffV1({
      ...base,
      preparedAction: widenedAction,
    }),
    (error: unknown) =>
      error instanceof PreparedExternalActionHostErrorV1 &&
      error.code === "invalid_linear_state_update",
  );

  await assert.rejects(
    buildPreparedLinearIssueStateUpdateHandoffV1({
      ...base,
      descriptor: {
        ...fixture.descriptor,
        capability: { ...fixture.descriptor.capability, action: "delete" },
      },
    }),
    (error: unknown) =>
      error instanceof PreparedExternalActionHostErrorV1 &&
      error.code === "invalid_descriptor",
  );

  await assert.rejects(
    buildPreparedLinearIssueStateUpdateHandoffV1({
      ...base,
      consumedGrant: {
        ...fixture.consumedGrant,
        usage: { ...fixture.consumedGrant.usage, actions: 2 },
      },
    }),
    (error: unknown) =>
      error instanceof PreparedExternalActionHostErrorV1 &&
      error.code === "invalid_authority",
  );

  const vaultGraph = structuredClone(fixture.graph);
  vaultGraph.nodes.update.executionHost = "obsidian_core";
  await assert.rejects(
    buildPreparedLinearIssueStateUpdateHandoffV1({ ...base, graph: vaultGraph }),
    /capability envelope|background external-action node|not installed on host/i,
  );

  await assert.rejects(
    buildPreparedLinearIssueStateUpdateHandoffV1({
      ...base,
      credentialReferenceId: "linear-secret-value",
    }),
    PreparedExternalActionHandoffErrorV1,
  );
});

test("closed contract rejects unknown fields and fingerprint drift", async () => {
  const fixture = await createFixture();
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "secret_linear1234",
    now: new Date(T3),
  });

  assert.throws(
    () =>
      parsePreparedExternalActionHandoffV1({
        ...handoff,
        command: "curl https://attacker.invalid",
      }),
    /closed contract/i,
  );
  assert.throws(
    () =>
      parsePreparedExternalActionHandoffV1({
        ...handoff,
        payload: { ...handoff.payload, stateId: "state-attacker" },
      }),
    /fingerprint/i,
  );
});

test("operation journal round-trips the prepared handoff before any dispatch", async () => {
  const fixture = await createFixture();
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  });
  const pendingJournal = createOperationJournalRecord({
    operationId: fixture.preparedAction.idempotencyKey!,
    rootRunId: fixture.preparedAction.runId,
    segmentId: fixture.preparedAction.runId,
    nodeId: "update",
    toolName: "linear_update_issue",
    operation: "update",
    inputHash: fixture.preparedAction.payloadFingerprint,
    preparedAction: fixture.preparedAction,
    descriptor: fixture.descriptor,
    authorization: {
      preparedActionId: fixture.preparedAction.id,
      payloadFingerprint: fixture.preparedAction.payloadFingerprint,
      grantId: fixture.consumedGrant.id,
    },
    now: new Date(T3),
  });
  const journal = await attachPreparedExternalActionHandoff(
    pendingJournal,
    handoff,
    new Date(T3),
  );
  await assert.rejects(
    async () =>
      attachPreparedExternalActionHandoff(
        { ...pendingJournal, nodeId: "different-node" },
        handoff,
      ),
    /does not match/i,
  );
  const restored = normalizeMissionRuntimeSnapshot(
    JSON.parse(
      JSON.stringify(
        createMissionRuntimeSnapshot({
          runId: fixture.preparedAction.runId,
          originalMission: "Move the trusted Linear issue to Done in the background.",
          operationJournal: [journal],
          createdAt: new Date(T3),
        }),
      ),
    ),
  );

  assert.equal(
    restored?.operationJournal[0].preparedExternalActionHandoff?.fingerprint,
    handoff.fingerprint,
  );
  assert.equal(
    buildOperationReconciliationInputs(restored!.operationJournal)[0]
      .preparedExternalActionHandoff?.payload.stateId,
    "state-done",
  );
  assert.equal(
    buildOperationReconciliationInputs(restored!.operationJournal)[0]
      .recommendedAction,
    "safe_to_retry",
  );
});

test("effectful companion commits dispatch before Linear and verifies independent readback", async () => {
  const fixture = await createFixture();
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  });
  const job = await prepareEffectfulJob(fixture.graph, handoff);
  const order: string[] = [];
  const receipts: CompanionReceiptV1[] = [];
  let readCount = 0;
  const executor = createLinearIssueReadbackExecutorV1({
    secretStore: persistentSecretStore("credential_linear1234"),
    now: () => new Date(T3),
    linearReadIssue: async () => {
      readCount += 1;
      order.push("read");
      return issueReadback(
        readCount === 1 ? "state-started" : "state-done",
        readCount === 1 ? PRECONDITION : `sha256:${"e".repeat(64)}`,
      );
    },
    linearUpdateIssueState: async () => {
      order.push("update");
      assert.equal(receipts.some((receipt) => receipt.status === "dispatched"), true);
      return { providerRequestId: null };
    },
  });
  const result = await executor(job, {
    signal: new AbortController().signal,
    now: () => new Date(T3),
    reportProgress: async () => undefined,
    listCommittedReceipts: async () => [...receipts],
    commitReceipt: async (receipt) => {
      order.push(`commit:${receipt.status}`);
      receipts.push(receipt);
      return receipt;
    },
  });

  assert.equal(result.status, "complete");
  assert.deepEqual(order, [
    "read",
    "commit:dispatched",
    "update",
    "read",
    "commit:verified",
  ]);
  assert.equal(result.receipts?.length, 1);
  assert.equal(result.receipts?.[0].status, "verified");
});

test("ambiguous Linear dispatch survives restart and reconciles with zero redispatch", async () => {
  const fixture = await createFixture();
  const handoff = await buildPreparedLinearIssueStateUpdateHandoffV1({
    ...fixture,
    credentialReferenceId: "credential_linear1234",
    now: new Date(T3),
  });
  const job = await prepareEffectfulJob(fixture.graph, handoff);
  const receipts: CompanionReceiptV1[] = [];
  let updates = 0;
  let reads = 0;
  const dependencies = {
    secretStore: persistentSecretStore("credential_linear1234"),
    now: () => new Date(T3),
    linearReadIssue: async () => {
      reads += 1;
      if (reads === 1) return issueReadback("state-started", PRECONDITION);
      if (reads === 2) throw new Error("readback transport lost");
      return issueReadback("state-done", `sha256:${"f".repeat(64)}`);
    },
    linearUpdateIssueState: async () => {
      updates += 1;
      throw new Error("mutation response lost after provider commit");
    },
  };
  const context = {
    signal: new AbortController().signal,
    now: () => new Date(T3),
    reportProgress: async () => undefined,
    listCommittedReceipts: async () => [...receipts],
    commitReceipt: async (receipt: CompanionReceiptV1) => {
      if (!receipts.some((item) => item.fingerprint === receipt.fingerprint)) {
        receipts.push(receipt);
      }
      return receipt;
    },
  };
  const first = await createLinearIssueReadbackExecutorV1(dependencies)(
    job,
    context,
  );
  assert.equal(first.status, "reconcile_required");
  assert.equal(updates, 1);
  assert.deepEqual(
    receipts.map((receipt) => receipt.status),
    ["dispatched", "ambiguous"],
  );

  const second = await new HeadlessMissionWorkerV1({
    executors: {
      linear: createLinearIssueReadbackExecutorV1({
        ...dependencies,
        now: () => new Date(AFTER_EXPIRES),
      }),
    },
    receiptJournal: {
      list: async () => [...receipts],
      commit: async (_activeJob, receipt) => context.commitReceipt(receipt),
    },
    emit: async () => undefined,
    now: () => new Date(AFTER_EXPIRES),
  }).execute({ ...job, attempts: job.attempts + 1 });
  assert.equal(second.status, "complete");
  assert.equal(updates, 1, "reconciliation must never redispatch the mutation");
  assert.equal(receipts.at(-1)?.status, "verified");

  const baseJournal = createOperationJournalRecord({
    operationId: fixture.preparedAction.idempotencyKey!,
    rootRunId: fixture.preparedAction.runId,
    segmentId: fixture.preparedAction.runId,
    nodeId: "update",
    toolName: "linear_update_issue",
    operation: "update",
    inputHash: fixture.preparedAction.payloadFingerprint,
    preparedAction: fixture.preparedAction,
    descriptor: fixture.descriptor,
    authorization: {
      preparedActionId: fixture.preparedAction.id,
      payloadFingerprint: fixture.preparedAction.payloadFingerprint,
      grantId: fixture.consumedGrant.id,
    },
    now: new Date(T3),
  });
  let journal = await attachPreparedExternalActionHandoff(
    baseJournal,
    handoff,
    new Date(T3),
  );
  journal = transitionOperationJournalRecord(journal, "applying", {
    message: "Prepared background dispatch.",
    now: new Date(T3),
  });
  journal = attachExternalActionDispatchAttemptV1(journal, job.id, new Date(T3));
  journal = markExternalActionJobSubmittedV1(journal, new Date(T3));
  const submittedJournal = journal;
  const submittedReconciliation = buildOperationReconciliationInputs([journal]);
  assert.equal(journal.state, "applying");
  assert.equal(journal.mutationMayHaveApplied, true);
  assert.equal(
    journal.externalActionDispatchAttempt?.status,
    "job_submitted",
  );
  assert.equal(submittedReconciliation[0]?.recommendedAction, "provider_reconcile");
  assert.notEqual(submittedReconciliation[0]?.recommendedAction, "safe_to_retry");
  const driftedIssueReceipt = structuredClone(receipts.at(-1)!);
  driftedIssueReceipt.payload.issueId = "issue-attacker";
  assert.throws(
    () =>
      reconcileExternalActionDispatchAttemptV1(
        submittedJournal,
        [receipts[0], driftedIssueReceipt],
        new Date(T3),
      ),
    /payload drifted/u,
  );
  assert.throws(
    () =>
      reconcileExternalActionDispatchAttemptV1(
        submittedJournal,
        [receipts.at(-1)!, receipts[0]],
        new Date(T3),
      ),
    /precedes/u,
  );
  journal = reconcileExternalActionDispatchAttemptV1(
    journal,
    receipts.slice(0, 2),
    new Date(T3),
  );
  assert.equal(journal.state, "ambiguous");
  journal = reconcileExternalActionDispatchAttemptV1(
    journal,
    receipts,
    new Date(T3),
  );
  assert.equal(journal.state, "readback_verified");
  assert.equal(
    journal.externalActionDispatchAttempt?.verifiedReceiptFingerprint,
    receipts.at(-1)?.fingerprint,
  );
  const restored = normalizeMissionRuntimeSnapshot(
    JSON.parse(
      JSON.stringify(
        createMissionRuntimeSnapshot({
          runId: fixture.preparedAction.runId,
          originalMission: "Move the issue in the background.",
          operationJournal: [journal],
          createdAt: new Date(T3),
        }),
      ),
    ),
  );
  assert.equal(
    restored?.operationJournal[0].externalActionDispatchAttempt?.attemptId,
    journal.externalActionDispatchAttempt?.attemptId,
  );
});

async function prepareEffectfulJob(
  graph: MissionGraphV3,
  handoff: Awaited<
    ReturnType<typeof buildPreparedLinearIssueStateUpdateHandoffV1>
  >,
) {
  const authorization = await buildBackgroundAuthorizationV1({
    graph,
    nodeId: "update",
    grantId: "mission-capability-linear-42",
    authorizedAt: T3,
    expiresAt: EXPIRES,
  });
  const prepared = await prepareCompanionJobV1({
    graph,
    nodeId: "update",
    authorization,
    preparedExternalActionHandoff: handoff,
    now: new Date(T3),
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") throw new Error("job preparation failed");
  assert.equal(prepared.job.inputs && Object.keys(prepared.job.inputs).length, 0);
  return prepared.job;
}

function issueReadback(
  stateId: string,
  snapshotFingerprint: string,
): LinearIssueReadbackV1 {
  return {
    id: "issue-42",
    identifier: "PLAT-42",
    title: "Ship effectful continuation",
    updatedAt: T3,
    url: "https://linear.app/example/issue/PLAT-42",
    state: { id: stateId, name: stateId },
    snapshotFingerprint,
  };
}

function persistentSecretStore(referenceId: string): Pick<SecretStoreV1, "health" | "lease"> {
  return {
    health: async () => ({
      version: 1,
      available: true,
      persistent: true,
      backend: "test-keyring",
      backgroundEligible: true,
      blocker: null,
    }),
    lease: async (requestedReferenceId) => {
      assert.equal(requestedReferenceId, referenceId);
      let disposed = false;
      const description = {
        version: 1 as const,
        leaseId: "lease_linear1234",
        referenceId,
        source: "secure_store_lease" as const,
        persistent: true,
        expiresAt: EXPIRES,
      };
      return {
        description,
        get disposed() {
          return disposed;
        },
        async withSecret(use) {
          if (disposed) throw new Error("lease disposed");
          return use("linear-secret-value");
        },
        dispose() {
          disposed = true;
        },
        toJSON() {
          return { redacted: true as const, description };
        },
      };
    },
  };
}

async function createFixture(runId = "mission-linear-42"): Promise<{
  graph: MissionGraphV3;
  nodeId: string;
  preparedAction: PreparedAction;
  descriptor: ToolDescriptor;
  approvedGrant: AuthorityGrantV1;
  consumedGrant: AuthorityGrantV1;
}> {
  const descriptor = descriptorFixture();
  const preparedAction = await actionFixture({ runId });
  const approvedGrant = await createOneShotGrant({
    id: "grant:linear-state-42",
    action: preparedAction,
    descriptor,
    issuedAt: new Date(T1),
    expiresAt: new Date(EXPIRES),
  });
  const consumed = await consumeAuthorityGrant({
    grant: approvedGrant,
    action: preparedAction,
    descriptor,
    now: new Date(T2),
  });
  if (!consumed.allowed) throw new Error(consumed.reason);
  return {
    graph: await graphFixture(canonicalMissionGraphId(runId)),
    nodeId: "update",
    preparedAction,
    descriptor,
    approvedGrant,
    consumedGrant: consumed.grant,
  };
}

async function actionFixture(
  override: {
    variables?: Record<string, unknown>;
    changedFields?: string[];
    runId?: string;
  } = {},
): Promise<PreparedAction> {
  const runId = override.runId ?? "mission-linear-42";
  return withPreparedActionFingerprint({
    version: 1,
    id: "linear-action-state-42",
    runId,
    toolCallId: "tool-call-state-42",
    toolName: "linear_update_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: "issue-42",
      identifier: "PLAT-42",
      teamId: "team-platform",
      projectId: "project-platform",
    },
    relatedResources: [
      { system: "linear", resourceType: "state", id: "state-done" },
    ],
    normalizedArgs: {
      operationKey: "issues.update",
      readbackOperationKey: "issues.get",
      mutationKind: "issue_update",
      variables:
        (override.variables as PreparedAction["normalizedArgs"][string]) ??
        { id: "issue-42", input: { stateId: "state-done" } },
      preconditionHash: PRECONDITION,
      expectedAbsent: false,
      changedFields: override.changedFields ?? ["stateId"],
    },
    preview: {
      summary: "Move PLAT-42 to Done",
      destination: "Linear issue PLAT-42",
      before: { stateId: "state-started" },
      after: { stateId: "state-done" },
      outboundPayload: { id: "issue-42", input: { stateId: "state-done" } },
      warnings: [],
      outboundBytes: 58,
    },
    expectedTargetRevision: PRECONDITION,
    idempotencyKey: `linear:issue:update:${runId}:tool-call-state-42:0`,
    reconciliationKey: `linear:issue:update:${runId}:tool-call-state-42:0`,
    preparedAt: T0,
    expiresAt: EXPIRES,
  });
}

async function graphFixture(
  missionId = "mission-linear-42",
): Promise<MissionGraphV3> {
  const bindingFingerprint = `sha256:${"b".repeat(64)}`;
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: T0,
    expiresAt: EXPIRES,
    capabilities: ["linear.issue.update"],
    executionHosts: ["headless_runtime"],
    executors: {
      "linear-issue-state-update": {
        id: "linear-issue-state-update",
        executionHosts: ["headless_runtime"],
        allowedEffects: ["external_action"],
      },
    },
    verifiers: ["companion-external-result-v1"],
    tools: {
      linear_update_issue: {
        name: "linear_update_issue",
        effect: "external_action",
        capabilityIds: ["linear.issue.update"],
        executionHosts: ["headless_runtime"],
        bindingKinds: ["issue"],
      },
    },
    bindings: {
      "linear-issue-binding": {
        id: "linear-issue-binding",
        kind: "issue",
        destinationFingerprint: bindingFingerprint,
        allowedEffects: ["read", "external_action"],
      },
    },
    budgets: {
      maxNodes: 1,
      maxDepth: 1,
      maxConcurrentReadNodes: 1,
      maxTotalToolCalls: 1,
      maxExternalActions: 1,
      maxWallClockMs: 60_000,
      maxAttemptsPerNode: 3,
    },
  });
  return parseMissionGraphV3({
    schemaVersion: 3,
    missionId,
    objective: "Move the trusted Linear issue to Done.",
    revision: 2,
    journalHeadFingerprint: `sha256:${"c".repeat(64)}`,
    createdAt: T0,
    updatedAt: T2,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: T0,
      decisionFingerprint: `sha256:${"d".repeat(64)}`,
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      update: {
        id: "update",
        dependencyIds: [],
        objective: "Move the exact trusted issue to the approved state.",
        executorId: "linear-issue-state-update",
        executionHost: "headless_runtime",
        effect: "external_action",
        inputs: {
          resource: {
            kind: "binding",
            bindingId: "linear-issue-binding",
            selector: null,
          },
        },
        outputs: {},
        requiredCapabilities: ["linear.issue.update"],
        allowedTools: ["linear_update_issue"],
        destination: {
          bindingId: "linear-issue-binding",
          effect: "external_action",
          selector: "PLAT-42",
        },
        resourceLocks: [
          { bindingId: "linear-issue-binding", mode: "exclusive" },
        ],
        budget: { toolCalls: 1, externalActions: 1, wallClockMs: 60_000 },
        retries: {
          maxAttempts: 3,
          attempts: 1,
          failureFingerprints: [],
          consecutiveFailureFingerprint: null,
          consecutiveFailureCount: 0,
        },
        status: "running",
        evidence: [],
        receipts: [],
        verification: null,
        completionContract: {
          criteria: ["Independent Linear readback verifies the exact state."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["linear_readback"],
          minimumReceipts: 1,
          requiredReceiptKinds: [
            "external:linear:linear_issue_state_update_v1",
          ],
          verifierId: "companion-external-result-v1",
        },
        blocker: null,
      },
    },
  });
}

function descriptorFixture(): ToolDescriptor {
  return {
    version: 1,
    name: "linear_update_issue",
    capability: { system: "linear", resourceType: "issue", action: "update" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: { preparation: "required", cacheable: false, parallelSafe: false },
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

function createRuntimeLookupContext(initialFiles: Map<string, string>): {
  context: ToolExecutionContext;
  files: Map<string, string>;
} {
  const files = new Map(initialFiles);
  const getFileByPath = (path: string) => {
    if (!files.has(path)) return null;
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.md$/iu, ""),
      extension: "md",
      stat: { mtime: 1_000 },
    };
  };
  const context = {
    app: {
      vault: {
        getFolderByPath: (path: string) =>
          path === "Agent Runs" ? { path, name: "Agent Runs" } : null,
        createFolder: async () => undefined,
        getFileByPath,
        getFiles: () =>
          [...files.keys()]
            .map(getFileByPath)
            .filter((file): file is NonNullable<typeof file> => Boolean(file)),
        create: async (path: string, content: string) => {
          files.set(path, content);
        },
        read: async (file: { path: string }) => files.get(file.path) ?? "",
        modify: async (file: { path: string }, content: string) => {
          files.set(file.path, content);
        },
      },
    },
    now: () => new Date(T3),
  } as unknown as ToolExecutionContext;
  return { context, files };
}
