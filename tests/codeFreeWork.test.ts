import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_FREE_BUDGET_LIMITS_V1,
  codeFreeSegmentStepLimitV1,
  CODE_FREE_WORK_NODE_ID_V1,
  CODE_PLAN_MAX_ITEMS_V1,
  createCodePlanToolOverlayV1,
  DEFAULT_CODE_FREE_BUDGET_V1,
  describeCodeFreeWorkLeftV1,
  normalizeCodeAutonomyV1,
  normalizeCodeFreeBudgetV1,
  parseCodePlanItemsV1,
  planCodeFreeWorkV1,
  renderCodePlanV1,
  type CodePlanItemV1,
} from "../src/agent/codeFreeWorkV1";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import {
  getMissionOpenWorkStateV1,
  MissionGraphSession,
  type MissionGraphToolExecution,
  type MissionGraphToolStartResult,
} from "../src/agent/missionGraphSession";
import { planMissionGraphV3 } from "../src/agent/missionGraphPlanner";
import {
  reduceMissionGraphPatchV1,
  validateMissionGraphV3,
  type MissionEvidenceRefV1,
  type MissionGraphV3,
  type MissionReceiptRefV1,
} from "../src/agent/missionGraphV3";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import type { ToolExecutionContext } from "../src/tools/types";
import { processTestVaultFile } from "./helpers/atomicTestVault";
import { createScriptedCodeWorkspace } from "./helpers/scriptedCodeWorkspace";

const GRAPH_TIME = new Date("2026-10-16T12:00:00.000Z");
const CLOSING = [
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_commit_verified",
];
const GUIDED_LADDER = [
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_patch",
  ...CLOSING,
];

test("code autonomy defaults to guided and only the word free selects the free pass", () => {
  assert.equal(normalizeCodeAutonomyV1(undefined), "guided");
  assert.equal(normalizeCodeAutonomyV1("guided"), "guided");
  assert.equal(normalizeCodeAutonomyV1("FREE"), "guided");
  assert.equal(normalizeCodeAutonomyV1(true), "guided");
  assert.equal(normalizeCodeAutonomyV1("free"), "free");
});

test("the free budget takes defaults for missing fields and clamps the rest", () => {
  assert.deepEqual(normalizeCodeFreeBudgetV1(undefined), DEFAULT_CODE_FREE_BUDGET_V1);
  assert.deepEqual(DEFAULT_CODE_FREE_BUDGET_V1, {
    toolCalls: 60,
    modelCalls: 80,
    tokens: 3_000_000,
    ms: 30 * 60_000,
  });
  assert.deepEqual(
    normalizeCodeFreeBudgetV1({ toolCalls: 1, modelCalls: 10_000, tokens: Number.NaN, ms: 90_000.7 }),
    {
      toolCalls: CODE_FREE_BUDGET_LIMITS_V1.toolCalls[0],
      modelCalls: CODE_FREE_BUDGET_LIMITS_V1.modelCalls[1],
      tokens: DEFAULT_CODE_FREE_BUDGET_V1.tokens,
      ms: 90_000,
    },
  );
  assert.deepEqual(CODE_FREE_BUDGET_LIMITS_V1, {
    toolCalls: [4, 400],
    modelCalls: [4, 400],
    tokens: [20_000, 20_000_000],
    ms: [60_000, 4 * 60 * 60_000],
  });
});

test("the free plan replaces the steps before the first validation and keeps the rest", () => {
  const available = new Set([...GUIDED_LADDER, "code_workspace_search", "code_workspace_trash", "code_repair_status"]);
  const plan = planCodeFreeWorkV1({ ladder: GUIDED_LADDER, available });
  assert.ok(plan);
  assert.deepEqual(plan.closing, CLOSING);
  assert.deepEqual(plan.menu, [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_workspace_patch",
    "code_workspace_trash",
    "code_validate_fast",
    "code_validate_targeted",
    "code_repair_status",
    "code_plan_update",
  ]);
  // Tools a later core or a host registers join the menu by being there.
  const later = planCodeFreeWorkV1({
    ladder: GUIDED_LADDER,
    available: new Set([...available, "code_workspace_apply_patch", "code_sandbox_run", "code_workspace_inspect"]),
  });
  assert.ok(later?.menu.includes("code_workspace_apply_patch"));
  assert.ok(later?.menu.includes("code_sandbox_run"));
  assert.ok(later?.menu.includes("code_workspace_inspect"));
  // What compaction set aside can be read back from the open node (CODE2-13).
  const recall = planCodeFreeWorkV1({
    ladder: GUIDED_LADDER,
    available: new Set([...available, "recall_tool_result"]),
  });
  assert.deepEqual(recall?.menu.slice(-2), ["recall_tool_result", "code_plan_update"]);
  // A ladder whose only write is an append is an implementation too.
  const appendLadder = GUIDED_LADDER.map((name) =>
    name === "code_workspace_patch" ? "code_workspace_append" : name,
  );
  const append = planCodeFreeWorkV1({
    ladder: appendLadder,
    available: new Set([...available, "code_workspace_append"]),
  });
  assert.ok(append, "an append-only ladder plans the open node");
  assert.deepEqual(append.closing, CLOSING);
  assert.ok(append.menu.includes("code_workspace_append"));
  assert.ok(append.menu.includes("code_workspace_patch"));
  // Not an implementation, or not a plain coding pass: plan it guided.
  assert.equal(planCodeFreeWorkV1({ ladder: ["code_sandbox_status", "code_validate_fast"], available }), null);
  assert.equal(planCodeFreeWorkV1({ ladder: ["code_workspace_patch"], available }), null);
  assert.equal(
    planCodeFreeWorkV1({ ladder: ["web_search", ...GUIDED_LADDER], available }),
    null,
  );
  assert.equal(
    planCodeFreeWorkV1({
      ladder: GUIDED_LADDER,
      available: new Set(GUIDED_LADDER.filter((name) => name !== "code_validate_targeted")),
    }),
    null,
  );
});

test("a plan is one to twenty short items with a known status", () => {
  const item = (index: number): CodePlanItemV1 => ({ text: `Step ${index}`, status: "pending" });
  assert.deepEqual(parseCodePlanItemsV1({ items: [{ text: "  Fix   it ", status: "done" }] }), {
    ok: true,
    items: [{ text: "Fix it", status: "done" }],
  });
  assert.equal(parseCodePlanItemsV1({ items: [] }).ok, false);
  assert.equal(parseCodePlanItemsV1({}).ok, false);
  assert.equal(
    parseCodePlanItemsV1({ items: Array.from({ length: CODE_PLAN_MAX_ITEMS_V1 }, (_, i) => item(i)) }).ok,
    true,
  );
  assert.equal(
    parseCodePlanItemsV1({ items: Array.from({ length: CODE_PLAN_MAX_ITEMS_V1 + 1 }, (_, i) => item(i)) }).ok,
    false,
  );
  assert.equal(parseCodePlanItemsV1({ items: [{ text: "x", status: "started" }] }).ok, false);
  assert.equal(parseCodePlanItemsV1({ items: [{ text: "x".repeat(201), status: "done" }] }).ok, false);
  assert.equal(parseCodePlanItemsV1({ items: [{ text: "   ", status: "done" }] }).ok, false);
  assert.equal(
    renderCodePlanV1([
      { text: "Read", status: "done" },
      { text: "Fix", status: "in_progress" },
      { text: "Check", status: "pending" },
    ]),
    "Plan recorded (1 of 3 done):\n[x] Read\n[>] Fix\n[ ] Check",
  );
  assert.equal(
    describeCodeFreeWorkLeftV1({
      items: [
        { text: "Read", status: "done" },
        { text: "Fix", status: "pending" },
      ],
      closing: ["code_validate_full", "code_commit_verified"],
    }),
    "Left on the plan: Fix. Then: code_validate_full, code_commit_verified.",
  );
  assert.equal(
    describeCodeFreeWorkLeftV1({ items: null, closing: [] }),
    "No plan was recorded.",
  );
});

test("the plan tool is invisible until a run activates it, then answers the list back", async () => {
  const base = new DefaultToolRegistry(
    createScriptedCodeWorkspace({ now: () => GRAPH_TIME, files: {}, check: () => ({ passed: true, diagnostic: "" }) }).tools,
  );
  const recorded: CodePlanItemV1[][] = [];
  const overlay = createCodePlanToolOverlayV1(base, (items) => recorded.push(items));
  const names = () => overlay.registry.getDefinitions().map((definition) => definition.function.name);
  assert.deepEqual(names(), base.getDefinitions().map((definition) => definition.function.name));
  assert.equal(overlay.registry.getDescriptor?.("code_plan_update"), null);
  const before = await overlay.registry.execute(
    { name: "code_plan_update", arguments: { items: [{ text: "x", status: "done" }] } },
    {} as ToolExecutionContext,
  );
  assert.equal(before.ok, false);
  assert.equal(recorded.length, 0);

  overlay.activate();
  assert.ok(names().includes("code_plan_update"));
  const descriptor = overlay.registry.getDescriptor?.("code_plan_update");
  assert.equal(descriptor?.effect, "read");
  assert.equal(descriptor?.execution.preparation, "none");
  const answer = await overlay.registry.execute(
    { name: "code_plan_update", arguments: { items: [{ text: "Fix offset()", status: "in_progress" }] } },
    {} as ToolExecutionContext,
  );
  assert.equal(answer.ok, true);
  assert.equal(answer.output, "Plan recorded (0 of 1 done):\n[>] Fix offset()");
  assert.deepEqual(recorded, [[{ text: "Fix offset()", status: "in_progress" }]]);
  const refused = await overlay.registry.execute(
    { name: "code_plan_update", arguments: { items: [] } },
    {} as ToolExecutionContext,
  );
  assert.equal(refused.ok, false);
  assert.equal(recorded.length, 1);
  // Every other tool still goes to the host's registry.
  const status = await overlay.registry.execute(
    { name: "code_sandbox_status", arguments: {} },
    {} as ToolExecutionContext,
  );
  assert.equal(status.ok, true);
});

async function freeGraph(options: {
  toolCalls?: number;
  missionId?: string;
  objective?: string;
  routerMode?: "off" | "authority";
} = {}): Promise<{
  graph: MissionGraphV3;
  menu: string[];
  host: Awaited<ReturnType<typeof buildHostMissionGraphPlanV1>>;
  fallbackReason: string | null;
  guided: Awaited<ReturnType<typeof buildHostMissionGraphPlanV1>>;
}> {
  const base = new DefaultToolRegistry(
    createScriptedCodeWorkspace({ now: () => GRAPH_TIME, files: {}, check: () => ({ passed: true, diagnostic: "" }) }).tools,
  );
  const overlay = createCodePlanToolOverlayV1(base, () => undefined);
  overlay.activate();
  const registry = overlay.registry;
  const installed = new Set(registry.getDefinitions().map((definition) => definition.function.name));
  const plan = planCodeFreeWorkV1({ ladder: GUIDED_LADDER, available: installed });
  assert.ok(plan);
  const missionId = options.missionId ?? "code-free-graph";
  const objective = options.objective ?? "Fix the pager's off-by-one in the trusted repository.";
  const input = {
    missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: [...new Set([...GUIDED_LADDER, ...plan.menu])],
    plannedToolNames: plan.closing,
    currentNotePath: null,
    maxToolCalls: 12,
    maxWallClockMs: 300_000,
    now: GRAPH_TIME,
  };
  const host = await buildHostMissionGraphPlanV1({
    ...input,
    codeFreeWork: {
      toolNames: plan.menu,
      toolCalls: options.toolCalls ?? 6,
      wallClockMs: 600_000,
    },
  });
  // The same closing steps without the open node, for comparison.
  const guided = await buildHostMissionGraphPlanV1(input);
  const planned = await planMissionGraphV3({
    mission: { missionId, objective },
    routerMode: options.routerMode ?? "off",
    capabilityEnvelope: host.capabilityEnvelope,
    deterministicProposal: host.deterministicProposal,
    allowedToolDescriptors: host.allowedToolDescriptors,
    // A free pass never asks the planner model: with it unavailable the
    // planner falls back to the host's own graph.
    modelClient: null,
    now: () => GRAPH_TIME.toISOString(),
  });
  return {
    graph: planned.graph,
    menu: plan.menu,
    host,
    fallbackReason: planned.fallbackReason ?? null,
    guided,
  };
}

test("the host plans one open node with the menu, then the closing steps that wait for it", async () => {
  const { graph, menu } = await freeGraph();
  validateMissionGraphV3(graph);
  const open = graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  assert.deepEqual(open.allowedTools, [...menu].sort());
  assert.deepEqual(open.inputs, {
    open_work: {
      kind: "literal",
      value: { version: 1, open: true, kind: "code_free_work", tools: [...menu].sort() },
    },
  });
  assert.equal(open.destination, null);
  assert.equal(open.status, "ready");
  assert.equal(open.budget.toolCalls, 6);
  assert.equal(open.budget.externalActions, 0);
  assert.equal(open.effect, "execution");
  assert.ok(open.resourceLocks.length > 0);
  assert.ok(open.resourceLocks.every((lock) => lock.mode === "exclusive"));
  assert.deepEqual(open.completionContract.requiredEvidenceKinds, ["open-work-done"]);
  // The open node's calls come on top of what a guided graph of the same
  // request gets (12 here), so the closing nodes keep their reserve.
  assert.equal(graph.capabilityEnvelope.budgets.maxTotalToolCalls, 12 + 6);
  assert.equal(graph.capabilityEnvelope.budgets.maxNodes, 12 + 2);
  assert.equal(graph.capabilityEnvelope.budgets.maxExternalActions, 0);
  const closing = Object.values(graph.nodes)
    .filter((node) => node.id !== open.id && node.id !== "final")
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(closing.map((node) => node.allowedTools[0]), CLOSING);
  for (const node of Object.values(graph.nodes)) {
    if (node.id === open.id) continue;
    assert.ok(node.dependencyIds.includes(open.id), `${node.id} waits for the open node`);
    assert.equal(node.status, "queued");
  }
});

test("a pass whose words name its checks still plans the open node when the planner model is unavailable", async () => {
  // RAP's feature pass says "Then run distinct targeted and fresh full
  // sandbox validation". Its closing steps are all validation tools, and on
  // their own they plan as one lifecycle-code_validation node, which once
  // left a free pass with no open node and no code tool to call.
  const objective = [
    "Coding pass (feature) for the project “Site”, in the trusted repository site-repo (in its durable workspace).",
    "You are done when a targeted validation passes after your last edit; the full validation and the verified commit follow.",
    "Use at most three edit and fast-validation repair cycles. Then run distinct targeted and fresh full sandbox validation, and make one verified commit with the exact durable validation receipt ids.",
  ].join("\n");
  const { graph, host, guided, fallbackReason } = await freeGraph({ objective, routerMode: "authority" });
  assert.notEqual(guided.projectLifecycleIntent, null, "the closing steps alone read as a validation lifecycle");
  assert.equal(host.projectLifecycleIntent, null);
  assert.equal(fallbackReason, "structured_model_unavailable");
  validateMissionGraphV3(graph);
  assert.ok(graph.nodes[CODE_FREE_WORK_NODE_ID_V1], "the host's fallback graph has the open node");
  assert.deepEqual(Object.keys(graph.nodes).filter((id) => id.startsWith("lifecycle-")), []);
  const closing = Object.values(graph.nodes)
    .filter((node) => node.id !== CODE_FREE_WORK_NODE_ID_V1 && node.id !== "final")
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(closing.map((node) => node.allowedTools), CLOSING.map((name) => [name]));
  for (const node of closing) {
    assert.ok(node.dependencyIds.includes(CODE_FREE_WORK_NODE_ID_V1), `${node.id} waits for the open node`);
  }
});

test("the reducer refuses an open node that widens its authority", async () => {
  const { graph } = await freeGraph({ missionId: "code-free-authority" });
  const open = graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  const tampered = structuredClone(graph);
  tampered.nodes[open.id]!.allowedTools = [...open.allowedTools, "web_fetch"].sort();
  assert.throws(() => validateMissionGraphV3(tampered));
  const spec = structuredClone(graph);
  (spec.nodes[open.id]!.inputs.open_work as unknown as { value: { tools: string[] } }).value.tools = ["code_workspace_read"];
  assert.throws(() => validateMissionGraphV3(spec));
  await assert.rejects(
    reduceMissionGraphPatchV1(graph, {
      version: 1,
      patchId: "code-free-widen",
      missionId: graph.missionId,
      baseRevision: graph.revision,
      baseJournalFingerprint: graph.journalHeadFingerprint,
      proposedAt: GRAPH_TIME.toISOString(),
      reason: "Try to widen the open node.",
      operations: [
        {
          op: "update_node",
          nodeId: open.id,
          changes: {
            inputs: {
              open_work: {
                kind: "literal",
                value: { version: 1, open: true, kind: "code_free_work", tools: ["code_workspace_read"] },
              },
            },
          },
        },
      ],
    }),
  );
});

function vaultContext(): ToolExecutionContext {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let nowMs = GRAPH_TIME.getTime();
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
      if (files.has(path)) throw new Error(`File already exists: ${path}`);
      files.set(path, content);
      return getFile(path);
    },
    read: async (file: { path: string }) => files.get(file.path) ?? "",
    process: function (file: any, transform: (content: string) => string): Promise<string> {
      return processTestVaultFile(this, file, transform);
    },
    modify: async (file: { path: string }, content: string) => {
      files.set(file.path, content);
    },
  };
  return {
    app: { vault },
    settings: {},
    originalPrompt: "code free work fixture",
    httpTransport: {},
    now: () => {
      const now = new Date(nowMs);
      nowMs += 1_000;
      return now;
    },
  } as unknown as ToolExecutionContext;
}

function started(result: MissionGraphToolStartResult): MissionGraphToolExecution {
  if (!result.ok) throw new Error(result.reason);
  return result.execution;
}

const sha = (character: string) => `sha256:${character.repeat(64)}`;
let evidenceCounter = 0;
function evidence(kind = "tool-result"): MissionEvidenceRefV1 {
  evidenceCounter += 1;
  return {
    id: `evidence-open-${evidenceCounter}`,
    kind,
    fingerprint: sha("e"),
    observedAt: GRAPH_TIME.toISOString(),
  };
}

async function openSession(toolCalls = 8, missionId = "code-free-session") {
  const { graph } = await freeGraph({ toolCalls, missionId });
  return MissionGraphSession.open({ context: vaultContext(), initialGraph: graph });
}

test("the open node stays ready between calls and completes only after a targeted pass with no edit since", async () => {
  const session = await openSession(8, "code-free-complete");
  const call = async (
    toolName: string,
    result: Parameters<MissionGraphSession["finishToolExecution"]>[1],
  ) => {
    const execution = started(await session.beginToolExecution(toolName));
    assert.equal(execution.nodeId, CODE_FREE_WORK_NODE_ID_V1);
    await session.finishToolExecution(execution, result);
    return session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  };
  let node = await call("code_workspace_read", { ok: true, evidence: evidence() });
  assert.equal(node.status, "ready");
  assert.equal(node.retries.attempts, 0, "calls are not attempts at one action");

  const early = await session.completeOpenWork({ nodeId: node.id, evidence: evidence("open-work-done") });
  assert.equal(early.ok, false);

  node = await call("code_workspace_patch", { ok: true, evidence: evidence(), openWork: { write: true } });
  node = await call("code_validate_targeted", {
    ok: false,
    failureFingerprint: sha("a"),
    failureMessage: "code_validate_targeted completed red.",
    openWork: { validationFailed: true },
  });
  assert.equal(node.status, "ready", "a red check is the model's to correct");
  node = await call("code_validate_targeted", { ok: true, evidence: evidence(), openWork: { targetedPassed: true } });
  node = await call("code_workspace_patch", { ok: true, evidence: evidence(), openWork: { write: true } });
  const afterEdit = await session.completeOpenWork({ nodeId: node.id, evidence: evidence("open-work-done") });
  assert.equal(afterEdit.ok, false, "an edit after the passing check reopens the debt");

  node = await call("code_validate_targeted", {
    ok: true,
    evidence: evidence(),
    openWork: {
      targetedPassed: true,
      spent: { modelCalls: 6, tokens: 1200, ms: 4000 },
    },
  });
  const state = getMissionOpenWorkStateV1(node);
  assert.deepEqual(
    { calls: state.calls, lastWriteCall: state.lastWriteCall, lastTargetedPassCall: state.lastTargetedPassCall },
    { calls: 6, lastWriteCall: 5, lastTargetedPassCall: 6 },
  );
  assert.deepEqual(state.spent, { modelCalls: 6, tokens: 1200, ms: 4000 });
  assert.deepEqual(state.failures, [{ fingerprint: sha("a"), count: 1 }]);

  const done = await session.completeOpenWork({ nodeId: node.id, evidence: evidence("open-work-done") });
  assert.equal(done.ok, true);
  assert.equal(session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!.status, "complete");
  const fast = Object.values(session.graph.nodes).find(
    (candidate) =>
      candidate.id !== CODE_FREE_WORK_NODE_ID_V1 &&
      candidate.allowedTools.includes("code_validate_fast"),
  );
  assert.equal(fast?.status, "ready", "the closing steps start once the open node is done");
});

test("the same validation failure surviving two corrections stops the open node", async () => {
  const session = await openSession(12, "code-free-unchanged");
  const red = async () => {
    const execution = started(await session.beginToolExecution("code_validate_targeted"));
    await session.finishToolExecution(execution, {
      ok: false,
      failureFingerprint: sha("b"),
      failureMessage: "code_validate_targeted completed red.",
      openWork: { validationFailed: true },
    });
  };
  const edit = async () => {
    const execution = started(await session.beginToolExecution("code_workspace_patch"));
    await session.finishToolExecution(execution, { ok: true, evidence: evidence(), openWork: { write: true } });
  };
  await red();
  await edit();
  await red();
  assert.equal(session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!.status, "ready");
  await edit();
  await red();
  const node = session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  assert.equal(node.status, "blocked");
  assert.equal(node.blocker?.code, "unchanged_failure");
});

test("the same tool failure twice in a row stops the open node, as it stops any node", async () => {
  const session = await openSession(12, "code-free-repeated");
  for (let index = 0; index < 2; index += 1) {
    const execution = started(await session.beginToolExecution("code_workspace_read"));
    await session.finishToolExecution(execution, {
      ok: false,
      failureFingerprint: sha("c"),
      failureMessage: "No file src/missing.py in the workspace.",
    });
  }
  const node = session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  assert.equal(node.status, "blocked");
  assert.equal(node.blocker?.code, "tool_failure_repeated");
});

test("a call that repeats an action the open node holds proof of keeps the first proof and goes on", async () => {
  // Live on muse-spark-open and mistral-large-4, a pass attached the person's workspace twice. The receipt is named by
  // its prepared action, which is named by the arguments and the state they expect, so the second was named as the
  // first; it differed only in when it was taken and that it said it reconciled. Appending it failed the graph and
  // ended the pass.
  const session = await openSession(12, "code-free-repeated-receipt");
  const receipt: MissionReceiptRefV1 = {
    id: "workspace-create-prepared-code_workspace_create-da95d62ae07113d5",
    kind: "workspace",
    fingerprint: sha("d"),
    committedAt: GRAPH_TIME.toISOString(),
  };
  const attach = async (ref: MissionReceiptRefV1, proof: MissionEvidenceRefV1) => {
    const execution = started(await session.beginToolExecution("code_workspace_create"));
    return session.finishToolExecution(execution, { ok: true, receipt: ref, evidence: proof });
  };
  const seen = evidence();
  await attach(receipt, seen);
  await attach({ ...receipt }, { ...seen });
  // The reconciling repeat, as the code extension writes it: the same id, its own time and fingerprint.
  await attach({ ...receipt, fingerprint: sha("f"), committedAt: new Date(GRAPH_TIME.getTime() + 5_000).toISOString() }, { ...seen, fingerprint: sha("a") });
  const node = session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  assert.equal(node.status, "ready", "the pass goes on");
  assert.deepEqual(node.receipts.filter((item) => item.id === receipt.id), [receipt], "the first is kept, once");
  assert.deepEqual(node.evidence.filter((item) => item.id === seen.id), [seen]);
  assert.equal(getMissionOpenWorkStateV1(node).calls, 3, "every call is counted");
});

test("the open node stops when its tool calls are spent, and on a budget the host counts", async () => {
  const session = await openSession(4, "code-free-budget");
  for (let index = 0; index < 4; index += 1) {
    const execution = started(await session.beginToolExecution("code_workspace_read"));
    await session.finishToolExecution(execution, { ok: true, evidence: evidence() });
  }
  const node = session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  assert.equal(node.status, "blocked");
  assert.equal(node.blocker?.code, "open_work_budget_exhausted");

  const other = await openSession(8, "code-free-host-budget");
  const blocked = await other.blockOpenWork({
    nodeId: CODE_FREE_WORK_NODE_ID_V1,
    blocker: {
      code: "open_work_budget_exhausted",
      message: "The open work node used its 80 model calls.",
      requiredAction: "Continue with a larger budget, or finish the work by hand.",
    },
  });
  assert.equal(blocked?.nodes[CODE_FREE_WORK_NODE_ID_V1]?.status, "blocked");
});

test("a refused approval inside the open node refuses that action, not the work", async () => {
  const session = await openSession(8, "code-free-denied");
  const execution = started(await session.beginToolExecution("code_workspace_trash"));
  await session.waitForToolApproval(execution);
  assert.equal(session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!.status, "waiting_approval");
  await session.resolveToolApproval(execution, "denied");
  const node = session.graph.nodes[CODE_FREE_WORK_NODE_ID_V1]!;
  assert.equal(node.status, "ready");
  assert.equal(node.blocker, null);
});

test("a free segment's step limit is the open node's model calls left and the closing steps' allowance (CODE2-2)", () => {
  // Past the runner's 100-step cap: a deep and an extended budget are reachable.
  assert.equal(codeFreeSegmentStepLimitV1({ budget: { modelCalls: 240 }, spentModelCalls: 0, closingCount: 6 }), 256);
  assert.equal(codeFreeSegmentStepLimitV1({ budget: { modelCalls: 400 }, spentModelCalls: 0, closingCount: 6 }), 416);
  // A continuation gets what the node has left, never less than one step.
  assert.equal(codeFreeSegmentStepLimitV1({ budget: { modelCalls: 240 }, spentModelCalls: 200, closingCount: 6 }), 56);
  assert.equal(codeFreeSegmentStepLimitV1({ budget: { modelCalls: 40 }, spentModelCalls: 90, closingCount: 0 }), 4);
});
