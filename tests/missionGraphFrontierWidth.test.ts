/**
 * How wide is the offered frontier on a real compound mission, and is that
 * width a defect?
 *
 * The dominant recorded tool-call failure is `tool_not_allowed` (39 of 48), and
 * the surviving transcripts contain ZERO invented tool names — nine of ten
 * recovered refusals were real, correctly-named product tools refused because
 * no ready slot existed. The compound lane's own instrumentation says
 * `toolsOffered: {avg: 1.64, max: 6}`. This file reproduces that at unit level
 * and answers the question the number poses.
 *
 * VERDICT (see the ordering test below for the evidence): the width is CORRECT.
 * A compound plan is a linear list of steps and `buildToolNodeProposals` gives
 * every effectful node a dependency on the immediately preceding effectful
 * node, so an eleven-step mission offers exactly one tool eleven times. Both
 * plausible relaxations break real ordering, and the tests here pin the
 * orderings that a future widening must not break.
 *
 * The DEFECT is the steering: a model offered one tool was told nothing about
 * the other ten, so it reached for the one the user had actually asked for.
 * `append_to_current_file` — node ELEVEN — was refused at steps 1, 2, 4, 5, 6,
 * 8 and 9 of one live run. No admissible frontier widening would have admitted
 * it; only being told to wait would have stopped it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import { planMissionGraphV3 } from "../src/agent/missionGraphPlanner";
import {
  buildMissionGraphFrontierTurnContext,
  constrainToolsToMissionGraphFrontier,
  formatMissionGraphPlannedSequenceLineV1,
} from "../src/agent/missionGraphFrontier";
import { missionGraphPlannedSequenceAfterFrontierV1 } from "../src/agent/missionGraphSelectors";
import {
  MissionGraphSession,
  type MissionGraphToolExecution,
  type MissionGraphToolStartResult,
} from "../src/agent/missionGraphSession";
import {
  getCurrentMissionCompositeLifecycleActionV1,
  getMissionCompositeLifecycleSpecV1,
  type MissionGraphV3,
  type MissionNodeV3,
} from "../src/agent/missionGraphV3";
import { descriptorFor } from "../src/tools/toolDescriptors";
import type { ToolDescriptor } from "../src/agent/actions";
import type { ToolExecutionContext, ToolRegistry } from "../src/tools/types";
import type { ModelToolDefinition } from "../src/model/types";

const GRAPH_TIME = new Date("2026-07-11T18:00:00.000Z");

/**
 * The mission the measurement came from: web research, publish to Linear,
 * create a workspace, write code, validate three times, commit, publish to
 * GitHub, write a reflection.
 */
const COMPOUND_PLAN = [
  "web_search",
  "web_fetch",
  "publish_research_to_linear",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_commit_verified",
  "github_publish_repository",
  "append_to_current_file",
] as const;

const COMPOUND_ALLOWED = [
  ...COMPOUND_PLAN,
  "read_current_file",
  "list_markdown_files",
  "read_file",
  "code_workspace_read",
];

type StepReading = {
  step: number;
  offered: string[];
  readyNodeIds: string[];
};

test("a compound mission offers exactly one tool at every one of its eleven steps", async () => {
  const graph = await compoundGraph("frontier-width-compound");
  const harness = createVaultHarness();
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const readings = await walkFrontier(session, harness);

  // The per-step reproduction, verbatim. Anything that changes this list is
  // changing when the mission is allowed to do its effectful work.
  assert.deepEqual(
    readings.map((reading) => reading.offered),
    [
      ["web_search"],
      ["web_fetch"],
      ["publish_research_to_linear"],
      ["code_workspace_create"],
      ["code_workspace_create_file"],
      ["code_validate_fast"],
      ["code_validate_targeted"],
      ["code_validate_full"],
      ["code_commit_verified"],
      ["github_publish_repository"],
      ["append_to_current_file"],
    ],
  );

  const widths = readings.map((reading) => reading.offered.length);
  const average = widths.reduce((total, width) => total + width, 0) / widths.length;
  assert.equal(widths.length, COMPOUND_PLAN.length);
  assert.equal(Math.max(...widths), 1, "max offered-set width");
  assert.equal(average, 1, "average offered-set width");
});

/**
 * The two relaxations that would widen the frontier, and why neither is
 * admissible. Read the pinned orderings as the contract a future widening owes:
 * these edges are load-bearing, and a wider frontier that breaks one of them is
 * the duplication side of the deadlock/duplication trade, not a fix.
 */
test("the serialization that makes the frontier one wide is load-bearing", async () => {
  const graph = await compoundGraph("frontier-width-ordering");
  const nodeFor = (toolName: string): MissionNodeV3 => {
    const node = Object.values(graph.nodes).find(
      (candidate) =>
        candidate.id !== "final" && candidate.allowedTools.includes(toolName),
    );
    assert.ok(node, `missing node for ${toolName}`);
    return node;
  };
  const dependsOn = (toolName: string, prerequisiteTool: string): boolean =>
    nodeFor(toolName).dependencyIds.includes(nodeFor(prerequisiteTool).id);

  // Rule A — every effectful node waits for ALL prior planned reads. Drop it
  // and `publish_research_to_linear` becomes ready at step 1, publishing
  // "accepted research" before a single source has been read.
  assert.equal(dependsOn("publish_research_to_linear", "web_search"), true);
  assert.equal(dependsOn("publish_research_to_linear", "web_fetch"), true);

  // Rule B — every effectful node waits for the previous effectful node. Drop
  // it in favour of per-binding serialization and the two cross-system edges
  // that carry the mission's real order vanish: GitHub publication would become
  // ready before the workspace exists (nothing else binds it to the code), and
  // the reflection append would become ready before there is anything to
  // reflect on. Neither edge is recoverable from `bindingId` or `effect`, which
  // is why the global chain has to stay.
  assert.equal(dependsOn("github_publish_repository", "code_commit_verified"), true);
  assert.equal(dependsOn("append_to_current_file", "github_publish_repository"), true);
  assert.equal(dependsOn("code_validate_fast", "code_workspace_create_file"), true);
  assert.equal(dependsOn("code_workspace_create_file", "code_workspace_create"), true);
});

/**
 * THE discriminating test. Before the planned-sequence line existed, the exact
 * one-tool frontier told the model `web_search` and nothing else: the routing
 * card is gated on `setLooseCompoundEnabled` and is null here, `preferredNext`
 * only ever names something already on the menu, and the hand-written "later
 * frontiers will open…" paragraphs in `buildMissionGraphFrontierTurnContext`
 * cover seven hard-coded names — two of this mission's eleven steps.
 */
test("a one-tool frontier tells the model the rest of the planned sequence", async () => {
  const graph = await compoundGraph("frontier-width-steering");
  const offered = constrainToolsToMissionGraphFrontier(
    schemasFor(COMPOUND_ALLOWED),
    graph,
    { includeCapabilityReads: false, allowDynamicReadContinuation: false },
  );
  assert.deepEqual(
    offered.map((tool) => tool.function.name),
    ["web_search"],
    "precondition: the frontier really is one tool wide",
  );

  const context = buildMissionGraphFrontierTurnContext(offered, null, { graph });

  // The mission's last step is the one the live run reached for seven times.
  assert.match(context, /PLANNED SEQUENCE/u);
  assert.match(context, /append_to_current_file/u);
  assert.match(context, /code_commit_verified/u);
  assert.match(context, /github_publish_repository/u);
  // And it must say, in the same breath, that none of them are callable — a
  // "later" list that reads as a menu is the over-reporting defect the
  // authoritative-refusal seats were built to end.
  assert.match(context, /None of those are callable yet/u);
  assert.match(context, /Callable on this turn: web_search/u);
});

test("the planned sequence names only what the authority will refuse right now", async () => {
  const graph = await compoundGraph("frontier-width-disjoint");
  const later = missionGraphPlannedSequenceAfterFrontierV1(graph);
  const ready = constrainToolsToMissionGraphFrontier(
    schemasFor(COMPOUND_ALLOWED),
    graph,
    { includeCapabilityReads: false, allowDynamicReadContinuation: false },
  ).map((tool) => tool.function.name);

  assert.deepEqual(ready, ["web_search"]);
  // Dependency order, not catalog or alphabetical order.
  assert.deepEqual(later, [
    "web_fetch",
    "publish_research_to_linear",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_commit_verified",
    "github_publish_repository",
    "append_to_current_file",
  ]);
  // Disjoint from the callable set, by construction.
  for (const name of ready) {
    assert.equal(later.includes(name), false, `${name} is both ready and later`);
  }
});

test("the planned sequence shrinks as the mission is paid down, and fails closed", async () => {
  const graph = await compoundGraph("frontier-width-shrink");
  const harness = createVaultHarness();
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const lengths: number[] = [];
  await walkFrontier(session, harness, () => {
    lengths.push(missionGraphPlannedSequenceAfterFrontierV1(session.graph).length);
  });

  // One entry per offered step: the queue behind the frontier drains to empty.
  assert.deepEqual(lengths, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  // Exhausted mission: nothing pending, so nothing is claimed.
  assert.equal(missionGraphPlannedSequenceAfterFrontierV1(session.graph).length, 0);
  assert.equal(missionGraphPlannedSequenceAfterFrontierV1(null).length, 0);
  assert.equal(
    formatMissionGraphPlannedSequenceLineV1({
      readyToolNames: ["web_search"],
      laterToolNames: [],
    }),
    null,
  );
  assert.equal(
    formatMissionGraphPlannedSequenceLineV1({
      readyToolNames: [],
      laterToolNames: ["append_to_current_file"],
    }),
    null,
    "no callable tool means no steering line, never a bare list of refusals",
  );
});

test("steering never widens the offered menu", async () => {
  const graph = await compoundGraph("frontier-width-no-widening");
  const withGraph = constrainToolsToMissionGraphFrontier(
    schemasFor(COMPOUND_ALLOWED),
    graph,
    { includeCapabilityReads: false, allowDynamicReadContinuation: false },
  ).map((tool) => tool.function.name);
  const context = buildMissionGraphFrontierTurnContext(
    schemasFor(withGraph),
    null,
    { graph },
  );
  const withoutGraph = buildMissionGraphFrontierTurnContext(
    schemasFor(withGraph),
    null,
    {},
  );
  // The menu is `stepTools`, and the graph option cannot touch it.
  assert.deepEqual(withGraph, ["web_search"]);
  // The only difference the graph makes is prose.
  assert.equal(withoutGraph.includes("PLANNED SEQUENCE"), false);
  assert.equal(context.includes("PLANNED SEQUENCE"), true);
  assert.equal(
    context.replace(/PLANNED SEQUENCE[\s\S]*?\n(?=[A-Z])/u, "").length <
      context.length,
    true,
  );
});

/**
 * A composite lifecycle node is a whole stage, and the ready-frontier selector
 * deliberately reports only its current action. Reusing that answer for the
 * planned sequence would have told a mission owing seven more actions that it
 * owed one — a count the model can check against the user's own request and
 * disbelieve. Expand from the durable action cursor instead.
 */
test("a composite lifecycle stage contributes its remaining actions, not just its next one", async () => {
  const planned = [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_validate_fast",
    "code_repair_record_cycle",
    "code_validate_targeted",
    "code_validate_full",
    "code_workspace_export_directory",
  ];
  const allowed = [...planned, "code_workspace_read", "code_workspace_write_expected"];
  const objective = "write a number guessing game in Python on my desktop";
  const host = await buildHostMissionGraphPlanV1({
    missionId: "frontier-width-composite",
    objective,
    toolRegistry: registryFor(allowed),
    allowedToolNames: allowed,
    modelVisibleToolNames: allowed,
    plannedToolNames: planned,
    maxToolCalls: 30,
    maxWallClockMs: 600_000,
    now: GRAPH_TIME,
  });
  const graph = (
    await planMissionGraphV3({
      mission: { missionId: "frontier-width-composite", objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;

  // Precondition: this really is the composite shape, two stage nodes wide.
  assert.ok(graph.nodes["lifecycle-code_execution"]);
  assert.ok(graph.nodes["lifecycle-code_validation"]);
  const offered = constrainToolsToMissionGraphFrontier(schemasFor(allowed), graph, {
    includeCapabilityReads: false,
    allowDynamicReadContinuation: false,
  }).map((tool) => tool.function.name);
  assert.deepEqual(offered, ["code_sandbox_status"]);

  assert.deepEqual(missionGraphPlannedSequenceAfterFrontierV1(graph), [
    // Rest of the live stage, from its action cursor.
    "code_workspace_create",
    "code_workspace_create_file",
    "code_workspace_export_directory",
    // Then the queued stage.
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    // code_repair_record_cycle is conditional on fast validation going red, so
    // the mission does not owe it and the sequence must not promise it.
  ]);
});

test("a set-loose turn keeps its stage-local projection unchanged", async () => {
  const graph = await compoundGraph("frontier-width-set-loose");
  const setLoose = buildMissionGraphFrontierTurnContext(
    schemasFor(["web_search"]),
    null,
    { graph, setLoose: true, currentStage: "accepted_research" },
  );
  // Set-loose turns deliberately stay stage-local; widening THAT surface is a
  // separate change with its own compactness budget.
  assert.equal(setLoose.includes("PLANNED SEQUENCE"), false);
  assert.match(setLoose, /exactly one tool call in this response/u);
  assert.match(setLoose, /stale authority/u);
});

async function walkFrontier(
  session: MissionGraphSession,
  harness: { nextTimestamp: () => string },
  beforeEachStep?: () => void,
): Promise<StepReading[]> {
  const catalog = schemasFor(COMPOUND_ALLOWED);
  const readings: StepReading[] = [];
  for (let step = 1; step <= 40; step += 1) {
    const offered = constrainToolsToMissionGraphFrontier(catalog, session.graph, {
      includeCapabilityReads: false,
      allowDynamicReadContinuation: false,
    }).map((tool) => tool.function.name);
    if (offered.length === 0) break;
    beforeEachStep?.();
    readings.push({
      step,
      offered,
      readyNodeIds: Object.values(session.graph.nodes)
        .filter((node) => node.status === "ready")
        .map((node) => node.id),
    });
    const started = await session.beginToolExecution(offered[0]!);
    const execution = requireExecution(started);
    const node = session.graph.nodes[execution.nodeId]!;
    await session.finishToolExecution(
      execution,
      proofFor(node, "0123456789abcdef"[step % 16]!, harness.nextTimestamp()),
    );
  }
  return readings;
}

async function compoundGraph(missionId: string): Promise<MissionGraphV3> {
  const objective =
    "Research the topic on the web, publish the plan to Linear, create a code " +
    "workspace, write the code, validate it three times, commit it, publish it " +
    "to a private GitHub repository, and append a reflection to my note.";
  const host = await buildHostMissionGraphPlanV1({
    missionId,
    objective,
    toolRegistry: registryFor(COMPOUND_ALLOWED),
    allowedToolNames: COMPOUND_ALLOWED,
    modelVisibleToolNames: COMPOUND_ALLOWED,
    plannedToolNames: [...COMPOUND_PLAN],
    currentNotePath: "Research/Brief.md",
    maxToolCalls: 60,
    maxWallClockMs: 1_800_000,
    now: GRAPH_TIME,
  });
  return (
    await planMissionGraphV3({
      mission: { missionId, objective },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

function schemasFor(names: readonly string[]): ModelToolDefinition[] {
  return names.map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: name,
      parameters: { type: "object" as const },
    },
  })) as unknown as ModelToolDefinition[];
}

function registryFor(names: readonly string[]): ToolRegistry {
  const byName = new Map(
    names.map((name) => [name, descriptorForCompoundTool(name)] as const),
  );
  return {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name: string) => byName.get(name) ?? null,
    execute: async (call: { name: string }) => ({ ok: true, toolName: call.name }),
  } as unknown as ToolRegistry;
}

function descriptorForCompoundTool(name: string): ToolDescriptor {
  if (name.startsWith("linear_") || name === "publish_research_to_linear") {
    return externalDescriptor(name, "linear", "issue", "linear_issue");
  }
  if (name.startsWith("github_")) {
    return externalDescriptor(name, "github", "repository", "github_repository");
  }
  if (name.startsWith("code_")) {
    return workspaceDescriptor(name);
  }
  return descriptorFor(name);
}

function workspaceDescriptor(name: string): ToolDescriptor {
  const readOnly = name === "code_workspace_read" || name === "code_sandbox_status";
  return {
    version: 1,
    name,
    capability: {
      system: "workspace",
      resourceType: "workspace_file",
      action: readOnly ? "read" : "update",
    },
    effect: readOnly ? "read" : "reversible_mutation",
    risk: readOnly ? "low" : "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: readOnly,
      fallback: readOnly ? "none" : "exact",
    },
    execution: {
      preparation: readOnly ? "none" : "required",
      cacheable: readOnly,
      parallelSafe: readOnly,
    },
    durability: {
      journal: !readOnly,
      receipt: !readOnly,
      readback: readOnly ? "none" : "required",
      reconciliation: readOnly ? "none" : "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    ...(readOnly ? {} : { receiptKind: "code_change" as const }),
  } as ToolDescriptor;
}

function externalDescriptor(
  name: string,
  system: string,
  resourceType: string,
  receiptKind: string,
): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system, resourceType, action: "create" },
    effect: "external_action",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
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
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind,
  } as unknown as ToolDescriptor;
}

function proofFor(node: MissionNodeV3, character: string, observedAt: string) {
  const lifecycle =
    node.inputs && (node.inputs as Record<string, unknown>).lifecycle
      ? getMissionCompositeLifecycleSpecV1(node)
      : null;
  const action = lifecycle
    ? getCurrentMissionCompositeLifecycleActionV1(node)
    : null;
  const evidenceKinds = action
    ? action.requiredEvidenceKinds
    : node.completionContract.requiredEvidenceKinds;
  const receiptKinds = action
    ? action.requiredReceiptKinds
    : node.completionContract.requiredReceiptKinds;
  const minimumReceipts = action
    ? action.minimumReceipts
    : node.completionContract.minimumReceipts;
  return {
    ok: true as const,
    evidence: {
      id: `evidence-${node.id}-${character}`.slice(0, 128),
      kind: evidenceKinds[0] ?? "tool-result",
      fingerprint: fp(character),
      observedAt,
    },
    ...(minimumReceipts > 0
      ? {
          receipt: {
            id: `receipt-${node.id}-${character}`.slice(0, 128),
            kind: receiptKinds[0] ?? "action-receipt",
            fingerprint: fp(character),
            committedAt: observedAt,
          },
        }
      : {}),
  };
}

function requireExecution(
  result: MissionGraphToolStartResult,
): MissionGraphToolExecution {
  if (!result.ok) throw new Error(result.reason);
  return result.execution;
}

function createVaultHarness(): {
  context: ToolExecutionContext;
  nextTimestamp: () => string;
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let nowMs = Date.parse("2026-07-11T19:00:00.000Z");
  const nextDate = () => {
    const now = new Date(nowMs);
    nowMs += 1_000;
    return now;
  };
  const getFile = (path: string) =>
    files.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null;
  const vault = {
    getFileByPath: getFile,
    getFolderByPath: (path: string) =>
      folders.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null,
    createFolder: async (path: string) => {
      folders.add(path);
    },
    create: async (path: string, content: string) => {
      files.set(path, content);
      return getFile(path);
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    modify: async (file: { path: string }, content: string) => {
      files.set(file.path, content);
    },
  };
  return {
    nextTimestamp: () => nextDate().toISOString(),
    context: {
      app: { vault },
      settings: {},
      originalPrompt: "compound frontier width fixture",
      httpTransport: {},
      now: nextDate,
    } as unknown as ToolExecutionContext,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
