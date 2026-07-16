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

test("run coordinator aggregates redacted provider evidence", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onModelCallEvidence?.({
      schemaVersion: 1,
      callId: "model-call-1",
      phase: "router",
      provider: "ollama",
      model: "gpt-oss:120b-cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
      attempt: 1,
      durationMs: 42,
      outcome: "success",
      responseChars: 80,
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
      tokenUsageReported: true,
    });
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });
  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.modelCallEvidence.length, 1);
  assert.equal(snapshot.providerUsage.modelCallCount, 1);
  assert.equal(snapshot.providerUsage.reportedTokens, 13);
  assert.equal(snapshot.providerUsage.wallClockMs, 42);
});

test("run coordinator retains only redacted durable source evidence", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onMissionEvidence?.({
      schemaVersion: 1,
      id: "web:owned-alpha",
      kind: "web_source",
      sourceId: "source:owned-alpha",
      passageIds: ["source:owned-alpha:passage:0-42"],
      usableSource: true,
      parserStatus: "parsed",
      confidence: "high",
    });
    events.onTrace?.({
      id: "verified-final-append-3:candidate-held",
      kind: "verification",
      step: 3,
      toolName: "append_to_current_file",
      message: "Held candidate: fail.",
      outputPreview: {
        acceptance: { missing: ["claim_grounding:missing"] },
        content: "must-not-escape",
      },
    });
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.deepEqual(snapshot.missionEvidence, [
    {
      schemaVersion: 1,
      id: "web:owned-alpha",
      kind: "web_source",
      sourceId: "source:owned-alpha",
      passageIds: ["source:owned-alpha:passage:0-42"],
      usableSource: true,
      parserStatus: "parsed",
      confidence: "high",
    },
  ]);
  assert.equal(
    /summary|content|title|path|url/iu.test(JSON.stringify(snapshot.missionEvidence)),
    false,
  );
  assert.deepEqual(snapshot.diagnosticAttestations, [
    {
      schemaVersion: 1,
      id: "verified-final-append-3:candidate-held",
      kind: "verification",
      step: 3,
      toolName: "append_to_current_file",
      message: "Held candidate: fail.",
      missing: ["claim_grounding:missing"],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(snapshot.diagnosticAttestations),
    /must-not-escape/u,
  );
});

test("run coordinator retains and replays the latest canonical mission graph", async () => {
  const coordinator = new RunCoordinator();
  const graph = {
    schemaVersion: 3,
    missionId: "mission-graph-run",
    objective: "Inspect and update the active note",
    revision: 2,
    nodes: {},
  } as never;

  await coordinator.start(async (_signal, events) => {
    events.onMissionGraphUpdate?.(graph);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const seen: string[] = [];
  coordinator.subscribe(
    {
      onMissionGraphUpdate: (snapshot) => seen.push(snapshot.objective),
    },
    { replay: true },
  );

  assert.equal(coordinator.getSnapshot().runId, "mission-graph-run");
  assert.deepEqual(coordinator.getSnapshot().lastMissionGraph, graph);
  assert.deepEqual(seen, ["Inspect and update the active note"]);
});

test("run coordinator hydrates and replays an idle persisted mission projection", () => {
  const coordinator = new RunCoordinator();
  const graph = {
    schemaVersion: 3,
    missionId: "mission-persisted",
    objective: "Resume the durable mission",
    revision: 2,
    nodes: {},
  } as never;
  const hydrated = coordinator.hydratePersistedMission({
    runId: "run-persisted",
    runtimeSnapshotPath: "Agent Runs/run-persisted.md",
    missionLedgerPath: "Agent Runs/run-persisted.md",
    graphStorePath: "Agent Runs/Mission Graphs/mission-persisted.md",
    graphReference: {
      version: 1,
      missionId: "mission-persisted",
      path: "Agent Runs/Mission Graphs/mission-persisted.md",
      storeRevision: 7,
      graphRevision: 2,
      recordFingerprint: `sha256:${"a".repeat(64)}`,
      journalHeadFingerprint: `sha256:${"b".repeat(64)}`,
    },
    missionLedger: {
      runId: "run-persisted",
      status: "blocked",
      evidenceCount: 1,
      receiptCount: 1,
      expectedTools: ["append_to_current_file"],
      nextAction: "Verify the final artifact.",
      remainingActions: ["Verify the final artifact."],
      continuationCommand: "continue run run-persisted",
      canResume: true,
      dependencyStatus: [],
      iterationCount: 2,
      progressScore: 0.5,
      stalledCount: 0,
    },
    missionGraph: graph,
  });

  assert.equal(hydrated, true);
  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.isRunning, false);
  assert.equal(snapshot.lastMissionLedger?.canResume, true);
  assert.equal(snapshot.persistedProjection?.graphReference.storeRevision, 7);
  assert.deepEqual(snapshot.lastMissionGraph, graph);

  const replayed: string[] = [];
  coordinator.subscribe(
    {
      onMissionGraphUpdate: (value) => replayed.push(value.objective),
    },
    { replay: true },
  );
  assert.deepEqual(replayed, ["Resume the durable mission"]);
});

test("starting a new run clears the persisted restart projection", async () => {
  const coordinator = new RunCoordinator();
  coordinator.hydratePersistedMission({
    runId: "run-old",
    runtimeSnapshotPath: "Agent Runs/run-old.md",
    missionLedgerPath: "Agent Runs/run-old.md",
    graphStorePath: "Agent Runs/Mission Graphs/run-old.md",
    graphReference: {
      version: 1,
      missionId: "run-old",
      path: "Agent Runs/Mission Graphs/run-old.md",
      storeRevision: 1,
      graphRevision: 0,
      recordFingerprint: `sha256:${"a".repeat(64)}`,
      journalHeadFingerprint: null,
    },
    missionLedger: {
      runId: "run-old",
      status: "running",
      evidenceCount: 0,
      receiptCount: 0,
      expectedTools: [],
      nextAction: "Continue.",
      remainingActions: ["Continue."],
      continuationCommand: "continue run run-old",
      canResume: true,
      dependencyStatus: [],
      iterationCount: 0,
      progressScore: 0,
      stalledCount: 0,
    },
    missionGraph: {
      schemaVersion: 3,
      missionId: "run-old",
      objective: "Old mission",
      revision: 0,
      nodes: {},
    } as never,
  });

  await coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({ runId: "run-new" } as never);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.runId, "run-new");
  assert.equal(snapshot.persistedProjection, null);
  assert.equal(snapshot.lastMissionLedger, null);
  assert.equal(snapshot.lastMissionGraph, null);
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
