import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeNpmValidationProfile,
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories";
import {
  acquireLinearQueueLease,
  advanceLinearQueueCursor,
  compareLinearQueueCursors,
  createCandidateEligibilityPolicy,
  createLinearQueueState,
  evaluateCandidateEligibility,
  normalizeLinearQueueState,
  recordCandidateEligibility,
  reduceLinearQueue,
  selectNextEligibleCandidate,
  upsertLinearQueueCandidate,
} from "../src/agent/queue";
import { createWorkItemSpecV1 } from "../src/integrations/linear/WorkItemSpecV1";

const T0 = "2026-07-11T12:00:00.000Z";
const T1 = "2026-07-11T12:01:00.000Z";
const T2 = "2026-07-11T12:02:00.000Z";

function createFixture() {
  const profile = createRepositoryProfile({
    key: "research-agent",
    displayName: "Research Agent",
    repositoryRoot: "C:\\work\\research-agent",
    defaultBranch: "main",
    allowedPathPrefixes: ["src", "tests"],
    validationProfile: createNodeNpmValidationProfile(),
  });
  const repositories = createRepositoryProfileRegistry([profile]);
  const workItem = createWorkItemSpecV1({
    schemaVersion: 1,
    ready: true,
    executionClass: "code",
    objective: "Implement the durable queue contract.",
    repositoryKey: profile.key,
    acceptanceCriteria: [{ id: "AC-1", text: "Queue tests pass." }],
    validationRequirements: ["npm test", "npm run build"],
    evidenceRefs: ["https://linear.app/acme/issue/ENG-42"],
    riskClass: "low",
    originRunId: "run-1",
    generation: 0,
  });
  return { repositories, workItem };
}

test("candidate eligibility is deterministic and repository-gated", () => {
  const { repositories, workItem } = createFixture();
  const policy = createCandidateEligibilityPolicy({
    allowedRepositoryKeys: ["research-agent"],
  });
  const eligible = evaluateCandidateEligibility(workItem, {
    policy,
    repositories,
    at: T1,
  });
  assert.deepEqual(eligible.reasons, []);
  assert.equal(eligible.eligible, true);

  const { fingerprint: _fingerprint, ...unsignedWorkItem } = workItem;
  const highRisk = createWorkItemSpecV1({ ...unsignedWorkItem, riskClass: "high" });
  const rejected = evaluateCandidateEligibility(highRisk, {
    policy,
    repositories,
    at: T1,
  });
  assert.equal(rejected.eligible, false);
  assert.deepEqual(rejected.reasons, ["risk_not_allowed"]);
});

test("research needs no repository while vault work needs a trusted host binding", () => {
  const { repositories, workItem } = createFixture();
  const { fingerprint: _fingerprint, repositoryKey: _repositoryKey, ...base } = workItem;
  const research = createWorkItemSpecV1({
    ...base,
    executionClass: "research",
  });
  const researchDecision = evaluateCandidateEligibility(research, {
    policy: createCandidateEligibilityPolicy(),
    repositories,
    at: T1,
  });
  assert.equal(researchDecision.eligible, true);
  assert.equal(researchDecision.repositoryKey, null);

  const vault = createWorkItemSpecV1({
    ...base,
    executionClass: "vault",
  });
  const unbound = evaluateCandidateEligibility(vault, {
    policy: createCandidateEligibilityPolicy(),
    repositories,
    at: T1,
  });
  assert.deepEqual(unbound.reasons, ["missing_trusted_binding"]);
  const bound = evaluateCandidateEligibility(vault, {
    policy: createCandidateEligibilityPolicy(),
    repositories,
    at: T1,
    trustedBindingAvailable: true,
  });
  assert.equal(bound.eligible, true);
});

test("pure queue reducer persists eligibility, leases, execution, and retry state", () => {
  const { repositories, workItem } = createFixture();
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  queue = upsertLinearQueueCandidate(queue, {
    at: T0,
    issueId: "issue-42",
    identifier: "ENG-42",
    remoteUpdatedAt: T0,
    workItem,
  });
  const eligibility = evaluateCandidateEligibility(workItem, {
    policy: createCandidateEligibilityPolicy(),
    repositories,
    at: T1,
  });
  queue = recordCandidateEligibility(queue, "issue-42", eligibility);
  assert.equal(selectNextEligibleCandidate(queue, { at: T1 })?.identifier, "ENG-42");

  const claim = acquireLinearQueueLease(queue, {
    issueId: "issue-42",
    ownerId: "worker-1",
    at: T1,
    leaseMs: 60_000,
  });
  assert.equal(claim.accepted, true);
  const blockedClaim = acquireLinearQueueLease(claim.state, {
    issueId: "issue-42",
    ownerId: "worker-2",
    at: "2026-07-11T12:01:30.000Z",
    leaseMs: 60_000,
  });
  assert.deepEqual(blockedClaim.reason, "leased");

  queue = reduceLinearQueue(claim.state, {
    type: "candidate_started",
    expectedRevision: claim.state.revision,
    at: "2026-07-11T12:01:10.000Z",
    issueId: "issue-42",
    ownerId: "worker-1",
    token: claim.lease!.token,
  });
  queue = reduceLinearQueue(queue, {
    type: "candidate_failed",
    expectedRevision: queue.revision,
    at: "2026-07-11T12:01:20.000Z",
    issueId: "issue-42",
    ownerId: "worker-1",
    token: claim.lease!.token,
    error: "Transient validation service failure.",
    retryable: true,
  });
  assert.equal(queue.candidates["issue-42"].status, "eligible");
  assert.equal(queue.candidates["issue-42"].attemptCount, 1);
  assert.equal(queue.candidates["issue-42"].lease, null);
  assert.deepEqual(normalizeLinearQueueState(JSON.parse(JSON.stringify(queue))), queue);
});

test("queue cursor is monotonic with an issue-id tie breaker", () => {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  queue = advanceLinearQueueCursor(
    queue,
    { updatedAt: T1, issueId: "issue-a" },
    T1,
  );
  assert.ok(
    compareLinearQueueCursors(
      { updatedAt: T1, issueId: "issue-b" },
      { updatedAt: T1, issueId: "issue-a" },
    ) > 0,
  );
  queue = advanceLinearQueueCursor(
    queue,
    { updatedAt: T1, issueId: "issue-b" },
    T2,
  );
  assert.equal(queue.cursor?.issueId, "issue-b");
  assert.throws(
    () =>
      advanceLinearQueueCursor(
        queue,
        { updatedAt: T0, issueId: "issue-z" },
        T2,
      ),
    /must not move backwards/i,
  );
});

test("queue rejects stale remote updates and reducer revision races", () => {
  const { workItem } = createFixture();
  const initial = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  const queued = upsertLinearQueueCandidate(initial, {
    at: T1,
    issueId: "issue-42",
    identifier: "ENG-42",
    remoteUpdatedAt: T1,
    workItem,
  });
  assert.throws(
    () =>
      upsertLinearQueueCandidate(queued, {
        at: T2,
        issueId: "issue-42",
        identifier: "ENG-42",
        remoteUpdatedAt: T0,
        workItem,
      }),
    /regress/i,
  );
  assert.throws(
    () =>
      reduceLinearQueue(queued, {
        type: "cursor_advanced",
        expectedRevision: 0,
        at: T2,
        cursor: { updatedAt: T2, issueId: "issue-42" },
      }),
    /revision conflict/i,
  );
});
