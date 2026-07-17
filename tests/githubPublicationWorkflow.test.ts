import assert from "node:assert/strict";
import test from "node:test";

import type { ActionReceipt } from "../src/agent/actions";
import { verifyPreparedActionFingerprint } from "../src/agent/actions/canonicalize";
import {
  GitHubPublicationWorkflowV1,
  isGitHubPublicationLineageProofCheckpointV1,
  type GitHubPublicationApprovalPortV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationProviderPortV1,
  type GitHubPublicationPullRequestV1,
  type PublishVerifiedCodeRequestV1,
} from "../src/integrations/github/GitHubPublicationWorkflow";
import { parseGitHubPublicationCheckpointV1 } from "../src/integrations/github/GitHubPublicationCheckpointStore";
import { createPendingExternalActionStateV2 } from "../src/integrations/PendingExternalActionStateV2";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;
const FP_C = `sha256:${"c".repeat(64)}`;

test("verified local commit pushes, creates a draft PR, and persists fresh proof", async () => {
  const harness = createHarness();
  const workflow = new GitHubPublicationWorkflowV1(harness.options);

  const checkpoint = await workflow.publishDraft(request());

  assert.equal(checkpoint.status, "review_or_merge_ready");
  assert.equal(checkpoint.pullRequest?.draft, true);
  assert.equal(checkpoint.pullRequest?.head.sha, SHA_B);
  assert.deepEqual(checkpoint.proofSnapshot?.passedChecks, ["ci"]);
  assert.deepEqual(harness.approvalKinds, ["publish"]);
  assert.equal(harness.pushes, 1);
  assert.equal(harness.createdPullRequests, 1);
  assert.deepEqual(checkpoint.receiptIds, ["receipt-push", "receipt-pr"]);
  assert.deepEqual(
    harness.checkpoints.map((entry) => entry.status),
    [
      "local_verified",
      "push_prepared",
      "pushed_verified",
      "reconcile_required",
      "draft_pr_verified",
      "review_or_merge_ready",
    ],
  );
});

test("untrusted review changes request local repair and never reaches merge", async () => {
  const harness = createHarness({ reviewState: "CHANGES_REQUESTED" });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const published = await workflow.publishDraft(request());

  assert.equal(published.status, "repair_required");
  assert.deepEqual(published.proofSnapshot?.changesRequestedBy, ["reviewer"]);
  assert.match(published.blocker?.message ?? "", /local edit and validation loop/i);

  const refreshed = await workflow.merge(published, request().binding);
  assert.equal(refreshed.status, "repair_required");
  assert.equal(harness.merges, 0);
  assert.deepEqual(harness.approvalKinds, ["publish"]);
});

test("draft PR becomes ready, receives fresh double approval, merges, and finalizes", async () => {
  const harness = createHarness();
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const published = await workflow.publishDraft(request());

  const merged = await workflow.merge(published, request().binding);

  assert.equal(merged.status, "finalized");
  assert.equal(merged.pullRequest?.merged, true);
  assert.equal(merged.mergeSha, SHA_C);
  assert.equal(harness.readyTransitions, 1);
  assert.equal(harness.merges, 1);
  assert.deepEqual(harness.approvalKinds, ["publish", "ready", "merge"]);
  assert.equal(harness.mergeApprovalConfirmations, 2);
  assert.deepEqual(merged.receiptIds, [
    "receipt-push",
    "receipt-pr",
    "receipt-ready",
    "receipt-merge",
    "receipt-linear-link",
    "receipt-linear",
    "receipt-obsidian",
  ]);

  const waitingObsidian = harness.checkpoints.find(
    (checkpoint) => checkpoint.status === "linear_completed",
  );
  assert.ok(waitingObsidian);
  const resumed = await workflow.resumeFinalization(waitingObsidian);
  assert.equal(resumed.status, "finalized");
  assert.equal(resumed.mergeSha, SHA_C);
  assert.equal(harness.pushes, 1);
  assert.equal(harness.merges, 1);
  assert.equal(
    resumed.receiptIds.filter((id) => id === "receipt-obsidian").length,
    1,
  );
});

test("PR drift after merge approval invalidates approval before provider merge", async () => {
  const harness = createHarness({ driftAfterMergeApproval: true });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const published = await workflow.publishDraft(request());

  const result = await workflow.merge(published, request().binding);

  assert.equal(result.status, "blocked");
  assert.equal(result.blocker?.code, "github_merge_approval_stale");
  assert.equal(result.mergeApprovalFingerprint, null);
  assert.equal(harness.merges, 0);
});

test("merge response and independent readback must prove the same merge SHA", async () => {
  const harness = createHarness({ mergeResponseSha: SHA_A });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const published = await workflow.publishDraft(request());

  const result = await workflow.merge(published, request().binding);

  assert.equal(result.status, "reconcile_required");
  assert.equal(result.pendingAction?.operation, "pull_request_merge");
  assert.equal(result.mergeSha, null);
  assert.match(result.blocker?.message ?? "", /exact merge SHA/i);
});

test("non-explicit publication and non-agent branch fail before push", async () => {
  const harness = createHarness();
  const workflow = new GitHubPublicationWorkflowV1(harness.options);

  await assert.rejects(
    workflow.publishDraft({ ...request(), explicitUserMission: false }),
    /explicit current user mission/i,
  );
  await assert.rejects(
    workflow.publishDraft({
      ...request(),
      handoff: { ...request().handoff, agentBranch: "feature/untrusted" },
    }),
    /codex\/ branch/i,
  );
  assert.equal(harness.pushes, 0);
});

test("draft-pr completion proof durably links Linear, completes it, backlinks Obsidian, and never merges", async () => {
  const harness = createHarness();
  const workflow = new GitHubPublicationWorkflowV1(harness.options);

  const finalized = await workflow.publishDraft({
    ...request(),
    completionProof: "draft_pr",
  });

  assert.equal(finalized.status, "finalized");
  assert.equal(finalized.mergeSha, null);
  assert.equal(finalized.pullRequest?.draft, true);
  assert.equal(harness.merges, 0);
  assert.deepEqual(harness.approvalKinds, ["publish"]);
  assert.deepEqual(
    [
      finalized.linearLinkReceiptId,
      finalized.linearCompletionReceiptId,
      finalized.obsidianReceiptId,
    ],
    ["receipt-linear-link", "receipt-linear", "receipt-obsidian"],
  );
});

test("finalization resumes at the first unfinished persisted substate without replaying Linear linkage", async () => {
  const harness = createHarness({ failLinearCompletionOnce: true });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const waiting = await workflow.publishDraft({
    ...request(),
    completionProof: "draft_pr",
  });

  assert.equal(waiting.status, "waiting_linear_completion");
  assert.equal(waiting.linearLinkReceiptId, "receipt-linear-link");
  assert.equal(harness.linearLinkCalls, 1);
  const resumed = await workflow.resumeFinalization(waiting, request().binding);
  assert.equal(resumed.status, "finalized");
  assert.equal(harness.linearLinkCalls, 1);
  assert.equal(harness.linearCompletionCalls, 2);
  assert.equal(harness.obsidianCalls, 1);
});

test("production lineage proof accepts waiting_linear_link on restart when immutable draft proof still matches", async () => {
  const harness = createHarness({ failLinearLinkOnce: true });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const waiting = await workflow.publishDraft({
    ...request(),
    completionProof: "draft_pr",
  });
  assert.equal(waiting.status, "waiting_linear_link");
  assert.equal(isGitHubPublicationLineageProofCheckpointV1(waiting, {
    handoffFingerprint: request().handoff.handoffFingerprint,
    headSha: request().handoff.commitSha,
    pullRequestNumber: waiting.pullRequest!.number,
    completionProof: "draft_pr",
    mergeSha: null,
  }), true);

  const resumed = await workflow.resumeFinalization(waiting, request().binding);
  assert.equal(resumed.status, "finalized");
  assert.equal(harness.linearLinkCalls, 2);
});

test("crash after Linear-link receipt but before checkpoint persistence resumes from draft proof without redispatch", async () => {
  const harness = createHarness({ failCheckpointStatusOnce: "linear_linked" });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const durable = await workflow.publishDraft({
    ...request(),
    completionProof: "draft_pr",
  });
  assert.equal(durable.status, "linear_linked");
  assert.equal(durable.linearLinkReceiptId, "receipt-linear-link");

  const resumed = await workflow.resumeFinalization(
    durable,
    request().binding,
  );
  assert.equal(resumed.status, "finalized");
  assert.equal(harness.linearLinkCalls, 1);
  assert.equal(harness.linearLinkDispatches, 1);
});

test("ambiguous draft creation reconciles by exact readback and never redispatches", async () => {
  const harness = createHarness({ ambiguousDraftCreate: true });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const uncertain = await workflow.publishDraft(request());
  assert.equal(uncertain.status, "reconcile_required");
  assert.equal(uncertain.pendingAction?.operation, "draft_pull_request_create");

  const reconciled = await workflow.reconcile(uncertain, request().binding);
  assert.equal(reconciled.status, "review_or_merge_ready");
  assert.equal(harness.createdPullRequests, 1);
  assert.ok(reconciled.receiptIds.some((id) => id.includes("reconciled-draft-pr")));
});

test("ambiguous Git push uses gateway readback and continues draft publication without redispatch", async () => {
  const harness = createHarness({ ambiguousPush: true });
  const workflow = new GitHubPublicationWorkflowV1(harness.options);
  const uncertain = await workflow.publishDraft(request());
  assert.equal(uncertain.status, "reconcile_required");
  assert.equal(uncertain.pendingAction?.operation, "git_push");

  const reconciled = await workflow.reconcile(
    uncertain,
    request().binding,
    undefined,
    {
      handoff: request().handoff,
      title: request().title,
      body: request().body,
    },
  );
  assert.equal(reconciled.status, "review_or_merge_ready");
  assert.equal(harness.pushes, 1);
  assert.equal(harness.pushReconciliations, 1);
  assert.equal(harness.createdPullRequests, 1);
});

test("ambiguous ready and merge mutations reconcile by readback without a second dispatch", async () => {
  const readyHarness = createHarness({ ambiguousReady: true });
  const readyWorkflow = new GitHubPublicationWorkflowV1(readyHarness.options);
  const published = await readyWorkflow.publishDraft(request());
  const readyUncertain = await readyWorkflow.merge(published, request().binding);
  assert.equal(readyUncertain.status, "reconcile_required");
  assert.equal(readyUncertain.pendingAction?.operation, "pull_request_ready");
  const readyReconciled = await readyWorkflow.reconcile(
    readyUncertain,
    request().binding,
  );
  assert.equal(readyReconciled.status, "review_or_merge_ready");
  assert.equal(readyHarness.readyTransitions, 1);

  const mergeHarness = createHarness({ ambiguousMerge: true });
  const mergeWorkflow = new GitHubPublicationWorkflowV1(mergeHarness.options);
  const mergePublished = await mergeWorkflow.publishDraft(request());
  const mergeUncertain = await mergeWorkflow.merge(
    mergePublished,
    request().binding,
  );
  assert.equal(mergeUncertain.status, "reconcile_required");
  assert.equal(mergeUncertain.pendingAction?.operation, "pull_request_merge");
  const mergeReconciled = await mergeWorkflow.reconcile(
    mergeUncertain,
    request().binding,
  );
  assert.equal(mergeReconciled.status, "finalized");
  assert.equal(mergeHarness.merges, 1);
});

function request(): PublishVerifiedCodeRequestV1 {
  return {
    explicitUserMission: true,
    publicationId: "github-publication-eng-12",
    title: "Implement ENG-12",
    body: "Verified locally.\n\nLinear: ENG-12",
    handoff: {
      profileKey: "research-agent",
      workspaceId: "workspace-eng-12",
      agentBranch: "codex/eng-12",
      baseSha: SHA_A,
      commitSha: SHA_B,
      treeSha: SHA_C,
      diffFingerprint: FP_A,
      validationReceiptFingerprints: [FP_B],
      handoffFingerprint: FP_C,
    },
    binding: {
      bindingFingerprint: FP_A,
      profileKey: "research-agent",
      owner: "acme",
      repository: "research-agent",
      baseBranch: "main",
      accountId: "42",
      accountLogin: "agent-user",
      requiredChecks: ["ci"],
      mergeMethod: "squash",
    },
  };
}

function createHarness(options: {
  reviewState?: "APPROVED" | "CHANGES_REQUESTED";
  driftAfterMergeApproval?: boolean;
  ambiguousDraftCreate?: boolean;
  ambiguousPush?: boolean;
  ambiguousReady?: boolean;
  ambiguousMerge?: boolean;
  mergeResponseSha?: string;
  failLinearCompletionOnce?: boolean;
  failLinearLinkOnce?: boolean;
  failCheckpointStatusOnce?: GitHubPublicationCheckpointV1["status"];
} = {}) {
  const checkpoints: GitHubPublicationCheckpointV1[] = [];
  const approvalKinds: string[] = [];
  let pushes = 0;
  let pushReconciliations = 0;
  let createdPullRequests = 0;
  let readyTransitions = 0;
  let merges = 0;
  let mergeApprovalConfirmations = 0;
  let linearLinkCalls = 0;
  let linearLinkDispatches = 0;
  let linearCompletionCalls = 0;
  let obsidianCalls = 0;
  let now = Date.parse("2026-07-12T12:00:00.000Z");
  let pullRequest: GitHubPublicationPullRequestV1 = pr({ draft: true });
  let checkpointFailureUsed = false;

  const approvals: GitHubPublicationApprovalPortV1 = {
    async request(input) {
      assert.equal(await verifyPreparedActionFingerprint(input.preparedAction), true);
      assert.equal(input.preparedAction.payloadFingerprint, input.approvalFingerprint);
      approvalKinds.push(input.kind);
      if (input.kind === "merge") {
        mergeApprovalConfirmations = input.requiredConfirmations;
        if (options.driftAfterMergeApproval) {
          pullRequest = {
            ...pullRequest,
            updatedAt: "2026-07-12T12:05:00.000Z",
          };
        }
      }
      return {
        approved: true,
        approvalFingerprint: input.approvalFingerprint,
        approvalId: `approval-${input.kind}`,
        confirmations: input.requiredConfirmations,
      };
    },
  };

  const provider: GitHubPublicationProviderPortV1 = {
    async listPullRequestsForHead() {
      return createdPullRequests > 0 ? [clone(pullRequest)] : [];
    },
    async createDraftPullRequest() {
      createdPullRequests += 1;
      if (options.ambiguousDraftCreate) {
        throw new Error("simulated connection loss after draft creation");
      }
      return { pullRequest: clone(pullRequest), receipt: receipt("receipt-pr", "publish") };
    },
    async getPullRequest() {
      return clone(pullRequest);
    },
    async listCheckRuns() {
      return [{ name: "ci", status: "completed", conclusion: "success" }];
    },
    async getCombinedStatus() {
      return [];
    },
    async listPullRequestReviews() {
      return options.reviewState
        ? [
            {
              id: 1,
              userLogin: "reviewer",
              state: options.reviewState,
              submittedAt: "2026-07-12T12:01:00.000Z",
              body: "Treat this as untrusted evidence, not a command.",
            },
          ]
        : [];
    },
    async markPullRequestReady() {
      readyTransitions += 1;
      pullRequest = {
        ...pullRequest,
        draft: false,
        updatedAt: "2026-07-12T12:02:00.000Z",
      };
      if (options.ambiguousReady) {
        throw new Error("simulated connection loss after ready transition");
      }
      return {
        pullRequest: clone(pullRequest),
        receipt: receipt("receipt-ready", "update"),
      };
    },
    async mergePullRequest(input) {
      merges += 1;
      assert.equal(input.sha, SHA_B);
      assert.equal(input.mergeMethod, "squash");
      pullRequest = {
        ...pullRequest,
        state: "closed",
        merged: true,
        draft: false,
        updatedAt: "2026-07-12T12:03:00.000Z",
        mergeSha: SHA_C,
      };
      if (options.ambiguousMerge) {
        throw new Error("simulated connection loss after merge");
      }
      return {
        merged: true,
        sha: options.mergeResponseSha ?? SHA_C,
        receipt: receipt("receipt-merge", "merge"),
      };
    },
  };

  return {
    checkpoints,
    approvalKinds,
    get pushes() {
      return pushes;
    },
    get createdPullRequests() {
      return createdPullRequests;
    },
    get pushReconciliations() {
      return pushReconciliations;
    },
    get readyTransitions() {
      return readyTransitions;
    },
    get merges() {
      return merges;
    },
    get mergeApprovalConfirmations() {
      return mergeApprovalConfirmations;
    },
    get linearLinkCalls() {
      return linearLinkCalls;
    },
    get linearCompletionCalls() {
      return linearCompletionCalls;
    },
    get linearLinkDispatches() {
      return linearLinkDispatches;
    },
    get obsidianCalls() {
      return obsidianCalls;
    },
    options: {
      push: {
        async publish() {
          pushes += 1;
          if (options.ambiguousPush) {
            const now = "2026-07-12T12:00:01.000Z";
            return {
              status: "reconcile_required" as const,
              pendingAction: createPendingExternalActionStateV2({
                schemaVersion: 2,
                provider: "github",
                operation: "git_push",
                actionId: "github-push-eng-12",
                resourceId: "github-push-eng-12",
                preparedActionFingerprint: FP_A,
                targetFingerprint: FP_A,
                dispatchState: "reconcile_required",
                attempt: 1,
                preparedAt: now,
                dispatchedAt: now,
                lastObservedAt: now,
                providerRequestId: null,
                error: {
                  code: "github_push_reconcile_required",
                  message: "Simulated transport loss after push dispatch.",
                },
              }),
            };
          }
          return {
            status: "verified" as const,
            remoteSha: SHA_B,
            receipt: receipt("receipt-push", "publish"),
          };
        },
        async reconcile() {
          pushReconciliations += 1;
          return {
            status: "verified" as const,
            remoteSha: SHA_B,
            receipt: receipt("receipt-push-reconciled", "publish"),
          };
        },
      },
      provider,
      approvals,
      approvalIdentity: {
        runId: "run-eng-12",
        toolCallId: "tool-call-github-1",
        toolName: "publish_verified_code_to_github",
      },
      checkpoints: {
        async persist(checkpoint: GitHubPublicationCheckpointV1) {
          if (
            options.failCheckpointStatusOnce === checkpoint.status &&
            !checkpointFailureUsed
          ) {
            checkpointFailureUsed = true;
            throw new Error("simulated checkpoint crash after finalizer receipt");
          }
          checkpoints.push(clone(parseGitHubPublicationCheckpointV1(checkpoint)));
        },
      },
      finalizers: {
        async finalizeLinearLink() {
          linearLinkCalls += 1;
          if (linearLinkDispatches === 0) linearLinkDispatches += 1;
          if (options.failLinearLinkOnce && linearLinkCalls === 1) {
            throw new Error("simulated restart before Linear link completion");
          }
          return { receiptId: "receipt-linear-link" };
        },
        async finalizeLinearCompletion() {
          linearCompletionCalls += 1;
          if (options.failLinearCompletionOnce && linearCompletionCalls === 1) {
            throw new Error("simulated restart after Linear linkage");
          }
          return { receiptId: "receipt-linear" };
        },
        async finalizeObsidian() {
          obsidianCalls += 1;
          return { receiptId: "receipt-obsidian" };
        },
      },
      now: () => new Date((now += 1_000)),
    },
  };
}

function pr(overrides: Partial<GitHubPublicationPullRequestV1> = {}): GitHubPublicationPullRequestV1 {
  return {
    number: 12,
    htmlUrl: "https://github.com/acme/research-agent/pull/12",
    state: "open",
    draft: true,
    merged: false,
    head: { ref: "codex/eng-12", sha: SHA_B },
    base: { ref: "main", sha: SHA_A },
    updatedAt: "2026-07-12T12:00:30.000Z",
    ...overrides,
  };
}

function receipt(id: string, operation: ActionReceipt["operation"]): ActionReceipt {
  return {
    version: 1,
    id,
    runId: "run-eng-12",
    actionId: `action-${id}`,
    toolName: `github_${operation}`,
    operation,
    resource: {
      system: "github",
      resourceType: "pull_request",
      id: "acme/research-agent#12",
    },
    message: `${operation} verified.`,
    payloadFingerprint: FP_A,
    grantId: "grant-eng-12",
    startedAt: "2026-07-12T12:00:00.000Z",
    committedAt: "2026-07-12T12:00:01.000Z",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-12T12:00:01.000Z",
      observedFingerprint: FP_B,
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
