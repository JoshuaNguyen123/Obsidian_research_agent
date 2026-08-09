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

test("the tool is both offered and budgeted on every stage that can report", () => {
  // Two parallel allowlists govern a stage: lifecycleStagePolicy decides what
  // reaches the model's frontier, missionStageEnvelope decides what the
  // mutation budget authorizes. Wiring only the envelope means the tool is
  // authorized but never offered — the live run proved that silently, with the
  // model never seeing it. Keep them in step.
  for (const stage of [
    "accepted_research",
    "private_github_publication",
  ] as const) {
    assert.ok(
      toolsAllowedForLifecycleStage(stage).includes(
        REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
      ),
      `${stage} must offer the tool on the frontier`,
    );
  }
  for (const stage of [
    "accepted_research",
    "linear_hierarchy",
    "private_github_publication",
  ] as const) {
    assert.ok(
      toolsAllowedForEnvelopeStage(stage).includes(
        REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
      ),
      `${stage} must budget the tool's mutation`,
    );
  }
  // Listing it under linear_hierarchy would delete it from the reflection
  // turn, because that stage's tools are withdrawn once it is no longer the
  // earliest unpaid one.
  assert.equal(
    toolsAllowedForLifecycleStage("linear_hierarchy").includes(
      REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
    ),
    false,
  );
  // Cleanup is trash-only; a progress report has no business there.
  assert.equal(
    toolsAllowedForLifecycleStage("reconciliation_cleanup").includes(
      REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
    ),
    false,
  );
});

test("set-loose actually offers the tool at the reflection moment", () => {
  // The allowlists above are necessary but not sufficient. Under set-loose —
  // the autonomous mode — the offered frontier comes from this hardcoded
  // switch, keyed on the earliest unpaid delivery item. Two live runs passed
  // with the tool wired into both allowlists and still never offered, because
  // nothing routed it here.
  assert.ok(
    pendingToolsForUnpaidSetLooseDelivery(["note_reflection"]).includes(
      REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
    ),
    "reflection must be able to report back to the issue",
  );
  assert.ok(
    pendingToolsForUnpaidSetLooseDelivery(["linear_hierarchy"]).includes(
      REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
    ),
  );
  // Code and GitHub stages have no business reporting progress.
  assert.equal(
    pendingToolsForUnpaidSetLooseDelivery(["code_execution"]).includes(
      REPORT_PROGRESS_TO_LINEAR_TOOL_NAME,
    ),
    false,
  );
});

test("the reflection turn's real offered frontier contains the tool", () => {
  // The full chain the runner actually applies, not just the raw stage lists.
  // Three live runs could not answer this: run telemetry does not reliably
  // capture frontier contents (one capture reported zero rejected calls while
  // the operator watched several). Assert it deterministically instead.
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

  assert.ok(
    offered.includes(REPORT_PROGRESS_TO_LINEAR_TOOL_NAME),
    `reflection frontier was: ${offered.join(", ")}`,
  );
  assert.ok(offered.includes("append_to_current_file"));

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
