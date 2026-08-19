import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceProjectLineageV1,
  createProjectLineageV1,
  createResearchProjectPlanV1,
  createResearcherHandoffV1,
} from "../src/agent/projectLifecycle";
import {
  assertProjectWorkUnitExecutionBindingCurrentV1,
  createProjectWorkUnitAcceptanceEventV1,
  createProjectWorkUnitCommitEventV1,
  createProjectWorkUnitDraftPullRequestEventV1,
  createProjectWorkUnitEventScopeV1,
  createProjectWorkUnitExecutionBindingV1,
  createProjectWorkUnitImplementationEventV1,
  createProjectWorkUnitValidationEventV1,
  deriveProjectWorkItemSpecV2FromHierarchyChildV1,
  fingerprintProjectWorkUnitExecutionBindingV1,
  parseProjectWorkUnitExecutionBindingV1,
} from "../src/agent/projectWorkUnitExecution";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";

const AT = "2026-08-19T15:00:00.000Z";
const HASH = (character: string) => `sha256:${character.repeat(64)}`;
const COMMIT_SHA = "a".repeat(40);
const REPOSITORY_PROFILE_KEY = "trusted-project-repository";
const REPOSITORY_PROFILE_FINGERPRINT = HASH("a");
const VALIDATION_KEYS = ["focused-project-validation", "full-project-validation"];

test("one hierarchy child becomes a separate signed WorkItemSpecV2 execution binding", () => {
  const fixture = projectFixture();
  const binding = bindingFor(fixture, "issue-a");
  const independentlyDerived = deriveProjectWorkItemSpecV2FromHierarchyChildV1({
    projectLineage: fixture.lineage,
    researchProjectPlan: fixture.plan,
    workUnitId: "issue-a",
    repositoryProfileKey: REPOSITORY_PROFILE_KEY,
    repositoryProfileFingerprint: REPOSITORY_PROFILE_FINGERPRINT,
    validationRequirementKeys: VALIDATION_KEYS,
  });

  assert.equal(binding.projectRunId, fixture.plan.runId);
  assert.equal(binding.projectLineageFingerprint, fixture.lineage.fingerprint);
  assert.equal(binding.workUnitId, "issue-a");
  assert.equal(binding.linearIssueId, "linear-issue-a");
  assert.equal(binding.linearIssueIdentifier, "ENG-41");
  assert.equal(
    binding.providerReadbackFingerprint,
    fixture.issueAReadbackFingerprint,
  );
  assert.deepEqual(binding.acceptanceCriterionIds, [
    "issue-a:AC-1",
    "issue-a:AC-2",
  ]);
  assert.deepEqual(binding.workItemSpec.acceptanceCriteria, [
    { id: "AC-1", text: "The focused behavior is independently verified." },
    { id: "AC-2", text: "The regression behavior remains stable." },
  ]);
  assert.deepEqual(
    binding.workItemSpec.validationRequirementKeys,
    VALIDATION_KEYS,
  );
  assert.equal(binding.workItemSpec.repositoryKey, REPOSITORY_PROFILE_KEY);
  assert.equal(
    binding.workItemSpec.acceptedResearchArtifactFingerprint,
    fixture.plan.acceptedResearchArtifactFingerprint,
  );
  assert.equal(binding.workItemSpecFingerprint, binding.workItemSpec.fingerprint);
  assert.notEqual(
    binding.workItemSpecFingerprint,
    binding.hierarchyWorkItemFingerprint,
  );
  assert.equal(independentlyDerived.fingerprint, binding.workItemSpecFingerprint);
  assert.equal(
    fingerprintProjectWorkUnitExecutionBindingV1(binding),
    binding.fingerprint,
  );
  assert.deepEqual(parseProjectWorkUnitExecutionBindingV1(binding), binding);
});

test("binding revalidation accepts a later verified lineage prefix and rejects durable drift", () => {
  const fixture = projectFixture();
  const binding = bindingFor(fixture, "issue-a");
  const laterLineage = advanceProjectLineageV1({
    lineage: fixture.lineage,
    committedAt: "2026-08-19T15:01:00.000Z",
    proof: {
      stage: "code_execution",
      repositoryProfileKey: REPOSITORY_PROFILE_KEY,
      repositoryProfileFingerprint: REPOSITORY_PROFILE_FINGERPRINT,
      workspaceId: "workspace-code-a",
      validationReceiptFingerprints: [HASH("b"), HASH("c")],
      diffFingerprint: HASH("d"),
      targetedValidationPassed: true,
      freshFullValidationPassed: true,
      commitSha: COMMIT_SHA,
      commitReadbackFingerprint: HASH("e"),
    },
  });

  assert.equal(
    assertProjectWorkUnitExecutionBindingCurrentV1({
      binding,
      projectLineage: laterLineage,
      researchProjectPlan: fixture.plan,
      repositoryProfileKey: REPOSITORY_PROFILE_KEY,
      repositoryProfileFingerprint: REPOSITORY_PROFILE_FINGERPRINT,
      validationRequirementKeys: VALIDATION_KEYS,
    }).fingerprint,
    binding.fingerprint,
  );

  assert.throws(
    () =>
      assertProjectWorkUnitExecutionBindingCurrentV1({
        binding,
        projectLineage: laterLineage,
        researchProjectPlan: fixture.plan,
        repositoryProfileKey: REPOSITORY_PROFILE_KEY,
        repositoryProfileFingerprint: HASH("f"),
        validationRequirementKeys: VALIDATION_KEYS,
      }),
    /no longer matches current lineage.*repository profile/iu,
  );
  assert.throws(
    () =>
      assertProjectWorkUnitExecutionBindingCurrentV1({
        binding,
        projectLineage: laterLineage,
        researchProjectPlan: fixture.plan,
        repositoryProfileKey: REPOSITORY_PROFILE_KEY,
        repositoryProfileFingerprint: REPOSITORY_PROFILE_FINGERPRINT,
        validationRequirementKeys: ["different-validator"],
      }),
    /no longer matches current lineage.*validation policy/iu,
  );
});

test("binding parsing and hierarchy resolution fail closed on tamper or child drift", () => {
  const fixture = projectFixture();
  const binding = bindingFor(fixture, "issue-a");

  assert.throws(
    () =>
      parseProjectWorkUnitExecutionBindingV1({
        ...binding,
        unexpectedAuthority: "model-value",
      }),
    /unknown: unexpectedAuthority/iu,
  );
  assert.throws(
    () =>
      parseProjectWorkUnitExecutionBindingV1({
        ...binding,
        linearIssueId: "different-linear-issue",
      }),
    /fingerprint does not match/iu,
  );
  assert.throws(
    () =>
      parseProjectWorkUnitExecutionBindingV1({
        ...binding,
        linearIssueUrl: binding.linearIssueUrl.replace("https:", "http:"),
      }),
    /Linear HTTPS host/iu,
  );
  assert.throws(
    () =>
      parseProjectWorkUnitExecutionBindingV1({
        ...binding,
        hierarchyWorkItemFingerprint: binding.workItemSpecFingerprint,
      }),
    /must never be reused/iu,
  );
  assert.throws(
    () =>
      parseProjectWorkUnitExecutionBindingV1({
        ...binding,
        workItemSpec: {
          ...binding.workItemSpec,
          objective: "A changed executable objective.",
        },
      }),
    /work item v2 fingerprint does not match/iu,
  );

  const reorderedCriteria = projectFixture({
    issueAAcceptanceCriterionIds: ["issue-a:AC-2", "issue-a:AC-1"],
  });
  assert.throws(
    () => bindingFor(reorderedCriteria, "issue-a"),
    /acceptance criterion ids do not exactly match/iu,
  );

  const changedHierarchyFingerprint = projectFixture({
    issueAProofWorkItemFingerprint: HASH("f"),
  });
  assert.throws(
    () => bindingFor(changedHierarchyFingerprint, "issue-a"),
    /hierarchy fingerprint.*drifted/iu,
  );
});

test("stage helpers emit implementation, validation, commit, acceptance, and PR evidence for only one child", () => {
  const fixture = projectFixture();
  const bindingA = bindingFor(fixture, "issue-a");
  const scopeA = createProjectWorkUnitEventScopeV1(bindingA);
  const common = {
    binding: bindingA,
    scope: scopeA,
    occurredAt: "2026-08-19T15:02:00.000Z",
    evidenceFingerprint: HASH("b"),
  };
  const events = [
    createProjectWorkUnitImplementationEventV1({
      ...common,
      sourceReceiptId: "receipt-implementation-a",
      workspaceId: "workspace-code-a",
      path: "src/feature.ts",
      observedRevision: HASH("c"),
    }),
    createProjectWorkUnitValidationEventV1({
      ...common,
      sourceReceiptId: "receipt-targeted-a",
      validationRequirementKey: VALIDATION_KEYS[0],
      validationScope: "targeted",
      workspaceId: "workspace-code-a",
      observedRevision: HASH("d"),
    }),
    createProjectWorkUnitValidationEventV1({
      ...common,
      sourceReceiptId: "receipt-full-a",
      validationRequirementKey: VALIDATION_KEYS[1],
      validationScope: "full",
      workspaceId: "workspace-code-a",
      observedRevision: HASH("e"),
    }),
    createProjectWorkUnitCommitEventV1({
      ...common,
      sourceReceiptId: "receipt-commit-a",
      commitSha: COMMIT_SHA,
    }),
    createProjectWorkUnitAcceptanceEventV1({
      ...common,
      sourceReceiptId: "receipt-acceptance-a",
      validationRequirementKey: VALIDATION_KEYS[0],
      acceptanceCriterionId: "issue-a:AC-1",
      acceptanceCriterionText:
        "The focused behavior is independently verified.",
      commitSha: COMMIT_SHA,
    }),
    createProjectWorkUnitDraftPullRequestEventV1({
      ...common,
      sourceReceiptId: "receipt-pr-a",
      owner: "acme",
      repository: "project-repository",
      pullRequestNumber: 17,
      draft: true,
      verifiedCommitSha: COMMIT_SHA,
      remoteSha: COMMIT_SHA,
    }),
  ];

  assert.deepEqual(
    events.map((event) => event.evidenceKind),
    [
      "workspace_mutation",
      "targeted_validation",
      "full_validation",
      "commit_readback",
      "acceptance_criterion",
      "github_draft_pr_readback",
    ],
  );
  assert.ok(events.every((event) => event.runId === bindingA.projectRunId));
  assert.ok(
    events.every(
      (event) =>
        event.workUnits.length === 1 &&
        event.workUnits[0]?.workUnitId === "issue-a",
    ),
  );
  assert.deepEqual(events[4]?.workUnits[0]?.acceptanceCriterionIds, [
    "issue-a:AC-1",
  ]);
  assert.ok(
    events
      .filter((event) => event.evidenceKind !== "acceptance_criterion")
      .every(
        (event) => event.workUnits[0]?.acceptanceCriterionIds.length === 0,
      ),
  );
  assert.equal(
    events[5]?.resource.url,
    "https://github.com/acme/project-repository/pull/17",
  );

  const bindingB = bindingFor(fixture, "issue-b");
  const eventB = createProjectWorkUnitCommitEventV1({
    binding: bindingB,
    scope: createProjectWorkUnitEventScopeV1(bindingB),
    occurredAt: "2026-08-19T15:03:00.000Z",
    sourceReceiptId: "receipt-commit-b",
    evidenceFingerprint: HASH("f"),
    commitSha: COMMIT_SHA,
  });
  assert.deepEqual(eventB.workUnits, [
    { workUnitId: "issue-b", acceptanceCriterionIds: [] },
  ]);
});

test("stage helpers reject sibling scope, unknown validators, criterion text drift, and unverified remote SHA", () => {
  const fixture = projectFixture();
  const binding = bindingFor(fixture, "issue-a");
  const scope = createProjectWorkUnitEventScopeV1(binding);
  const common = {
    binding,
    scope,
    occurredAt: "2026-08-19T15:04:00.000Z",
    sourceReceiptId: "receipt-invalid",
    evidenceFingerprint: HASH("b"),
  };

  assert.throws(
    () =>
      createProjectWorkUnitCommitEventV1({
        ...common,
        scope: { ...scope, workUnitId: "issue-b" },
        commitSha: COMMIT_SHA,
      }),
    /event scope values must already be in canonical form/iu,
  );
  assert.throws(
    () =>
      createProjectWorkUnitValidationEventV1({
        ...common,
        validationRequirementKey: "untrusted-validation",
        validationScope: "targeted",
        workspaceId: "workspace-code-a",
        observedRevision: HASH("c"),
      }),
    /does not use a key approved/iu,
  );
  assert.throws(
    () =>
      createProjectWorkUnitAcceptanceEventV1({
        ...common,
        validationRequirementKey: VALIDATION_KEYS[0],
        acceptanceCriterionId: "issue-b:AC-1",
        acceptanceCriterionText:
          "The focused behavior is independently verified.",
        commitSha: COMMIT_SHA,
      }),
    /outside this work unit/iu,
  );
  assert.throws(
    () =>
      createProjectWorkUnitAcceptanceEventV1({
        ...common,
        validationRequirementKey: VALIDATION_KEYS[0],
        acceptanceCriterionId: "issue-a:AC-1",
        acceptanceCriterionText: "Changed acceptance text.",
        commitSha: COMMIT_SHA,
      }),
    /text does not exactly match/iu,
  );
  assert.throws(
    () =>
      createProjectWorkUnitDraftPullRequestEventV1({
        ...common,
        owner: "acme",
        repository: "project-repository",
        pullRequestNumber: 17,
        draft: true,
        verifiedCommitSha: COMMIT_SHA,
        remoteSha: "b".repeat(40),
      }),
    /remote SHA must equal/iu,
  );
});

interface ProjectFixtureOptions {
  issueAAcceptanceCriterionIds?: string[];
  issueAProofWorkItemFingerprint?: string;
}

function projectFixture(options: ProjectFixtureOptions = {}) {
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-project-research",
    originRunId: "run-project-work-units",
    vaultBindingKey: "current-vault",
    notePath: "Research/Accepted project.md",
    noteSha256: HASH("1"),
    noteReceiptId: "research-note-receipt",
    evidence: [
      {
        id: "evidence-source",
        kind: "web",
        reference: "https://example.com/research",
        contentSha256: HASH("2"),
      },
    ],
    acceptanceCriteria: [
      { id: "AC-1", text: "The project is decomposed into verified work." },
    ],
    riskClass: "medium",
    acceptedAt: AT,
    acceptedBy: "host",
  });
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: artifact.originRunId,
    taskId: "research-task-work-units",
    evidenceIds: ["evidence-source"],
    summary: "Accepted research is ready for exact project decomposition.",
    unresolvedQuestions: [],
    acceptedAt: AT,
  });
  const plan = createResearchProjectPlanV1({
    planId: "research-plan-work-units",
    runId: artifact.originRunId,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    sourceNotePath: artifact.notePath,
    destination: { workspaceId: "linear-workspace", teamId: "linear-team" },
    initiative: {
      key: "initiative-project-delivery",
      title: "Project delivery",
      description: "Deliver the accepted technical direction safely.",
    },
    project: {
      key: "project-exact-work-units",
      title: "Exact work units",
      description: "Implement and verify each provider-bound child independently.",
    },
    issues: [
      {
        key: "issue-a",
        title: "Implement focused behavior",
        description: "Implement the accepted focused behavior and verify it.",
        dependencyKeys: [],
        acceptanceCriteria: [
          "The focused behavior is independently verified.",
          "The regression behavior remains stable.",
        ],
        workItemFingerprint: HASH("c"),
      },
      {
        key: "issue-b",
        title: "Integrate verified behavior",
        description: "Integrate the verified behavior into the project boundary.",
        dependencyKeys: ["issue-a"],
        acceptanceCriteria: ["The integration readback is independently verified."],
        workItemFingerprint: HASH("d"),
      },
    ],
    createdAt: AT,
  });
  let lineage = createProjectLineageV1({
    lineageId: "project-lineage-work-units",
    runId: artifact.originRunId,
    vaultBindingKey: artifact.vaultBindingKey,
    handoff,
    updatedAt: AT,
  });
  const issueAReadbackFingerprint = HASH("5");
  const issueBReadbackFingerprint = HASH("6");
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-08-19T15:00:30.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: plan.fingerprint,
      workspaceId: plan.destination.workspaceId,
      teamId: plan.destination.teamId,
      initiativeId: "linear-initiative",
      projectId: "linear-project",
      issueIds: ["linear-issue-a", "linear-issue-b"],
      workItemFingerprints: [
        options.issueAProofWorkItemFingerprint ??
          plan.issues[0].workItemFingerprint,
        plan.issues[1].workItemFingerprint,
      ],
      providerReadbackFingerprints: [
        HASH("3"),
        HASH("4"),
        issueAReadbackFingerprint,
        issueBReadbackFingerprint,
      ],
      workUnits: [
        {
          workUnitId: "issue-a",
          linearIssueId: "linear-issue-a",
          linearIssueIdentifier: "ENG-41",
          linearIssueUrl:
            "https://linear.app/acme/issue/ENG-41/implement-focused-behavior",
          acceptanceCriterionIds:
            options.issueAAcceptanceCriterionIds ?? [
              "issue-a:AC-1",
              "issue-a:AC-2",
            ],
          providerReadbackFingerprint: issueAReadbackFingerprint,
        },
        {
          workUnitId: "issue-b",
          linearIssueId: "linear-issue-b",
          linearIssueIdentifier: "ENG-42",
          linearIssueUrl:
            "https://linear.app/acme/issue/ENG-42/integrate-verified-behavior",
          acceptanceCriterionIds: ["issue-b:AC-1"],
          providerReadbackFingerprint: issueBReadbackFingerprint,
        },
      ],
    },
  });
  return { plan, lineage, issueAReadbackFingerprint };
}

function bindingFor(
  fixture: ReturnType<typeof projectFixture>,
  workUnitId: string,
) {
  return createProjectWorkUnitExecutionBindingV1({
    projectLineage: fixture.lineage,
    researchProjectPlan: fixture.plan,
    workUnitId,
    repositoryProfileKey: REPOSITORY_PROFILE_KEY,
    repositoryProfileFingerprint: REPOSITORY_PROFILE_FINGERPRINT,
    validationRequirementKeys: VALIDATION_KEYS,
  });
}
