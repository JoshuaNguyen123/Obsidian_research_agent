import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  buildBackgroundAuthorizationV1,
  classifyBackgroundMissionNodeV1,
  CompanionBoundaryErrorV1,
  CompanionCoordinatorClientErrorV1,
  CompanionCoordinatorClientV1,
  clearCompanionBootstrapSessionV1,
  createSessionBootstrapTokenLeaseV1,
  HeadlessMissionWorkerV1,
  installCompanionBootstrapSessionV1,
  normalizeCompanionBaseUrlV1,
  prepareCompanionJobV1,
  resolveCompanionBootstrapSessionV1,
  type BackgroundAuthorizationV1,
  type CompanionEventV1,
  type CompanionJobV1,
  type CompanionReceiptV1,
  type CompanionRemoteJobV1,
  type MissionGraphV3,
  type MissionNodeV3,
} from "../packages/headless-runtime/src";

const NOW = "2026-07-11T23:45:00.000Z";
const BOOTSTRAP_TOKEN = "phase3-bootstrap-token-material-0123456789abcdef";

test("bootstrap credential lease is closure-backed, redacted, expirable, and disposable", async () => {
  const lease = createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN, {
    source: "secure_store_lease",
    persistent: true,
    expiresAt: "2999-01-01T00:00:00.000Z",
  });

  assert.equal(lease.disposed, false);
  assert.equal(
    await lease.withToken(async (token) => token === BOOTSTRAP_TOKEN),
    true,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(lease)), {
    redacted: true,
    description: {
      source: "secure_store_lease",
      persistent: true,
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  });
  assert.equal(JSON.stringify(lease).includes(BOOTSTRAP_TOKEN), false);
  assert.equal(Object.values(lease).includes(BOOTSTRAP_TOKEN), false);

  lease.dispose();
  assert.equal(lease.disposed, true);
  await assert.rejects(
    lease.withToken(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof CompanionBoundaryErrorV1);
      assert.equal(error.code, "credential_unavailable");
      assert.equal(error.message.includes(BOOTSTRAP_TOKEN), false);
      return true;
    },
  );

  const expired = createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN, {
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  await assert.rejects(
    expired.withToken(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof CompanionBoundaryErrorV1);
      assert.equal(error.code, "credential_expired");
      assert.equal(error.message.includes(BOOTSTRAP_TOKEN), false);
      return true;
    },
  );
});

test("companion bootstrap sessions accept only loopback origins and never serialize credentials", async () => {
  assert.equal(
    normalizeCompanionBaseUrlV1("http://127.0.0.1:8765/"),
    "http://127.0.0.1:8765",
  );
  for (const unsafe of [
    "https://companion.example.com",
    "http://user:pass@127.0.0.1:8765",
    "http://127.0.0.1:8765/jobs",
    "http://127.0.0.1:8765?token=secret",
  ]) {
    assert.throws(() => normalizeCompanionBaseUrlV1(unsafe), /loopback origin/u);
  }

  const baseUrl = "http://127.0.0.1:18765";
  clearCompanionBootstrapSessionV1(baseUrl);
  const credential = createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN);
  const disconnect = installCompanionBootstrapSessionV1({
    version: 1,
    baseUrl,
    credential,
    connectedAt: NOW,
  });
  const resolved = resolveCompanionBootstrapSessionV1(`${baseUrl}/`);
  assert.ok(resolved);
  assert.equal(resolved.baseUrl, baseUrl);
  assert.equal(JSON.stringify(resolved).includes(BOOTSTRAP_TOKEN), false);
  assert.equal(Object.keys(globalThis).some((key) => key.includes("companion-bootstrap")), false);

  disconnect();
  assert.equal(credential.disposed, true);
  assert.equal(resolveCompanionBootstrapSessionV1(baseUrl), null);
});

test("coordinator client requires closure-backed auth and redacts authentication failures", async () => {
  let unauthenticatedFetchCalls = 0;
  const unconfigured = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18766",
    fetchImpl: async () => {
      unauthenticatedFetchCalls += 1;
      throw new Error("fetch must not run without a credential");
    },
  });
  await assert.rejects(unconfigured.health(), (error: unknown) => {
    assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
    assert.equal(error.code, "authentication_unconfigured");
    return true;
  });
  assert.equal(unauthenticatedFetchCalls, 0);

  const credential = createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN);
  let capturedAuthorization = "";
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18766",
    credential,
    fetchImpl: async (_input, init) => {
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({ error: `Bearer ${BOOTSTRAP_TOKEN} was rejected` }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  await assert.rejects(client.health(), (error: unknown) => {
    assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
    assert.equal(error.code, "authentication_failed");
    assert.equal(error.status, 401);
    assert.equal(error.message, "Companion authentication failed.");
    assert.equal(error.message.includes(BOOTSTRAP_TOKEN), false);
    return true;
  });
  assert.equal(capturedAuthorization, `Bearer ${BOOTSTRAP_TOKEN}`);
  assert.equal(JSON.stringify(client).includes(BOOTSTRAP_TOKEN), false);
});

test("coordinator claim lease is single-use opaque state and request errors cannot echo it", async () => {
  const remoteJob = createRemoteJob();
  const leaseToken = "lease-token-material-that-must-never-leak-0123456789";
  let claimCount = 0;
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18767",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    fetchImpl: async (input, init) => {
      const url = String(input);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${BOOTSTRAP_TOKEN}`,
      );
      if (!url.endsWith(`/jobs/${remoteJob.id}/claim`)) {
        return new Response("not found", { status: 404 });
      }
      claimCount += 1;
      if (claimCount === 1) {
        return jsonResponse({ job: remoteJob, leaseToken });
      }
      return new Response(
        JSON.stringify({ error: `secret=${leaseToken}` }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const claimed = await client.claim({
    jobId: remoteJob.id,
    coordinatorId: "coordinator-a",
  });
  assert.equal(claimed.job.id, remoteJob.id);
  assert.equal(JSON.stringify(claimed.lease).includes(leaseToken), false);
  assert.deepEqual(JSON.parse(JSON.stringify(claimed.lease)), {
    redacted: true,
    description: {
      jobId: remoteJob.id,
      coordinatorId: "coordinator-a",
      expiresAt: remoteJob.leaseExpiresAt,
    },
  });

  await assert.rejects(
    client.claim({ jobId: remoteJob.id, coordinatorId: "coordinator-b" }),
    (error: unknown) => {
      assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
      assert.equal(error.code, "request_failed");
      assert.equal(error.status, 409);
      assert.equal(error.message.includes(leaseToken), false);
      return true;
    },
  );
  assert.equal(claimCount, 2);

  claimed.lease.dispose();
  await assert.rejects(
    claimed.lease.withLeaseToken(async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
      assert.equal(error.code, "authentication_unconfigured");
      return true;
    },
  );
});

test("coordinator replay maps persisted service events and enforces a monotonic reconnect cursor", async () => {
  const remoteJob = createRemoteJob();
  const replayRequests: number[] = [];
  const records = [
    remoteEvent(1, remoteJob.id, "job_queued"),
    remoteEvent(2, remoteJob.id, "lease_acquired"),
    remoteEvent(3, remoteJob.id, "external_receipt_recorded"),
    remoteEvent(4, remoteJob.id, "job_complete"),
  ];
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18768",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/jobs/${remoteJob.id}`) {
        return jsonResponse(remoteJob);
      }
      if (url.pathname === `/jobs/${remoteJob.id}/events`) {
        const after = Number(url.searchParams.get("after") ?? "0");
        replayRequests.push(after);
        return sseResponse(records.filter((record) => record.sequence > after));
      }
      return new Response("not found", { status: 404 });
    },
  });

  const initial = await client.replayEvents({
    jobId: remoteJob.id,
    afterSequence: 0,
  });
  assert.deepEqual(
    initial.map((event) => [event.sequence, event.type]),
    [
      [1, "job_accepted"],
      [2, "job_leased"],
      [3, "receipt_committed"],
      [4, "job_completed"],
    ],
  );
  assert.deepEqual(
    initial.map((event) => event.payload.rawEventType),
    ["job_queued", "lease_acquired", "external_receipt_recorded", "job_complete"],
  );

  const afterRestart = await client.replayEvents({
    jobId: remoteJob.id,
    afterSequence: 2,
  });
  assert.deepEqual(
    afterRestart.map((event) => event.sequence),
    [3, 4],
  );
  assert.deepEqual(replayRequests, [0, 2]);

  const regressingClient = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18769",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/events")
        ? sseResponse([
            remoteEvent(3, remoteJob.id, "external_receipt_recorded"),
            remoteEvent(3, remoteJob.id, "job_complete"),
          ])
        : jsonResponse(remoteJob);
    },
  });
  await assert.rejects(
    regressingClient.replayEvents({ jobId: remoteJob.id, afterSequence: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
      assert.equal(error.code, "event_sequence_regression");
      return true;
    },
  );
});

test("coordinator follows typed sparse replay boundaries without truncating the tail", async () => {
  const remote = createRemoteJob();
  const requestedAfter: string[] = [];
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18769",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/events")) return jsonResponse(remote);
      const after = url.searchParams.get("after") ?? "";
      requestedAfter.push(after);
      return after === "0"
        ? sseRaw([
            sseEvent(remoteEvent(501, remote.id, "progress")),
            sseBoundary(501, "event_limit"),
          ])
        : sseRaw([sseEvent(remoteEvent(1_001, remote.id, "job_complete"))]);
    },
  });

  const events = await client.replayEvents({ jobId: remote.id });
  assert.deepEqual(events.map((event) => event.sequence), [501, 1_001]);
  assert.deepEqual(requestedAfter, ["0", "501"]);
});

test("coordinator timeout remains active while JSON and finite SSE bodies are stalled", async () => {
  let jsonAborted = false;
  const jsonClient = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18770",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    timeoutMs: 250,
    fetchImpl: async (_input, init) =>
      new Response(stalledBody(init?.signal, () => { jsonAborted = true; })),
  });
  const jsonStarted = Date.now();
  await assert.rejects(jsonClient.health(), /body aborted/u);
  assert.equal(jsonAborted, true);
  assert.ok(Date.now() - jsonStarted < 1_500);

  const remote = createRemoteJob();
  let sseAborted = false;
  const sseClient = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18771",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    timeoutMs: 250,
    fetchImpl: async (input, init) =>
      String(input).includes("/events?")
        ? new Response(stalledBody(init?.signal, () => { sseAborted = true; }), {
            headers: { "Content-Type": "text/event-stream" },
          })
        : jsonResponse(remote),
  });
  const sseStarted = Date.now();
  await assert.rejects(sseClient.replayEvents({ jobId: remote.id }), /body aborted/u);
  assert.equal(sseAborted, true);
  assert.ok(Date.now() - sseStarted < 1_500);
});

test("coordinator rejects an oversized SSE frame before parsing it", async () => {
  const remote = createRemoteJob();
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18772",
    credential: createSessionBootstrapTokenLeaseV1(BOOTSTRAP_TOKEN),
    maxResponseBytes: 1_024,
    fetchImpl: async (input) =>
      String(input).includes("/events?")
        ? new Response(`data: ${"x".repeat(2_048)}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          })
        : jsonResponse(remote),
  });
  await assert.rejects(client.replayEvents({ jobId: remote.id }), (error: unknown) => {
    assert.ok(error instanceof CompanionCoordinatorClientErrorV1);
    assert.equal(error.code, "response_too_large");
    return true;
  });
});

test("background classification keeps vault work in waiting_obsidian and accepts authorized research", async () => {
  const graph = await createGraph();
  const researchAuthorization = await authorizationFor(graph, "research");

  assert.deepEqual(classifyBackgroundMissionNodeV1(graph, "research"), {
    disposition: "background",
    domain: "research",
    reason:
      "Already-authorized research work may continue through the local companion.",
  });
  assert.equal(
    classifyBackgroundMissionNodeV1(graph, "vault-write").disposition,
    "waiting_obsidian",
  );
  assert.equal(
    classifyBackgroundMissionNodeV1(graph, "vault-input-injection").disposition,
    "waiting_obsidian",
    "vault-shaped literal inputs must not cross the companion boundary",
  );

  const vaultPrepared = await prepareCompanionJobV1({
    graph,
    nodeId: "vault-write",
    authorization: authorization(),
    now: new Date(NOW),
  });
  assert.equal(vaultPrepared.status, "waiting_obsidian");

  const injectedPrepared = await prepareCompanionJobV1({
    graph,
    nodeId: "vault-input-injection",
    authorization: authorization(),
    now: new Date(NOW),
  });
  assert.equal(injectedPrepared.status, "waiting_obsidian");

  const first = await prepareCompanionJobV1({
    graph,
    nodeId: "research",
    authorization: researchAuthorization,
    now: new Date(NOW),
  });
  const second = await prepareCompanionJobV1({
    graph,
    nodeId: "research",
    authorization: researchAuthorization,
    now: new Date(NOW),
  });
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  if (first.status !== "ready" || second.status !== "ready") {
    throw new Error("Expected the research job to be ready.");
  }
  assert.equal(first.job.id, second.job.id);
  assert.equal(first.job.idempotencyKey, second.job.idempotencyKey);
  assert.equal(first.job.capabilityEnvelopeFingerprint, graph.capabilityEnvelope.fingerprint);
  assert.deepEqual(first.job.inputs, { query: "verified local research" });
  assert.equal(JSON.stringify(first.job).includes(BOOTSTRAP_TOKEN), false);
  assert.equal(JSON.stringify(first.job).includes("Secrets.md"), false);
});

test("background preparation requires current exact host authorization and an untampered envelope", async () => {
  const graph = await createGraph();
  const validAuthorization = await authorizationFor(graph, "research");

  await assert.rejects(
    prepareCompanionJobV1({
      graph,
      nodeId: "research",
      authorization: undefined as never,
      now: new Date(NOW),
    }),
    (error: unknown) => {
      assert.equal(String(error).includes(BOOTSTRAP_TOKEN), false);
      return true;
    },
  );

  await assert.rejects(
    prepareCompanionJobV1({
      graph,
      nodeId: "research",
      authorization: await authorizationFor(
        graph,
        "research",
        "2026-07-11T23:44:59.999Z",
      ),
      now: new Date(NOW),
    }),
    (error: unknown) => {
      assert.ok(error instanceof CompanionBoundaryErrorV1);
      assert.equal(error.code, "authorization_expired");
      return true;
    },
  );

  const tampered = structuredClone(graph);
  tampered.capabilityEnvelope.fingerprint = fp("f");
  await assert.rejects(
    prepareCompanionJobV1({
      graph: tampered,
      nodeId: "research",
      authorization: validAuthorization,
      now: new Date(NOW),
    }),
    (error: unknown) => {
      assert.equal(String(error).includes(BOOTSTRAP_TOKEN), false);
      return true;
    },
  );
});

test("headless worker continues authorized external work with monotonic replay events and no vault executor", async () => {
  const graph = await createGraph();
  const prepared = await prepareCompanionJobV1({
    graph,
    nodeId: "research",
    authorization: await authorizationFor(graph, "research"),
    now: new Date(NOW),
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") {
    throw new Error("Expected the research job to be ready.");
  }

  const events: CompanionEventV1[] = [];
  let researchCalls = 0;
  let vaultCalls = 0;
  const receipt = createReceipt(prepared.job);
  const worker = new HeadlessMissionWorkerV1({
    initialSequence: 40,
    now: () => new Date(NOW),
    emit: async (event) => {
      events.push(event);
    },
    executors: {
      research: async (job, context) => {
        researchCalls += 1;
        assert.equal(job.id, prepared.job.id);
        await context.reportProgress("source fetch survived the core disconnect");
        return {
          status: "complete",
          outputs: { answer: "verified" },
          evidence: ["source:primary"],
          receipts: [receipt],
        };
      },
    },
  });

  const vaultPrepared = await prepareCompanionJobV1({
    graph,
    nodeId: "vault-write",
    authorization: authorization(),
    now: new Date(NOW),
  });
  if (vaultPrepared.status === "ready") {
    vaultCalls += 1;
    await worker.execute(vaultPrepared.job);
  }
  const result = await worker.execute(prepared.job);

  assert.equal(result.status, "complete");
  assert.equal(researchCalls, 1);
  assert.equal(vaultCalls, 0);
  assert.deepEqual(
    events.map((event) => event.sequence),
    [41, 42, 43],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["job_started", "job_progress", "job_completed"],
  );
  assert.ok(events.every((event) => event.jobId === prepared.job.id));
  assert.equal(JSON.stringify(events).includes(BOOTSTRAP_TOKEN), false);
});

test("headless worker redacts bearer credentials from executor failures", async () => {
  const graph = await createGraph();
  const prepared = await prepareCompanionJobV1({
    graph,
    nodeId: "research",
    authorization: await authorizationFor(graph, "research"),
    now: new Date(NOW),
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") {
    throw new Error("Expected the research job to be ready.");
  }

  const events: CompanionEventV1[] = [];
  const worker = new HeadlessMissionWorkerV1({
    now: () => new Date(NOW),
    emit: async (event) => {
      events.push(event);
    },
    executors: {
      research: async () => {
        throw new Error(`remote rejected Bearer ${BOOTSTRAP_TOKEN}`);
      },
    },
  });

  const result = await worker.execute(prepared.job);
  assert.equal(result.status, "failed");
  assert.match(result.blocker?.message ?? "", /Bearer \[REDACTED\]/u);
  assert.equal(JSON.stringify(result).includes(BOOTSTRAP_TOKEN), false);
  assert.equal(JSON.stringify(events).includes(BOOTSTRAP_TOKEN), false);
});

async function createGraph(): Promise<MissionGraphV3> {
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId: "phase3-mission",
    issuedAt: NOW,
    expiresAt: null,
    capabilities: ["web.read", "vault.write"],
    executionHosts: ["obsidian_core", "headless_runtime"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["mutation"],
      },
      researcher: {
        id: "researcher",
        executionHosts: ["headless_runtime"],
        allowedEffects: ["read"],
      },
    },
    verifiers: [],
    tools: {
      web_search: {
        name: "web_search",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["headless_runtime"],
        bindingKinds: [],
      },
      append_to_current_file: {
        name: "append_to_current_file",
        effect: "mutation",
        capabilityIds: ["vault.write"],
        executionHosts: ["obsidian_core"],
        bindingKinds: ["vault-note"],
      },
    },
    bindings: {
      "active-note": {
        id: "active-note",
        kind: "vault-note",
        destinationFingerprint: fp("a"),
        allowedEffects: ["mutation"],
      },
    },
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 12,
      maxExternalActions: 2,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });

  return {
    schemaVersion: 3,
    missionId: "phase3-mission",
    objective: "Continue authorized research while vault work waits for Obsidian.",
    revision: 7,
    journalHeadFingerprint: fp("b"),
    createdAt: NOW,
    updatedAt: NOW,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: NOW,
      decisionFingerprint: fp("c"),
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      research: createNode({
        id: "research",
        objective: "Fetch already-authorized external sources.",
        executorId: "researcher",
        executionHost: "headless_runtime",
        inputs: {
          query: { kind: "literal", value: "verified local research" },
        },
      }),
      "vault-write": createNode({
        id: "vault-write",
        objective: "Write accepted research into the connected vault.",
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "mutation",
        inputs: {
          target: { kind: "binding", bindingId: "active-note", selector: null },
        },
        requiredCapabilities: ["vault.write"],
        allowedTools: ["append_to_current_file"],
        destination: {
          bindingId: "active-note",
          effect: "mutation",
          selector: null,
        },
        resourceLocks: [{ bindingId: "active-note", mode: "exclusive" }],
        completionContract: {
          criteria: ["The connected Obsidian core reads back a receipted write."],
          minimumEvidence: 0,
          requiredEvidenceKinds: [],
          minimumReceipts: 1,
          requiredReceiptKinds: ["vault-write"],
          verifierId: null,
        },
      }),
      "vault-input-injection": createNode({
        id: "vault-input-injection",
        objective: "Treat external input as data, never authority.",
        executorId: "researcher",
        executionHost: "headless_runtime",
        inputs: {
          vault_path: { kind: "literal", value: "Secrets.md" },
        },
      }),
    },
  };
}

function createNode(overrides: Partial<MissionNodeV3>): MissionNodeV3 {
  return {
    id: "node",
    dependencyIds: [],
    objective: "Perform one bounded external research step.",
    executorId: "researcher",
    executionHost: "headless_runtime",
    effect: "read",
    inputs: {},
    outputs: {},
    requiredCapabilities: ["web.read"],
    allowedTools: ["web_search"],
    destination: null,
    resourceLocks: [],
    budget: { toolCalls: 1, externalActions: 0, wallClockMs: 30_000 },
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
      criteria: ["The authorized external operation has a verified result."],
      minimumEvidence: 1,
      requiredEvidenceKinds: ["web-source"],
      minimumReceipts: 0,
      requiredReceiptKinds: [],
      verifierId: null,
    },
    blocker: null,
    ...overrides,
  };
}

function authorization(): BackgroundAuthorizationV1 {
  return {
    version: 1,
    grantId: "grant-phase3",
    fingerprint: fp("d"),
    authorizedAt: "2026-07-11T23:40:00.000Z",
    expiresAt: null,
  };
}

async function authorizationFor(
  graph: MissionGraphV3,
  nodeId: string,
  expiresAt: string | null = null,
): Promise<BackgroundAuthorizationV1> {
  return buildBackgroundAuthorizationV1({
    graph,
    nodeId,
    grantId: "grant-phase3",
    authorizedAt: "2026-07-11T23:40:00.000Z",
    expiresAt,
  });
}

function createReceipt(job: CompanionJobV1): CompanionReceiptV1 {
  return {
    version: 1,
    id: "receipt-phase3-research",
    jobId: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    provider: "research",
    operation: "fetch_verified_sources",
    status: "verified",
    fingerprint: fp("e"),
    payload: { sourceCount: 2 },
    committedAt: NOW,
  };
}

function createRemoteJob(): CompanionRemoteJobV1 {
  return {
    id: "companion-remote-phase3",
    missionId: "phase3-mission",
    nodeId: "research",
    executionHost: "research",
    state: "running",
    payload: { query: "verified local research" },
    capabilityEnvelope: { fingerprint: fp("1") },
    idempotencyKey: fp("2"),
    ownerCoordinatorId: "coordinator-a",
    leaseExpiresAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function remoteEvent(
  sequence: number,
  jobId: string,
  type: string,
): {
  sequence: number;
  jobId: string;
  type: string;
  payload: Record<string, string | number>;
  createdAt: string;
} {
  return {
    sequence,
    jobId,
    type,
    payload: { observedSequence: sequence },
    createdAt: NOW,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(records: ReturnType<typeof remoteEvent>[]): Response {
  const body = records
    .map(
      (record) =>
        `id: ${record.sequence}\nevent: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`,
    )
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseEvent(record: ReturnType<typeof remoteEvent>): string {
  return `id: ${record.sequence}\nevent: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`;
}

function sseBoundary(
  afterSequence: number,
  reason: "event_limit" | "time_limit",
): string {
  return `id: ${afterSequence}\nevent: replay_boundary\ndata: ${JSON.stringify({ afterSequence, complete: false, reason })}\n\n`;
}

function sseRaw(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function stalledBody(
  signal: AbortSignal | null | undefined,
  onAbort: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          controller.error(new Error("body aborted by timeout"));
        },
        { once: true },
      );
    },
  });
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
