import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceDurableMissionRetryState,
  createDurableMissionManifest,
  isDurableMissionRecoverable,
  normalizeDurableMissionManifest,
  type DurableMissionManifestV1,
} from "../src/agent/durableMission";
import type { DurableMissionManifestRepository } from "../src/agent/durableMissionSupervisor";
import {
  LiveDurableMissionRuntime,
  type DurableMissionRuntimeEvent,
  type DurableMissionRuntimeSegmentOutcome,
  type DurableMissionRuntimeTimer,
} from "../src/agent/durableMissionRuntime";
import type {
  KeepAwakeAcquireOptions,
  KeepAwakeController,
  KeepAwakeLease,
  KeepAwakeMode,
} from "../src/platform/keepAwake";

const START = "2026-07-10T12:00:00.000Z";

test("live durable runtime persists ownership, heartbeat, acceptance, and keep-awake cleanup", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);
  const keepAwake = new RecordingKeepAwakeController();
  const events: DurableMissionRuntimeEvent[] = [];
  const manifest = createDurableMissionManifest({
    missionId: "overnight-accepted",
    prompt: "Research until the evidence-backed result is accepted.",
    keepAwakeRequested: true,
    createdAt: timer.now(),
  });

  const runtime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    keepAwakeController: keepAwake,
    timer,
    onEvent: (event) => events.push(event),
    executor: {
      executeSegment: async (_current, options) => {
        assert.equal(options.remaining.segments, 24);
        assert.equal(options.remaining.modelSteps, 2_400);
        assert.equal(options.remaining.toolCalls, 4_800);
        assert.equal(options.remaining.wallClockMs, 10 * 60 * 60 * 1_000);
        await options.checkpointSegment("segment-1");
        await timer.advanceBy(2 * 60_000);
        return {
          segmentId: "segment-1",
          modelSteps: 18,
          toolCalls: 7,
          accepted: true,
          productive: true,
        };
      },
    },
  });

  const result = await runtime.run(manifest);

  assert.equal(result.status, "complete");
  assert.deepEqual(result.usage, {
    segments: 1,
    modelSteps: 18,
    toolCalls: 7,
  });
  assert.equal(result.lease, undefined);
  assert.equal(result.keepAwake.requested, true);
  assert.equal(result.keepAwake.active, false);
  assert.equal(keepAwake.acquireCount, 1);
  assert.equal(keepAwake.releaseCount, 1);
  assert.ok(events.some((event) => event.kind === "heartbeat"));
  assert.ok(
    repository.history.some(
      (item) =>
        item.status === "running" &&
        item.lease?.heartbeatAt === "2026-07-10T12:02:00.000Z",
    ),
  );
  assert.ok(
    repository.history.some(
      (item) =>
        item.usage.segments === 0 &&
        item.lineage.currentSegmentId === "segment-1",
    ),
  );
  assert.equal(runtime.isRunning(manifest.missionId), false);
});

test("continuation requires productive budget exhaustion and hard segment caps stop the loop", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);
  let executions = 0;
  const runtime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async (_manifest, options) => {
        executions += 1;
        assert.equal(options.remaining.segments, 4 - (executions - 1));
        if (executions < 3) {
          return {
            segmentId: `segment-${executions}`,
            modelSteps: 100,
            toolCalls: 10,
            productive: true,
            continuation: {
              recommended: true,
              stopReason: "step_budget",
            },
          };
        }
        return {
          segmentId: "segment-3",
          modelSteps: 40,
          toolCalls: 4,
          accepted: true,
        };
      },
    },
  });
  const accepted = createDurableMissionManifest({
    missionId: "productive-budget-continuation",
    prompt: "Continue only after productive bounded segments.",
    policy: { maxSegments: 4 },
    createdAt: timer.now(),
  });

  const acceptedResult = await runtime.run(accepted);
  assert.equal(acceptedResult.status, "complete");
  assert.equal(acceptedResult.usage.segments, 3);
  assert.equal(executions, 3);

  let ungroundedExecutions = 0;
  const noBudgetRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async () => {
        ungroundedExecutions += 1;
        return { productive: true };
      },
    },
  });
  const noBudgetResult = await noBudgetRuntime.run(
    createDurableMissionManifest({
      missionId: "productive-without-budget-stop",
      prompt: "Do not loop after an ordinary non-final response.",
      createdAt: timer.now(),
    }),
  );
  assert.equal(noBudgetResult.status, "blocked");
  assert.equal(noBudgetResult.blocker?.code, "no_productive_progress");
  assert.equal(ungroundedExecutions, 1);

  let cappedExecutions = 0;
  const cappedRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async () => {
        cappedExecutions += 1;
        return {
          modelSteps: 100,
          toolCalls: 10,
          productive: true,
          continuation: {
            recommended: true,
            stopReason: "budget",
          },
        };
      },
    },
  });
  const cappedResult = await cappedRuntime.run(
    createDurableMissionManifest({
      missionId: "hard-segment-cap",
      prompt: "Stop at the configured segment cap.",
      policy: { maxSegments: 2 },
      createdAt: timer.now(),
    }),
  );
  assert.equal(cappedResult.status, "blocked");
  assert.equal(cappedResult.blocker?.code, "segment_budget_exhausted");
  assert.equal(cappedResult.usage.segments, 2);
  assert.equal(cappedExecutions, 2);

  let resourceExecutions = 0;
  const resourceCappedRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async (_current, options) => {
        resourceExecutions += 1;
        assert.deepEqual(
          {
            modelSteps: options.remaining.modelSteps,
            toolCalls: options.remaining.toolCalls,
          },
          { modelSteps: 150, toolCalls: 15 },
        );
        return {
          modelSteps: 150,
          toolCalls: 15,
          productive: true,
          continuation: {
            recommended: true,
            stopReason: "step_budget",
          },
        };
      },
    },
  });
  const resourceCappedResult = await resourceCappedRuntime.run(
    createDurableMissionManifest({
      missionId: "hard-resource-cap",
      prompt: "Stop at the cumulative model and tool budgets.",
      policy: { maxModelSteps: 150, maxToolCalls: 15 },
      createdAt: timer.now(),
    }),
  );
  assert.equal(resourceCappedResult.status, "blocked");
  assert.equal(
    resourceCappedResult.blocker?.code,
    "model_step_budget_exhausted",
  );
  assert.equal(resourceExecutions, 1);
});

test("transient failures persist bounded backoff before a later accepted segment", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);
  let executions = 0;
  const runtime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async () => {
        executions += 1;
        if (executions === 1) {
          return {
            segmentId: "transient-segment",
            transientFailure: {
              code: "http_503",
              message: "Provider temporarily unavailable.",
            },
          };
        }
        return {
          segmentId: "recovered-segment",
          modelSteps: 12,
          toolCalls: 2,
          accepted: true,
        };
      },
    },
  });
  const result = await runtime.run(
    createDurableMissionManifest({
      missionId: "transient-backoff",
      prompt: "Retry transient provider failures safely.",
      createdAt: timer.now(),
    }),
  );

  assert.equal(result.status, "complete");
  assert.equal(executions, 2);
  assert.deepEqual(timer.sleepDelays, [30_000]);
  assert.equal(result.retry.consecutiveFailures, 0);
  assert.ok(
    repository.history.some(
      (item) =>
        item.status === "backing_off" &&
        item.retry.nextAttemptAt === "2026-07-10T12:00:30.000Z" &&
        item.lease === undefined,
    ),
  );
});

test("an interrupted backoff waits out the persisted retry window after reload", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);
  const manifest = createDurableMissionManifest({
    missionId: "interrupted-backoff",
    prompt: "Respect the persisted retry time after plugin reload.",
    createdAt: timer.now(),
  });
  manifest.status = "interrupted";
  manifest.retry = advanceDurableMissionRetryState(manifest.retry, {
    now: timer.now(),
    errorCode: "http_503",
    errorMessage: "Provider temporarily unavailable.",
  });
  await timer.advanceBy(5_000);

  let executedAt: string | undefined;
  const reloadedRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-after-reload",
    timer,
    executor: {
      executeSegment: async () => {
        executedAt = timer.now().toISOString();
        return {
          segmentId: "post-backoff-segment",
          modelSteps: 4,
          toolCalls: 1,
          accepted: true,
        };
      },
    },
  });

  const result = await reloadedRuntime.run(manifest);
  assert.equal(result.status, "complete");
  assert.deepEqual(timer.sleepDelays, [25_000]);
  assert.equal(executedAt, "2026-07-10T12:00:30.000Z");
  assert.ok(
    repository.history.some(
      (item) =>
        item.status === "backing_off" &&
        item.retry.nextAttemptAt === "2026-07-10T12:00:30.000Z",
    ),
  );
});

test("the absolute deadline aborts an in-flight segment and prevents a second segment", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);
  let executions = 0;
  const createdAt = new Date(
    timer.now().getTime() - 8 * 60 * 60 * 1_000 + 100,
  );
  const manifest = createDurableMissionManifest({
    missionId: "accelerated-deadline",
    prompt: "Exercise an accelerated absolute deadline.",
    durationHours: 8,
    createdAt,
  });
  const runtime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async (_current, options) => {
        executions += 1;
        assert.equal(options.remaining.wallClockMs, 100);
        await timer.advanceBy(100);
        assert.equal(options.signal.aborted, true);
        return {
          productive: true,
          continuation: {
            recommended: true,
            stopReason: "time_budget",
          },
        };
      },
    },
  });

  const result = await runtime.run(manifest);
  assert.equal(result.status, "expired");
  assert.equal(result.blocker?.code, "deadline_reached");
  assert.equal(result.usage.segments, 0);
  assert.equal(executions, 1);
});

test("user cancellation and plugin interruption persist different states, and interruption is reload-recoverable", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);

  const cancelledStarted = deferred<void>();
  const cancelledRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async (_manifest, options) => {
        cancelledStarted.resolve();
        await waitForAbort(options.signal);
        return { productive: false };
      },
    },
  });
  const cancelledManifest = createDurableMissionManifest({
    missionId: "cancelled-mission",
    prompt: "The user will cancel this mission.",
    createdAt: timer.now(),
  });
  const cancelledPromise = cancelledRuntime.run(cancelledManifest);
  await cancelledStarted.promise;
  const cancelledResult = await cancelledRuntime.cancel(
    cancelledManifest.missionId,
  );
  assert.equal((await cancelledPromise).status, "cancelled");
  assert.equal(cancelledResult?.status, "cancelled");
  assert.equal(
    isDurableMissionRecoverable(
      assertManifest(await repository.load(cancelledManifest.missionId)),
      timer.now(),
    ),
    false,
  );

  const interruptedStarted = deferred<void>();
  const interruptedRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async (_manifest, options) => {
        interruptedStarted.resolve();
        await waitForAbort(options.signal);
        return { productive: false };
      },
    },
  });
  const interruptedManifest = createDurableMissionManifest({
    missionId: "interrupted-mission",
    prompt: "Resume this mission after plugin reload.",
    createdAt: timer.now(),
  });
  const interruptedPromise = interruptedRuntime.run(interruptedManifest);
  await interruptedStarted.promise;
  await interruptedRuntime.interruptAll();
  const interruptedResult = await interruptedPromise;
  assert.equal(interruptedResult.status, "interrupted");
  assert.equal(interruptedResult.lease, undefined);
  assert.equal(
    isDurableMissionRecoverable(interruptedResult, timer.now()),
    true,
  );

  let resumedExecutions = 0;
  const reloadedRuntime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-b",
    timer,
    executor: {
      executeSegment: async () => {
        resumedExecutions += 1;
        return {
          segmentId: "post-reload-segment",
          modelSteps: 5,
          toolCalls: 1,
          accepted: true,
        };
      },
    },
  });
  const recovered = await reloadedRuntime.recoverLatest();
  assert.equal(recovered?.missionId, interruptedManifest.missionId);
  assert.equal(recovered?.status, "complete");
  assert.equal(resumedExecutions, 1);
});

test("approval, unsafe WAL, and safety blockers pause without autonomous continuation", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);

  const approval = await runSingleOutcome(
    repository,
    timer,
    "approval-pause",
    {
      approval: {
        id: "approval-1",
        summary: "Approve external upload.",
      },
      productive: true,
      continuation: {
        recommended: true,
        stopReason: "budget",
      },
    },
  );
  assert.equal(approval.status, "paused_for_approval");
  assert.equal(approval.pendingApproval?.id, "approval-1");
  assert.equal(approval.lease, undefined);

  const unsafeWal = await runSingleOutcome(
    repository,
    timer,
    "unsafe-wal-pause",
    {
      unsafeWal: {
        operationIds: ["op-1"],
        message: "Reconcile the note write before resuming.",
      },
      productive: true,
      continuation: {
        recommended: true,
        stopReason: "budget",
      },
    },
  );
  assert.equal(unsafeWal.status, "blocked");
  assert.equal(unsafeWal.blocker?.code, "unsafe_wal");
  assert.equal(unsafeWal.reconciliation.status, "required");

  const safety = await runSingleOutcome(
    repository,
    timer,
    "safety-pause",
    {
      safetyPause: {
        code: "unsafe_path",
        message: "Unsafe vault path rejected.",
      },
      productive: true,
      continuation: {
        recommended: true,
        stopReason: "budget",
      },
    },
  );
  assert.equal(safety.status, "blocked");
  assert.equal(safety.blocker?.code, "unsafe_path");
});

test("child safety checkpoints persist approval ordering and unsafe WAL immediately", async () => {
  const repository = new MemoryManifestRepository();
  const timer = new ManualRuntimeTimer(START);
  const runtime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async (_manifest, options) => {
        await options.checkpointSafetyState({
          approval: { id: "approval-live", summary: "Approve mutation" },
        });
        assert.equal(repository.history.at(-1)?.pendingApproval?.id, "approval-live");
        await options.checkpointSafetyState({ clearApprovalId: "approval-live" });
        assert.equal(repository.history.at(-1)?.pendingApproval, undefined);
        await options.checkpointSafetyState({
          unsafeWal: {
            operationIds: ["op-live"],
            message: "Inspect the applying write.",
          },
        });
        assert.deepEqual(repository.history.at(-1)?.reconciliation.operationIds, [
          "op-live",
        ]);
        return {
          unsafeWal: {
            operationIds: ["op-live"],
            message: "Inspect the applying write.",
          },
        };
      },
    },
  });

  const result = await runtime.run(
    createDurableMissionManifest({
      missionId: "live-safety-checkpoint",
      prompt: "Persist safety checkpoints.",
      createdAt: timer.now(),
    }),
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.blocker?.code, "unsafe_wal");
});

async function runSingleOutcome(
  repository: MemoryManifestRepository,
  timer: ManualRuntimeTimer,
  missionId: string,
  outcome: DurableMissionRuntimeSegmentOutcome,
): Promise<DurableMissionManifestV1> {
  let executions = 0;
  const runtime = new LiveDurableMissionRuntime({
    repository,
    ownerId: "window-a",
    timer,
    executor: {
      executeSegment: async () => {
        executions += 1;
        return outcome;
      },
    },
  });
  const result = await runtime.run(
    createDurableMissionManifest({
      missionId,
      prompt: `Exercise ${missionId}.`,
      createdAt: timer.now(),
    }),
  );
  assert.equal(executions, 1);
  return result;
}

class MemoryManifestRepository implements DurableMissionManifestRepository {
  readonly history: DurableMissionManifestV1[] = [];
  private readonly manifests = new Map<string, DurableMissionManifestV1>();

  async load(missionId: string): Promise<DurableMissionManifestV1 | null> {
    const manifest = this.manifests.get(missionId);
    return manifest ? cloneManifest(manifest) : null;
  }

  async save(
    manifest: DurableMissionManifestV1,
    expectedRevision: number,
  ): Promise<DurableMissionManifestV1> {
    const actualRevision = this.manifests.get(manifest.missionId)?.revision ?? 0;
    assert.equal(
      expectedRevision,
      actualRevision,
      `revision conflict for ${manifest.missionId}`,
    );
    const saved = cloneManifest(manifest);
    saved.revision = actualRevision + 1;
    this.manifests.set(saved.missionId, cloneManifest(saved));
    this.history.push(cloneManifest(saved));
    return cloneManifest(saved);
  }

  async listRecoverable(now: Date): Promise<DurableMissionManifestV1[]> {
    return [...this.manifests.values()]
      .filter((manifest) => isDurableMissionRecoverable(manifest, now))
      .sort(
        (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )
      .map(cloneManifest);
  }
}

class ManualRuntimeTimer implements DurableMissionRuntimeTimer {
  readonly sleepDelays: number[] = [];
  private nowMs: number;
  private nextHandle = 1;
  private readonly timeouts = new Map<
    number,
    { at: number; handler: () => void | Promise<void> }
  >();
  private readonly intervals = new Map<
    number,
    { intervalMs: number; nextAt: number; handler: () => void | Promise<void> }
  >();

  constructor(now: string) {
    this.nowMs = Date.parse(now);
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.sleepDelays.push(delayMs);
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    await this.advanceBy(delayMs);
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  }

  setTimeout(
    handler: () => void | Promise<void>,
    delayMs: number,
  ): number {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, {
      at: this.nowMs + Math.max(0, delayMs),
      handler,
    });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(Number(handle));
  }

  setInterval(
    handler: () => void | Promise<void>,
    intervalMs: number,
  ): number {
    const handle = this.nextHandle++;
    this.intervals.set(handle, {
      intervalMs,
      nextAt: this.nowMs + intervalMs,
      handler,
    });
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(Number(handle));
  }

  async advanceBy(delayMs: number): Promise<void> {
    const target = this.nowMs + delayMs;
    while (true) {
      const nextDue = this.getNextDueAt(target);
      if (nextDue === undefined) {
        break;
      }
      this.nowMs = nextDue;
      for (const [handle, timeout] of [...this.timeouts.entries()]) {
        if (timeout.at <= this.nowMs) {
          this.timeouts.delete(handle);
          await timeout.handler();
        }
      }
      for (const interval of this.intervals.values()) {
        while (interval.nextAt <= this.nowMs) {
          interval.nextAt += interval.intervalMs;
          await interval.handler();
        }
      }
    }
    this.nowMs = target;
  }

  private getNextDueAt(target: number): number | undefined {
    const due = [
      ...[...this.timeouts.values()].map((item) => item.at),
      ...[...this.intervals.values()].map((item) => item.nextAt),
    ].filter((at) => at <= target && at >= this.nowMs);
    return due.length > 0 ? Math.min(...due) : undefined;
  }
}

class RecordingKeepAwakeController implements KeepAwakeController {
  readonly supported = true;
  acquireCount = 0;
  releaseCount = 0;

  async acquire(options: KeepAwakeAcquireOptions): Promise<KeepAwakeLease> {
    this.acquireCount += 1;
    return new RecordingKeepAwakeLease(options.missionId, this);
  }
}

class RecordingKeepAwakeLease implements KeepAwakeLease {
  readonly id: string;
  readonly mode: KeepAwakeMode = "prevent-app-suspension";
  readonly acquired = true;
  private isReleased = false;

  constructor(
    readonly missionId: string,
    private readonly owner: RecordingKeepAwakeController,
  ) {
    this.id = `lease:${missionId}`;
  }

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    if (this.isReleased) {
      return;
    }
    this.isReleased = true;
    this.owner.releaseCount += 1;
  }
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

function assertManifest(
  manifest: DurableMissionManifestV1 | null,
): DurableMissionManifestV1 {
  assert.ok(manifest);
  return manifest;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });
}
