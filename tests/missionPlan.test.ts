import test from "node:test";
import assert from "node:assert/strict";
import { deriveAutonomyScope } from "../src/agent/missionScope";
import {
  createMissionPlan,
  getNextMissionPlanAction,
  isMissionPlanComplete,
  receiptSatisfiesProof,
  type MissionPlan,
} from "../src/agent/missionPlan";
import {
  advanceMissionPlanFromFinalOutput,
  advanceMissionPlanFromReceipt,
  advanceMissionPlanFromToolResult,
} from "../src/agent/missionPlanAdvance";
import { evaluateMissionPlanAcceptance } from "../src/agent/missionPlanAcceptance";
import { runMissionVerifiers } from "../src/agent/verifiers";
import {
  createMissionLedger,
  setLedgerMissionPlan,
  summarizeMissionLedger,
  type MissionEvidence,
} from "../src/agent/missionLedger";
import type { MissionIntent, ToolExecutionResult } from "../src/tools/types";

test("mission plan infers proof contract and next action from the mission", () => {
  const plan = createTestPlan(
    "Research latest sources and append a cited summary to the current note.",
    ["web_search", "web_fetch", "append_to_current_file"],
  );

  assert.equal(plan.status, "in_progress");
  assert.equal(plan.progress.totalTasks, 3);
  assert.deepEqual(
    plan.tasks.map((task) => ({
      id: task.id,
      dependencies: task.dependencies,
      proof: task.completionContract.requiredProof,
    })),
    [
      {
        id: "task-research-web",
        dependencies: [],
        proof: ["web_evidence"],
      },
      {
        id: "task-act",
        dependencies: ["task-research-web"],
        proof: ["write_receipt"],
      },
      {
        id: "task-verify",
        dependencies: ["task-act"],
        proof: ["final_relevance"],
      },
    ],
  );
  assert.deepEqual(getNextMissionPlanAction(plan), {
    kind: "tool",
    taskId: "task-research-web",
    toolName: "web_search",
    summary: "Gather required web evidence.",
  });
});

test("mission plan retains required mutation tools when route reads fill the task cap", () => {
  const routeReadTools = Array.from(
    { length: 14 },
    (_, index) => `read_tool_${index + 1}`,
  );
  const requiredTools = ["rename_current_file", "append_to_current_file"];
  const plan = createMissionPlan({
    runId: "run:test",
    prompt: "Rename the current note and append the completed research summary.",
    missionIntent: createIntent(true),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames: routeReadTools,
    },
    requiredTools,
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  assert.equal(plan.tasks[0].allowedTools.length, 12);
  assert.deepEqual(plan.tasks[0].allowedTools.slice(0, 2), requiredTools);
  assert.ok(plan.tasks[0].allowedTools.includes("rename_current_file"));
  assert.ok(plan.tasks[0].allowedTools.includes("append_to_current_file"));
  assert.deepEqual(plan.tasks[0].completionContract.requiredProof, [
    "write_receipt",
    "rename_receipt",
  ]);
});

test("external action receipts are domain-specific and never prove a vault write", () => {
  const plan = createTestPlan(
    "Create a Linear issue titled Research follow-up.",
    ["linear_create_issue"],
  );
  assert.ok(
    plan.tasks.some((task) =>
      task.completionContract.requiredProof.includes(
        "external_action_receipt",
      ),
    ),
  );

  const externalReceipt = {
    toolName: "linear_create_issue",
    operation: "create",
    path: "Current.md",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: "issue-123",
    },
  };
  assert.equal(
    receiptSatisfiesProof("external_action_receipt", externalReceipt),
    true,
  );
  assert.equal(receiptSatisfiesProof("write_receipt", externalReceipt), false);
  assert.equal(
    receiptSatisfiesProof("write_receipt", {
      toolName: "append_to_current_file",
      operation: "append",
      path: "Current.md",
      resource: {
        system: "vault",
        resourceType: "markdown",
        id: "Current.md",
      },
    }),
    true,
  );

  const accepted = evaluateMissionPlanAcceptance({
    prompt: "Create a Linear issue titled Research follow-up.",
    missionIntent: createIntent(false),
    requiredTools: ["linear_create_issue"],
    successfulTools: ["linear_create_issue"],
    failedTools: [],
    evidence: [],
    receipts: [externalReceipt],
    operationGoals: {},
    finalOutput: "Created Linear issue RES-123.",
    plan,
  });
  assert.equal(
    accepted.missing.some((item) => item.includes("external_action_receipt")),
    false,
  );
});

test("workspace mutations satisfy write proof while reads and external actions do not", () => {
  const workspaceMutation = {
    toolName: "code_workspace_create_file",
    operation: "create",
    path: "src/value.txt",
    resource: {
      system: "workspace",
      resourceType: "code_workspace",
      id: "workspace:test",
    },
  };
  assert.equal(
    receiptSatisfiesProof("write_receipt", workspaceMutation),
    true,
  );
  assert.equal(
    receiptSatisfiesProof("write_receipt", {
      ...workspaceMutation,
      toolName: "code_workspace_write_expected",
      operation: "replace",
    }),
    true,
  );
  assert.equal(
    receiptSatisfiesProof("write_receipt", {
      ...workspaceMutation,
      toolName: "code_workspace_read",
      operation: "read",
    }),
    false,
  );
  assert.equal(
    receiptSatisfiesProof("write_receipt", {
      toolName: "github_create_pull_request",
      operation: "create",
      resource: {
        system: "github",
        resourceType: "pull_request",
        id: "owner/repo#1",
      },
    }),
    false,
  );
});

test("mission plan ignores premature append proof while web research is active", () => {
  const plan = createTestPlan(
    "Research latest sources and append a cited summary to the current note.",
    ["web_search", "web_fetch", "append_to_current_file"],
  );
  assert.equal(plan.activeTaskId, "task-research-web");

  const toolAdvance = advanceMissionPlanFromToolResult({
    plan,
    toolName: "append_to_current_file",
    result: okResult("append_to_current_file", {
      operation: "append",
      path: "Current.md",
      bytesWritten: 48,
    }),
  });
  assert.equal(toolAdvance.changed, false);
  assert.equal(toolAdvance.plan, plan);

  const receiptAdvance = advanceMissionPlanFromReceipt({
    plan,
    receipt: {
      toolName: "append_to_current_file",
      operation: "append",
      path: "Current.md",
      bytesWritten: 48,
      message: "Premature append must not satisfy a future task.",
    },
  });
  assert.equal(receiptAdvance.changed, false);
  assert.equal(receiptAdvance.plan, plan);
  assert.equal(receiptAdvance.plan.activeTaskId, "task-research-web");
  assert.equal(receiptAdvance.plan.progress.completedTasks, 0);
  assert.deepEqual(receiptAdvance.plan.tasks[1].receiptIds, []);
  assert.deepEqual(getNextMissionPlanAction(receiptAdvance.plan), {
    kind: "tool",
    taskId: "task-research-web",
    toolName: "web_search",
    summary: "Gather required web evidence.",
  });
});

test("mission plan does not require web evidence for current-note word counts", () => {
  const plan = createTestPlan(
    "Count the words in the current note before answering.",
    ["count_words"],
  );

  assert.deepEqual(plan.tasks[0].completionContract.requiredProof, [
    "word_count",
  ]);
  assert.deepEqual(getNextMissionPlanAction(plan), {
    kind: "tool",
    taskId: "task-1",
    toolName: "count_words",
    summary: "Verify word count.",
  });
});

test("mission plan acceptance treats count_words as word-count proof", () => {
  const plan = advanceMissionPlanFromToolResult({
    plan: createTestPlan(
      "Count the words in the current note before answering.",
      ["count_words"],
    ),
    toolName: "count_words",
    result: okResult("count_words", { wordCount: 42 }),
  }).plan;

  const acceptance = evaluateMissionPlanAcceptance({
    prompt: "Count the words in the current note before answering.",
    missionIntent: createIntent(false),
    successfulTools: ["count_words"],
    failedTools: [],
    requiredTools: ["count_words"],
    receipts: [],
    evidence: [],
    operationGoals: {},
    finalOutput: "There are 42 words.",
    plan,
  });

  assert.equal(acceptance.status, "pass");
});

test("mission plan acceptance recognizes semantic vault-search evidence", () => {
  const plan = createTestPlan(
    "Research across my notes about local retrieval coverage.",
    ["semantic_search_notes"],
  );
  const taskId = plan.tasks[0].id;
  plan.tasks[0] = {
    ...plan.tasks[0],
    status: "complete",
    evidenceIds: ["vault_search:local-retrieval"],
    completionContract: {
      ...plan.tasks[0].completionContract,
      requiredProof: ["vault_evidence"],
    },
  };
  plan.activeTaskId = null;

  const acceptance = evaluateMissionPlanAcceptance({
    prompt: "Research across my notes about local retrieval coverage.",
    missionIntent: createIntent(false),
    successfulTools: ["semantic_search_notes"],
    failedTools: [],
    requiredTools: ["semantic_search_notes"],
    receipts: [],
    evidence: [
      {
        id: "vault_search:local-retrieval",
        kind: "vault_note",
        title: "Semantic vault results",
        path: "Notes/Retrieval.md",
        summary: "Local retrieval evidence.",
        confidence: "high",
      },
    ],
    operationGoals: {},
    finalOutput: "Local retrieval evidence is present in the vault.",
    plan,
  });

  assert.equal(taskId.length > 0, true);
  assert.equal(
    acceptance.missing.some((item) => item.includes("vault_evidence")),
    false,
  );
});

test("projected graph-context proof survives ledger evidence ID normalization", () => {
  const plan = createTestPlan(
    "Inspect the current note graph before answering.",
    ["get_note_graph_context"],
  );
  plan.tasks[0] = {
    ...plan.tasks[0],
    status: "complete",
    // MissionGraph's generic read projection classifies graph context as
    // vault proof even though the canonical ledger retains graph:*.
    evidenceIds: ["vault:graph:local-context"],
    completionContract: {
      ...plan.tasks[0].completionContract,
      requiredProof: ["vault_evidence"],
    },
  };
  const evidence: MissionEvidence[] = [{
    id: "graph:local-context",
    kind: "tool_result",
    title: "Graph context",
    summary: "Bounded local note graph context.",
    confidence: "medium",
  }];

  const acceptance = evaluateMissionPlanAcceptance({
    prompt: "Inspect the current note graph before answering.",
    missionIntent: createIntent(false),
    successfulTools: ["get_note_graph_context"],
    failedTools: [],
    requiredTools: ["get_note_graph_context"],
    receipts: [],
    evidence,
    operationGoals: {},
    finalOutput: "The bounded note graph context was inspected.",
    plan,
  });
  const verification = runMissionVerifiers({
    plan,
    evidence,
    receipts: [],
    finalOutput: "The bounded note graph context was inspected.",
  });

  assert.equal(
    acceptance.missing.some((item) => item.includes("vault_evidence")),
    false,
  );
  assert.equal(
    verification.missing.some((item) => item.includes("vault_evidence")),
    false,
  );
});

test("mission plan expects blocker proof for broad unscoped vault mutation", () => {
  const prompt = "Update my whole vault with this project summary.";
  const missionIntent: MissionIntent = {
    mode: "explicit_file_mutation",
    vaultContext: true,
    noteOutput: false,
    explicitPersistence: true,
    explicitMutation: true,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: deriveAutonomyScope(prompt, {
      noteOutput: true,
      explicitPersistence: true,
      explicitMutation: true,
    }),
  };
  const plan = createMissionPlan({
    runId: "run:test",
    prompt,
    missionIntent,
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames: ["list_markdown_files", "read_file"],
    },
    requiredTools: [],
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  assert.deepEqual(plan.tasks[0].completionContract.requiredProof, ["blocker"]);
  assert.deepEqual(getNextMissionPlanAction(plan), {
    kind: "verify",
    taskId: "task-1",
    summary: "Verify this task against its completion contract.",
  });
});

test("mission plan advances from evidence and receipt into verified completion", () => {
  let plan = createTestPlan(
    "Research latest sources and append a cited summary to the current note.",
    ["web_search", "append_to_current_file"],
  );
  const evidence: MissionEvidence = {
    id: "web:source",
    kind: "web_source",
    title: "Source",
    url: "https://example.com/source",
    passageId: "source:example:passage:0-100",
    passageIds: ["source:example:passage:0-100"],
    usableSource: true,
    summary: "Useful source.",
    confidence: "high",
  };

  const toolAdvance = advanceMissionPlanFromToolResult({
    plan,
    toolName: "web_search",
    result: okResult("web_search", { results: [{ url: evidence.url }] }),
    evidence,
    now: new Date("2026-07-07T12:00:00.000Z"),
  });
  plan = toolAdvance.plan;
  assert.equal(plan.tasks[0].status, "complete");
  assert.equal(plan.activeTaskId, "task-act");
  assert.equal(getNextMissionPlanAction(plan)?.kind, "write");

  const receiptAdvance = advanceMissionPlanFromReceipt({
    plan,
    receipt: {
      toolName: "append_to_current_file",
      operation: "append",
      path: "Current.md",
      message: "Appended cited summary.",
      bytesWritten: 120,
    },
    evidenceId: "receipt:append",
    now: new Date("2026-07-07T12:01:00.000Z"),
  });
  plan = receiptAdvance.plan;

  assert.equal(isMissionPlanComplete(plan), false);
  assert.equal(plan.status, "in_progress");
  assert.equal(plan.progress.completedTasks, 2);
  assert.equal(plan.activeTaskId, "task-verify");
  assert.equal(plan.nextAction?.kind, "verify");

  plan = advanceMissionPlanFromFinalOutput({
    plan,
    finalOutput: "Latest sources were checked and the cited summary was appended.",
    now: new Date("2026-07-07T12:02:00.000Z"),
  }).plan;

  assert.equal(isMissionPlanComplete(plan), true);
  assert.equal(plan.status, "complete");
  assert.equal(plan.progress.completedTasks, 3);
  assert.equal(plan.nextAction?.kind, "final");
});

test("mission plan acceptance blocks final completion until required proof exists", () => {
  const evidence: MissionEvidence = {
    id: "web:source",
    kind: "web_source",
    title: "Source",
    url: "https://example.com/source",
    passageId: "source:example:passage:0-100",
    passageIds: ["source:example:passage:0-100"],
    usableSource: true,
    summary: "Useful source.",
    confidence: "high",
  };
  const plan = createTestPlan(
    "Research latest sources and append a cited summary to the current note.",
    ["web_search", "append_to_current_file"],
  );

  const missingReceipt = evaluateMissionPlanAcceptance({
    prompt: "Research latest sources and append a cited summary to the current note.",
    missionIntent: createIntent(true),
    requiredTools: ["web_search", "append_to_current_file"],
    successfulTools: ["web_search"],
    failedTools: [],
    evidence: [evidence],
    receipts: [],
    operationGoals: {},
    plan,
  });
  assert.equal(missingReceipt.status, "fail");
  assert.ok(missingReceipt.missing.includes("write_receipt"));
  assert.ok(missingReceipt.missing.includes("plan:task-act:write_receipt"));

  const restoredReceipt = evaluateMissionPlanAcceptance({
    prompt: "Research latest sources and append a cited summary to the current note.",
    missionIntent: createIntent(true),
    requiredTools: ["web_search", "append_to_current_file"],
    successfulTools: ["web_search", "append_to_current_file"],
    failedTools: [],
    evidence: [evidence],
    receipts: [
      {
        toolName: "append_to_current_file",
        operation: "append",
        path: "Current.md",
      },
    ],
    operationGoals: {},
    plan,
  });
  assert.equal(
    restoredReceipt.missing.includes("plan:task-act:write_receipt"),
    false,
    "a persisted receipt must remain valid proof after a child segment reload",
  );

  const withReceipt = evaluateMissionPlanAcceptance({
    prompt: "Research latest sources and append a cited summary to the current note.",
    missionIntent: createIntent(true),
    requiredTools: ["web_search", "append_to_current_file"],
    successfulTools: ["web_search", "append_to_current_file"],
    failedTools: [],
    evidence: [evidence],
    receipts: [
      {
        toolName: "append_to_current_file",
        operation: "append",
        path: "Current.md",
      },
    ],
    operationGoals: {},
    plan: completeWithReceipt(plan),
  });
  assert.equal(withReceipt.status, "pass");
});

test("code missions require an exit-code-0 run before the proof contract passes", () => {
  const prompt = "Run this python code snippet and report the output.";
  let plan = createMissionPlan({
    runId: "run:test",
    prompt,
    missionIntent: createIntent(false),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames: ["run_code_block", "read_current_file"],
    },
    requiredTools: ["run_code_block"],
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  assert.deepEqual(plan.tasks[0].completionContract.requiredProof, [
    "code_execution",
  ]);
  assert.deepEqual(getNextMissionPlanAction(plan), {
    kind: "tool",
    taskId: "task-1",
    toolName: "run_code_block",
    summary: "Run the requested code until it exits with code 0.",
  });

  plan = advanceMissionPlanFromToolResult({
    plan,
    toolName: "run_code_block",
    result: okResult("run_code_block", {
      language: "python",
      operation: "run",
      result: { exitCode: 1, stdout: "", stderr: "Boom", timedOut: false },
    }),
    now: new Date("2026-07-07T12:01:00.000Z"),
  }).plan;
  assert.equal(plan.tasks[0].status, "in_progress");
  assert.equal(getNextMissionPlanAction(plan)?.toolName, "run_code_block");
  const failedAcceptance = evaluateMissionPlanAcceptance({
    prompt,
    missionIntent: createIntent(false),
    requiredTools: ["run_code_block"],
    successfulTools: ["run_code_block"],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "The code failed with exit code 1.",
    plan,
  });
  assert.notEqual(failedAcceptance.status, "pass");
  assert.ok(failedAcceptance.missing.includes("plan:task-1:code_execution"));

  plan = advanceMissionPlanFromToolResult({
    plan,
    toolName: "run_code_block",
    result: okResult("run_code_block", {
      language: "python",
      operation: "run",
      result: { exitCode: 0, stdout: "42", stderr: "", timedOut: false },
    }),
    now: new Date("2026-07-07T12:02:00.000Z"),
  }).plan;
  assert.equal(plan.tasks[0].status, "complete");
  const passedAcceptance = evaluateMissionPlanAcceptance({
    prompt,
    missionIntent: createIntent(false),
    requiredTools: ["run_code_block"],
    successfulTools: ["run_code_block"],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "The code printed 42.",
    plan,
  });
  assert.equal(passedAcceptance.status, "pass");
});

test("code proof treats timeouts and blocked runs as failures", () => {
  const prompt = "Execute the javascript snippet.";
  const basePlan = createMissionPlan({
    runId: "run:test",
    prompt,
    missionIntent: createIntent(false),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames: ["run_code_block"],
    },
    requiredTools: ["run_code_block"],
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  const timedOut = advanceMissionPlanFromToolResult({
    plan: basePlan,
    toolName: "run_code_block",
    result: okResult("run_code_block", {
      language: "javascript",
      operation: "run",
      result: { exitCode: 0, stdout: "", stderr: "", timedOut: true },
    }),
  }).plan;
  assert.equal(timedOut.tasks[0].status, "in_progress");

  const blocked = advanceMissionPlanFromToolResult({
    plan: basePlan,
    toolName: "run_code_block",
    result: okResult("run_code_block", {
      status: "requires_approval",
      toolName: "run_code_block",
      reason: "Code execution timeout exceeds 30000ms.",
    }),
  }).plan;
  assert.equal(blocked.tasks[0].status, "in_progress");

  const htmlPreview = advanceMissionPlanFromToolResult({
    plan: basePlan,
    toolName: "run_code_block",
    result: okResult("run_code_block", {
      language: "html",
      operation: "render_html_preview",
      bytesRendered: 512,
    }),
  }).plan;
  assert.equal(htmlPreview.tasks[0].status, "complete");
});

test("mission ledger summary exposes mission-plan progress for run details", () => {
  const plan = createTestPlan(
    "Research latest sources and append a cited summary to the current note.",
    ["web_search", "append_to_current_file"],
  );
  const ledger = createMissionLedger({
    runId: "run:test",
    mission: "Research latest sources and append a cited summary to the current note.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 100,
      toolStepBudget: 24,
      finalizationReserve: 4,
      expectedTools: ["web_search", "append_to_current_file"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-07T12:00:00.000Z"),
  });

  setLedgerMissionPlan(ledger, plan, new Date("2026-07-07T12:00:00.000Z"));
  const summary = summarizeMissionLedger(ledger);

  assert.equal(summary.iterationCount, 0);
  assert.equal(summary.missionPlan?.status, "in_progress");
  assert.equal(summary.missionPlan?.activeTaskId, "task-research-web");
  assert.equal(summary.missionPlan?.remainingTasks, 3);
  assert.equal(summary.remainingActions[0], "Gather required web evidence.");
});

function createTestPlan(prompt: string, allowedToolNames: string[]): MissionPlan {
  return createMissionPlan({
    runId: "run:test",
    prompt,
    missionIntent: createIntent(allowedToolNames.some((tool) => /append|replace|write/.test(tool))),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_model_planning",
      allowedToolNames,
    },
    requiredTools: allowedToolNames,
    now: new Date("2026-07-07T12:00:00.000Z"),
  });
}

function completeWithReceipt(plan: MissionPlan): MissionPlan {
  const evidence: MissionEvidence = {
    id: "web:source",
    kind: "web_source",
    title: "Source",
    url: "https://example.com/source",
    passageId: "source:example:passage:0-100",
    passageIds: ["source:example:passage:0-100"],
    usableSource: true,
    summary: "Useful source.",
    confidence: "high",
  };
  const withEvidence = advanceMissionPlanFromToolResult({
    plan,
    toolName: "web_search",
    result: okResult("web_search", {}),
    evidence,
  }).plan;
  const withReceipt = advanceMissionPlanFromReceipt({
    plan: withEvidence,
    receipt: {
      toolName: "append_to_current_file",
      operation: "append",
      path: "Current.md",
      message: "Appended cited summary.",
      bytesWritten: 120,
    },
  }).plan;
  return advanceMissionPlanFromFinalOutput({
    plan: withReceipt,
    finalOutput:
      "Latest sources were checked and source:example:passage:0-100 was appended.",
  }).plan;
}

function createIntent(requireWriteCompletion: boolean): MissionIntent {
  return {
    mode: requireWriteCompletion ? "note_output" : "vault_context_answer",
    vaultContext: false,
    noteOutput: requireWriteCompletion,
    explicitPersistence: requireWriteCompletion,
    explicitMutation: requireWriteCompletion,
    explicitDelete: false,
    allowAutonomousWrite: requireWriteCompletion,
    requireWriteCompletion,
    autonomyScope: deriveAutonomyScope("append to current note", {
      noteOutput: requireWriteCompletion,
      explicitPersistence: requireWriteCompletion,
      explicitMutation: requireWriteCompletion,
    }),
  };
}

function okResult(toolName: string, output: unknown): ToolExecutionResult {
  return {
    ok: true,
    toolName,
    output,
  };
}
