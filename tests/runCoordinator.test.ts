import {
  normalizeModelUsageAggregateV1,
  promptPrefixReuseAverageV1,
} from "../src/model/modelCallEvidence";
import assert from "node:assert/strict";
import test from "node:test";
import {
  RunAlreadyActiveError,
  RunCoordinator,
  runScopedProviderUsageV1,
} from "../src/agent/runCoordinator";
import { scoreMissionV1 } from "../src/agent/missionScorecard";

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

test("provider usage scope is stable within one start and unique across starts", async () => {
  const coordinator = new RunCoordinator();
  let firstScope: string | null = null;
  await coordinator.start(async (_signal, events) => {
    firstScope = coordinator.getSnapshot().providerUsageScopeId;
    events.onRunConfig?.({ runId: "lead-segment-1" } as never);
    events.onRunConfig?.({ runId: "lead-segment-2" } as never);
    assert.equal(coordinator.getSnapshot().providerUsageScopeId, firstScope);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  assert.ok(firstScope);
  let secondScope: string | null = null;
  await coordinator.start(async (_signal, events) => {
    secondScope = coordinator.getSnapshot().providerUsageScopeId;
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  assert.ok(secondScope);
  assert.notEqual(secondScope, firstScope);
});

test("events from a completed coordinator generation cannot contaminate a later run", async () => {
  const coordinator = new RunCoordinator();
  let staleEvents:
    | Parameters<Parameters<RunCoordinator["start"]>[0]>[1]
    | undefined;
  await coordinator.start(async (_signal, events) => {
    staleEvents = events;
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  await coordinator.start(async (_signal, events) => {
    staleEvents?.onModelCallEvidence?.(
      modelCallEvidenceForTest("stale-model-call"),
    );
    events.onModelCallEvidence?.(modelCallEvidenceForTest("current-model-call"));
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.providerUsage.modelCallCount, 1);
  assert.deepEqual(
    snapshot.modelCallEvidence.map((item) => item.callId),
    ["current-model-call"],
  );
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
      clientInvoked: true,
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

test("run coordinator does not count a pre-dispatch budget rejection as a provider call", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onModelCallEvidence?.({
      schemaVersion: 1,
      callId: "model-call-budget",
      phase: "retry",
      provider: "ollama",
      model: "gpt-oss:120b-cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
      attempt: 2,
      durationMs: 0,
      clientInvoked: false,
      outcome: "budget_exhausted",
      responseChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenUsageReported: false,
      errorCategory: "provider_budget_exhausted",
    });
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "budget" });
  });
  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.modelCallEvidence.length, 1);
  assert.equal(snapshot.providerUsage.modelCallCount, 0);
  assert.equal(snapshot.providerUsage.successfulCallCount, 0);
  assert.equal(snapshot.providerUsage.failedCallCount, 0);
});

test("run coordinator counts a provider-returned quota error as a failed client call", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onModelCallEvidence?.({
      schemaVersion: 1,
      callId: "model-call-provider-quota",
      phase: "agent_step",
      provider: "ollama",
      model: "gpt-oss:120b-cloud",
      endpointCategory: "ollama_cloud",
      transportKind: "production",
      attempt: 1,
      durationMs: 25,
      clientInvoked: true,
      outcome: "budget_exhausted",
      responseChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokenUsageReported: false,
      errorCategory: "provider_budget_exhausted",
    });
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "budget" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.providerUsage.modelCallCount, 1);
  assert.equal(snapshot.providerUsage.successfulCallCount, 0);
  assert.equal(snapshot.providerUsage.failedCallCount, 1);
  assert.equal(snapshot.providerUsage.wallClockMs, 25);
});

test("run coordinator retains, replays, and resets the latest mission scorecard", async () => {
  const coordinator = new RunCoordinator();
  const scorecard = scoreMissionV1({
    acceptanceCriteriaTotal: 1,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 0,
    claimsWithEvidence: 0,
    mutationsPerformed: 0,
    mutationsWithReceipts: 0,
    recoveryAttempts: 0,
    modelCalls: 1,
    modelCallBudget: 3,
    wallClockMs: 10,
    wallClockBudgetMs: 100,
  });
  await coordinator.start(async (_signal, events) => {
    events.onMissionScorecard?.(scorecard);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.deepEqual(snapshot.lastMissionScorecard, scorecard);
  assert.notEqual(snapshot.lastMissionScorecard, scorecard);
  const replayed: number[] = [];
  coordinator.subscribe(
    { onMissionScorecard: (value) => replayed.push(value.total) },
    { replay: true },
  );
  assert.deepEqual(replayed, [scorecard.total]);

  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = coordinator.start(async (_signal, events) => {
    await gate;
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });
  assert.equal(coordinator.getSnapshot().lastMissionScorecard, null);
  release?.();
  await next;
});

test("run coordinator retains applicable research dimensions across compound segments", async () => {
  const coordinator = new RunCoordinator();
  const research = scoreMissionV1({
    acceptanceCriteriaTotal: 1,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 2,
    claimsWithEvidence: 2,
    mutationsPerformed: 1,
    mutationsWithReceipts: 1,
    recoveryAttempts: 0,
    modelCalls: 1,
    modelCallBudget: 3,
    wallClockMs: 10,
    wallClockBudgetMs: 100,
  });
  const later = scoreMissionV1({
    acceptanceCriteriaTotal: 1,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 2,
    claimsWithEvidence: 0,
    evidenceGroundingApplicable: false,
    mutationsPerformed: 2,
    mutationsWithReceipts: 2,
    recoveryAttempts: 0,
    modelCalls: 2,
    modelCallBudget: 3,
    wallClockMs: 20,
    wallClockBudgetMs: 100,
  });

  await coordinator.start(async (_signal, events) => {
    events.onMissionScorecard?.(research);
    events.onMissionScorecard?.(later);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const grounding = coordinator
    .getSnapshot()
    .lastMissionScorecard?.dimensions.find(
      (item) => item.id === "evidence_grounding",
    );
  assert.equal(grounding?.score, 1);
  assert.equal(grounding?.applicable, true);
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

test("graph and orchestrator events cannot replace the configured root run id", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({
      runId: "run-root-ledger",
      missionLedger: { runId: "run-root-ledger-lead" },
    } as never);
    events.onMissionGraphUpdate?.({
      schemaVersion: 3,
      missionId: "run-root-ledger-canonicalized",
      objective: "Coordinate a research team",
      revision: 1,
      nodes: {},
    } as never);
    events.onOrchestratorEvent?.(
      { kind: "status" } as never,
      { runId: "run-researcher-child" } as never,
    );
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.runId, "run-root-ledger");
  assert.equal(snapshot.lastConfig?.runId, "run-root-ledger");
  assert.equal(snapshot.lastConfig?.missionLedger?.runId, "run-root-ledger-lead");
  assert.equal(snapshot.lastMissionLedger?.runId, "run-root-ledger-lead");
});

test("a non-authoritative continuation config cannot split the run identity", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({
      runId: "run-root",
      missionLedger: { runId: "run-root" },
    } as never);
    events.onMissionGraphUpdate?.({
      schemaVersion: 3,
      missionId: "run-root",
      objective: "root mission",
      revision: 1,
      nodes: {},
    } as never);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  await coordinator.start(
    async (_signal, events) => {
      // A continuation segment's early config arrives before any mission
      // ledger. It must not be adopted piecemeal.
      events.onRunConfig?.({ runId: "run-continuation-segment" } as never);
      events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "budget" });
    },
    { preserveExistingProjectionUntilLedger: true },
  );

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.runId, "run-root");
  assert.equal(snapshot.lastConfig?.runId ?? snapshot.runId, snapshot.runId);
});

test("a ledger-less segment config cannot demote an established ledger identity", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onRunConfig?.({ runId: "run-root" } as never);
    events.onRunConfig?.({
      runId: "run-root",
      missionLedger: { runId: "run-root" },
    } as never);
    // A continuation segment's early config arrives before its own ledger.
    events.onRunConfig?.({ runId: "run-segment-2" } as never);
    events.onRunComplete?.({ step: 2, maxSteps: 4, stopReason: "budget" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.runId, "run-root");
  assert.equal(snapshot.lastConfig?.runId, "run-root");
  assert.equal(snapshot.lastMissionLedger?.runId, "run-root");
  assert.equal(snapshot.lastConfig?.missionLedger?.runId, "run-root");
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
      providerUsage: emptyProviderUsageForTest(),
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
      providerUsage: emptyProviderUsageForTest(),
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

test("run coordinator settles cancellation when an abort-aware executor rejects", async () => {
  const coordinator = new RunCoordinator();
  const completions: string[] = [];
  coordinator.subscribe({
    onRunComplete: (event) => completions.push(event.stopReason),
  });
  const active = coordinator.start(async (signal, events) => {
    events.onRunConfig?.({
      runId: "run-abort-rejection",
      maxStepsForRun: 24,
    } as never);
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  });

  assert.equal(coordinator.requestStop("coordinator_shutdown"), true);
  assert.deepEqual(await active, {
    runId: "run-abort-rejection",
    step: 0,
    maxSteps: 24,
    stopReason: "user_stopped",
  });
  assert.deepEqual(completions, ["user_stopped"]);
  assert.equal(coordinator.getSnapshot().isRunning, false);
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
      providerUsage: emptyProviderUsageForTest(),
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
      providerUsage: emptyProviderUsageForTest(),
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

function modelCallEvidenceForTest(callId: string) {
  return {
    schemaVersion: 1 as const,
    callId,
    phase: "agent_step" as const,
    provider: "ollama" as const,
    model: "gpt-oss:120b-cloud",
    endpointCategory: "ollama_cloud" as const,
    transportKind: "production" as const,
    attempt: 1,
    durationMs: 10,
    clientInvoked: true,
    outcome: "success" as const,
    responseChars: 20,
    promptTokens: 2,
    completionTokens: 1,
    totalTokens: 3,
    tokenUsageReported: true,
  };
}

function emptyProviderUsageForTest() {
  return {
    schemaVersion: 1 as const,
    modelCallCount: 0,
    successfulCallCount: 0,
    failedCallCount: 0,
    reportedTokens: 0,
    estimatedTokens: 0,
    retries: 0,
    wallClockMs: 0,
  };
}

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

test("run coordinator retains committed-write and wall-clock acceptance diagnostics", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onTrace?.({
      id: "committed-write-acceptance-invariant-4",
      kind: "acceptance",
      step: 4,
      message: "Exact verified payload retained.",
      outputPreview: { missing: ["claim_grounding:ungrounded:claim:1"] },
    });
    events.onTrace?.({
      id: "wall-clock-budget-lead",
      kind: "status",
      message: "Adaptive Lead wall-clock budget exhausted.",
    });
    events.onRunComplete?.({ step: 4, maxSteps: 10, stopReason: "budget" });
  });

  assert.deepEqual(
    coordinator.getSnapshot().diagnosticAttestations.map((item) => item.id),
    [
      "committed-write-acceptance-invariant-4",
      "wall-clock-budget-lead",
    ],
  );
  assert.deepEqual(
    coordinator.getSnapshot().diagnosticAttestations[0]?.missing,
    ["claim_grounding:ungrounded:claim:1"],
  );
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
  assert.equal(coordinator.getSnapshot().lastReceipts[0].id, "receipt-1");
});

test("run coordinator retains distinct legacy appends with identical display text", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    for (const fingerprint of ["a", "b"]) {
      events.onReceipt?.({
        toolName: "append_to_current_file", operation: "append", path: "Notes/Result.md",
        message: "append Notes/Result.md", bytesWritten: 24,
        readback: { status: "verified", checkedAt: "2026-09-04T22:00:00.000Z",
          observedFingerprint: `sha256:${fingerprint.repeat(64)}` },
      });
    }
    events.onRunComplete?.({ step: 2, maxSteps: 3, stopReason: "final" });
  });
  assert.equal(coordinator.getSnapshot().lastReceipts.length, 2,
    "different read-back states are different effects even when paths, sizes and messages match");
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

test("steering is rejected when there is no active run", () => {
  const coordinator = new RunCoordinator();
  const result = coordinator.steerActiveRun({
    kind: "add_constraint",
    text: "cite every claim",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, "no_active_run");
  assert.deepEqual(coordinator.getRunSteeringPort().drain(), []);
});

test("the coordinator queues narrowing directives and drains them once", async () => {
  const coordinator = new RunCoordinator();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const drained: string[][] = [];

  const active = coordinator.start(async (_signal, events) => {
    const port = coordinator.getRunSteeringPort();
    // Step boundary 1: nothing queued yet.
    drained.push(port.drain().map((directive) => directive.kind));
    await gate;
    // Step boundary 2: the user's directives arrived mid-run.
    drained.push(port.drain().map((directive) => directive.kind));
    // Step boundary 3: draining is idempotent.
    drained.push(port.drain().map((directive) => directive.kind));
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const accepted = coordinator.steerActiveRun({
    kind: "narrow_scope",
    text: "only the 2024 papers",
  });
  assert.equal(accepted.ok, true);

  const dropped = coordinator.steerActiveRun({
    kind: "drop_tool",
    text: "fetches keep timing out",
    toolName: "web_fetch",
  });
  assert.equal(dropped.ok, true);

  release?.();
  await active;

  assert.deepEqual(drained, [[], ["narrow_scope", "drop_tool"], []]);
});

test("the coordinator refuses a directive that would widen authority", async () => {
  const coordinator = new RunCoordinator();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed: string[] = [];

  const active = coordinator.start(async (_signal, events) => {
    await gate;
    observed = coordinator
      .getRunSteeringPort()
      .drain()
      .map((directive) => directive.kind);
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  const rejected = coordinator.steerActiveRun({
    kind: "add_tool",
    text: "enable the github publication tool",
    toolName: "publish_research_to_github",
  });

  assert.equal(rejected.ok, false);
  assert.equal(
    rejected.ok === false ? rejected.code : null,
    "would_widen_authority",
  );

  release?.();
  await active;

  // The rejected directive never reached the run.
  assert.deepEqual(observed, []);
});

test("steering does not carry across runs", async () => {
  const coordinator = new RunCoordinator();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const first = coordinator.start(async (_signal, events) => {
    await gate;
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });
  assert.equal(
    coordinator.steerActiveRun({ kind: "add_constraint", text: "stay local" }).ok,
    true,
  );
  release?.();
  await first;

  let leaked: unknown[] = [];
  await coordinator.start(async (_signal, events) => {
    leaked = coordinator.getRunSteeringPort().drain();
    events.onRunComplete?.({ step: 1, maxSteps: 1, stopReason: "final" });
  });

  assert.deepEqual(leaked, []);
});

test("run coordinator attests in-flight model retry and wait diagnostics", async () => {
  // Regression: a Phase B step that kept timing out and retrying looked like
  // an idle run because retries were status-only and the diagnostic allowlist
  // dropped them. A stalled step must be visible while it is still in flight.
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onTrace?.({
      id: "model-wait-10-1",
      kind: "status",
      step: 10,
      message: "model_wait label=streaming model response; elapsed_s=300",
    });
    events.onTrace?.({
      id: "model-retry-10-2",
      kind: "status",
      step: 10,
      message:
        "model_retry attempt=2; delay_ms=750; timeout=true; error=Streaming request to Ollama failed: Request timed out after 600000ms.",
    });
    events.onTrace?.({
      id: "model-call-agent-step-10",
      kind: "status",
      step: 10,
      message: "Model call: agent step 10",
    });
    events.onRunComplete?.({ step: 10, maxSteps: 25, stopReason: "final" });
  });

  assert.deepEqual(
    coordinator.getSnapshot().diagnosticAttestations.map((item) => item.id),
    ["model-wait-10-1", "model-retry-10-2"],
  );
});

test("run coordinator attests ordered append frontier projection decisions", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onTrace?.({
      id: "ordered-current-note-append-frontier-projection-skipped-1",
      kind: "verification",
      step: 1,
      message:
        "Ordered append projection skipped: decision=current_note_unreadable; offered=append_to_current_file; model_tools=read_file; current_note_readable=false.",
    });
    events.onRunComplete?.({ step: 1, maxSteps: 2, stopReason: "error" });
  });

  assert.deepEqual(
    coordinator.getSnapshot().diagnosticAttestations.map((item) => item.id),
    ["ordered-current-note-append-frontier-projection-skipped-1"],
  );
});

test("run coordinator attests the verified no-model resume terminal", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onTrace?.({
      id: "resume-already-verified-complete",
      kind: "verification",
      step: 0,
      message:
        "Completed the resumed run from its verified graph, receipts, operation goals, and acceptance without another provider turn.",
    });
    events.onRunComplete?.({
      step: 0,
      maxSteps: 24,
      stopReason: "write_completed",
    });
  });

  assert.deepEqual(coordinator.getSnapshot().diagnosticAttestations, [
    {
      schemaVersion: 1,
      id: "resume-already-verified-complete",
      kind: "verification",
      step: 0,
      message:
        "Completed the resumed run from its verified graph, receipts, operation goals, and acceptance without another provider turn.",
      missing: [],
    },
  ]);
});

test("a refused create-file collision replan is attested with its reason", async () => {
  // Regression: the desktop audit lane blocked because code_workspace_create_file
  // hit an existing file and the read -> write_expected replan was refused. The
  // refusal reason was emitted but not attested, so the failure snapshot showed
  // only a model that stopped calling tools against an unchanged frontier.
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onTrace?.({
      id: "3:0:code_workspace_create_file:create-file-collision-replan-failed",
      kind: "error",
      step: 3,
      toolName: "code_workspace_create_file",
      message:
        "The create-file collision could not be replanned into an exact hash-bound repair.",
      error: {
        code: "create_file_collision_replan_failed",
        message: "Create-file collision repair path main.py does not match the trusted graph selector game.py.",
      },
    });
    events.onRunComplete?.({ step: 3, maxSteps: 16, stopReason: "error" });
  });

  const attested = coordinator.getSnapshot().diagnosticAttestations;
  assert.equal(attested.length, 1);
  assert.equal(attested[0]?.errorCode, "create_file_collision_replan_failed");
});

test("run coordinator folds prompt-prefix reuse metrics into its usage projection", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onMetric?.({
      kind: "run",
      name: "prompt_prefix_reuse",
      step: 2,
      durationMs: 0,
      prefixReuseRatio: 0.5,
      prefixFirstDivergentIndex: 3,
    });
    events.onMetric?.({
      kind: "run",
      name: "prompt_prefix_reuse",
      step: 3,
      durationMs: 0,
      prefixReuseRatio: 0.9,
      prefixFirstDivergentIndex: 5,
    });
    // A reuse event without a ratio and unrelated metrics leave the
    // projection alone.
    events.onMetric?.({ kind: "run", name: "prompt_prefix_reuse", step: 4, durationMs: 0 });
    events.onMetric?.({ kind: "tool", name: "web_fetch", step: 4, durationMs: 12 });
    events.onRunComplete?.({ step: 4, maxSteps: 8, stopReason: "final" });
  });

  const usage = coordinator.getSnapshot().providerUsage;
  assert.equal(usage.promptPrefixReuseSamples, 2);
  assert.ok(Math.abs((usage.promptPrefixReuseRatioTotal ?? 0) - 1.4) < 1e-9);
  assert.ok(Math.abs((promptPrefixReuseAverageV1(usage) ?? 0) - 0.7) < 1e-9);
});

test("a continued run's coordinator aggregate covers the ledger segment it publishes", async () => {
  // The BYOK journey's shape: one durable run, continued once. The Lead ledger
  // merges every segment's usage, while each Continue click opens a fresh
  // coordinator scope that starts counting at zero. Before the scope declared
  // what it inherited, the whole-team aggregate read smaller than the ledger
  // segment it published -- an aggregate below one of its own parts.
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onProviderUsageInherited?.({
      schemaVersion: 1,
      runId: "run-segment-1",
      resumedFromRunId: null,
      usage: emptyProviderUsageForTest(),
    });
    events.onModelCallEvidence?.(modelCallEvidenceForTest("segment-1-call-1"));
    events.onModelCallEvidence?.(modelCallEvidenceForTest("segment-1-call-2"));
    events.onRunConfig?.({
      runId: "run-segment-1",
      missionLedger: {
        runId: "run-segment-1",
        canResume: true,
        providerUsage: { ...emptyProviderUsageForTest(), modelCallCount: 2 },
      },
    } as never);
    events.onMissionGraphUpdate?.({
      missionId: "run-segment-1",
      objective: "continued mission",
      revision: 1,
      nodes: {},
    } as never);
    events.onRunComplete?.({ step: 2, maxSteps: 4, stopReason: "budget" });
  });

  await coordinator.start(
    async (_signal, events) => {
      events.onProviderUsageInherited?.({
        schemaVersion: 1,
        runId: "run-segment-2",
        resumedFromRunId: "run-segment-1",
        usage: { ...emptyProviderUsageForTest(), modelCallCount: 2 },
      });
      events.onModelCallEvidence?.(modelCallEvidenceForTest("segment-2-call-1"));
      events.onModelCallEvidence?.(modelCallEvidenceForTest("segment-2-call-2"));
      events.onModelCallEvidence?.(modelCallEvidenceForTest("segment-2-call-3"));
      events.onRunConfig?.({
        runId: "run-segment-2",
        missionLedger: {
          runId: "run-segment-2",
          canResume: false,
          providerUsage: { ...emptyProviderUsageForTest(), modelCallCount: 5 },
        },
      } as never);
      events.onRunComplete?.({ step: 5, maxSteps: 8, stopReason: "final" });
    },
    { preserveExistingProjectionUntilLedger: true },
  );

  const snapshot = coordinator.getSnapshot();
  // The scope keeps measuring only itself, so per-scope counts stay disjoint
  // and still sum to the mission's real total across starts.
  assert.equal(snapshot.providerUsage.modelCallCount, 3);
  assert.equal(snapshot.providerUsageInherited.modelCallCount, 2);
  assert.equal(
    runScopedProviderUsageV1(snapshot).modelCallCount,
    snapshot.lastMissionLedger?.providerUsage.modelCallCount,
  );
  assert.ok(
    runScopedProviderUsageV1(snapshot).modelCallCount >=
      (snapshot.lastMissionLedger?.providerUsage.modelCallCount ?? 0),
  );
});

test("a coordinator scope adopts only the baseline older than itself", async () => {
  // A long run auto-continues inside ONE start: segment 2 resumes segment 1's
  // ledger, but this scope already counted those calls one evidence record at
  // a time. Re-adopting the later declaration would double count the scope's
  // own measurements.
  const coordinator = new RunCoordinator();
  await coordinator.start(
    async (_signal, events) => {
      events.onProviderUsageInherited?.({
        schemaVersion: 1,
        runId: "run-inner-1",
        resumedFromRunId: "run-earlier",
        usage: { ...emptyProviderUsageForTest(), modelCallCount: 4 },
      });
      events.onModelCallEvidence?.(modelCallEvidenceForTest("inner-1-call-1"));
      events.onModelCallEvidence?.(modelCallEvidenceForTest("inner-1-call-2"));
      // Segment 2 of the same start, resuming what this scope just measured.
      events.onProviderUsageInherited?.({
        schemaVersion: 1,
        runId: "run-inner-2",
        resumedFromRunId: "run-inner-1",
        usage: { ...emptyProviderUsageForTest(), modelCallCount: 6 },
      });
      events.onModelCallEvidence?.(modelCallEvidenceForTest("inner-2-call-1"));
      events.onRunConfig?.({
        runId: "run-inner-2",
        missionLedger: {
          runId: "run-inner-2",
          canResume: false,
          providerUsage: { ...emptyProviderUsageForTest(), modelCallCount: 7 },
        },
      } as never);
      events.onRunComplete?.({ step: 3, maxSteps: 6, stopReason: "final" });
    },
    { preserveExistingProjectionUntilLedger: true },
  );

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.providerUsageInherited.modelCallCount, 4);
  assert.equal(snapshot.providerUsage.modelCallCount, 3);
  assert.equal(runScopedProviderUsageV1(snapshot).modelCallCount, 7);
});

test("a fresh mission's scope inherits nothing and starts a new baseline", async () => {
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onProviderUsageInherited?.({
      schemaVersion: 1,
      runId: "run-continued",
      resumedFromRunId: "run-earlier",
      usage: { ...emptyProviderUsageForTest(), modelCallCount: 9 },
    });
    events.onModelCallEvidence?.(modelCallEvidenceForTest("continued-call"));
    events.onRunComplete?.({ step: 1, maxSteps: 2, stopReason: "final" });
  });
  assert.equal(
    coordinator.getSnapshot().providerUsageInherited.modelCallCount,
    9,
  );

  await coordinator.start(async (_signal, events) => {
    events.onProviderUsageInherited?.({
      schemaVersion: 1,
      runId: "run-fresh",
      resumedFromRunId: null,
      usage: emptyProviderUsageForTest(),
    });
    events.onModelCallEvidence?.(modelCallEvidenceForTest("fresh-call"));
    events.onRunComplete?.({ step: 1, maxSteps: 2, stopReason: "final" });
  });

  const snapshot = coordinator.getSnapshot();
  assert.equal(snapshot.providerUsageInherited.modelCallCount, 0);
  assert.equal(runScopedProviderUsageV1(snapshot).modelCallCount, 1);
});

test("the coordinator and the mission ledger normalize one inherited aggregate identically", async () => {
  // The disagreement this whole seam fixes is two subsystems reading the same
  // number differently. They must also *coerce* it identically: a legacy or
  // partial record has to mean one thing, not one thing per reader.
  const legacy = {
    schemaVersion: 1,
    modelCallCount: 3.7,
    successfulCallCount: -2,
    reportedTokens: 11,
    promptPrefixReuseSamples: 2,
  };
  const coordinator = new RunCoordinator();
  await coordinator.start(async (_signal, events) => {
    events.onProviderUsageInherited?.({
      schemaVersion: 1,
      runId: "run-legacy",
      resumedFromRunId: "run-legacy-parent",
      usage: legacy as never,
    });
    events.onRunComplete?.({ step: 0, maxSteps: 1, stopReason: "final" });
  });

  assert.deepEqual(
    coordinator.getSnapshot().providerUsageInherited,
    normalizeModelUsageAggregateV1(legacy),
  );
  // Half a prefix-reuse pair is unreadable and must stay absent on both sides.
  assert.equal(
    coordinator.getSnapshot().providerUsageInherited.promptPrefixReuseSamples,
    undefined,
  );
});
