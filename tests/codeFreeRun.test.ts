import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAgentMission, type AgentRunCompleteEvent } from "../src/AgentRunner";
import type { MissionGraphV3 } from "../src/agent/missionGraphV3";
import type { CodePlanUpdateEventV1 } from "../src/agent/codeFreeWorkV1";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import { __setCodeToolsDesktopAppForTests } from "../src/tools/codeTools";
import { createScriptedCodeWorkspace } from "./helpers/scriptedCodeWorkspace";
import {
  autoApprovals,
  codePassPromptV1,
  GUIDED_PASS_STEPS_V1,
  scriptedCodeModel,
  scriptedRunContext,
  scriptedRunSettings,
} from "./helpers/scriptedCodeRun";

/*
 * CODE-18's core half, driven end to end through the real runner, the real
 * mission graph and its session, with a scripted model and an in-memory code
 * workspace whose tools prepare, fingerprint and receipt every write as the
 * code extension's do. A guided pass must plan exactly as it did before; a
 * free pass works in one open node and then runs the guided closing steps.
 */

const BUGGY = "def offset(page, size):\n    return page * size + 1\n";
const FIXED = "def offset(page, size):\n    return page * size\n";
const WORKSPACE = "code-pager-1";
const OBJECTIVE = "offset() is off by one for zero-based pages; fix it.";
const CLOSING = [
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_commit_verified",
];

type Call = { name: string; arguments: Record<string, unknown> };

function call(name: string, args: Record<string, unknown> = {}): Call {
  return { name, arguments: { workspaceId: WORKSPACE, ...args } };
}

async function runPass(input: {
  steps: readonly string[];
  options?: Record<string, unknown>;
  decide: (offered: string[]) => { calls: Call[] } | { content: string };
}) {
  const now = () => new Date("2026-10-16T12:00:00.000Z");
  const prompt = codePassPromptV1(OBJECTIVE, input.steps);
  const workspace = createScriptedCodeWorkspace({
    now,
    files: { "src/pager.py": BUGGY, "tests/test_pager.py": "assert offset(0, 10) == 0\n" },
    check: (files) => {
      const passed = files.get("src/pager.py") === FIXED;
      return {
        passed,
        diagnostic: passed
          ? "1 passed"
          : `tests/test_pager.py:1 AssertionError: ${files.get("src/pager.py")?.trim()}`,
      };
    },
  });
  const { context } = scriptedRunContext({
    prompt,
    now,
    settings: scriptedRunSettings({ maxAgentSteps: 60 }),
  });
  const model = scriptedCodeModel(({ offered }) => input.decide(offered));
  const approvals = autoApprovals();
  const graphs: MissionGraphV3[] = [];
  const plans: CodePlanUpdateEventV1[] = [];
  const answers: string[] = [];
  let complete: AgentRunCompleteEvent | null = null;
  __setCodeToolsDesktopAppForTests(true);
  try {
    await runAgentMission({
      prompt,
      runId: "run-code-free",
      modelClient: model.client,
      toolRegistry: new DefaultToolRegistry(workspace.tools),
      toolContext: context,
      enableStreaming: false,
      interactiveApprovals: true,
      approvalBroker: approvals.broker,
      ...input.options,
      events: {
        onMissionGraphUpdate: (graph) => graphs.push(structuredClone(graph)),
        onRunComplete: (event) => {
          complete = event;
        },
        onApprovalRequest: approvals.onApprovalRequest,
        onCodePlan: (event) => plans.push(event),
        onFinalDelta: (delta) => answers.push(delta),
        onFinalReplace: (content) => answers.push(content),
      },
    });
  } finally {
    __setCodeToolsDesktopAppForTests(null);
  }
  return {
    workspace,
    model,
    graphs,
    plans,
    answers,
    approvals,
    complete: complete as AgentRunCompleteEvent | null,
  };
}

/** The guided script: whichever ladder step is offered, in ladder order. */
function guidedStep(offered: string[]): { calls: Call[] } | { content: string } {
  const order: Array<[string, Record<string, unknown>]> = [
    ["code_sandbox_status", {}],
    ["code_workspace_create", { kind: "repository" }],
    ["code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }],
    ["code_validate_fast", {}],
    ["code_repair_record_cycle", {}],
    ["code_validate_targeted", {}],
    ["code_validate_full", {}],
    ["code_commit_verified", {}],
    ["code_workspace_list", {}],
    ["code_workspace_read", { path: "src/pager.py" }],
  ];
  for (const [name, args] of order) {
    if (name === "code_sandbox_status" && offered.includes(name)) return { calls: [{ name, arguments: {} }] };
    if (offered.includes(name)) return { calls: [call(name, args)] };
  }
  return { content: "Done." };
}

function planShape(graph: MissionGraphV3) {
  return Object.values(graph.nodes)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => {
      const { wallClockMs: _wallClockMs, ...budget } = node.budget;
      return {
        id: node.id,
        allowedTools: node.allowedTools,
        dependencyIds: node.dependencyIds,
        effect: node.effect,
        budget,
        status: node.status,
        selector: node.destination?.selector ?? null,
        contract: node.completionContract,
      };
    });
}

test("a guided coding pass plans and runs exactly as it did before CODE-18", async () => {
  const expected = JSON.parse(
    readFileSync(new URL("./fixtures/guidedCodePassPlanV1.json", import.meta.url), "utf8"),
  ) as {
    nodes: unknown;
    envelopeBudgets: unknown;
    turns: Array<{ offered: string[]; calls: string[] }>;
    executed: string[];
  };
  // The default (no codeAutonomy) is the guided pass.
  const run = await runPass({ steps: GUIDED_PASS_STEPS_V1, decide: guidedStep });
  const first = run.graphs[0];
  assert.ok(first, "the run published its graph");
  assert.deepEqual(planShape(first), expected.nodes);
  const { maxWallClockMs: _maxWallClockMs, ...envelope } = first.capabilityEnvelope.budgets;
  assert.deepEqual(envelope, expected.envelopeBudgets);
  assert.deepEqual(
    run.model.turns.map((turn) => ({ offered: turn.offered, calls: turn.calls.map((c) => c.name) })),
    expected.turns,
  );
  assert.deepEqual(run.workspace.state.executed, expected.executed);
  assert.equal(run.plans.length, 0);
  assert.equal(
    first.nodes.code_free_work,
    undefined,
    "a guided pass has no open node",
  );
  assert.equal(run.complete?.stopReason, "final");
});

test("a free pass reads, searches, patches, fails a check, reads the failure, patches again, passes and commits in one open node", async () => {
  const open: Call[] = [
    { name: "code_plan_update", arguments: { items: [
      { text: "Find the off-by-one", status: "in_progress" },
      { text: "Fix offset()", status: "pending" },
      { text: "Pass the targeted check", status: "pending" },
    ] } },
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_search", { query: "def offset" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    // A wrong first fix: the targeted check stays red.
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size - 1" }] }),
    call("code_validate_targeted"),
    call("code_repair_status"),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size - 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
    { name: "code_plan_update", arguments: { items: [
      { text: "Find the off-by-one", status: "done" },
      { text: "Fix offset()", status: "done" },
      { text: "Pass the targeted check", status: "done" },
    ] } },
  ];
  const openTurns: string[][] = [];
  let saidDone = false;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        openTurns.push(offered);
        const next = open.shift();
        if (next) return { calls: [next] };
        if (!saidDone) {
          saidDone = true;
          return { content: "The off-by-one is fixed and the targeted check passes." };
        }
        return { content: "Done." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });

  // One open node, then the guided ladder's closing steps.
  const first = run.graphs[0]!;
  const openNode = first.nodes.code_free_work!;
  assert.ok(openNode, "the free plan has an open node");
  assert.equal(openNode.status, "ready");
  assert.deepEqual(openNode.dependencyIds, []);
  assert.equal(openNode.destination, null);
  assert.equal(openNode.budget.toolCalls, 60);
  assert.equal(openNode.budget.externalActions, 0);
  const closingNodes = Object.values(first.nodes)
    .filter((node) => node.id !== "code_free_work" && node.id !== "final")
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(closingNodes.map((node) => node.allowedTools), CLOSING.map((name) => [name]));
  for (const node of closingNodes) {
    assert.ok(node.dependencyIds.includes("code_free_work"), `${node.id} waits for the open node`);
    assert.equal(node.status, "queued");
  }
  assert.equal(
    Object.values(first.nodes).some((node) =>
      ["code_workspace_list", "code_workspace_read", "code_workspace_patch"].some((name) =>
        node.id.endsWith(name),
      ),
    ),
    false,
    "the guided steps before the first validation are replaced",
  );

  // The whole menu at every open step.
  const menu = [...openNode.allowedTools].sort();
  assert.ok(menu.includes("code_plan_update"));
  assert.ok(menu.includes("code_workspace_trash"));
  assert.ok(!menu.includes("code_repair_record_cycle"), "repair cycles are not counted inside the node");
  assert.ok(!menu.includes("code_commit_verified"));
  assert.ok(openTurns.length >= 13);
  for (const offered of openTurns) {
    assert.deepEqual([...offered].sort(), menu);
  }

  // What happened, in order, and the proof it ended on.
  assert.deepEqual(run.workspace.state.executed, [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_search",
    "code_workspace_read",
    "code_workspace_patch",
    "code_validate_targeted",
    "code_repair_status",
    "code_workspace_read",
    "code_workspace_patch",
    "code_validate_targeted",
    ...CLOSING,
  ]);
  assert.deepEqual(
    run.workspace.state.validations.map((validation) => `${validation.kind}:${validation.status}`),
    ["targeted:failed", "targeted:passed", "fast:passed", "targeted:passed", "full:passed"],
  );
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");

  const last = run.graphs.at(-1)!;
  for (const node of Object.values(last.nodes)) {
    assert.equal(node.status, "complete", `${node.id} completed`);
  }
  const state = last.nodes.code_free_work!.outputs.open_work as Record<string, unknown>;
  assert.equal(state.calls, 12);
  assert.equal(state.lastWriteCall, 10);
  assert.equal(state.lastTargetedPassCall, 11);
  assert.ok(
    last.nodes.code_free_work!.evidence.some((evidence) => evidence.kind === "open-work-done"),
  );

  // The to-do list, as the run reported it.
  assert.deepEqual(
    run.plans.map((plan) => ({ revision: plan.revision, statuses: plan.items.map((item) => item.status) })),
    [
      { revision: 1, statuses: ["in_progress", "pending", "pending"] },
      { revision: 2, statuses: ["done", "done", "done"] },
    ],
  );
  assert.deepEqual(Object.keys(run.plans[0]!).sort(), [
    "items",
    "nodeId",
    "revision",
    "runId",
    "updatedAt",
    "version",
  ]);
  assert.equal(run.plans[0]!.version, 1);
  assert.equal(run.plans[0]!.runId, "run-code-free");
  assert.equal(run.plans[0]!.nodeId, "code_free_work");

  // Every write stayed prepared and approved where it asks; validations ask.
  assert.ok(run.approvals.requests.some((request) => request.toolName === "code_commit_verified"));
});

test("a free pass that spends its tool calls stops on its budget and says what is left", async () => {
  const open: Call[] = [
    { name: "code_plan_update", arguments: { items: [
      { text: "Find the off-by-one", status: "in_progress" },
      { text: "Fix offset()", status: "pending" },
    ] } },
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_search", { query: "def offset" }),
    call("code_workspace_read", { path: "src/pager.py" }),
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", codeFreeBudget: { toolCalls: 4 } },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: [next] } : { content: "Done." };
      }
      return { content: "Done." };
    },
  });
  assert.deepEqual(run.workspace.state.executed, [
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_search",
  ]);
  assert.equal(run.workspace.state.commits.length, 0);
  assert.equal(run.complete?.stopReason, "budget");
  const last = run.graphs.at(-1)!;
  assert.equal(last.nodes.code_free_work!.status, "blocked");
  assert.equal(last.nodes.code_free_work!.blocker?.code, "open_work_budget_exhausted");
  for (const name of CLOSING) {
    const node = Object.values(last.nodes).find(
      (candidate) => candidate.id !== "code_free_work" && candidate.allowedTools.includes(name),
    );
    assert.equal(node?.status, "queued", `${name} never ran`);
  }
  const said = run.answers.join("\n");
  assert.match(said, /Free coding pass stopped at its budget: it used its 4 tool calls\./);
  assert.match(said, /Left on the plan: Find the off-by-one; Fix offset\(\)\./);
  assert.match(said, /Then: code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, code_commit_verified\./);
  assert.match(said, /Nothing was committed\./);
});

test("a free pass that spends its model calls stops before the next turn", async () => {
  // Different reads each turn: the runner's own repeated-call guard stops a
  // model that asks the same thing three times, open node or not.
  const reads: Call[] = [
    call("code_workspace_status"),
    call("code_workspace_list"),
    call("code_workspace_stat", { path: "src/pager.py" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_search", { query: "offset" }),
    call("code_workspace_stat", { path: "tests/test_pager.py" }),
    call("code_workspace_read", { path: "tests/test_pager.py" }),
    call("code_workspace_search", { query: "size" }),
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", codeFreeBudget: { modelCalls: 4 } },
    decide: (offered) => {
      if (!offered.includes("code_plan_update")) return { content: "Done." };
      const next = reads.shift();
      return next ? { calls: [next] } : { content: "Done." };
    },
  });
  // Every model call the run makes while the node is open counts, the
  // host's own structured calls included, so the agent gets at most four.
  const openTurns = run.model.turns.filter((turn) => turn.offered.includes("code_plan_update"));
  assert.ok(openTurns.length >= 1 && openTurns.length <= 4, `${openTurns.length} open turns`);
  assert.equal(run.complete?.stopReason, "budget");
  const last = run.graphs.at(-1)!;
  assert.equal(last.nodes.code_free_work!.blocker?.code, "open_work_budget_exhausted");
  assert.match(run.answers.join("\n"), /it used its 4 model calls\. No plan was recorded\./);
  assert.equal(run.workspace.state.commits.length, 0);
});
