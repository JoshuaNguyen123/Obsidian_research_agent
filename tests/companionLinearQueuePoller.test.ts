import assert from "node:assert/strict";
import test from "node:test";

import {
  CompanionCoordinatorClientV1,
  CompanionLinearQueuePollerV1,
  CompanionWorkerCoordinatorV1,
  createCompanionLinearQueueCandidateObservationV1,
  createCompanionLinearQueueConfigurationV1,
  createSecretLeaseV1,
  createSessionBootstrapTokenLeaseV1,
  type CompanionLinearQueueConfigurationV1,
  type CompanionLinearQueueScanLeaseV1,
} from "../packages/headless-runtime/src";
import type { SecretStoreHealthV1 } from "../packages/core-api/src";

const NOW = "2026-07-13T18:00:00.000Z";
const EXPIRES = "2026-07-13T22:00:00.000Z";
const CREDENTIAL_REFERENCE = "secret_linearqueue123";
const CREDENTIAL = "linear-credential-that-must-never-serialize";

test("companion poller leases only the opaque credential and commits fingerprint observations", async () => {
  const configuration = await queueConfiguration();
  const observation = await createCompanionLinearQueueCandidateObservationV1({
    issueId: "issue-linear-1",
    identifier: "LIN-1",
    queueProjectId: configuration.queueProjectId,
    remoteStateId: "state-triage",
    remoteUpdatedAt: NOW,
    workItemFingerprint: fp("b"),
    readbackFingerprint: fp("d"),
  });
  const fixture = pollerFixture(configuration, async (_input, credential) => {
    assert.equal(credential, CREDENTIAL);
    return {
      candidates: [observation],
      cursor: { updatedAt: NOW, issueId: observation.issueId },
    };
  });

  const result = await fixture.poller.runDue();

  assert.equal(result.status, "completed");
  assert.equal(fixture.completions.length, 1);
  assert.equal(fixture.failures.length, 0);
  assert.deepEqual(fixture.completions[0].candidates, [observation]);
  assert.equal(fixture.scanLease.disposed, true);
  assert.equal(fixture.secretLeases.every((lease) => lease.disposed), true);
  assert.equal(JSON.stringify(fixture).includes(CREDENTIAL), false);
  assert.equal(JSON.stringify(fixture.completions).includes("description"), false);
});

test("project drift is rejected before coordinator completion and persists a bounded failure", async () => {
  const configuration = await queueConfiguration();
  const wrongProject = await createCompanionLinearQueueCandidateObservationV1({
    issueId: "issue-linear-2",
    identifier: "LIN-2",
    queueProjectId: "project-other",
    remoteStateId: "state-triage",
    remoteUpdatedAt: NOW,
    workItemFingerprint: fp("b"),
    readbackFingerprint: fp("d"),
  });
  const fixture = pollerFixture(configuration, async () => ({
    candidates: [wrongProject],
    cursor: { updatedAt: NOW, issueId: wrongProject.issueId },
  }));

  const result = await fixture.poller.runDue();

  assert.deepEqual(result, {
    status: "failed",
    code: "linear_queue_invalid_response",
  });
  assert.equal(fixture.completions.length, 0);
  assert.deepEqual(fixture.failures.map((item) => item.errorCode), [
    "linear_queue_invalid_response",
  ]);
  assert.equal(fixture.scanLease.disposed, true);
});

test("configuration builder requires the exact four-hour bounded grant", async () => {
  await assert.rejects(
    () =>
      createCompanionLinearQueueConfigurationV1({
        workspaceId: "workspace-linear",
        queueProjectId: "project-linear",
        credentialReferenceId: CREDENTIAL_REFERENCE,
        authority: {
          version: 1,
          grantId: "grant-linear",
          fingerprint: fp("a"),
          authorizedAt: NOW,
          expiresAt: "2026-07-13T22:00:00.001Z",
        },
      }),
    /exact four-hour grant/u,
  );
});

test("worker runs the queue poller before enumerating ordinary jobs", async () => {
  const order: string[] = [];
  const bootstrap = createSessionBootstrapTokenLeaseV1(
    "bootstrap-linear-queue-worker-0123456789abcdef",
  );
  const client = new CompanionCoordinatorClientV1({
    baseUrl: "http://127.0.0.1:18799",
    credential: bootstrap,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/worker/heartbeat") {
        return json({ ok: true, workerReady: true, expiresAt: EXPIRES });
      }
      if (url.pathname === "/health") {
        order.push("health");
        return json({ ok: true });
      }
      if (url.pathname === "/jobs") {
        order.push("jobs");
        return json({ jobs: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const worker = new CompanionWorkerCoordinatorV1({
    client,
    coordinatorId: "worker-linear-queue",
    catalogFingerprint: fp("c"),
    executorCatalog: {},
    linearQueuePoller: {
      runDue: async () => {
        order.push("poller");
        return { status: "skipped", reason: "not_due" } as const;
      },
    },
    now: () => new Date(NOW),
  });

  const result = await worker.runOnce();
  assert.equal(result.inspected, 0);
  assert.ok(order.indexOf("health") < order.indexOf("poller"));
  assert.ok(order.indexOf("poller") < order.indexOf("jobs"));
  bootstrap.dispose();
});

function pollerFixture(
  configuration: CompanionLinearQueueConfigurationV1,
  scan: ConstructorParameters<typeof CompanionLinearQueuePollerV1>[0]["scan"],
) {
  const scanLease = queueScanLease(configuration.configurationFingerprint);
  const completions: Array<{
    candidates: Awaited<ReturnType<typeof scan>>["candidates"];
  }> = [];
  const failures: Array<{ errorCode: string }> = [];
  const secretLeases: ReturnType<typeof createSecretLeaseV1>[] = [];
  const health: SecretStoreHealthV1 = {
    version: 1,
    available: true,
    persistent: true,
    backend: "test-keyring",
    backgroundEligible: true,
    blocker: null,
  };
  const poller = new CompanionLinearQueuePollerV1({
    client: {
      claimLinearQueueScan: async () => ({
        claimed: true,
        reason: "claimed",
        configuration,
        cursor: null,
        nextScanAt: NOW,
        lease: scanLease,
      }),
      completeLinearQueueScan: async (
        input: Parameters<CompanionCoordinatorClientV1["completeLinearQueueScan"]>[0],
      ) => {
        completions.push({ candidates: input.candidates });
        return queueStatus(configuration, input.candidates.length);
      },
      failLinearQueueScan: async (
        input: Parameters<CompanionCoordinatorClientV1["failLinearQueueScan"]>[0],
      ) => {
        failures.push({ errorCode: input.errorCode });
        return queueStatus(configuration, 0);
      },
    } as never,
    secretStore: {
      health: async () => health,
      lease: async (referenceId) => {
        assert.equal(referenceId, CREDENTIAL_REFERENCE);
        const lease = createSecretLeaseV1(
          CREDENTIAL,
          {
            version: 1,
            leaseId: "lease_linearqueue123",
            referenceId,
            source: "secure_store_lease",
            persistent: true,
            expiresAt: EXPIRES,
          },
          { now: () => new Date(NOW) },
        );
        secretLeases.push(lease);
        return lease;
      },
    },
    coordinatorId: "worker-linear-queue",
    catalogFingerprint: fp("c"),
    scan,
    now: () => new Date(NOW),
  });
  return { poller, scanLease, completions, failures, secretLeases };
}

function queueScanLease(
  configurationFingerprint: string,
): CompanionLinearQueueScanLeaseV1 {
  let disposed = false;
  return {
    description: {
      scanId: "scan-linear-1",
      coordinatorId: "worker-linear-queue",
      configurationFingerprint,
    },
    get disposed() {
      return disposed;
    },
    async withToken<TResult>(use: (token: string) => Promise<TResult>) {
      if (disposed) throw new Error("disposed");
      return use("scan-token-never-serialize");
    },
    dispose() {
      disposed = true;
    },
    toJSON() {
      return { redacted: true, description: this.description };
    },
  };
}

async function queueConfiguration() {
  return createCompanionLinearQueueConfigurationV1({
    workspaceId: "workspace-linear",
    queueProjectId: "project-linear",
    credentialReferenceId: CREDENTIAL_REFERENCE,
    authority: {
      version: 1,
      grantId: "grant-linear",
      fingerprint: fp("a"),
      authorizedAt: NOW,
      expiresAt: EXPIRES,
    },
  });
}

function queueStatus(
  configuration: CompanionLinearQueueConfigurationV1,
  candidates: number,
) {
  return {
    enabled: true,
    configurationFingerprint: configuration.configurationFingerprint,
    queueProjectId: configuration.queueProjectId,
    authorityExpiresAt: configuration.authority.expiresAt,
    cursor: null,
    nextScanAt: NOW,
    lastScanStartedAt: NOW,
    lastScanCompletedAt: NOW,
    lastErrorCode: null,
    candidateCount: candidates,
    scheduledReadbackCount: candidates,
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
