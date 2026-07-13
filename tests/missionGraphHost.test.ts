import assert from "node:assert/strict";
import test from "node:test";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import { planMissionGraphV3 } from "../src/agent/missionGraphPlanner";
import { descriptorFor } from "../src/tools/toolDescriptors";
import type { ToolDescriptor } from "../src/agent/actions";
import type { MissionBindingGrantV1 } from "../src/agent/missionGraphV3";
import type { ToolRegistry } from "../src/tools/types";
import { createPreparedBackgroundGitHubToolDescriptorV1 } from "../extensions/integrations/host/PreparedBackgroundGitHubToolsV1";

const NOW = new Date("2026-07-11T18:00:00.000Z");

test("host graph plan turns filtered descriptors into exact read-before-mutation authority", async () => {
  const registry = registryFor([
    "read_current_file",
    "append_to_current_file",
    "web_search",
  ]);
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-host-graph",
    objective: "Read the current note and append a sourced answer.",
    toolRegistry: registry,
    allowedToolNames: [
      "read_current_file",
      "append_to_current_file",
      "web_search",
    ],
    plannedToolNames: ["read_current_file", "append_to_current_file"],
    currentNotePath: "Research/Brief.md",
    maxToolCalls: 8,
    maxWallClockMs: 60_000,
    now: NOW,
  });

  const result = await planMissionGraphV3({
    mission: {
      missionId: "run-host-graph",
      objective: "Read the current note and append a sourced answer.",
    },
    routerMode: "off",
    capabilityEnvelope: host.capabilityEnvelope,
    deterministicProposal: host.deterministicProposal,
    allowedToolDescriptors: host.allowedToolDescriptors,
    now: () => NOW.toISOString(),
  });

  const nodes = Object.values(result.graph.nodes);
  const read = nodes.find((node) =>
    node.allowedTools.includes("read_current_file"),
  );
  const write = nodes.find((node) =>
    node.allowedTools.includes("append_to_current_file"),
  );
  assert.ok(read);
  assert.ok(write);
  assert.deepEqual(write.dependencyIds, [read.id]);
  assert.equal(write.effect, "mutation");
  assert.equal(write.destination?.selector, "Research/Brief.md");
  assert.deepEqual(write.resourceLocks, [
    { bindingId: "binding-vault-markdown", mode: "exclusive" },
  ]);
  assert.equal(result.graph.nodes.final.dependencyIds.includes(write.id), true);
  assert.ok(host.deterministicProposal.optionalReadNodes);
  assert.equal(
    Object.values(host.deterministicProposal.optionalReadNodes ?? {}).some(
      (node) => node.allowedTools.includes("web_search"),
    ),
    true,
  );
});

test("host graph planning fails closed when a tool has no explicit descriptor", async () => {
  const registry: ToolRegistry = {
    getDefinitions: () => [
      {
        type: "function",
        function: {
          name: "unknown_dynamic_tool",
          parameters: { type: "object" },
        },
      },
    ],
    execute: async () => ({ ok: true, toolName: "unknown_dynamic_tool" }),
  };
  await assert.rejects(
    buildHostMissionGraphPlanV1({
      missionId: "run-unknown-tool",
      objective: "Try an unknown tool.",
      toolRegistry: registry,
      allowedToolNames: ["unknown_dynamic_tool"],
      plannedToolNames: ["unknown_dynamic_tool"],
      maxToolCalls: 1,
      maxWallClockMs: 10_000,
      now: NOW,
    }),
    /Missing explicit tool descriptor/,
  );
});

test("planned reads after a prerequisite mutation wait for that mutation", async () => {
  const registry = registryFor([
    "create_folder",
    "list_folder",
    "create_file",
  ]);
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-mutation-before-read",
    objective: "Create a bounded workspace, inspect it, then create a file.",
    toolRegistry: registry,
    allowedToolNames: ["create_folder", "list_folder", "create_file"],
    plannedToolNames: ["create_folder", "list_folder", "create_file"],
    maxToolCalls: 6,
    maxWallClockMs: 60_000,
    now: NOW,
  });
  const nodes = Object.values(host.deterministicProposal.nodes);
  const createFolder = nodes.find((node) =>
    node.allowedTools.includes("create_folder"),
  );
  const listFolder = nodes.find((node) => node.allowedTools.includes("list_folder"));
  const createFile = nodes.find((node) => node.allowedTools.includes("create_file"));
  assert.ok(createFolder && listFolder && createFile);
  assert.deepEqual(createFolder.dependencyIds, []);
  assert.deepEqual(listFolder.dependencyIds, [createFolder.id]);
  assert.deepEqual(createFile.dependencyIds, [listFolder.id]);
});

test("explicit background planning routes an installed fixed read executor", async () => {
  const names = ["web_fetch"];
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-fixed-background-reads",
    objective: "Continue these exact readbacks in the background.",
    toolRegistry: registryFor(names),
    allowedToolNames: names,
    plannedToolNames: names,
    maxToolCalls: 8,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["research"],
      preferBackground: true,
    },
  });
  const nodes = Object.values(host.deterministicProposal.nodes).filter(
    (node) => node.id !== "final",
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes.every((node) => node.executionHost === "headless_runtime"), true);
  assert.deepEqual(
    nodes.map((node) => node.executorId).sort(),
    ["public_research_fetch_v1"],
  );
  assert.deepEqual(host.capabilityEnvelope.executionHosts, [
    "headless_runtime",
    "obsidian_core",
  ]);
  assert.equal(host.deterministicProposal.nodes.final.executionHost, "obsidian_core");
});

test("explicit background planning routes only the exact prepared Linear state update", async () => {
  const descriptor = linearStateUpdateDescriptor();
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-fixed-background-linear-update",
    objective: "Continue in the background and move the trusted Linear issue to Done.",
    toolRegistry: registryForDescriptors([descriptor]),
    allowedToolNames: [descriptor.name],
    plannedToolNames: [descriptor.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["linear"],
      preferBackground: true,
    },
  });

  const node = Object.values(host.deterministicProposal.nodes).find(
    (candidate) => candidate.allowedTools[0] === descriptor.name,
  );
  assert.ok(node);
  assert.equal(node.executionHost, "headless_runtime");
  assert.equal(node.executorId, "linear_issue_readback_v1");
  assert.equal(node.effect, "external_action");
  assert.equal(node.destination?.bindingId, "binding-linear-issue");
  assert.equal(node.destination?.selector, null);
  assert.deepEqual(node.resourceLocks, [
    { bindingId: "binding-linear-issue", mode: "exclusive" },
  ]);
  assert.deepEqual(
    host.capabilityEnvelope.executors.linear_issue_readback_v1.allowedEffects,
    ["external_action"],
  );
  assert.deepEqual(
    host.capabilityEnvelope.tools.linear_update_issue.executionHosts,
    ["headless_runtime", "obsidian_core"],
  );
});

test("installed Linear capability does not move an ordinary foreground update to the companion", async () => {
  const descriptor = linearStateUpdateDescriptor();
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-foreground-linear-update",
    objective: "Move the trusted Linear issue to Done now.",
    toolRegistry: registryForDescriptors([descriptor]),
    allowedToolNames: [descriptor.name],
    plannedToolNames: [descriptor.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["linear"],
      preferBackground: false,
    },
  });

  const node = Object.values(host.deterministicProposal.nodes).find(
    (candidate) => candidate.allowedTools[0] === descriptor.name,
  );
  assert.ok(node);
  assert.equal(node.executionHost, "obsidian_core");
  assert.equal(node.executorId, "single-agent");
});

test("descriptor drift keeps a Linear-looking mutation core-hosted", async () => {
  const exact = linearStateUpdateDescriptor();
  const drifted: ToolDescriptor = {
    ...exact,
    durability: { ...exact.durability, readback: "none" },
  };
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-drifted-background-linear-update",
    objective: "Continue this Linear update in the background.",
    toolRegistry: registryForDescriptors([drifted]),
    allowedToolNames: [drifted.name],
    plannedToolNames: [drifted.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["linear"],
      preferBackground: true,
    },
  });

  const node = Object.values(host.deterministicProposal.nodes).find(
    (candidate) => candidate.allowedTools[0] === drifted.name,
  );
  assert.ok(node);
  assert.equal(node.executionHost, "obsidian_core");
  assert.equal(node.executorId, "single-agent");
});

test("explicit background planning routes only the exact prepared Code commit contract", async () => {
  const descriptor = backgroundCodeDescriptor();
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-fixed-background-code-commit",
    objective:
      "Continue the already-edited and fast-green Code checkpoint in the background.",
    toolRegistry: registryForDescriptors([descriptor]),
    allowedToolNames: [descriptor.name],
    plannedToolNames: [descriptor.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["code"],
      preferBackground: true,
    },
    bindingOverrides: {
      [descriptor.name]: {
        id: "workspace-background-code-1",
        kind: "prepared_validation_commit",
        destinationFingerprint: `sha256:${"b".repeat(64)}`,
        allowedEffects: ["read", "execution"],
      },
    },
  });

  const node = Object.values(host.deterministicProposal.nodes).find(
    (candidate) => candidate.allowedTools[0] === descriptor.name,
  );
  assert.ok(node);
  assert.equal(node.executionHost, "headless_runtime");
  assert.equal(node.executorId, "verified_code_manifest_readback_v1");
  assert.equal(node.effect, "execution");
  assert.equal(node.destination?.bindingId, "workspace-background-code-1");
  assert.equal(
    host.capabilityEnvelope.bindings["workspace-background-code-1"]
      ?.destinationFingerprint,
    `sha256:${"b".repeat(64)}`,
  );
  assert.deepEqual(node.resourceLocks, [
    { bindingId: "workspace-background-code-1", mode: "exclusive" },
  ]);
  assert.deepEqual(node.completionContract.requiredEvidenceKinds, [
    "verified_local_commit",
  ]);
  assert.deepEqual(node.completionContract.requiredReceiptKinds, [
    "external:code:prepared_code_validation_commit_v1",
  ]);
  assert.equal(
    node.completionContract.verifierId,
    "companion-external-result-v1",
  );
});

test("a generic prepared-validation binding cannot grant headless Code authority", async () => {
  const descriptor = backgroundCodeDescriptor();
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-background-code-without-trusted-binding",
    objective: "Continue one exact Code checkpoint in the background.",
    toolRegistry: registryForDescriptors([descriptor]),
    allowedToolNames: [descriptor.name],
    plannedToolNames: [descriptor.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["code"],
      preferBackground: true,
    },
  });

  const node = Object.values(host.deterministicProposal.nodes).find(
    (candidate) => candidate.allowedTools[0] === descriptor.name,
  );
  assert.ok(node);
  assert.equal(node.executionHost, "obsidian_core");
  assert.equal(node.executorId, "single-agent");
  assert.notEqual(
    node.destination?.bindingId,
    "workspace-background-code-1",
  );
});

test("trusted binding overrides cannot widen descriptor authority", async () => {
  const descriptor = backgroundCodeDescriptor();
  await assert.rejects(
    buildHostMissionGraphPlanV1({
      missionId: "run-widened-background-code-binding",
      objective: "Continue one exact Code checkpoint in the background.",
      toolRegistry: registryForDescriptors([descriptor]),
      allowedToolNames: [descriptor.name],
      plannedToolNames: [descriptor.name],
      maxToolCalls: 1,
      maxWallClockMs: 60_000,
      now: NOW,
      background: {
        installedDomains: ["code"],
        preferBackground: true,
      },
      bindingOverrides: {
        [descriptor.name]: {
          id: "workspace-background-code-1",
          kind: "prepared_validation_commit",
          destinationFingerprint: `sha256:${"b".repeat(64)}`,
          allowedEffects: ["read", "execution", "external_action"],
        },
      },
    }),
    /exceeds its descriptor authority/iu,
  );
});

test("descriptor drift cannot grant headless Code commit authority", async () => {
  const exact = backgroundCodeDescriptor();
  const drifted: ToolDescriptor = {
    ...exact,
    durability: { ...exact.durability, readback: "none" },
  };
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-drifted-background-code-commit",
    objective: "Continue the Code checkpoint in the background.",
    toolRegistry: registryForDescriptors([drifted]),
    allowedToolNames: [drifted.name],
    plannedToolNames: [drifted.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["code"],
      preferBackground: true,
    },
  });
  const node = Object.values(host.deterministicProposal.nodes).find(
    (candidate) => candidate.allowedTools[0] === drifted.name,
  );
  assert.ok(node);
  assert.equal(node.executionHost, "obsidian_core");
  assert.equal(node.executorId, "single-agent");
});

test("exact prepared GitHub push and draft nodes are separately bound and sequential", async () => {
  const push = createPreparedBackgroundGitHubToolDescriptorV1(
    "github_publish_verified_branch",
  );
  const draft = createPreparedBackgroundGitHubToolDescriptorV1(
    "github_create_draft_pull_request",
  );
  const binding: MissionBindingGrantV1 = {
    id: "github-publication-background-1",
    kind: "trusted_repository_publication",
    destinationFingerprint: `sha256:${"d".repeat(64)}`,
    allowedEffects: ["read", "external_action"],
  };
  const host = await buildHostMissionGraphPlanV1({
    missionId: "run-fixed-background-github-publication",
    objective: "Push the verified branch, then create its draft PR in the background.",
    toolRegistry: registryForDescriptors([push, draft]),
    allowedToolNames: [push.name, draft.name],
    plannedToolNames: [push.name, draft.name],
    maxToolCalls: 2,
    maxWallClockMs: 60_000,
    now: NOW,
    background: {
      installedDomains: ["github"],
      preferBackground: true,
    },
    bindingOverrides: {
      [push.name]: binding,
      [draft.name]: binding,
    },
  });
  const nodes = Object.values(host.deterministicProposal.nodes);
  const pushNode = nodes.find((node) => node.allowedTools[0] === push.name);
  const draftNode = nodes.find((node) => node.allowedTools[0] === draft.name);
  assert.ok(pushNode && draftNode);
  assert.equal(pushNode.executionHost, "headless_runtime");
  assert.equal(draftNode.executionHost, "headless_runtime");
  assert.notEqual(pushNode.id, draftNode.id);
  assert.deepEqual(pushNode.dependencyIds, []);
  assert.deepEqual(draftNode.dependencyIds, [pushNode.id]);
  assert.equal(pushNode.destination?.bindingId, binding.id);
  assert.equal(pushNode.destination?.selector, null);
  assert.equal(draftNode.destination?.bindingId, binding.id);
  assert.deepEqual(pushNode.completionContract.requiredReceiptKinds, [
    "external:github:github_verified_branch_push_v1",
  ]);
  assert.deepEqual(draftNode.completionContract.requiredReceiptKinds, [
    "external:github:github_draft_pull_request_v1",
  ]);
});

test("prepared GitHub headless authority requires both an exact descriptor and exact binding", async () => {
  const exact = createPreparedBackgroundGitHubToolDescriptorV1(
    "github_publish_verified_branch",
  );
  const withoutBinding = await buildHostMissionGraphPlanV1({
    missionId: "run-background-github-without-binding",
    objective: "Try to push without a synchronized repository binding.",
    toolRegistry: registryForDescriptors([exact]),
    allowedToolNames: [exact.name],
    plannedToolNames: [exact.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: { installedDomains: ["github"], preferBackground: true },
  });
  const unboundNode = Object.values(withoutBinding.deterministicProposal.nodes)
    .find((node) => node.allowedTools[0] === exact.name);
  assert.ok(unboundNode);
  assert.equal(unboundNode.executionHost, "obsidian_core");

  const drifted: ToolDescriptor = {
    ...exact,
    durability: { ...exact.durability, readback: "none" },
  };
  const withBinding = await buildHostMissionGraphPlanV1({
    missionId: "run-background-github-drifted-descriptor",
    objective: "Try to push with a same-name descriptor that lost readback proof.",
    toolRegistry: registryForDescriptors([drifted]),
    allowedToolNames: [drifted.name],
    plannedToolNames: [drifted.name],
    maxToolCalls: 1,
    maxWallClockMs: 60_000,
    now: NOW,
    background: { installedDomains: ["github"], preferBackground: true },
    bindingOverrides: {
      [drifted.name]: {
        id: "github-publication-background-2",
        kind: "trusted_repository_publication",
        destinationFingerprint: `sha256:${"e".repeat(64)}`,
        allowedEffects: ["read", "external_action"],
      },
    },
  });
  const driftedNode = Object.values(withBinding.deterministicProposal.nodes)
    .find((node) => node.allowedTools[0] === drifted.name);
  assert.ok(driftedNode);
  assert.equal(driftedNode.executionHost, "obsidian_core");
  assert.equal(driftedNode.executorId, "single-agent");
});

function registryFor(names: string[]): ToolRegistry {
  const descriptors = new Map(
    names.map((name) => [name, descriptorFor(name)] as const),
  );
  return {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: {
          name,
          parameters: { type: "object" },
        },
      })),
    getDescriptor: (name) => descriptors.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
}

function registryForDescriptors(descriptors: ToolDescriptor[]): ToolRegistry {
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return {
    getDefinitions: () =>
      descriptors.map((descriptor) => ({
        type: "function" as const,
        function: {
          name: descriptor.name,
          parameters: { type: "object" },
        },
      })),
    getDescriptor: (name) => byName.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
}

function linearStateUpdateDescriptor(): ToolDescriptor {
  return {
    version: 1,
    name: "linear_update_issue",
    capability: { system: "linear", resourceType: "issue", action: "update" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead", "researcher"],
    receiptKind: "external_action",
  };
}

function backgroundCodeDescriptor(): ToolDescriptor {
  return {
    version: 1,
    name: "code_validate_commit_prepared",
    capability: {
      system: "git",
      resourceType: "prepared_validation_commit",
      action: "commit",
    },
    effect: "execution",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      desktopOnly: true,
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    receiptKind: "code_change",
  };
}
