import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeNpmValidationProfile,
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories";
import {
  LINEAR_QUEUE_SCAN_INTERVAL_MS,
  LINEAR_QUEUE_SCAN_LIMIT,
  LinearQueueSupervisor,
  QueueExecutionCoordinator,
  advanceLinearQueueCursor,
  createCandidateEligibilityPolicy,
  createQueueDailyStartBudgetState,
  createLinearQueueState,
  createResourceLockState,
  evaluateCandidateEligibility,
  normalizeLinearQueueState,
  recordCandidateEligibility,
  reduceLinearQueue,
  reserveQueueDailyStart,
  upsertLinearQueueCandidate,
  type DurableQueueDailyStartBudgetReducer,
  type DurableLinearQueueReducer,
  type DurableResourceLockReducer,
  type LinearQueueClock,
  type LinearQueueStateV1,
  type LinearQueueTimer,
  type QueueDailyStartBudgetStateV1,
  type ResourceLockStateV1,
} from "../src/agent/queue";
import type {
  LinearIssueRecord,
  LinearOperationResult,
} from "../src/integrations/linear/types";
import { createWorkItemSpecV1 } from "../src/integrations/linear/WorkItemSpecV1";
import { renderWorkItemSpecV1 } from "../src/integrations/linear/WorkItemRenderer";

const PROJECT_ID = "project-queue";
const T0 = "2026-07-11T10:00:00.000Z";

test("supervisor polls every 15 minutes, scopes the trusted project, and caps scans at 10", async () => {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  const timer = new FakeTimer();
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  const readyBatches: string[][] = [];
  const issues = [
    makeIssue(99, "foreign-project", "2026-07-11T11:00:00.000Z"),
    ...Array.from({ length: 12 }, (_, index) =>
      makeIssue(
        index + 1,
        PROJECT_ID,
        `2026-07-11T11:00:${String(index + 1).padStart(2, "0")}.000Z`,
      ),
    ),
  ].reverse();
  const supervisor = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async (operation, variables = {}) => {
        calls.push({ operation, variables });
        return issuePage(issues);
      },
    },
    clock: new IncrementingClock("2026-07-11T12:00:00.000Z"),
    timer,
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
    onCandidatesReady: (ids) => {
      readyBatches.push(ids);
    },
  });

  const result = await supervisor.start();
  assert.equal(result?.status, "completed");
  if (result?.status !== "completed") {
    return;
  }
  assert.equal(timer.intervalMs, LINEAR_QUEUE_SCAN_INTERVAL_MS);
  assert.equal(result.fetched, LINEAR_QUEUE_SCAN_LIMIT);
  assert.equal(result.upserted, LINEAR_QUEUE_SCAN_LIMIT);
  assert.equal(Object.keys(queue.candidates).length, LINEAR_QUEUE_SCAN_LIMIT);
  assert.equal(queue.candidates["issue-99"], undefined);
  assert.equal(queue.cursor?.issueId, "issue-10");
  assert.equal(readyBatches[0].length, LINEAR_QUEUE_SCAN_LIMIT);
  assert.equal(calls[0].operation, "issues.list");
  assert.deepEqual(calls[0].variables, {
    first: 10,
    includeArchived: false,
    filter: { project: { id: { eq: PROJECT_ID } } },
  });
  await supervisor.stop();
  assert.equal(timer.cleared, true);
});

test("supervisor preserves its cursor when the final durable cursor commit fails", async () => {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  queue = advanceLinearQueueCursor(
    queue,
    { updatedAt: "2026-07-11T11:00:00.000Z", issueId: "issue-1" },
    "2026-07-11T11:30:00.000Z",
  );
  const originalCursor = queue.cursor;
  let rejectCursorCommit = true;
  const variables: Record<string, unknown>[] = [];
  const supervisor = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async (_operation, input = {}) => {
        variables.push(input);
        return issuePage([
          makeIssue(2, PROJECT_ID, "2026-07-11T11:01:00.000Z"),
        ]);
      },
    },
    clock: new IncrementingClock("2026-07-11T12:00:00.000Z"),
    timer: new FakeTimer(),
    reduceQueueState: async (reduce) => {
      const next = reduce(queue);
      if (
        rejectCursorCommit &&
        JSON.stringify(next.cursor) !== JSON.stringify(queue.cursor)
      ) {
        throw new Error("simulated durable cursor failure");
      }
      queue = next;
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

  const failed = await supervisor.start();
  assert.equal(failed?.status, "failed");
  assert.deepEqual(queue.cursor, originalCursor);
  assert.equal(queue.candidates["issue-2"].status, "eligible");
  assert.deepEqual(variables[0].filter, {
    project: { id: { eq: PROJECT_ID } },
    updatedAt: { gte: originalCursor!.updatedAt },
  });

  rejectCursorCommit = false;
  const retried = await supervisor.scanNow();
  assert.equal(retried.status, "completed");
  assert.equal(queue.cursor?.issueId, "issue-2");
  await supervisor.stop();
});

test("grant-ineligible candidates remain pending and can be evaluated on a later scan", async () => {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  let grant = false;
  const supervisor = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async () =>
        issuePage([makeIssue(1, PROJECT_ID, "2026-07-11T11:00:00.000Z")]),
    },
    clock: new IncrementingClock("2026-07-11T12:00:00.000Z"),
    timer: new FakeTimer(),
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    isConnectionEligible: () => true,
    isConfigurationEligible: () => true,
    isExecutionGrantEligible: () => grant,
    evaluateCandidate: ({ workItem, at }) =>
      evaluateCandidateEligibility(workItem, {
        policy: createCandidateEligibilityPolicy(),
        repositories: createRepositoryProfileRegistry(),
        at,
      }),
  });

  const first = await supervisor.start();
  assert.equal(first?.status, "completed");
  assert.equal(queue.candidates["issue-1"].status, "pending");
  grant = true;
  const second = await supervisor.scanNow();
  assert.equal(second.status, "completed");
  if (second.status === "completed") {
    assert.equal(second.fetched, 0);
    assert.deepEqual(second.readyIssueIds, ["issue-1"]);
  }
  assert.equal(queue.candidates["issue-1"].status, "eligible");
  await supervisor.stop();
});

test("connection and configuration gates prevent Linear reads", async () => {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  let clientCalls = 0;
  let configurationCalls = 0;
  const connectionBlocked = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async () => {
        clientCalls += 1;
        return issuePage([]);
      },
    },
    timer: new FakeTimer(),
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    isConnectionEligible: () => false,
    isConfigurationEligible: () => {
      configurationCalls += 1;
      return true;
    },
    isExecutionGrantEligible: () => true,
    evaluateCandidate: () => {
      throw new Error("not reached");
    },
  });
  assert.deepEqual(await connectionBlocked.start(), {
    status: "skipped",
    reason: "connection_ineligible",
  });
  assert.equal(configurationCalls, 0);
  assert.equal(clientCalls, 0);
  await connectionBlocked.stop();

  const configurationBlocked = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async () => {
        clientCalls += 1;
        return issuePage([]);
      },
    },
    timer: new FakeTimer(),
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    isConnectionEligible: () => true,
    isConfigurationEligible: () => false,
    isExecutionGrantEligible: () => true,
    evaluateCandidate: () => {
      throw new Error("not reached");
    },
  });
  assert.deepEqual(await configurationBlocked.start(), {
    status: "skipped",
    reason: "configuration_ineligible",
  });
  assert.equal(clientCalls, 0);
  await configurationBlocked.stop();
});

test("supervisor prevents overlapping scans and aborts the active scan on stop", async () => {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  const timer = new FakeTimer();
  let aborted = false;
  const supervisor = new LinearQueueSupervisor({
    queueProjectId: PROJECT_ID,
    client: {
      execute: async (_operation, _variables, options) =>
        new Promise<LinearOperationResult>((_resolve, reject) => {
          if (options?.abortSignal?.aborted) {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          options?.abortSignal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    },
    clock: new IncrementingClock("2026-07-11T12:00:00.000Z"),
    timer,
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    isConnectionEligible: () => true,
    isConfigurationEligible: () => true,
    isExecutionGrantEligible: () => true,
    evaluateCandidate: () => {
      throw new Error("not reached");
    },
  });

  const active = supervisor.start();
  await waitFor(() => timer.callback !== null);
  const overlap = await supervisor.scanNow();
  assert.deepEqual(overlap, { status: "skipped", reason: "scan_in_progress" });
  await supervisor.stop();
  const activeResult = await active;
  assert.deepEqual(activeResult, { status: "skipped", reason: "stopped" });
  assert.equal(aborted, true);
  assert.equal(timer.cleared, true);
});

test("coordinator verifies both claim mutations before executing and never exceeds concurrency two", async () => {
  const durable = createDurableRuntime(3);
  const clock = new IncrementingClock("2026-07-11T13:00:00.000Z");
  const orders = new Map<string, string[]>();
  const gates = new Map<string, Deferred<void>>();
  const started: string[] = [];
  const releases: string[] = [];
  const retained: string[] = [];
  let activeExecutions = 0;
  let maximumExecutions = 0;
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-pool",
    clock,
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async ({ candidate }) => {
      event(orders, candidate.issueId, "comment");
      return { status: "applied" };
    },
    verifyClaimComment: async ({ candidate }) => {
      event(orders, candidate.issueId, "verify-comment");
      return true;
    },
    moveIssueToStarted: async ({ candidate }) => {
      event(orders, candidate.issueId, "move-started");
      return { status: "applied" };
    },
    verifyIssueStarted: async ({ candidate }) => {
      event(orders, candidate.issueId, "verify-started");
      return true;
    },
    execute: async ({ candidate }) => {
      event(orders, candidate.issueId, "execute");
      activeExecutions += 1;
      maximumExecutions = Math.max(maximumExecutions, activeExecutions);
      started.push(candidate.issueId);
      const gate = deferred<void>();
      gates.set(candidate.issueId, gate);
      await gate.promise;
      activeExecutions -= 1;
      return { status: "completed" };
    },
    retainLease: ({ candidate, reason }) => {
      assert.equal(reason, "execution_active");
      retained.push(candidate.issueId);
    },
    releaseLease: ({ candidate }) => {
      releases.push(candidate.issueId);
    },
  });

  const run = coordinator.runCandidates(["issue-1", "issue-2", "issue-3"]);
  await waitFor(() => started.length === 2);
  assert.equal(maximumExecutions, 2);
  assert.equal(orders.has("issue-3"), false);
  gates.get(started[0])!.resolve();
  await waitFor(() => started.length === 3);
  for (const gate of gates.values()) {
    gate.resolve();
  }
  const results = await run;
  assert.ok(results.every((result) => result.status === "completed"));
  assert.equal(maximumExecutions, 2);
  assert.equal(releases.length, 3);
  assert.equal(retained.length, 3);
  for (const issueId of ["issue-1", "issue-2", "issue-3"]) {
    assert.deepEqual(orders.get(issueId), [
      "comment",
      "verify-comment",
      "move-started",
      "verify-started",
      "execute",
    ]);
    assert.equal(durable.queue().candidates[issueId].status, "completed");
  }
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  await coordinator.stop();
});

test("coordinator refuses execution when started-state readback is not verified", async () => {
  const durable = createDurableRuntime(1);
  let executed = false;
  const releaseReasons: string[] = [];
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async () => ({ status: "applied" }),
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => false,
    execute: async () => {
      executed = true;
      return { status: "completed" };
    },
    retainLease: () => undefined,
    releaseLease: ({ reason }) => {
      releaseReasons.push(reason);
    },
  });

  const result = await coordinator.runCandidate("issue-1");
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "skipped",
    reason: "started_state_unverified",
  });
  assert.equal(executed, false);
  assert.equal(durable.queue().candidates["issue-1"].status, "eligible");
  assert.equal(durable.queue().candidates["issue-1"].lease, null);
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  assert.deepEqual(releaseReasons, ["start_verification_failed"]);
  await coordinator.stop();
});

test("ambiguous claim dispatch retains leases and surfaces reconciliation", async () => {
  const durable = createDurableRuntime(1);
  let verified = false;
  let executed = false;
  const retained: string[] = [];
  const released: string[] = [];
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async () => ({
      status: "ambiguous",
      operationId: "claim-operation-1",
    }),
    verifyClaimComment: async () => {
      verified = true;
      return true;
    },
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async () => {
      executed = true;
      return { status: "completed" };
    },
    retainLease: ({ candidate }) => {
      retained.push(candidate.issueId);
    },
    releaseLease: ({ candidate }) => {
      released.push(candidate.issueId);
    },
  });

  const result = await coordinator.runCandidate("issue-1");
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "reconcile_required",
    stage: "claim_comment",
    operationId: "claim-operation-1",
  });
  assert.equal(verified, false);
  assert.equal(executed, false);
  assert.deepEqual(retained, ["issue-1"]);
  assert.deepEqual(released, []);
  assert.ok(durable.queue().candidates["issue-1"].lease);
  assert.equal(Object.keys(durable.locks().locks).length, 1);
  await coordinator.stop();
});

test("ambiguous worker publication retains leases without completing or failing locally", async () => {
  const durable = createDurableRuntime(1);
  const retained: Array<{ issueId: string; reason: string }> = [];
  const released: string[] = [];
  const reconciliations: Array<{ stage: string; operationId?: string }> = [];
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async () => ({ status: "applied" }),
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async () => ({
      status: "reconcile_required",
      stage: "completed_state",
      operationId: "complete-operation-1",
    }),
    retainLease: ({ candidate, reason }) => {
      retained.push({ issueId: candidate.issueId, reason });
    },
    releaseLease: ({ candidate }) => {
      released.push(candidate.issueId);
    },
    onReconcileRequired: ({ stage, operationId }) => {
      reconciliations.push({ stage, operationId });
    },
  });

  const result = await coordinator.runCandidate("issue-1");
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "reconcile_required",
    stage: "completed_state",
    operationId: "complete-operation-1",
  });
  assert.equal(durable.queue().candidates["issue-1"].status, "running");
  assert.ok(durable.queue().candidates["issue-1"].lease);
  assert.equal(Object.keys(durable.locks().locks).length, 1);
  assert.deepEqual(retained, [
    { issueId: "issue-1", reason: "execution_active" },
    { issueId: "issue-1", reason: "reconcile_required" },
  ]);
  assert.deepEqual(released, []);
  assert.deepEqual(reconciliations, [
    { stage: "completed_state", operationId: "complete-operation-1" },
  ]);
  await coordinator.stop();
});

test("verified local code proof waits durably for publication without replaying execution", async () => {
  const durable = createDurableRuntime(1);
  const releases: string[] = [];
  let executions = 0;
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async () => ({ status: "applied" }),
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async () => {
      executions += 1;
      return {
        status: "waiting_for_publication",
        message: "Verified local commit is durable; draft PR and merge proof remain.",
      };
    },
    retainLease: () => undefined,
    releaseLease: ({ reason }) => {
      releases.push(reason);
    },
  });

  const result = await coordinator.runCandidate("issue-1");
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "waiting_for_publication",
    message: "Verified local commit is durable; draft PR and merge proof remain.",
  });
  const waiting = durable.queue().candidates["issue-1"];
  assert.equal(waiting.status, "waiting_for_publication");
  assert.equal(waiting.completedAt, null);
  assert.equal(waiting.lease, null);
  assert.equal(
    waiting.lastError,
    "Verified local commit is durable; draft PR and merge proof remain.",
  );
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  assert.deepEqual(releases, ["execution_waiting_for_publication"]);

  const restored = normalizeLinearQueueState(
    JSON.parse(JSON.stringify(durable.queue())),
  );
  assert.equal(restored.candidates["issue-1"].status, "waiting_for_publication");
  assert.deepEqual(await coordinator.runCandidate("issue-1"), {
    issueId: "issue-1",
    status: "skipped",
    reason: "terminal",
  });
  assert.equal(executions, 1);

  const completedAt = new Date(Date.parse(restored.updatedAt) + 1_000).toISOString();
  const completed = reduceLinearQueue(restored, {
    type: "candidate_publication_completed",
    expectedRevision: restored.revision,
    at: completedAt,
    issueId: "issue-1",
  });
  assert.equal(completed.candidates["issue-1"].status, "completed");
  assert.equal(completed.candidates["issue-1"].completedAt, completedAt);
  assert.equal(completed.candidates["issue-1"].lastError, null);
  await coordinator.stop();
});

test("worker-blocked tickets stay dormant until their contract fingerprint changes", async () => {
  const durable = createDurableRuntime(1);
  const releases: string[] = [];
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async () => ({ status: "applied" }),
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async () => ({
      status: "blocked",
      error: "Required human review is still outstanding.",
    }),
    retainLease: () => undefined,
    releaseLease: ({ reason }) => {
      releases.push(reason);
    },
  });

  const result = await coordinator.runCandidate("issue-1");
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "blocked",
    error: "Required human review is still outstanding.",
  });
  const blocked = durable.queue().candidates["issue-1"];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.eligibility?.eligible, true);
  assert.equal(blocked.lastError, "Required human review is still outstanding.");
  assert.equal(blocked.lease, null);
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  assert.deepEqual(releases, ["execution_blocked"]);
  assert.deepEqual(await coordinator.runCandidate("issue-1"), {
    issueId: "issue-1",
    status: "skipped",
    reason: "terminal",
  });

  await durable.reduceQueueState((current) =>
    upsertLinearQueueCandidate(current, {
      at: "2026-07-11T14:00:00.000Z",
      issueId: blocked.issueId,
      identifier: blocked.identifier,
      remoteUpdatedAt: "2026-07-11T14:00:00.000Z",
      workItem: blocked.workItem,
    }),
  );
  assert.equal(durable.queue().candidates["issue-1"].status, "blocked");

  if (blocked.workItem.schemaVersion !== 1) {
    assert.fail("Legacy blocker fixture must remain a v1 work item.");
  }
  const { fingerprint: _fingerprint, ...unsignedWorkItem } = blocked.workItem;
  const changedWorkItem = createWorkItemSpecV1({
    ...unsignedWorkItem,
    objective: "Resume after the human review requirement was resolved.",
  });
  await durable.reduceQueueState((current) =>
    upsertLinearQueueCandidate(current, {
      at: "2026-07-11T14:01:00.000Z",
      issueId: blocked.issueId,
      identifier: blocked.identifier,
      remoteUpdatedAt: "2026-07-11T14:01:00.000Z",
      workItem: changedWorkItem,
    }),
  );
  const resumed = durable.queue().candidates["issue-1"];
  assert.equal(resumed.status, "pending");
  assert.equal(resumed.eligibility, null);
  assert.equal(resumed.lastError, null);
  await coordinator.stop();
});

test("coordinator stop aborts active execution and releases queue/resource leases", async () => {
  const durable = createDurableRuntime(1);
  let executionStarted = false;
  const releaseReasons: string[] = [];
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    createClaimComment: async () => ({ status: "applied" }),
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async ({ signal }) =>
      new Promise((resolve, reject) => {
        executionStarted = true;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("stopped", "AbortError")),
          { once: true },
        );
      }),
    retainLease: () => undefined,
    releaseLease: ({ reason }) => {
      releaseReasons.push(reason);
    },
  });

  const run = coordinator.runCandidate("issue-1");
  await waitFor(() => executionStarted);
  await coordinator.stop();
  const result = await run;
  assert.deepEqual(result, { issueId: "issue-1", status: "skipped", reason: "stopped" });
  assert.equal(durable.queue().candidates["issue-1"].status, "eligible");
  assert.equal(durable.queue().candidates["issue-1"].lease, null);
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  assert.deepEqual(releaseReasons, ["stopped"]);
});

test("coordinator rechecks a grant revoked after scanning before any claim mutation", async () => {
  const durable = createDurableRuntime(1);
  const grantCheckStarted = deferred<void>();
  const finishGrantCheck = deferred<void>();
  let grantLive = true;
  let remoteMutationCalled = false;
  const releaseReasons: string[] = [];
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: async () => {
      grantCheckStarted.resolve();
      await finishGrantCheck.promise;
      return grantLive;
    },
    createClaimComment: async () => {
      remoteMutationCalled = true;
      return { status: "applied" };
    },
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async () => ({ status: "completed" }),
    retainLease: () => undefined,
    releaseLease: ({ reason }) => {
      releaseReasons.push(reason);
    },
  });

  const run = coordinator.runCandidate("issue-1");
  await grantCheckStarted.promise;
  grantLive = false;
  finishGrantCheck.resolve();
  const result = await run;
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "skipped",
    reason: "grant_ineligible",
  });
  assert.equal(remoteMutationCalled, false);
  assert.equal(Object.keys(durable.dailyBudget().reservations).length, 0);
  assert.equal(durable.queue().candidates["issue-1"].lease, null);
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  assert.deepEqual(releaseReasons, ["grant_ineligible"]);
  await coordinator.stop();
});

test("coordinator reserves the durable daily start budget before Linear mutation", async () => {
  const durable = createDurableRuntime(1);
  for (let index = 0; index < 25; index += 1) {
    await durable.reduceDailyStartBudget((current) =>
      reserveQueueDailyStart(current, {
        issueId: `budget-issue-${index}`,
        contractFingerprint: budgetFingerprint(index),
        at: `2026-07-11T12:30:${String(index).padStart(2, "0")}.000Z`,
      }).state,
    );
  }
  let claimCalled = false;
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-1",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
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

  const result = await coordinator.runCandidate("issue-1");
  assert.deepEqual(result, {
    issueId: "issue-1",
    status: "skipped",
    reason: "daily_limit_exhausted",
  });
  assert.equal(claimCalled, false);
  assert.equal(Object.keys(durable.dailyBudget().reservations).length, 25);
  assert.equal(durable.queue().candidates["issue-1"].lease, null);
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  await coordinator.stop();
});

test("host vault locks serialize tickets while preserving distinct repository defaults", async () => {
  const durable = createDurableRuntime(2, ["repo-a", "repo-b"]);
  const firstExecution = deferred<void>();
  const finishFirst = deferred<void>();
  let secondExecuted = false;
  const coordinator = new QueueExecutionCoordinator({
    ownerId: "worker-pool",
    clock: new IncrementingClock("2026-07-11T13:00:00.000Z"),
    reduceQueueState: durable.reduceQueueState,
    reduceResourceLocks: durable.reduceResourceLocks,
    reduceDailyStartBudget: durable.reduceDailyStartBudget,
    isExecutionGrantEligible: () => true,
    resolveAdditionalResourceKeys: () => ["vault:path:shared-note.md"],
    createClaimComment: async () => ({ status: "applied" }),
    verifyClaimComment: async () => true,
    moveIssueToStarted: async () => ({ status: "applied" }),
    verifyIssueStarted: async () => true,
    execute: async ({ candidate }) => {
      if (candidate.issueId === "issue-1") {
        firstExecution.resolve();
        await finishFirst.promise;
      } else {
        secondExecuted = true;
      }
      return { status: "completed" };
    },
    retainLease: () => undefined,
    releaseLease: () => undefined,
  });

  const firstRun = coordinator.runCandidate("issue-1");
  await firstExecution.promise;
  assert.deepEqual(Object.keys(durable.locks().locks).sort(), [
    "linear:issue:issue-1",
    "repository:repo-a",
    "vault:path:shared-note.md",
  ]);
  const secondRun = coordinator.runCandidate("issue-2");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(secondExecuted, false);
  assert.equal(durable.dailyBudget().revision, 1);
  finishFirst.resolve();
  assert.deepEqual(await firstRun, { issueId: "issue-1", status: "completed" });
  assert.deepEqual(await secondRun, { issueId: "issue-2", status: "completed" });
  assert.equal(secondExecuted, true);
  assert.equal(durable.dailyBudget().revision, 2);
  assert.deepEqual(Object.keys(durable.locks().locks), []);
  await coordinator.stop();
});

function makeIssue(index: number, projectId: string, updatedAt: string): LinearIssueRecord {
  const workItem = createWorkItemSpecV1({
    schemaVersion: 1,
    ready: true,
    executionClass: "research",
    objective: `Research queue candidate ${index}.`,
    acceptanceCriteria: [{ id: "AC-1", text: "The requested result is verified." }],
    validationRequirements: ["Verify the result against cited evidence."],
    evidenceRefs: [`https://linear.app/acme/issue/ENG-${index}`],
    riskClass: "low",
    originRunId: `run-${index}`,
    generation: 0,
  });
  return {
    resourceType: "issue",
    id: `issue-${index}`,
    identifier: `ENG-${index}`,
    url: `https://linear.app/acme/issue/ENG-${index}`,
    title: `Candidate ${index}`,
    description: renderWorkItemSpecV1(workItem),
    priority: 2,
    trashed: false,
    team: { id: "team-1", key: "ENG", name: "Engineering" },
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    project: { id: projectId, name: "Execution queue" },
    labels: [],
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt,
    snapshotHash: `sha256:${String(index).padStart(64, "0")}`,
  };
}

function issuePage(issues: LinearIssueRecord[]): LinearOperationResult {
  return {
    items: issues,
    pageInfo: { hasNextPage: false },
    fetchedAt: "2026-07-11T12:00:00.000Z",
  };
}

function createDurableRuntime(
  candidateCount: number,
  repositoryKeys: readonly string[] = [],
): {
  queue(): LinearQueueStateV1;
  locks(): ResourceLockStateV1;
  dailyBudget(): QueueDailyStartBudgetStateV1;
  reduceQueueState: DurableLinearQueueReducer;
  reduceResourceLocks: DurableResourceLockReducer;
  reduceDailyStartBudget: DurableQueueDailyStartBudgetReducer;
} {
  let queue = createLinearQueueState({ workspaceId: "workspace-1", at: T0 });
  const repositories = createRepositoryProfileRegistry(
    [...new Set(repositoryKeys)].map((repositoryKey) =>
      createRepositoryProfile({
        key: repositoryKey,
        displayName: repositoryKey,
        repositoryRoot: `C:\\work\\${repositoryKey}`,
        defaultBranch: "main",
        allowedPathPrefixes: ["src", "tests"],
        validationProfile: createNodeNpmValidationProfile(),
      }),
    ),
  );
  let second = 0;
  for (let index = 1; index <= candidateCount; index += 1) {
    const issue = makeIssue(index, PROJECT_ID, `2026-07-11T11:00:0${index}.000Z`);
    const repositoryKey = repositoryKeys[index - 1];
    const workItem = createWorkItemSpecV1({
      schemaVersion: 1,
      ready: true,
      executionClass: repositoryKey ? "code" : "research",
      objective: `Execute research candidate ${index}.`,
      ...(repositoryKey ? { repositoryKey } : {}),
      acceptanceCriteria: [{ id: "AC-1", text: "Execution completes with proof." }],
      validationRequirements: ["Validate the final evidence."],
      evidenceRefs: [issue.url],
      riskClass: "low",
      originRunId: `origin-${index}`,
      generation: 0,
    });
    second += 1;
    const upsertAt = `2026-07-11T12:00:${String(second).padStart(2, "0")}.000Z`;
    queue = upsertLinearQueueCandidate(queue, {
      at: upsertAt,
      issueId: issue.id,
      identifier: issue.identifier,
      remoteUpdatedAt: issue.updatedAt!,
      workItem,
    });
    second += 1;
    const evaluatedAt = `2026-07-11T12:00:${String(second).padStart(2, "0")}.000Z`;
    queue = recordCandidateEligibility(
      queue,
      issue.id,
      evaluateCandidateEligibility(workItem, {
        policy: createCandidateEligibilityPolicy(),
        repositories,
        at: evaluatedAt,
      }),
    );
  }
  let locks = createResourceLockState(queue.updatedAt);
  let dailyBudget = createQueueDailyStartBudgetState({ at: queue.updatedAt });
  return {
    queue: () => queue,
    locks: () => locks,
    dailyBudget: () => dailyBudget,
    reduceQueueState: async (reduce) => {
      queue = reduce(queue);
      return queue;
    },
    reduceResourceLocks: async (reduce) => {
      locks = reduce(locks);
      return locks;
    },
    reduceDailyStartBudget: async (reduce) => {
      dailyBudget = reduce(dailyBudget);
      return dailyBudget;
    },
  };
}

class IncrementingClock implements LinearQueueClock {
  private nextMs: number;

  constructor(initial: string) {
    this.nextMs = Date.parse(initial);
  }

  now(): Date {
    const value = new Date(this.nextMs);
    this.nextMs += 1_000;
    return value;
  }
}

class FakeTimer implements LinearQueueTimer {
  callback: (() => void) | null = null;
  intervalMs = 0;
  cleared = false;
  private readonly handle = { fake: true };

  setInterval(callback: () => void, intervalMs: number): unknown {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return this.handle;
  }

  clearInterval(handle: unknown): void {
    assert.equal(handle, this.handle);
    this.cleared = true;
    this.callback = null;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function event(target: Map<string, string[]>, issueId: string, value: string): void {
  target.set(issueId, [...(target.get(issueId) ?? []), value]);
}

function budgetFingerprint(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition.");
}
