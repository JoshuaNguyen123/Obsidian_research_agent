import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAgentMission, type AgentRunCompleteEvent } from "../src/AgentRunner";
import type { MissionGraphV3 } from "../src/agent/missionGraphV3";
import { CODE_FREE_UNCHECKED_DONE_LIMIT_V1, type CodePlanUpdateEventV1 } from "../src/agent/codeFreeWorkV1";
import { DefaultToolRegistry } from "../src/tools/ToolRegistry";
import { createRecallTools } from "../src/tools/recallTools";
import type { AgentTool } from "../src/tools/types";
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
  /** The whole prompt, when the pass is not the default one. */
  prompt?: string;
  options?: Record<string, unknown>;
  decide: (offered: string[]) => { calls: Call[] } | { content: string };
  structured?: Parameters<typeof scriptedCodeModel>[1];
  /** Tools whose approval the person denies. */
  deny?: readonly string[];
  /** What a code_sandbox_run program prints. */
  command?: Parameters<typeof createScriptedCodeWorkspace>[0]["command"];
  diagnosticExcerpts?: boolean;
  /** More files in the checkout, beside the pager and its test. */
  files?: Record<string, string>;
  /** The repository's protected controls and the confirmations each asks for. */
  protectedControls?: Record<string, 1 | 2>;
  /** The person's step setting. */
  maxAgentSteps?: number;
  /** Tools the registry has beside the workspace's. */
  extraTools?: AgentTool[];
  /** The reflex completion gate, on by default in the product. */
  reflex?: boolean;
  /** code_repair_status as the code runtime answers before any repair record exists. */
  noRepairRecord?: boolean;
}) {
  const now = () => new Date("2026-10-16T12:00:00.000Z");
  const prompt = input.prompt ?? codePassPromptV1(OBJECTIVE, input.steps);
  const workspace = createScriptedCodeWorkspace({
    now,
    files: { "src/pager.py": BUGGY, "tests/test_pager.py": "assert offset(0, 10) == 0\n", ...input.files },
    ...(input.command ? { command: input.command } : {}),
    ...(input.diagnosticExcerpts ? { diagnosticExcerpts: true } : {}),
    ...(input.protectedControls ? { protectedControls: input.protectedControls } : {}),
    check: (files) => {
      const passed = files.get("src/pager.py") === FIXED;
      return {
        passed,
        diagnostic: passed
          ? "1 passed"
          : input.diagnosticExcerpts
            ? `src/pager.py:2: AssertionError: offset(0, 10) is not 0\n${files.get("src/pager.py")?.trim()}`
            : `tests/test_pager.py:1 AssertionError: ${files.get("src/pager.py")?.trim()}`,
      };
    },
  });
  const { context } = scriptedRunContext({
    prompt,
    now,
    settings: scriptedRunSettings({ maxAgentSteps: input.maxAgentSteps ?? 60, agenticReflexEnabled: input.reflex ?? false }),
  });
  const model = scriptedCodeModel(({ offered }) => input.decide(offered), input.structured);
  const approvals = autoApprovals({ deny: input.deny });
  const graphs: MissionGraphV3[] = [];
  const plans: CodePlanUpdateEventV1[] = [];
  const answers: string[] = [];
  const statuses: string[] = [];
  let complete: AgentRunCompleteEvent | null = null;
  __setCodeToolsDesktopAppForTests(true);
  try {
    await runAgentMission({
      prompt,
      runId: "run-code-free",
      modelClient: model.client,
      toolRegistry: new DefaultToolRegistry([
        ...(input.noRepairRecord
          ? workspace.tools.map((tool) =>
              tool.name === "code_repair_status"
                ? {
                    ...tool,
                    async execute() {
                      // CodeRepairToolRuntimeV1.readStatus with no checkpoint saved.
                      throw Object.assign(
                        new Error(`No durable code repair checkpoint exists for code-repair:run-code-free:${WORKSPACE}:repair-1.`),
                        { code: "repair_checkpoint_missing" },
                      );
                    },
                  }
                : tool)
          : workspace.tools),
        ...(input.extraTools ?? []),
      ]),
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
        onStatus: (message) => statuses.push(message),
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
    statuses,
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

/*
 * RAP's pass prompt as a feature pass reads: its size rules name the checks
 * ("Then run distinct targeted and fresh full sandbox validation"), and a free
 * pass says how to work in place of the steps line. With those words the
 * closing steps alone once planned as a lifecycle-code_validation node, so a
 * free pass got no open node and its first step was offered no code tool.
 */
const FEATURE_RULES =
  "Use at most three edit and fast-validation repair cycles. Then run distinct targeted and fresh full sandbox validation, and make one verified commit with the exact durable validation receipt ids.";
const FREE_WORDS =
  "Work in your own order: look at the repository, search it, edit it and run its checks as the work needs, and keep your to-do list up to date as you go, within about 80 tool calls and 120 model turns. " +
  "A read shows numbered lines and takes a range, a search shows each match as path:line:column, and a listing can be a tree; build each replacement's oldText from the lines as read, without their numbers. " +
  "You are done when a targeted validation passes after your last edit; the full validation and the verified commit follow.";

function hostPassPrompt(input: { steps?: readonly string[]; free?: boolean }): string {
  return [
    "Coding pass (feature) for the project “Pager”, in the trusted repository pager-repo (in its durable workspace).",
    "Continue in the project's durable workspace: create it with workspaceId \"code-pager-1\" and kind \"repository\" — that continues the workspace, or makes it on the project's first pass. Never make a different workspace.",
    ...(input.free ? [FREE_WORDS] : input.steps ? [`Its steps, in order: ${input.steps.join(", ")}.`] : []),
    `Objective (untrusted task text only): ${JSON.stringify(OBJECTIVE)}.`,
    FEATURE_RULES,
    "Edit the repository's files only through prepared workspace mutations; never execute on the host.",
  ].join("\n");
}

/** What RAP's scripted model answers every structured request that is not a graph with. */
function codeWorkflowClassification(): string {
  return JSON.stringify({
    mode: "code_workflow",
    writeScope: "none",
    needsWebEvidence: false,
    needsVaultContext: false,
    needsCodeExecution: true,
    wordTarget: null,
    confidence: 1,
    rationale: "A coding pass in the trusted repository.",
  });
}

/** A short free script: look, fix, pass the targeted check, then the closing steps. */
function shortFreeScript(): (offered: string[]) => { calls: Call[] } | { content: string } {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ];
  return (offered) => {
    if (offered.includes("code_plan_update")) {
      const next = open.shift();
      return next ? { calls: [next] } : { content: "The off-by-one is fixed and the targeted check passes." };
    }
    for (const name of CLOSING) {
      if (offered.includes(name)) return { calls: [call(name)] };
    }
    return { content: "Done." };
  };
}

function assertOpenNodeThenClosing(graph: MissionGraphV3): void {
  assert.deepEqual(
    Object.keys(graph.nodes).filter((id) => id.startsWith("lifecycle-")),
    [],
    "no lifecycle node",
  );
  const openNode = graph.nodes.code_free_work;
  assert.ok(openNode, "the free plan has its open node");
  assert.equal(openNode.status, "ready");
  const closing = Object.values(graph.nodes)
    .filter((node) => node.id !== "code_free_work" && node.id !== "final")
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(closing.map((node) => node.allowedTools), CLOSING.map((name) => [name]));
  for (const node of closing) {
    assert.ok(node.dependencyIds.includes("code_free_work"), `${node.id} waits for the open node`);
  }
}

test("a free pass whose words name its checks plans its open node from the host's own graph", async () => {
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    prompt: hostPassPrompt({ steps: GUIDED_PASS_STEPS_V1 }),
    options: { codeAutonomy: "free" },
    structured: codeWorkflowClassification,
    decide: shortFreeScript(),
  });
  assertOpenNodeThenClosing(run.graphs[0]!);
  // The planner model is never asked for a free pass's graph.
  assert.equal(
    run.model.requests.some((request) => JSON.stringify(request.format ?? {}).includes("\"nodes\"")),
    false,
  );
  assert.ok(run.model.turns[0]!.offered.includes("code_workspace_read"), "the first step is offered the code menu");
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a free pass that names no steps, only how to work, plans its open node too", async () => {
  const run = await runPass({
    steps: [],
    prompt: hostPassPrompt({ free: true }),
    options: { codeAutonomy: "free" },
    structured: codeWorkflowClassification,
    decide: shortFreeScript(),
  });
  assertOpenNodeThenClosing(run.graphs[0]!);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("the same pass guided still plans its per-tool ladder, never a lifecycle node", async () => {
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    prompt: hostPassPrompt({ steps: GUIDED_PASS_STEPS_V1 }),
    structured: codeWorkflowClassification,
    decide: guidedStep,
  });
  const first = run.graphs[0]!;
  assert.deepEqual(Object.keys(first.nodes).filter((id) => id.startsWith("lifecycle-")), []);
  assert.equal(first.nodes.code_free_work, undefined);
  const tools = Object.values(first.nodes)
    .filter((node) => node.id !== "final")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => node.allowedTools[0]);
  assert.deepEqual(tools, [...GUIDED_PASS_STEPS_V1]);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

/** One patch over the code and its test: the fix and a second assertion. */
const TWO_FILE_PATCH = [
  "--- a/src/pager.py",
  "+++ b/src/pager.py",
  "@@ -1,2 +1,2 @@",
  " def offset(page, size):",
  "-    return page * size + 1",
  "+    return page * size",
  "--- a/tests/test_pager.py",
  "+++ b/tests/test_pager.py",
  "@@ -1 +1,2 @@",
  " assert offset(0, 10) == 0",
  "+assert offset(2, 10) == 20",
  "",
].join("\n");
const TESTS_AFTER = "assert offset(0, 10) == 0\nassert offset(2, 10) == 20\n";

test("a free pass changes the code and its test with one patch: one prepared write, one change", async () => {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_apply_patch", { patch: TWO_FILE_PATCH }),
    call("code_validate_targeted"),
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: [next] } : { content: "Fixed, with a second test." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  const openNode = run.graphs[0]!.nodes.code_free_work!;
  assert.ok(openNode.allowedTools.includes("code_workspace_apply_patch"), "the open node offers the patch");
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.files.get("tests/test_pager.py"), TESTS_AFTER);
  assert.deepEqual(
    run.workspace.state.executed.filter((name) => name.startsWith("code_workspace_") && name !== "code_workspace_create" && name !== "code_workspace_read"),
    ["code_workspace_apply_patch"],
  );
  // What the model read back: a line per file.
  const after = JSON.stringify(run.model.requests.at(-1)?.messages ?? []);
  assert.match(after, /Applied the patch to 2 files\./u);
  assert.ok(after.includes("src/pager.py: +1 −1"), after);
  assert.ok(after.includes("tests/test_pager.py: +1 −0"), after);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a guided pass whose steps name the patch plans one patch step, offered alone among the writes", async () => {
  const steps = GUIDED_PASS_STEPS_V1.map((name) => (name === "code_workspace_patch" ? "code_workspace_apply_patch" : name));
  const offeredAtPatch: string[][] = [];
  const run = await runPass({
    steps,
    decide: (offered) => {
      if (offered.includes("code_workspace_apply_patch")) {
        offeredAtPatch.push(offered);
        return { calls: [call("code_workspace_apply_patch", { patch: TWO_FILE_PATCH })] };
      }
      return guidedStep(offered);
    },
  });
  const first = run.graphs[0]!;
  const tools = Object.values(first.nodes)
    .filter((node) => node.id !== "final")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => node.allowedTools[0]);
  assert.deepEqual(tools, steps);
  assert.ok(offeredAtPatch.length >= 1);
  for (const offered of offeredAtPatch) {
    for (const single of ["code_workspace_patch", "code_workspace_write_expected", "code_workspace_create_file"]) {
      assert.equal(offered.includes(single), false, `${single} is not offered beside the planned patch`);
    }
  }
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.files.get("tests/test_pager.py"), TESTS_AFTER);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

// CODE-7 4b: a patch is judged by its kind. A patch that renames a file asks
// as code_workspace_move does, and one that deletes asks as code_workspace_trash
// does, even though the run's write autonomy passes an edit without asking.
const RENAMING_PATCH = [
  "diff --git a/tests/test_pager.py b/tests/test_offset.py",
  "rename from tests/test_pager.py",
  "rename to tests/test_offset.py",
  "--- a/tests/test_pager.py",
  "+++ b/tests/test_offset.py",
  "@@ -1 +1,2 @@",
  " assert offset(0, 10) == 0",
  "+assert offset(2, 10) == 20",
  "--- a/src/pager.py",
  "+++ b/src/pager.py",
  "@@ -1,2 +1,2 @@",
  " def offset(page, size):",
  "-    return page * size + 1",
  "+    return page * size",
  "",
].join("\n");
const DELETING_PATCH = [
  "--- a/tests/test_pager.py",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-assert offset(0, 10) == 0",
  "--- a/src/pager.py",
  "+++ b/src/pager.py",
  "@@ -1,2 +1,2 @@",
  " def offset(page, size):",
  "-    return page * size + 1",
  "+    return page * size",
  "",
].join("\n");

async function freePatchPass(patch: string, options: Record<string, unknown> = {}) {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_apply_patch", { patch }),
    call("code_validate_targeted"),
  ];
  return runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", ...options },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: [next] } : { content: "Fixed." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
}

test("under write autonomy a patch that only edits goes ahead, one that renames or deletes a file asks first", async () => {
  const edits = await freePatchPass(TWO_FILE_PATCH);
  assert.equal(edits.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(
    edits.approvals.requests.some((request) => request.toolName === "code_workspace_apply_patch"),
    false,
    "an edit passes under write autonomy, as code_workspace_patch does",
  );

  const renames = await freePatchPass(RENAMING_PATCH);
  const renameAsks = renames.approvals.requests.filter((request) => request.toolName === "code_workspace_apply_patch");
  assert.equal(renameAsks.length, 1, "a rename asks once, as code_workspace_move does");
  assert.equal(renames.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(renames.workspace.state.files.has("tests/test_pager.py"), false);
  assert.equal(renames.workspace.state.files.get("tests/test_offset.py"), TESTS_AFTER);

  const deletes = await freePatchPass(DELETING_PATCH);
  const deleteAsks = deletes.approvals.requests.filter((request) => request.toolName === "code_workspace_apply_patch");
  assert.equal(deleteAsks.length, 1, "a delete asks once, as code_workspace_trash does");
  assert.equal(deletes.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(deletes.workspace.state.files.has("tests/test_pager.py"), false);
});

test("a denied patch that deletes a file changes nothing", async () => {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_apply_patch", { patch: DELETING_PATCH }),
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: [next] } : { content: "Stopped." };
      }
      return { content: "Stopped." };
    },
    deny: ["code_workspace_apply_patch"],
  });
  assert.ok(run.approvals.requests.some((request) => request.toolName === "code_workspace_apply_patch"));
  assert.equal(run.workspace.state.files.get("src/pager.py"), BUGGY);
  assert.equal(run.workspace.state.files.has("tests/test_pager.py"), true);
});

// Write autonomy never covers a protected repository control: a change to a
// manifest, a lockfile, a build script, a workflow or a hook asks for its exact
// approval with the confirmations it names, as it would without autonomy.
const PACKAGE = "{\"name\":\"pager\"}\n";
const PACKAGE_AFTER = "{\"name\":\"pager\",\"version\":\"1.0.1\"}\n";
const WORKFLOW = "name: ci\n";
const WORKFLOW_AFTER = "name: ci\non: push\n";
const PROTECTED = { "package.json": 1, ".github/workflows": 2 } as const;
const PROTECTED_FILES = { "package.json": PACKAGE, ".github/workflows/ci.yml": WORKFLOW };

async function freeCallsPass(calls: Call[], options: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const open = [...calls];
  return runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", ...options },
    files: { ...PROTECTED_FILES, ...files },
    protectedControls: PROTECTED,
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: [next] } : { content: "Fixed." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
}

/** The confirmations each prepared write asked for, by the path it named. */
function asksByPath(run: Awaited<ReturnType<typeof runPass>>, toolName: string): Record<string, number[]> {
  const asks: Record<string, number[]> = {};
  for (const request of run.approvals.requests) {
    if (request.toolName !== toolName) continue;
    const path = String(request.preparedAction?.target.path ?? "");
    (asks[path] ??= []).push(request.confirmationIndex ?? 1);
  }
  return asks;
}

test("under write autonomy a single write to a protected control asks, twice for a double-exact one, and an ordinary edit still goes ahead", async () => {
  const run = await freeCallsPass([
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    // The same single-file write to two protected controls and to the code.
    call("code_workspace_patch", { path: "package.json", replacements: [{ oldText: "\"pager\"}", newText: "\"pager\",\"version\":\"1.0.1\"}" }] }),
    call("code_workspace_patch", { path: ".github/workflows/ci.yml", replacements: [{ oldText: "name: ci\n", newText: "name: ci\non: push\n" }] }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ]);
  assert.deepEqual(
    asksByPath(run, "code_workspace_patch"),
    { "package.json": [1], ".github/workflows/ci.yml": [1, 2] },
    "an exact-diff control asks once and a double-exact one twice, as without autonomy, and the ordinary edit, which also names one confirmation, does not ask",
  );
  for (const request of run.approvals.requests.filter((entry) => entry.toolName === "code_workspace_patch")) {
    assert.ok(!request.policyTags.includes("write_autonomy"), JSON.stringify(request.policyTags));
    assert.ok(request.policyTags.includes("exact_payload_approval"), JSON.stringify(request.policyTags));
  }
  assert.equal(run.workspace.state.files.get("package.json"), PACKAGE_AFTER);
  assert.equal(run.workspace.state.files.get(".github/workflows/ci.yml"), WORKFLOW_AFTER);
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
});

const PROTECTED_PATCH = [
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -1 +1 @@",
  "-{\"name\":\"pager\"}",
  "+{\"name\":\"pager\",\"version\":\"1.0.1\"}",
  "--- a/src/pager.py",
  "+++ b/src/pager.py",
  "@@ -1,2 +1,2 @@",
  " def offset(page, size):",
  "-    return page * size + 1",
  "+    return page * size",
  "--- /dev/null",
  "+++ b/src/new.py",
  "@@ -0,0 +1 @@",
  "+NEW = True",
  "",
].join("\n");

test("under write autonomy a patch that touches a protected control asks for its exact approval, and one that does not goes ahead", async () => {
  const patchCalls = (patch: string): Call[] => [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_apply_patch", { patch }),
    call("code_validate_targeted"),
  ];
  const touched = await freeCallsPass(patchCalls(PROTECTED_PATCH));
  const asks = touched.approvals.requests.filter((request) => request.toolName === "code_workspace_apply_patch");
  assert.equal(asks.length, 1, "the patch over package.json asks, as a single write to it does");
  assert.equal(asks[0]!.requiredConfirmations, 1);
  assert.equal(asks[0]!.preparedAction?.normalizedArgs.requiresProfileRedetection, true);
  assert.equal(touched.workspace.state.files.get("package.json"), PACKAGE_AFTER);
  assert.equal(touched.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(touched.workspace.state.files.get("src/new.py"), "NEW = True\n");

  const ordinary = await freeCallsPass(patchCalls(TWO_FILE_PATCH));
  assert.equal(
    ordinary.approvals.requests.some((request) => request.toolName === "code_workspace_apply_patch"),
    false,
    "a patch that touches no control goes ahead under write autonomy",
  );
  assert.equal(ordinary.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(ordinary.workspace.state.files.get("package.json"), PACKAGE);
});

// CODE-17: one program and its arguments in the sandbox.
const RED_RUN = { exitCode: 1, stdout: "F\n1 failed in 0.02s\n", stderr: "AssertionError: offset(0, 10) == 1\n" };

test("a free pass runs one test on its own in the sandbox, after asking, and reads what it printed", async () => {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_sandbox_run", { argv: ["python3", "-m", "pytest", "-q", "tests/test_pager.py"] }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
    command: (argv, files) => (files.get("src/pager.py") === FIXED ? { exitCode: 0, stdout: "1 passed\n", stderr: "" } : RED_RUN),
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: [next] } : { content: "Fixed." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  assert.ok(run.graphs[0]!.nodes.code_free_work!.allowedTools.includes("code_sandbox_run"), "the open node offers the command");
  assert.deepEqual(run.workspace.state.commands, [["python3", "-m", "pytest", "-q", "tests/test_pager.py"]]);
  assert.equal(
    run.approvals.requests.filter((request) => request.toolName === "code_sandbox_run").length,
    1,
    "the command asked first",
  );
  const heard = JSON.stringify(run.model.requests.map((request) => request.messages));
  assert.match(heard, /python3 -m pytest -q tests\/test_pager\.py exited 1/u);
  assert.match(heard, /what a program printed in the sandbox/u);
  assert.match(heard, /1 failed in 0\.02s/u);
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a guided pass never offers the command, even while a red validation waits for its correction", async () => {
  // The guided ladder plans no command, and a mission graph cannot add an
  // execution its plan did not hold, so the recovery after a red validation
  // offers its own read and correction and nothing else.
  const menus: string[][] = [];
  let wrongPatchDone = false;
  let read = false;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    command: () => RED_RUN,
    diagnosticExcerpts: true,
    decide: (offered) => {
      menus.push([...offered]);
      if (offered.includes("code_workspace_patch") && !wrongPatchDone) {
        wrongPatchDone = true;
        return { calls: [call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size - 1" }] })] };
      }
      if (offered.includes("code_workspace_read") && wrongPatchDone && !read) {
        read = true;
        return { calls: [call("code_workspace_read", { path: "src/pager.py" })] };
      }
      if (offered.includes("code_workspace_patch") && read) {
        return { calls: [call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size - 1", newText: "page * size" }] })] };
      }
      if (offered.includes("code_workspace_write_expected")) {
        return { calls: [call("code_workspace_write_expected", { path: "src/pager.py", content: FIXED })] };
      }
      return guidedStep(offered);
    },
  });
  assert.ok(read, "the recovery offered its read");
  assert.equal(menus.some((offered) => offered.includes("code_sandbox_run")), false, JSON.stringify(menus));
  assert.deepEqual(run.workspace.state.commands, []);
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

/** A free pass whose open steps are model turns of one call or several. */
async function freeTurnsPass(turns: Call[][]) {
  const open = turns.map((turn) => [...turn]);
  return runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        return next ? { calls: next } : { content: "The off-by-one is fixed and the targeted check passes." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
}

/** What the model was told about each of a turn's calls, by call id. */
function toolAnswers(run: Awaited<ReturnType<typeof runPass>>, turnCalls: number): Array<{ name: string; status: string }> {
  const turn = run.model.turns.find((entry) => entry.calls.length === turnCalls);
  assert.ok(turn, `a model turn asked for ${turnCalls} calls`);
  const transcript = run.model.requests.at(-1)!.messages;
  return turn.calls.map((asked) => {
    const answers = transcript.filter((message) => message.role === "tool" && message.toolCallId === asked.id);
    assert.equal(answers.length, 1, `${asked.name} (${asked.id}) was answered once`);
    const payload = JSON.parse(String(answers[0]!.content)) as { toolName: string; status: string };
    return { name: payload.toolName, status: payload.status };
  });
}

const PLAN_ITEMS = [
  { text: "Read offset()", status: "in_progress" },
  { text: "Fix it and pass the targeted check", status: "pending" },
];

for (const second of [
  call("code_workspace_stat", { path: "src/pager.py" }),
  call("code_workspace_list"),
]) {
  test(`a free pass whose model asks for a read and a ${second.name.replace("code_workspace_", "")} in one turn runs both in its open node, one after the other`, async () => {
    // The open node runs one call at a time whatever its tool. Two different
    // read tools each counted that one node as their ready slot, so both
    // entered the parallel batch, the first claimed the node and the second
    // was refused as "not ready in the exact authoritative mission graph",
    // which ended the run (CODE-19's pilot, glm-5.3-flash, 2026-10-16).
    const run = await freeTurnsPass([
      [{ name: "code_plan_update", arguments: { items: PLAN_ITEMS } }],
      [{ name: "code_sandbox_status", arguments: {} }],
      [call("code_workspace_create", { kind: "repository" })],
      [call("code_workspace_read", { path: "src/pager.py" }), second],
      [call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] })],
      [call("code_validate_targeted")],
    ]);
    assert.equal(run.complete?.stopReason, "final", JSON.stringify(run.statuses));
    assert.deepEqual(
      run.statuses.filter((message) => /not ready|Tool execution failed|in parallel/.test(message)),
      [],
      "neither call was refused, and the two were not run side by side in the one node",
    );
    assert.deepEqual(toolAnswers(run, 2), [
      { name: "code_workspace_read", status: "success" },
      { name: second.name, status: "success" },
    ]);
    assert.deepEqual(run.workspace.state.executed, [
      "code_sandbox_status",
      "code_workspace_create",
      "code_workspace_read",
      second.name,
      "code_workspace_patch",
      "code_validate_targeted",
      ...CLOSING,
    ]);
    const last = run.graphs.at(-1)!;
    for (const node of Object.values(last.nodes)) {
      assert.equal(node.status, "complete", `${node.id} completed`);
    }
    const state = last.nodes.code_free_work!.outputs.open_work as Record<string, unknown>;
    assert.equal(state.calls, 7, "each call of the turn is one call of the open node");
    assert.equal(state.lastWriteCall, 6);
    assert.equal(state.lastTargetedPassCall, 7);
    assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
    assert.equal(run.workspace.state.commits.length, 1);
  });
}

test("a guided pass whose model asks for its list and its read in one turn still runs the two steps side by side", async () => {
  // The control: in a guided pass the list and the read are two ready steps,
  // each its own node, and a turn asking for both runs them in parallel as it
  // always has. Only an open node is one slot for every tool.
  const expected = JSON.parse(
    readFileSync(new URL("./fixtures/guidedCodePassPlanV1.json", import.meta.url), "utf8"),
  ) as { nodes: unknown; executed: string[] };
  let asked = false;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    decide: (offered) => {
      if (!asked && offered.includes("code_workspace_list") && offered.includes("code_workspace_read")) {
        asked = true;
        return { calls: [call("code_workspace_list"), call("code_workspace_read", { path: "src/pager.py" })] };
      }
      return guidedStep(offered);
    },
  });
  assert.deepEqual(planShape(run.graphs[0]!), expected.nodes);
  assert.ok(run.statuses.includes("Running 2 read-only tools in parallel..."), JSON.stringify(run.statuses));
  assert.deepEqual(toolAnswers(run, 2), [
    { name: "code_workspace_list", status: "success" },
    { name: "code_workspace_read", status: "success" },
  ]);
  assert.deepEqual(
    run.model.turns.map((turn) => turn.calls.map((entry) => entry.name)),
    [
      ["code_sandbox_status"],
      ["code_workspace_create"],
      ["code_workspace_list", "code_workspace_read"],
      ["code_workspace_patch"],
      ...CLOSING.map((name) => [name]),
    ],
  );
  assert.deepEqual([...run.workspace.state.executed].sort(), [...expected.executed].sort());
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a free pass's open node is bounded by its own model calls, not the runner's step cap or the person's step setting (CODE2-2)", async () => {
  // 30 distinct searches before the fix: past the person's step setting (20).
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    ...Array.from({ length: 30 }, (_, index) => call("code_workspace_search", { query: `offset ${index}` })),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ];
  let openTurns = 0;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    maxAgentSteps: 20,
    options: { codeAutonomy: "free", codeFreeBudget: { modelCalls: 240, toolCalls: 300 } },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        openTurns += 1;
        const next = open.shift();
        return next ? { calls: [next] } : { content: "The off-by-one is fixed and the targeted check passes." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  // The segment's step limit is the node's 240 model calls and the closing
  // steps' allowance, past MAX_AGENT_STEPS (100).
  const limit = run.statuses
    .map((status) => /^Agent step 1 of max (\d+)\.\.\.$/u.exec(status)?.[1])
    .find((value) => value !== undefined);
  assert.ok(Number(limit) >= 240, `step limit ${limit}`);
  assert.ok(openTurns > 30, `${openTurns} open turns`);
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a model that keeps saying it is done without the targeted check hands the open node to its closing checks (RAP CODE2-24)", async () => {
  // Beam on the IDE journey: it fixed the bug, checked it with its own command, then said it was done 200 times
  // without running code_validate_targeted, each time told so, until its 240 model calls were gone.
  const open: Array<Call | string> = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    "The off-by-one is fixed.",
    "Done: the fix is in.",
    // A call in between is work, so the count starts again after it.
    call("code_workspace_search", { query: "offset" }),
  ];
  let claims = 0;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", codeFreeBudget: { modelCalls: 240, toolCalls: 300 } },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        if (next && typeof next !== "string") return { calls: [next] };
        claims += 1;
        return { content: typeof next === "string" ? next : "The fix is complete; nothing else to do." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  const handed = run.statuses.filter((status) => status.startsWith("The model said "));
  assert.deepEqual(handed, [
    `The model said ${CODE_FREE_UNCHECKED_DONE_LIMIT_V1} times that the open coding work is done without a passing targeted validation. The closing steps check it now: ${CLOSING.join(", ")}.`,
  ]);
  // Two claims before the search, then the limit after it; never the rest of the budget.
  assert.equal(claims, 2 + CODE_FREE_UNCHECKED_DONE_LIMIT_V1);
  const turns = run.model.requests.filter((request) => !request.format).length;
  assert.ok(turns < 20, `${turns} model turns`);
  // The closing checks judged the work: they passed, and the pass committed.
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a model that asks for a closing check from the open node, after its targeted check passed, has said the work is done (RAP CODE2-24)", async () => {
  // Beam on the pilot: with the fix checked it asked for code_validate_full and code_repair_record_cycle from the open
  // node instead of saying it was done; each was deferred and none was read as the claim it was.
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ];
  let asked = 0;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", codeFreeBudget: { modelCalls: 240, toolCalls: 300 } },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        if (next) return { calls: [next] };
        asked += 1;
        return { calls: [call("code_validate_full"), call("code_repair_record_cycle")] };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  // One ask, for two closing tools at once, ends the node: never a loop of deferrals.
  assert.equal(asked, 1);
  assert.ok(
    run.statuses.includes(`The open coding work is done. The closing steps run now: ${CLOSING.join(", ")}.`),
    run.statuses.filter((status) => /open coding work|free coding pass/u.test(status)).join("\n"),
  );
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a model that keeps asking for the closing checks without the targeted check hands the open node over at the limit (RAP CODE2-24)", async () => {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
  ];
  const closingAsks = ["code_validate_full", "code_repair_record_cycle", "code_commit_verified"];
  let asked = 0;
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free", codeFreeBudget: { modelCalls: 240, toolCalls: 300 } },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        if (next) return { calls: [next] };
        asked += 1;
        return { calls: [call(closingAsks[(asked - 1) % closingAsks.length]!)] };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  assert.equal(asked, CODE_FREE_UNCHECKED_DONE_LIMIT_V1);
  assert.deepEqual(
    run.statuses.filter((status) => status.startsWith("The model said ")),
    [`The model said ${CODE_FREE_UNCHECKED_DONE_LIMIT_V1} times that the open coding work is done without a passing targeted validation. The closing steps check it now: ${CLOSING.join(", ")}.`],
  );
  // Each ask before the limit was told what is owed, in words that name what it asked for.
  const told = run.model.requests.flatMap((request) =>
    request.messages.filter((message) => message.role === "system" && /^Asking for code_/u.test(String(message.content ?? ""))),
  );
  assert.ok(told.length > 0, "the model was told what an ask for a closing check still owes");
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("in the open node code_repair_status finding no repair record is an answer, so reading it twice does not end the pass (RAP CODE2-24)", async () => {
  // Beam on the pilot read code_repair_status twice after a red check, as the open node's own message told it to;
  // the open node writes no repair record, both reads failed the same way, and the pass ended on them.
  const open: Array<Call | string> = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_validate_fast"),
    call("code_repair_status"),
    call("code_repair_status"),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
    "The fix is in and checked.",
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    noRepairRecord: true,
    options: { codeAutonomy: "free", codeFreeBudget: { modelCalls: 240, toolCalls: 300 } },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = open.shift();
        if (next && typeof next !== "string") return { calls: [next] };
        return { content: typeof next === "string" ? next : "Done." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  assert.deepEqual(run.statuses.filter((status) => status.startsWith("The free coding pass stopped")), []);
  const said = run.model.requests.flatMap((request) =>
    request.messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content ?? "")),
  );
  assert.ok(said.some((text) => text.startsWith("code_repair_status has nothing to read yet")), "the model was told why");
  // The red check's own message no longer points at a read that cannot answer in the open node.
  assert.ok(said.some((text) => text.startsWith("code_validate_fast completed red.") && !text.includes("code_repair_status")));
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("a free pass's open node offers recall_tool_result, so what compaction set aside can be read back (CODE2-13)", async () => {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    { name: "recall_tool_result", arguments: { key: "tr_run-code-free_3" } },
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ];
  const offeredInOpenNode: string[][] = [];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    extraTools: createRecallTools(),
    options: { codeAutonomy: "free" },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        offeredInOpenNode.push(offered);
        const next = open.shift();
        return next ? { calls: [next] } : { content: "The off-by-one is fixed and the targeted check passes." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  assert.ok(offeredInOpenNode.length > 0);
  for (const offered of offeredInOpenNode) {
    assert.ok(offered.includes("recall_tool_result"), "recall is on the open node's menu");
  }
  const state = run.graphs.at(-1)!.nodes.code_free_work!.outputs.open_work as Record<string, unknown>;
  assert.equal(state.calls, 6, "the recall counted as one of the open node's calls");
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

// CODE2-16 (D-291): under the person's Auto-apply a move, a trash and a patch
// that renames or deletes go ahead inside the workspace; a protected control
// still asks, as it does under write autonomy.
test("under Auto-apply a patch that renames or deletes a file goes ahead without asking (CODE2-16)", async () => {
  for (const [label, patch] of [["rename", RENAMING_PATCH], ["delete", DELETING_PATCH]] as const) {
    const run = await freePatchPass(patch, { codeWorkspaceAutoApply: true });
    assert.equal(
      run.approvals.requests.some((request) => request.toolName === "code_workspace_apply_patch"),
      false,
      `a ${label} patch does not ask under Auto-apply`,
    );
    assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED, label);
    assert.equal(run.workspace.state.files.has("tests/test_pager.py"), false, label);
    assert.ok(run.statuses.includes("Auto-apply; running tool: code_workspace_apply_patch"), label);
    assert.equal(run.workspace.state.commits.length, 1, label);
  }
});

test("under Auto-apply a move and a trash go ahead, and one of a protected control still asks (CODE2-16)", async () => {
  const run = await freeCallsPass([
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_move", { path: "tests/test_pager.py", from: "tests/test_pager.py", to: "tests/test_offset.py" }),
    call("code_workspace_trash", { path: "src/unused.py" }),
    call("code_workspace_trash", { path: "package.json" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ], { codeWorkspaceAutoApply: true }, { "src/unused.py": "UNUSED = 1\n" });
  const asked = run.approvals.requests
    .filter((request) => request.toolName === "code_workspace_move" || request.toolName === "code_workspace_trash")
    .map((request) => `${request.toolName}:${String(request.preparedAction?.target.path ?? "")}`);
  assert.deepEqual(asked, ["code_workspace_trash:package.json"], "only the protected control asked");
  assert.equal(run.workspace.state.files.has("tests/test_pager.py"), false);
  assert.equal(run.workspace.state.files.has("tests/test_offset.py"), true);
  assert.equal(run.workspace.state.files.has("src/unused.py"), false);
  assert.equal(run.workspace.state.files.has("package.json"), false, "approved by hand, then trashed");
});

test("without Auto-apply a move and a trash still ask under write autonomy (CODE2-16)", async () => {
  const run = await freeCallsPass([
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_move", { path: "tests/test_pager.py", from: "tests/test_pager.py", to: "tests/test_offset.py" }),
    call("code_workspace_trash", { path: "src/unused.py" }),
    call("code_workspace_patch", { path: "src/pager.py", replacements: [{ oldText: "page * size + 1", newText: "page * size" }] }),
    call("code_validate_targeted"),
  ], {}, { "src/unused.py": "UNUSED = 1\n" });
  const asked = run.approvals.requests
    .filter((request) => request.toolName === "code_workspace_move" || request.toolName === "code_workspace_trash")
    .map((request) => request.toolName);
  assert.deepEqual(asked, ["code_workspace_move", "code_workspace_trash"]);
});

test("in the open node a full-file write goes to the file the model names, and shorthand for a file is refused", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const run = await freeCallsPass([
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_write_expected", { path: "src/pager.py", expectedSha256: sha(BUGGY), content: "# ..." }),
    call("code_workspace_write_expected", { path: "src/pager.py", expectedSha256: sha(BUGGY), content: FIXED }),
    call("code_validate_targeted"),
  ]);
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  const said = JSON.stringify(run.model.requests.map((request) => request.messages));
  assert.match(said, /The content is a placeholder, not the file/u);
  assert.doesNotMatch(said, /workspace read SHA and bounded content from the completed graph dependency/u);
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("in the open node two files written whole in one response are both written, neither deferred", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const turns: Call[][] = [
    [{ name: "code_sandbox_status", arguments: {} }],
    [call("code_workspace_create", { kind: "repository" })],
    [call("code_workspace_read", { path: "src/pager.py" }), call("code_workspace_read", { path: "tests/test_pager.py" })],
    [
      call("code_workspace_write_expected", { path: "src/pager.py", expectedSha256: sha(BUGGY), content: FIXED }),
      call("code_workspace_write_expected", {
        path: "tests/test_pager.py",
        expectedSha256: sha("assert offset(0, 10) == 0\n"),
        content: TESTS_AFTER,
      }),
    ],
    [call("code_validate_targeted")],
  ];
  const run = await runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
    decide: (offered) => {
      if (offered.includes("code_plan_update")) {
        const next = turns.shift();
        return next ? { calls: next } : { content: "Fixed, with a second test." };
      }
      for (const name of CLOSING) {
        if (offered.includes(name)) return { calls: [call(name)] };
      }
      return { content: "Done." };
    },
  });
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.files.get("tests/test_pager.py"), TESTS_AFTER);
  assert.ok(!run.statuses.some((status) => /may attempt only one hash-bound workspace correction/u.test(status)));
  assert.equal(run.workspace.state.commits.length, 1);
  assert.equal(run.complete?.stopReason, "final");
});

test("with the reflex gate on, a pass that commits finishes there instead of being told its write is missing", async () => {
  const run = await runPass({
    steps: [],
    prompt: hostPassPrompt({ free: true }),
    options: { codeAutonomy: "free" },
    structured: codeWorkflowClassification,
    reflex: true,
    decide: shortFreeScript(),
  });
  assert.equal(run.workspace.state.commits.length, 1);
  assert.ok(!run.statuses.some((status) => /Reflex completion gate missing/u.test(status)), run.statuses.join(" | "));
  assert.equal(run.complete?.stopReason, "final");
});

test("a pass attached to a person's workspace plans no repair record or commit, and ends done once its checks pass", async () => {
  const run = await runPass({
    steps: [],
    prompt: hostPassPrompt({ free: true }),
    options: { codeAutonomy: "free", codeWorkspaceCommitByPerson: true },
    structured: codeWorkflowClassification,
    reflex: true,
    decide: shortFreeScript(),
  });
  const planned = Object.values(run.graphs[0]!.nodes).flatMap((node) => node.allowedTools);
  for (const tool of ["code_repair_record_cycle", "code_commit_verified", "publish_verified_code_to_github", "code_workspace_init_repository"]) {
    assert.ok(!planned.includes(tool), `${tool} is not planned`);
  }
  assert.ok(planned.includes("code_validate_targeted"), "the checks are still planned");
  assert.equal(run.workspace.state.files.get("src/pager.py"), FIXED);
  assert.equal(run.workspace.state.commits.length, 0, "the person commits");
  assert.equal(run.complete?.stopReason, "final");
  // The same pass without the attachment plans the agent's own commit, as before.
  const owned = await runPass({
    steps: [],
    prompt: hostPassPrompt({ free: true }),
    options: { codeAutonomy: "free" },
    structured: codeWorkflowClassification,
    decide: shortFreeScript(),
  });
  assert.ok(Object.values(owned.graphs[0]!.nodes).some((node) => node.allowedTools.includes("code_commit_verified")));
});
