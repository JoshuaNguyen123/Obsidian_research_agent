import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNextLoopAction,
  unresolvedFailedTools,
  type LoopLedger,
} from "../src/agent/loopDecision";

test("segment ledger counts host-prefetched successes and filters resolved failures", () => {
  const budget = {
    hardCap: 5,
    toolStepBudget: 4,
    finalizationReserve: 1,
    expectedTools: ["read_current_file", "web_search"],
    stopWhenSatisfied: true,
  };
  const firstFailureKill: LoopLedger = {
    successfulTools: [],
    failedTools: ["web_search"],
    repeatedToolCalls: 0,
    requiredToolsSatisfied: false,
    finalizationReserved: true,
    writeCompleted: false,
  };
  assert.deepEqual(
    decideNextLoopAction(firstFailureKill, budget),
    { action: "stop_budget", reason: "required_tools_failed" },
    "a true first failure with zero successes still stops",
  );

  assert.deepEqual(
    decideNextLoopAction(
      {
        ...firstFailureKill,
        hostPrefetchedSuccesses: ["read_current_file"],
      },
      budget,
    ),
    {
      action: "continue_planned_action",
      reason: "mission_plan_action_available",
    },
    "automatic read_current_file is a success; do not kill the segment",
  );

  assert.deepEqual(
    unresolvedFailedTools(
      ["web_search", "web_search", "read_current_file"],
      ["read_current_file"],
    ),
    ["web_search"],
    "acceptance's resolved-failure filter drops tools that later succeeded",
  );
  assert.deepEqual(
    decideNextLoopAction(
      {
        successfulTools: [],
        hostPrefetchedSuccesses: ["read_current_file"],
        failedTools: unresolvedFailedTools(
          ["read_current_file", "web_search"],
          ["read_current_file"],
        ),
        repeatedToolCalls: 0,
        requiredToolsSatisfied: false,
        finalizationReserved: true,
        writeCompleted: false,
      },
      budget,
    ),
    {
      action: "continue_planned_action",
      reason: "mission_plan_action_available",
    },
  );
});
