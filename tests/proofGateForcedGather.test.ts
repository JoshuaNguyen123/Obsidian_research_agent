import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainToolsToMissionGraphFrontier,
  injectProofGateForcedGatherToolsV1,
} from "../src/agent/missionGraphFrontier";
import { chooseAlternativeTool, planRecovery } from "../src/agent/recoveryEngine";
import { createMissionPlan } from "../src/agent/missionPlan";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import {
  blockingProofsAreWebFetchOnlyV1,
  buildProofGateForcedGatherContractV1,
  containProofGateRejectedWriteToolsV1,
  PROOF_GATE_FRONTIER_CONTAINMENT_THRESHOLD,
} from "../src/AgentRunner";
import type { ModelToolDefinition } from "../src/model/types";

const tool = (name: string): ModelToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

test("proof-gated web/fetch debt keeps the write, injects gather tools, and splices search-then-write", () => {
  assert.equal(
    blockingProofsAreWebFetchOnlyV1(["web_evidence", "fetched_sources"]),
    true,
  );
  assert.equal(
    blockingProofsAreWebFetchOnlyV1(["web_evidence", "vault_evidence"]),
    false,
  );

  const menu = [
    "append_to_current_file",
    "replace_current_file",
    "web_search",
  ].map(tool);
  assert.deepEqual(
    containProofGateRejectedWriteToolsV1(menu, {
      rejectionCounts: new Map([
        ["append_to_current_file", PROOF_GATE_FRONTIER_CONTAINMENT_THRESHOLD],
      ]),
      blockingProofsOutstanding: true,
      blockingProofs: ["web_evidence", "citation_coverage"],
    }).map((item) => item.function.name),
    ["append_to_current_file", "replace_current_file", "web_search"],
    "do not hide the held write when the unpaid proofs are only web/fetch",
  );
  assert.deepEqual(
    containProofGateRejectedWriteToolsV1(menu, {
      rejectionCounts: new Map([
        ["append_to_current_file", PROOF_GATE_FRONTIER_CONTAINMENT_THRESHOLD],
      ]),
      blockingProofsOutstanding: true,
      blockingProofs: ["vault_evidence"],
    }).map((item) => item.function.name),
    ["replace_current_file", "web_search"],
  );

  const catalog = [
    "append_to_current_file",
    "read_current_file",
    "web_search",
    "web_fetch",
  ].map(tool);
  assert.deepEqual(
    injectProofGateForcedGatherToolsV1(
      [tool("append_to_current_file")],
      catalog,
      { injectWebTools: true, heldWriteToolName: "append_to_current_file" },
    ).map((item) => item.function.name),
    ["append_to_current_file", "web_search", "web_fetch"],
  );

  const streamingStub = {
    nodes: {
      dispatch: {
        id: "dispatch",
        status: "complete",
        allowedTools: [],
        inputs: {},
        outputs: {},
      },
      final: {
        id: "final",
        status: "ready",
        allowedTools: [],
        inputs: {},
        outputs: {},
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
    capabilityEnvelope: { tools: {} },
  } as never;
  const continueFrontier = constrainToolsToMissionGraphFrontier(
    catalog,
    streamingStub,
    {
      route: "single_model_writeback",
      proofGateForcedGather: {
        injectWebTools: true,
        heldWriteToolName: "append_to_current_file",
      },
    },
  ).map((item) => item.function.name);
  assert.ok(
    continueFrontier.includes("append_to_current_file"),
    `Continue empty-frontier must keep the write, got ${continueFrontier.join(",")}`,
  );
  assert.ok(
    continueFrontier.includes("web_search") &&
      continueFrontier.includes("web_fetch"),
    `Continue empty-frontier must inject gather tools, got ${continueFrontier.join(",")}`,
  );

  const contract = buildProofGateForcedGatherContractV1({
    heldWriteToolName: "append_to_current_file",
    offeredGatherTools: ["web_search", "web_fetch", "append_to_current_file"],
  });
  assert.match(contract, /Request one of these allowed gather tools now: web_search, web_fetch/u);
  assert.match(contract, /Then call append_to_current_file/u);
  assert.match(contract, /Do not retry the write first/u);

  assert.equal(
    chooseAlternativeTool(
      ["web_search", "web_fetch", "append_to_current_file"],
      "append_to_current_file",
    ),
    "web_search",
    "search-then-write splice prefers web_search after a held write",
  );
  const plan = createMissionPlan({
    runId: "run:test",
    prompt: "Search the web and append a cited note.",
    missionIntent: {
      mode: "note_output",
      vaultContext: false,
      noteOutput: true,
      explicitPersistence: true,
      explicitMutation: true,
      explicitDelete: false,
      allowAutonomousWrite: true,
      requireWriteCompletion: true,
      autonomyScope: deriveAutonomyScope("append to current note", {
        noteOutput: true,
        explicitPersistence: true,
        explicitMutation: true,
      }),
    },
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames: ["web_search", "web_fetch", "append_to_current_file"],
    },
    requiredTools: ["web_search", "append_to_current_file"],
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  const recovery = planRecovery({
    plan,
    reason: "tool_failed",
    failedAction: "append_to_current_file",
    allowedToolNames: ["web_search", "web_fetch", "append_to_current_file"],
    attemptedActions: [],
  });
  assert.equal(recovery.status, "recover");
  assert.equal(recovery.updatedAction?.toolName, "web_search");
});

test("first gather turn injects web tools and holds writes until proofs exist", () => {
  const transformerWithCite =
    "Write a brief explaining the transformer architecture and cite at least 5 scholarly sources on this page.";
  const thousandWordResearch =
    "Write a 1000 word research note on photosynthesis. Cite at least 5-10 scholarly and academic sources.";

  assert.equal(
    blockingProofsAreWebFetchOnlyV1([
      "web_evidence",
      "citation_coverage",
      "fetched_sources",
    ]),
    true,
    transformerWithCite,
  );
  assert.equal(
    blockingProofsAreWebFetchOnlyV1(["web_evidence", "source_coverage"]),
    true,
    thousandWordResearch,
  );

  const firstGatherMenu = [
    "append_to_current_file",
    "replace_current_file",
    "read_current_file",
  ].map(tool);
  assert.deepEqual(
    containProofGateRejectedWriteToolsV1(firstGatherMenu, {
      rejectionCounts: new Map(),
      blockingProofsOutstanding: true,
      blockingProofs: ["web_evidence", "citation_coverage"],
    }).map((item) => item.function.name),
    ["append_to_current_file", "replace_current_file", "read_current_file"],
    "web/fetch-only first gather keeps the write visible; execution still holds it",
  );
  assert.deepEqual(
    containProofGateRejectedWriteToolsV1(firstGatherMenu, {
      rejectionCounts: new Map(),
      blockingProofsOutstanding: true,
      blockingProofs: ["vault_evidence"],
      holdWritesUntilProofs: true,
    }).map((item) => item.function.name),
    ["read_current_file"],
    "non-web first-gather holds writes until proofs exist",
  );

  const catalog = [
    "append_to_current_file",
    "read_current_file",
    "web_search",
    "web_fetch",
  ].map(tool);
  assert.deepEqual(
    injectProofGateForcedGatherToolsV1(
      [tool("read_current_file")],
      catalog,
      { injectWebTools: true, heldWriteToolName: "append_to_current_file" },
    ).map((item) => item.function.name),
    ["read_current_file", "web_search", "web_fetch", "append_to_current_file"],
    "first gather injects web_search/web_fetch without a prior write rejection",
  );

  const streamingStub = {
    nodes: {
      dispatch: {
        id: "dispatch",
        status: "complete",
        allowedTools: [],
        inputs: {},
        outputs: {},
      },
      final: {
        id: "final",
        status: "ready",
        allowedTools: [],
        inputs: {},
        outputs: {},
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
    capabilityEnvelope: { tools: {} },
  } as never;
  const firstTurnFrontier = constrainToolsToMissionGraphFrontier(
    catalog,
    streamingStub,
    {
      route: "single_model_writeback",
      proofGateForcedGather: {
        injectWebTools: true,
        heldWriteToolName: "append_to_current_file",
      },
    },
  ).map((item) => item.function.name);
  assert.ok(
    firstTurnFrontier.includes("web_search") &&
      firstTurnFrontier.includes("web_fetch"),
    `transformer-architecture-with-cite and 1000-word research note must gather first; got ${firstTurnFrontier.join(",")}`,
  );
});
