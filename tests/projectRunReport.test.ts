import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectPriorPhaseAttestationV1,
  createProjectRunReportV1,
  createProjectStageEventV1,
  deriveProjectPhaseLimitationsV1,
  parseProjectPriorPhaseAttestationV1,
  parseProjectRunReportV1,
  parseProjectStageEventV1,
  reduceProjectStageEventsV1,
  renderProjectRunReportMarkdownV1,
  resolveProjectResultsDestinationV1,
  type ProjectEvidenceKindV1,
  type ProjectPhaseV1,
  type ProjectPriorPhaseAttestationV1,
  type ProjectStageEventV1,
} from "../src/agent/projectRunReport";

const fp = (character: string) => `sha256:${character.repeat(64)}`;

function event(input: {
  phase: ProjectPhaseV1;
  kind: ProjectEvidenceKindV1;
  minute: number;
  disposition?: "verified" | "blocked";
  workUnits?: Array<{ workUnitId: string; acceptanceCriterionIds: string[] }>;
  system?: "vault" | "linear" | "workspace" | "git" | "github";
  url?: string | null;
  path?: string | null;
  revision?: string | null;
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
      system: input.system ?? "workspace",
      resourceType: "artifact",
      id: `${input.kind}-${input.minute}`,
      url: input.url ?? null,
      path: input.path ?? null,
      revision: input.revision ?? null,
    },
    workUnits: input.workUnits ?? [],
  });
}

function completedEvents(): ProjectStageEventV1[] {
  return [
    event({
      phase: "research",
      kind: "research_artifact",
      minute: 0,
      system: "vault",
      path: "Research/Design.md",
    }),
    event({
      phase: "linear_plan",
      kind: "linear_hierarchy_readback",
      minute: 1,
      system: "linear",
      url: "https://linear.app/acme/issue/ENG-42/developer-mission",
    }),
    event({
      phase: "implement",
      kind: "workspace_mutation",
      minute: 2,
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "implement",
      kind: "diff_readback",
      minute: 3,
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "test",
      kind: "targeted_validation",
      minute: 4,
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "test",
      kind: "full_validation",
      minute: 5,
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "test",
      kind: "commit_readback",
      minute: 6,
      system: "git",
      revision: "a".repeat(40),
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "github",
      kind: "github_repository_readback",
      minute: 7,
      system: "github",
      url: "https://github.com/acme/project",
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "github",
      kind: "github_draft_pr_readback",
      minute: 8,
      system: "github",
      url: "https://github.com/acme/project/pull/7",
      revision: "a".repeat(40),
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
    event({
      phase: "reflect",
      kind: "reflection_writeback",
      minute: 9,
      system: "vault",
      path: "Agent Work/Results/project/2026-08-19-run-42.md",
      workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
    }),
  ];
}

test("project stage events are closed, fingerprinted, idempotent evidence", () => {
  const created = completedEvents()[0]!;
  assert.match(created.eventId, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(parseProjectStageEventV1(JSON.parse(JSON.stringify(created))), created);
  assert.throws(
    () => parseProjectStageEventV1({ ...created, modelSummary: "trust me" }),
    /keys are invalid/iu,
  );
  assert.throws(
    () => parseProjectStageEventV1({ ...created, evidenceFingerprint: fp("f") }),
    /event id does not match/iu,
  );
  assert.throws(
    () => createProjectStageEventV1({
      ...created,
      eventId: undefined,
      phase: "github",
      evidenceKind: "commit_readback",
    } as never),
    /keys are invalid|belongs to/iu,
  );
});

test("six phase reducer requires every proof and lets later proof resolve a blocker", () => {
  const evidence = completedEvents();
  const duplicate = evidence[0]!;
  const snapshot = reduceProjectStageEventsV1({
    runId: "run-42",
    events: [...evidence, duplicate],
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(
    snapshot.phases.map((phase) => [phase.label, phase.status]),
    [
      ["Research", "verified"],
      ["Linear plan", "verified"],
      ["Implement", "verified"],
      ["Test", "verified"],
      ["GitHub", "verified"],
      ["Reflect", "verified"],
    ],
  );

  const blocker = event({
    phase: "test",
    kind: "actionable_blocker",
    disposition: "blocked",
    minute: 7,
  });
  const blocked = reduceProjectStageEventsV1({
    runId: "run-42",
    events: [...evidence, blocker],
  });
  assert.equal(blocked.complete, false);
  assert.equal(blocked.phases.find((phase) => phase.phase === "test")?.status, "blocked");

  const repaired = event({
    phase: "test",
    kind: "full_validation",
    minute: 10,
    workUnits: [{ workUnitId: "work-1", acceptanceCriterionIds: [] }],
  });
  assert.equal(
    reduceProjectStageEventsV1({
      runId: "run-42",
      events: [...evidence, blocker, repaired],
    }).phases.find((phase) => phase.phase === "test")?.status,
    "verified",
  );
});

test("Results destination defaults safely and accepts explicit Markdown or Jupyter paths", () => {
  assert.deepEqual(
    resolveProjectResultsDestinationV1({
      projectName: "Native Developer Mission",
      runId: "run-42",
      completedAt: "2026-08-19T12:09:00.000Z",
    }),
    {
      kind: "markdown",
      path: "Agent Work/Results/native-developer-mission/2026-08-19-run-42.md",
      source: "default",
    },
  );
  assert.equal(
    resolveProjectResultsDestinationV1({
      projectName: "Project",
      runId: "run-42",
      completedAt: "2026-08-19T12:09:00.000Z",
      explicitPath: "Experiments/final-reflection.ipynb",
    }).kind,
    "jupyter",
  );
  assert.deepEqual(
    createProjectRunReportV1({
      runId: "run-42",
      projectName: "Native Developer Mission",
      generatedAt: "2026-08-19T12:09:00.000Z",
      destination: {
        kind: "jupyter",
        path: "Agent Work/Results/native-developer-mission/2026-08-19-run-42.ipynb",
        source: "default",
      },
      events: [],
    }).destination,
    {
      kind: "jupyter",
      path: "Agent Work/Results/native-developer-mission/2026-08-19-run-42.ipynb",
      source: "default",
    },
  );
  assert.throws(
    () => resolveProjectResultsDestinationV1({
      projectName: "Project",
      runId: "run-42",
      completedAt: "2026-08-19T12:09:00.000Z",
      explicitPath: "../escape.md",
    }),
    /safe vault-relative/iu,
  );
});

test("report is derived from evidence and renders validation, publication, limits, and exact code", () => {
  const destination = resolveProjectResultsDestinationV1({
    projectName: "Native Developer Mission",
    runId: "run-42",
    completedAt: "2026-08-19T12:09:00.000Z",
  });
  const code = "export function result(): string {\n  return \"verified\";\n}";
  const report = createProjectRunReportV1({
    runId: "run-42",
    projectName: "Native Developer Mission",
    generatedAt: "2026-08-19T12:10:00.000Z",
    destination,
    events: completedEvents(),
    limitations: ["Live merge was intentionally not requested."],
    codeExamples: [
      {
        path: "src/result.ts",
        language: "typescript",
        startLine: 12,
        endLine: 14,
        code,
        sourceReceiptId: "receipt-diff-3",
        sourceFingerprint: fp("3"),
      },
    ],
  });
  assert.equal(report.complete, true);
  assert.equal("workUnitOutcomes" in report, false);
  assert.deepEqual(parseProjectRunReportV1(JSON.parse(JSON.stringify(report))), report);
  const markdown = renderProjectRunReportMarkdownV1(report);
  assert.match(markdown, /## Phase outcomes/u);
  assert.match(markdown, /## High-level phase reflection/u);
  assert.match(markdown, /## Scientific reflection/u);
  assert.match(markdown, /Could the accepted technical direction/iu);
  assert.match(markdown, /six-phase delivery hypothesis is supported/iu);
  assert.match(markdown, /Next experiment: Complete human review/iu);
  assert.match(markdown, /### Research/u);
  assert.match(markdown, /research and high-level design were accepted/iu);
  assert.match(markdown, /### Linear plan/u);
  assert.match(markdown, /Linear readback verified the project plan/u);
  assert.match(markdown, /### Implement/u);
  assert.match(markdown, /verified workspace mutation/iu);
  assert.match(markdown, /### Test/u);
  assert.match(markdown, /Targeted validation passed; fresh full validation passed/u);
  assert.match(markdown, /### GitHub/u);
  assert.match(markdown, /draft pull request/u);
  assert.match(markdown, /### Reflect/u);
  assert.match(markdown, /closes the run with a deterministic reflection/u);
  assert.match(markdown, /Targeted_validation: \*\*verified\*\*/iu);
  assert.match(markdown, /Verified commit: `a{40}`/u);
  assert.match(markdown, /https:\/\/github\.com\/acme\/project\/pull\/7/u);
  assert.match(markdown, /Live merge was intentionally not requested/u);
  assert.ok(markdown.includes(code));
  assert.doesNotMatch(markdown, /chain.of.thought/iu);

  assert.throws(
    () => parseProjectRunReportV1({ ...report, complete: false }),
    /completion must be derived/iu,
  );
});

test("supplied work-unit outcomes expose proof debt and fail closed independently of phase completion", () => {
  const destination = resolveProjectResultsDestinationV1({
    projectName: "Multi-child Developer Mission",
    runId: "run-42",
    completedAt: "2026-08-19T12:10:00.000Z",
  });
  const acceptance = event({
    phase: "test",
    kind: "acceptance_criterion",
    minute: 10,
    system: "git",
    workUnits: [{
      workUnitId: "work-1",
      acceptanceCriterionIds: ["AC-1"],
    }],
  });
  const evidence = [...completedEvents(), acceptance];
  const paid = createProjectRunReportV1({
    runId: "run-42",
    projectName: "Multi-child Developer Mission",
    generatedAt: "2026-08-19T12:11:00.000Z",
    destination,
    events: evidence,
    workUnitOutcomes: [{
      workUnitId: "work-1",
      linearIssueIdentifier: "ENG-42",
      status: "paid",
      paidAcceptanceCriterionIds: ["AC-1"],
      unpaidAcceptanceCriterionIds: [],
      evidenceEventIds: [acceptance.eventId],
      proofDebt: [],
    }],
  });
  assert.equal(paid.complete, true);
  assert.deepEqual(
    parseProjectRunReportV1(JSON.parse(JSON.stringify(paid))),
    paid,
  );

  const unpaid = createProjectRunReportV1({
    runId: "run-42",
    projectName: "Multi-child Developer Mission",
    generatedAt: "2026-08-19T12:11:00.000Z",
    destination,
    events: evidence,
    workUnitOutcomes: [
      paid.workUnitOutcomes![0]!,
      {
        workUnitId: "work-2",
        linearIssueIdentifier: "ENG-43",
        status: "unpaid",
        paidAcceptanceCriterionIds: [],
        unpaidAcceptanceCriterionIds: ["AC-2"],
        evidenceEventIds: [],
        proofDebt: ["No criterion-specific validation receipt for AC-2."],
      },
    ],
  });
  assert.equal(unpaid.phases.every((phase) => phase.status === "verified"), true);
  assert.equal(unpaid.complete, false);
  const markdown = renderProjectRunReportMarkdownV1(unpaid);
  assert.match(markdown, /## Work-unit outcomes/u);
  assert.match(markdown, /ENG-42 \/ work-1/u);
  assert.match(markdown, /ENG-43 \/ work-2/u);
  assert.match(markdown, /Outcome: \*\*Unpaid\*\*/u);
  assert.match(markdown, /No criterion-specific validation receipt for AC-2/u);
  assert.match(markdown, /1 supplied work-unit outcome remains unpaid or blocked/u);
  assert.throws(
    () => parseProjectRunReportV1({ ...unpaid, complete: true }),
    /completion must be derived/iu,
  );
  assert.throws(
    () => createProjectRunReportV1({
      runId: "run-42",
      projectName: "Invalid attribution",
      generatedAt: "2026-08-19T12:11:00.000Z",
      destination,
      events: evidence,
      workUnitOutcomes: [{
        workUnitId: "work-2",
        linearIssueIdentifier: "ENG-43",
        status: "paid",
        paidAcceptanceCriterionIds: [],
        unpaidAcceptanceCriterionIds: [],
        evidenceEventIds: [evidence[0]!.eventId],
        proofDebt: [],
      }],
    }),
    /project-level or differently bound evidence/iu,
  );
});

/**
 * A second-phase mission is handed only a Linear issue id. Its own run ledger
 * legitimately holds no research or planning receipt, because the originating
 * run paid those. The report must not translate that absence into "the research
 * never happened, resume at Research".
 */
function priorPhaseAttestations(): ProjectPriorPhaseAttestationV1[] {
  return [
    createProjectPriorPhaseAttestationV1({
      schemaVersion: 1,
      phase: "research",
      originRunId: "run-phase-a",
      linearIssueId: "linear-issue-1",
      linearIssueIdentifier: "ENG-42",
      evidenceKind: "research_artifact",
      verifiedAt: "2026-08-18T09:00:00.000Z",
      proofFingerprint: fp("7"),
      resource: {
        system: "vault",
        resourceType: "accepted_research_note",
        id: fp("7"),
        url: null,
        path: "Research/Design.md",
        revision: fp("8"),
      },
    }),
    createProjectPriorPhaseAttestationV1({
      schemaVersion: 1,
      phase: "linear_plan",
      originRunId: "run-phase-a",
      linearIssueId: "linear-issue-1",
      linearIssueIdentifier: "ENG-42",
      evidenceKind: "linear_hierarchy_readback",
      verifiedAt: "2026-08-18T09:05:00.000Z",
      proofFingerprint: fp("9"),
      resource: {
        system: "linear",
        resourceType: "project_hierarchy",
        id: "linear-project-1",
        url: null,
        path: null,
        revision: fp("a"),
      },
    }),
  ];
}

function secondPhaseEvents(): ProjectStageEventV1[] {
  return completedEvents().filter(
    (candidate) =>
      candidate.phase !== "research" && candidate.phase !== "linear_plan",
  );
}

test("durable prior-run lineage resolves a phase without ever promoting it to plain verified", () => {
  const events = secondPhaseEvents();
  const withoutLineage = reduceProjectStageEventsV1({
    runId: "run-42",
    events,
  });
  assert.deepEqual(
    withoutLineage.phases.map((phase) => [phase.phase, phase.status]),
    [
      ["research", "pending"],
      ["linear_plan", "pending"],
      ["implement", "verified"],
      ["test", "verified"],
      ["github", "verified"],
      ["reflect", "verified"],
    ],
  );
  assert.equal(withoutLineage.complete, false);

  const attestations = priorPhaseAttestations();
  const resolved = reduceProjectStageEventsV1({
    runId: "run-42",
    events,
    priorPhaseAttestations: attestations,
  });
  const research = resolved.phases.find((phase) => phase.phase === "research")!;
  const linearPlan = resolved.phases.find(
    (phase) => phase.phase === "linear_plan",
  )!;
  // The pin: recovered is not the same as verified-in-this-run. Anything that
  // collapses these two statuses claims evidence this run never held.
  assert.equal(research.status, "verified_prior_run");
  assert.notEqual(research.status, "verified");
  assert.equal(linearPlan.status, "verified_prior_run");
  assert.notEqual(linearPlan.status, "verified");
  assert.equal(research.priorRunAttestationId, attestations[0]!.attestationId);
  assert.equal(research.startedAt, "2026-08-18T09:00:00.000Z");
  assert.equal(research.completedAt, "2026-08-18T09:00:00.000Z");
  assert.deepEqual(research.evidenceEventIds, []);
  assert.equal(resolved.complete, true);
  assert.equal(
    resolved.phases.filter((phase) => phase.status === "verified").length,
    4,
  );
});

test("a run with no durable lineage keeps its unresolved phases pending and still advises resuming", () => {
  const destination = resolveProjectResultsDestinationV1({
    projectName: "Second Phase",
    runId: "run-42",
    completedAt: "2026-08-19T12:09:00.000Z",
  });
  const report = createProjectRunReportV1({
    runId: "run-42",
    projectName: "Second Phase",
    generatedAt: "2026-08-19T12:10:00.000Z",
    destination,
    events: secondPhaseEvents(),
  });
  assert.equal("priorPhaseAttestations" in report, false);
  assert.deepEqual(
    report.phases.map((phase) => phase.status),
    ["pending", "pending", "verified", "verified", "verified", "verified"],
  );
  assert.equal(report.complete, false);
  const markdown = renderProjectRunReportMarkdownV1(report);
  assert.match(markdown, /- Outcome: Incomplete/u);
  assert.match(markdown, /- Research: \*\*Pending\*\*/u);
  assert.match(markdown, /Research, Linear plan remain open/u);
  assert.match(markdown, /Next experiment: Resume at Research/u);
});

test("a lineage-resolved report reports the recovered phases as done and stops advising a redo", () => {
  const destination = resolveProjectResultsDestinationV1({
    projectName: "Second Phase",
    runId: "run-42",
    completedAt: "2026-08-19T12:09:00.000Z",
  });
  const attestations = priorPhaseAttestations();
  const report = createProjectRunReportV1({
    runId: "run-42",
    projectName: "Second Phase",
    generatedAt: "2026-08-19T12:10:00.000Z",
    destination,
    events: secondPhaseEvents(),
    priorPhaseAttestations: attestations,
    limitations: deriveProjectPhaseLimitationsV1(
      reduceProjectStageEventsV1({
        runId: "run-42",
        events: secondPhaseEvents(),
        priorPhaseAttestations: attestations,
      }).phases,
    ),
  });
  assert.equal(report.complete, true);
  // The signed payload must survive a durable round trip, phases and all.
  assert.deepEqual(
    parseProjectRunReportV1(JSON.parse(JSON.stringify(report))),
    report,
  );

  const markdown = renderProjectRunReportMarkdownV1(report);
  assert.match(markdown, /- Outcome: Complete/u);
  assert.match(markdown, /- Research: \*\*Verified prior run\*\*/u);
  assert.match(markdown, /- Linear plan: \*\*Verified prior run\*\*/u);
  assert.doesNotMatch(markdown, /- Research: \*\*Pending\*\*/u);
  assert.doesNotMatch(markdown, /Next experiment: Resume at Research/u);
  assert.doesNotMatch(markdown, /Research, Linear plan remain open/u);
  assert.match(
    markdown,
    /research and high-level design were completed and verified in the originating run `run-phase-a`/u,
  );
  assert.match(markdown, /readback of Linear issue ENG-42 and bound to `Research\/Design\.md`/u);
  assert.match(
    markdown,
    /Linear plan was completed and verified in the originating run `run-phase-a`/u,
  );
  assert.match(markdown, /2 more are verified by durable prior-run lineage/u);
  assert.match(
    markdown,
    /Research, Linear plan were verified in the originating run `run-phase-a`/u,
  );
  // The recovered phases stay on the record as an explicit caveat rather than
  // silently disappearing from the report.
  assert.match(
    markdown,
    /Research was verified in the originating run of this project, not re-verified/u,
  );
  assert.match(
    markdown,
    /Research — research_artifact \(prior run `run-phase-a`, Linear issue ENG-42\)/u,
  );
});

test("prior-run attestations never invent evidence, overwrite this run's ledger, or name this run", () => {
  const attestations = priorPhaseAttestations();
  // Current-run evidence always outranks a prior-run fact, including a blocker
  // that must not be papered over by an older success.
  const blocked = reduceProjectStageEventsV1({
    runId: "run-42",
    events: [
      ...secondPhaseEvents(),
      event({
        phase: "research",
        kind: "actionable_blocker",
        disposition: "blocked",
        minute: 11,
      }),
    ],
    priorPhaseAttestations: attestations,
  });
  const blockedResearch = blocked.phases.find(
    (phase) => phase.phase === "research",
  )!;
  assert.equal(blockedResearch.status, "blocked");
  assert.equal(blockedResearch.priorRunAttestationId, undefined);
  assert.equal(blocked.complete, false);

  // An attestation whose origin is this very run would be a self-signed claim.
  assert.throws(
    () => reduceProjectStageEventsV1({
      runId: "run-phase-a",
      events: [],
      priorPhaseAttestations: attestations,
    }),
    /cannot name the current run as its origin/iu,
  );

  // Only a proof kind that would itself have completed the phase may attest it.
  const unsigned = {
    schemaVersion: 1,
    phase: "research",
    originRunId: "run-phase-a",
    linearIssueId: "linear-issue-1",
    linearIssueIdentifier: "ENG-42",
    evidenceKind: "research_artifact",
    verifiedAt: "2026-08-18T09:00:00.000Z",
    proofFingerprint: fp("7"),
    resource: attestations[0]!.resource,
  };
  assert.deepEqual(
    createProjectPriorPhaseAttestationV1(unsigned as never),
    attestations[0],
  );
  assert.throws(
    () => createProjectPriorPhaseAttestationV1({
      ...unsigned,
      evidenceKind: "workspace_mutation",
    } as never),
    /cannot attest the research phase/iu,
  );
  // Implementation, validation, publication, and reflection are this run's own
  // work; no cross-run join may speak for them at all.
  assert.throws(
    () => createProjectPriorPhaseAttestationV1({
      ...unsigned,
      phase: "implement",
      evidenceKind: "workspace_mutation",
    } as never),
    /project prior phase must be one of/iu,
  );
  assert.throws(
    () => createProjectPriorPhaseAttestationV1({
      ...unsigned,
      phase: "github",
      evidenceKind: "github_repository_readback",
    } as never),
    /project prior phase must be one of/iu,
  );
  // A tampered attestation cannot ride into the report on a stale id.
  assert.throws(
    () => parseProjectPriorPhaseAttestationV1({
      ...attestations[0]!,
      originRunId: "run-phase-forged",
    }),
    /does not match its canonical payload/iu,
  );
  assert.throws(
    () => reduceProjectStageEventsV1({
      runId: "run-42",
      events: secondPhaseEvents(),
      priorPhaseAttestations: [attestations[0]!, attestations[0]!],
    }),
    /must not name a phase twice/iu,
  );
});
