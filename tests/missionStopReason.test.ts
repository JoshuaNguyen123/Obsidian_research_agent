import assert from "node:assert/strict";
import test from "node:test";

import {
  fromAgentRunStopReason,
  stopReasonChatLine,
} from "../src/agent/missionStopReason";

test("unpaid set-loose delivery budget is not labeled relevance_rejected", () => {
  const withGraph = fromAgentRunStopReason(
    "budget",
    "set_loose_delivery_unpaid=code_execution;verifier:final_relevance;mission_graph_incomplete",
  );
  assert.equal(withGraph, "graph_blocked");
  assert.notEqual(withGraph, "relevance_rejected");

  const deliveryOnly = fromAgentRunStopReason(
    "budget",
    "set_loose_delivery_unpaid=code_execution,private_github_publication;verifier:final_relevance",
  );
  assert.equal(deliveryOnly, "step_budget");
  assert.match(stopReasonChatLine(deliveryOnly), /Paused at a safety limit/i);
});

test("graph blockers outrank final_relevance in budget detail", () => {
  const reason = fromAgentRunStopReason(
    "budget",
    "verifier:final_relevance;Recovery attempts exhausted for tool-06-code_validate_fast",
  );
  assert.equal(reason, "graph_blocked");
});

test("pure final_relevance budget still maps to relevance_rejected", () => {
  assert.equal(
    fromAgentRunStopReason("budget", "verifier:final_relevance"),
    "relevance_rejected",
  );
  assert.match(
    stopReasonChatLine("relevance_rejected"),
    /failed the relevance check/i,
  );
});

test("mission-graph authority errors map to graph_blocked not provider_error", () => {
  assert.equal(
    fromAgentRunStopReason(
      "error",
      "Model step failed: Tool append_to_current_file is not ready in the authoritative mission graph.",
    ),
    "graph_blocked",
  );
  assert.equal(
    fromAgentRunStopReason("error", "Network timeout talking to the provider"),
    "provider_error",
  );
});
