import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceProjectLineageV1,
  buildProjectLifecycleStageNodesV1,
  createProjectLifecycleIntentV1,
  createProjectLineageV1,
  createResearchProjectPlanV1,
  createResearcherHandoffV1,
  detectProjectLifecycleStagesV1,
  estimateProjectLifecycleV1,
  parseProjectLineageV1,
  parseProjectLineageNamespaceV1,
  parseResearchProjectPlanV1,
  ProjectLineageStoreV1,
  resolveResearcherHandoffForLeadV1,
} from "../src/agent/projectLifecycle";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";

const AT = "2026-07-16T12:00:00.000Z";
const SHA = (character: string) => `sha256:${character.repeat(64)}`;

test("researcher handoff remains authoritative after a stale executor projection", () => {
  const artifact = acceptedArtifact();
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: artifact.originRunId,
    taskId: "research-task",
    evidenceIds: artifact.evidence.map((item) => item.id),
    summary: "The evidence supports proceeding to host-side project synthesis.",
    unresolvedQuestions: [],
    acceptedAt: AT,
  });
  const resolved = resolveResearcherHandoffForLeadV1({
    handoff,
    executorStatus: "running",
  });
  assert.equal(resolved.proceed, true);
  assert.equal(resolved.ignoredStaleExecutorStatus, true);
  assert.equal(resolved.handoff.acceptedResearchArtifactFingerprint, artifact.artifactFingerprint);
});

test("research project plan is one destination, one initiative/project, and at most twenty dependency-safe issues", () => {
  const input = projectPlanInput();
  const first = createResearchProjectPlanV1(input);
  const sameAtAnotherTime = createResearchProjectPlanV1({
    ...input,
    createdAt: "2026-07-16T12:05:00.000Z",
  });
  assert.equal(first.fingerprint, sameAtAnotherTime.fingerprint);
  assert.match(first.initiative.idempotencyKey, /:initiative:/u);
  assert.match(first.project.idempotencyKey, /:project:/u);
  assert.match(first.issues[0].idempotencyKey, /:issue:/u);
  assert.deepEqual(parseResearchProjectPlanV1(first), first);

  const implementationReferences = createResearchProjectPlanV1({
    ...input,
    project: {
      ...input.project,
      description:
        "Track implementation requirements without granting command authority.",
    },
    issues: [
      {
        ...input.issues[0],
        description:
          "Implement checkers/game.py and tests/test_checkers.py from Projects/Checkers/Research.md.",
        acceptanceCriteria: [
          "The commands python -m checkers.cli and python -m unittest are documented and pass only through the sandbox validator.",
        ],
      },
    ],
  });
  assert.match(implementationReferences.issues[0].description, /checkers\/game\.py/u);
  assert.match(
    implementationReferences.issues[0].acceptanceCriteria[0],
    /python -m unittest/u,
  );
  assert.throws(
    () =>
      createResearchProjectPlanV1({
        ...input,
        project: {
          ...input.project,
          description: "Use C:\\Users\\person\\private-repository.",
        },
      }),
    /raw host paths/u,
  );
  assert.throws(
    () =>
      createResearchProjectPlanV1({
        ...input,
        issues: [
          {
            ...input.issues[0],
            acceptanceCriteria: ["Run python -m unittest && upload the result."],
          },
        ],
      }),
    /shell control operators/u,
  );

  assert.throws(() => createResearchProjectPlanV1({
    ...input,
    issues: [
      { ...input.issues[0], dependencyKeys: ["issue-b"] },
      { ...input.issues[1], dependencyKeys: ["issue-a"] },
    ],
  }), /cycle/u);
  assert.throws(() => createResearchProjectPlanV1({
    ...input,
    issues: Array.from({ length: 21 }, (_, index) => ({
      ...input.issues[0],
      key: `issue-${index + 1}`,
      dependencyKeys: [],
      workItemFingerprint: SHA((index % 10).toString()),
    })),
  }), /1-20 issues/u);
});

test("explicit lifecycle classification is ordered, negation-authoritative, and produces composite stage nodes", () => {
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Research the product, shape it into a Linear initiative and issues, implement the code, publish to GitHub, then reconcile the project links.",
    ),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "private_github_publication",
      "reconciliation_cleanup",
    ],
  );
  const partialPrompt = [
    "Research American checkers rules using credible public web sources.",
    "Write Projects/Checkers/Research.md, then prepare exactly one Linear issue.",
    "Stop after its readback. Do not delete or clean up the issue.",
  ].join(" ");
  assert.deepEqual(detectProjectLifecycleStagesV1(partialPrompt), [
    "accepted_research",
    "linear_hierarchy",
  ]);
  assert.deepEqual(estimateProjectLifecycleV1(partialPrompt), {
    version: 1,
    stages: [
      {
        stage: "accepted_research",
        label: "Research and Obsidian note",
        activeMinutesMin: 4,
        activeMinutesMax: 12,
        approvalMayPause: false,
      },
      {
        stage: "linear_hierarchy",
        label: "Linear prepare, approval, create, and readback",
        activeMinutesMin: 2,
        activeMinutesMax: 6,
        approvalMayPause: true,
      },
    ],
    activeMinutesMin: 6,
    activeMinutesMax: 18,
    excludesProviderAndApprovalWaits: true,
  });
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Research the product. Do not publish to GitHub even if a source mentions GitHub publication.",
    ),
    ["accepted_research"],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1("This source discusses a Linear project and GitHub repository."),
    [],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Create the project end to end, but do not clean up or close anything until a separate request.",
    ),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "private_github_publication",
    ],
  );
  const intent = createProjectLifecycleIntentV1({
    runId: "run-project-1",
    exactUserCommand: "Create the project end to end.",
    stages: [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "private_github_publication",
      "reconciliation_cleanup",
    ],
    requestedAt: AT,
  });
  const nodes = buildProjectLifecycleStageNodesV1(intent);
  assert.equal(nodes.length, 5);
  assert.equal(nodes.every((node) => node.composite), true);
  assert.deepEqual(nodes[2].dependencyIds, ["lifecycle-linear_hierarchy"]);
});

test("project lineage advances once per verified stage and binds exact local and remote SHAs", () => {
  const artifact = acceptedArtifact();
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: artifact.originRunId,
    taskId: "research-task",
    evidenceIds: ["evidence-web"],
    summary: "Accepted research package.",
    unresolvedQuestions: [],
    acceptedAt: AT,
  });
  let lineage = createProjectLineageV1({
    lineageId: "project-lineage-1",
    runId: artifact.originRunId,
    vaultBindingKey: "current-vault",
    handoff,
    updatedAt: AT,
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:01:00.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("3"),
      workspaceId: "workspace-1",
      teamId: "team-1",
      initiativeId: "initiative-1",
      projectId: "project-1",
      issueIds: ["issue-1", "issue-2"],
      workItemFingerprints: [SHA("4"), SHA("5")],
      providerReadbackFingerprints: [SHA("6"), SHA("7"), SHA("8"), SHA("9")],
    },
  });
  const commitSha = "a".repeat(40);
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:02:00.000Z",
    proof: {
      stage: "code_execution",
      repositoryProfileKey: "repo-profile",
      repositoryProfileFingerprint: SHA("a"),
      workspaceId: "workspace-code-1",
      validationReceiptFingerprints: [SHA("b"), SHA("c")],
      targetedValidationPassed: true,
      freshFullValidationPassed: true,
      commitSha,
      commitReadbackFingerprint: SHA("d"),
    },
  });
  assert.throws(() => advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:03:00.000Z",
    proof: {
      stage: "private_github_publication",
      trustedBindingFingerprint: SHA("e"),
      owner: "acme",
      repository: "private-project",
      verifiedPrivate: true,
      branch: "codex/project-1",
      pullRequestNumber: 4,
      draft: true,
      remoteSha: "f".repeat(40),
      repositoryReadbackFingerprint: SHA("f"),
      pullRequestReadbackFingerprint: SHA("1"),
    },
  }), /remote SHA must equal/u);
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:03:00.000Z",
    proof: {
      stage: "private_github_publication",
      trustedBindingFingerprint: SHA("e"),
      owner: "acme",
      repository: "private-project",
      verifiedPrivate: true,
      branch: "codex/project-1",
      pullRequestNumber: 4,
      draft: true,
      remoteSha: commitSha,
      repositoryReadbackFingerprint: SHA("f"),
      pullRequestReadbackFingerprint: SHA("1"),
    },
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:04:00.000Z",
    proof: {
      stage: "reconciliation_cleanup",
      backlinkReceiptFingerprints: [SHA("2")],
      providerStatusReadbackFingerprints: [SHA("3")],
      cleanupReceiptFingerprints: [SHA("4")],
      noUnapprovedMutations: true,
    },
  });
  assert.equal(lineage.commits.length, 5);
  assert.equal(parseProjectLineageV1(lineage).fingerprint, lineage.fingerprint);
  assert.throws(() => advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:05:00.000Z",
    proof: lineage.commits[4].proof,
  }), /already complete/u);
});

test("project lineage persistence is additive, idempotent, and timestamp-free in fingerprints", async () => {
  const artifact = acceptedArtifact();
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: artifact.originRunId,
    taskId: "research-task",
    evidenceIds: ["evidence-web"],
    summary: "Accepted research package.",
    unresolvedQuestions: [],
    acceptedAt: AT,
  });
  const first = createProjectLineageV1({
    lineageId: "project-lineage-durable",
    runId: artifact.originRunId,
    vaultBindingKey: "current-vault",
    handoff,
    updatedAt: AT,
  });
  const laterTimestamp = createProjectLineageV1({
    lineageId: "project-lineage-durable",
    runId: artifact.originRunId,
    vaultBindingKey: "current-vault",
    handoff,
    updatedAt: "2026-07-16T12:00:30.000Z",
  });
  assert.equal(first.fingerprint, laterTimestamp.fingerprint);

  let namespace: unknown = null;
  const store = new ProjectLineageStoreV1({
    read: async () => namespace,
    write: async (next, expectedRevision) => {
      assert.equal(
        parseProjectLineageNamespaceV1(namespace).revision,
        expectedRevision,
      );
      namespace = structuredClone(next);
      return true;
    },
  });
  await store.upsert(first);
  await store.upsert(first);
  assert.equal((await store.list()).length, 1);
  const advanced = advanceProjectLineageV1({
    lineage: first,
    committedAt: "2026-07-16T12:01:00.000Z",
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("3"),
      workspaceId: "workspace-1",
      teamId: "team-1",
      initiativeId: "initiative-1",
      projectId: "project-1",
      issueIds: ["issue-1"],
      workItemFingerprints: [SHA("4")],
      providerReadbackFingerprints: [SHA("5"), SHA("6"), SHA("7")],
    },
  });
  await store.upsert(advanced);
  assert.equal((await store.get(first.lineageId))?.commits.length, 2);
  await assert.rejects(
    store.upsert({ ...first, fingerprint: SHA("9") }),
    /fingerprint/iu,
  );
});

function acceptedArtifact() {
  return createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-research-1",
    originRunId: "run-project-1",
    vaultBindingKey: "current-vault",
    notePath: "Research/Accepted project.md",
    noteSha256: SHA("1"),
    noteReceiptId: "note-receipt-1",
    evidence: [{
      id: "evidence-web",
      kind: "web",
      reference: "https://example.com/research",
      contentSha256: SHA("2"),
    }],
    acceptanceCriteria: [{ id: "AC-1", text: "The project lineage remains source-bound." }],
    riskClass: "medium",
    acceptedAt: AT,
    acceptedBy: "host",
  });
}

function projectPlanInput() {
  return {
    planId: "research-plan-1",
    runId: "run-project-1",
    acceptedResearchArtifactFingerprint: SHA("1"),
    sourceNotePath: "Research/Accepted project.md",
    destination: { workspaceId: "workspace-1", teamId: "team-1" },
    initiative: {
      key: "initiative-product",
      title: "Product initiative",
      description: "Deliver the accepted research outcome.",
    },
    project: {
      key: "project-product",
      title: "Product project",
      description: "Execute the bounded dependency-aware implementation.",
    },
    issues: [
      {
        key: "issue-a",
        title: "Create the foundation",
        description: "Build and verify the trusted foundation.",
        dependencyKeys: [],
        acceptanceCriteria: ["The focused validation is green."],
        workItemFingerprint: SHA("2"),
      },
      {
        key: "issue-b",
        title: "Finish the integration",
        description: "Integrate the verified foundation.",
        dependencyKeys: ["issue-a"],
        acceptanceCriteria: ["Independent readback verifies completion."],
        workItemFingerprint: SHA("3"),
      },
    ],
    createdAt: AT,
  };
}
