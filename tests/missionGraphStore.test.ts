import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  reduceMissionGraphPatchV1,
  type MissionGraphPatchV1,
  type MissionGraphV3,
  type MissionNodeStatusV3,
} from "../packages/headless-runtime/src/missionGraphV3";
import {
  formatMissionGraphStoreBlock,
  getMissionGraphStorePath,
  MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES,
  MissionGraphStoreIntegrityError,
  MissionGraphStorePatchConflictError,
  MissionGraphStoreRevisionConflictError,
  parseMissionGraphStoreRecord,
  persistAppliedMissionGraphPatch,
  persistInitialMissionGraph,
  persistMissionGraphPatchTransaction,
  persistMissionGraphResourceLocks,
  persistPreparedMissionGraphPatch,
  readMissionGraphStoreRecord,
  recoverFinalPreparedMissionGraphPatch,
  type MissionGraphStoreRecordV1,
} from "../src/agent/missionGraphStore";
import { sha256Fingerprint } from "../src/agent/actions/canonicalize";
import {
  acquireResourceLocks,
  createResourceLockState,
} from "../src/agent/queue/resourceLocks";
import type { ToolExecutionContext } from "../src/tools/types";

const CREATED_AT = "2026-07-11T12:00:00.000Z";
const PATCHED_AT = "2026-07-11T12:01:00.000Z";

test("persists the initial MissionGraphV3 with a separate CAS revision and strict readback", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph("mission-store-initial");

  const result = await persistInitialMissionGraph(harness.context, graph);

  assert.equal(result.path, "Agent Runs/Mission Graphs/mission-store-initial.md");
  assert.equal(result.record.storeRevision, 1);
  assert.equal(result.record.graph.revision, 0);
  assert.equal(result.record.resourceLocks.revision, 0);
  assert.match(result.record.recordFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(harness.createdFolders, [
    "Agent Runs",
    "Agent Runs/Mission Graphs",
  ]);

  const readback = await readMissionGraphStoreRecord(
    harness.context,
    graph.missionId,
  );
  assert.deepEqual(readback?.record, result.record);
  assert.equal(
    await recordFingerprint(result.record),
    result.record.recordFingerprint,
  );
});

test("rejects stale writers without changing the stored record", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph("mission-store-cas");
  const initial = await persistInitialMissionGraph(harness.context, graph);
  const patch = createStatusPatch(graph, "patch-cas", "ready", "running");

  const prepared = await persistPreparedMissionGraphPatch(
    harness.context,
    graph.missionId,
    patch,
    { expectedStoreRevision: initial.record.storeRevision, appliedAt: PATCHED_AT },
  );
  const before = harness.files.get(prepared.path);

  await assert.rejects(
    persistMissionGraphResourceLocks(
      harness.context,
      graph.missionId,
      prepared.record.resourceLocks,
      { expectedStoreRevision: initial.record.storeRevision },
    ),
    (error: unknown) => {
      assert.ok(error instanceof MissionGraphStoreRevisionConflictError);
      assert.equal(error.expectedRevision, 1);
      assert.equal(error.actualRevision, 2);
      return true;
    },
  );
  assert.equal(harness.files.get(prepared.path), before);
});

test("durably prepares the full patch before apply and makes applied replay idempotent", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph("mission-store-wal");
  const initial = await persistInitialMissionGraph(harness.context, graph);
  const patch = createStatusPatch(graph, "patch-wal", "ready", "running");

  const prepared = await persistPreparedMissionGraphPatch(
    harness.context,
    graph.missionId,
    patch,
    { expectedStoreRevision: initial.record.storeRevision, appliedAt: PATCHED_AT },
  );

  assert.equal(prepared.record.storeRevision, 2);
  assert.equal(prepared.record.graph.revision, 0);
  assert.equal(prepared.record.graph.nodes.read.status, "ready");
  assert.equal(prepared.record.journal.length, 1);
  assert.equal(prepared.record.journal[0].state, "prepared");
  assert.deepEqual(prepared.record.journal[0].patch, patch);

  const applied = await persistAppliedMissionGraphPatch(
    harness.context,
    graph.missionId,
    patch.patchId,
    { expectedStoreRevision: prepared.record.storeRevision },
  );
  assert.equal(applied.record.storeRevision, 3);
  assert.equal(applied.record.graph.revision, 1);
  assert.equal(applied.record.graph.nodes.read.status, "running");
  assert.equal(applied.record.journal[0].state, "applied");

  const replay = await persistAppliedMissionGraphPatch(
    harness.context,
    graph.missionId,
    patch.patchId,
    { expectedStoreRevision: applied.record.storeRevision },
  );
  assert.equal(replay.written, false);
  assert.equal(replay.bytesWritten, 0);
  assert.equal(replay.record.storeRevision, applied.record.storeRevision);
  assert.equal(harness.files.get(applied.path), harness.files.get(replay.path));
});

test("recovers only the final prepared patch once after a restart", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph("mission-store-recovery");
  const initial = await persistInitialMissionGraph(harness.context, graph);
  const patch = createStatusPatch(
    graph,
    "patch-recover-final",
    "ready",
    "running",
  );
  const prepared = await persistPreparedMissionGraphPatch(
    harness.context,
    graph.missionId,
    patch,
    { expectedStoreRevision: initial.record.storeRevision, appliedAt: PATCHED_AT },
  );

  const recovered = await recoverFinalPreparedMissionGraphPatch(
    harness.context,
    graph.missionId,
    { expectedStoreRevision: prepared.record.storeRevision },
  );
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.patchId, patch.patchId);
  assert.equal(recovered.record.graph.revision, 1);
  assert.equal(recovered.record.journal.at(-1)?.state, "applied");

  const repeated = await recoverFinalPreparedMissionGraphPatch(
    harness.context,
    graph.missionId,
    { expectedStoreRevision: recovered.record.storeRevision },
  );
  assert.equal(repeated.recovered, false);
  assert.equal(repeated.written, false);
  assert.equal(repeated.record.storeRevision, recovered.record.storeRevision);
});

test("persists only normalized resource-lock state and fails closed on malformed stored locks", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph("mission-store-locks");
  const initial = await persistInitialMissionGraph(harness.context, graph);
  const acquisition = acquireResourceLocks(initial.record.resourceLocks, {
    resourceKeys: ["vault-note:research/main"],
    ownerId: "mission-node-read",
    at: "2026-07-11T12:11:00.000Z",
    leaseMs: 60_000,
  });
  assert.equal(acquisition.accepted, true);

  const locked = await persistMissionGraphResourceLocks(
    harness.context,
    graph.missionId,
    acquisition.state,
    { expectedStoreRevision: initial.record.storeRevision },
  );
  assert.equal(locked.record.resourceLocks.revision, 1);
  assert.ok(
    locked.record.resourceLocks.locks["vault-note:research/main"],
  );

  const malformed = clone(locked.record) as unknown as {
    resourceLocks: { schemaVersion: number };
    recordFingerprint: string;
  };
  malformed.resourceLocks.schemaVersion = 99;
  malformed.recordFingerprint = await recordFingerprint(
    malformed as MissionGraphStoreRecordV1,
  );
  harness.files.set(
    locked.path,
    storeMarkdown(malformed as MissionGraphStoreRecordV1),
  );

  await assert.rejects(
    readMissionGraphStoreRecord(harness.context, graph.missionId),
    (error: unknown) => {
      assert.ok(error instanceof MissionGraphStoreIntegrityError);
      assert.match(error.message, /resource lock state is invalid/i);
      return true;
    },
  );
});

test("fails closed on tampering, broken journal chains, and duplicate patch IDs", async () => {
  const tamperedHarness = createVaultHarness();
  const tamperedGraph = await createGraph("mission-store-tampered");
  const tampered = await persistInitialMissionGraph(
    tamperedHarness.context,
    tamperedGraph,
  );
  tamperedHarness.files.set(
    tampered.path,
    (tamperedHarness.files.get(tampered.path) ?? "").replace(
      '"objective": "Read the trusted source."',
      '"objective": "Tampered objective."',
    ),
  );
  await assert.rejects(
    readMissionGraphStoreRecord(tamperedHarness.context, tamperedGraph.missionId),
    MissionGraphStoreIntegrityError,
  );

  const chainHarness = createVaultHarness();
  let graph = await createGraph("mission-store-chain");
  let write = await persistInitialMissionGraph(chainHarness.context, graph);
  write = await persistMissionGraphPatchTransaction(
    chainHarness.context,
    graph.missionId,
    createStatusPatch(graph, "patch-chain-1", "ready", "running"),
    { expectedStoreRevision: write.record.storeRevision, appliedAt: PATCHED_AT },
  );
  graph = write.record.graph;
  write = await persistMissionGraphPatchTransaction(
    chainHarness.context,
    graph.missionId,
    createStatusPatch(graph, "patch-chain-2", "running", "ready"),
    { expectedStoreRevision: write.record.storeRevision, appliedAt: PATCHED_AT },
  );

  const broken = clone(write.record);
  broken.journal.reverse();
  broken.recordFingerprint = await recordFingerprint(broken);
  await assert.rejects(parseMissionGraphStoreRecord(broken), (error: unknown) => {
    assert.ok(error instanceof MissionGraphStoreIntegrityError);
    assert.match(error.message, /journal chain is broken/i);
    return true;
  });

  const duplicate = clone(write.record);
  duplicate.journal = [duplicate.journal[0], clone(duplicate.journal[0])];
  duplicate.recordFingerprint = await recordFingerprint(duplicate);
  await assert.rejects(
    parseMissionGraphStoreRecord(duplicate),
    (error: unknown) => {
      assert.ok(error instanceof MissionGraphStoreIntegrityError);
      assert.match(error.message, /duplicate patch id/i);
      return true;
    },
  );

  const duplicatePatch = createStatusPatch(
    write.record.graph,
    "patch-chain-2",
    "ready",
    "running",
  );
  await assert.rejects(
    persistPreparedMissionGraphPatch(
      chainHarness.context,
      graph.missionId,
      duplicatePatch,
      { expectedStoreRevision: write.record.storeRevision, appliedAt: PATCHED_AT },
    ),
    MissionGraphStorePatchConflictError,
  );
});

test("bounds the retained journal while preserving its hash chain", async () => {
  const harness = createVaultHarness();
  let graph = await createGraph("mission-store-bounded-journal");
  const journal: MissionGraphStoreRecordV1["journal"] = [];
  for (let index = 0; index < MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES; index += 1) {
    const from = graph.nodes.read.status as "ready" | "running";
    const to = from === "ready" ? "running" : "ready";
    const reduced = await reduceMissionGraphPatchV1(
      graph,
      createStatusPatch(graph, `patch-bounded-${index}`, from, to),
      { appliedAt: PATCHED_AT },
    );
    graph = reduced.graph;
    journal.push(reduced.journalEntry);
  }

  const seededPayload = {
    version: 1 as const,
    storeRevision: 1,
    missionId: graph.missionId,
    graph,
    journal,
    resourceLocks: createResourceLockState(CREATED_AT),
    createdAt: CREATED_AT,
    updatedAt: PATCHED_AT,
  };
  const seeded: MissionGraphStoreRecordV1 = {
    ...seededPayload,
    recordFingerprint: await sha256Fingerprint(seededPayload),
  };
  harness.files.set(getMissionGraphStorePath(graph.missionId), storeMarkdown(seeded));

  const write = await persistMissionGraphPatchTransaction(
    harness.context,
    graph.missionId,
    createStatusPatch(graph, "patch-bounded-64", "ready", "running"),
    { expectedStoreRevision: seeded.storeRevision, appliedAt: PATCHED_AT },
  );

  assert.equal(
    write.record.journal.length,
    MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES,
  );
  assert.equal(write.record.journal[0].patchId, "patch-bounded-1");
  assert.equal(write.record.journal.at(-1)?.patchId, "patch-bounded-64");
  assert.deepEqual(await parseMissionGraphStoreRecord(write.record), write.record);
});

test("requires exact post-write readback instead of trusting a successful vault write", async () => {
  const harness = createVaultHarness((content) =>
    content.replace('"storeRevision": 1', '"storeRevision": 2'),
  );
  const graph = await createGraph("mission-store-readback");

  await assert.rejects(
    persistInitialMissionGraph(harness.context, graph),
    (error: unknown) => {
      assert.ok(error instanceof MissionGraphStoreIntegrityError);
      assert.match(error.message, /fingerprint does not match/i);
      return true;
    },
  );
});

test("refuses to overwrite a colliding mission file without a valid store block", async () => {
  const harness = createVaultHarness();
  const graph = await createGraph("mission:store:collision");
  const path = getMissionGraphStorePath(graph.missionId);
  harness.files.set(path, "# User-owned note\n\nDo not overwrite me.\n");

  await assert.rejects(
    persistInitialMissionGraph(harness.context, graph),
    (error: unknown) => {
      assert.ok(error instanceof MissionGraphStoreIntegrityError);
      assert.match(error.message, /without a store block/i);
      return true;
    },
  );
  assert.equal(
    harness.files.get(path),
    "# User-owned note\n\nDo not overwrite me.\n",
  );
});

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
      decisionFingerprint: fp("1"),
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

function createVaultHarness(
  transformWrite?: (content: string) => string,
): {
  context: ToolExecutionContext;
  files: Map<string, string>;
  createdFolders: string[];
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const createdFolders: string[] = [];
  let nowMs = Date.parse("2026-07-11T12:10:00.000Z");
  const getFile = (path: string) =>
    files.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null;

  const vault = {
    getFileByPath: getFile,
    getFolderByPath: (path: string) =>
      folders.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null,
    createFolder: async (path: string) => {
      if (folders.has(path)) throw new Error(`Folder already exists: ${path}`);
      folders.add(path);
      createdFolders.push(path);
    },
    create: async (path: string, content: string) => {
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      files.set(path, transformWrite ? transformWrite(content) : content);
      return getFile(path);
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    modify: async (file: { path: string }, content: string) => {
      if (!files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
      files.set(
        file.path,
        transformWrite ? transformWrite(content) : content,
      );
    },
  };

  return {
    files,
    createdFolders,
    context: {
      app: { vault },
      settings: {},
      originalPrompt: "test mission graph persistence",
      httpTransport: {},
      now: () => {
        const now = new Date(nowMs);
        nowMs += 1_000;
        return now;
      },
    } as unknown as ToolExecutionContext,
  };
}

async function recordFingerprint(
  record: MissionGraphStoreRecordV1,
): Promise<string> {
  const { recordFingerprint: _ignored, ...payload } = record;
  return sha256Fingerprint(payload);
}

function storeMarkdown(record: MissionGraphStoreRecordV1): string {
  return [
    `# Mission Graph ${record.missionId}`,
    "",
    formatMissionGraphStoreBlock(record),
  ].join("\n");
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
