import assert from "node:assert/strict";
import test from "node:test";

import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import type { ActionReceipt } from "../src/agent/actions";
import {
  createGitHubPrivateRepositoryTool,
  hasExplicitPrivateGitHubRepositoryCreationIntent,
  type GitHubPrivateRepositoryCheckpointV1,
  type GitHubPrivateRepositoryDestinationV1,
} from "../src/tools/githubPrivateRepositoryTool";
import type { ToolExecutionContext } from "../src/tools/types";

const NOW = new Date("2026-07-16T16:00:00.000Z");

test("private repository creation checkpoints before dispatch and accepts only independent private readback", async () => {
  const checkpoints: GitHubPrivateRepositoryCheckpointV1[] = [];
  const bindings: string[] = [];
  const receipts: ActionReceipt[] = [];
  let readCount = 0;
  let createCount = 0;
  let approvedActionId = "";
  const tool = createGitHubPrivateRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => ++readCount === 1 ? null : repository(true),
    createPrivateRepository: async (resolved, description) => {
      createCount += 1;
      assert.equal(checkpoints.at(-1)?.status, "reconcile_required");
      assert.equal(resolved.ownerKind, "organization");
      assert.equal(description, "Daily use fixture");
      return repository(true);
    },
    getCheckpoint: async (id) =>
      checkpoints.slice().reverse().find((item) => item.creationId === id) ?? null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    persistBinding: async (binding) => {
      bindings.push(binding.fingerprint);
    },
    persistExternalReceipt: async (receipt) => {
      receipts.push(receipt);
    },
    now: () => NOW,
  });
  const result = await tool.executeResult!({
    profileKey: "fixture",
    description: "Daily use fixture",
  }, context(async (request) => {
    approvedActionId = request.preparedAction!.id;
    assert.deepEqual(
      {
        visibility: request.preparedAction!.normalizedArgs.visibility,
        private: request.preparedAction!.normalizedArgs.private,
      },
      { visibility: "private", private: true },
    );
    return {
      approved: true,
      approvalId: "approval-private-create",
      approvalFingerprint: request.preparedAction!.payloadFingerprint,
    };
  }));

  assert.equal(result.ok, true);
  assert.equal(createCount, 1);
  assert.equal(readCount, 2, "precondition and independent post-create readback both run");
  assert.equal(approvedActionId, "github-private-fixture");
  assert.deepEqual(checkpoints.map((item) => item.status), [
    "prepared",
    "reconcile_required",
    "verified",
  ]);
  assert.equal(bindings.length, 1);
  assert.equal(receipts[0]?.readback.status, "verified");
  assert.equal(receipts[0]?.resource.resourceType, "private_repository");
});

test("existing public repository is blocked and never converted or approved", async () => {
  let createCount = 0;
  let approvalCount = 0;
  const checkpoints: GitHubPrivateRepositoryCheckpointV1[] = [];
  const tool = createGitHubPrivateRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => repository(false),
    createPrivateRepository: async () => {
      createCount += 1;
      return repository(true);
    },
    getCheckpoint: async () => null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint);
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });

  await assert.rejects(
    tool.executeResult!({ profileKey: "fixture" }, context(async () => {
      approvalCount += 1;
      throw new Error("approval must not run");
    })),
    /Public repositories are never converted automatically/iu,
  );
  assert.equal(createCount, 0);
  assert.equal(approvalCount, 0);
  assert.equal(checkpoints.at(-1)?.status, "blocked");
});

test("ambiguous creation resumes through readback without redispatch", async () => {
  let checkpoint: GitHubPrivateRepositoryCheckpointV1 | null = null;
  let createCount = 0;
  let readCount = 0;
  let providerRecovered = false;
  const tool = createGitHubPrivateRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => {
      readCount += 1;
      if (!providerRecovered) {
        if (readCount === 1) return null;
        throw new Error("transport interrupted after provider accepted create");
      }
      return repository(true);
    },
    createPrivateRepository: async () => {
      createCount += 1;
      return repository(true);
    },
    getCheckpoint: async () => checkpoint,
    persistCheckpoint: async (next) => {
      checkpoint = structuredClone(next);
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });
  const approval = async (request: Parameters<NonNullable<ToolExecutionContext["requestNestedApproval"]>>[0]) => ({
    approved: true as const,
    approvalId: "approval-private-create",
    approvalFingerprint: request.preparedAction!.payloadFingerprint,
  });
  await assert.rejects(
    tool.executeResult!({ profileKey: "fixture" }, context(approval)),
    /transport interrupted/iu,
  );
  assert.equal(
    (checkpoint as GitHubPrivateRepositoryCheckpointV1 | null)?.status,
    "reconcile_required",
  );
  providerRecovered = true;
  const result = await tool.executeResult!({ profileKey: "fixture" }, context(approval));
  assert.equal(result.ok, true);
  assert.equal(createCount, 1, "resume performs readback only");
  assert.equal(result.receipt?.commitKind, "reconciled");
});

test("private repository intent honors explicit negation", () => {
  assert.equal(
    hasExplicitPrivateGitHubRepositoryCreationIntent(
      "Create a private GitHub repository for this project.",
    ),
    true,
  );
  assert.equal(
    hasExplicitPrivateGitHubRepositoryCreationIntent(
      "Do not create a GitHub repository; only describe the setup.",
    ),
    false,
  );
});

function destination(): GitHubPrivateRepositoryDestinationV1 {
  return {
    ownerKind: "organization",
    owner: "acme",
    repository: "private-agent",
    profile: detectRepositoryProfileV2({
      key: "fixture",
      displayName: "Fixture",
      repositoryRoot: "C:\\repos\\fixture",
      defaultBranch: "main",
      files: ["package.json", "package-lock.json"],
      requiredGitHubChecks: ["ci"],
    }),
    accountId: 202,
    accountLogin: "agent-owner",
    trustedAt: "2026-07-16T14:00:00.000Z",
  };
}

function repository(privateVisibility: boolean) {
  return {
    id: 101,
    fullName: "acme/private-agent",
    htmlUrl: "https://github.com/acme/private-agent",
    defaultBranch: "main",
    private: privateVisibility,
    archived: false,
  };
}

function context(
  requestNestedApproval: NonNullable<ToolExecutionContext["requestNestedApproval"]>,
): ToolExecutionContext {
  return {
    app: {} as never,
    settings: {} as never,
    originalPrompt: "Create a private GitHub repository for this project.",
    runId: "run-private-repository",
    operationId: "tool-private-repository",
    httpTransport: async () => {
      throw new Error("not used");
    },
    requestNestedApproval,
    now: () => NOW,
  };
}
