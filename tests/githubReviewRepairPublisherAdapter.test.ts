import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createVerifiedCodePublicationHandoffV1,
  type VerifiedCodePublicationHandoffV1,
  type VerifiedLocalCommitForPublicationV1,
} from "../packages/core-api/src/verifiedCodePublicationHandoffV1";
import type { ActionReceipt } from "../src/agent/actions";
import { createPendingExternalActionStateV2 } from "../src/integrations/PendingExternalActionStateV2";
import {
  GitHubPublicationCheckpointStoreV1,
  type GitHubPublicationCheckpointNamespaceV1,
} from "../src/integrations/github/GitHubPublicationCheckpointStore";
import {
  GitHubPublicationWorkflowV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationProviderPortV1,
  type GitHubPublicationPullRequestV1,
  type TrustedGitHubPublicationBindingV1,
} from "../src/integrations/github/GitHubPublicationWorkflow";
import {
  GitHubReviewRepairPublisherAdapterV1,
} from "../src/integrations/github/GitHubReviewRepairPublisherAdapterV1";
import type { GitHubReviewRepairBindingV1 } from "../src/integrations/github/GitHubReviewRepairCoordinatorV1";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;
const FP_C = `sha256:${"c".repeat(64)}`;
const PUBLICATION_ID = "github-fixture-original";
const REPAIR_ID = "review-repair-42";

test("production review publisher advances the existing checkpoint through one verified fast-forward", async () => {
  const harness = await createHarness(false);

  const result = await harness.publisher.publishVerifiedReviewRepairFastForward({
    repairId: REPAIR_ID,
    publicationId: PUBLICATION_ID,
    binding: harness.reviewBinding,
    pullRequestNumber: 42,
    expectedRemoteHeadSha: harness.original.commitSha,
    previousHandoffFingerprint: harness.original.fingerprint,
    handoff: harness.repaired,
  });

  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  assert.equal(result.remoteSha, harness.repaired.commitSha);
  assert.deepEqual(result.receiptIds, ["receipt-review-push"]);
  assert.equal(harness.pushes, 1);
  assert.equal(harness.reconciliations, 0);
  const checkpoint = await harness.store.get(PUBLICATION_ID);
  assert.equal(checkpoint?.status, "draft_pr_verified");
  assert.equal(checkpoint?.headSha, harness.repaired.commitSha);
  assert.equal(checkpoint?.remoteSha, harness.repaired.commitSha);
  assert.equal(checkpoint?.handoffFingerprint, harness.repaired.fingerprint);
  assert.equal(checkpoint?.repairBaseSha, harness.original.commitSha);
  assert.equal(checkpoint?.repairId, REPAIR_ID);
  assert.equal(checkpoint?.repairPullRequestNumber, 42);
  assert.equal(checkpoint?.pullRequest?.head.sha, harness.repaired.commitSha);
  assert.deepEqual(checkpoint?.receiptIds, ["receipt-original-push", "receipt-review-push"]);
});

test("ambiguous review fast-forward restarts through gateway reconciliation without redispatch", async () => {
  const harness = await createHarness(true);

  const uncertain = await harness.publisher.publishVerifiedReviewRepairFastForward({
    repairId: REPAIR_ID,
    publicationId: PUBLICATION_ID,
    binding: harness.reviewBinding,
    pullRequestNumber: 42,
    expectedRemoteHeadSha: harness.original.commitSha,
    previousHandoffFingerprint: harness.original.fingerprint,
    handoff: harness.repaired,
  });
  assert.equal(uncertain.status, "reconcile_required");
  assert.equal((await harness.store.get(PUBLICATION_ID))?.status, "reconcile_required");

  const reconciled = await harness.publisher.reconcileVerifiedReviewRepairFastForward({
    repairId: REPAIR_ID,
    publicationId: PUBLICATION_ID,
    binding: harness.reviewBinding,
    pullRequestNumber: 42,
    expectedOldHeadSha: harness.original.commitSha,
    expectedNewHeadSha: harness.repaired.commitSha,
    handoffFingerprint: harness.repaired.fingerprint,
    handoff: harness.repaired,
  });

  assert.equal(reconciled.status, "verified");
  assert.equal(harness.pushes, 1);
  assert.equal(harness.reconciliations, 1);
  assert.equal((await harness.store.get(PUBLICATION_ID))?.status, "draft_pr_verified");
  if (reconciled.status === "verified") {
    assert.deepEqual(reconciled.receiptIds, ["receipt-review-push-reconciled"]);
  }
});

test("checkpoint store rejects an unbound publication-head rewrite", async () => {
  const harness = await createHarness(false);
  const current = await harness.store.get(PUBLICATION_ID);
  assert.ok(current);
  await assert.rejects(
    harness.store.persist({
      ...current,
      status: "push_prepared",
      updatedAt: "2026-07-13T12:20:00.000Z",
      headSha: SHA_C,
      handoffFingerprint: FP_C,
      remoteSha: null,
      pullRequest: null,
    }),
    /review-repair epoch|immutable/i,
  );
});

for (const approvalMode of ["denied", "stale"] as const) {
  test(`${approvalMode} review fast-forward approval performs zero pushes`, async () => {
    const harness = await createHarness(false, approvalMode);

    const result = await harness.publisher.publishVerifiedReviewRepairFastForward({
      repairId: REPAIR_ID,
      publicationId: PUBLICATION_ID,
      binding: harness.reviewBinding,
      pullRequestNumber: 42,
      expectedRemoteHeadSha: harness.original.commitSha,
      previousHandoffFingerprint: harness.original.fingerprint,
      handoff: harness.repaired,
    });

    assert.equal(result.status, "blocked");
    assert.equal(harness.approvals, 1);
    assert.equal(harness.pushes, 0);
    assert.equal(harness.reconciliations, 0);
    assert.equal((await harness.store.get(PUBLICATION_ID))?.status, "repair_required");
  });
}

async function createHarness(
  ambiguous: boolean,
  approvalMode: "exact" | "denied" | "stale" = "exact",
) {
  const original = handoff(false);
  const repaired = handoff(true);
  const persistence = memoryPersistence();
  const store = new GitHubPublicationCheckpointStoreV1(persistence);
  let pullRequest = pr(original.commitSha);
  let pushes = 0;
  let reconciliations = 0;
  let approvals = 0;
  let now = Date.parse("2026-07-13T12:10:00.000Z");
  const workflowBinding: TrustedGitHubPublicationBindingV1 = {
    bindingFingerprint: FP_A,
    profileKey: "fixture",
    owner: "acme",
    repository: "fixture",
    baseBranch: "main",
    accountId: "42",
    accountLogin: "agent-user",
    requiredChecks: ["ci"],
    mergeMethod: "squash",
  };
  const reviewBinding: GitHubReviewRepairBindingV1 = {
    bindingFingerprint: FP_A,
    profileKey: "fixture",
    owner: "acme",
    repository: "fixture",
    baseBranch: "main",
    accountId: "42",
    accountLogin: "agent-user",
  };
  await store.persist(initialCheckpoint(original, pullRequest));

  const provider: GitHubPublicationProviderPortV1 = {
    async listPullRequestsForHead() { return [clone(pullRequest)]; },
    async createDraftPullRequest() { throw new Error("not used"); },
    async getPullRequest() { return clone(pullRequest); },
    async listCheckRuns() { return []; },
    async getCombinedStatus() { return []; },
    async listPullRequestReviews() { return []; },
    async markPullRequestReady() { throw new Error("not used"); },
    async mergePullRequest() { throw new Error("not used"); },
  };
  const workflow = new GitHubPublicationWorkflowV1({
    provider,
    checkpoints: store,
    approvals: {
      async request(input) {
        approvals += 1;
        if (approvalMode === "denied") {
          return { approved: false, approvalFingerprint: input.approvalFingerprint };
        }
        return {
          approved: true,
          approvalFingerprint:
            approvalMode === "stale" ? FP_B : input.approvalFingerprint,
          confirmations: 1,
        };
      },
    },
    approvalIdentity: {
      runId: "run-42",
      toolCallId: "review-repair-42",
      toolName: "github_review_repair",
    },
    push: {
      async publish(input) {
        pushes += 1;
        assert.equal(input.handoff.commitSha, repaired.commitSha);
        assert.equal(input.handoff.baseSha, original.commitSha);
        pullRequest = {
          ...pullRequest,
          head: { ...pullRequest.head, sha: repaired.commitSha },
          updatedAt: "2026-07-13T12:12:00.000Z",
        };
        if (ambiguous) {
          const timestamp = "2026-07-13T12:11:00.000Z";
          return {
            status: "reconcile_required" as const,
            pendingAction: createPendingExternalActionStateV2({
              schemaVersion: 2,
              provider: "github",
              operation: "git_push",
              actionId: "review-push-attempt-42",
              resourceId: "review-push-attempt-42",
              preparedActionFingerprint: input.approvalFingerprint,
              targetFingerprint: FP_A,
              dispatchState: "reconcile_required",
              attempt: 1,
              preparedAt: timestamp,
              dispatchedAt: timestamp,
              lastObservedAt: timestamp,
              providerRequestId: null,
              error: { code: "transport_lost", message: "Readback required." },
            }),
          };
        }
        return {
          status: "verified" as const,
          remoteSha: repaired.commitSha,
          receipt: receipt("receipt-review-push"),
        };
      },
      async reconcile(input) {
        reconciliations += 1;
        assert.equal(input.handoff.commitSha, repaired.commitSha);
        return {
          status: "verified" as const,
          remoteSha: repaired.commitSha,
          receipt: receipt("receipt-review-push-reconciled"),
        };
      },
    },
    now: () => new Date((now += 1_000)),
  });
  const publisher = new GitHubReviewRepairPublisherAdapterV1(store, {
    async create(input) {
      assert.equal(input.handoff.fingerprint, repaired.fingerprint);
      return { workflow, binding: workflowBinding };
    },
  });
  return {
    original,
    repaired,
    reviewBinding,
    store,
    publisher,
    get pushes() { return pushes; },
    get reconciliations() { return reconciliations; },
    get approvals() { return approvals; },
  };
}

function initialCheckpoint(
  original: VerifiedCodePublicationHandoffV1,
  pullRequest: GitHubPublicationPullRequestV1,
): GitHubPublicationCheckpointV1 {
  return {
    version: 1,
    publicationId: PUBLICATION_ID,
    status: "repair_required",
    updatedAt: "2026-07-13T12:00:00.000Z",
    handoffFingerprint: original.fingerprint,
    bindingFingerprint: FP_A,
    headSha: original.commitSha,
    branch: original.branch,
    remoteSha: original.commitSha,
    mergeSha: null,
    pullRequest,
    proofSnapshot: null,
    publishApprovalFingerprint: FP_B,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: "merged_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: ["receipt-original-push"],
    pendingAction: null,
    blocker: {
      code: "github_review_repair_required",
      message: "Review changes require local repair.",
    },
    repairBaseSha: null,
    repairId: null,
    repairPullRequestNumber: null,
  };
}

function handoff(repaired: boolean): VerifiedCodePublicationHandoffV1 {
  const baseSha = repaired ? SHA_B : SHA_A;
  const commitSha = repaired ? SHA_C : SHA_B;
  const evidence = {
    requestId: repaired ? "review-repair-request" : "original-request",
    runId: "run-42",
    worktreeId: "worktree-42",
    workspaceId: "workspace-42",
    branch: "codex/repair-42",
    baseSha,
    commitSha,
    parentSha: baseSha,
    treeSha: repaired ? SHA_D : SHA_C,
    diffFingerprint: repaired ? FP_C : FP_A,
    changedPaths: ["src/fix.ts"],
    artifactHashes: [{ path: "src/fix.ts", sha256: repaired ? FP_C : FP_A, bytes: 42 }],
    changedArtifacts: [{ path: "src/fix.ts", sha256: repaired ? FP_C : FP_A }],
    targetedValidationReceiptId: repaired ? "targeted-repair" : "targeted-original",
    fullValidationReceiptId: repaired ? "full-repair" : "full-original",
    targetedValidationFingerprint: repaired ? FP_B : FP_A,
    fullValidationFingerprint: repaired ? FP_C : FP_B,
    committedAt: repaired ? "2026-07-13T12:08:00.000Z" : "2026-07-13T11:58:00.000Z",
  };
  const localCommit: VerifiedLocalCommitForPublicationV1 = {
    version: 1,
    kind: "verified_local_commit",
    id: repaired ? "verified-commit-repair" : "verified-commit-original",
    status: "verified",
    ...evidence,
    fingerprint: hash(evidence),
  };
  return createVerifiedCodePublicationHandoffV1({
    id: repaired ? "handoff-review-repair" : "handoff-original",
    repositoryProfileKey: "fixture",
    repositoryProfileFingerprint: FP_A,
    canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-42",
    baseBranch: "main",
    localCommit,
    preparedAt: repaired ? "2026-07-13T12:09:00.000Z" : "2026-07-13T11:59:00.000Z",
  });
}

function pr(headSha: string): GitHubPublicationPullRequestV1 {
  return {
    number: 42,
    htmlUrl: "https://github.com/acme/fixture/pull/42",
    state: "open",
    draft: false,
    merged: false,
    head: { ref: "codex/repair-42", sha: headSha },
    base: { ref: "main", sha: SHA_A },
    updatedAt: "2026-07-13T12:00:00.000Z",
  };
}

function receipt(id: string): ActionReceipt {
  return {
    version: 1,
    id,
    runId: "run-42",
    actionId: id,
    toolName: "github_review_repair",
    operation: "publish",
    resource: { system: "github", resourceType: "repository_branch", id: "codex/repair-42" },
    message: "Verified review-repair push.",
    payloadFingerprint: FP_A,
    grantId: "review-repair-authority",
    startedAt: "2026-07-13T12:10:00.000Z",
    committedAt: "2026-07-13T12:11:00.000Z",
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-07-13T12:11:00.000Z",
      observedRevision: SHA_C,
      observedFingerprint: FP_C,
    },
  };
}

function memoryPersistence() {
  let namespace: GitHubPublicationCheckpointNamespaceV1 | null = null;
  return {
    async read() { return clone(namespace); },
    async write(next: GitHubPublicationCheckpointNamespaceV1, expectedRevision: number) {
      if ((namespace?.revision ?? 0) !== expectedRevision) return false;
      namespace = clone(next);
      return true;
    },
  };
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
