import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgeLinearProgressOutboxItemV1,
  createProjectWorkUnitLinearBindingV1,
  formatLinearProgressCommentV1,
  parseLinearProgressOutboxItemV1,
  parseProjectWorkUnitLinearBindingV1,
  projectLinearProgressV1,
  projectWorkUnitOutcomesV1,
  recordLinearProgressOutboxFailureV1,
} from "../src/agent/projectProgressProjection";
import {
  createProjectStageEventV1,
  type ProjectEvidenceKindV1,
  type ProjectPhaseV1,
  type ProjectStageEventV1,
} from "../src/agent/projectRunReport";

const fp = (character: string) => `sha256:${character.repeat(64)}`;

const binding = createProjectWorkUnitLinearBindingV1({
  schemaVersion: 1,
  bindingId: "binding-work-1",
  runId: "run-42",
  workUnitId: "work-1",
  linearIssueId: "issue-uuid-1",
  linearIssueIdentifier: "ENG-42",
  linearIssueUrl: "https://linear.app/acme/issue/ENG-42/developer-mission",
  acceptanceCriterionIds: ["AC-2", "AC-1"],
  providerReadbackFingerprint: fp("a"),
  verifiedAt: "2026-08-19T12:00:00.000Z",
});

function event(input: {
  phase: ProjectPhaseV1;
  kind: ProjectEvidenceKindV1;
  minute: number;
  disposition?: "verified" | "blocked";
  acceptanceCriterionIds?: string[];
  global?: boolean;
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
      system: input.phase === "linear_plan" ? "linear" : "workspace",
      resourceType: "artifact",
      id: `${input.kind}-${input.minute}`,
      url: null,
      path: null,
      revision: input.kind === "commit_readback" ? "a".repeat(40) : null,
    },
    workUnits: input.global
      ? []
      : [
          {
            workUnitId: "work-1",
            acceptanceCriterionIds: input.acceptanceCriterionIds ?? [],
          },
        ],
  });
}

const at = (minute: number) =>
  `2026-08-19T13:${String(minute).padStart(2, "0")}:00.000Z`;

test("work-unit binding is exact, canonical, and requires acceptance criteria", () => {
  assert.deepEqual(binding.acceptanceCriterionIds, ["AC-1", "AC-2"]);
  assert.deepEqual(
    parseProjectWorkUnitLinearBindingV1(JSON.parse(JSON.stringify(binding))),
    binding,
  );
  assert.throws(
    () => parseProjectWorkUnitLinearBindingV1({ ...binding, extra: true }),
    /keys are invalid/iu,
  );
  assert.throws(
    () => createProjectWorkUnitLinearBindingV1({
      ...binding,
      bindingFingerprint: undefined,
      acceptanceCriterionIds: [],
    } as never),
    /keys are invalid|requires 1/iu,
  );
});

test("projection follows verified phase boundaries and is idempotent across restarts", () => {
  const linear = event({
    phase: "linear_plan",
    kind: "linear_hierarchy_readback",
    minute: 1,
    global: true,
  });
  const first = projectLinearProgressV1({
    runId: "run-42",
    events: [linear],
    bindings: [binding],
    projectedAt: at(1),
  });
  assert.equal(first.cursor.workUnits[0]?.target, "ready");
  assert.equal(first.outbox.length, 1);

  const restarted = projectLinearProgressV1({
    runId: "run-42",
    events: [linear, linear],
    bindings: [binding],
    previousCursor: first.cursor,
    previousOutbox: first.outbox,
    projectedAt: at(2),
  });
  assert.equal(restarted.outbox.length, 1, "same durable event must not enqueue twice");
  assert.equal(restarted.cursor.revision, 1, "an exact replay must preserve the cursor revision");

  const implemented = projectLinearProgressV1({
    runId: "run-42",
    events: [
      linear,
      event({ phase: "implement", kind: "workspace_mutation", minute: 2 }),
    ],
    bindings: [binding],
    previousCursor: restarted.cursor,
    previousOutbox: restarted.outbox,
    projectedAt: at(3),
  });
  assert.equal(implemented.cursor.workUnits[0]?.target, "in_progress");
  assert.equal(implemented.outbox.length, 2);
});

test("actionable blocker wins until newer verified progress and validation needs all receipts", () => {
  const base = [
    event({
      phase: "linear_plan",
      kind: "linear_hierarchy_readback",
      minute: 1,
      global: true,
    }),
    event({ phase: "implement", kind: "workspace_mutation", minute: 2 }),
    event({ phase: "test", kind: "targeted_validation", minute: 3 }),
    event({
      phase: "test",
      kind: "actionable_blocker",
      disposition: "blocked",
      minute: 4,
    }),
  ];
  const blocked = projectLinearProgressV1({
    runId: "run-42",
    events: base,
    bindings: [binding],
    projectedAt: at(4),
  });
  assert.equal(blocked.cursor.workUnits[0]?.target, "blocked");

  const onlyFull = projectLinearProgressV1({
    runId: "run-42",
    events: [
      ...base,
      event({ phase: "test", kind: "full_validation", minute: 5 }),
    ],
    bindings: [binding],
    projectedAt: at(5),
  });
  assert.equal(
    onlyFull.cursor.workUnits[0]?.target,
    "in_progress",
    "new proof resolves the blocker but cannot skip missing commit readback",
  );

  const validated = projectLinearProgressV1({
    runId: "run-42",
    events: [
      ...base,
      event({ phase: "test", kind: "full_validation", minute: 5 }),
      event({ phase: "test", kind: "commit_readback", minute: 6 }),
    ],
    bindings: [binding],
    projectedAt: at(6),
  });
  assert.equal(validated.cursor.workUnits[0]?.target, "ready_for_review");
});

test("reflection cannot close an issue until its own acceptance evidence is paid", () => {
  const publication = [
    event({
      phase: "linear_plan",
      kind: "linear_hierarchy_readback",
      minute: 1,
      global: true,
    }),
    event({ phase: "implement", kind: "workspace_mutation", minute: 2 }),
    event({ phase: "test", kind: "targeted_validation", minute: 3 }),
    event({ phase: "test", kind: "full_validation", minute: 4 }),
    event({ phase: "test", kind: "commit_readback", minute: 5 }),
    event({ phase: "github", kind: "github_repository_readback", minute: 6 }),
    event({ phase: "github", kind: "github_draft_pr_readback", minute: 7 }),
    event({ phase: "reflect", kind: "reflection_writeback", minute: 8 }),
  ];
  const unpaid = projectLinearProgressV1({
    runId: "run-42",
    events: publication,
    bindings: [binding],
    projectedAt: at(8),
  });
  assert.equal(unpaid.cursor.workUnits[0]?.target, "in_review");
  assert.deepEqual(unpaid.cursor.workUnits[0]?.unpaidAcceptanceCriterionIds, ["AC-1", "AC-2"]);

  const partlyPaid = projectLinearProgressV1({
    runId: "run-42",
    events: [
      ...publication,
      event({
        phase: "test",
        kind: "acceptance_criterion",
        minute: 9,
        acceptanceCriterionIds: ["AC-1"],
      }),
    ],
    bindings: [binding],
    projectedAt: at(9),
  });
  assert.equal(partlyPaid.cursor.workUnits[0]?.target, "in_review");
  assert.deepEqual(partlyPaid.cursor.workUnits[0]?.unpaidAcceptanceCriterionIds, ["AC-2"]);

  const paid = projectLinearProgressV1({
    runId: "run-42",
    events: [
      ...publication,
      event({
        phase: "test",
        kind: "acceptance_criterion",
        minute: 9,
        acceptanceCriterionIds: ["AC-1", "AC-2"],
      }),
    ],
    bindings: [binding],
    projectedAt: at(10),
  });
  assert.equal(paid.cursor.workUnits[0]?.target, "completed");
  assert.deepEqual(paid.cursor.workUnits[0]?.unpaidAcceptanceCriterionIds, []);
});

test("work-unit Results outcomes require exact child-bound acceptance, publication, PR, and reflection evidence", () => {
  const acceptance = event({
    phase: "test",
    kind: "acceptance_criterion",
    minute: 1,
    acceptanceCriterionIds: ["AC-1", "AC-2"],
  });
  const repository = event({
    phase: "github",
    kind: "github_repository_readback",
    minute: 2,
  });
  const aggregatePr = event({
    phase: "github",
    kind: "github_draft_pr_readback",
    minute: 3,
    global: true,
  });
  const aggregateReflection = event({
    phase: "reflect",
    kind: "reflection_writeback",
    minute: 4,
    global: true,
  });
  const unpaid = projectWorkUnitOutcomesV1({
    runId: "run-42",
    events: [acceptance, repository, aggregatePr, aggregateReflection],
    bindings: [binding],
    projectedAt: at(4),
  });
  assert.equal(unpaid[0]?.status, "unpaid");
  assert.deepEqual(unpaid[0]?.paidAcceptanceCriterionIds, ["AC-1", "AC-2"]);
  assert.deepEqual(unpaid[0]?.unpaidAcceptanceCriterionIds, []);
  assert.equal(unpaid[0]?.evidenceEventIds.includes(aggregatePr.eventId), false);
  assert.equal(unpaid[0]?.evidenceEventIds.includes(aggregateReflection.eventId), false);
  assert.match(unpaid[0]?.proofDebt.join("\n") ?? "", /draft pull request/iu);
  assert.match(unpaid[0]?.proofDebt.join("\n") ?? "", /Results reflection/iu);

  const exactPr = event({
    phase: "github",
    kind: "github_draft_pr_readback",
    minute: 5,
  });
  const exactReflection = event({
    phase: "reflect",
    kind: "reflection_writeback",
    minute: 6,
  });
  const paid = projectWorkUnitOutcomesV1({
    runId: "run-42",
    events: [acceptance, repository, exactPr, exactReflection],
    bindings: [binding],
    projectedAt: at(6),
  });
  assert.equal(paid[0]?.status, "paid");
  assert.deepEqual(paid[0]?.proofDebt, []);
  assert.equal(paid[0]?.evidenceEventIds.includes(exactPr.eventId), true);
  assert.equal(paid[0]?.evidenceEventIds.includes(exactReflection.eventId), true);
});

test("an unresolved exact child blocker produces a blocked Results outcome", () => {
  const blocker = event({
    phase: "implement",
    kind: "actionable_blocker",
    disposition: "blocked",
    minute: 2,
  });
  const outcomes = projectWorkUnitOutcomesV1({
    runId: "run-42",
    events: [
      event({ phase: "implement", kind: "workspace_mutation", minute: 1 }),
      blocker,
    ],
    bindings: [binding],
    projectedAt: at(2),
  });
  assert.equal(outcomes[0]?.status, "blocked");
  assert.equal(outcomes[0]?.evidenceEventIds.includes(blocker.eventId), true);
  assert.match(outcomes[0]?.proofDebt.join("\n") ?? "", /blocker evidence/iu);
});

test("outbox supports retry, terminal failure, and receipt-backed acknowledgement", () => {
  const projection = projectLinearProgressV1({
    runId: "run-42",
    events: [
      event({
        phase: "linear_plan",
        kind: "linear_hierarchy_readback",
        minute: 1,
        global: true,
      }),
    ],
    bindings: [binding],
    projectedAt: at(1),
  });
  const pending = projection.outbox[0]!;
  const retry = recordLinearProgressOutboxFailureV1(pending, {
    at: at(2),
    error: "Provider timed out before readback.",
    retryable: true,
  });
  assert.equal(retry.status, "pending");
  assert.equal(retry.attemptCount, 1);
  const blocked = recordLinearProgressOutboxFailureV1(retry, {
    at: at(3),
    error: "Configured state mapping is unavailable.",
    retryable: false,
  });
  assert.equal(blocked.status, "blocked");

  const applied = acknowledgeLinearProgressOutboxItemV1(retry, {
    at: at(4),
    providerReceiptId: "linear-receipt-42",
    providerReceiptFingerprint: fp("b"),
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.appliedReceiptId, "linear-receipt-42");
  assert.deepEqual(parseLinearProgressOutboxItemV1(JSON.parse(JSON.stringify(applied))), applied);
  assert.match(formatLinearProgressCommentV1(applied), /Project plan and issue readback verified/iu);
  assert.doesNotMatch(formatLinearProgressCommentV1(applied), /sha256:/iu);
});
