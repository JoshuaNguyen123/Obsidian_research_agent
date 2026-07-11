import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceDurableMissionRetryState,
  canClaimDurableMissionLease,
  computeDurableMissionDeadline,
  createDurableMissionLease,
  createDurableMissionManifest,
  getDurableMissionRecoverability,
  getDurableMissionRetryDelayMs,
  hasDurableMissionDeadlineElapsed,
  isDurableMissionLeaseLive,
  isDurableMissionRetryExhausted,
  normalizeDurableMissionManifest,
  normalizeDurableMissionPolicy,
  type DurableMissionManifestV1,
  type DurableMissionRetryState,
} from "../src/agent/durableMission";
import {
  DurableMissionRevisionConflictError,
  formatDurableMissionManifestBlock,
  getDurableMissionManifestPath,
  listDurableMissionManifests,
  listRecoverableDurableMissions,
  parseDurableMissionManifestFromMarkdown,
  readDurableMissionManifestById,
  writeDurableMissionManifest,
} from "../src/agent/durableMissionStore";
import { reduceDurableMissionTransition } from "../src/agent/durableMissionSupervisor";
import { createNoopKeepAwakeController } from "../src/platform/keepAwake";
import type { ToolExecutionContext } from "../src/tools/types";

test("durable mission policy defaults to ten hours and clamps all hard caps", () => {
  const defaults = normalizeDurableMissionPolicy(undefined);
  assert.equal(defaults.durationHours, 10);
  assert.equal(defaults.maxSegments, 24);
  assert.equal(defaults.maxModelSteps, 2_400);
  assert.equal(defaults.maxToolCalls, 4_800);

  const minimum = normalizeDurableMissionPolicy({
    durationHours: 1,
    maxSegments: 0,
    maxModelSteps: 0,
    maxToolCalls: 0,
  });
  assert.equal(minimum.durationHours, 8);
  assert.equal(minimum.maxSegments, 1);
  assert.equal(minimum.maxModelSteps, 1);
  assert.equal(minimum.maxToolCalls, 1);

  const maximum = normalizeDurableMissionPolicy({
    durationHours: 99,
    maxSegments: 999,
    maxModelSteps: 9_999,
    maxToolCalls: 9_999,
    heartbeatIntervalMs: 10 * 60_000,
  });
  assert.equal(maximum.durationHours, 12);
  assert.equal(maximum.maxSegments, 24);
  assert.equal(maximum.maxModelSteps, 2_400);
  assert.equal(maximum.maxToolCalls, 4_800);
  assert.ok(maximum.leaseDurationMs >= maximum.heartbeatIntervalMs);
});

test("durable mission manifests round-trip and reject malformed durable state", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const manifest = createDurableMissionManifest({
    missionId: "mission:overnight",
    rootMissionId: "root:overnight",
    prompt: "Research durable Obsidian agents overnight.",
    currentNotePath: " Research/Overnight.md ",
    keepAwakeRequested: true,
    createdAt: now,
  });
  manifest.lease = createDurableMissionLease({
    ownerId: "plugin-window-1",
    now,
  });

  const markdown = `# Mission\n\n${formatDurableMissionManifestBlock(manifest)}`;
  const restored = parseDurableMissionManifestFromMarkdown(markdown);
  assert.equal(restored?.version, 1);
  assert.equal(restored?.missionId, "mission:overnight");
  assert.equal(restored?.currentNotePath, "Research/Overnight.md");
  assert.equal(restored?.deadlineAt, "2026-07-10T22:00:00.000Z");
  assert.equal(restored?.keepAwake.requested, true);
  assert.equal(restored?.lease?.ownerId, "plugin-window-1");
  assert.equal(
    getDurableMissionManifestPath("mission:overnight"),
    "Agent Runs/Missions/mission-overnight.md",
  );

  assert.equal(
    normalizeDurableMissionManifest({ ...manifest, status: "sleeping" }),
    null,
  );
  assert.equal(
    normalizeDurableMissionManifest({
      ...manifest,
      lease: { ownerId: "owner", expiresAt: "not-a-date" },
    }),
    null,
  );
  assert.equal(
    parseDurableMissionManifestFromMarkdown(
      "## Durable Mission Manifest\n```json\n{broken}\n```\n",
    ),
    null,
  );

  const unsafeNote = normalizeDurableMissionManifest({
    ...manifest,
    currentNotePath: "../Secrets.md",
  });
  assert.equal(unsafeNote?.currentNotePath, undefined);
});

test("persisted durable manifests fail closed instead of resetting accounting", () => {
  const createdAt = new Date("2026-07-10T12:00:00.000Z");
  const manifest = createDurableMissionManifest({
    missionId: "mission:strict-recovery",
    prompt: "Never expand recovery budgets from corrupt persisted state.",
    createdAt,
  });
  manifest.revision = 9;
  manifest.usage = { segments: 4, modelSteps: 211, toolCalls: 37 };
  manifest.lineage = {
    currentSegmentId: "segment-4",
    segmentIndex: 4,
    childSegmentIds: ["segment-1", "segment-2", "segment-3", "segment-4"],
  };

  const corruptions: Array<{
    name: string;
    mutate: (persisted: Record<string, unknown>) => void;
  }> = [
    {
      name: "missing revision",
      mutate: (persisted) => delete persisted.revision,
    },
    {
      name: "fractional revision",
      mutate: (persisted) => {
        persisted.revision = 8.5;
      },
    },
    {
      name: "missing usage counter",
      mutate: (persisted) => {
        delete (persisted.usage as Record<string, unknown>).modelSteps;
      },
    },
    {
      name: "negative usage counter",
      mutate: (persisted) => {
        (persisted.usage as Record<string, unknown>).toolCalls = -1;
      },
    },
    {
      name: "missing lineage index",
      mutate: (persisted) => {
        delete (persisted.lineage as Record<string, unknown>).segmentIndex;
      },
    },
    {
      name: "invalid lineage id",
      mutate: (persisted) => {
        (persisted.lineage as Record<string, unknown>).childSegmentIds = [
          "segment-1",
          2,
        ];
      },
    },
    {
      name: "missing policy cap",
      mutate: (persisted) => {
        delete (persisted.policy as Record<string, unknown>).maxModelSteps;
      },
    },
    {
      name: "expanded policy cap",
      mutate: (persisted) => {
        (persisted.policy as Record<string, unknown>).maxToolCalls = 4_801;
      },
    },
    {
      name: "invalid retry counter",
      mutate: (persisted) => {
        (persisted.retry as Record<string, unknown>).consecutiveFailures = "0";
      },
    },
  ];

  for (const { name, mutate } of corruptions) {
    const persisted = JSON.parse(JSON.stringify(manifest)) as Record<
      string,
      unknown
    >;
    mutate(persisted);
    assert.equal(normalizeDurableMissionManifest(persisted), null, name);
    assert.equal(
      parseDurableMissionManifestFromMarkdown(
        `## Durable Mission Manifest\n\`\`\`json\n${JSON.stringify(persisted)}\n\`\`\`\n`,
      ),
      null,
      `${name} persisted block`,
    );
  }
});

test("persisted durable deadlines must match their bounded duration policy", () => {
  const createdAt = new Date("2026-07-10T12:00:00.000Z");
  const manifest = createDurableMissionManifest({
    missionId: "mission:strict-deadline",
    prompt: "Keep the absolute deadline bounded.",
    durationHours: 8,
    createdAt,
  });
  assert.ok(normalizeDurableMissionManifest(manifest));

  assert.equal(
    normalizeDurableMissionManifest({
      ...manifest,
      deadlineAt: new Date(createdAt.getTime() + 7 * 60 * 60 * 1_000).toISOString(),
    }),
    null,
  );
  assert.equal(
    normalizeDurableMissionManifest({
      ...manifest,
      deadlineAt: new Date(createdAt.getTime() + 13 * 60 * 60 * 1_000).toISOString(),
    }),
    null,
  );
  assert.equal(
    normalizeDurableMissionManifest({
      ...manifest,
      deadlineAt: new Date(createdAt.getTime() + 10 * 60 * 60 * 1_000).toISOString(),
    }),
    null,
    "deadline cannot silently exceed the persisted eight-hour policy",
  );

  const twelveHours = createDurableMissionManifest({
    missionId: "mission:twelve-hours",
    prompt: "Exercise the maximum supported duration.",
    durationHours: 12,
    createdAt,
  });
  assert.ok(normalizeDurableMissionManifest(twelveHours));
});

test("deadlines, leases, retry timing, and recoverability are deterministic", () => {
  const start = new Date("2026-07-10T12:00:00.000Z");
  assert.equal(
    computeDurableMissionDeadline(start, 1),
    "2026-07-10T20:00:00.000Z",
  );
  assert.equal(
    computeDurableMissionDeadline(start, 99),
    "2026-07-11T00:00:00.000Z",
  );

  const manifest = createDurableMissionManifest({
    missionId: "mission-lease",
    prompt: "Test durable ownership.",
    createdAt: start,
  });
  assert.equal(
    hasDurableMissionDeadlineElapsed(
      manifest,
      new Date("2026-07-10T21:59:59.999Z"),
    ),
    false,
  );
  assert.equal(
    hasDurableMissionDeadlineElapsed(
      manifest,
      new Date("2026-07-10T22:00:00.000Z"),
    ),
    true,
  );

  manifest.lease = createDurableMissionLease({
    ownerId: "owner-a",
    now: start,
  });
  const beforeExpiry = new Date("2026-07-10T12:04:59.999Z");
  const atExpiry = new Date("2026-07-10T12:05:00.000Z");
  assert.equal(isDurableMissionLeaseLive(manifest.lease, beforeExpiry), true);
  assert.equal(isDurableMissionLeaseLive(manifest.lease, atExpiry), false);
  assert.equal(canClaimDurableMissionLease(manifest, "owner-b", beforeExpiry), false);
  assert.equal(canClaimDurableMissionLease(manifest, "owner-a", beforeExpiry), true);
  assert.equal(
    getDurableMissionRecoverability(manifest, beforeExpiry).reason,
    "live_lease",
  );
  assert.equal(getDurableMissionRecoverability(manifest, atExpiry).recoverable, true);

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(getDurableMissionRetryDelayMs),
    [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000],
  );
  let retry: DurableMissionRetryState = { consecutiveFailures: 0 };
  retry = advanceDurableMissionRetryState(retry, {
    now: start,
    errorCode: "http_503",
  });
  manifest.lease = undefined;
  manifest.status = "backing_off";
  manifest.retry = retry;
  const pending = getDurableMissionRecoverability(manifest, start);
  assert.equal(pending.reason, "backoff_pending");
  assert.equal(pending.availableAt, "2026-07-10T12:00:30.000Z");
  assert.equal(
    getDurableMissionRecoverability(
      manifest,
      new Date("2026-07-10T12:00:30.000Z"),
    ).recoverable,
    true,
  );

  for (let index = 1; index < 12; index += 1) {
    retry = advanceDurableMissionRetryState(retry, { now: start });
  }
  assert.equal(retry.consecutiveFailures, 12);
  assert.equal(isDurableMissionRetryExhausted(retry, manifest.policy), true);
});

test("durable mission store enforces revisions and lists only recoverable jobs", async () => {
  const mock = createDurableMissionContext();
  const mission = createDurableMissionManifest({
    missionId: "mission:recoverable",
    prompt: "Resume after a plugin interruption.",
    status: "interrupted",
    createdAt: new Date("2026-07-10T12:00:00.000Z"),
  });
  const stale = cloneManifest(mission);

  const first = await writeDurableMissionManifest(mock.context, mission);
  assert.deepEqual(first, {
    path: "Agent Runs/Missions/mission-recoverable.md",
    bytesWritten: first?.bytesWritten,
    revision: 1,
  });
  assert.ok((first?.bytesWritten ?? 0) > 0);
  assert.equal(mock.folders.has("Agent Runs"), true);
  assert.equal(mock.folders.has("Agent Runs/Missions"), true);

  await assert.rejects(
    () => writeDurableMissionManifest(mock.context, stale),
    (error: unknown) => {
      assert.ok(error instanceof DurableMissionRevisionConflictError);
      assert.equal(error.expectedRevision, 0);
      assert.equal(error.actualRevision, 1);
      return true;
    },
  );

  mission.status = "running";
  const second = await writeDurableMissionManifest(mock.context, mission);
  assert.equal(second?.revision, 2);
  const loaded = await readDurableMissionManifestById(
    mock.context,
    "mission:recoverable",
  );
  assert.equal(loaded?.manifest.revision, 2);
  assert.equal(loaded?.manifest.status, "running");

  const completed = createDurableMissionManifest({
    missionId: "mission-complete",
    prompt: "This one is already complete.",
    status: "complete",
    createdAt: new Date("2026-07-10T12:05:00.000Z"),
  });
  await writeDurableMissionManifest(mock.context, completed);

  const recoverable = await listRecoverableDurableMissions(
    mock.context,
    new Date("2026-07-10T12:30:00.000Z"),
  );
  assert.deepEqual(
    recoverable.map((item) => item.manifest.missionId),
    ["mission:recoverable"],
  );
  assert.deepEqual(
    (await listDurableMissionManifests(mock.context)).map(
      (item) => item.manifest.missionId,
    ),
    ["mission-complete", "mission:recoverable"],
  );
  assert.equal(
    (
      mock.files
        .get("Agent Runs/Missions/mission-recoverable.md")
        ?.match(/## Durable Mission Manifest/g) ?? []
    ).length,
    1,
  );
});

test("supervisor reducer applies the documented safety-first decision order", () => {
  const transitionAt = new Date("2026-07-10T13:00:00.000Z");

  const expired = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T02:00:00.000Z"),
    { accepted: true, productive: true },
    transitionAt,
  );
  assert.equal(expired.decision.type, "deadline_reached");
  assert.equal(expired.manifest.status, "expired");

  const atBudget = createManifestAt("2026-07-10T12:00:00.000Z");
  atBudget.usage.segments = 23;
  const budget = reduceDurableMissionTransition(
    atBudget,
    { accepted: true, productive: true },
    transitionAt,
  );
  assert.equal(budget.decision.type, "accepted_complete");
  assert.equal(budget.manifest.status, "complete");
  assert.equal(budget.manifest.usage.segments, 24);

  const acceptedWithUnsafeWal = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T12:00:00.000Z"),
    {
      accepted: true,
      unsafeWal: { operationIds: ["accepted-op"] },
      productive: true,
    },
    transitionAt,
  );
  assert.equal(acceptedWithUnsafeWal.decision.type, "unsafe_wal");
  assert.equal(acceptedWithUnsafeWal.manifest.status, "blocked");
  assert.deepEqual(
    acceptedWithUnsafeWal.manifest.reconciliation.operationIds,
    ["accepted-op"],
  );

  const budgetWithUnsafeWalBase = createManifestAt(
    "2026-07-10T12:00:00.000Z",
  );
  budgetWithUnsafeWalBase.usage.segments = 23;
  const budgetWithUnsafeWal = reduceDurableMissionTransition(
    budgetWithUnsafeWalBase,
    { unsafeWal: { operationIds: ["budget-op"] }, productive: true },
    transitionAt,
  );
  assert.equal(budgetWithUnsafeWal.decision.type, "unsafe_wal");
  assert.deepEqual(
    budgetWithUnsafeWal.manifest.reconciliation.operationIds,
    ["budget-op"],
  );

  const unsafeWal = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T12:00:00.000Z"),
    {
      unsafeWal: { operationIds: ["op-1"] },
      approval: { id: "approval-1", summary: "Approve upload." },
      transientFailure: { code: "http_503" },
      productive: true,
    },
    transitionAt,
  );
  assert.equal(unsafeWal.decision.type, "unsafe_wal");
  assert.deepEqual(unsafeWal.manifest.reconciliation.operationIds, ["op-1"]);

  const approval = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T12:00:00.000Z"),
    {
      approval: { id: "approval-1", summary: "Approve upload." },
      transientFailure: { code: "http_503" },
      productive: true,
    },
    transitionAt,
  );
  assert.equal(approval.decision.type, "approval_required");
  assert.equal(approval.manifest.status, "paused_for_approval");

  const safety = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T12:00:00.000Z"),
    {
      safetyPause: { code: "unsafe_path", message: "Unsafe path blocked." },
      transientFailure: { code: "http_503" },
      productive: true,
    },
    transitionAt,
  );
  assert.equal(safety.decision.type, "safety_pause");
  assert.equal(safety.manifest.blocker?.code, "unsafe_path");

  const backingOff = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T12:00:00.000Z"),
    { transientFailure: { code: "http_503" }, productive: true },
    transitionAt,
  );
  assert.equal(backingOff.decision.type, "transient_backoff");
  assert.equal(backingOff.manifest.status, "backing_off");
  assert.equal(backingOff.decision.nextAttemptAt, "2026-07-10T13:00:30.000Z");

  const productiveBase = createManifestAt("2026-07-10T12:00:00.000Z");
  productiveBase.retry = advanceDurableMissionRetryState(productiveBase.retry, {
    now: new Date("2026-07-10T12:30:00.000Z"),
  });
  const productive = reduceDurableMissionTransition(
    productiveBase,
    { segmentId: "segment-2", modelSteps: 8, toolCalls: 3, productive: true },
    transitionAt,
  );
  assert.equal(productive.decision.type, "continue");
  assert.equal(productive.manifest.retry.consecutiveFailures, 0);
  assert.equal(productive.manifest.usage.modelSteps, 8);
  assert.deepEqual(productive.manifest.lineage.childSegmentIds, ["segment-2"]);

  const failureLimitBase = createManifestAt("2026-07-10T12:00:00.000Z");
  failureLimitBase.retry.consecutiveFailures = 11;
  const failureLimit = reduceDurableMissionTransition(
    failureLimitBase,
    { transientFailure: { code: "http_503" } },
    transitionAt,
  );
  assert.equal(failureLimit.decision.type, "transient_failure_limit");
  assert.equal(failureLimit.manifest.retry.consecutiveFailures, 12);

  const stalled = reduceDurableMissionTransition(
    createManifestAt("2026-07-10T12:00:00.000Z"),
    {},
    transitionAt,
  );
  assert.equal(stalled.decision.type, "no_productive_progress");
  assert.equal(stalled.manifest.status, "blocked");
});

test("no-op keep-awake controller never claims native protection", async () => {
  const controller = createNoopKeepAwakeController();
  assert.equal(controller.supported, false);
  const lease = await controller.acquire({ missionId: "mission-overnight" });
  assert.equal(lease.acquired, false);
  assert.equal(lease.released, false);
  assert.match(lease.warning ?? "", /unavailable/i);
  await lease.release();
  await lease.release();
  assert.equal(lease.released, true);
});

function createManifestAt(createdAt: string): DurableMissionManifestV1 {
  return createDurableMissionManifest({
    missionId: `mission-${createdAt}`,
    prompt: "Exercise the pure durable supervisor reducer.",
    status: "running",
    createdAt: new Date(createdAt),
  });
}

function cloneManifest(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  const clone = normalizeDurableMissionManifest(
    JSON.parse(JSON.stringify(manifest)),
  );
  assert.ok(clone);
  return clone;
}

function createDurableMissionContext(): {
  context: ToolExecutionContext;
  files: Map<string, string>;
  folders: Set<string>;
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const mtimes = new Map<string, number>();
  let mtime = 1_000;

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
          if (path === "Agent Runs/Missions" && !folders.has("Agent Runs")) {
            throw new Error("Parent folder does not exist.");
          }
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

  return { context, files, folders };
}
