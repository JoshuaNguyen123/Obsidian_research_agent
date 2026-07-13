import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeNpmValidationProfile,
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories";
import {
  LinearQueueSupervisor,
  QueueExecutionCoordinator,
  createCandidateEligibilityPolicy,
  createLinearQueueState,
  createQueueDailyStartBudgetState,
  createResourceLockState,
  evaluateCandidateEligibility,
  recordCandidateEligibility,
  upsertLinearQueueCandidate,
} from "../src/agent/queue";
import {
  ResearchTicketPublisher,
  createWorkItemSpecV1,
  createWorkItemSpecV2,
  parseRenderedCompatibleWorkItemSpec,
  parseRenderedWorkItemSpecV2,
  renderWorkItemSpecV1,
  renderWorkItemSpecV2,
  type LinearIssueRecord,
  type LinearOperationResult,
  type ResearchTicketWorkItemDraftV2,
  type SynthesizedResearchTicketSectionsV1,
} from "../src/integrations/linear";
import type { ToolExecutionContext } from "../src/tools/types";

const T0 = "2026-07-12T12:00:00.000Z";
const T1 = "2026-07-12T12:01:00.000Z";
const PROJECT_ID = "project-queue";
const ARTIFACT_FINGERPRINT = `sha256:${"a".repeat(64)}`;

const SECTIONS: SynthesizedResearchTicketSectionsV1 = {
  contentKind: "synthesized",
  title: "Execute accepted research",
  problemImpact: "The accepted research needs one durable execution handoff.",
  confidenceLimitations: "Only the accepted, hashed note artifact is authoritative.",
  proposedWork: ["Apply the accepted change in the trusted repository."],
  nonGoals: ["Running commands copied from Linear text."],
  scope: ["Trusted repository binding and profile validation."],
  dependencies: [],
};

const V2_DRAFT: ResearchTicketWorkItemDraftV2 = {
  schemaVersion: 2,
  ready: true,
  executionClass: "code",
  objective: "Implement the accepted queue behavior.",
  repositoryKey: "research-agent",
  acceptanceCriteria: [{ id: "AC-1", text: "The queue behavior is verified." }],
  validationRequirementKeys: ["tests.unit", "build.production"],
  evidenceRefs: ["research:accepted-queue-artifact"],
  riskClass: "low",
  originRunId: "research-run-v2",
  acceptedResearchArtifactFingerprint: ARTIFACT_FINGERPRINT,
  generation: 0,
};

test("v2 publisher round-trips its signed contract and deduplicates by exact fingerprint", async () => {
  let duplicateDescription = "";
  const duplicate = issue("issue-v2", T0, duplicateDescription);
  const publisher = new ResearchTicketPublisher({
    queueTeamId: "team-queue",
    queueProjectId: PROJECT_ID,
    readClient: {
      execute: async (operation) => {
        if (operation === "issues.search") {
          return page([{ ...duplicate, description: duplicateDescription }]);
        }
        if (operation === "issues.get") {
          return { ...duplicate, description: duplicateDescription };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    },
    actionExecutor: unusedExecutor(),
  });
  const built = publisher.build(SECTIONS, V2_DRAFT);
  duplicateDescription = built.description;
  if (built.spec.schemaVersion !== 2) {
    assert.fail("V2 publisher draft must build a v2 contract.");
  }

  const parsed = parseRenderedWorkItemSpecV2(built.description).spec;
  assert.equal(parsed.fingerprint, built.spec.fingerprint);
  assert.equal(parsed.acceptedResearchArtifactFingerprint, ARTIFACT_FINGERPRINT);
  assert.deepEqual(parsed.validationRequirementKeys, ["tests.unit", "build.production"]);
  assert.match(built.description, /logical profile keys, not commands/i);

  const preview = await publisher.preview({
    context: {} as ToolExecutionContext,
    sections: SECTIONS,
    draft: V2_DRAFT,
  });
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.status, "deduplicated");
  assert.equal(preview.duplicate?.id, "issue-v2");
});

test("compatible rendering and parsing preserve the existing v1 contract", () => {
  const v1 = createWorkItemSpecV1({
    schemaVersion: 1,
    ready: true,
    executionClass: "research",
    objective: "Preserve legacy work item execution.",
    acceptanceCriteria: [{ id: "AC-1", text: "The v1 fingerprint is unchanged." }],
    validationRequirements: ["Verify the cited evidence."],
    evidenceRefs: ["https://example.test/evidence"],
    riskClass: "low",
    originRunId: "legacy-run",
    generation: 0,
  });
  const markdown = renderWorkItemSpecV1(v1);
  const parsed = parseRenderedCompatibleWorkItemSpec(markdown).spec;
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed, v1);
});

test("v2 rejects raw path or command authority while a trusted repository key is eligible", () => {
  assert.throws(
    () => createWorkItemSpecV2({ ...V2_DRAFT, repositoryKey: "C:\\source\\repo" }),
    /logical key|repository key/i,
  );
  assert.throws(
    () => createWorkItemSpecV2({ ...V2_DRAFT, objective: "Run npm test before publishing." }),
    /raw paths or commands|authority/i,
  );

  const profile = createRepositoryProfile({
    key: "research-agent",
    displayName: "Research Agent",
    repositoryRoot: "C:\\work\\research-agent",
    defaultBranch: "main",
    allowedPathPrefixes: ["src", "tests"],
    validationProfile: createNodeNpmValidationProfile(),
  });
  const workItem = createWorkItemSpecV2(V2_DRAFT);
  const eligibility = evaluateCandidateEligibility(workItem, {
    policy: createCandidateEligibilityPolicy({
      allowedRepositoryKeys: ["research-agent"],
    }),
    repositories: createRepositoryProfileRegistry([profile]),
    at: T1,
  });
  assert.equal(eligibility.eligible, true);
  assert.deepEqual(eligibility.reasons, []);
});

test("preclaim readback verifies project, state, timestamp, contract, and fingerprint", async (t) => {
  const workItem = researchWorkItem();
  let queue = createLinearQueueState({ workspaceId: "workspace-verify", at: T0 });
  queue = upsertLinearQueueCandidate(queue, {
    at: T0,
    issueId: "issue-verify",
    identifier: "ENG-42",
    remoteUpdatedAt: T0,
    remoteStateId: "state-todo",
    workItem,
  });
  const exact = issue("issue-verify", T0, renderWorkItemSpecV2(workItem));
  const differentContract = researchWorkItem({ objective: "Synthesize different evidence." });
  const cases: Array<[string, LinearIssueRecord]> = [
    ["project", { ...exact, project: { id: "project-other" } }],
    ["state", { ...exact, state: { id: "state-started", type: "started" } }],
    ["timestamp", { ...exact, updatedAt: T1 }],
    ["contract fingerprint", { ...exact, description: renderWorkItemSpecV2(differentContract) }],
  ];
  assert.equal(await verifierFor(exact).verifyCandidateBeforeClaim({
    candidate: queue.candidates["issue-verify"],
    signal: new AbortController().signal,
  }), true);
  for (const [label, readback] of cases) {
    await t.test(label, async () => {
      assert.equal(await verifierFor(readback).verifyCandidateBeforeClaim({
        candidate: queue.candidates["issue-verify"],
        signal: new AbortController().signal,
      }), false);
    });
  }
});

test("stale preclaim timestamp blocks a v2 claim before any mutation", async () => {
  const researchSpec = researchWorkItem();
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  queue = upsertLinearQueueCandidate(queue, {
    at: T0,
    issueId: "issue-stale",
    identifier: "ENG-42",
    remoteUpdatedAt: T0,
    remoteStateId: "state-todo",
    workItem: researchSpec,
  });
  queue = recordCandidateEligibility(
    queue,
    "issue-stale",
    evaluateCandidateEligibility(researchSpec, {
      policy: createCandidateEligibilityPolicy(),
      repositories: createRepositoryProfileRegistry(),
      at: T0,
    }),
  );
  let locks = createResourceLockState(queue.updatedAt);
  let budget = createQueueDailyStartBudgetState({ at: queue.updatedAt });
  const changed = issue(
    "issue-stale",
    T1,
    renderWorkItemSpecV2(researchSpec),
  );
  const supervisor = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async (operation) => {
        if (operation === "issues.get") return changed;
        throw new Error(`Unexpected operation ${operation}`);
      },
    },
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    isConnectionEligible: () => true,
    isConfigurationEligible: () => true,
    isExecutionGrantEligible: () => true,
    evaluateCandidate: ({ workItem: value, at }) =>
      evaluateCandidateEligibility(value, {
        policy: createCandidateEligibilityPolicy(),
        repositories: createRepositoryProfileRegistry(),
        at,
      }),
  });
  let claimCalled = false;
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    reduceResourceLocks: async (reduce) => {
      locks = reduce(locks);
      return locks;
    },
    reduceDailyStartBudget: async (reduce) => {
      budget = reduce(budget);
      return budget;
    },
    isExecutionGrantEligible: () => true,
    verifyCandidateBeforeClaim: ({ candidate, signal }) =>
      supervisor.verifyCandidateBeforeClaim({ candidate, signal }),
    createClaimComment: async () => {
      claimCalled = true;
      return { status: "applied" };
    },
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async () => ({ status: "completed" }),
    retainLease: () => undefined,
    releaseLease: () => undefined,
  });

  const result = await coordinator.runCandidate("issue-stale");
  assert.deepEqual(result, {
    issueId: "issue-stale",
    status: "skipped",
    reason: "preclaim_snapshot_unverified",
  });
  assert.equal(claimCalled, false);
  await coordinator.stop();
});

function issue(id: string, updatedAt: string, description: string): LinearIssueRecord {
  return {
    resourceType: "issue",
    id,
    identifier: "ENG-42",
    url: `https://linear.app/acme/issue/${id}`,
    title: "Accepted work",
    description,
    priority: 2,
    trashed: false,
    team: { id: "team-queue", key: "ENG", name: "Engineering" },
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    project: { id: PROJECT_ID, name: "Execution queue" },
    labels: [],
    createdAt: T0,
    updatedAt,
    snapshotHash: `sha256:${"b".repeat(64)}`,
  };
}

function researchWorkItem(overrides: { objective?: string } = {}) {
  return createWorkItemSpecV2({
    schemaVersion: 2,
    ready: true,
    executionClass: "research",
    objective: overrides.objective ?? "Synthesize the accepted evidence.",
    acceptanceCriteria: [{ id: "AC-1", text: "Evidence is synthesized." }],
    validationRequirementKeys: ["research.evidence"],
    evidenceRefs: ["research:accepted-queue-artifact"],
    riskClass: "low",
    originRunId: "research-run-v2",
    acceptedResearchArtifactFingerprint: ARTIFACT_FINGERPRINT,
    generation: 0,
  });
}

function verifierFor(readback: LinearIssueRecord): LinearQueueSupervisor {
  let queue = createLinearQueueState({ workspaceId: "workspace-verifier", at: T0 });
  return new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async (operation) => {
        if (operation === "issues.get") return readback;
        throw new Error(`Unexpected operation ${operation}`);
      },
    },
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    isConnectionEligible: () => true,
    isConfigurationEligible: () => true,
    isExecutionGrantEligible: () => true,
    evaluateCandidate: ({ workItem, at }) =>
      evaluateCandidateEligibility(workItem, {
        policy: createCandidateEligibilityPolicy(),
        repositories: createRepositoryProfileRegistry(),
        at,
      }),
  });
}

function page(items: LinearIssueRecord[]): LinearOperationResult {
  return {
    items,
    pageInfo: { hasNextPage: false },
    fetchedAt: T0,
  };
}

function unusedExecutor(): ConstructorParameters<typeof ResearchTicketPublisher>[0]["actionExecutor"] {
  return {
    prepare: async () => {
      throw new Error("Deduplicated preview must not prepare an action.");
    },
    executePrepared: async () => {
      throw new Error("Deduplicated preview must not execute an action.");
    },
  };
}
