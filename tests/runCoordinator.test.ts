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
    events.onTrace?.({
      id: "mission-graph-initialization-failed",
      kind: "error",
      message: "Mission graph initialization failed before tool execution: invalid bounded graph.",
      error: { code: "mission_graph_initialization_failed", message: "bounded" },
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
    {
      schemaVersion: 1,
      id: "mission-graph-initialization-failed",
      kind: "error",
      message: "Mission graph initialization failed before tool execution: invalid bounded graph.",
      errorCode: "mission_graph_initialization_failed",
      missing: [],
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

test("a continuation stopped before publishing authority retains its verified restart projection", async () => {
  const coordinator = new RunCoordinator();
  const graph = {
    schemaVersion: 3,
    missionId: "mission-resumable",
    objective: "Resume accepted research",
    revision: 4,
    nodes: {},
  } as never;
  coordinator.hydratePersistedMission({
    runId: "run-resumable",
    runtimeSnapshotPath: "Agent Runs/run-resumable.md",
    missionLedgerPath: "Agent Runs/run-resumable.md",
    graphStorePath: "Agent Runs/Mission Graphs/run-resumable.md",
    graphReference: {
      version: 1,
      missionId: "mission-resumable",
      path: "Agent Runs/Mission Graphs/run-resumable.md",
      storeRevision: 5,
      graphRevision: 4,
      recordFingerprint: `sha256:${"a".repeat(64)}`,
      journalHeadFingerprint: `sha256:${"b".repeat(64)}`,
    },
    missionLedger: {
      runId: "run-resumable",
      status: "stopped",
      evidenceCount: 2,
      receiptCount: 1,
      expectedTools: ["publish_research_project_to_linear"],
      nextAction: "Create the Linear hierarchy.",
      remainingActions: ["Create the Linear hierarchy."],
      continuationCommand: "continue run run-resumable",
      canResume: true,
      dependencyStatus: [],
      iterationCount: 3,
      progressScore: 0.4,
      stalledCount: 0,
    },
    missionGraph: graph,
  });

  const active = coordinator.start(async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  assert.equal(coordinator.requestStop("durable_restart_boundary"), true);
  assert.equal((await active).stopReason, "user_stopped");

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.lastMissionLedger?.runId, "run-resumable");
  assert.equal(snapshot.lastMissionLedger?.canResume, true);
  assert.deepEqual(snapshot.lastMissionGraph, graph);
  assert.equal(snapshot.persistedProjection?.graphReference.storeRevision, 5);
  assert.deepEqual(snapshot.diagnosticAttestations.at(-1), {
    schemaVersion: 1,
    id: "run-coordinator-pre-authority-completion",
    kind: "error",
    message:
      "Mission stopped before publishing run authority; reason=durable_restart_boundary. The verified restart projection was retained.",
    errorCode: "run_stopped_before_authority",
    missing: [],
  });
});

test("a durable continuation does not replace its projection with a routing-only config", async () => {
  const coordinator = new RunCoordinator();
  const completions: string[] = [];
  coordinator.subscribe({
    onRunComplete: (event) => completions.push(event.stopReason),
  });
  const graph = {
    schemaVersion: 3,
    missionId: "mission-routing-resume",
    objective: "Resume the exact Linear hierarchy frontier",
    revision: 6,
    nodes: {},
  } as never;
  coordinator.hydratePersistedMission({
    runId: "run-routing-resume",
    runtimeSnapshotPath: "Agent Runs/run-routing-resume.md",
    missionLedgerPath: "Agent Runs/run-routing-resume.md",
    graphStorePath: "Agent Runs/Mission Graphs/run-routing-resume.md",
    graphReference: {
      version: 1,
      missionId: "mission-routing-resume",
      path: "Agent Runs/Mission Graphs/run-routing-resume.md",
      storeRevision: 8,
      graphRevision: 6,
      recordFingerprint: `sha256:${"c".repeat(64)}`,
      journalHeadFingerprint: `sha256:${"d".repeat(64)}`,
    },
    missionLedger: {
      runId: "run-routing-resume",
      status: "budget",
      evidenceCount: 3,
      receiptCount: 2,
      expectedTools: ["publish_research_project_to_linear"],
      nextAction: "Resume the Linear hierarchy.",
      remainingActions: ["Resume the Linear hierarchy."],
      continuationCommand: "continue run run-routing-resume",
      canResume: true,
      dependencyStatus: [],
      iterationCount: 4,
      progressScore: 0.5,
      stalledCount: 0,
    },
    missionGraph: graph,
  });

  const outcome = await coordinator.start(
    async (_signal, events) => {
      events.onRunConfig?.({
        runId: "run-routing-child",
        maxStepsForRun: 1,
      } as never);
      events.onRunComplete?.({
        step: 0,
        maxSteps: 1,
        stopReason: "clarifying_question",
      });
    },
    { preserveExistingProjectionUntilLedger: true },
  );

  const snapshot = coordinator.getSnapshot();
  assert.equal(outcome.stopReason, "budget");
  assert.deepEqual(completions, ["budget"]);
  assert.equal(snapshot.lastComplete?.stopReason, "budget");
  assert.equal(snapshot.runId, "run-routing-resume");
  assert.equal(snapshot.lastMissionLedger?.canResume, true);
  assert.deepEqual(snapshot.lastMissionGraph, graph);
  assert.equal(
    snapshot.diagnosticAttestations.at(-1)?.errorCode,
    "run_returned_before_authority",
  );
});

test("run coordinator retains a bounded redacted terminal rejection", async () => {
  const coordinator = new RunCoordinator();
  const secret = `lin_api_${"s".repeat(64)}`;
  await assert.rejects(
    coordinator.start(async () => {
      const error = new Error(
        `Resume failed for ${secret} at C:\\Users\\person\\vault\\Agent Runs\\run.md`,
      ) as Error & { code: string };
      error.code = "resume_contract_failed";
      throw error;
    }),
    /Resume failed/u,
  );

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.lastComplete?.stopReason, "error");
  assert.deepEqual(snapshot.diagnosticAttestations, [
    {
      schemaVersion: 1,
      id: "run-coordinator-terminal-error",
      kind: "error",
      message: "Error: Resume failed for [REDACTED] at [LOCAL_PATH]",
      errorCode: "resume_contract_failed",
      missing: [],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(snapshot.diagnosticAttestations),
    /lin_api_|person|run\.md/u,
  );
});

test("run coordinator retains a redacted failed tool-result code", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onTrace?.({
      id: "tool-call-2:result",
      kind: "tool_result",
      toolName: "publish_research_project_to_linear",
      message: `Tool returned error at C:\\private\\vault using lin_api_${"x".repeat(64)}`,
      error: {
        code: "linear_hierarchy_invalid_arguments",
        message: "not retained",
      },
    });
    events.onRunComplete?.({ step: 2, maxSteps: 24, stopReason: "budget" });
  });

  assert.deepEqual(coordinator.getSnapshot().diagnosticAttestations, [
    {
      schemaVersion: 1,
      id: "tool-call-2:result",
      kind: "tool_result",
      toolName: "publish_research_project_to_linear",
      message: "Tool returned error at [LOCAL_PATH]",
      errorCode: "linear_hierarchy_invalid_arguments",
      missing: [],
    },
  ]);
});

test("run event observer failures are redacted and cannot abort the mission", async () => {
  const coordinator = new RunCoordinator();
  coordinator.subscribe({
    onRunConfig: () => {
      throw new Error(
        `view detached at C:\\private\\vault with github_pat_${"z".repeat(64)}`,
      );
    },
  });

  const outcome = await coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({ runId: "run-observer", maxStepsForRun: 3 } as never);
    events.onRunComplete?.({ step: 1, maxSteps: 3, stopReason: "final" });
  });

  assert.equal(outcome.stopReason, "final");
  assert.deepEqual(coordinator.getSnapshot().diagnosticAttestations, [
    {
      schemaVersion: 1,
      id: "run-event-listener-error:onRunConfig",
      kind: "error",
      message: "Error: view detached at [LOCAL_PATH]",
      errorCode: "run_event_listener_failed",
      missing: [],
    },
  ]);
});

test("run coordinator retains one receipt when a continuation re-emits durable proof", async () => {
  const coordinator = new RunCoordinator();
  const resource = {
    system: "vault",
    resourceType: "markdown",
    id: "Notes/Result.md",
    path: "Notes/Result.md",
  } as const;
  const readback = {
    status: "verified",
    checkedAt: "2026-07-16T22:00:00.000Z",
    observedFingerprint: `sha256:${"a".repeat(64)}`,
    observedRevision: `sha256:${"a".repeat(64)}`,
  } as const;

  await coordinator.start(async (_signal, events) => {
    events.onReceipt?.({
      toolName: "append_to_current_file",
      operation: "append",
      path: resource.path,
      resource,
      message: `append ${resource.path}`,
      readback,
      bytesWritten: 183,
    });
    events.onReceipt?.({
      id: "receipt-1",
      toolName: "append_to_current_file",
      operation: "append",
      path: resource.path,
      resource,
      message: `append ${resource.path}`,
      readback,
      bytesWritten: 183,
    });
    events.onRunComplete?.({ step: 1, maxSteps: 2, stopReason: "write_completed" });
  });

  assert.equal(coordinator.getSnapshot().lastReceipts.length, 1);
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
