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
}) {
  const now = () => new Date("2026-10-16T12:00:00.000Z");
  const prompt = input.prompt ?? codePassPromptV1(OBJECTIVE, input.steps);
  const workspace = createScriptedCodeWorkspace({
    now,
    files: { "src/pager.py": BUGGY, "tests/test_pager.py": "assert offset(0, 10) == 0\n" },
    ...(input.command ? { command: input.command } : {}),
    ...(input.diagnosticExcerpts ? { diagnosticExcerpts: true } : {}),
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
    settings: scriptedRunSettings({ maxAgentSteps: 60 }),
  });
  const model = scriptedCodeModel(({ offered }) => input.decide(offered), input.structured);
  const approvals = autoApprovals({ deny: input.deny });
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

async function freePatchPass(patch: string) {
  const open: Call[] = [
    { name: "code_sandbox_status", arguments: {} },
    call("code_workspace_create", { kind: "repository" }),
    call("code_workspace_read", { path: "src/pager.py" }),
    call("code_workspace_apply_patch", { patch }),
    call("code_validate_targeted"),
  ];
  return runPass({
    steps: GUIDED_PASS_STEPS_V1,
    options: { codeAutonomy: "free" },
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
