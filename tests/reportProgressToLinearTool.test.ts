import assert from "node:assert/strict";
import test from "node:test";

import {
  collectBoundLinearIssueIdsFromProjectLineagesV1,
  createReportProgressToLinearTool,
  resolveStatusState,
  REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
  type CreateReportProgressToLinearOptionsV1,
} from "../src/tools/reportProgressToLinearTool";
import type { ProjectLineageV1 } from "../src/agent/projectLifecycle";
import { toolsAllowedForLifecycleStage } from "../src/agent/lifecycleStagePolicy";
import { constrainSetLooseCompanionsToAutonomyScope } from "../src/AgentRunner";
import {
  pendingToolsForUnpaidSetLooseDelivery,
  toolsOfferedForSetLooseTurn,
} from "../src/agent/setLooseCompoundAutonomy";
import { toolsAllowedForEnvelopeStage } from "../src/agent/missionStageEnvelope";
import type { ToolExecutionContext } from "../src/tools/types";
import { ToolExecutionError } from "../src/tools/types";

const BOUND_ISSUE = "issue-bound-1";

const STATE_IDS = {
  started: "state-started",
  blocked: "state-blocked",
  completed: "state-completed",
};

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: "run-1",
    rootMissionId: "root-1",
    operationId: "tool-call-1",
    originalPrompt: "Research the topic and file a Linear issue.",
    ...overrides,
  } as ToolExecutionContext;
}

function createTool(
  overrides: Partial<CreateReportProgressToLinearOptionsV1> = {},
) {
  const comments: Array<{ issueId: string; body: string }> = [];
  const states: Array<{ issueId: string; stateId: string }> = [];
  const tool = createReportProgressToLinearTool({
    resolveBoundIssueIds: () => [BOUND_ISSUE],
    resolveStateIds: () => ({ ...STATE_IDS }),
    postComment: async ({ issueId, body }) => {
      comments.push({ issueId, body });
      return { receiptId: `receipt-comment-${comments.length}`, commentId: "comment-1" };
    },
    moveIssueState: async ({ issueId, stateId }) => {
      states.push({ issueId, stateId });
      return { receiptId: `receipt-state-${states.length}`, changed: true };
    },
    ...overrides,
  });
  return { tool, comments, states };
}

test("the tool keeps the reserved integrations name", () => {
  const { tool } = createTool();
  assert.equal(tool.name, REPORT_PROGRESS_TO_LINEAR_TOOL_NAME);
  assert.equal(tool.name, "report_progress_to_linear");
  // Not linear_-prefixed: toolSchemaPolicy drops /^(linear_|github_)/ on the
  // note and research routes, which is exactly where reflection runs.
  assert.doesNotMatch(tool.name, /^linear_/u);
});

test("progress issue authority is limited to the current root or segment lineage", async () => {
  const makeLineage = (runId: string, issueId: string) =>
    ({
      runId,
      commits: [{
        proof: {
        stage: "linear_hierarchy",
          issueIds: [issueId],
        },
      }],
    }) as unknown as ProjectLineageV1;
  const current = makeLineage("root-1", "issue-current");
  const unrelated = makeLineage("root-somebody-else", "issue-unrelated");
  assert.deepEqual(
    collectBoundLinearIssueIdsFromProjectLineagesV1(
      [unrelated, current],
      new Set(["root-1", "segment-1"]),
    ),
    ["issue-current"],
  );
});

test("the model-driven progress tool stays outside the autonomous lifecycle", () => {
  for (const stage of [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "reflection",
    "reconciliation_cleanup",
  ] as const) {
    assert.equal(
      toolsAllowedForLifecycleStage(stage).includes(
        REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
      ),
      false,
      `${stage} must rely on receipt-driven host progress`,
    );
    assert.equal(
      toolsAllowedForEnvelopeStage(stage).includes(
        REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
      ),
      false,
      `${stage} must not budget a model-selected progress mutation`,
    );
  }
});

test("set-loose never offers the model-driven progress tool", () => {
  for (const unpaid of [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "note_reflection",
    "reflection",
  ] as const) {
    assert.equal(
      pendingToolsForUnpaidSetLooseDelivery([unpaid]).includes(
        REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
      ),
      false,
    );
  }
});

test("the reflection frontier writes Results while progress remains host-owned", () => {
  const scope = {
    read: { currentNote: true, vault: true, folders: [], files: [], web: true },
    write: {
      currentNote: true,
      folders: [],
      files: [],
      artifacts: false,
      researchMemory: false,
    },
    destructive: {
      replaceCurrentNote: true,
      deleteCurrentNote: false,
      deletePaths: false,
    },
  };
  const offered = constrainSetLooseCompanionsToAutonomyScope(
    toolsOfferedForSetLooseTurn({
      stages: [
        "accepted_research",
        "linear_hierarchy",
        "code_execution",
        "private_github_publication",
      ],
      currentStage: "private_github_publication",
      passedFastRepairCycle: true,
      codeDeliveryPaid: true,
      unpaidDeliveryKeys: ["note_reflection"],
    }),
    scope,
  );

  assert.equal(offered.includes(REPORT_PROGRESS_TO_LINEAR_TOOL_NAME), false);
  assert.ok(offered.includes("write_project_results"));

  // The same chain with current-note writes unauthorized is what stranded a
  // live run: the host asked for a write while offering no write tool. If that
  // state is reachable it must at least not silently look healthy.
  const withoutWrite = constrainSetLooseCompanionsToAutonomyScope(
    toolsOfferedForSetLooseTurn({
      stages: ["accepted_research"],
      currentStage: "accepted_research",
      passedFastRepairCycle: false,
      codeDeliveryPaid: false,
      unpaidDeliveryKeys: ["accepted_research"],
    }),
    { ...scope, write: { ...scope.write, currentNote: false } },
  );
  assert.equal(withoutWrite.includes("append_to_current_file"), false);
});

test("each status maps onto the workspace's configured state id", async () => {
  for (const [status, expected] of [
    ["started", STATE_IDS.started],
    ["blocked", STATE_IDS.blocked],
    ["completed", STATE_IDS.completed],
  ] as const) {
    const { tool, states } = createTool();
    await tool.execute(
      { issueId: BOUND_ISSUE, status, comment: `Reporting ${status}.` },
      context(),
    );
    assert.deepEqual(states, [{ issueId: BOUND_ISSUE, stateId: expected }]);
  }
  assert.equal(resolveStatusState(null, STATE_IDS).stateId, null);
});

test("an unconfigured state posts the comment and skips the move", async () => {
  const { tool, comments, states } = createTool({
    resolveStateIds: () => ({ ...STATE_IDS, blocked: "" }),
  });
  const result = (await tool.execute(
    { issueId: BOUND_ISSUE, status: "blocked", comment: "Blocked on review." },
    context(),
  )) as Record<string, unknown>;

  assert.equal(comments.length, 1, "the comment must still be posted");
  assert.deepEqual(states, [], "no state move without a configured id");
  assert.match(String(result.stateOutcome), /skipped: no Linear state is configured/u);
});

test("an issue this run did not touch is refused", async () => {
  const { tool, comments } = createTool();
  await assert.rejects(
    () =>
      tool.execute(
        { issueId: "issue-somebody-elses", status: "completed", comment: "Done." },
        context(),
      ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "linear_progress_report_issue_not_bound",
  );
  assert.deepEqual(comments, [], "nothing may reach the provider");
});

test("a run with no bound Linear issue cannot report at all", async () => {
  const { tool } = createTool({ resolveBoundIssueIds: () => [] });
  await assert.rejects(
    () =>
      tool.execute(
        { issueId: BOUND_ISSUE, status: "completed", comment: "Done." },
        context(),
      ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "linear_progress_report_unbound_run",
  );
});

test("a comment carrying host-internal metadata never reaches the provider", async () => {
  for (const unsafe of [
    `Work item: sha256:${"a".repeat(64)}`,
    "## Machine contract",
    "<!-- agentic-researcher:work-item:v2:start -->",
    "Filled {{placeholder}} left behind",
  ]) {
    const { tool, comments } = createTool();
    await assert.rejects(
      () =>
        tool.execute(
          { issueId: BOUND_ISSUE, status: "completed", comment: unsafe },
          context(),
        ),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.code === "linear_progress_report_invalid_arguments",
      unsafe,
    );
    assert.deepEqual(comments, [], unsafe);
  }
});

test("an issue already at the requested level is a confirmation, not a failure", async () => {
  const { tool } = createTool({
    moveIssueState: async () => ({ receiptId: "", changed: false }),
  });
  const result = (await tool.execute(
    { issueId: BOUND_ISSUE, status: "completed", comment: "Wrapped up." },
    context(),
  )) as Record<string, unknown>;
  assert.equal(result.stateOutcome, "already completed");
});

test("progress is reported once per issue per run", async () => {
  const { tool, comments } = createTool();
  await tool.execute(
    { issueId: BOUND_ISSUE, status: "started", comment: "Starting." },
    context(),
  );
  await assert.rejects(
    () =>
      tool.execute(
        { issueId: BOUND_ISSUE, status: "completed", comment: "Again." },
        context(),
      ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "linear_progress_report_already_reported",
  );
  assert.equal(comments.length, 1, "a looping model must not spam the ticket");
});

test("status is optional and an unknown status is rejected", async () => {
  const { tool, comments, states } = createTool();
  const result = (await tool.execute(
    { issueId: BOUND_ISSUE, comment: "Note without a level change." },
    context(),
  )) as Record<string, unknown>;
  assert.equal(comments.length, 1);
  assert.deepEqual(states, []);
  assert.equal(result.status, null);
  assert.equal(result.stateOutcome, "no state change requested");

  const second = createTool();
  await assert.rejects(
    () =>
      second.tool.execute(
        { issueId: BOUND_ISSUE, status: "in_review", comment: "Bad level." },
        context(),
      ),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.code === "linear_progress_report_invalid_arguments",
  );
});
