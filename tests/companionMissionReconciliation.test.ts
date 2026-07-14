import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackgroundAuthorizationV1,
  buildCompanionReceiptV1,
  buildMissionCapabilityEnvelopeV1,
  companionResultFingerprintV1,
  prepareCompanionJobV1,
  type CompanionEventV1,
  type CompanionJobV1,
  type CompanionRemoteJobV1,
  type MissionGraphV3,
} from "../packages/headless-runtime/src";
import { reconcileCompanionMissionCompletionV1 } from "../src/agent/companionMissionReconciliation";
import { MissionGraphSession } from "../src/agent/missionGraphSession";
import { dispatchPersistedBackgroundNodesV1 } from "../src/agent/backgroundMissionDispatch";
import { readMissionGraphStoreRecord } from "../src/agent/missionGraphStore";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = "2026-07-12T18:00:00.000Z";

test("a real persisted graph dispatches its authorized headless node exactly once", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph();
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  let submitCalls = 0;
  const first = await dispatchPersistedBackgroundNodesV1({
    session,
    now: () => new Date(NOW),
    port: {
      readCapabilities: async () => ({
        configured: true,
        backgroundEnabled: true,
        installedDomains: ["research"],
        blocker: null,
      }),
      submitAuthorizedNode: async (input) => {
        submitCalls += 1;
        const persisted = await readMissionGraphStoreRecord(
          harness.context,
          graph.missionId,
        );
        assert.ok(persisted, "graph must exist before external dispatch");
        assert.equal(
          persisted!.record.graph.capabilityEnvelope.fingerprint,
          input.graph.capabilityEnvelope.fingerprint,
        );
        const prepared = await prepareCompanionJobV1(input);
        assert.equal(prepared.status, "ready");
        if (prepared.status !== "ready") throw new Error("Expected ready job.");
        return { status: "submitted", job: remoteFromJob(prepared.job, {}) };
      },
    },
  });
  assert.deepEqual(first.submitted, ["research"]);
  assert.equal(submitCalls, 1);
  assert.equal(session.graph.nodes.research.status, "running");

  const resumed = await MissionGraphSession.resume({
    context: harness.context,
    missionId: graph.missionId,
  });
  const second = await dispatchPersistedBackgroundNodesV1({
    session: resumed,
    port: {
      readCapabilities: async () => ({
        configured: true,
        backgroundEnabled: true,
        installedDomains: ["research"],
        blocker: null,
      }),
      submitAuthorizedNode: async () => {
        submitCalls += 1;
        throw new Error("running persisted nodes must not be replayed");
      },
    },
  });
  assert.equal(second.handled, 0);
  assert.equal(submitCalls, 1);
});

test("verified companion completion is journaled exactly once before the applied cursor advances", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph();
  await MissionGraphSession.open({ context: harness.context, initialGraph: graph });
  const authorization = await buildBackgroundAuthorizationV1({
    graph,
    nodeId: "research",
    grantId: "reconcile-grant",
    authorizedAt: NOW,
    expiresAt: null,
  });
  const prepared = await prepareCompanionJobV1({
    graph,
    nodeId: "research",
    authorization,
    now: new Date(NOW),
  });
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") throw new Error("Expected ready companion job.");

  const receipt = await buildCompanionReceiptV1({
    job: prepared.job,
    id: "reconcile-receipt",
    provider: "research",
    operation: "public_research_fetch",
    status: "verified",
    payload: { sourceCount: 1 },
    committedAt: NOW,
  });
  const proof = {
    status: "complete",
    outputs: { answer: "verified" },
    evidence: [{ kind: "public_web_source", fingerprint: fp("e") }],
    receiptIds: [receipt.id],
    blocker: null,
  };
  const remote = remoteFromJob(prepared.job, {
    state: "complete",
    output: {
      ...proof,
      resultFingerprint: await companionResultFingerprintV1(prepared.job, proof),
    },
  });
  const events: CompanionEventV1[] = [event(prepared.job, 7, "job_completed")];

  const first = await reconcileCompanionMissionCompletionV1({
    context: harness.context,
    job: remote,
    receipts: [receipt],
    events,
  });
  assert.equal(first.status, "applied");
  assert.equal(first.appliedThroughSequence, 7);
  const afterFirst = await readMissionGraphStoreRecord(harness.context, graph.missionId);
  assert.ok(afterFirst);
  assert.deepEqual(first.graphReference, {
    version: 1,
    missionId: afterFirst!.record.missionId,
    path: afterFirst!.path,
    storeRevision: afterFirst!.record.storeRevision,
    graphRevision: afterFirst!.record.graph.revision,
    recordFingerprint: afterFirst!.record.recordFingerprint,
    journalHeadFingerprint:
      afterFirst!.record.graph.journalHeadFingerprint,
  });
  const revision = afterFirst!.record.graph.revision;
  const journalLength = afterFirst!.record.journal.length;
  assert.equal(afterFirst!.record.graph.nodes.research.outputs.answer, "verified");

  const second = await reconcileCompanionMissionCompletionV1({
    context: harness.context,
    job: remote,
    receipts: [receipt],
    events,
  });
  assert.equal(second.status, "already_applied");
  const afterSecond = await readMissionGraphStoreRecord(harness.context, graph.missionId);
  assert.equal(afterSecond?.record.graph.revision, revision);
  assert.equal(afterSecond?.record.journal.length, journalLength);
  assert.deepEqual(second.graphReference, first.graphReference);
  assert.equal(second.appliedThroughSequence, 7);
});

async function createGraph(): Promise<MissionGraphV3> {
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId: "reconcile-mission",
    issuedAt: NOW,
    expiresAt: null,
    capabilities: ["web.read"],
    executionHosts: ["headless_runtime"],
    executors: {
      researcher: {
        id: "researcher",
        executionHosts: ["headless_runtime"],
        allowedEffects: ["read"],
      },
    },
    verifiers: ["companion-external-result-v1"],
    tools: {
      web_fetch: {
        name: "web_fetch",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["headless_runtime"],
        bindingKinds: [],
      },
    },
    bindings: {},
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 8,
      maxExternalActions: 0,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });
  return {
    schemaVersion: 3,
    missionId: "reconcile-mission",
    objective: "Reconcile one authorized public research result.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt: NOW,
    updatedAt: NOW,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: NOW,
      decisionFingerprint: fp("b"),
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      research: {
        id: "research",
        dependencyIds: [],
        objective: "Fetch an authorized public source.",
        executorId: "researcher",
        executionHost: "headless_runtime",
        effect: "read",
        inputs: { url: { kind: "literal", value: "https://example.com/source" } },
        outputs: {},
        requiredCapabilities: ["web.read"],
        allowedTools: ["web_fetch"],
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
          criteria: ["A public source result is verified."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["public_web_source"],
          minimumReceipts: 1,
          requiredReceiptKinds: ["external:research:public_research_fetch"],
          verifierId: "companion-external-result-v1",
        },
        blocker: null,
      },
    },
  };
}

function remoteFromJob(
  job: CompanionJobV1,
  overrides: Partial<CompanionRemoteJobV1>,
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
    ownerCoordinatorId: "agentic-researcher-service-worker",
    leaseExpiresAt: null,
    attempts: 1,
    createdAt: job.createdAt,
    updatedAt: NOW,
    ...overrides,
  };
}

function event(
  job: CompanionJobV1,
  sequence: number,
  type: CompanionEventV1["type"],
): CompanionEventV1 {
  return {
    version: 1,
    sequence,
    jobId: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    type,
    payload: {},
    occurredAt: NOW,
  };
}

function createVaultHarness(): {
  context: ToolExecutionContext;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const getFile = (path: string) => files.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null;
  let time = Date.parse(NOW);
  const vault = {
    getFileByPath: getFile,
    getFolderByPath: (path: string) => folders.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null,
    createFolder: async (path: string) => { folders.add(path); },
    create: async (path: string, content: string) => {
      files.set(path, content);
      return getFile(path);
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    modify: async (file: { path: string }, content: string) => { files.set(file.path, content); },
  };
  return {
    files,
    context: {
      app: { vault },
      settings: {},
      originalPrompt: "reconcile companion mission fixture",
      httpTransport: {},
      now: () => new Date(time += 1_000),
    } as unknown as ToolExecutionContext,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
