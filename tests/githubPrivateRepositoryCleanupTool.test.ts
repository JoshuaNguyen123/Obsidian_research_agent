import assert from "node:assert/strict";
import test from "node:test";

import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { createTrustedGitHubRepositoryBindingV2 } from "../src/integrations/github/TrustedGitHubRepositoryBindingV2";
import type { ActionReceipt } from "../src/agent/actions";
import {
  createGitHubPrivateRepositoryCleanupTool,
  hasExplicitPrivateGitHubRepositoryCleanupIntent,
  parseGitHubPrivateRepositoryCleanupCheckpointMapV1,
  type GitHubPrivateRepositoryCleanupCheckpointV1,
} from "../src/tools/githubPrivateRepositoryCleanupTool";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = new Date("2026-07-16T18:00:00.000Z");

test("private repository cleanup checkpoints, deletes once, and verifies absence", async () => {
  const checkpoints: GitHubPrivateRepositoryCleanupCheckpointV1[] = [];
  const receipts: ActionReceipt[] = [];
  let present = true;
  let deleteCount = 0;
  const tool = createGitHubPrivateRepositoryCleanupTool({
    resolveBinding: async () => binding(),
    readRepository: async () => (present ? repository() : null),
    deleteRepository: async () => {
      assert.equal(checkpoints.at(-1)?.status, "reconcile_required");
      deleteCount += 1;
      present = false;
    },
    getCheckpoint: async (id) =>
      checkpoints.slice().reverse().find((item) => item.cleanupId === id) ?? null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    persistExternalReceipt: async (receipt) => {
      receipts.push(receipt);
    },
    now: () => NOW,
  });

  const result = await tool.executeResult!(
    { profileKey: "fixture" },
    context(async (request) => ({
      approved: true,
      approvalId: "approval-private-delete",
      approvalFingerprint: request.preparedAction!.payloadFingerprint,
    })),
  );

  assert.equal(result.ok, true);
  assert.equal(deleteCount, 1);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.status),
    ["prepared", "reconcile_required", "verified"],
  );
  assert.equal(receipts[0]?.operation, "delete");
  assert.equal(receipts[0]?.readback.status, "verified");
  assert.equal(receipts[0]?.commitKind, "committed");
});

test("private repository cleanup reconciles prior absence without approval or delete", async () => {
  let deleteCount = 0;
  let approvalCount = 0;
  const checkpoints: GitHubPrivateRepositoryCleanupCheckpointV1[] = [];
  const tool = createGitHubPrivateRepositoryCleanupTool({
    resolveBinding: async () => binding(),
    readRepository: async () => null,
    deleteRepository: async () => {
      deleteCount += 1;
    },
    getCheckpoint: async () => null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint);
    },
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });

  const result = await tool.executeResult!(
    { profileKey: "fixture" },
    context(async () => {
      approvalCount += 1;
      throw new Error("approval must not run");
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(deleteCount, 0);
  assert.equal(approvalCount, 0);
  assert.equal(result.receipt?.commitKind, "reconciled");
  assert.equal(checkpoints.at(-1)?.status, "verified");
});

test("private repository cleanup blocks mismatched or public readback before approval", async () => {
  let deleteCount = 0;
  let approvalCount = 0;
  const tool = createGitHubPrivateRepositoryCleanupTool({
    resolveBinding: async () => binding(),
    readRepository: async () => ({ ...repository(), private: false }),
    deleteRepository: async () => {
      deleteCount += 1;
    },
    getCheckpoint: async () => null,
    persistCheckpoint: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });

  await assert.rejects(
    tool.executeResult!(
      { profileKey: "fixture" },
      context(async () => {
        approvalCount += 1;
        throw new Error("approval must not run");
      }),
    ),
    /does not match the exact active private binding/iu,
  );
  assert.equal(deleteCount, 0);
  assert.equal(approvalCount, 0);
});

test("cleanup intent honors negation and corrupt checkpoints are quarantined", () => {
  assert.equal(
    hasExplicitPrivateGitHubRepositoryCleanupIntent(
      "Delete the private GitHub repository after verifying cleanup.",
    ),
    true,
  );
  assert.equal(
    hasExplicitPrivateGitHubRepositoryCleanupIntent(
      "Keep the private GitHub repository; do not delete it.",
    ),
    false,
  );
  assert.deepEqual(
    parseGitHubPrivateRepositoryCleanupCheckpointMapV1({
      corrupt: { version: 1, cleanupId: "corrupt" },
    }),
    {},
  );
});

function binding() {
  return createTrustedGitHubRepositoryBindingV2({
    key: "fixture-binding",
    profile: detectRepositoryProfileV2({
      key: "fixture",
      displayName: "Fixture",
      repositoryRoot: "C:\\repos\\fixture",
      defaultBranch: "main",
      files: ["package.json", "package-lock.json"],
      requiredGitHubChecks: ["ci"],
    }),
    owner: "acme",
    repository: "private-agent",
    repositoryReadback: repository(),
    observedAt: NOW.toISOString(),
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-16T17:00:00.000Z",
  });
}

function repository() {
  return {
    id: 101,
    fullName: "acme/private-agent",
    htmlUrl: "https://github.com/acme/private-agent",
    defaultBranch: "main",
    private: true,
    archived: false,
  };
}

function context(
  requestNestedApproval: NonNullable<ToolExecutionContext["requestNestedApproval"]>,
): ToolExecutionContext {
  return {
    app: {} as never,
    settings: {} as never,
    originalPrompt:
      "Delete the private GitHub repository after verifying exact cleanup.",
    runId: "run-private-repository-cleanup",
    operationId: "tool-private-repository-cleanup",
    httpTransport: async () => {
      throw new Error("not used");
    },
    requestNestedApproval,
    now: () => NOW,
  };
}
