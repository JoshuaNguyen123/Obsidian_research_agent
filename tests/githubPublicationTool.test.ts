import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createVerifiedCodePublicationHandoffV1 } from "../packages/core-api/src";
import type { VerifiedLocalCommitReceiptV1 } from "../extensions/code/repair";
import { verifyPreparedActionFingerprint } from "../src/agent/actions/canonicalize";
import type {
  GitHubPublicationCheckpointV1,
  PublishVerifiedCodeRequestV1,
} from "../src/integrations/github/GitHubPublicationWorkflow";
import {
  createGitHubPublicationTool,
  hasExplicitGitHubPublicationIntent,
} from "../src/tools/githubPublicationTool";
import type { ToolExecutionContext } from "../src/tools/types";

const GIT_A = "a".repeat(40);
const GIT_B = "b".repeat(40);
const GIT_C = "c".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

test("GitHub publication tool accepts only a logical profile and host-resolves proof", async () => {
  const handoff = verifiedHandoff();
  const persisted: string[] = [];
  let published = 0;
  const tool = createGitHubPublicationTool({
    async resolveHandoff(profileKey) {
      assert.equal(profileKey, "fixture");
      return handoff;
    },
    async resolveBinding() {
      return bindingResolution();
    },
    async getCheckpoint() {
      return null;
    },
    createWorkflow(input) {
      return {
        async publishDraft(request: PublishVerifiedCodeRequestV1) {
          published += 1;
          assert.equal(request.handoff.commitSha, GIT_B);
          assert.equal(request.binding.owner, "acme");
          const action = await preparedAction(input.approvalIdentity);
          const approval = await input.approvals.request({
            kind: "publish",
            approvalFingerprint: action.payloadFingerprint,
            preparedAction: action,
            requiredConfirmations: 1,
            summary: "Publish verified branch",
            destination: "acme/research-agent",
          });
          assert.equal(approval.approved, true);
          return checkpoint("review_or_merge_ready");
        },
      } as never;
    },
    async persistExternalReceipt(receipt) {
      persisted.push(receipt.id);
    },
  });

  const result = await tool.executeResult!({
    action: "publish_draft",
    profileKey: "fixture",
    title: "Implement ENG-12",
    body: "Verified locally and ready for review.",
  }, context());

  assert.equal(result.ok, true);
  assert.equal(result.mutationState, "applied");
  assert.equal(result.receipt?.resource.system, "github");
  assert.equal(published, 1);
  assert.equal(persisted.length, 1);
});

test("GitHub merge requests two distinct exact approval gestures", async () => {
  const handoff = verifiedHandoff();
  const durable = checkpoint("review_or_merge_ready");
  const confirmationOrdinals: number[] = [];
  const approvalIds: string[] = [];
  const tool = createGitHubPublicationTool({
    async resolveHandoff() {
      return handoff;
    },
    async resolveBinding() {
      return bindingResolution();
    },
    async getCheckpoint() {
      return durable;
    },
    createWorkflow(input) {
      return {
        async merge(value: GitHubPublicationCheckpointV1) {
          const action = await preparedAction(input.approvalIdentity, 2);
          const approval = await input.approvals.request({
            kind: "merge",
            approvalFingerprint: action.payloadFingerprint,
            preparedAction: action,
            requiredConfirmations: 2,
            summary: "Merge exact verified pull request",
            destination: "https://github.com/acme/research-agent/pull/12",
          });
          assert.equal(approval.approved, true);
          assert.equal(approval.confirmations, 2);
          assert.equal(approval.approvalId, approvalIds.join(":"));
          return {
            ...value,
            status: "finalized" as const,
            mergeSha: GIT_C,
            mergeApprovalFingerprint: action.payloadFingerprint,
            pullRequest: value.pullRequest
              ? {
                  ...value.pullRequest,
                  state: "closed" as const,
                  draft: false,
                  merged: true,
                }
              : null,
          };
        },
      } as never;
    },
    async persistExternalReceipt() {},
  });
  const mergeContext: ToolExecutionContext = {
    ...context(),
    originalPrompt: "Merge the GitHub pull request after fresh checks pass.",
    async requestNestedApproval(request) {
      assert.ok(request.preparedAction);
      assert.equal(await verifyPreparedActionFingerprint(request.preparedAction), true);
      assert.equal(request.requiredConfirmations, 2);
      const ordinal = request.confirmationIndex ?? 0;
      confirmationOrdinals.push(ordinal);
      const approvalId = `merge-approval-${ordinal}`;
      approvalIds.push(approvalId);
      return {
        approved: true,
        approvalId,
        approvalFingerprint: request.preparedAction.payloadFingerprint,
      };
    },
  };

  const result = await tool.executeResult!({
    action: "merge",
    profileKey: "fixture",
  }, mergeContext);

  assert.equal(result.ok, true);
  assert.deepEqual(confirmationOrdinals, [1, 2]);
});

test("GitHub publication tool rejects model-supplied paths or SHAs before resolution", async () => {
  let resolved = 0;
  const tool = createGitHubPublicationTool({
    async resolveHandoff() {
      resolved += 1;
      return verifiedHandoff();
    },
    async resolveBinding() {
      return bindingResolution();
    },
    async getCheckpoint() {
      return null;
    },
    createWorkflow() {
      throw new Error("must not be reached");
    },
    async persistExternalReceipt() {},
  });

  await assert.rejects(
    tool.executeResult!({
      action: "publish_draft",
      profileKey: "fixture",
      title: "Title",
      body: "Body",
      worktreePath: "C:\\untrusted",
      commitSha: GIT_B,
    }, context()),
    /closed tool contract/i,
  );
  assert.equal(resolved, 0);
});

test("publish_draft resumes draft-proof finalization from durable draft_pr_verified checkpoint", async () => {
  const durable = {
    ...checkpoint("draft_pr_verified"),
    completionProof: "draft_pr" as const,
  };
  let resumed = 0;
  const tool = createGitHubPublicationTool({
    async resolveHandoff() {
      return verifiedHandoff();
    },
    async resolveBinding() {
      return { ...bindingResolution(), completionProof: "draft_pr" as const };
    },
    async getCheckpoint() {
      return durable;
    },
    createWorkflow() {
      return {
        async resumeFinalization(value: GitHubPublicationCheckpointV1) {
          resumed += 1;
          assert.equal(value.status, "draft_pr_verified");
          return { ...value, status: "finalized" as const };
        },
      } as never;
    },
    async persistExternalReceipt() {},
  });

  const result = await tool.executeResult!({
    action: "publish_draft",
    profileKey: "fixture",
    title: "Resume exact draft proof",
    body: "Resume finalization without another provider mutation.",
  }, context());
  assert.equal(result.ok, true);
  assert.equal(resumed, 1);
});

test("GitHub publication intent is explicit and does not match ordinary GitHub reading", () => {
  assert.equal(hasExplicitGitHubPublicationIntent("Push the verified branch to GitHub and open a draft PR."), true);
  assert.equal(hasExplicitGitHubPublicationIntent("Merge the GitHub pull request after checks pass."), true);
  assert.equal(hasExplicitGitHubPublicationIntent("Read that GitHub issue and summarize it."), false);
});

function context(): ToolExecutionContext {
  return {
    app: {} as never,
    settings: {} as never,
    originalPrompt: "Push the verified code to GitHub and open a draft PR.",
    runId: "run-1",
    operationId: "tool-call-1",
    httpTransport: async () => ({ status: 500, headers: {} }),
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-07-12T12:10:00.000Z"),
    async requestNestedApproval(request) {
      assert.ok(request.preparedAction);
      assert.equal(await verifyPreparedActionFingerprint(request.preparedAction), true);
      return {
        approved: true,
        approvalId: "approval-1",
        approvalFingerprint: request.preparedAction.payloadFingerprint,
      };
    },
  };
}

async function preparedAction(identity: {
  runId: string;
  toolCallId: string;
  toolName: string;
}, requiredConfirmations: 1 | 2 = 1) {
  const { withPreparedActionFingerprint } = await import("../src/agent/actions/canonicalize");
  return withPreparedActionFingerprint({
    version: 1,
    id: "github-publish-test",
    runId: identity.runId,
    toolCallId: identity.toolCallId,
    toolName: identity.toolName,
    target: {
      system: "github",
      resourceType: "repository_branch",
      id: "acme/research-agent",
    },
    relatedResources: [],
    normalizedArgs: { profileKey: "fixture" },
    preview: {
      summary: "Publish verified branch",
      destination: "acme/research-agent",
      warnings: [],
      outboundBytes: 0,
    },
    preparedAt: "2026-07-12T12:00:00.000Z",
    expiresAt: "2026-07-12T12:02:00.000Z",
    requiredConfirmations,
  });
}

function binding() {
  return {
    bindingFingerprint: FP_A,
    profileKey: "fixture",
    owner: "acme",
    repository: "research-agent",
    baseBranch: "main",
    accountId: "42",
    accountLogin: "agent-user",
    requiredChecks: ["ci"],
    mergeMethod: "squash" as const,
  };
}

function bindingResolution() {
  return {
    workflowBinding: binding(),
    publicationBinding: {} as never,
    privateRepositoryBinding: {} as never,
    profile: {} as never,
  };
}

function checkpoint(status: GitHubPublicationCheckpointV1["status"]): GitHubPublicationCheckpointV1 {
  return {
    version: 1,
    publicationId: `github-fixture-${FP_A.slice(7, 31)}`,
    status,
    updatedAt: "2026-07-12T12:05:00.000Z",
    handoffFingerprint: verifiedHandoff().fingerprint,
    bindingFingerprint: FP_A,
    headSha: GIT_B,
    branch: "codex/repair-1",
    remoteSha: GIT_B,
    mergeSha: null,
    pullRequest: {
      number: 12,
      htmlUrl: "https://github.com/acme/research-agent/pull/12",
      state: "open",
      draft: true,
      merged: false,
      head: { ref: "codex/repair-1", sha: GIT_B },
      base: { ref: "main", sha: GIT_A },
      updatedAt: "2026-07-12T12:04:00.000Z",
    },
    proofSnapshot: null,
    publishApprovalFingerprint: FP_A,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: "merged_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: ["receipt-push"],
    pendingAction: null,
    blocker: null,
  };
}

function verifiedHandoff() {
  return createVerifiedCodePublicationHandoffV1({
    id: "handoff-1",
    repositoryProfileKey: "fixture",
    repositoryProfileFingerprint: FP_A,
    canonicalWorktreeRoot: "C:\\agent-worktrees\\repair-1",
    baseBranch: "main",
    localCommit: localCommitReceipt(),
    preparedAt: "2026-07-12T12:01:00.000Z",
  });
}

function localCommitReceipt(): VerifiedLocalCommitReceiptV1 {
  const evidence = {
    requestId: "repair-1",
    runId: "run-1",
    worktreeId: "worktree-1",
    workspaceId: "workspace-1",
    branch: "codex/repair-1",
    baseSha: GIT_A,
    commitSha: GIT_B,
    parentSha: GIT_A,
    treeSha: GIT_C,
    diffFingerprint: FP_A,
    changedPaths: ["src/fix.ts"],
    artifactHashes: [{ path: "src/fix.ts", sha256: FP_A, bytes: 42 }],
    changedArtifacts: [{ path: "src/fix.ts", sha256: FP_A }],
    targetedValidationReceiptId: "targeted-1",
    fullValidationReceiptId: "full-1",
    targetedValidationFingerprint: FP_A,
    fullValidationFingerprint: FP_B,
    committedAt: "2026-07-12T12:00:00.000Z",
  };
  return {
    version: 1,
    kind: "verified_local_commit",
    id: "verified-commit-1",
    status: "verified",
    ...evidence,
    fingerprint: hash(evidence),
  };
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
