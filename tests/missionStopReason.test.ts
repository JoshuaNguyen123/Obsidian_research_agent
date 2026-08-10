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

test("provider budget exhaustion is a resumable safety-limit pause, not an external blocker", () => {
  // The full stop detail of the 2026-08 failure: acceptance keys, the graph
  // marker, and the provider-budget message all in one string. It must read
  // as a budget pause even though "mission_graph_incomplete" is present.
  const reason = fromAgentRunStopReason(
    "budget",
    "tool:create_design_canvas,write_receipt,fetched_sources:1/3,research_plan_items," +
      "subquestion_evidence:rq-1:1/3,citation_url_coverage,limitations_section," +
      "confidence_section,plan:tool-01-create_design_canvas:artifact_receipt," +
      "plan:final:final_relevance,verifier:tool-01-create_design_canvas:artifact_receipt," +
      "verifier:final:final_relevance,research_phase_acceptance;gather;mission_graph_incomplete;" +
      'Provider execution budget exhausted before mission acceptance. Resolve the blocker, then run "continue run run-x".',
  );
  assert.equal(reason, "model_budget");
  assert.match(stopReasonChatLine(reason), /Paused at a safety limit/i);

  // The bare error category token classifies the same way.
  assert.equal(
    fromAgentRunStopReason("budget", "provider_budget_exhausted"),
    "model_budget",
  );

  // A graph blocker without the provider-budget message keeps its meaning.
  assert.equal(
    fromAgentRunStopReason("budget", "tool:web_fetch;mission_graph_incomplete"),
    "graph_blocked",
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
