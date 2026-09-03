import * as runStoreForStatusTest from "../src/agent/runStore";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMissionCapabilityEnvelopeV1,
  type MissionGraphV3,
} from "../packages/headless-runtime/src/missionGraphV3";
import {
  persistInitialMissionGraph,
  type MissionGraphStoreWriteResult,
} from "../src/agent/missionGraphStore";
import {
  createMissionLedger,
  writeMissionLedger,
  type MissionLedger,
} from "../src/agent/missionLedger";
import {
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  transitionOperationJournalRecord,
  writeMissionRuntimeSnapshot,
} from "../src/agent/runStore";
import {
  getDurablyCompletedLifecycleToolNames,
  loadLatestPersistedMissionRunProjection,
  loadPersistedMissionRunProjectionByRunId,
  StartupMissionHydrationIntegrityError,
} from "../src/agent/startupMissionHydration";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = new Date("2026-07-11T18:00:00.000Z");

test("startup hydration reads the exact durable graph and resumable ledger", async () => {
  const harness = createVaultHarness();
  const seeded = await seedRun(harness, "run-startup-valid");

  const projection = await loadLatestPersistedMissionRunProjection(
    harness.context,
  );

  assert.ok(projection);
  assert.equal(projection.runId, "run-startup-valid");
  assert.equal(projection.missionGraph.missionId, "run-startup-valid");
  assert.equal(projection.missionLedger.canResume, true);
  assert.equal(
    projection.graphReference.recordFingerprint,
    seeded.graph.record.recordFingerprint,
  );
  assert.equal(
    projection.graphReference.storeRevision,
    seeded.graph.record.storeRevision,
  );
  const direct = await loadPersistedMissionRunProjectionByRunId(
    harness.context,
    "run-startup-valid",
  );
  assert.deepEqual(direct, projection);
});

test("lifecycle restart readiness requires a resumable durable completed node", () => {
  const projection = {
    missionLedger: { canResume: true },
    missionGraph: {
      nodes: {
        accepted: {
          status: "complete",
          allowedTools: ["publish_research_to_linear"],
        },
        hierarchy: {
          status: "running",
          allowedTools: ["publish_research_project_to_linear"],
        },
      },
    },
  } as unknown as Parameters<typeof getDurablyCompletedLifecycleToolNames>[0];
  assert.deepEqual(getDurablyCompletedLifecycleToolNames(projection), [
    "publish_research_to_linear",
  ]);
  projection.missionLedger.canResume = false;
  assert.deepEqual(getDurablyCompletedLifecycleToolNames(projection), []);
});

test("startup hydration skips a newer accepted ledger and selects the older incomplete run", async () => {
  const harness = createVaultHarness();
  await seedRun(harness, "run-older-incomplete");
  await seedRun(harness, "run-newer-accepted", (ledger) => {
    ledger.status = "complete";
    ledger.acceptance = {
      status: "pass",
      confidence: 1,
      missing: [],
      reasons: ["All completion proof is present."],
      checkedAt: NOW.toISOString(),
    };
  });

  const projection = await loadLatestPersistedMissionRunProjection(
    harness.context,
  );

  assert.equal(projection?.runId, "run-older-incomplete");
});

test("startup hydration exposes unsafe WAL proof debt without a resume action", async () => {
  const harness = createVaultHarness();
  let journal = createOperationJournalRecord({
    operationId: "op-ambiguous",
    rootRunId: "run-unsafe-wal",
    segmentId: "run-unsafe-wal",
    toolName: "append_to_current_file",
    operation: "append",
    targetPath: "Research/Brief.md",
    now: NOW,
  });
  journal = transitionOperationJournalRecord(journal, "applying", {
    message: "Write dispatch started.",
    now: new Date(NOW.getTime() + 1_000),
  });
  journal = transitionOperationJournalRecord(journal, "reconcile_required", {
    message: "Write result is ambiguous after restart.",
    mutationMayHaveApplied: true,
    now: new Date(NOW.getTime() + 2_000),
  });
  await seedRun(harness, "run-unsafe-wal", undefined, [journal]);

  const projection = await loadLatestPersistedMissionRunProjection(
    harness.context,
  );

  assert.ok(projection);
  assert.equal(projection.missionLedger.canResume, false);
  assert.equal(projection.missionLedger.blockerCategory, "safety_policy");
  assert.match(projection.missionLedger.nextAction, /reconcil/i);
});

test("startup hydration fails closed when the exact graph reference drifts", async () => {
  const harness = createVaultHarness();
  await seedRun(
    harness,
    "run-startup-drift",
    undefined,
    [],
    `sha256:${"f".repeat(64)}`,
  );

  await assert.rejects(
    loadLatestPersistedMissionRunProjection(harness.context),
    (error: unknown) => {
      assert.ok(error instanceof StartupMissionHydrationIntegrityError);
      assert.match(error.message, /recordFingerprint/);
      return true;
    },
  );
});

test("startup hydration fails closed when the referenced graph is missing", async () => {
  const harness = createVaultHarness();
  const seeded = await seedRun(harness, "run-startup-missing-graph");
  harness.files.delete(seeded.graph.path);

  await assert.rejects(
    loadLatestPersistedMissionRunProjection(harness.context),
    (error: unknown) => {
      assert.ok(error instanceof StartupMissionHydrationIntegrityError);
      assert.match(error.message, /missing/i);
      return true;
    },
  );
});

test("startup hydration keeps a waiting approval visible but non-resumable", async () => {
  const harness = createVaultHarness();
  await seedRun(
    harness,
    "run-startup-approval",
    undefined,
    [],
    undefined,
    "waiting_approval",
  );

  const projection = await loadLatestPersistedMissionRunProjection(
    harness.context,
  );

  assert.ok(projection);
  assert.equal(projection.missionGraph.nodes.read.status, "waiting_approval");
  assert.equal(projection.missionLedger.canResume, false);
  assert.equal(projection.missionLedger.blockerCategory, "safety_policy");
});

async function seedRun(
  harness: ReturnType<typeof createVaultHarness>,
  runId: string,
  mutateLedger?: (ledger: MissionLedger) => void,
  operationJournal: ReturnType<typeof createOperationJournalRecord>[] = [],
  referenceFingerprint?: string,
  graphStatus: "ready" | "waiting_approval" = "ready",
): Promise<{ graph: MissionGraphStoreWriteResult; ledger: MissionLedger }> {
  const graph = await persistInitialMissionGraph(
    harness.context,
    await createGraph(runId, graphStatus),
  );
  const ledger = createMissionLedger({
    runId,
    mission: "Resume this durable mission.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 4,
      toolStepBudget: 2,
      finalizationReserve: 1,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
    now: NOW,
  });
  ledger.nextActions = ["Verify the final artifact."];
  ledger.remainingActions = ["Verify the final artifact."];
  mutateLedger?.(ledger);
  await writeMissionLedger(harness.context, ledger);

  const reference = {
    version: 1 as const,
    missionId: graph.record.missionId,
    path: graph.path,
    storeRevision: graph.record.storeRevision,
    graphRevision: graph.record.graph.revision,
    recordFingerprint:
      referenceFingerprint ?? graph.record.recordFingerprint,
    journalHeadFingerprint: graph.record.graph.journalHeadFingerprint,
  };
  await writeMissionRuntimeSnapshot(
    harness.context,
    createMissionRuntimeSnapshot({
      runId,
      originalMission: ledger.mission,
      status: "paused",
      missionGraphRef: reference,
      operationJournal,
      createdAt: NOW,
      updatedAt: new Date(NOW.getTime() + 3_000),
    }),
  );
  return { graph, ledger };
}

async function createGraph(
  missionId: string,
  status: "ready" | "waiting_approval" = "ready",
): Promise<MissionGraphV3> {
  const timestamp = NOW.toISOString();
  const capabilityEnvelope = await buildMissionCapabilityEnvelopeV1({
    missionId,
    issuedAt: timestamp,
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
      web_search: {
        name: "web_search",
        effect: "read",
        capabilityIds: ["web.read"],
        executionHosts: ["obsidian_core"],
        bindingKinds: [],
      },
    },
    bindings: {},
    budgets: {
      maxNodes: 2,
      maxDepth: 2,
      maxConcurrentReadNodes: 1,
      maxTotalToolCalls: 1,
      maxExternalActions: 0,
      maxWallClockMs: 60_000,
      maxAttemptsPerNode: 2,
    },
  });
  return {
    schemaVersion: 3,
    missionId,
    objective: "Resume this durable mission.",
    revision: 0,
    journalHeadFingerprint: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    routing: {
      source: "deterministic",
      fallbackFrom: null,
      fallbackReason: null,
      confidence: 1,
      decidedAt: timestamp,
      decisionFingerprint: `sha256:${"1".repeat(64)}`,
    },
    continuationCheckpoint: null,
    capabilityEnvelope,
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
        allowedTools: ["web_search"],
        destination: null,
        resourceLocks: [],
        budget: { toolCalls: 1, externalActions: 0, wallClockMs: 5_000 },
        retries: {
          maxAttempts: 2,
          attempts: 0,
          failureFingerprints: [],
          consecutiveFailureFingerprint: null,
          consecutiveFailureCount: 0,
        },
        status,
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

function createVaultHarness(): {
  context: ToolExecutionContext;
  files: Map<string, string>;
  reads: string[];
  frontmatter: Map<string, Record<string, unknown>>;
} {
  const files = new Map<string, string>();
  const reads: string[] = [];
  const frontmatter = new Map<string, Record<string, unknown>>();
  const folders = new Set<string>();
  const mtimes = new Map<string, number>();
  let mtime = 1_000;
  const getFileByPath = (path: string) => {
    if (!files.has(path)) return null;
    const name = path.split("/").at(-1) ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.md$/i, ""),
      extension: name.split(".").at(-1)?.toLowerCase() ?? "",
      stat: { mtime: mtimes.get(path) ?? 0 },
    };
  };
  const vault = {
    getFileByPath,
    getFiles: () =>
      [...files.keys()]
        .map(getFileByPath)
        .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    getFolderByPath: (path: string) =>
      folders.has(path)
        ? { path, name: path.split("/").at(-1) ?? path }
        : null,
    createFolder: async (path: string) => {
      folders.add(path);
    },
    create: async (path: string, content: string) => {
      files.set(path, content);
      mtimes.set(path, ++mtime);
      return getFileByPath(path);
    },
    read: async (file: { path: string }) => {
      reads.push(file.path);
      return files.get(file.path) ?? "";
    },
    modify: async (file: { path: string }, content: string) => {
      files.set(file.path, content);
      mtimes.set(file.path, ++mtime);
    },
  };
  return {
    files,
    reads,
    frontmatter,
    context: {
      app: {
        vault,
        metadataCache: {
          getFileCache: (file: { path: string }) => {
            const cached = frontmatter.get(file.path);
            return cached ? { frontmatter: cached } : null;
          },
        },
      },
      settings: {},
      originalPrompt: "startup hydration test",
      httpTransport: {},
      now: () => new Date(NOW),
    } as unknown as ToolExecutionContext,
  };
}

test("startup hydration stops at the newest resumable run and never reads the older notes", async () => {
  // This scan runs in the immediate phase of plugin load. It used to read and
  // parse EVERY note under Agent Runs/ before returning; with three resumable
  // runs seeded, only the newest may be opened.
  const harness = createVaultHarness();
  await seedRun(harness, "run-startup-older-1");
  await seedRun(harness, "run-startup-older-2");
  await seedRun(harness, "run-startup-newest");

  const vault = harness.context.app.vault as unknown as {
    read: (file: { path: string }) => Promise<string>;
  };
  const readsByPath = new Map<string, number>();
  const originalRead = vault.read;
  vault.read = async (file) => {
    readsByPath.set(file.path, (readsByPath.get(file.path) ?? 0) + 1);
    return originalRead(file);
  };

  const projection = await loadLatestPersistedMissionRunProjection(
    harness.context,
  );

  assert.ok(projection);
  assert.equal(projection.runId, "run-startup-newest");
  const olderReads = [...readsByPath.entries()].filter(
    ([path, count]) =>
      /^Agent Runs\/run-startup-older-/.test(path) && count > 0,
  );
  assert.deepEqual(
    olderReads,
    [],
    `older run notes must not be read on the load path: ${JSON.stringify([...readsByPath])}`,
  );
});

test("terminal run notes announced by the metadata cache are skipped without a read", async () => {
  const { context, files, reads, frontmatter } = createVaultHarness();
  const write = (
    runId: string,
    status: "running" | "complete",
    createdAt: string,
  ) =>
    runStoreForStatusTest.writeMissionRuntimeSnapshot(
      context,
      runStoreForStatusTest.createMissionRuntimeSnapshot({
        runId,
        originalMission: `mission ${runId}`,
        status,
        createdAt: new Date(createdAt),
      }),
    );
  await write("run-old-running", "running", "2026-07-11T10:00:00.000Z");
  await writeMissionLedger(
    context,
    createMissionLedger({
      runId: "run-old-running",
      mission: "mission run-old-running",
      route: "grounded_workflow",
      loopBudget: {
        hardCap: 4,
        toolStepBudget: 2,
        finalizationReserve: 1,
        expectedTools: ["web_search"],
        stopWhenSatisfied: true,
      },
    }),
  );
  await write("run-new-complete-1", "complete", "2026-07-11T11:00:00.000Z");
  await write("run-new-complete-2", "complete", "2026-07-11T12:00:00.000Z");

  // The product wrote the status property in the same rewrite as the fence;
  // the metadata cache is what Obsidian would index from those bytes.
  for (const runId of ["run-new-complete-1", "run-new-complete-2"]) {
    const note = files.get(`Agent Runs/${runId}.md`) ?? "";
    assert.match(note, /^---\nagentic_run_status: complete\n---\n/);
    frontmatter.set(`Agent Runs/${runId}.md`, { agentic_run_status: "complete" });
  }
  // The ledger write spliced into the marked note without disturbing the
  // property (a ledger-only rewrite carries no status of its own).
  assert.match(
    files.get("Agent Runs/run-old-running.md") ?? "",
    /^---\nagentic_run_status: running\n---\n# Agent Run run-old-running\n/,
  );
  assert.match(files.get("Agent Runs/run-old-running.md") ?? "", /## Mission Ledger/);

  reads.length = 0;
  await loadLatestPersistedMissionRunProjection(context);
  assert.deepEqual(
    reads.filter((path) => path.startsWith("Agent Runs/run-new-complete")),
    [],
    `terminal notes were read on the load path: ${reads.join(", ")}`,
  );
  assert.ok(
    reads.includes("Agent Runs/run-old-running.md"),
    "the resumable note is still read",
  );

  // A missing (or stale) cache entry falls back to reading, never to skipping.
  frontmatter.delete("Agent Runs/run-new-complete-2.md");
  reads.length = 0;
  await loadLatestPersistedMissionRunProjection(context);
  assert.ok(reads.includes("Agent Runs/run-new-complete-2.md"));
  assert.ok(!reads.includes("Agent Runs/run-new-complete-1.md"));
});
