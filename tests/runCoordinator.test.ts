import assert from "node:assert/strict";
import test from "node:test";
import { RunAlreadyActiveError, RunCoordinator } from "../src/agent/runCoordinator";

test("run coordinator enforces single flight and returns the runner outcome", async () => {
  const coordinator = new RunCoordinator();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const active = coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({ runId: "run-1" } as never);
    await gate;
    events.onRunComplete?.({ step: 3, maxSteps: 10, stopReason: "final" });
  });

  assert.equal(coordinator.isRunning(), true);
  assert.throws(
    () => coordinator.start(async () => undefined),
    RunAlreadyActiveError,
  );
  release?.();
  assert.deepEqual(await active, {
    runId: "run-1",
    step: 3,
    maxSteps: 10,
    stopReason: "final",
  });
  assert.equal(coordinator.isRunning(), false);
});

test("run coordinator replays buffered events to a replacement view", async () => {
  const coordinator = new RunCoordinator();
  const seen: string[] = [];
  await coordinator.start(async (_signal, events) => {
    events.onStatus?.("working");
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  coordinator.subscribe(
    {
      onStatus: (message) => seen.push(message),
      onRunComplete: (event) => seen.push(event.stopReason),
    },
    { replay: true },
  );
  assert.deepEqual(seen, ["working", "final"]);
});

test("run coordinator cancellation reaches the active executor", async () => {
  const coordinator = new RunCoordinator();
  const active = coordinator.start(async (signal, events) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    events.onRunComplete?.({
      step: 2,
      maxSteps: 10,
      stopReason: "user_stopped",
    });
  });

  assert.equal(coordinator.requestStop(), true);
  assert.equal(coordinator.getSnapshot().state, "stopping");
  assert.equal((await active).stopReason, "user_stopped");
  assert.equal(coordinator.getSnapshot().state, "idle");
});

test("run coordinator publishes a fallback completion when an aborted executor returns silently", async () => {
  const coordinator = new RunCoordinator();
  const completions: string[] = [];
  coordinator.subscribe({
    onRunComplete: (event) => completions.push(event.stopReason),
  });
  const active = coordinator.start(async (signal, events) => {
    events.onRunConfig?.({
      runId: "run-silent-stop",
      maxStepsForRun: 24,
    } as never);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  assert.equal(coordinator.requestStop(), true);
  assert.deepEqual(await active, {
    runId: "run-silent-stop",
    step: 0,
    maxSteps: 24,
    stopReason: "user_stopped",
  });
  assert.deepEqual(completions, ["user_stopped"]);
  assert.deepEqual(coordinator.getSnapshot().lastComplete, {
    step: 0,
    maxSteps: 24,
    stopReason: "user_stopped",
  });
});

test("run coordinator emits a terminal error projection when the executor rejects", async () => {
  const coordinator = new RunCoordinator();
  const completions: string[] = [];
  coordinator.subscribe({
    onRunComplete: (event) => completions.push(event.stopReason),
  });

  await assert.rejects(
    coordinator.start(async (_signal, events) => {
      events.onRunConfig?.({ runId: "run-error", maxStepsForRun: 12 } as never);
      throw new Error("simulated executor failure");
    }),
    /simulated executor failure/,
  );

  assert.deepEqual(completions, ["error"]);
  assert.equal(coordinator.getSnapshot().state, "idle");
  assert.deepEqual(coordinator.getSnapshot().lastComplete, {
    step: 0,
    maxSteps: 12,
    stopReason: "error",
  });
});

test("run coordinator bounds replay payloads and retained receipts", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({ runId: "run-bounded" } as never);
    for (let index = 0; index < 900; index += 1) {
      events.onStatus?.(`status-${index}-${"x".repeat(3_000)}`);
      events.onReceipt?.({
        toolName: "append_to_current_file",
        operation: "append",
        path: `Note-${index}.md`,
        bytesWritten: index + 1,
      } as never);
    }
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.ok(snapshot.bufferedEventCount <= 800);
  assert.ok(snapshot.bufferedEventChars <= 2_000_000);
  assert.ok(snapshot.droppedEventCount > 0);
  assert.equal(snapshot.lastReceipts.length, 256);
  assert.equal(snapshot.lastReceipts.at(-1)?.path, "Note-899.md");
});

test("a rejected concurrent start cannot tap or persist the active run's events", async () => {
  const coordinator = new RunCoordinator();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rejectedCapture = "";
  const rejectedPersisted: string[] = [];
  let acceptedCapture = "";
  let rejectedReentrantStart = false;

  const active = coordinator.start(
    async (_signal, events) => {
      events.onRunConfig?.({ runId: "owned-run" } as never);
      await gate;
      events.onAssistantMessageStart?.();
      events.onAssistantDelta?.("owned output");
      events.onAssistantMessageDone?.();
      events.onRunComplete?.({ step: 1, maxSteps: 2, stopReason: "final" });
    },
    {
      eventTap: {
        onRunConfig: () => {
          assert.throws(
            () => coordinator.start(async () => undefined),
            RunAlreadyActiveError,
          );
          rejectedReentrantStart = true;
        },
        onAssistantDelta: (delta) => {
          acceptedCapture += delta;
        },
      },
    },
  );

  assert.equal(rejectedReentrantStart, true);
  assert.throws(
    () =>
      coordinator.start(async () => undefined, {
        eventTap: {
          onAssistantMessageStart: () => {
            rejectedCapture = "";
          },
          onAssistantDelta: (delta) => {
            rejectedCapture += delta;
          },
          onAssistantMessageDone: () => {
            if (rejectedCapture.trim()) {
              rejectedPersisted.push(rejectedCapture);
            }
          },
        },
      }),
    RunAlreadyActiveError,
  );

  release?.();
  await active;
  assert.equal(acceptedCapture, "owned output");
  assert.equal(rejectedCapture, "");
  assert.deepEqual(rejectedPersisted, []);
});
