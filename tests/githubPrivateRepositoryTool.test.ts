import assert from "node:assert/strict";
import test from "node:test";

import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import type { ActionReceipt } from "../src/agent/actions";
import {
  CREATE_GITHUB_REPOSITORY_TOOL_NAME,
  LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  createGitHubRepositoryTool,
  createGitHubPrivateRepositoryTool,
  hasGitHubRepositoryBootstrapIntent,
  hasExplicitPrivateGitHubRepositoryCreationIntent,
  hasPrivateGitHubRepositoryBootstrapIntent,
  parseGitHubPrivateRepositoryCheckpointMapV1,
  type GitHubPrivateRepositoryCheckpointV1,
  type GitHubPrivateRepositoryDestinationV1,
} from "../src/tools/githubPrivateRepositoryTool";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import type { ToolExecutionContext } from "../src/tools/types";
import { resolveExplicitRepositoryVisibilityChoiceV1 } from "../src/integrations/github/RepositoryVisibility";

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
    visibility: "private",
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
  assert.equal(approvedActionId, "github-repository-fixture");
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
    tool.executeResult!({
      profileKey: "fixture",
      visibility: "private",
    }, context(async () => {
      approvalCount += 1;
      throw new Error("approval must not run");
    })),
    /Existing repositories are never converted automatically/iu,
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
    tool.executeResult!({
      profileKey: "fixture",
      visibility: "private",
    }, context(approval)),
    /transport interrupted/iu,
  );
  assert.equal(
    (checkpoint as GitHubPrivateRepositoryCheckpointV1 | null)?.status,
    "reconcile_required",
  );
  providerRecovered = true;
  const result = await tool.executeResult!({
    profileKey: "fixture",
    visibility: "private",
  }, context(approval));
  assert.equal(result.ok, true);
  assert.equal(createCount, 1, "resume performs readback only");
  assert.equal(result.receipt?.commitKind, "reconciled");
});

test("repository creation durably waits for an explicit public/private choice without GitHub mutation", async () => {
  const checkpoints: GitHubPrivateRepositoryCheckpointV1[] = [];
  let readCount = 0;
  let createCount = 0;
  let approvalCount = 0;
  const tool = createGitHubRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => {
      readCount += 1;
      return null;
    },
    createRepository: async () => {
      createCount += 1;
      return repository(true);
    },
    getCheckpoint: async () => null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });

  await assert.rejects(
    tool.executeResult!(
      { profileKey: "fixture" },
      context(async () => {
        approvalCount += 1;
        throw new Error("approval must not run");
      }, "Publish the verified project to GitHub as a draft pull request."),
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "waiting_for_repository_visibility",
  );

  assert.equal(readCount, 0);
  assert.equal(createCount, 0);
  assert.equal(approvalCount, 0);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.status, "waiting_for_repository_visibility");
  assert.equal(checkpoints[0]?.visibility, null);
  assert.equal(checkpoints[0]?.preparedAction, null);
  assert.match(
    checkpoints[0]?.blocker?.message ?? "",
    /public or private/iu,
  );
});

test("tool registry exposes the generic name and V1 alias with the same explicit visibility gate", async () => {
  const checkpoints: GitHubPrivateRepositoryCheckpointV1[] = [];
  let readCount = 0;
  let createCount = 0;
  let approvalCount = 0;
  const repositoryTool = createGitHubRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => {
      readCount += 1;
      return null;
    },
    createRepository: async () => {
      createCount += 1;
      return repository(true);
    },
    getCheckpoint: async () => null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });
  const registry = createDefaultToolRegistry({
    githubPrivateRepositoryTool: repositoryTool,
  });
  const definitions = new Set(
    registry
      .getDefinitions()
      .map((definition) => definition.function.name),
  );
  assert.ok(definitions.has(CREATE_GITHUB_REPOSITORY_TOOL_NAME));
  assert.ok(definitions.has(LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME));

  for (const name of [
    CREATE_GITHUB_REPOSITORY_TOOL_NAME,
    LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  ]) {
    const result = await registry.execute(
      { name, arguments: { profileKey: "fixture" } },
      context(async () => {
        approvalCount += 1;
        throw new Error("approval must not run");
      }, "Publish the verified project to GitHub as a draft pull request."),
    );
    assert.equal(result.ok, false);
    assert.equal(result.toolName, name);
    assert.equal(result.error?.code, "waiting_for_repository_visibility");
    assert.equal(result.mutationState, "not_applied");
  }

  assert.equal(readCount, 0);
  assert.equal(createCount, 0);
  assert.equal(approvalCount, 0);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.status),
    ["waiting_for_repository_visibility", "waiting_for_repository_visibility"],
  );
});

test("V1 private checkpoint without a top-level visibility projects to private only", async () => {
  const checkpoints: GitHubPrivateRepositoryCheckpointV1[] = [];
  const tool = createGitHubRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => null,
    createRepository: async () => repository(true),
    getCheckpoint: async () => null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });
  await assert.rejects(
    tool.executeResult!(
      { profileKey: "fixture", visibility: "private" },
      context(async () => {
        throw new Error("stop after prepared checkpoint");
      }),
    ),
    /stop after prepared checkpoint/iu,
  );
  const legacy = structuredClone(checkpoints[0]) as unknown as Record<
    string,
    unknown
  >;
  const legacyCreationId = "github-private-fixture";
  legacy.creationId = legacyCreationId;
  delete legacy.visibility;
  const legacyAction = legacy.preparedAction as Record<string, unknown>;
  legacyAction.id = legacyCreationId;
  legacyAction.toolName = LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME;

  const parsed = parseGitHubPrivateRepositoryCheckpointMapV1({
    [legacyCreationId]: legacy,
  });
  assert.equal(parsed[legacyCreationId]?.visibility, "private");
  assert.equal(
    parsed[legacyCreationId]?.preparedAction?.toolName,
    LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  );
});

test("public repository creation warns, approves, and independently verifies public visibility", async () => {
  const checkpoints: GitHubPrivateRepositoryCheckpointV1[] = [];
  let readCount = 0;
  let createCount = 0;
  const tool = createGitHubRepositoryTool({
    resolveDestination: async () => destination(),
    readRepository: async () => ++readCount === 1 ? null : repository(false),
    createRepository: async (_resolved, visibility) => {
      createCount += 1;
      assert.equal(visibility, "public");
      return repository(false);
    },
    getCheckpoint: async (id) =>
      checkpoints.slice().reverse().find((item) => item.creationId === id) ?? null,
    persistCheckpoint: async (checkpoint) => {
      checkpoints.push(structuredClone(checkpoint));
    },
    persistBinding: async () => undefined,
    persistExternalReceipt: async () => undefined,
    now: () => NOW,
  });

  const result = await tool.executeResult!(
    { profileKey: "fixture", visibility: "public" },
    context(async (request) => {
      assert.equal(request.toolName, CREATE_GITHUB_REPOSITORY_TOOL_NAME);
      assert.ok(request.policyTags.includes("internet_visible"));
      assert.match(request.reason, /visible on the internet/iu);
      assert.deepEqual(request.preparedAction?.preview.after, {
        visibility: "public",
        archived: false,
      });
      assert.match(
        request.preparedAction?.preview.warnings.join(" ") ?? "",
        /visible on the internet/iu,
      );
      return {
        approved: true,
        approvalId: "approval-public-create",
        approvalFingerprint: request.preparedAction!.payloadFingerprint,
      };
    }, "Create this GitHub repository as public."),
  );

  assert.equal(result.ok, true);
  assert.equal(createCount, 1);
  assert.equal(readCount, 2);
  assert.equal(
    (result.output as { binding: { visibility: string } }).binding.visibility,
    "public",
  );
  assert.equal(result.receipt?.resource.resourceType, "public_repository");
  assert.equal(checkpoints.at(-1)?.visibility, "public");
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
      "Call github_create_private_repository for the exact private repository owner/repo.",
    ),
    true,
  );
  assert.equal(
    hasExplicitPrivateGitHubRepositoryCreationIntent(
      "Create the exact private GitHub repository owner/repo. Do not stop before Linear, code, GitHub proofs exist.",
    ),
    true,
  );
  assert.equal(
    hasExplicitPrivateGitHubRepositoryCreationIntent(
      "Do not create a GitHub repository; only describe the setup.",
    ),
    false,
  );
  assert.equal(
    hasPrivateGitHubRepositoryBootstrapIntent(
      "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
    ),
    true,
  );
  assert.equal(
    hasPrivateGitHubRepositoryBootstrapIntent(
      "Publish this commit to GitHub as a draft pull request.",
    ),
    false,
    "generic publication must not infer private-repository creation authority",
  );
  assert.equal(
    hasPrivateGitHubRepositoryBootstrapIntent(
      "Do not create a GitHub repository; publish only to the issue-bound private GitHub destination if it already exists.",
    ),
    false,
    "explicit creation negation must dominate bound-destination publication",
  );
  assert.equal(
    hasGitHubRepositoryBootstrapIntent(
      "Publish this commit to GitHub as a draft pull request.",
    ),
    true,
    "generic publication must enter the visibility-choice gate",
  );
});

test("repository visibility requires an affirmative choice instead of inverting negation", () => {
  assert.deepEqual(
    resolveExplicitRepositoryVisibilityChoiceV1(
      "Create the repository, but do not make it public.",
    ),
    {
      status: "waiting",
      code: "waiting_for_repository_visibility",
      message:
        "Should this GitHub repository be public or private? No GitHub mutation was performed.",
    },
  );
  assert.equal(
    resolveExplicitRepositoryVisibilityChoiceV1(
      "Publish it, but never use a private repository.",
    ).status,
    "waiting",
  );
  assert.deepEqual(
    resolveExplicitRepositoryVisibilityChoiceV1(
      "Do not make it public; create a private GitHub repository.",
    ),
    { status: "chosen", visibility: "private" },
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
    visibility: privateVisibility ? "private" as const : "public" as const,
    archived: false,
  };
}

function context(
  requestNestedApproval: NonNullable<ToolExecutionContext["requestNestedApproval"]>,
  originalPrompt = "Create a private GitHub repository for this project.",
): ToolExecutionContext {
  return {
    app: {} as never,
    settings: {} as never,
    originalPrompt,
    runId: "run-private-repository",
    operationId: "tool-private-repository",
    httpTransport: async () => {
      throw new Error("not used");
    },
    requestNestedApproval,
    now: () => NOW,
  };
}
