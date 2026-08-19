import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceProjectLineageV1,
  createProjectLineageV1,
  createResearcherHandoffV1,
  type ProjectLineageV1,
} from "../src/agent/projectLifecycle";
import {
  createProjectStageEventV1,
  parseProjectRunReportV1,
  type ProjectStageEventV1,
} from "../src/agent/projectRunReport";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";
import {
  WRITE_PROJECT_RESULTS_TOOL_NAME,
  createProjectResultsTool,
} from "../src/tools/projectResultsTool";
import type { ToolExecutionContext } from "../src/tools/types";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";

const NOW = "2026-08-19T16:00:00.000Z";
const RUN_ID = "run-project-results-1";
const SHA = (character: string) => `sha256:${character.repeat(64)}`;

class MemoryVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  createCalls = 0;
  folderCreateCalls = 0;

  getAbstractFileByPath(path: string) {
    if (this.files.has(path)) {
      return { path, name: path.split("/").at(-1)!, extension: "md" };
    }
    if (this.folders.has(path)) {
      return { path, name: path.split("/").at(-1)!, children: [] };
    }
    return null;
  }

  async createFolder(path: string): Promise<void> {
    this.folderCreateCalls += 1;
    this.folders.add(path);
  }

  async create(path: string, content: string) {
    this.createCalls += 1;
    if (this.files.has(path) || this.folders.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent && !this.folders.has(parent)) throw new Error(`missing parent: ${parent}`);
    this.files.set(path, content);
    return { path, name: path.split("/").at(-1)!, extension: "md" };
  }

  async read(file: { path: string }): Promise<string> {
    const value = this.files.get(file.path);
    if (value === undefined) throw new Error(`missing ${file.path}`);
    return value;
  }
}

test("prepared Results creation seals every Markdown byte, creates once, and returns exact readback", async () => {
  const vault = new MemoryVault();
  const tool = createProjectResultsTool();
  const context = toolContext(vault);
  const prepared = await tool.prepare!({}, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const path = prepared.action.target.path!;
  assert.equal(
    path,
    "Agent Work/Results/project-run-project-results-1/2026-08-19-run-project-results-1.md",
  );
  assert.equal(prepared.action.expectedTargetRevision, "absent");
  assert.equal(
    prepared.action.preview.outboundPayload?.markdownContent,
    prepared.action.normalizedArgs.proposedMarkdown,
  );
  assert.equal(
    prepared.action.preview.outboundBytes,
    new TextEncoder().encode(
      prepared.action.normalizedArgs.proposedMarkdown as string,
    ).byteLength,
  );
  assert.equal(vault.files.has(path), false);

  const execution = await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-project-results-1",
    },
  });
  assert.equal(vault.createCalls, 1);
  assert.equal(vault.files.get(path), prepared.action.normalizedArgs.proposedMarkdown);
  assert.equal(execution.receipt.toolName, WRITE_PROJECT_RESULTS_TOOL_NAME);
  assert.equal(execution.receipt.operation, "create");
  assert.equal(execution.receipt.commitKind, "committed");
  assert.equal(execution.receipt.grantId, "approval-project-results-1");
  assert.equal(execution.receipt.readback.status, "verified");
  assert.equal(
    execution.receipt.readback.observedFingerprint,
    prepared.action.normalizedArgs.expectedAfterSha256,
  );
  assert.equal(execution.receipt.effects?.affectedCount, 1);
  const report = parseProjectRunReportV1(
    (execution.output as Record<string, unknown>).report,
  );
  assert.equal(report.runId, RUN_ID);
  assert.equal(report.workUnitOutcomes, undefined);
  assert.equal(report.complete, false);
  assert.match(vault.files.get(path) ?? "", /- Outcome: Incomplete/u);
  assert.match(vault.files.get(path) ?? "", /## Phase outcomes/u);
});

test("Results destination is host-resolved from a Results-labelled prompt and never redirects to an input note", async () => {
  const explicitVault = new MemoryVault();
  const explicit = await createProjectResultsTool().prepare!(
    {},
    toolContext(explicitVault, {
      originalPrompt:
        "Write the project results report to `Reports/Final Results.md` after validation.",
    }),
  );
  assert.equal(
    explicit.ok,
    true,
    explicit.ok ? undefined : JSON.stringify(explicit.error),
  );
  if (explicit.ok) {
    assert.equal(explicit.action.target.path, "Reports/Final Results.md");
    assert.equal(
      (explicit.action.normalizedArgs.report as { destination: { source: string } })
        .destination.source,
      "explicit",
    );
  }

  const inputOnly = await createProjectResultsTool().prepare!(
    {},
    toolContext(new MemoryVault(), {
      originalPrompt:
        "Read `Research/Input.md`, complete the project, and write project results.",
    }),
  );
  assert.equal(inputOnly.ok, true);
  if (inputOnly.ok) {
    assert.notEqual(inputOnly.action.target.path, "Research/Input.md");
    assert.match(inputOnly.action.target.path ?? "", /^Agent Work\/Results\//u);
  }

  explicitVault.files.set("Reports/Final Results.md", "existing\n");
  const existing = await createProjectResultsTool().prepare!(
    {},
    toolContext(explicitVault, {
      originalPrompt: "Write project results to `Reports/Final Results.md`.",
    }),
  );
  assert.equal(existing.ok, false);
  if (!existing.ok) assert.equal(existing.error.code, "project_results_target_exists");

  const injected = await createProjectResultsTool().prepare!(
    { path: "Redirect.md", markdown: "Invented report" },
    toolContext(new MemoryVault()),
  );
  assert.equal(injected.ok, false);
  if (!injected.ok) assert.equal(injected.error.code, "project_results_invalid_arguments");
});

test("Results code examples come only from the exact lineage-bound verified handoff", async () => {
  const vault = new MemoryVault();
  const { examples } = verifiedCodeReflectionFixture("b".repeat(40));
  const lineage = fullCodeLineage(examples.commitSha);
  let resolutionCalls = 0;
  const context = toolContext(vault, {
    getProjectStageEvents: () => [],
    getProjectLineages: () => [lineage],
    resolveVerifiedCodeReflectionExamples: async (input) => {
      resolutionCalls += 1;
      assert.deepEqual(input, {
        repositoryProfileKey: "reflection-fixture",
        commitSha: examples.commitSha,
      });
      return examples;
    },
  });
  const prepared = await createProjectResultsTool().prepare!({}, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(resolutionCalls, 1);
  assert.notEqual(prepared.action.normalizedArgs.verifiedCodeExamples, null);
  const report = parseProjectRunReportV1(prepared.action.normalizedArgs.report);
  assert.equal(report.codeExamples.length, 1);
  assert.equal(report.codeExamples[0]?.path, "src/add.ts");
  assert.match(report.codeExamples[0]?.code ?? "", /return left \+ right/u);
  assert.match(
    prepared.action.normalizedArgs.proposedMarkdown as string,
    /## Verified code examples/u,
  );
  assert.equal(report.complete, true);
  assert.equal(
    report.phases.find((phase) => phase.phase === "github")?.status,
    "verified",
  );
  assert.equal(
    report.phases.find((phase) => phase.phase === "reflect")?.status,
    "verified",
  );
  const path = prepared.action.target.path!;
  assert.equal(vault.files.has(path), false);
  await createProjectResultsTool().executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-complete-project-results",
    },
  });
  assert.match(vault.files.get(path) ?? "", /- Outcome: Complete/u);
  assert.match(vault.files.get(path) ?? "", /- Reflect: \*\*Verified\*\*/u);

  const unavailable = await createProjectResultsTool().prepare!(
    {},
    toolContext(new MemoryVault(), {
      getProjectStageEvents: () => [],
      getProjectLineages: () => [lineage],
      resolveVerifiedCodeReflectionExamples: async () => null,
    }),
  );
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(
      unavailable.error.code,
      "project_results_code_examples_unavailable",
    );
  }
});

test("Results derives paid child outcomes only from exact bound acceptance, PR, and prospective reflection evidence", async () => {
  const lineage = workUnitLineage();
  const exactEvents = [
    workUnitEvent("acceptance_criterion", "test", 1, ["issue-a:AC-1"]),
    workUnitEvent("github_repository_readback", "github", 2),
    workUnitEvent("github_draft_pr_readback", "github", 3),
  ];
  const prepared = await createProjectResultsTool().prepare!(
    {},
    toolContext(new MemoryVault(), {
      getProjectLineages: () => [lineage],
      getProjectStageEvents: (requestedRunId) => {
        assert.equal(requestedRunId, RUN_ID);
        return exactEvents;
      },
    }),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const report = parseProjectRunReportV1(prepared.action.normalizedArgs.report);
  assert.equal(report.workUnitOutcomes?.length, 1);
  assert.equal(report.workUnitOutcomes?.[0]?.workUnitId, "issue-a");
  assert.equal(report.workUnitOutcomes?.[0]?.linearIssueIdentifier, "ENG-42");
  assert.equal(report.workUnitOutcomes?.[0]?.status, "paid");
  assert.deepEqual(report.workUnitOutcomes?.[0]?.proofDebt, []);
  const reflection = report.evidence.find(
    (event) => event.evidenceKind === "reflection_writeback",
  );
  assert.deepEqual(reflection?.workUnits, [{
    workUnitId: "issue-a",
    acceptanceCriterionIds: [],
  }]);

  const aggregateOnly = await createProjectResultsTool().prepare!(
    {},
    toolContext(new MemoryVault(), {
      getProjectLineages: () => [lineage],
      getProjectStageEvents: () => [
        exactEvents[0]!,
        workUnitEvent("github_repository_readback", "github", 2, [], false),
        workUnitEvent("github_draft_pr_readback", "github", 3, [], false),
      ],
    }),
  );
  assert.equal(aggregateOnly.ok, true);
  if (!aggregateOnly.ok) {
    return;
  }
  const aggregateReport = parseProjectRunReportV1(
    aggregateOnly.action.normalizedArgs.report,
  );
  assert.equal(aggregateReport.workUnitOutcomes?.[0]?.status, "unpaid");
  assert.match(
    aggregateReport.workUnitOutcomes?.[0]?.proofDebt.join("\n") ?? "",
    /draft pull request/iu,
  );
});

test("Results reconciliation identifies absence or exact bytes and never replays creation", async () => {
  const vault = new MemoryVault();
  const tool = createProjectResultsTool();
  const context = toolContext(vault);
  const prepared = await tool.prepare!({}, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const path = prepared.action.target.path!;

  const absent = await tool.reconcile!(prepared.action, context);
  assert.equal(absent.outcome, "not_applied");
  assert.match(absent.message, /did not replay/iu);
  assert.equal(vault.createCalls, 0);

  await tool.executePrepared!(prepared.action, {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "approval-project-results-reconcile",
    },
  });
  assert.equal(vault.createCalls, 1);
  const committed = await tool.reconcile!(prepared.action, context);
  assert.equal(committed.outcome, "committed");
  assert.equal(committed.receipt?.commitKind, "reconciled");
  assert.equal(committed.receipt?.grantId, "reconciled-exact-readback");
  assert.match(committed.message, /no create was replayed/iu);
  assert.equal(vault.createCalls, 1);

  vault.files.set(path, "unrelated content\n");
  const uncertain = await tool.reconcile!(prepared.action, context);
  assert.equal(uncertain.outcome, "still_uncertain");
  assert.equal(vault.createCalls, 1);
});

test("Results execution rejects stale occupancy and an inexact approval without overwriting", async () => {
  const vault = new MemoryVault();
  const tool = createProjectResultsTool();
  const context = toolContext(vault);
  const prepared = await tool.prepare!({}, context);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const path = prepared.action.target.path!;

  await assert.rejects(
    () =>
      tool.executePrepared!(prepared.action, {
        ...context,
        authorizedAction: {
          preparedActionId: prepared.action.id,
          payloadFingerprint: SHA("f"),
          grantId: "wrong-approval",
        },
      }),
    /exact approval binding/iu,
  );
  vault.files.set(path, "concurrent file\n");
  await assert.rejects(
    () =>
      tool.executePrepared!(prepared.action, {
        ...context,
        authorizedAction: {
          preparedActionId: prepared.action.id,
          payloadFingerprint: prepared.action.payloadFingerprint,
          grantId: "approval-stale-results",
        },
      }),
    /never overwrites/iu,
  );
  assert.equal(vault.files.get(path), "concurrent file\n");
  assert.equal(vault.createCalls, 0);
});

function toolContext(
  vault: MemoryVault,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    app: { vault } as unknown as ToolExecutionContext["app"],
    settings: {} as ToolExecutionContext["settings"],
    originalPrompt: "Complete the project and write project results.",
    runId: RUN_ID,
    rootMissionId: RUN_ID,
    operationId: "call-project-results-1",
    httpTransport: async () => {
      throw new Error("unused");
    },
    now: () => new Date(NOW),
    getProjectStageEvents: () => [researchEvent()],
    ...overrides,
  };
}

function researchEvent(): ProjectStageEventV1 {
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: RUN_ID,
    phase: "research",
    evidenceKind: "research_artifact",
    disposition: "verified",
    occurredAt: "2026-08-19T15:00:00.000Z",
    sourceReceiptId: "receipt-research-1",
    evidenceFingerprint: SHA("1"),
    resource: {
      system: "vault",
      resourceType: "accepted_research_note",
      id: "accepted-research-1",
      url: null,
      path: "Research/Accepted.md",
      revision: SHA("2"),
    },
    workUnits: [],
  });
}

function fullCodeLineage(commitSha: string): ProjectLineageV1 {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-results-research-1",
    originRunId: RUN_ID,
    vaultBindingKey: "vault-results-1",
    notePath: "Research/Accepted.md",
    noteSha256: SHA("1"),
    noteReceiptId: "note-results-receipt-1",
    evidence: [{
      id: "evidence-results-web-1",
      kind: "web",
      reference: "https://example.com/results-research",
      contentSha256: SHA("2"),
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The Results report contains exact verified evidence.",
    }],
    riskClass: "medium",
    acceptedAt: "2026-08-19T15:00:00.000Z",
    acceptedBy: "host",
  });
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: RUN_ID,
    taskId: "results-research-task-1",
    evidenceIds: ["evidence-results-web-1"],
    summary: "Accepted research for the deterministic Results fixture.",
    unresolvedQuestions: [],
    acceptedAt: "2026-08-19T15:00:00.000Z",
  });
  let lineage = createProjectLineageV1({
    lineageId: "lineage-project-results-1",
    runId: RUN_ID,
    vaultBindingKey: "vault-results-1",
    handoff,
    updatedAt: "2026-08-19T15:00:00.000Z",
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T15:01:00.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("3"),
      workspaceId: "linear-workspace-1",
      teamId: "linear-team-1",
      initiativeId: "linear-initiative-1",
      projectId: "linear-project-1",
      issueIds: ["linear-issue-1"],
      workItemFingerprints: [SHA("4")],
      providerReadbackFingerprints: [SHA("5"), SHA("6"), SHA("7")],
    },
  });
  const codeProof = {
    stage: "code_execution" as const,
    repositoryProfileKey: "reflection-fixture",
    repositoryProfileFingerprint: SHA("8"),
    workspaceId: "code-workspace-1",
    validationReceiptFingerprints: [SHA("9"), SHA("a")],
    diffFingerprint: SHA("b"),
    targetedValidationPassed: true as const,
    freshFullValidationPassed: true as const,
    commitSha,
    commitReadbackFingerprint: SHA("c"),
  };
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T15:02:00.000Z",
    proof: codeProof,
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T15:03:00.000Z",
    proof: {
      ...codeProof,
      stage: "code_validation",
      validationReceiptFingerprints: [SHA("d"), SHA("e")],
      commitReadbackFingerprint: SHA("f"),
    },
  });
  return advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T15:04:00.000Z",
    proof: {
      stage: "private_github_publication",
      trustedBindingFingerprint: SHA("1"),
      owner: "acme",
      repository: "project-results",
      verifiedPrivate: true,
      branch: "codex/project-results",
      pullRequestNumber: 7,
      draft: true,
      remoteSha: commitSha,
      repositoryReadbackFingerprint: SHA("2"),
      pullRequestReadbackFingerprint: SHA("3"),
    },
  });
}

function workUnitLineage(): ProjectLineageV1 {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-results-work-unit-1",
    originRunId: RUN_ID,
    vaultBindingKey: "vault-results-work-unit-1",
    notePath: "Research/Accepted Work Unit.md",
    noteSha256: SHA("4"),
    noteReceiptId: "note-results-work-unit-receipt-1",
    evidence: [{
      id: "evidence-results-work-unit-1",
      kind: "web",
      reference: "https://example.com/results-work-unit",
      contentSha256: SHA("5"),
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The exact child outcome is backed by acceptance and publication receipts.",
    }],
    riskClass: "medium",
    acceptedAt: "2026-08-19T15:00:00.000Z",
    acceptedBy: "host",
  });
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: RUN_ID,
    taskId: "results-work-unit-task-1",
    evidenceIds: ["evidence-results-work-unit-1"],
    summary: "Accepted research for exact Results work-unit outcomes.",
    unresolvedQuestions: [],
    acceptedAt: "2026-08-19T15:00:00.000Z",
  });
  const lineage = createProjectLineageV1({
    lineageId: "lineage-project-results-work-unit-1",
    runId: RUN_ID,
    vaultBindingKey: "vault-results-work-unit-1",
    handoff,
    updatedAt: "2026-08-19T15:00:00.000Z",
  });
  return advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T15:01:00.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("6"),
      workspaceId: "linear-workspace-work-unit-1",
      teamId: "linear-team-work-unit-1",
      initiativeId: "linear-initiative-work-unit-1",
      projectId: "linear-project-work-unit-1",
      issueIds: ["linear-issue-work-unit-1"],
      workItemFingerprints: [SHA("7")],
      providerReadbackFingerprints: [SHA("8"), SHA("9"), SHA("a")],
      workUnits: [{
        workUnitId: "issue-a",
        linearIssueId: "linear-issue-work-unit-1",
        linearIssueIdentifier: "ENG-42",
        linearIssueUrl: "https://linear.app/acme/issue/ENG-42/results-work-unit",
        acceptanceCriterionIds: ["issue-a:AC-1"],
        providerReadbackFingerprint: SHA("a"),
      }],
    },
  });
}

function workUnitEvent(
  evidenceKind: "acceptance_criterion" | "github_repository_readback" | "github_draft_pr_readback",
  phase: "test" | "github",
  minute: number,
  acceptanceCriterionIds: string[] = [],
  bound = true,
): ProjectStageEventV1 {
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: RUN_ID,
    phase,
    evidenceKind,
    disposition: "verified",
    occurredAt: `2026-08-19T15:${String(minute + 10).padStart(2, "0")}:00.000Z`,
    sourceReceiptId: `receipt-results-${evidenceKind}-${minute}`,
    evidenceFingerprint: SHA(String((minute + 3) % 10)),
    resource: {
      system: phase === "github" ? "github" : "git",
      resourceType: evidenceKind,
      id: `results-${evidenceKind}-${minute}`,
      url: phase === "github" ? "https://github.com/acme/results/pull/42" : null,
      path: null,
      revision: null,
    },
    workUnits: bound
      ? [{ workUnitId: "issue-a", acceptanceCriterionIds }]
      : [],
  });
}
