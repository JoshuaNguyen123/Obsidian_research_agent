import assert from "node:assert/strict";
import test from "node:test";
import { decideNextLoopAction } from "../src/agent/loopDecision";
import {
  fromAgentRunStopReason,
  loopDecisionToStopReason,
  stopReasonChatLine,
  formatStopReasonLabel,
} from "../src/agent/missionStopReason";
import {
  isMissionGraphAcceptablyComplete,
  collectRequiredDependencyIds,
  partitionGraphNodes,
} from "../src/agent/missionGraphAuthority";
import {
  createStreamWriteSession,
  recordAppliedBytes,
  shouldAbortReleasedChunk,
  createIdempotentStreamRetryPolicy,
  containsToolCallMarkup,
} from "../src/agent/streamedWritebackGuard";
import { schemasForStep } from "../src/agent/toolSchemaPolicy";

test("write_completed loop decision is verified complete, not budget", () => {
  const decision = decideNextLoopAction(
    {
      successfulTools: ["replace_current_file"],
      failedTools: [],
      repeatedToolCalls: 0,
      requiredToolsSatisfied: true,
      finalizationReserved: true,
      writeCompleted: true,
    },
    {
      hardCap: 5,
      toolStepBudget: 4,
      finalizationReserve: 1,
      expectedTools: ["replace_current_file"],
      stopWhenSatisfied: true,
    },
  );
  assert.deepEqual(decision, {
    action: "stop_verified_complete",
    reason: "write_completed",
  });
  assert.equal(loopDecisionToStopReason(decision), "write_completed");
  assert.match(stopReasonChatLine("write_completed"), /Write complete/i);
  assert.equal(formatStopReasonLabel("step_budget"), "Step budget");
  assert.equal(fromAgentRunStopReason("budget", "wall_clock_budget"), "wall_clock");
});

test("optional graph siblings never gate acceptance even if wrongly listed as deps", () => {
  const graph = {
    nodes: {
      "optional-web_search": {
        status: "ready",
        dependencyIds: [],
        allowedTools: ["web_search"],
        objective: "optional enrichment",
        completionContract: { requiredEvidenceKinds: [] },
      },
      write: {
        status: "complete",
        dependencyIds: [],
        allowedTools: ["replace_current_file"],
        objective: "write note",
        completionContract: { requiredEvidenceKinds: [] },
      },
      final: {
        status: "complete",
        dependencyIds: ["write", "optional-web_search"],
        allowedTools: [],
        objective: "final",
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
  } as never;

  assert.equal(isMissionGraphAcceptablyComplete(graph), true);
  const required = collectRequiredDependencyIds(graph, "final");
  assert.equal(required.has("write"), true);
  assert.equal(required.has("optional-web_search"), false);
  assert.equal(partitionGraphNodes(graph).optional.length, 1);
});

test("stream writeback guard aborts mid-stream tool markup after release", () => {
  const session = createStreamWriteSession();
  recordAppliedBytes(session, "Hello world. ");
  assert.equal(session.released, true);
  assert.equal(
    shouldAbortReleasedChunk(session, "More text <requested_tool_call>"),
    true,
  );
  assert.equal(session.aborted, true);
  const policy = createIdempotentStreamRetryPolicy(session);
  assert.equal(policy.allowRetry, false);
  assert.equal(containsToolCallMarkup('{"tool_calls":[]}'), true);
});

test("route-scoped schema policy keeps frontier plus route base only", () => {
  const schemas = schemasForStep({
    route: "current_note",
    frontier: ["replace_current_file"],
    graphRequired: [],
    allSchemas: [
      { type: "function", function: { name: "replace_current_file" } },
      { type: "function", function: { name: "read_current_file" } },
      { type: "function", function: { name: "web_search" } },
      { type: "function", function: { name: "linear_create_issue" } },
    ],
  });
  assert.deepEqual(
    schemas.map((s) => s.function.name).sort(),
    ["read_current_file", "replace_current_file"].sort(),
  );
});

test("fromAgentRunStopReason uses budget detail for wall-clock vs step budget", () => {
  assert.equal(fromAgentRunStopReason("budget", "wall_clock_budget"), "wall_clock");
  assert.equal(
    fromAgentRunStopReason("budget", "mission_graph_incomplete"),
    "graph_blocked",
  );
  assert.match(stopReasonChatLine("write_completed"), /Write complete/i);
});
