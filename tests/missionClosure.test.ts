import test from "node:test";
import assert from "node:assert/strict";
import { decideNextLoopAction } from "../src/agent/loopDecision";
import { constrainToolsToMissionGraphFrontier } from "../src/agent/missionGraphFrontier";
import { missionGraphTerminalProjectionSealsToolFrontierV1 } from "../src/agent/missionGraphFrontier";
import { missionGraphOnlyFinalSynthesisRemainsV1 } from "../src/agent/missionGraphSelectors";
import { shouldAcceptHeldFinalProjectionCandidateV1 } from "../src/agent/verifiedWorkspaceBinding";
import type { ModelToolDefinition } from "../src/model/types";

const tool = (name: string): ModelToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

const SET_LOOSE_READS = [
  "read_current_file",
  "web_search",
  "append_to_current_file",
];

function paidWriteQueuedFinalGraph() {
  return {
    nodes: {
      write: {
        id: "write",
        status: "complete",
        allowedTools: ["append_to_current_file"],
        inputs: {},
        outputs: {},
        receipts: [
          {
            id: "receipt-append-1",
            kind: "action-receipt",
            fingerprint: `sha256:${"a".repeat(64)}`,
            observedAt: "2026-08-25T22:41:00.000Z",
          },
        ],
      },
      final: {
        id: "final",
        status: "queued",
        allowedTools: [],
        inputs: {},
        outputs: {},
        completionContract: { requiredEvidenceKinds: ["final-output"] },
      },
    },
    capabilityEnvelope: { tools: {} },
  } as const;
}

const FORCE_FINAL_BUDGET = {
  hardCap: 5,
  toolStepBudget: 4,
  finalizationReserve: 1,
  expectedTools: ["web_search", "web_fetch"],
  stopWhenSatisfied: true,
};

test("force_final_no_tools + graph_final_only accepts a held candidate instead of a nonempty set-loose frontier", () => {
  const graph = paidWriteQueuedFinalGraph();
  assert.equal(missionGraphOnlyFinalSynthesisRemainsV1(graph as never), true);
  assert.equal(
    missionGraphTerminalProjectionSealsToolFrontierV1(graph as never),
    false,
    "queued finals are the hole: the seal requires ready/running/complete",
  );

  const decision = decideNextLoopAction(
    {
      successfulTools: ["web_search", "web_fetch"],
      failedTools: [],
      repeatedToolCalls: 0,
      requiredToolsSatisfied: true,
      finalizationReserved: true,
      writeCompleted: false,
    },
    FORCE_FINAL_BUDGET,
  );
  assert.deepEqual(decision, {
    action: "force_final_no_tools",
    reason: "required_tools_satisfied",
  });

  const reopened = constrainToolsToMissionGraphFrontier(
    SET_LOOSE_READS.map(tool),
    graph as never,
    { setLooseOfferedToolNames: SET_LOOSE_READS },
  ).map((item) => item.function.name);
  assert.ok(
    reopened.length > 0,
    `eval signature is force_final_no_tools + graph_final_only followed by a nonempty mission-graph-tool-frontier; got ${reopened.join(",") || "none"}`,
  );

  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate:
        "A relevant cited synthesis of the gathered sources for this mission.",
      acceptanceMissing: [
        "plan:final:final_relevance",
        "verifier:final:final_relevance",
      ],
      hasReadyToollessFinalNode: false,
      setLooseDeliveryStillUnpaid: false,
      pendingRequiredWriteCount: 0,
    }),
    true,
    "the held candidate is the one deterministic close; do not continue into that nonempty frontier",
  );
  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate: "draft",
      acceptanceMissing: [
        "plan:final:final_relevance",
        "receipt:write_receipt",
      ],
      hasReadyToollessFinalNode: true,
      setLooseDeliveryStillUnpaid: false,
      pendingRequiredWriteCount: 0,
    }),
    false,
    "substantive proof debt must never turn green through this close",
  );
});
