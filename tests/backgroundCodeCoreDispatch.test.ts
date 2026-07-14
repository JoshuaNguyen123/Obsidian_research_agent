import assert from "node:assert/strict";
import test from "node:test";

import {
  createPreparedBackgroundCodeActionV1,
} from "../packages/core-api/src/preparedBackgroundCodeActionV1";
import {
  createPreparedBackgroundCodePackageIdentityV1,
} from "../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import {
  createPreparedBackgroundCodeToolContributionV1,
} from "../extensions/code/background/PreparedBackgroundCodeContributionsV1";
import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  attachBackgroundCodeDispatchAttemptV1,
  attachPreparedBackgroundCodeHandoffV1,
  buildOperationReconciliationInputs,
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  formatMissionRuntimeSnapshotBlock,
  isBackgroundCodeCommitProofVerifiedV1,
  markBackgroundCodeJobSubmittedV1,
  parseMissionRuntimeSnapshotFromMarkdown,
  reconcileBackgroundCodeDispatchAttemptV1,
  transitionOperationJournalRecord,
} from "../src/agent/runStore";

const NOW = "2026-07-13T12:00:00.000Z";
const EXPIRES = "2026-07-13T12:10:00.000Z";
const JOB_ID = "companion-0123456789abcdef0123456789abcdef";
const COMMIT_SHA = "b".repeat(40);

test("prepared background Code descriptor has no foreground preparation or execution fallback", async () => {
  const contribution = createPreparedBackgroundCodeToolContributionV1();
  assert.deepEqual(contribution.tool.parameters.required, ["repairCheckpointId"]);
  assert.deepEqual(Object.keys(contribution.tool.parameters.properties ?? {}), [
    "repairCheckpointId",
  ]);
  const prepared = await contribution.tool.prepare?.({}, {} as never);
  assert.equal(prepared?.ok, false);
  if (prepared?.ok === false) {
    assert.equal(
      prepared.error.code,
      "prepared_background_code_host_package_required",
    );
  }
  await assert.rejects(
    contribution.tool.executePrepared?.({} as never, {} as never) ??
      Promise.resolve(),
    /no foreground executePrepared fallback/iu,
  );
});

test("prepared background Code contribution forwards only checkpoint and scoped mission identities", async () => {
  const observed: unknown[] = [];
  const contribution = createPreparedBackgroundCodeToolContributionV1({
    async prepareBackgroundValidationCommitApproval(input) {
      observed.push(input);
      return {
        status: "ready",
        preparedAction: { id: "prepared-action" } as never,
      };
    },
  });
  const context = {
    missionId: "run-background-code-1",
    operationId: "tool-call-1",
  } as never;
  const prepared = await contribution.tool.prepare?.(
    { repairCheckpointId: "code-repair:run-background-code-1:workspace-1:request-1" },
    context,
  );
  assert.equal(prepared?.ok, true);
  assert.deepEqual(observed, [{
    repairCheckpointId: "code-repair:run-background-code-1:workspace-1:request-1",
    runId: "run-background-code-1",
    toolCallId: "tool-call-1",
  }]);

  const injected = await contribution.tool.prepare?.(
    {
      repairCheckpointId: "code-repair:run-background-code-1:workspace-1:request-1",
      command: "powershell -c whoami",
    },
    context,
  );
  assert.equal(injected?.ok, false);
  assert.equal(observed.length, 1);
});

test("Code ActionJournal requires exact package lineage and verified commit readback", async () => {
  const descriptor = backgroundCodeDescriptor();
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "prepared-background-code-1",
    runId: "run-background-code-1",
    toolCallId: "call-background-code-1",
    toolName: descriptor.name,
    target: {
      system: "git",
      resourceType: "prepared_validation_commit",
      id: "checkpoint-1",
      workspaceId: "workspace-1",
      repositoryProfileId: "profile-1",
    },
    relatedResources: [],
    normalizedArgs: {
      checkpointId: "checkpoint-1",
      diffFingerprint: fp("1"),
      fastValidationFingerprint: fp("2"),
    },
    preview: {
      summary: "Validate the exact approved diff and create one local commit",
      destination: "Trusted workspace workspace-1",
      before: { baseSha: "a".repeat(40) },
      after: { diffFingerprint: fp("1") },
      warnings: ["Execution remains sandbox-only."],
      outboundBytes: 0,
    },
    idempotencyKey: "background-code:checkpoint-1",
    reconciliationKey: "background-code:checkpoint-1",
    preparedAt: NOW,
    expiresAt: EXPIRES,
  });
  const descriptorFingerprint = await sha256Fingerprint(descriptor);
  const handoff = createPreparedBackgroundCodeActionV1({
    id: "background-code-handoff-1",
    missionId: "mission-background-code-1",
    graphRevision: 3,
    capabilityEnvelopeFingerprint: fp("3"),
    nodeId: "code-node",
    nodeFingerprint: fp("4"),
    executionHost: "headless_runtime",
    descriptorFingerprint,
    preparedActionId: action.id,
    preparedActionFingerprint: action.payloadFingerprint,
    binding: {
      workspaceId: "workspace-1",
      repositoryProfileKey: "profile-1",
      destinationFingerprint: fp("5"),
    },
    authority: {
      id: "grant-background-code-1",
      authorityFingerprint: fp("6"),
      actionFingerprint: action.payloadFingerprint,
      consumedAt: NOW,
      expiresAt: EXPIRES,
    },
    payload: {
      repairCheckpointId: "checkpoint-1",
      repairRequestFingerprint: fp("7"),
      preparedCheckpointSequence: 4,
      workspaceBindingFingerprint: fp("8"),
      repositoryProfileFingerprint: fp("9"),
      sandboxCapabilityFingerprint: fp("a"),
    },
    idempotencyKey: "background-code:checkpoint-1",
    reconciliationKey: "background-code:checkpoint-1",
    preparedAt: NOW,
    expiresAt: EXPIRES,
  });
  const packageIdentity = createPreparedBackgroundCodePackageIdentityV1({
    packageId: "package-background-code-1",
    packageFingerprint: fp("b"),
    executionPlanFingerprint: fp("c"),
    handoffFingerprint: handoff.fingerprint,
    workspaceId: handoff.binding.workspaceId,
    workspaceBindingFingerprint: handoff.payload.workspaceBindingFingerprint,
    repositoryProfileKey: handoff.binding.repositoryProfileKey,
    repositoryProfileFingerprint: handoff.payload.repositoryProfileFingerprint,
    consumedActionAuthorityFingerprint: handoff.authority.authorityFingerprint,
    backgroundAuthorizationFingerprint: fp("d"),
    preparedAt: NOW,
    expiresAt: EXPIRES,
  });
  let journal = createOperationJournalRecord({
    operationId: "operation-background-code-1",
    rootRunId: action.runId,
    segmentId: action.runId,
    nodeId: handoff.nodeId,
    toolName: descriptor.name,
    operation: "commit",
    preparedAction: action,
    descriptor,
    authorization: {
      preparedActionId: action.id,
      payloadFingerprint: action.payloadFingerprint,
      grantId: handoff.authority.id,
    },
    now: new Date(NOW),
  });
  journal = transitionOperationJournalRecord(journal, "applying", {
    message: "WAL persisted before companion dispatch.",
    now: new Date(NOW),
  });
  journal = await attachPreparedBackgroundCodeHandoffV1(
    journal,
    handoff,
    packageIdentity,
    new Date(NOW),
  );
  journal = attachBackgroundCodeDispatchAttemptV1(
    journal,
    JOB_ID,
    new Date(NOW),
  );
  journal = markBackgroundCodeJobSubmittedV1(journal, new Date(NOW));

  assert.equal(journal.state, "applying");
  assert.equal(journal.mutationMayHaveApplied, true);
  assert.equal(
    buildOperationReconciliationInputs([journal])[0]?.recommendedAction,
    "provider_reconcile",
  );

  const attemptId = journal.backgroundCodeDispatchAttempt!.attemptId;
  const dispatched = receipt("dispatched", fp("e"), {
    attemptId,
    handoffFingerprint: handoff.fingerprint,
    repairCheckpointId: handoff.payload.repairCheckpointId,
    checkpointSequence: 4,
    repairRequestFingerprint: handoff.payload.repairRequestFingerprint,
  }, NOW);
  journal = reconcileBackgroundCodeDispatchAttemptV1(
    journal,
    [dispatched],
    new Date("2026-07-13T12:00:01.000Z"),
  );
  assert.equal(journal.state, "dispatched");

  const ambiguous = receipt("ambiguous", fp("f"), {
    attemptId,
    handoffFingerprint: handoff.fingerprint,
    repairCheckpointId: handoff.payload.repairCheckpointId,
    checkpointSequence: 5,
    failureFingerprint: fp("0"),
  }, "2026-07-13T12:00:02.000Z");
  journal = reconcileBackgroundCodeDispatchAttemptV1(
    journal,
    [dispatched, ambiguous],
    new Date("2026-07-13T12:00:02.000Z"),
  );
  assert.equal(journal.state, "ambiguous");

  const verifiedCommitFingerprint = fp("1");
  const verified = receipt("verified", fp("2"), {
    attemptId,
    handoffFingerprint: handoff.fingerprint,
    repairCheckpointId: handoff.payload.repairCheckpointId,
    checkpointSequence: 6,
    verifiedCommitReceiptFingerprint: verifiedCommitFingerprint,
    commitSha: COMMIT_SHA,
    workspaceBindingFingerprint: handoff.payload.workspaceBindingFingerprint,
    repositoryProfileFingerprint: handoff.payload.repositoryProfileFingerprint,
    sandboxCapabilityFingerprint: handoff.payload.sandboxCapabilityFingerprint,
  }, "2026-07-13T12:00:03.000Z");
  journal = reconcileBackgroundCodeDispatchAttemptV1(
    journal,
    [dispatched, ambiguous, verified],
    new Date("2026-07-13T12:00:03.000Z"),
  );

  assert.equal(journal.state, "readback_verified");
  assert.equal(
    isBackgroundCodeCommitProofVerifiedV1(journal, {
      jobId: JOB_ID,
      handoffFingerprint: handoff.fingerprint,
      packageIdentityFingerprint: packageIdentity.fingerprint,
      verifiedReceiptFingerprint: verified.fingerprint,
      verifiedCommitReceiptFingerprint: verifiedCommitFingerprint,
      commitSha: COMMIT_SHA,
    }),
    true,
  );
  const snapshot = createMissionRuntimeSnapshot({
    runId: action.runId,
    originalMission: "Continue the exact Code checkpoint in the background.",
    operationJournal: [journal],
    createdAt: new Date(NOW),
    updatedAt: new Date("2026-07-13T12:00:03.000Z"),
  });
  const restored = parseMissionRuntimeSnapshotFromMarkdown(
    `# Agent Run\n\n${formatMissionRuntimeSnapshotBlock(snapshot)}`,
  );
  const restoredJournal = restored?.operationJournal[0];
  assert.equal(
    restoredJournal?.preparedBackgroundCodePackage?.fingerprint,
    packageIdentity.fingerprint,
  );
  assert.equal(
    restoredJournal?.backgroundCodeDispatchAttempt?.commitSha,
    COMMIT_SHA,
  );
  assert.equal(
    isBackgroundCodeCommitProofVerifiedV1(restoredJournal!, {
      jobId: JOB_ID,
      handoffFingerprint: handoff.fingerprint,
      packageIdentityFingerprint: packageIdentity.fingerprint,
      verifiedReceiptFingerprint: verified.fingerprint,
      verifiedCommitReceiptFingerprint: verifiedCommitFingerprint,
      commitSha: COMMIT_SHA,
    }),
    true,
  );
  assert.throws(
    () => reconcileBackgroundCodeDispatchAttemptV1(journal, [
      { ...verified, payload: { ...verified.payload, commitSha: "c".repeat(40) } },
    ]),
    /missing a durable dispatch|does not prove|drifted/iu,
  );
});

function backgroundCodeDescriptor(): ToolDescriptor {
  return {
    version: 1,
    name: "code_validate_commit_prepared",
    capability: {
      system: "git",
      resourceType: "prepared_validation_commit",
      action: "commit",
    },
    effect: "execution",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      desktopOnly: true,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    receiptKind: "code_change",
  };
}

function receipt(
  status: "dispatched" | "ambiguous" | "verified",
  fingerprint: string,
  payload: Record<string, unknown>,
  committedAt: string,
) {
  return {
    id: `receipt-${status}`,
    provider: "code",
    operation: "prepared_code_validation_commit_v1",
    status,
    fingerprint,
    payload,
    committedAt,
  } as const;
}

function fp(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}
