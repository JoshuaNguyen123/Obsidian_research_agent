import assert from "node:assert/strict";
import test from "node:test";

import {
  formatStopReasonLabel,
  fromAgentRunStopReason,
  stopReasonChatLine,
} from "../src/agent/missionStopReason";

test("a parked approval classifies as approval_pending ahead of every other budget word", () => {
  const detail =
    "approval_pending:approval-run-1-3; Approve replace_current_file when Chat asks again, then continue.;web_evidence;mission_graph_incomplete";
  assert.equal(fromAgentRunStopReason("budget", detail), "approval_pending");
  // It is a budget-class stop by design: the ledger stays resumable.
  assert.notEqual(fromAgentRunStopReason("budget", detail), "graph_blocked");
  // Without the marker the same detail is an ordinary budget pause.
  assert.equal(
    fromAgentRunStopReason("budget", "web_evidence;mission_graph_incomplete"),
    "graph_blocked",
  );
  // The word inside another token does not count.
  assert.equal(
    fromAgentRunStopReason("budget", "no_approval_pending_here;wall_clock"),
    "wall_clock",
  );
});

test("the parked copy says nothing changed and how to resume", () => {
  const line = stopReasonChatLine("approval_pending");
  assert.match(line, /^Parked:/u);
  assert.match(line, /Nothing was changed/u);
  assert.match(line, /Continue/u);
  assert.equal(formatStopReasonLabel("approval_pending"), "Approval pending");
});
