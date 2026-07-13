import assert from "node:assert/strict";
import test from "node:test";

import {
  companionResultFingerprintV1,
  createSessionBootstrapTokenLeaseV1,
  type CompanionJobV1,
  type CompanionRemoteJobV1,
} from "../packages/headless-runtime/src";
import {
  CompanionExtensionCoordinatorV1,
  type CompanionRuntimeStateV1,
} from "../extensions/companion/CompanionExtensionCoordinator";

const NOW = "2026-07-13T18:00:00.000Z";
const EXPIRES = "2026-07-13T22:00:00.000Z";
const JOB_ID = "companion-linear-terminal-readback";
const CONFIGURATION_FINGERPRINT = fp("a");
const CANDIDATE_FINGERPRINT = fp("b");
const WORK_ITEM_FINGERPRINT = fp("c");
const READBACK_FINGERPRINT = fp("d");

for (const terminalState of ["blocked", "failed", "cancelled"] as const) {
  test(`terminal ${terminalState} queue readback advances the durable event cursor exactly once`, async () => {
    const remote = await terminalRemoteJob(terminalState);
    let durableState: CompanionRuntimeStateV1 | null = null;
    const requestedAfter: number[] = [];
    const first = coordinatorWithQueueFetch(
      remote,
      requestedAfter,
      () => [candidateEvent()],
    );
    first.configurePersistence({
      load: async () => null,
      save: async (state) => {
        durableState = structuredClone(state);
      },
    });
    await first.hydratePersistence();

    const reconciled = await first.reconcileLinearQueue();
    assert.equal(reconciled.events.length, 1);
    assert.equal(reconciled.readbacks.length, 1);
    assert.equal(reconciled.readbacks[0].state, terminalState);
    assert.equal(
      reconciled.readbacks[0].terminalCode,
      `linear_queue_${terminalState}`,
    );
    assert.equal(reconciled.readbacks[0].verifiedReceiptFingerprint, null);
    assert.equal(
      first.getRuntimeState().linearQueueLastObservedEventSequence,
      1,
    );
    assert.equal(first.getRuntimeState().linearQueueLastAppliedEventSequence, 0);

    await first.acknowledgeAppliedLinearQueueEvents(1);
    assert.equal(first.getRuntimeState().linearQueueLastAppliedEventSequence, 1);
    assert.ok(durableState);
    first.clearSession();

    const resumed = coordinatorWithQueueFetch(
      remote,
      requestedAfter,
      () => [],
    );
    resumed.configurePersistence({
      load: async () => durableState,
      save: async (state) => {
        durableState = structuredClone(state);
      },
    });
    await resumed.hydratePersistence();
    const afterRestart = await resumed.reconcileLinearQueue();
    assert.deepEqual(afterRestart.events, []);
    assert.deepEqual(afterRestart.readbacks, []);
    assert.equal(
      resumed.getRuntimeState().linearQueueLastAppliedEventSequence,
      1,
    );
    assert.deepEqual(requestedAfter, [0, 1]);
    resumed.clearSession();
  });
}

test("terminal rescan request contains only the exact configuration fingerprint and fixed reason", async () => {
  const remote = await terminalRemoteJob("blocked");
  const observedBodies: Record<string, unknown>[] = [];
  const coordinator = coordinatorWithQueueFetch(remote, [], () => [], (body) => {
    observedBodies.push(body);
  });
  await coordinator.requestLinearQueueRescan(CONFIGURATION_FINGERPRINT);
  const observedBody = observedBodies[0];
  assert.ok(observedBody);
  assert.deepEqual({
    configurationFingerprint: observedBody.configurationFingerprint,
    reason: observedBody.reason,
  }, {
    configurationFingerprint: CONFIGURATION_FINGERPRINT,
    reason: "terminal_readback",
  });
  assert.equal("issueId" in (observedBody ?? {}), false);
  assert.equal("description" in (observedBody ?? {}), false);
  coordinator.clearSession();
});

function coordinatorWithQueueFetch(
  remote: CompanionRemoteJobV1,
  requestedAfter: number[],
  events: () => ReturnType<typeof candidateEvent>[],
  onRescan?: (body: Record<string, unknown>) => void,
): CompanionExtensionCoordinatorV1 {
  const coordinator = new CompanionExtensionCoordinatorV1();
  coordinator.configureSession({
    baseUrl: "http://127.0.0.1:18801",
    credential: createSessionBootstrapTokenLeaseV1(
      "bootstrap-linear-reconcile-0123456789abcdef",
    ),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/linear-queue/status") {
        return json(queueStatus());
      }
      if (url.pathname === "/linear-queue/events") {
        requestedAfter.push(Number(url.searchParams.get("after")));
        return json({ events: events() });
      }
      if (url.pathname === "/linear-queue/rescan") {
        onRescan?.(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(queueStatus());
      }
      if (url.pathname === `/jobs/${JOB_ID}`) {
        return json(remote);
      }
      if (url.pathname === `/jobs/${JOB_ID}/receipts`) {
        return json({ receipts: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return coordinator;
}

async function terminalRemoteJob(
  state: "blocked" | "failed" | "cancelled",
): Promise<CompanionRemoteJobV1> {
  const projected = queueJob();
  const proof = {
    status: state,
    outputs: {},
    evidence: [],
    receiptIds: [],
    blocker: {
      code: `linear_queue_${state}`,
      message: "The fixed issue readback ended without completion proof.",
      requiredAction: null,
    },
  };
  return {
    id: projected.id,
    missionId: projected.missionId,
    nodeId: projected.nodeId,
    executionHost: "linear",
    state,
    payload: {
      version: projected.version,
      graphRevision: projected.graphRevision,
      objective: projected.objective,
      executionHost: projected.executionHost,
      inputs: projected.inputs,
      allowedTools: projected.allowedTools,
      requiredCapabilities: projected.requiredCapabilities,
      bindings: projected.bindings.map((binding) => ({
        id: binding.id,
        kind: binding.kind,
        destinationFingerprint: binding.destinationFingerprint,
      })),
      authorization: {
        version: projected.authorization.version,
        grantId: projected.authorization.grantId,
        fingerprint: projected.authorization.fingerprint,
        authorizedAt: projected.authorization.authorizedAt,
        expiresAt: projected.authorization.expiresAt,
      },
      preparedExternalActionHandoff: null,
      createdAt: projected.createdAt,
      updatedAt: projected.updatedAt,
    },
    capabilityEnvelope: {
      fingerprint: projected.capabilityEnvelopeFingerprint,
      authorizationFingerprint: projected.authorization.fingerprint,
    },
    idempotencyKey: projected.idempotencyKey,
    ownerCoordinatorId: null,
    leaseExpiresAt: null,
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
    output: {
      ...proof,
      resultFingerprint: await companionResultFingerprintV1(projected, proof),
    },
  };
}

function queueJob(): CompanionJobV1 {
  return {
    version: 1,
    id: JOB_ID,
    missionId: "linear-queue-configuration",
    nodeId: "linear-queue-candidate",
    graphRevision: 0,
    domain: "linear",
    executionHost: "headless_runtime",
    state: "queued",
    objective: "Read back one fingerprinted trusted-project issue.",
    inputs: {
      issueId: "issue-linear-1",
      credentialReferenceId: "secret_linearqueue123",
      projectBindingId: "project-linear",
      contractFingerprint: WORK_ITEM_FINGERPRINT,
      queueCandidateFingerprint: CANDIDATE_FINGERPRINT,
    },
    allowedTools: ["linear_get_issue"],
    requiredCapabilities: ["linear.issue.read"],
    bindings: [
      {
        id: "project-linear",
        kind: "linear-project",
        destinationFingerprint: fp("e"),
      },
    ],
    capabilityEnvelopeFingerprint: fp("f"),
    authorization: {
      version: 1,
      grantId: "linear-queue-grant",
      fingerprint: fp("9"),
      authorizedAt: NOW,
      expiresAt: EXPIRES,
    },
    idempotencyKey: fp("8"),
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function candidateEvent() {
  return {
    sequence: 1,
    type: "linear_queue_candidate_scheduled" as const,
    payload: {
      configurationFingerprint: CONFIGURATION_FINGERPRINT,
      queueProjectId: "project-linear",
      issueId: "issue-linear-1",
      identifier: "LIN-1",
      candidateFingerprint: CANDIDATE_FINGERPRINT,
      workItemFingerprint: WORK_ITEM_FINGERPRINT,
      readbackFingerprint: READBACK_FINGERPRINT,
      jobId: JOB_ID,
    },
    createdAt: NOW,
  };
}

function queueStatus() {
  return {
    enabled: true,
    configurationFingerprint: CONFIGURATION_FINGERPRINT,
    queueProjectId: "project-linear",
    authorityExpiresAt: EXPIRES,
    cursor: { updatedAt: NOW, issueId: "issue-linear-1" },
    nextScanAt: EXPIRES,
    lastScanStartedAt: NOW,
    lastScanCompletedAt: NOW,
    lastErrorCode: null,
    candidateCount: 1,
    scheduledReadbackCount: 1,
    latestEventSequence: 1,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
