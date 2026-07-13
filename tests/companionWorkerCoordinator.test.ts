import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompanionReceiptV1,
  CompanionCoordinatorClientV1,
  CompanionWorkerCoordinatorV1,
  companionResultFingerprintV1,
  createSessionBootstrapTokenLeaseV1,
  type CompanionJobV1,
  type CompanionRemoteJobV1,
  type HeadlessDomainExecutorV1,
} from "../packages/headless-runtime/src";

const NOW = "2026-07-12T18:00:00.000Z";
const TOKEN = "worker-bootstrap-token-0123456789abcdef";
const LEASE = "worker-lease-token-0123456789abcdef";

test("worker claims an expired lease, heartbeats, executes, persists proof, and completes", async () => {
  const fixture = createCoordinatorFixture();
  const executor: HeadlessDomainExecutorV1 = async (job, context) => {
    await context.reportProgress("real executor is still running");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    return {
      status: "complete",
      outputs: { answer: "verified" },
      evidence: [{ kind: "public_web_source", fingerprint: fp("e") }],
      receipts: [
        await buildCompanionReceiptV1({
          job,
          id: "worker-receipt",
          provider: "research",
          operation: "public_research_fetch",
          status: "verified",
          payload: { sourceCount: 1 },
          committedAt: NOW,
        }),
      ],
    };
  };
  const worker = new CompanionWorkerCoordinatorV1({
    client: fixture.client,
    coordinatorId: "agentic-researcher-service-worker",
    catalogFingerprint: fp("c"),
    executorCatalog: { research: executor },
    heartbeatIntervalMs: 1_000,
    workerHeartbeatIntervalMs: 250,
    leaseSeconds: 5,
    now: () => new Date(NOW),
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    inspected: 1,
    claimed: 1,
    completed: 1,
    blocked: 0,
    failed: 0,
  });
  assert.ok(fixture.workerHeartbeats >= 5, "worker readiness must stay live during execution");
  assert.ok(fixture.leaseHeartbeats >= 1, "long execution must renew its job lease");
  assert.deepEqual(fixture.eventTypes, ["job_started", "job_progress"]);
  assert.equal(fixture.receipts.length, 1);
  assert.equal(fixture.completions.length, 1);
  const completion = fixture.completions[0];
  assert.equal(completion.state, "complete");
  const { resultFingerprint, ...proof } = completion.output;
  assert.equal(
    resultFingerprint,
    await companionResultFingerprintV1(fixture.job, proof as never),
  );
  assert.ok(fixture.leaseBodies.every((body) => body.leaseToken === LEASE));
  assert.equal(JSON.stringify(fixture).includes(TOKEN), false);
});

test("worker failure completion uses the canonical job-bound result fingerprint", async () => {
  const fixture = createCoordinatorFixture();
  const worker = new CompanionWorkerCoordinatorV1({
    client: fixture.client,
    coordinatorId: "agentic-researcher-service-worker",
    catalogFingerprint: fp("c"),
    executorCatalog: {
      research: async () => {
        throw new Error("executor failed");
      },
    },
    now: () => new Date(NOW),
  });

  const result = await worker.runOnce();
  assert.equal(result.failed, 1);
  assert.equal(fixture.completions.length, 1);
  const completion = fixture.completions[0];
  assert.equal(completion.state, "failed");
  const { resultFingerprint, ...proof } = completion.output;
  assert.equal(
    resultFingerprint,
    await companionResultFingerprintV1(fixture.job, proof as never),
  );
  assert.equal(
    (proof.blocker as { code?: string } | null)?.code,
    "executor_failed",
  );
});

function createCoordinatorFixture() {
  const job = createJob();
  const remote = remoteFromJob(job, {
    state: "running",
    ownerCoordinatorId: "dead-worker",
    leaseExpiresAt: "2026-07-12T17:59:59.000Z",
  });
  let sequence = 0;
  let workerHeartbeats = 0;
  let leaseHeartbeats = 0;
  const eventTypes: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  const completions: Array<{
    state: string;
    output: Record<string, unknown>;
  }> = [];
  const leaseBodies: Array<Record<string, unknown>> = [];
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18780",
    credential: createSessionBootstrapTokenLeaseV1(TOKEN),
    fetchImpl: async (input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.pathname === "/health") return json(health());
      if (url.pathname === "/jobs" && init?.method === "GET") {
        assert.deepEqual(url.searchParams.getAll("state"), ["queued", "running"]);
        return json({ jobs: [remote] });
      }
      if (url.pathname === "/worker/heartbeat") {
        workerHeartbeats += 1;
        return json({ ok: true, workerReady: true, expiresAt: "2026-07-12T18:01:00.000Z" });
      }
      if (url.pathname.endsWith("/claim")) {
        assert.equal(body.coordinatorId, "agentic-researcher-service-worker");
        return json({
          job: { ...remote, state: "running", ownerCoordinatorId: body.coordinatorId },
          leaseToken: LEASE,
        });
      }
      if (url.pathname.endsWith("/heartbeat")) {
        leaseHeartbeats += 1;
        leaseBodies.push(body);
        return json(remote);
      }
      if (url.pathname.endsWith("/events")) {
        leaseBodies.push(body);
        eventTypes.push(String(body.type));
        sequence += 1;
        return json({
          sequence,
          jobId: job.id,
          type: body.type,
          payload: body.payload ?? {},
          createdAt: NOW,
        });
      }
      if (url.pathname.endsWith("/receipts")) {
        leaseBodies.push(body);
        receipts.push(body);
        return json({
          id: "persisted-worker-receipt",
          jobId: job.id,
          provider: body.provider,
          operation: body.operation,
          status: body.status,
          fingerprint: body.fingerprint,
          payload: body.payload,
          createdAt: NOW,
        });
      }
      if (url.pathname.endsWith("/complete")) {
        leaseBodies.push(body);
        completions.push({
          state: String(body.state),
          output: body.output as Record<string, unknown>,
        });
        return json({ ...remote, state: body.state, output: body.output, updatedAt: NOW });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    job,
    client,
    eventTypes,
    receipts,
    completions,
    leaseBodies,
    get workerHeartbeats() { return workerHeartbeats; },
    get leaseHeartbeats() { return leaseHeartbeats; },
  };
}

function createJob(): CompanionJobV1 {
  return {
    version: 1,
    id: "worker-job-v1",
    missionId: "worker-mission-v1",
    nodeId: "research-node",
    graphRevision: 3,
    domain: "research",
    executionHost: "headless_runtime",
    state: "queued",
    objective: "Fetch one already-authorized public source.",
    inputs: { url: "https://example.com/source" },
    allowedTools: ["web_fetch"],
    requiredCapabilities: ["web.read"],
    bindings: [],
    capabilityEnvelopeFingerprint: fp("a"),
    authorization: {
      version: 1,
      grantId: "worker-grant",
      fingerprint: fp("b"),
      authorizedAt: NOW,
      expiresAt: null,
    },
    idempotencyKey: fp("d"),
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function remoteFromJob(
  job: CompanionJobV1,
  overrides: Partial<CompanionRemoteJobV1> = {},
): CompanionRemoteJobV1 {
  return {
    id: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    executionHost: job.domain,
    state: job.state,
    payload: {
      version: job.version,
      graphRevision: job.graphRevision,
      objective: job.objective,
      executionHost: job.executionHost,
      inputs: job.inputs,
      allowedTools: job.allowedTools,
      requiredCapabilities: job.requiredCapabilities,
      bindings: job.bindings as never,
      authorization: job.authorization as never,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    capabilityEnvelope: {
      fingerprint: job.capabilityEnvelopeFingerprint,
      authorizationFingerprint: job.authorization.fingerprint,
    },
    idempotencyKey: job.idempotencyKey,
    ownerCoordinatorId: null,
    leaseExpiresAt: null,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...overrides,
  };
}

function health() {
  return {
    ok: true,
    service: "agentic-researcher-companion",
    browserReady: false,
    memoryReady: false,
    coordinatorReady: true,
    workerReady: true,
    workerDiagnostic: null,
    secureStorePersistent: true,
    backgroundEnabled: true,
    backgroundBlocker: null,
    version: "1",
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
