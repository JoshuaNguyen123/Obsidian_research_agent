import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  constrainToolsToMissionGraphFrontier,
  MAX_ADAPTIVE_CODE_INVESTIGATION_READS_V1,
  missionGraphAdaptiveCodeInvestigationToolNamesV1,
} from "../src/agent/missionGraphFrontier";
import { authoritativeRefusalFrontierToolNamesV1 } from "../src/agent/missionGraphSelectors";
import type { MissionGraphV3 } from "../packages/headless-runtime/src/missionGraphV3";
import type { ModelToolDefinition } from "../src/model/types";

// CIP-3: an exact coding plan names its reads up front (list, read, inspect)
// and then offers the planned edit alone, so a pass whose inspection points at
// another file could only patch blind. These pin the bounded exception.

const INVESTIGATION = [
  "code_workspace_read",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_search",
  "code_workspace_inspect",
];

const tool = (name: string): ModelToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

type NodeShape = { status: string; allowedTools: string[]; outputs?: Record<string, unknown> };

function graphOf(nodes: Record<string, NodeShape>): MissionGraphV3 {
  const tools: Record<string, { effect: string }> = {};
  for (const name of INVESTIGATION) tools[name] = { effect: "read" };
  for (const name of ["code_workspace_create", "code_workspace_patch", "code_validate_fast", "code_repair_record_cycle"]) {
    tools[name] = { effect: "write" };
  }
  return {
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { id, outputs: {}, ...node }])),
    capabilityEnvelope: { tools },
  } as unknown as MissionGraphV3;
}

/** A pass whose planned reads are done and whose planned edit is next. */
function editNext(extra: Record<string, NodeShape> = {}): MissionGraphV3 {
  return graphOf({
    "tool-01-code_workspace_create": { status: "complete", allowedTools: ["code_workspace_create"] },
    "tool-02-code_workspace_read": { status: "complete", allowedTools: ["code_workspace_read"] },
    "tool-03-code_workspace_inspect": { status: "complete", allowedTools: ["code_workspace_inspect"] },
    "tool-04-code_workspace_patch": { status: "ready", allowedTools: ["code_workspace_patch"] },
    "tool-05-code_validate_fast": { status: "queued", allowedTools: ["code_validate_fast"] },
    final: { status: "queued", allowedTools: [] },
    ...extra,
  });
}

const admits = (graph: MissionGraphV3, overrides: Partial<Parameters<typeof missionGraphAdaptiveCodeInvestigationToolNamesV1>[0]> = {}) =>
  missionGraphAdaptiveCodeInvestigationToolNamesV1({
    graph,
    usesExactPlannedFrontier: true,
    envelopeExhausted: false,
    toolCallsRemaining: 20,
    ...overrides,
  });

test("an exact coding plan whose edit is next admits the read-only workspace tools", () => {
  assert.deepEqual([...admits(editNext())].sort(), [...INVESTIGATION].sort());
});

test("nothing is admitted outside the window where the planned edit is next", () => {
  // A non-exact plan already mints dynamic reads; it needs nothing from here.
  assert.deepEqual(admits(editNext(), { usesExactPlannedFrontier: false }), []);
  // A spent envelope refuses every dynamic read, so none is offered.
  assert.deepEqual(admits(editNext(), { envelopeExhausted: true }), []);
  assert.deepEqual(admits(editNext(), { graph: null }), []);
  // Before the workspace exists there is nothing to investigate.
  assert.deepEqual(admits(editNext({ "tool-01-code_workspace_create": { status: "ready", allowedTools: ["code_workspace_create"] } })), []);
  // While a planned read is still to come, the edit is not next.
  assert.deepEqual(admits(graphOf({
    "tool-01-code_workspace_create": { status: "complete", allowedTools: ["code_workspace_create"] },
    "tool-02-code_workspace_read": { status: "ready", allowedTools: ["code_workspace_read"] },
    "tool-03-code_workspace_patch": { status: "queued", allowedTools: ["code_workspace_patch"] },
  })), []);
  // Anything in flight keeps the menu as it is.
  for (const status of ["running", "waiting_approval", "waiting_obsidian", "verifying"]) {
    assert.deepEqual(admits(editNext({ "tool-04-code_workspace_patch": { status, allowedTools: ["code_workspace_patch"] } })), [], status);
  }
});

test("a repair cycle or a validation-recovery window owns its own diagnostic reads", () => {
  assert.deepEqual(admits(editNext({ "tool-06-code_repair_record_cycle": { status: "ready", allowedTools: ["code_repair_record_cycle"] } })), []);
  assert.deepEqual(admits(editNext({
    "tool-05-code_validate_fast": {
      status: "queued",
      allowedTools: ["code_validate_fast"],
      outputs: { validationRecovery: { status: "awaiting_correction", fastNodeId: "tool-05-code_validate_fast", repairNodeId: "tool-06-code_repair_record_cycle" } },
    },
    "tool-06-code_repair_record_cycle": { status: "queued", allowedTools: ["code_repair_record_cycle"] },
  })), []);
});

test("the reads are capped per graph, counting every dynamic read already made", () => {
  const made: Record<string, NodeShape> = {};
  for (let i = 0; i < MAX_ADAPTIVE_CODE_INVESTIGATION_READS_V1 - 1; i += 1) {
    made[`retry-${10 + i}-code_workspace_search`] = { status: "complete", allowedTools: ["code_workspace_search"] };
  }
  assert.ok(admits(editNext(made)).length > 0, "one below the cap still admits");
  made["optional-retry-20-code_workspace_read"] = { status: "complete", allowedTools: ["code_workspace_read"] };
  assert.deepEqual(admits(editNext(made)), [], "at the cap nothing more is admitted");
  // A dynamic node for an unrelated tool does not count against the cap.
  assert.ok(admits(editNext({ "retry-30-read_file": { status: "complete", allowedTools: ["read_file"] } })).length > 0);
});

test("investigating never spends the calls the edit and its validation need", () => {
  // editNext() has three unfinished nodes (patch, fast validation, final); the
  // reserve keeps two more back for a retry, plus the read itself.
  assert.ok(admits(editNext(), { toolCallsRemaining: 6 }).length > 0);
  assert.deepEqual(admits(editNext(), { toolCallsRemaining: 5 }), []);
  assert.deepEqual(admits(editNext(), { toolCallsRemaining: Number.NaN }), []);
});

test("only tools the envelope grants as reads are named", () => {
  const graph = editNext();
  delete (graph.capabilityEnvelope.tools as Record<string, unknown>).code_workspace_search;
  (graph.capabilityEnvelope.tools as Record<string, { effect: string }>).code_workspace_stat = { effect: "write" };
  const names = admits(graph);
  assert.ok(!names.includes("code_workspace_search"));
  assert.ok(!names.includes("code_workspace_stat"));
  assert.ok(names.includes("code_workspace_read"));
});

test("the offered menu adds exactly the admitted reads beside the ready edit", () => {
  const graph = editNext();
  const menu = [...INVESTIGATION, "code_workspace_patch", "code_workspace_create_file", "code_validate_fast"].map(tool);
  const exact = constrainToolsToMissionGraphFrontier(menu, graph, {}).map((item) => item.function.name);
  assert.deepEqual(exact, ["code_workspace_patch"], "without the answer the menu is the edit alone");
  const widened = constrainToolsToMissionGraphFrontier(menu, graph, {
    adaptiveCodeInvestigationToolNames: admits(graph),
  }).map((item) => item.function.name);
  assert.deepEqual([...widened].sort(), [...INVESTIGATION, "code_workspace_patch"].sort());
  assert.ok(!widened.includes("code_workspace_create_file"), "no unplanned mutation is offered");
  assert.ok(!widened.includes("code_validate_fast"), "the queued validator is not pulled forward");
});

test("refusal messages name the admitted reads, and only when they are admitted", () => {
  const graph = editNext();
  const candidates = [...INVESTIGATION, "code_workspace_patch"];
  const without = authoritativeRefusalFrontierToolNamesV1({ graph, candidateToolNames: candidates, allowDynamicReadContinuation: false });
  assert.deepEqual(without, ["code_workspace_patch"]);
  const withAnswer = authoritativeRefusalFrontierToolNamesV1({
    graph,
    candidateToolNames: candidates,
    allowDynamicReadContinuation: false,
    adaptiveCodeInvestigationToolNames: admits(graph),
  });
  assert.deepEqual([...withAnswer].sort(), [...candidates].sort());
});

test("every AgentRunner seat reads the one investigation answer", () => {
  // The same source-level guard that keeps `dynamicReadContinuationAllowed()`
  // in step across the menu, the authority and the messages (instance #17).
  const source = readFileSync(new URL("../src/AgentRunner.ts", import.meta.url), "utf8");
  assert.ok(source.includes("missionGraphAdaptiveCodeInvestigationToolNamesV1({"), "the runner delegates to the shared predicate");
  // The authority.
  assert.match(source, /allowAdaptiveInvestigationRead =\s*adaptiveCodeInvestigationToolNames\(\)\.includes\(toolName\)/u);
  assert.match(source, /dynamicReadContinuationAllowed\(\) \|\| allowRecoveryRead \|\|\s*allowAdaptiveInvestigationRead/u);
  // Both offered-menu seats carry it beside their dynamic-read answer.
  const menuSeats = source.split("includeCapabilityReads: dynamicReadContinuationAllowed(),").length - 1;
  const menuWith = [...source.matchAll(/adaptiveCodeInvestigationToolNames:\s*adaptiveCodeInvestigationToolNames\(\),/gu)].length;
  const refusalSeats = [...source.matchAll(/allowDynamicReadContinuation: dynamicReadContinuationAllowed\(\),\n\s*admittedCompanionToolNames: citationGatherCompanionToolNames\(\),\n\s*adaptiveCodeInvestigationToolNames: adaptiveCodeInvestigationToolNames\(\),/gu)].length;
  const refusalCalls = [...source.matchAll(/allowDynamicReadContinuation: dynamicReadContinuationAllowed\(\),\n\s*admittedCompanionToolNames: citationGatherCompanionToolNames\(\),/gu)].length;
  assert.ok(menuSeats >= 2);
  assert.equal(refusalSeats, refusalCalls, "every refusal seat that may name dynamic reads names these too");
  assert.equal(menuWith, menuSeats + refusalSeats, "every menu seat carries the answer");
});
