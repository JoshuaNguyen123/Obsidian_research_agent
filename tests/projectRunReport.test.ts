import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectRunReportV1,
  createProjectStageEventV1,
  parseProjectRunReportV1,
  parseProjectStageEventV1,
  reduceProjectStageEventsV1,
  renderProjectRunReportMarkdownV1,
  resolveProjectResultsDestinationV1,
  type ProjectEvidenceKindV1,
  type ProjectPhaseV1,
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
