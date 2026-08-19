import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceProjectLineageV1,
  buildProjectLifecycleStageNodesV1,
  createProjectLifecycleIntentV1,
  createProjectLifecycleIntentV2,
  createProjectLineageV1,
  createResearchProjectPlanV1,
  createResearcherHandoffV1,
  detectProjectLifecycleStagesV1,
  detectProjectLifecycleStagesV2,
  estimateProjectLifecycleV1,
  getProjectLineageFingerprintHistoryV1,
  parseProjectLineageV1,
  parseProjectLifecycleIntentV2,
  parseProjectLineageNamespaceV1,
  parseResearchProjectPlanV1,
  ProjectLineageStoreV1,
  migratePrivateGitHubPublicationLineageProofV1ToV2,
  migrateProjectLifecycleIntentV1ToV2,
  parseGitHubPublicationLineageProofV2,
  projectGitHubPublicationLineageProofV2ToCompatibleV1,
  projectGitHubPublicationLineageProofV2ToV1,
  projectProjectLifecycleIntentV2ToV1,
  resolveResearcherHandoffForLeadV1,
} from "../src/agent/projectLifecycle";
import {
  bindAggregateProjectEventsToOnlyWorkUnitV1,
  mergeProjectStageEventsPreferExactWorkUnitScopeV1,
  projectLinearBindingsFromProjectLineageV1,
  projectStageEventsFromProjectLineageV1,
} from "../src/agent/projectStageLineageMapper";
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

test("note reflection of a Linear ticket URL is not code_execution", () => {
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      [
        "On the current Obsidian note, complete this Linear writeback mission.",
        "Create exactly one Linear issue on team TEAM.",
        "The append_to_current_file call is mandatory: write a markdown section that includes the exact Linear issue URL from linear_get_issue.",
      ].join(" "),
    ),
    ["linear_hierarchy"],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "After linear_get_issue, call append_to_current_file once and put the returned ticket URL into the note.",
    ),
    [],
  );
});

test("BYOK handoff phases classify existing proof as input instead of new work", () => {
  const phaseA = [
    "Deeply research a small dependency-free Python CRDT library for marker BYOK_AUTONOMOUS_unit.",
    "Use and fetch at least four independent sources exposed through the configured research backend. Reconcile their guidance on state-based G-Counter joins and observed-remove sets, including convergence, idempotence, concurrent add versus remove, and practical validation.",
    "Write accepted research into the initiating note as a concise but substantive implementation brief, then publish that accepted research to one Linear implementation issue in the configured destination.",
    "The accepted package is executable code work for trusted repository key byok-autonomous-python and validation requirement key byok-autonomous-python-validation.",
    "The issue must carry the source citations and behavioral acceptance contract: a GCounter supports replica-local non-negative increments, value, and convergent pointwise-max merge; an ORSet supports add, observed remove, value, union-style merge, concurrent add survival, and convergence after all tags are observed and removed.",
    "Require the public implementation and README to carry proof marker BYOK_AUTONOMOUS_unit, but leave filenames, internal design, workspace identity, and implementation choices to the coding agent.",
    "Do not implement code or publish to GitHub in this phase. Finish only after accepted-research lineage, Linear provider readback, and the note backlink are durable.",
  ].join(" ");
  assert.deepEqual(detectProjectLifecycleStagesV1(phaseA), [
    "accepted_research",
    "linear_hierarchy",
  ]);

  const phaseB = [
    "Review and implement Linear issue issue-1.",
    "Begin with an independent linear_get_issue read of that exact identity and treat its signed accepted-research contract as the sole product specification.",
    "When the work is complete, write exactly one human reflection to the accepted research's initiating note through its durable lineage.",
    "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
    "Implement the requested Python library in its bound trusted repository and create one verified local commit.",
  ].join(" ");
  assert.deepEqual(detectProjectLifecycleStagesV1(phaseB), [
    "code_execution",
    "private_github_publication",
    "reflection",
  ]);
});

test("research then code prompts detect accepted research and code execution without Linear", () => {
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Research American checkers rules with two web sources, then implement the game in Python.",
    ),
    ["accepted_research", "code_execution"],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Do research on checkers and then write code for a Python checkers game.",
    ),
    ["accepted_research", "code_execution"],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Research this topic online, then build a simple checkers app in Python.",
    ),
    ["accepted_research", "code_execution"],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Research the rules, then code a Python implementation in the workspace.",
    ),
    ["accepted_research", "code_execution"],
  );
});

test("full pipeline and Flow-real compound wording unlock multi-stage set without cleanup", () => {
  const multiStageWithoutCleanup = [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "reflection",
  ] as const;

  assert.deepEqual(
    detectProjectLifecycleStagesV1("Run the full pipeline on this tracking note."),
    [...multiStageWithoutCleanup],
  );
  // Durable Continue command text alone must not look like a compound mission;
  // AgentRunner re-detects from restored originalMission after resume.
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "continue run run-2026-07-21T12-00-00.000Z-abcd",
    ),
    [],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "FLOW_REAL_abc123 mission: create Linear issue, use the repository workspace, publish GitHub, append Flow real reflection.",
    ),
    [...multiStageWithoutCleanup],
  );
  // COMPOUND-REAL-style continuous mission (no literal "end-to-end").
  const compoundRealLike = [
    "Run the full pipeline on this tracking note for marker FLOW_REAL_xyz.",
    "Create one Linear issue for team TEAM titled Flow real FLOW_REAL_xyz, then read it back.",
    "Use the trusted local repository profile: create workspace ws, write code, validate, and commit.",
    "Create the exact private GitHub repository owner/repo.",
    "Append a Flow real reflection section to the current note with the Linear issue URL and GitHub repo URL.",
    "Decide tool order yourself. Do not ask for approval. Do not trash or delete. Do not merge.",
    // Continue-instruction wording must not strip Linear/code/GitHub stages.
    "Do not stop with a chat-only final answer before Linear, code, GitHub, and reflection proofs exist.",
  ].join(" ");
  assert.deepEqual(detectProjectLifecycleStagesV1(compoundRealLike), [
    ...multiStageWithoutCleanup,
  ]);
  // Compound Linear → repository → GitHub → reflection without "full pipeline".
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Create a Linear issue, implement in the repository workspace, publish to GitHub, then append a note reflection.",
    ),
    [...multiStageWithoutCleanup],
  );
  // Negation still filters stages on compound unlock.
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Run the full pipeline, but do not publish to GitHub or open a pull request.",
    ),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "code_validation",
      "reflection",
    ],
  );
  // Cleanup omitted unless explicitly asked on compound unlock.
  assert.deepEqual(
    detectProjectLifecycleStagesV1("Run the full pipeline and then reconcile the project links."),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "code_validation",
      "private_github_publication",
      "reflection",
      "reconciliation_cleanup",
    ],
  );
  assert.ok(
    !detectProjectLifecycleStagesV1("Run the full pipeline.").includes("reconciliation_cleanup"),
  );
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
        label: "Research & design",
        activeMinutesMin: 4,
        activeMinutesMax: 12,
        approvalMayPause: false,
      },
      {
        stage: "linear_hierarchy",
        label: "Linear planning",
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
      "code_validation",
      "private_github_publication",
      "reflection",
    ],
  );
  const intent = createProjectLifecycleIntentV1({
    runId: "run-project-1",
    exactUserCommand: "Create the project end to end.",
    stages: [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "code_validation",
      "private_github_publication",
      "reflection",
      "reconciliation_cleanup",
    ],
    requestedAt: AT,
  });
  const nodes = buildProjectLifecycleStageNodesV1(intent);
  assert.equal(nodes.length, 7);
  assert.equal(nodes.every((node) => node.composite), true);
  assert.deepEqual(nodes[2].dependencyIds, ["lifecycle-linear_hierarchy"]);
  assert.deepEqual(nodes[3].dependencyIds, ["lifecycle-code_execution"]);
  assert.deepEqual(nodes[5].dependencyIds, ["lifecycle-private_github_publication"]);
});

test("validation and reflection are independently routable lifecycle stages", () => {
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Run targeted and full validation for the repository test suite.",
    ),
    ["code_validation"],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(
      "Write a concise results reflection into the project results note.",
    ),
    ["reflection"],
  );

  const validation = createProjectLifecycleIntentV1({
    runId: "run-validation-only",
    exactUserCommand: "Run targeted and full validation for the repository test suite.",
    stages: ["code_validation"],
    requestedAt: AT,
  });
  assert.deepEqual(buildProjectLifecycleStageNodesV1(validation), [
    {
      id: "lifecycle-code_validation",
      stage: "code_validation",
      dependencyIds: [],
      objective:
        "Run targeted and fresh-full validation, repair only from observed failures, then create and read back one verified local commit.",
      composite: true,
    },
  ]);
});

test("a natural developer mission infers all six delivery stages without a checkbox", () => {
  const prompt =
    "Investigate conflict-free counters, turn the findings into Linear work, " +
    "implement it in the repository, test it, and open a draft PR on GitHub.";
  assert.deepEqual(detectProjectLifecycleStagesV1(prompt), [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "reflection",
  ]);
  assert.deepEqual(
    detectProjectLifecycleStagesV1(`${prompt} Do not write a reflection or report.`),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "code_validation",
      "private_github_publication",
    ],
  );
  assert.deepEqual(
    detectProjectLifecycleStagesV1(`${prompt} Do not use Jupyter; use the default Results note.`),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "code_validation",
      "private_github_publication",
      "reflection",
    ],
    "rejecting one destination must not opt out of reflection itself",
  );
});

test("each of the six developer stages remains independently routable", () => {
  const cases: Array<[string, string]> = [
    ["Research this topic online using credible sources.", "accepted_research"],
    ["Turn the accepted brief into a Linear initiative and issues.", "linear_hierarchy"],
    ["Implement the feature in the repository workspace.", "code_execution"],
    ["Run targeted and full validation for the repository test suite.", "code_validation"],
    ["Open a draft pull request on GitHub.", "private_github_publication"],
    ["Write a concise results reflection into the project results note.", "reflection"],
  ];
  for (const [command, stage] of cases) {
    assert.deepEqual(detectProjectLifecycleStagesV1(command), [stage], command);
  }
});

test("V2 lifecycle generalizes GitHub publication while projecting valid V1 private state", () => {
  const legacy = createProjectLifecycleIntentV1({
    runId: "run-project-1",
    exactUserCommand: "Publish the verified code to a private GitHub repository.",
    stages: ["code_execution", "private_github_publication"],
    requestedAt: AT,
  });
  const migrated = migrateProjectLifecycleIntentV1ToV2(legacy);
  assert.deepEqual(migrated.stages, ["code_execution", "github_publication"]);
  assert.deepEqual(parseProjectLifecycleIntentV2(legacy), migrated);
  assert.deepEqual(projectProjectLifecycleIntentV2ToV1(migrated), legacy);
  assert.deepEqual(
    detectProjectLifecycleStagesV2(
      "Implement the code and publish it to GitHub as a public repository.",
    ),
    ["code_execution", "github_publication"],
  );

  const publicIntent = createProjectLifecycleIntentV2({
    runId: "run-project-public",
    exactUserCommand: "Publish the verified code to a public GitHub repository.",
    stages: ["code_execution", "github_publication"],
    requestedAt: AT,
  });
  assert.deepEqual(parseProjectLifecycleIntentV2(publicIntent), publicIntent);

  const legacyProof = {
    stage: "private_github_publication" as const,
    trustedBindingFingerprint: SHA("1"),
    owner: "acme",
    repository: "agent-project",
    verifiedPrivate: true as const,
    branch: "codex/project",
    pullRequestNumber: 12,
    draft: true as const,
    remoteSha: "a".repeat(40),
    repositoryReadbackFingerprint: SHA("2"),
    pullRequestReadbackFingerprint: SHA("3"),
  };
  const migratedProof =
    migratePrivateGitHubPublicationLineageProofV1ToV2(legacyProof);
  assert.equal(migratedProof.stage, "github_publication");
  assert.equal(migratedProof.visibility, "private");
  assert.deepEqual(
    projectGitHubPublicationLineageProofV2ToV1(migratedProof),
    legacyProof,
  );
  assert.throws(
    () => projectGitHubPublicationLineageProofV2ToV1({
      ...migratedProof,
      visibility: "public",
    }),
    /cannot be projected as verified private/iu,
  );
  const publicProof = {
    ...migratedProof,
    visibility: "public" as const,
  };
  const compatiblePublicProof =
    projectGitHubPublicationLineageProofV2ToCompatibleV1(publicProof);
  assert.deepEqual(compatiblePublicProof, {
    stage: "private_github_publication",
    proofVersion: 2,
    trustedBindingFingerprint: SHA("1"),
    owner: "acme",
    repository: "agent-project",
    visibility: "public",
    verifiedVisibility: true,
    branch: "codex/project",
    pullRequestNumber: 12,
    draft: true,
    remoteSha: "a".repeat(40),
    repositoryReadbackFingerprint: SHA("2"),
    pullRequestReadbackFingerprint: SHA("3"),
  });
  assert.deepEqual(
    parseGitHubPublicationLineageProofV2(compatiblePublicProof),
    publicProof,
  );
  assert.throws(
    () => parseGitHubPublicationLineageProofV2({
      ...compatiblePublicProof,
      verifiedVisibility: false,
    }),
    /explicit verified visibility/iu,
  );
  assert.throws(
    () => migratePrivateGitHubPublicationLineageProofV1ToV2(
      compatiblePublicProof,
    ),
    /unversioned private-only contract/iu,
  );
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
      diffFingerprint: SHA("f"),
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

test("new lineage order proves validation and reflection while legacy order remains readable", () => {
  const artifact = acceptedArtifact();
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: artifact.originRunId,
    taskId: "research-task-current",
    evidenceIds: ["evidence-web"],
    summary: "Accepted research package for the current lifecycle.",
    unresolvedQuestions: [],
    acceptedAt: AT,
  });
  let lineage = createProjectLineageV1({
    lineageId: "project-lineage-current",
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
      issueIds: ["issue-1"],
      workItemFingerprints: [SHA("4")],
      providerReadbackFingerprints: [SHA("5"), SHA("6"), SHA("7")],
      workUnits: [{
        workUnitId: "issue-a",
        linearIssueId: "issue-1",
        linearIssueIdentifier: "ENG-42",
        linearIssueUrl: "https://linear.app/acme/issue/ENG-42/project-current",
        acceptanceCriterionIds: ["issue-a:AC-1"],
        providerReadbackFingerprint: SHA("7"),
      }],
    },
  });
  const commitSha = "a".repeat(40);
  const codeProof = {
    stage: "code_execution" as const,
    repositoryProfileKey: "repo-profile",
    repositoryProfileFingerprint: SHA("8"),
    workspaceId: "workspace-code-1",
    validationReceiptFingerprints: [SHA("9"), SHA("a")],
    diffFingerprint: SHA("b"),
    targetedValidationPassed: true as const,
    freshFullValidationPassed: true as const,
    commitSha,
    commitReadbackFingerprint: SHA("c"),
  };
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:02:00.000Z",
    proof: codeProof,
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:03:00.000Z",
    proof: {
      ...codeProof,
      stage: "code_validation",
      validationReceiptFingerprints: [SHA("d"), SHA("e")],
      commitReadbackFingerprint: SHA("f"),
    },
  });
  let publicLineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:04:00.000Z",
    proof: projectGitHubPublicationLineageProofV2ToCompatibleV1({
      stage: "github_publication",
      trustedBindingFingerprint: SHA("1"),
      owner: "acme",
      repository: "public-project",
      visibility: "public",
      verifiedVisibility: true,
      branch: "codex/project-public",
      pullRequestNumber: 8,
      draft: true,
      remoteSha: commitSha,
      repositoryReadbackFingerprint: SHA("2"),
      pullRequestReadbackFingerprint: SHA("3"),
    }),
  });
  publicLineage = advanceProjectLineageV1({
    lineage: publicLineage,
    committedAt: "2026-07-16T12:05:00.000Z",
    proof: {
      stage: "reflection",
      resultsPath: "Agent Work/Results/project-public.md",
      resultsSha256: SHA("4"),
      writeReceiptFingerprint: SHA("5"),
      summaryFingerprint: SHA("6"),
    },
  });
  const publicEvents = projectStageEventsFromProjectLineageV1({
    lineage: publicLineage,
    runId: "root-public-developer-mission",
  });
  assert.deepEqual(
    [...new Set(publicEvents.map((event) => event.phase))],
    ["research", "linear_plan", "implement", "test", "github", "reflect"],
  );
  assert.equal(
    publicEvents.find(
      (event) => event.evidenceKind === "github_draft_pr_readback",
    )?.resource.url,
    "https://github.com/acme/public-project/pull/8",
  );
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:04:00.000Z",
    proof: {
      stage: "private_github_publication",
      trustedBindingFingerprint: SHA("1"),
      owner: "acme",
      repository: "private-project",
      verifiedPrivate: true,
      branch: "codex/project-current",
      pullRequestNumber: 7,
      draft: true,
      remoteSha: commitSha,
      repositoryReadbackFingerprint: SHA("2"),
      pullRequestReadbackFingerprint: SHA("3"),
    },
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:05:00.000Z",
    proof: {
      stage: "reflection",
      resultsPath: "Agent Work/Results/project-current.ipynb",
      resultsSha256: SHA("4"),
      writeReceiptFingerprint: SHA("5"),
      summaryFingerprint: SHA("6"),
    },
  });
  assert.deepEqual(
    parseProjectLineageV1(lineage).commits.map((commit) => commit.stage),
    [
      "accepted_research",
      "linear_hierarchy",
      "code_execution",
      "code_validation",
      "private_github_publication",
      "reflection",
    ],
  );
  const reportEvents = projectStageEventsFromProjectLineageV1({
    lineage,
    runId: "root-developer-mission",
  });
  assert.deepEqual(
    [...new Set(reportEvents.map((event) => event.phase))],
    ["research", "linear_plan", "implement", "test", "github", "reflect"],
  );
  assert.ok(
    reportEvents.every((event) => event.runId === "root-developer-mission"),
  );
  for (const evidenceKind of [
    "diff_readback",
    "targeted_validation",
    "full_validation",
    "commit_readback",
  ] as const) {
    assert.equal(
      reportEvents.filter((event) => event.evidenceKind === evidenceKind).length,
      1,
      `${evidenceKind} must be projected exactly once`,
    );
  }
  assert.equal(
    reportEvents.find((event) => event.evidenceKind === "github_draft_pr_readback")
      ?.resource.url,
    "https://github.com/acme/private-project/pull/7",
  );
  assert.equal(
    reportEvents.find((event) => event.evidenceKind === "reflection_writeback")
      ?.resource.resourceType,
    "jupyter_notebook",
  );
  const linearProof = lineage.commits[1]?.proof;
  assert.equal(
    linearProof?.stage === "linear_hierarchy"
      ? linearProof.workUnits?.[0]?.linearIssueIdentifier
      : null,
    "ENG-42",
  );
  const singleBinding = projectLinearBindingsFromProjectLineageV1({
    lineage,
    runId: "root-developer-mission",
  });
  assert.deepEqual(
    singleBinding.map((binding) => ({
      runId: binding.runId,
      workUnitId: binding.workUnitId,
      identifier: binding.linearIssueIdentifier,
    })),
    [{
      runId: "root-developer-mission",
      workUnitId: "issue-a",
      identifier: "ENG-42",
    }],
  );
  assert.deepEqual(
    reportEvents.find((event) => event.evidenceKind === "acceptance_criterion")
      ?.workUnits,
    [{ workUnitId: "issue-a", acceptanceCriterionIds: ["issue-a:AC-1"] }],
  );
  for (const kind of [
    "workspace_mutation",
    "diff_readback",
    "targeted_validation",
    "full_validation",
    "commit_readback",
    "github_repository_readback",
    "github_draft_pr_readback",
    "reflection_writeback",
  ] as const) {
    assert.deepEqual(
      reportEvents.find((event) => event.evidenceKind === kind)?.workUnits,
      [],
      `${kind} must remain project-level without an exact child receipt`,
    );
  }
  const childAttributed = bindAggregateProjectEventsToOnlyWorkUnitV1({
    events: reportEvents,
    bindings: singleBinding,
  });
  for (const kind of [
    "workspace_mutation",
    "diff_readback",
    "targeted_validation",
    "full_validation",
    "commit_readback",
    "github_repository_readback",
    "github_draft_pr_readback",
    "reflection_writeback",
  ] as const) {
    assert.deepEqual(
      childAttributed.find((event) => event.evidenceKind === kind)?.workUnits,
      [{ workUnitId: "issue-a", acceptanceCriterionIds: [] }],
      `${kind} may be attributed to the only exact Linear child`,
    );
  }
  assert.deepEqual(
    childAttributed.find(
      (event) => event.evidenceKind === "acceptance_criterion",
    )?.workUnits,
    [{ workUnitId: "issue-a", acceptanceCriterionIds: ["issue-a:AC-1"] }],
    "criterion bindings must remain exact",
  );
  const merged = mergeProjectStageEventsPreferExactWorkUnitScopeV1([
    ...reportEvents,
    ...childAttributed,
  ]);
  assert.equal(merged.length, reportEvents.length);
  assert.deepEqual(
    merged.find(
      (event) => event.evidenceKind === "github_draft_pr_readback",
    )?.workUnits,
    [{ workUnitId: "issue-a", acceptanceCriterionIds: [] }],
    "report merging must prefer the exact child projection over its aggregate twin",
  );
});

test("aggregate lineage evidence cannot pay multiple Linear children", () => {
  const artifact = acceptedArtifact();
  const handoff = createResearcherHandoffV1({
    artifact,
    runId: artifact.originRunId,
    taskId: "research-task-multi-child",
    evidenceIds: ["evidence-web"],
    summary: "Accepted research package for two independently payable issues.",
    unresolvedQuestions: [],
    acceptedAt: AT,
  });
  let lineage = createProjectLineageV1({
    lineageId: "project-lineage-multi-child",
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
      planFingerprint: SHA("1"),
      workspaceId: "workspace-1",
      teamId: "team-1",
      initiativeId: "initiative-1",
      projectId: "project-1",
      issueIds: ["issue-1", "issue-2"],
      workItemFingerprints: [SHA("2"), SHA("3")],
      providerReadbackFingerprints: [SHA("4"), SHA("5"), SHA("6"), SHA("7")],
      workUnits: [
        {
          workUnitId: "issue-a",
          linearIssueId: "issue-1",
          linearIssueIdentifier: "ENG-42",
          linearIssueUrl: "https://linear.app/acme/issue/ENG-42/issue-a",
          acceptanceCriterionIds: ["issue-a:AC-1"],
          providerReadbackFingerprint: SHA("6"),
        },
        {
          workUnitId: "issue-b",
          linearIssueId: "issue-2",
          linearIssueIdentifier: "ENG-43",
          linearIssueUrl: "https://linear.app/acme/issue/ENG-43/issue-b",
          acceptanceCriterionIds: ["issue-b:AC-1"],
          providerReadbackFingerprint: SHA("7"),
        },
      ],
    },
  });
  const commitSha = "b".repeat(40);
  const codeProof = {
    stage: "code_execution" as const,
    repositoryProfileKey: "repo-profile",
    repositoryProfileFingerprint: SHA("8"),
    workspaceId: "workspace-code-multi",
    validationReceiptFingerprints: [SHA("9"), SHA("a")],
    diffFingerprint: SHA("b"),
    targetedValidationPassed: true as const,
    freshFullValidationPassed: true as const,
    commitSha,
    commitReadbackFingerprint: SHA("c"),
  };
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:02:00.000Z",
    proof: codeProof,
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:03:00.000Z",
    proof: {
      ...codeProof,
      stage: "code_validation",
      validationReceiptFingerprints: [SHA("d"), SHA("e")],
      commitReadbackFingerprint: SHA("f"),
    },
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: "2026-07-16T12:04:00.000Z",
    proof: {
      stage: "private_github_publication",
      trustedBindingFingerprint: SHA("1"),
      owner: "acme",
      repository: "multi-child",
      verifiedPrivate: true,
      branch: "codex/multi-child",
      pullRequestNumber: 8,
      draft: true,
      remoteSha: commitSha,
      repositoryReadbackFingerprint: SHA("2"),
      pullRequestReadbackFingerprint: SHA("3"),
    },
  });
  const events = projectStageEventsFromProjectLineageV1({ lineage });
  assert.equal(
    events.some((event) => event.evidenceKind === "acceptance_criterion"),
    false,
  );
  for (const event of events.filter((candidate) =>
    ["implement", "test", "github"].includes(candidate.phase),
  )) {
    assert.deepEqual(
      event.workUnits,
      [],
      `${event.evidenceKind} must remain aggregate for multiple children`,
    );
  }
  assert.deepEqual(
    bindAggregateProjectEventsToOnlyWorkUnitV1({
      events,
      bindings: projectLinearBindingsFromProjectLineageV1({ lineage }),
    }),
    events,
    "aggregate evidence must not be broadcast when several children exist",
  );
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
  assert.deepEqual(
    getProjectLineageFingerprintHistoryV1(advanced),
    [first.fingerprint, advanced.fingerprint],
  );
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
