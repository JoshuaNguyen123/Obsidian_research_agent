import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackgroundAuthorizationV1,
  buildMissionCapabilityEnvelopeV1,
  createSessionBootstrapTokenLeaseV1,
  prepareCompanionJobV1,
  type CompanionRemoteJobV1,
  type MissionGraphV3,
} from "../packages/headless-runtime/src";
import {
  createHostApprovalReceiptEvidenceV1,
  createPreparedExternalActionHandoffV1,
  sealHostApprovalReceiptV1,
} from "../packages/core-api/src";
import {
  CompanionExtensionCoordinatorV1,
  type CompanionRuntimeStateV1,
} from "../extensions/companion/CompanionExtensionCoordinator";

const NOW = "2026-07-12T18:00:00.000Z";
const JOB_ID = "persisted-companion-job";
const EFFECTFUL_NOW = "2026-07-13T18:00:00.000Z";
const EFFECTFUL_EXPIRES = "2026-07-13T18:30:00.000Z";

test("coordinator exposes authenticated host approval signer readback without key material", async () => {
  const signingKeyFingerprint = fp("f");
  const evidence = createHostApprovalReceiptEvidenceV1({
    id: "coordinator-approval-1",
    preparedActionId: "coordinator-action-1",
    preparedActionFingerprint: fp("a"),
    confirmationOrdinal: 1,
    requiredConfirmations: 1,
    decision: "approved",
    hostInstanceFingerprint: signingKeyFingerprint,
    actorFingerprint: fp("b"),
    sessionFingerprint: fp("c"),
    decidedAt: NOW,
  });
  const receipt = sealHostApprovalReceiptV1(evidence, {
    signingKeyFingerprint,
    authenticator: "a".repeat(43),
  });
  const paths: string[] = [];
  const coordinator = new CompanionExtensionCoordinatorV1();
  coordinator.configureSession({
    baseUrl: "http://127.0.0.1:18784",
    credential: createSessionBootstrapTokenLeaseV1(
      "coordinator-signer-token-0123456789abcdef",
    ),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const authorization = new Headers(init?.headers).get("authorization");
      assert.match(authorization ?? "", /^Bearer /u);
      assert.equal(String(init?.body ?? "").includes("coordinator-signer-token"), false);
      if (url.pathname === "/host-approval-signer") {
        return json({
          version: 1,
          kind: "host_approval_signer",
          persistent: true,
          provisioned: true,
          backend: "fake-os-keyring",
          signingKeyFingerprint,
        });
      }
      if (url.pathname === "/host-approval-signer/sign") return json(receipt);
      if (url.pathname === "/host-approval-signer/verify") {
        return json({
          version: 1,
          verified: true,
          reason: "verified",
          signingKeyFingerprint,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  assert.equal(
    (await coordinator.describeHostApprovalSigner()).signingKeyFingerprint,
    signingKeyFingerprint,
  );
  assert.equal(
    (await coordinator.sealHostApprovalReceipt(evidence)).fingerprint,
    receipt.fingerprint,
  );
  assert.equal(
    (await coordinator.verifyHostApprovalReceipt(receipt)).verified,
    true,
  );
  assert.deepEqual(paths, [
    "GET /host-approval-signer",
    "POST /host-approval-signer/sign",
    "POST /host-approval-signer/verify",
  ]);
  coordinator.clearSession();
});

test("observed and applied cursors survive a failed save and replay idempotently", async () => {
  const initial = stateFixture();
  const successfulSaves: CompanionRuntimeStateV1[] = [];
  let saveAttempts = 0;
  const requestedAfter: number[] = [];
  const coordinator = new CompanionExtensionCoordinatorV1();
  coordinator.configurePersistence({
    load: async () => initial,
    save: async (state) => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("simulated durable store failure");
      successfulSaves.push(structuredClone(state));
    },
  });
  await coordinator.hydratePersistence();
  coordinator.configureSession({
    baseUrl: "http://127.0.0.1:18785",
    credential: createSessionBootstrapTokenLeaseV1(
      "extension-persistence-token-0123456789abcdef",
    ),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/events")) return json(remoteJob());
      requestedAfter.push(Number(url.searchParams.get("after")));
      return sse([event(501), event(1_001)]);
    },
  });

  await assert.rejects(
    coordinator.replayEvents(JOB_ID, 100),
    /simulated durable store failure/u,
  );
  let lineage = coordinator.getRuntimeState().jobs[JOB_ID];
  assert.equal(lineage.lastObservedEventSequence, 1_001);
  assert.equal(lineage.lastAppliedEventSequence, 100);

  const replayed = await coordinator.replayEvents(
    JOB_ID,
    lineage.lastAppliedEventSequence,
  );
  assert.deepEqual(replayed.map((item) => item.sequence), [501, 1_001]);
  lineage = coordinator.getRuntimeState().jobs[JOB_ID];
  assert.equal(lineage.lastObservedEventSequence, 1_001);
  assert.equal(lineage.lastAppliedEventSequence, 100);

  await coordinator.acknowledgeAppliedEvents(JOB_ID, 1_001);
  lineage = coordinator.getRuntimeState().jobs[JOB_ID];
  assert.equal(lineage.lastObservedEventSequence, 1_001);
  assert.equal(lineage.lastAppliedEventSequence, 1_001);
  assert.deepEqual(requestedAfter, [100, 100]);
  assert.equal(saveAttempts, 3);
  assert.equal(successfulSaves.at(-1)?.jobs[JOB_ID].lastAppliedEventSequence, 1_001);
  coordinator.clearSession();
});

test("a failed applied-cursor save rolls back in memory and retries durably", async () => {
  const initial = stateFixture();
  initial.jobs[JOB_ID].lastObservedEventSequence = 900;
  initial.jobs[JOB_ID].lastAppliedEventSequence = 100;
  let saveAttempts = 0;
  let durableState = structuredClone(initial);
  const coordinator = new CompanionExtensionCoordinatorV1();
  coordinator.configurePersistence({
    load: async () => initial,
    save: async (state) => {
      saveAttempts += 1;
      if (saveAttempts === 1) {
        throw new Error("simulated applied-cursor save failure");
      }
      durableState = structuredClone(state);
    },
  });
  await coordinator.hydratePersistence();

  await assert.rejects(
    coordinator.acknowledgeAppliedEvents(JOB_ID, 900),
    /simulated applied-cursor save failure/u,
  );
  assert.equal(
    coordinator.getRuntimeState().jobs[JOB_ID].lastAppliedEventSequence,
    100,
  );
  assert.equal(durableState.jobs[JOB_ID].lastAppliedEventSequence, 100);

  await coordinator.acknowledgeAppliedEvents(JOB_ID, 900);
  assert.equal(
    coordinator.getRuntimeState().jobs[JOB_ID].lastAppliedEventSequence,
    900,
  );
  assert.equal(durableState.jobs[JOB_ID].lastAppliedEventSequence, 900);
  assert.equal(saveAttempts, 2);
  coordinator.clearSession();
});

test("a crash after the prepared lineage WAL but before POST safely creates the same deterministic job once", async () => {
  const fixture = await effectfulFixture();
  let durableState: CompanionRuntimeStateV1 | null = null;
  let postCalls = 0;
  const remoteJobs = new Map<string, CompanionRemoteJobV1>();
  const first = new CompanionExtensionCoordinatorV1();
  first.configurePersistence({
    load: async () => null,
    save: async (state) => {
      // The write reached durable storage, then the process died before the
      // promise could acknowledge it. POST /jobs must still be untouched.
      durableState = structuredClone(state);
      throw new Error("simulated crash after lineage WAL");
    },
  });
  first.configureSession({
    baseUrl: "http://127.0.0.1:18786",
    credential: effectfulCredential(),
    fetchImpl: effectfulFetch(remoteJobs, () => {
      postCalls += 1;
    }),
  });
  await assert.rejects(
    first.submitAuthorizedNode(fixture),
    /simulated crash after lineage WAL/u,
  );
  assert.equal(postCalls, 0, "no POST may precede the persisted lineage WAL");
  assert.ok(durableState);
  assert.equal(
    (durableState as CompanionRuntimeStateV1).jobs[fixture.expectedJobId]?.state,
    "prepared",
  );
  assert.equal(
    (durableState as CompanionRuntimeStateV1).jobs[fixture.expectedJobId]
      ?.hostRuntimeRunId,
    fixture.hostRuntimeRunId,
  );

  const resumed = new CompanionExtensionCoordinatorV1();
  resumed.configurePersistence({
    load: async () => durableState,
    save: async (state) => {
      durableState = structuredClone(state);
    },
  });
  await resumed.hydratePersistence();
  resumed.configureSession({
    baseUrl: "http://127.0.0.1:18786",
    credential: effectfulCredential(),
    fetchImpl: effectfulFetch(remoteJobs, () => {
      postCalls += 1;
    }),
  });
  const result = await resumed.submitAuthorizedNode(fixture);
  assert.equal(result.status, "submitted");
  assert.equal(postCalls, 1);
  assert.equal(remoteJobs.size, 1);
  assert.equal(
    resumed.getRuntimeState().jobs[fixture.expectedJobId].state,
    "queued",
  );
  assert.equal(
    resumed.getRuntimeState().jobs[fixture.expectedJobId].hostRuntimeRunId,
    fixture.hostRuntimeRunId,
  );
  resumed.clearSession();
  first.clearSession();
});

test("a crash after remote commit but before lineage readback is adopted without another POST", async () => {
  const fixture = await effectfulFixture();
  let durableState: CompanionRuntimeStateV1 | null = null;
  let saveCalls = 0;
  let postCalls = 0;
  const remoteJobs = new Map<string, CompanionRemoteJobV1>();
  const first = new CompanionExtensionCoordinatorV1();
  first.configurePersistence({
    load: async () => null,
    save: async (state) => {
      saveCalls += 1;
      if (saveCalls === 1) {
        durableState = structuredClone(state);
        return;
      }
      throw new Error("simulated crash before remote lineage readback save");
    },
  });
  first.configureSession({
    baseUrl: "http://127.0.0.1:18787",
    credential: effectfulCredential(),
    fetchImpl: effectfulFetch(remoteJobs, () => {
      postCalls += 1;
    }),
  });
  await assert.rejects(
    first.submitAuthorizedNode(fixture),
    /simulated crash before remote lineage readback save/u,
  );
  assert.equal(postCalls, 1);
  assert.ok(durableState);
  assert.equal(
    (durableState as CompanionRuntimeStateV1).jobs[fixture.expectedJobId]?.state,
    "prepared",
  );
  const committed = remoteJobs.get(fixture.expectedJobId)!;
  remoteJobs.set(fixture.expectedJobId, {
    ...committed,
    state: "complete",
    output: {},
    updatedAt: "2026-07-13T18:00:03.000Z",
  });

  const resumed = new CompanionExtensionCoordinatorV1();
  resumed.configurePersistence({
    load: async () => durableState,
    save: async (state) => {
      durableState = structuredClone(state);
    },
  });
  await resumed.hydratePersistence();
  resumed.configureSession({
    baseUrl: "http://127.0.0.1:18787",
    credential: effectfulCredential(),
    fetchImpl: effectfulFetch(remoteJobs, () => {
      postCalls += 1;
    }),
  });
  const reconciled = await resumed.reconcilePersistedJobs();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].job.state, "complete");
  assert.equal(postCalls, 1, "readback adoption must never POST the job again");
  assert.equal(
    resumed.getRuntimeState().jobs[fixture.expectedJobId].reconcileStatus,
    "reconciled",
  );
  resumed.clearSession();
  first.clearSession();
});

test("failed worker preflight creates neither core attempt callback nor extension lineage", async () => {
  const fixture = await effectfulFixture();
  const coordinator = new CompanionExtensionCoordinatorV1();
  let beforeSubmitCalls = 0;
  let postCalls = 0;
  const baseFetch = effectfulFetch(new Map(), () => {
    postCalls += 1;
  });
  coordinator.configureSession({
    baseUrl: "http://127.0.0.1:18788",
    credential: effectfulCredential(),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        return json({
          ...healthyCompanion(),
          workerReady: false,
          workerDiagnostic: "worker has not polled",
        });
      }
      return baseFetch(input, init);
    }) as typeof fetch,
  });
  const result = await coordinator.submitAuthorizedNode({
    ...fixture,
    beforeSubmit: async () => {
      beforeSubmitCalls += 1;
    },
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.equal(result.code, "background_worker_unavailable");
  }
  assert.equal(beforeSubmitCalls, 0);
  assert.equal(postCalls, 0);
  assert.deepEqual(coordinator.getRuntimeState().jobs, {});
  coordinator.clearSession();
});

function stateFixture(): CompanionRuntimeStateV1 {
  return {
    version: 1,
    serviceInstalled: true,
    baseUrl: "http://127.0.0.1:18785",
    linearQueueLastObservedEventSequence: 0,
    linearQueueLastAppliedEventSequence: 0,
    jobs: {
      [JOB_ID]: {
        version: 1,
        jobId: JOB_ID,
        missionId: "persisted-mission",
        nodeId: "research",
        graphRevision: 4,
        idempotencyKey: fp("a"),
        capabilityEnvelopeFingerprint: fp("b"),
        authorizationFingerprint: fp("c"),
        hostRuntimeRunId: null,
        state: "running",
        lastObservedEventSequence: 900,
        lastAppliedEventSequence: 100,
        receiptFingerprints: [],
        resultFingerprint: null,
        reconcileStatus: "pending",
        reconcileError: null,
        updatedAt: NOW,
      },
    },
  };
}

function remoteJob() {
  return {
    id: JOB_ID,
    missionId: "persisted-mission",
    nodeId: "research",
    executionHost: "research",
    state: "running",
    payload: {},
    capabilityEnvelope: {},
    idempotencyKey: fp("a"),
    ownerCoordinatorId: "worker",
    leaseExpiresAt: null,
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function event(sequence: number) {
  return {
    sequence,
    jobId: JOB_ID,
    type: "progress",
    payload: { observedSequence: sequence },
    createdAt: NOW,
  };
}

function sse(records: ReturnType<typeof event>[]): Response {
  return new Response(
    records
      .map(
        (record) =>
          `id: ${record.sequence}\nevent: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

async function effectfulFixture() {
  const graph = await effectfulGraph();
  const preparedExternalActionHandoff =
    createPreparedExternalActionHandoffV1({
      id: "handoff-effectful-persistence",
      missionId: graph.missionId,
      graphRevision: graph.revision,
      capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
      nodeId: "update",
      nodeFingerprint: fp("1"),
      executionHost: "headless_runtime",
      toolName: "linear_update_issue",
      descriptorFingerprint: fp("2"),
      preparedActionId: "prepared-effectful-persistence",
      preparedActionFingerprint: fp("3"),
      binding: {
        id: "linear-issue-binding",
        kind: "issue",
        destinationFingerprint: fp("4"),
      },
      authority: {
        id: "grant-effectful-persistence",
        authorityFingerprint: fp("5"),
        actionFingerprint: fp("3"),
        consumedAt: EFFECTFUL_NOW,
        expiresAt: EFFECTFUL_EXPIRES,
      },
      payload: {
        issueId: "issue-42",
        stateId: "state-done",
        preconditionFingerprint: fp("6"),
        credentialReferenceId: "credential_linear1234",
      },
      idempotencyKey: "linear:state:effectful-persistence",
      reconciliationKey: "linear:state:effectful-persistence",
      preparedAt: EFFECTFUL_NOW,
      expiresAt: EFFECTFUL_EXPIRES,
    });
  const authorization = await buildBackgroundAuthorizationV1({
    graph,
    nodeId: "update",
    grantId: "grant-effectful-persistence",
    authorizedAt: EFFECTFUL_NOW,
    expiresAt: EFFECTFUL_EXPIRES,
  });
  const prepared = await prepareCompanionJobV1({
    graph,
    nodeId: "update",
    authorization,
    preparedExternalActionHandoff,
    now: new Date(EFFECTFUL_NOW),
  });
  if (prepared.status !== "ready") {
    throw new Error(`Effectful companion fixture did not prepare: ${prepared.status}.`);
  }
  return {
    graph,
    nodeId: "update",
    authorization,
    hostRuntimeRunId: "run-2026-07-13T18-00-00.000Z-EFFECTFUL42",
    preparedExternalActionHandoff,
    now: new Date(EFFECTFUL_NOW),
    expectedJobId: prepared.job.id,
  };
}

async function effectfulGraph(): Promise<MissionGraphV3> {
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId: "effectful-persistence-mission",
    issuedAt: EFFECTFUL_NOW,
    expiresAt: EFFECTFUL_EXPIRES,
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
        destinationFingerprint: fp("4"),
        allowedEffects: ["external_action"],
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
  return {
    schemaVersion: 3,
    missionId: "effectful-persistence-mission",
    objective: "Move one trusted Linear issue in the background.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt: EFFECTFUL_NOW,
    updatedAt: EFFECTFUL_NOW,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: EFFECTFUL_NOW,
      decisionFingerprint: fp("7"),
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      update: {
        id: "update",
        dependencyIds: [],
        objective: "Apply the exact approved Linear state update.",
        executorId: "linear-issue-state-update",
        executionHost: "headless_runtime",
        effect: "external_action",
        inputs: {},
        outputs: {},
        requiredCapabilities: ["linear.issue.update"],
        allowedTools: ["linear_update_issue"],
        destination: {
          bindingId: "linear-issue-binding",
          effect: "external_action",
          selector: null,
        },
        resourceLocks: [
          { bindingId: "linear-issue-binding", mode: "exclusive" },
        ],
        budget: { toolCalls: 1, externalActions: 1, wallClockMs: 60_000 },
        retries: {
          maxAttempts: 3,
          attempts: 0,
          failureFingerprints: [],
          consecutiveFailureFingerprint: null,
          consecutiveFailureCount: 0,
        },
        status: "ready",
        evidence: [],
        receipts: [],
        verification: null,
        completionContract: {
          criteria: ["Independent Linear readback verifies the target state."],
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
  };
}

function effectfulCredential() {
  return createSessionBootstrapTokenLeaseV1(
    "effectful-extension-persistence-token-0123456789abcdef",
  );
}

function effectfulFetch(
  jobs: Map<string, CompanionRemoteJobV1>,
  onPost: () => void,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/health") return json(healthyCompanion());
    if (url.pathname.endsWith("/events")) {
      return new Response("", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (url.pathname.endsWith("/receipts")) return json({ receipts: [] });
    if (url.pathname === "/jobs" && init?.method === "POST") {
      onPost();
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const remote: CompanionRemoteJobV1 = {
        id: String(body.id),
        missionId: String(body.missionId),
        nodeId: String(body.nodeId),
        executionHost: String(body.executionHost) as "linear",
        state: "queued",
        payload: body.payload as CompanionRemoteJobV1["payload"],
        capabilityEnvelope:
          body.capabilityEnvelope as CompanionRemoteJobV1["capabilityEnvelope"],
        idempotencyKey: String(body.idempotencyKey),
        ownerCoordinatorId: null,
        leaseExpiresAt: null,
        attempts: 0,
        createdAt: EFFECTFUL_NOW,
        updatedAt: EFFECTFUL_NOW,
      };
      jobs.set(remote.id, remote);
      return json(remote);
    }
    const jobId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    const remote = jobs.get(jobId);
    return remote
      ? json(remote)
      : new Response(JSON.stringify({ detail: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
  }) as typeof fetch;
}

function healthyCompanion() {
  return {
    ok: true,
    host: "127.0.0.1",
    port: 18786,
    loopbackOnly: true,
    authRequired: true,
    bodyLimitBytes: 1_048_576,
    coordinatorReady: true,
    workerReady: true,
    workerDiagnostic: null,
    installedExecutorDomains: ["linear"],
    executorCatalogVersion: 1,
    secureStorePersistent: true,
    backgroundEnabled: true,
    backgroundBlocker: null,
    version: "test",
  };
}
