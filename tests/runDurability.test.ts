import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRunId } from "../src/agent/checkpoints";
import { extractRequestedRunId } from "../src/agent/missionResume";
import type { MissionPlan } from "../src/agent/missionPlan";
import {
  normalizeRecoveryState,
  type BoundedRecoveryAttempt,
} from "../src/agent/recoveryEngine";
import type { ResearchPlan } from "../src/agent/researchPlan";
import {
  buildOperationReconciliationInputs,
  createMissionRuntimeSnapshot,
  createOperationJournalRecord,
  formatMissionRuntimeSnapshotBlock,
  normalizeMissionRuntimeSnapshot,
  parseMissionRuntimeSnapshotFromMarkdown,
  readLatestIncompleteMissionRuntimeSnapshot,
  readMissionRuntimeSnapshotByRunId,
  transitionOperationJournalRecord,
  withSerializedRunWrite,
  writeMissionRuntimeSnapshot,
} from "../src/agent/runStore";
import type { ToolExecutionContext } from "../src/tools/types";

test("run ids retain milliseconds, add entropy, and remain resume-parser compatible", () => {
  const now = new Date("2026-07-10T12:34:56.123Z");
  const deterministic = createAgentRunId(now, "ABCDEF123456");
  const first = createAgentRunId(now);
  const second = createAgentRunId(now);

  assert.equal(
    deterministic,
    "run-2026-07-10T12-34-56.123Z-abcdef123456",
  );
  assert.notEqual(first, second);
  assert.equal(
    extractRequestedRunId(`continue run ${deterministic}`),
    deterministic,
  );
});

test("per-run write queue serializes operations without blocking other run ids", async () => {
  const vault = {};
  const order: string[] = [];
  let activeForRun = 0;
  let maxActiveForRun = 0;

  const operation = (label: string, runId: string) =>
    withSerializedRunWrite(vault, runId, async () => {
      if (label.startsWith("a")) {
        activeForRun += 1;
        maxActiveForRun = Math.max(maxActiveForRun, activeForRun);
      }
      order.push(`start:${label}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      order.push(`end:${label}`);
      if (label.startsWith("a")) {
        activeForRun -= 1;
      }
      return label;
    });

  const results = await Promise.all([
    operation("a1", "run:a"),
    operation("a2", "run-a"),
    operation("b1", "run-b"),
  ]);

  assert.deepEqual(results, ["a1", "a2", "b1"]);
  assert.equal(maxActiveForRun, 1);
  assert.ok(order.indexOf("end:a1") < order.indexOf("start:a2"));
});

test("runtime snapshots persist concurrently without replacing ledgers or checkpoints", async () => {
  const mock = createRuntimeSnapshotContext({
    "Agent Runs/run-persist.md": [
      "# Agent Run run-persist",
      "",
      "## Mission Ledger",
      "```json",
      '{"legacy":true}',
      "```",
      "",
      "## Step 1 - 2026-07-10T12:00:00.000Z",
      "",
      "checkpoint body",
      "",
    ].join("\n"),
  });
  const base = createMissionRuntimeSnapshot({
    runId: "run:persist",
    originalMission: "Persist and resume this mission.",
    status: "running",
    createdAt: new Date("2026-07-10T12:00:00.000Z"),
  });

  const first = await writeMissionRuntimeSnapshot(mock.context, base);
  assert.equal(first?.revision, 1);

  const paused = {
    ...base,
    status: "paused" as const,
    notes: ["paused snapshot"],
  };
  const blocked = {
    ...base,
    status: "blocked" as const,
    notes: ["blocked snapshot"],
  };
  const concurrent = await Promise.all([
    writeMissionRuntimeSnapshot(mock.context, paused),
    writeMissionRuntimeSnapshot(mock.context, blocked),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result?.revision),
    [2, 3],
  );

  const stored = await readMissionRuntimeSnapshotByRunId(
    mock.context,
    "run:persist",
  );
  assert.equal(stored?.snapshot.revision, 3);
  assert.equal(stored?.snapshot.status, "blocked");
  assert.deepEqual(stored?.snapshot.notes, ["blocked snapshot"]);

  const markdown = mock.files.get("Agent Runs/run-persist.md") ?? "";
  assert.equal((markdown.match(/## Runtime Snapshot/g) ?? []).length, 1);
  assert.match(markdown, /## Mission Ledger/);
  assert.match(markdown, /## Step 1/);
  assert.match(markdown, /checkpoint body/);

  const complete = createMissionRuntimeSnapshot({
    runId: "run-complete",
    originalMission: "Already complete.",
    status: "complete",
    createdAt: new Date("2026-07-10T12:10:00.000Z"),
  });
  await writeMissionRuntimeSnapshot(mock.context, complete);
  const latestIncomplete =
    await readLatestIncompleteMissionRuntimeSnapshot(mock.context);
  assert.equal(latestIncomplete?.snapshot.runId, "run:persist");
  assert.equal(latestIncomplete?.snapshot.status, "blocked");
});

test("runtime snapshot v2 round-trips complete resumable mission state", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const missionPlan = createMissionPlanFixture(now);
  const researchPlan = createResearchPlanFixture();
  const recovery = normalizeRecoveryState(
    {
      attempts: [createRecoveryAttempt(1), createRecoveryAttempt(2)],
      maxAttempts: 3,
    },
    { maxStoredAttempts: 8, now },
  );
  let journal = createOperationJournalRecord({
    operationId: "op-1",
    rootRunId: "run-root",
    segmentId: "run-segment-2",
    nodeId: "task-1",
    toolName: "append_to_current_file",
    operation: "append",
    targetPath: "Research/Brief.md",
    inputHash: "input-hash",
    preWriteHash: "before-hash",
    now,
  });
  journal = transitionOperationJournalRecord(journal, "applying", {
    message: "Tool execution started.",
    now: new Date("2026-07-10T12:00:01.000Z"),
  });

  const snapshot = createMissionRuntimeSnapshot({
    runId: "run-segment-2",
    rootRunId: "run-root",
    segmentId: "run-segment-2",
    segmentIndex: 2,
    parentSegmentId: "run-segment-1",
    priorSegmentIds: ["run-root", "run-segment-1"],
    originalMission: "Research durable agent runtimes and append a brief.",
    currentNotePath: "  Research/Brief.md/  ",
    revision: 7,
    lastSafeStep: 18,
    missionPlan,
    researchPlan,
    evidence: [
      {
        id: "web:1",
        kind: "web_source",
        title: "Durable execution",
        url: "https://example.com/durable",
        sourceId: "source:durable",
        passageId: "source:durable:passage:0-128",
        passageIds: [
          "source:durable:passage:0-128",
          "source:durable:passage:256-384",
        ],
        summary: "A source about durable execution.",
        confidence: "high",
      },
    ],
    receipts: [
      {
        toolName: "append_to_current_file",
        operation: "append",
        message: "append Research/Brief.md",
        path: "Research/Brief.md",
        bytesWritten: 42,
      },
    ],
    operationGoals: {
      current_note_content: "completed",
    },
    recovery,
    operationJournal: [journal],
    acceptance: {
      status: "needs_more_work",
      confidence: 0.7,
      missing: ["source_diversity"],
      reasons: ["research_acceptance_incomplete"],
      nextAction: "Fetch an independent source.",
    },
    notes: ["Continue with an independent source."],
    createdAt: now,
    updatedAt: new Date("2026-07-10T12:05:00.000Z"),
  });

  const restored = normalizeMissionRuntimeSnapshot(
    JSON.parse(JSON.stringify(snapshot)),
  );

  assert.equal(restored?.version, 2);
  assert.equal(restored?.revision, 7);
  assert.equal(restored?.originalMission, snapshot.originalMission);
  assert.equal(restored?.currentNotePath, "Research/Brief.md");
  assert.equal(restored?.lineage.rootRunId, "run-root");
  assert.equal(restored?.lineage.segmentIndex, 2);
  assert.equal(restored?.missionPlan?.version, 2);
  assert.equal(restored?.researchPlan?.mode, "deep_hybrid");
  assert.equal(restored?.evidence[0].id, "web:1");
  assert.equal(restored?.evidence[0].sourceId, "source:durable");
  assert.deepEqual(restored?.evidence[0].passageIds, [
    "source:durable:passage:0-128",
    "source:durable:passage:256-384",
  ]);
  assert.equal(restored?.receipts[0].bytesWritten, 42);
  assert.equal(restored?.operationGoals.current_note_content, "completed");
  assert.equal(restored?.recovery.totalAttempts, 2);
  assert.equal(restored?.operationJournal[0].state, "applying");
  assert.equal(restored?.acceptance?.missing[0], "source_diversity");

  const markdown = formatMissionRuntimeSnapshotBlock(snapshot);
  assert.equal(
    parseMissionRuntimeSnapshotFromMarkdown(markdown)?.currentNotePath,
    "Research/Brief.md",
  );
});

test("runtime snapshots omit unsafe or non-markdown current note paths", () => {
  const unsafePaths = [
    "../Secrets.md",
    "C:/Secrets.md",
    "Research\\Brief.md",
    ".obsidian/Secrets.md",
    "Research/Brief.txt",
    "   ",
  ];

  for (const currentNotePath of unsafePaths) {
    const snapshot = createMissionRuntimeSnapshot({
      runId: "run-unsafe-path",
      originalMission: "Do not retain an unsafe note target.",
      currentNotePath,
    });
    assert.equal(snapshot.currentNotePath, undefined, currentNotePath);
    assert.doesNotMatch(
      formatMissionRuntimeSnapshotBlock(snapshot),
      /currentNotePath/,
      currentNotePath,
    );

    const normalized = normalizeMissionRuntimeSnapshot({
      ...snapshot,
      currentNotePath,
    });
    assert.equal(normalized?.currentNotePath, undefined, currentNotePath);
  }
});

test("legacy continuation bundles migrate without fabricating unavailable proof", () => {
  const restored = normalizeMissionRuntimeSnapshot({
    version: 1,
    runId: "run-legacy",
    prompt: "Continue the legacy research mission.",
    createdAt: "2026-07-10T12:00:00.000Z",
    recovery: {
      attempts: 5,
      lastAction: "replan",
      lastReason: "timeout",
    },
    notes: ["Legacy note"],
  });

  assert.equal(restored?.version, 2);
  assert.equal(restored?.status, "paused");
  assert.equal(restored?.originalMission, "Continue the legacy research mission.");
  assert.equal(restored?.recovery.totalAttempts, 5);
  assert.deepEqual(restored?.evidence, []);
  assert.deepEqual(restored?.receipts, []);
  assert.equal(restored?.missionPlan, undefined);
  assert.equal(restored?.currentNotePath, undefined);
});

test("write-ahead journal exposes safe reconciliation inputs", () => {
  const intent = createOperationJournalRecord({
    operationId: "op-intent",
    rootRunId: "run-root",
    segmentId: "segment-1",
    toolName: "replace_current_file",
    operation: "replace",
    targetPath: "Current.md",
    preWriteHash: "before",
    expectedPostWriteHash: "after",
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  const applying = transitionOperationJournalRecord(intent, "applying", {
    message: "Execution began before process interruption.",
    mutationMayHaveApplied: true,
    now: new Date("2026-07-10T12:00:01.000Z"),
  });
  const reconciliation = buildOperationReconciliationInputs([intent, applying]);

  assert.equal(reconciliation[0].recommendedAction, "safe_to_retry");
  assert.equal(reconciliation[1].recommendedAction, "inspect_target");
  assert.throws(() =>
    transitionOperationJournalRecord(intent, "committed", {
      message: "Cannot skip apply and verify.",
    }),
  );
});

test("recovery normalization bounds persisted history while preserving counters", () => {
  const attempts = Array.from({ length: 20 }, (_, index) =>
    createRecoveryAttempt(index + 1),
  );
  const state = normalizeRecoveryState(
    {
      attempts,
      maxAttempts: 3,
      maxStoredAttempts: 4,
      totalAttempts: 20,
    },
    { now: new Date("2026-07-10T12:30:00.000Z") },
  );

  assert.equal(state.version, 1);
  assert.equal(state.attempts.length, 4);
  assert.equal(state.totalAttempts, 20);
  assert.equal(state.signatureCounts["web_fetch:timeout"], 20);
});

function createRecoveryAttempt(index: number): BoundedRecoveryAttempt {
  return {
    signature: "web_fetch:timeout",
    action: index === 1 ? "retry" : "replan",
    reason: "Recover from web fetch timeout.",
    createdAt: new Date(Date.UTC(2026, 6, 10, 12, index)).toISOString(),
  };
}

function createMissionPlanFixture(now: Date): MissionPlan {
  return {
    version: 1,
    runId: "run-segment-2",
    status: "in_progress",
    activeTaskId: "task-1",
    tasks: [
      {
        id: "task-1",
        title: "Gather durable execution evidence",
        status: "in_progress",
        allowedTools: ["web_search", "web_fetch"],
        dependencies: [],
        evidenceIds: ["web:1"],
        receiptIds: [],
        completionContract: {
          requiredProof: ["web_evidence"],
          minEvidenceCount: 2,
        },
      },
    ],
    progress: {
      score: 0.5,
      completedTasks: 0,
      totalTasks: 1,
      remainingTasks: 1,
      stalledCount: 0,
    },
    nextAction: {
      kind: "tool",
      taskId: "task-1",
      toolName: "web_fetch",
      summary: "Fetch the next source.",
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function createResearchPlanFixture(): ResearchPlan {
  return {
    version: 1,
    mode: "deep_hybrid",
    sourceRequirements: {
      minFetchedSources: 3,
      minDistinctDomains: 2,
    },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "research-1",
        question: "How should long-running writes be reconciled?",
        requiredEvidenceType: "either",
        minEvidence: 2,
        status: "in_progress",
        evidenceIds: ["web:1"],
      },
    ],
    evidenceIds: ["web:1"],
    status: "in_progress",
    nextAction: {
      toolName: "web_fetch",
      subquestionId: "research-1",
      reason: "Fetch an independent source.",
    },
  };
}

function createRuntimeSnapshotContext(
  initialFiles: Record<string, string> = {},
): {
  context: ToolExecutionContext;
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initialFiles));
  const folders = new Set<string>(["Agent Runs"]);
  const mtimes = new Map<string, number>();
  let mtime = 1000;
  for (const path of files.keys()) {
    mtimes.set(path, ++mtime);
  }

  const getFileByPath = (path: string) => {
    if (!files.has(path)) {
      return null;
    }
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.md$/i, ""),
      extension: name.split(".").pop()?.toLowerCase() ?? "",
      stat: { mtime: mtimes.get(path) ?? 0 },
    };
  };

  const context = {
    app: {
      vault: {
        getFolderByPath: (path: string) =>
          folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
        createFolder: async (path: string) => {
          folders.add(path);
        },
        getFileByPath,
        getFiles: () =>
          [...files.keys()]
            .map(getFileByPath)
            .filter((file): file is NonNullable<typeof file> => Boolean(file)),
        create: async (path: string, content: string) => {
          files.set(path, content);
          mtimes.set(path, ++mtime);
        },
        read: async (file: { path: string }) => files.get(file.path) ?? "",
        modify: async (file: { path: string }, content: string) => {
          files.set(file.path, content);
          mtimes.set(file.path, ++mtime);
        },
      },
    },
    now: () => new Date("2026-07-10T12:30:00.000Z"),
  } as unknown as ToolExecutionContext;

  return { context, files };
}
