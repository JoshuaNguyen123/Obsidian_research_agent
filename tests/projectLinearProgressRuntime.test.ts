import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectLinearProgressRuntimeV1,
  parseLinearProgressPhaseBoundaryCommandV1,
  parseProjectLinearProgressNamespaceV1,
  type ProjectLinearProgressNamespaceV1,
  type ProjectLinearProgressPersistenceV1,
} from "../src/agent/projectLinearProgressRuntime";
import {
  createProjectWorkUnitLinearBindingV1,
  type ProjectWorkUnitLinearBindingV1,
} from "../src/agent/projectProgressProjection";
import {
  createProjectStageEventV1,
  type ProjectEvidenceKindV1,
  type ProjectPhaseV1,
  type ProjectStageEventV1,
} from "../src/agent/projectRunReport";

const fp = (character: string) => `sha256:${character.repeat(64)}`;
const processedAt = (minute: number) =>
  `2026-08-19T13:${String(minute).padStart(2, "0")}:00.000Z`;

const binding = createBinding({
  workUnitId: "work-1",
  issueId: "issue-uuid-1",
  issueIdentifier: "ENG-42",
  criteria: ["AC-1", "AC-2"],
  character: "a",
});

function createBinding(input: {
  workUnitId: string;
  issueId: string;
  issueIdentifier: string;
  criteria: string[];
  character: string;
}): ProjectWorkUnitLinearBindingV1 {
  return createProjectWorkUnitLinearBindingV1({
    schemaVersion: 1,
    bindingId: `binding-${input.workUnitId}`,
    runId: "run-42",
    workUnitId: input.workUnitId,
    linearIssueId: input.issueId,
    linearIssueIdentifier: input.issueIdentifier,
    linearIssueUrl: `https://linear.app/acme/issue/${input.issueIdentifier}/developer-mission`,
    acceptanceCriterionIds: input.criteria,
    providerReadbackFingerprint: fp(input.character),
    verifiedAt: "2026-08-19T12:00:00.000Z",
  });
}

function event(input: {
  phase: ProjectPhaseV1;
  kind: ProjectEvidenceKindV1;
  minute: number;
  workUnits?: Array<{ workUnitId: string; acceptanceCriterionIds?: string[] }>;
  disposition?: "verified" | "blocked";
}): ProjectStageEventV1 {
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: "run-42",
    phase: input.phase,
    evidenceKind: input.kind,
    disposition: input.disposition ?? "verified",
    occurredAt: `2026-08-19T12:${String(input.minute).padStart(2, "0")}:00.000Z`,
    sourceReceiptId: `receipt-${input.kind}-${input.minute}`,
    evidenceFingerprint: fp(String(input.minute % 10)),
    resource: {
      system: input.phase === "linear_plan"
        ? "linear"
        : input.phase === "github"
          ? "github"
          : input.phase === "reflect"
            ? "vault"
            : "workspace",
      resourceType: "artifact",
      id: `${input.kind}-${input.minute}`,
      url: null,
      path: null,
      revision: input.kind === "commit_readback" ? "a".repeat(40) : null,
    },
    workUnits: (input.workUnits ?? []).map((unit) => ({
      workUnitId: unit.workUnitId,
      acceptanceCriterionIds: unit.acceptanceCriterionIds ?? [],
    })),
  });
}

function fullTimeline(): ProjectStageEventV1[] {
  const bound = [{ workUnitId: "work-1" }];
  return [
    event({ phase: "linear_plan", kind: "linear_hierarchy_readback", minute: 1 }),
    event({ phase: "implement", kind: "workspace_mutation", minute: 2, workUnits: bound }),
    event({ phase: "implement", kind: "workspace_mutation", minute: 3, workUnits: bound }),
    event({ phase: "test", kind: "targeted_validation", minute: 4, workUnits: bound }),
    event({ phase: "test", kind: "full_validation", minute: 5, workUnits: bound }),
    event({ phase: "test", kind: "commit_readback", minute: 6, workUnits: bound }),
    event({ phase: "github", kind: "github_repository_readback", minute: 7, workUnits: bound }),
    event({ phase: "github", kind: "github_draft_pr_readback", minute: 8, workUnits: bound }),
    event({
      phase: "test",
      kind: "acceptance_criterion",
      minute: 9,
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: ["AC-1", "AC-2"] }],
    }),
    event({ phase: "reflect", kind: "reflection_writeback", minute: 10, workUnits: bound }),
  ];
}

class MemoryPersistence implements ProjectLinearProgressPersistenceV1 {
  value: ProjectLinearProgressNamespaceV1 | null = null;
  writes = 0;
  forceConflict = false;

  async read(): Promise<unknown> {
    return this.value ? structuredClone(this.value) : null;
  }

  async write(
    namespace: ProjectLinearProgressNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean> {
    this.writes += 1;
    if (this.forceConflict) return false;
    const current = parseProjectLinearProgressNamespaceV1(this.value);
    if (current.revision !== expectedRevision) return false;
    this.value = structuredClone(namespace);
    return true;
  }
}

test("runtime records only phase boundaries and exact replay survives restart", async () => {
  const persistence = new MemoryPersistence();
  const runtime = new ProjectLinearProgressRuntimeV1(persistence);
  const recorded = await runtime.recordEvents({
    runId: "run-42",
    events: fullTimeline(),
    bindings: [binding],
    processedAt: processedAt(10),
  });

  assert.equal(recorded.changed, true);
  assert.deepEqual(
    recorded.pendingCommands.map((command) => command.target),
    ["ready", "in_progress", "ready_for_review", "in_review", "completed"],
    "a second workspace receipt must not create a second in-progress command",
  );
  assert.equal(recorded.run.revision, 1);
  assert.equal(persistence.writes, 1);
  for (const command of recorded.pendingCommands) {
    assert.deepEqual(
      parseLinearProgressPhaseBoundaryCommandV1(structuredClone(command)),
      command,
    );
    assert.deepEqual(command.requiredReadbacks, ["comment", "issue_state"]);
    assert.doesNotMatch(command.comment, /sha256:/iu);
  }

  const restarted = new ProjectLinearProgressRuntimeV1(persistence);
  const replayed = await restarted.recordEvents({
    runId: "run-42",
    events: [...fullTimeline(), ...fullTimeline()],
    bindings: [binding],
    processedAt: processedAt(11),
  });
  assert.equal(replayed.changed, false);
  assert.equal(replayed.run.revision, 1);
  assert.equal(persistence.writes, 1, "exact replay must not write a new revision");
  assert.equal((await restarted.nextPending("run-42"))?.target, "ready");
});

test("verified acknowledgements and not-applied retries remain durable and idempotent", async () => {
  const persistence = new MemoryPersistence();
  let runtime = new ProjectLinearProgressRuntimeV1(persistence);
  const recorded = await runtime.recordEvents({
    runId: "run-42",
    events: fullTimeline(),
    bindings: [binding],
    processedAt: processedAt(10),
  });
  const first = recorded.pendingCommands[0]!;
  const applied = await runtime.acknowledgeVerified({
    runId: "run-42",
    commandId: first.commandId,
    commandFingerprint: first.commandFingerprint,
    providerReceiptId: "linear-composite-receipt-1",
    providerReceiptFingerprint: fp("b"),
    verifiedAt: processedAt(11),
  });
  assert.equal(applied.outbox.find((item) => item.itemId === first.commandId)?.status, "applied");

  runtime = new ProjectLinearProgressRuntimeV1(persistence);
  assert.equal((await runtime.nextPending("run-42"))?.target, "in_progress");
  const writesBeforeReplay = persistence.writes;
  const replayed = await runtime.acknowledgeVerified({
    runId: "run-42",
    commandId: first.commandId,
    commandFingerprint: first.commandFingerprint,
    providerReceiptId: "linear-composite-receipt-1",
    providerReceiptFingerprint: fp("b"),
    verifiedAt: processedAt(12),
  });
  assert.equal(replayed.revision, applied.revision);
  assert.equal(persistence.writes, writesBeforeReplay);
  await assert.rejects(
    runtime.acknowledgeVerified({
      runId: "run-42",
      commandId: first.commandId,
      commandFingerprint: first.commandFingerprint,
      providerReceiptId: "different-receipt",
      providerReceiptFingerprint: fp("c"),
      verifiedAt: processedAt(12),
    }),
    /different provider receipt/iu,
  );

  const next = await runtime.nextPending("run-42");
  assert.ok(next);
  const retry = await runtime.recordFailure({
    runId: "run-42",
    commandId: next.commandId,
    commandFingerprint: next.commandFingerprint,
    failedAt: processedAt(13),
    error: "Provider readback proved the mutation was not applied.",
    outcome: "verified_not_applied",
  });
  const retryItem = retry.outbox.find((item) => item.itemId === next.commandId)!;
  assert.equal(retryItem.status, "pending");
  assert.equal(retryItem.attemptCount, 1);
});

test("child completion requires that child's acceptance, pull request, and reflection bindings", async () => {
  const second = createBinding({
    workUnitId: "work-2",
    issueId: "issue-uuid-2",
    issueIdentifier: "ENG-43",
    criteria: ["AC-3"],
    character: "d",
  });
  const both = [{ workUnitId: "work-1" }, { workUnitId: "work-2" }];
  const events = [
    event({ phase: "linear_plan", kind: "linear_hierarchy_readback", minute: 1 }),
    event({ phase: "implement", kind: "workspace_mutation", minute: 2, workUnits: both }),
    event({ phase: "test", kind: "targeted_validation", minute: 3, workUnits: both }),
    event({ phase: "test", kind: "full_validation", minute: 4, workUnits: both }),
    event({ phase: "test", kind: "commit_readback", minute: 5, workUnits: both }),
    event({ phase: "github", kind: "github_repository_readback", minute: 6, workUnits: both }),
    event({
      phase: "github",
      kind: "github_draft_pr_readback",
      minute: 7,
      workUnits: [{ workUnitId: "work-1" }],
    }),
    event({
      phase: "test",
      kind: "acceptance_criterion",
      minute: 8,
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: ["AC-1", "AC-2"] }],
    }),
    event({
      phase: "reflect",
      kind: "reflection_writeback",
      minute: 9,
      workUnits: [{ workUnitId: "work-1" }],
    }),
    // Global-looking reflection cannot pay work-2's child-specific gate.
    event({ phase: "reflect", kind: "reflection_writeback", minute: 10 }),
  ];
  const runtime = new ProjectLinearProgressRuntimeV1(new MemoryPersistence());
  const recorded = await runtime.recordEvents({
    runId: "run-42",
    events,
    bindings: [binding, second],
    processedAt: processedAt(10),
  });
  const completed = recorded.pendingCommands.filter(
    (command) => command.target === "completed",
  );
  assert.deepEqual(completed.map((command) => command.workUnitId), ["work-1"]);
  assert.equal(
    recorded.run.cursor.workUnits.find((unit) => unit.workUnitId === "work-2")?.target,
    "ready_for_review",
  );

  await assert.rejects(
    runtime.recordEvents({
      runId: "run-42",
      events: [
        event({
          phase: "test",
          kind: "acceptance_criterion",
          minute: 11,
          workUnits: [{ workUnitId: "work-2", acceptanceCriterionIds: ["AC-not-bound"] }],
        }),
      ],
      bindings: [binding, second],
      processedAt: processedAt(11),
    }),
    /outside its Linear binding/iu,
  );
});

test("late superseded evidence cannot regress an already applied child", async () => {
  const persistence = new MemoryPersistence();
  const runtime = new ProjectLinearProgressRuntimeV1(persistence);
  const recorded = await runtime.recordEvents({
    runId: "run-42",
    events: fullTimeline(),
    bindings: [binding],
    processedAt: processedAt(10),
  });
  for (const [index, command] of recorded.pendingCommands.entries()) {
    await runtime.acknowledgeVerified({
      runId: "run-42",
      commandId: command.commandId,
      commandFingerprint: command.commandFingerprint,
      providerReceiptId: `linear-composite-receipt-${index + 1}`,
      providerReceiptFingerprint: fp(String(index + 1)),
      verifiedAt: processedAt(11 + index),
    });
  }
  assert.equal(await runtime.nextPending("run-42"), null);

  const lateBlocker = event({
    phase: "test",
    kind: "actionable_blocker",
    minute: 3,
    disposition: "blocked",
    workUnits: [{ workUnitId: "work-1" }],
  });
  const afterLateEvidence = await runtime.recordEvents({
    runId: "run-42",
    events: [lateBlocker],
    bindings: [binding],
    processedAt: processedAt(17),
  });
  assert.equal(afterLateEvidence.run.cursor.workUnits[0]?.target, "completed");
  assert.equal(await runtime.nextPending("run-42"), null);
  assert.equal(
    afterLateEvidence.run.outbox.some(
      (item) => item.commentCode === "actionable_blocker_observed",
    ),
    false,
    "a newly discovered historical boundary superseded by applied proof is not dispatchable history",
  );
});

test("namespace parsing, immutable bindings, terminal blocking, and CAS fail closed", async () => {
  const persistence = new MemoryPersistence();
  const runtime = new ProjectLinearProgressRuntimeV1(persistence);
  const recorded = await runtime.recordEvents({
    runId: "run-42",
    events: fullTimeline(),
    bindings: [binding],
    processedAt: processedAt(10),
  });
  assert.throws(
    () => parseProjectLinearProgressNamespaceV1({ ...persistence.value, extra: true }),
    /keys are invalid/iu,
  );
  const { bindingFingerprint: _bindingFingerprint, ...unsignedBinding } = binding;
  const alteredBinding = createProjectWorkUnitLinearBindingV1({
    ...unsignedBinding,
    acceptanceCriterionIds: ["AC-1", "AC-2", "AC-3"],
  });
  await assert.rejects(
    runtime.recordEvents({
      runId: "run-42",
      events: fullTimeline(),
      bindings: [alteredBinding],
      processedAt: processedAt(11),
    }),
    /immutable/iu,
  );

  const first = recorded.pendingCommands[0]!;
  await assert.rejects(
    runtime.recordFailure({
      runId: "run-42",
      commandId: first.commandId,
      commandFingerprint: fp("f"),
      failedAt: processedAt(12),
      error: "This callback belongs to a different prepared command.",
      outcome: "terminal_blocked",
    }),
    /exact pending command/iu,
  );
  await runtime.recordFailure({
    runId: "run-42",
    commandId: first.commandId,
    commandFingerprint: first.commandFingerprint,
    failedAt: processedAt(12),
    error: "The configured Linear state mapping is unavailable.",
    outcome: "terminal_blocked",
  });
  assert.equal(await runtime.nextPending("run-42"), null);

  const conflictPersistence = new MemoryPersistence();
  conflictPersistence.forceConflict = true;
  const conflicting = new ProjectLinearProgressRuntimeV1(conflictPersistence);
  await assert.rejects(
    conflicting.recordEvents({
      runId: "run-42",
      events: fullTimeline(),
      bindings: [binding],
      processedAt: processedAt(10),
    }),
    /compare-and-swap/iu,
  );
});

test("a terminally blocked child does not stop another independently bound child", async () => {
  const second = createBinding({
    workUnitId: "work-2",
    issueId: "issue-uuid-2",
    issueIdentifier: "ENG-43",
    criteria: ["AC-3"],
    character: "d",
  });
  const runtime = new ProjectLinearProgressRuntimeV1(new MemoryPersistence());
  const recorded = await runtime.recordEvents({
    runId: "run-42",
    events: [
      event({ phase: "linear_plan", kind: "linear_hierarchy_readback", minute: 1 }),
    ],
    bindings: [binding, second],
    processedAt: processedAt(1),
  });
  const firstChild = recorded.pendingCommands.find(
    (command) => command.workUnitId === "work-1",
  )!;
  await runtime.recordFailure({
    runId: "run-42",
    commandId: firstChild.commandId,
    commandFingerprint: firstChild.commandFingerprint,
    failedAt: processedAt(2),
    error: "This child's configured state mapping is unavailable.",
    outcome: "terminal_blocked",
  });
  const pending = await runtime.pendingCommands("run-42");
  assert.deepEqual(pending.map((command) => command.workUnitId), ["work-2"]);
});
