import assert from "node:assert/strict";
import test from "node:test";

import {
  withPreparedActionFingerprint,
  type PreparedAction,
  type ResourceRef,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  FINALIZE_GITHUB_LINKS_IN_OBSIDIAN_TOOL_NAME,
  resolveNestedApprovalBindingV1,
} from "../src/agent/nestedApprovalPolicy";
import { PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME } from "../src/tools/githubPublicationTool";

test("same-tool publication approval retains the outer composite-tool identity", async () => {
  const publish = await action(
    PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    {
      system: "github",
      resourceType: "repository_branch",
      id: "acme/research-agent:codex/issue-42",
    },
    "foreground-publication-run",
  );
  const outerDescriptor: ToolDescriptor = {
    ...descriptor(
      PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      "pull_request",
      "publish",
    ),
    capability: { system: "github", resourceType: "pull_request", action: "publish" },
    effect: "publish",
  };
  const binding = await resolveNestedApprovalBindingV1({
    outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    request: request(publish),
    toolRegistry: registry(new Map([
      [PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME, outerDescriptor],
    ])),
  });
  assert.equal(binding.toolName, PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME);
  assert.equal(binding.runId, "foreground-publication-run");
});

test("GitHub finalizer may request only its exact registered Linear subactions", async () => {
  const descriptors = new Map<string, ToolDescriptor>([
    ["linear_create_comment", descriptor("linear_create_comment", "comment", "create")],
    ["linear_update_issue", descriptor("linear_update_issue", "issue", "update")],
  ]);
  const comment = await action(
    "linear_create_comment",
    { system: "linear", resourceType: "comment", id: "issue-42" },
    "queue-code-issue-42",
  );
  const binding = await resolveNestedApprovalBindingV1({
    outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    request: request(comment),
    toolRegistry: registry(descriptors),
  });
  assert.equal(binding.runId, "queue-code-issue-42");
  assert.equal(binding.toolName, "linear_create_comment");
  assert.equal(binding.descriptor.capability.action, "create");

  const update = await action(
    "linear_update_issue",
    { system: "linear", resourceType: "issue", id: "issue-42" },
    "queue-code-issue-42",
  );
  assert.equal(
    (await resolveNestedApprovalBindingV1({
      outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      request: request(update),
      toolRegistry: registry(descriptors),
    })).descriptor.capability.action,
    "update",
  );
});

test("cross-tool nested approval rejects arbitrary tools, identity drift, and descriptor drift", async () => {
  const descriptors = new Map<string, ToolDescriptor>([
    ["linear_delete_issue_permanently", descriptor(
      "linear_delete_issue_permanently",
      "issue",
      "delete",
    )],
    ["linear_create_comment", descriptor("linear_create_comment", "issue", "create")],
  ]);
  const destructive = await action(
    "linear_delete_issue_permanently",
    { system: "linear", resourceType: "issue", id: "issue-42" },
  );
  await assert.rejects(
    resolveNestedApprovalBindingV1({
      outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      request: request(destructive),
      toolRegistry: registry(descriptors),
    }),
    /closed capability contract/i,
  );

  const comment = await action(
    "linear_create_comment",
    { system: "linear", resourceType: "comment", id: "issue-42" },
  );
  await assert.rejects(
    resolveNestedApprovalBindingV1({
      outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      request: {
        toolName: "linear_create_comment",
        action: "Create comment",
        reason: "No exact action supplied.",
        policyTags: ["github_publication"],
      },
      toolRegistry: registry(descriptors),
    }),
    /requires an exact prepared action/i,
  );
  await assert.rejects(
    resolveNestedApprovalBindingV1({
      outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      request: { ...request(comment), toolName: "linear_update_issue" },
      toolRegistry: registry(descriptors),
    }),
    /tool identity/i,
  );
  await assert.rejects(
    resolveNestedApprovalBindingV1({
      outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      request: request(comment),
      toolRegistry: registry(descriptors),
    }),
    /descriptor/i,
  );
  await assert.rejects(
    resolveNestedApprovalBindingV1({
      outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      request: request({ ...comment, normalizedArgs: { changed: true } }),
      toolRegistry: registry(new Map([
        ["linear_create_comment", descriptor("linear_create_comment", "comment", "create")],
      ])),
    }),
    /fingerprint/i,
  );
});

test("GitHub note backlink approval uses the one host-owned vault subaction only", async () => {
  const backlink = await action(
    FINALIZE_GITHUB_LINKS_IN_OBSIDIAN_TOOL_NAME,
    {
      system: "vault",
      resourceType: "markdown_file",
      id: "Research/Issue 42.md",
      path: "Research/Issue 42.md",
      revision: `sha256:${"a".repeat(64)}`,
    },
  );
  const accepted = await resolveNestedApprovalBindingV1({
    outerToolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    request: request(backlink),
    toolRegistry: registry(new Map()),
  });
  assert.equal(accepted.descriptor.capability.system, "vault");
  assert.equal(accepted.descriptor.capability.action, "append");

  await assert.rejects(
    resolveNestedApprovalBindingV1({
      outerToolName: "some_other_workflow",
      request: request(backlink),
      toolRegistry: registry(new Map()),
    }),
    /closed capability contract/i,
  );
});

function request(preparedAction: PreparedAction) {
  return {
    toolName: preparedAction.toolName,
    action: preparedAction.preview.summary,
    reason: "Approve exact finalizer effect.",
    policyTags: ["github_publication", "exact"],
    preparedAction,
    confirmationIndex: 1,
    requiredConfirmations: 1 as const,
  };
}

async function action(
  toolName: string,
  target: ResourceRef,
  runId = "queue-code-issue-42",
): Promise<PreparedAction> {
  return withPreparedActionFingerprint({
    version: 1,
    id: `nested-${toolName}`,
    runId,
    toolCallId: `nested-${toolName}`,
    toolName,
    target,
    relatedResources: [],
    normalizedArgs: { targetId: target.id },
    preview: {
      summary: `Apply ${toolName}`,
      destination: target.id,
      warnings: [],
      outboundBytes: 0,
    },
    preparedAt: "2026-07-13T12:00:00.000Z",
    expiresAt: "2030-07-13T12:05:00.000Z",
  });
}

function descriptor(
  name: string,
  resourceType: string,
  capabilityAction: ToolDescriptor["capability"]["action"],
): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system: "linear", resourceType, action: capabilityAction },
    effect: capabilityAction === "delete" ? "destructive_mutation" : "reversible_mutation",
    risk: capabilityAction === "delete" ? "critical" : "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: capabilityAction !== "delete",
      fallback: capabilityAction === "delete" ? "double_exact" : "exact",
    },
    execution: { preparation: "required", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent"],
    receiptKind: "external_action",
  };
}

function registry(descriptors: Map<string, ToolDescriptor>) {
  return {
    getDescriptor(toolName: string) {
      return descriptors.get(toolName) ?? null;
    },
  };
}
