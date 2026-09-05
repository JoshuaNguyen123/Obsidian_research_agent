import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  type MissionGraphPatchV1,
  type MissionGraphV3,
  type MissionNodeStatusV3,
} from "../packages/headless-runtime/src/missionGraphV3";
import {
  buildCrashRecoveredContinuationV1,
  formatCrashRecoveredContinuationForPrompt,
} from "../src/agent/crashRecoveredContinuation";
import {
  getMissionGraphStorePath,
  persistInitialMissionGraph,
  persistMissionGraphPatchTransaction,
  persistPreparedMissionGraphPatch,
  type MissionGraphStoreWriteResult,
} from "../src/agent/missionGraphStore";
import type { MissionGraphStoreReferenceV1 } from "../src/agent/runStore";
import {
  createMissionLedger,
  writeMissionLedger,
  type MissionLedger,
} from "../src/agent/missionLedger";
import {
  createMissionRuntimeSnapshot,
  writeMissionRuntimeSnapshot,
} from "../src/agent/runStore";
import { buildContinuationHandoffV1 } from "../src/agent/continuationMemory";
import type { OrchestratorSnapshotV1 } from "../src/orchestrator/types";
import type { ToolExecutionContext } from "../src/tools/types";

const CREATED_AT = "2026-08-25T01:00:00.000Z";
const PATCHED_AT = "2026-08-25T01:01:00.000Z";

test("rebuilds a crash-recovered continuation from a direct mission graph store", async () => {
  const harness = createVaultHarness();
  const runId = "run-crash-direct";
  const stored = await seedStore(harness.context, runId);
  const storeMarkdownBefore = harness.files.get(stored.path);

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    runId,
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.provenance, "crash_recovered");
  assert.equal(result.value.requestedRunId, runId);
  assert.equal(result.value.resume.runId, runId);
  assert.equal(result.value.resume.viaOrchestratorLink, false);
  assert.equal(result.value.graph.missionId, runId);
  assert.equal(result.value.graph.graphRevision, 1);
  assert.equal(result.value.graph.storeRevision, stored.record.storeRevision);
  assert.equal(
    result.value.graph.recordFingerprint,
    stored.record.recordFingerprint,
  );
  assert.deepEqual(result.value.graph.activeNodeIds, ["read"]);
  assert.deepEqual(result.value.graph.walTail, {
    patchId: "patch-crash-1",
    state: "applied",
  });
  assert.equal(result.ledger, null);
  assert.equal(result.snapshot, null);
  assert.deepEqual(result.value.reconciliation, []);
  assert.match(result.value.fingerprint, /^sha256:[a-f0-9]{64}$/);
  // Reconstruction is read-only: the durable store must be byte-identical.
  assert.equal(harness.files.get(stored.path), storeMarkdownBefore);

  const prompt = formatCrashRecoveredContinuationForPrompt(result.value);
  assert.match(prompt, /provenance: crash_recovered/);
  assert.match(prompt, /Do not replay completed note writes/);
});

test("reports a prepared WAL tail without healing it during reconstruction", async () => {
  const harness = createVaultHarness();
  const runId = "run-crash-prepared";
  const initial = await persistInitialMissionGraph(
    harness.context,
    await createGraph(runId),
  );
  await persistPreparedMissionGraphPatch(
    harness.context,
    runId,
    createStatusPatch(initial.record.graph, "patch-prepared", "ready", "running"),
    { expectedStoreRevision: initial.record.storeRevision, appliedAt: PATCHED_AT },
  );
  const storeMarkdownBefore = harness.files.get(initial.path);

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    runId,
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value.graph.walTail, {
    patchId: "patch-prepared",
    state: "prepared",
  });
  // The graph itself is still pre-patch; MissionGraphSession recovery owns
  // the replay write, not this read-only reconstruction.
  assert.equal(result.value.graph.graphRevision, 0);
  assert.equal(harness.files.get(initial.path), storeMarkdownBefore);
});

test("follows a durable orchestrator link from a worker ledger to the requested root run", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-root";
  const leadRunId = "run-crash-root-lead";
  const stored = await seedStore(harness.context, leadRunId);
  await seedLinkedWorker(harness.context, {
    rootRunId,
    workerRunId: leadRunId,
    reference: referenceFor(stored),
  });

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.requestedRunId, rootRunId);
  assert.equal(result.value.resume.runId, leadRunId);
  assert.equal(result.value.resume.viaOrchestratorLink, true);
  assert.equal(result.value.graph.missionId, leadRunId);
  assert.equal(result.ledger?.runId, leadRunId);
  assert.equal(result.ledgerPath, `Agent Runs/${leadRunId}.md`);
  assert.equal(result.snapshot?.runId, leadRunId);
  assert.equal(result.snapshot?.missionGraphRef?.missionId, leadRunId);
});

test("refuses when no durable crash state exists for the requested run", async () => {
  const harness = createVaultHarness();

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    "run-crash-nothing",
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "no_durable_crash_state");
});

test("refuses a tampered mission graph store instead of reconstructing from it", async () => {
  const harness = createVaultHarness();
  const runId = "run-crash-tampered";
  const stored = await seedStore(harness.context, runId);
  harness.files.set(
    stored.path,
    (harness.files.get(stored.path) ?? "").replace(
      '"objective": "Read the trusted source."',
      '"objective": "Tampered objective."',
    ),
  );

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    runId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "graph_store_invalid");
});

test("refuses when the requested run already has a mission ledger", async () => {
  const harness = createVaultHarness();
  const runId = "run-crash-ledgered";
  await seedStore(harness.context, runId);
  await writeMissionLedger(harness.context, createLedger(runId));

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    runId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "run_note_ledger_present");
});

test("refuses ambiguous orchestrator links instead of choosing a worker", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-ambiguous-root";
  for (const workerRunId of [
    "run-crash-ambiguous-lead",
    "run-crash-ambiguous-verify",
  ]) {
    const ledger = createLedger(workerRunId);
    ledger.orchestrator = orchestratorSnapshot(rootRunId);
    await writeMissionLedger(harness.context, ledger);
  }

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "orchestrator_link_ambiguous");
});

test("refuses a linked worker that closed gracefully and points at its own continuation", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-graceful-root";
  const leadRunId = "run-crash-graceful-lead";
  const ledger = createLedger(leadRunId);
  ledger.orchestrator = orchestratorSnapshot(rootRunId);
  ledger.continuationHandoff = buildContinuationHandoffV1({
    ledger,
    now: new Date(PATCHED_AT),
  });
  await writeMissionLedger(harness.context, ledger);

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "graceful_handoff_present");
  assert.equal(result.detail, `continue run ${leadRunId}`);
});

test("refuses a linked worker whose stored handoff was marked invalid", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-invalid-root";
  const ledger = createLedger("run-crash-invalid-lead");
  ledger.orchestrator = orchestratorSnapshot(rootRunId);
  await writeMissionLedger(harness.context, ledger);
  // A malformed persisted handoff surfaces on read as
  // continuationHandoffInvalid; the write path strips it, so inject it into
  // the durable note the way a corrupted checkpoint would appear on disk.
  const notePath = "Agent Runs/run-crash-invalid-lead.md";
  harness.files.set(
    notePath,
    (harness.files.get(notePath) ?? "").replace(
      '"continuationCommand"',
      '"continuationHandoff": {"version": 1}, "continuationCommand"',
    ),
  );

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "linked_handoff_invalid");
});

test("refuses a linked worker without a runtime snapshot", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-nosnapshot-root";
  const ledger = createLedger("run-crash-nosnapshot-lead");
  ledger.orchestrator = orchestratorSnapshot(rootRunId);
  await writeMissionLedger(harness.context, ledger);

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "linked_snapshot_missing");
});

test("refuses a linked snapshot whose graph reference no longer matches the store", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-mismatch-root";
  const leadRunId = "run-crash-mismatch-lead";
  const stored = await seedStore(harness.context, leadRunId);
  const reference = referenceFor(stored);
  reference.recordFingerprint = `sha256:${"0".repeat(64)}`;
  await seedLinkedWorker(harness.context, {
    rootRunId,
    workerRunId: leadRunId,
    reference,
  });

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "graph_reference_mismatch");
});

test("refuses a linked snapshot whose referenced graph store is missing", async () => {
  const harness = createVaultHarness();
  const rootRunId = "run-crash-storeless-root";
  const leadRunId = "run-crash-storeless-lead";
  const stored = await seedStore(harness.context, leadRunId);
  await seedLinkedWorker(harness.context, {
    rootRunId,
    workerRunId: leadRunId,
    reference: referenceFor(stored),
  });
  harness.files.delete(stored.path);

  const result = await buildCrashRecoveredContinuationV1(
    harness.context,
    rootRunId,
  );

  assert.equal(result.ok, false);
  assert.equal(result.refusalCode, "linked_graph_store_missing");
});

async function seedStore(
  context: ToolExecutionContext,
  missionId: string,
): Promise<MissionGraphStoreWriteResult> {
  const initial = await persistInitialMissionGraph(
    context,
    await createGraph(missionId),
  );
  return persistMissionGraphPatchTransaction(
    context,
    missionId,
    createStatusPatch(initial.record.graph, "patch-crash-1", "ready", "running"),
    { expectedStoreRevision: initial.record.storeRevision, appliedAt: PATCHED_AT },
  );
}

function referenceFor(
  stored: MissionGraphStoreWriteResult,
): MissionGraphStoreReferenceV1 {
  return {
    version: 1,
    missionId: stored.record.missionId,
    path: getMissionGraphStorePath(stored.record.missionId),
    storeRevision: stored.record.storeRevision,
    graphRevision: stored.record.graph.revision,
    recordFingerprint: stored.record.recordFingerprint,
    journalHeadFingerprint: stored.record.graph.journalHeadFingerprint,
  };
}

async function seedLinkedWorker(
  context: ToolExecutionContext,
  input: {
    rootRunId: string;
    workerRunId: string;
    reference: MissionGraphStoreReferenceV1;
  },
): Promise<void> {
  const ledger = createLedger(input.workerRunId);
  ledger.orchestrator = orchestratorSnapshot(input.rootRunId);
  await writeMissionLedger(context, ledger);
  await writeMissionRuntimeSnapshot(
    context,
    createMissionRuntimeSnapshot({
      runId: input.workerRunId,
      originalMission: "Continue the crashed research mission.",
      currentNotePath: "Current.md",
      missionGraphRef: input.reference,
      createdAt: new Date(PATCHED_AT),
      updatedAt: new Date(PATCHED_AT),
    }),
  );
}

function createLedger(runId: string): MissionLedger {
  const ledger = createMissionLedger({
    runId,
    mission: "Continue the crashed research mission.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 12,
      toolStepBudget: 8,
      finalizationReserve: 4,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
    now: new Date(CREATED_AT),
  });
  ledger.status = "running";
  return ledger;
}

function orchestratorSnapshot(rootRunId: string): OrchestratorSnapshotV1 {
  return {
    runId: rootRunId,
  } as unknown as OrchestratorSnapshotV1;
}

async function createGraph(missionId: string): Promise<MissionGraphV3> {
  const envelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: CREATED_AT,
    expiresAt: null,
    capabilities: ["web.read"],
    executionHosts: ["obsidian_core"],
    executors: {
      core: {
        id: "core",
        executionHosts: ["obsidian_core"],
        allowedEffects: ["read"],
      },
    },
    verifiers: ["artifact-verifier"],
    tools: {
      "web-search": {
        name: "web-search",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
    },
    bindings: {},
    budgets: {
      maxNodes: 16,
      maxDepth: 4,
      maxConcurrentReadNodes: 3,
      maxTotalToolCalls: 24,
      maxExternalActions: 0,
      maxWallClockMs: 120_000,
      maxAttemptsPerNode: 3,
    },
  });
  return {
    schemaVersion: 3,
    missionId,
    objective: "Read the trusted source.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: CREATED_AT,
      decisionFingerprint: `sha256:${"1".repeat(64)}`,
    },
    continuationCheckpoint: null,
    capabilityEnvelope: envelope,
    nodes: {
      read: {
        id: "read",
        dependencyIds: [],
        objective: "Read one trusted source.",
        executorId: "core",
        executionHost: "obsidian_core",
        effect: "read",
        inputs: {},
        outputs: {},
        requiredCapabilities: ["web.read"],
        allowedTools: ["web-search"],
        destination: null,
        resourceLocks: [],
        budget: { toolCalls: 1, externalActions: 0, wallClockMs: 5_000 },
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
          criteria: ["One source is recorded."],
          minimumEvidence: 1,
          requiredEvidenceKinds: ["web-source"],
          minimumReceipts: 0,
          requiredReceiptKinds: [],
          verifierId: "artifact-verifier",
        },
        blocker: null,
      },
    },
  };
}

function createStatusPatch(
  graph: MissionGraphV3,
  patchId: string,
  expectedStatus: MissionNodeStatusV3,
  status: MissionNodeStatusV3,
): MissionGraphPatchV1 {
  return {
    version: 1,
    patchId,
    missionId: graph.missionId,
    baseRevision: graph.revision,
    baseJournalFingerprint: graph.journalHeadFingerprint,
    proposedAt: PATCHED_AT,
    reason: "Advance the durable mission graph.",
    operations: [
      {
        op: "set_status",
        nodeId: "read",
        expectedStatus,
        status,
        blocker: null,
      },
    ],
  };
}

function createVaultHarness(): {
  context: ToolExecutionContext;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let nowMs = Date.parse("2026-08-25T01:10:00.000Z");
  const getFile = (path: string) =>
    files.has(path)
      ? {
          path,
          name: path.split("/").at(-1) ?? path,
          extension: path.split(".").at(-1) ?? "",
          stat: { mtime: nowMs },
        }
      : null;

  const vault = {
    getFileByPath: getFile,
    getFiles: () => [...files.keys()].map((path) => getFile(path)),
    getFolderByPath: (path: string) =>
      folders.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null,
    createFolder: async (path: string) => {
      if (folders.has(path)) throw new Error(`Folder already exists: ${path}`);
      folders.add(path);
    },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      files.set(path, content);
      return getFile(path);
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    cachedRead: async (file: { path: string }) => files.get(file.path) ?? "",
    process: function (file: any, transform: (content: string) => string): Promise<string> {
      return processTestVaultFile(this, file, transform);
    },
    modify: async (file: { path: string }, content: string) => {
      if (!files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
      files.set(file.path, content);
    },
  };

  return {
    files,
    context: {
      app: { vault },
      settings: {},
      originalPrompt: "test crash-recovered continuation",
      httpTransport: {},
      now: () => {
        const now = new Date(nowMs);
        nowMs += 1_000;
        return now;
      },
    } as unknown as ToolExecutionContext,
  };
}
