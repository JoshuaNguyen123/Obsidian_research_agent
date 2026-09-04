import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNextLoopAction,
  proseAnswerCannotFinishMissionV1,
  shouldKeepLoopOpenForCitationGatherStallV1,
} from "../src/agent/loopDecision";
import {
  CITATION_GROUNDING_GATHER_TOOL_NAMES,
  citationGatherUnpaidMissingV1,
  constrainToolsToMissionGraphFrontier,
  missionGraphTerminalProjectionSealsToolFrontierV1,
  sealedFrontierShouldKeepCitationGatherV1,
  unpaidProofRequiresCitationGatherV1,
} from "../src/agent/missionGraphFrontier";
import {
  authoritativeRefusalFrontierToolNamesV1,
  missionGraphOnlyFinalSynthesisRemainsV1,
} from "../src/agent/missionGraphSelectors";
import {
  heldFinalProjectionHasUnpaidProofDebtV1,
  shouldAcceptHeldFinalProjectionCandidateV1,
} from "../src/agent/verifiedWorkspaceBinding";
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

  const citationGatherKeepsTools = decideNextLoopAction(
    {
      successfulTools: ["web_search", "web_fetch", "verify_citation"],
      failedTools: [],
      repeatedToolCalls: 0,
      requiredToolsSatisfied: true,
      citationGatherStillUnpaid: true,
      finalizationReserved: true,
      writeCompleted: false,
    },
    FORCE_FINAL_BUDGET,
  );
  assert.equal(
    citationGatherKeepsTools.action,
    "continue_planned_action",
    "unpaid claim-grounding must not force a tool-less final against an executable gather menu",
  );

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

function paidByokBriefQueuedFinalGraph() {
  return {
    nodes: {
      "tool-04-create_project_idea_brief": {
        id: "tool-04-create_project_idea_brief",
        status: "complete",
        allowedTools: ["create_project_idea_brief"],
        inputs: {},
        outputs: {},
        receipts: [
          {
            id: "receipt-brief-1",
            kind: "action-receipt",
            fingerprint: `sha256:${"b".repeat(64)}`,
            observedAt: "2026-09-04T10:00:00.000Z",
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

const BYOK_SET_LOOSE = [
  "create_project_idea_brief",
  "web_search",
  "append_to_current_file",
];

test("BYOK create_project_idea_brief leftover on set-loose does not block a held terminal close", () => {
  const graph = paidByokBriefQueuedFinalGraph();
  assert.equal(missionGraphOnlyFinalSynthesisRemainsV1(graph as never), true);

  const decision = decideNextLoopAction(
    {
      successfulTools: ["web_search", "web_fetch", "create_project_idea_brief"],
      failedTools: [],
      repeatedToolCalls: 0,
      requiredToolsSatisfied: true,
      finalizationReserved: true,
      writeCompleted: false,
    },
    FORCE_FINAL_BUDGET,
  );
  assert.equal(decision.action, "force_final_no_tools");

  const reopened = constrainToolsToMissionGraphFrontier(
    BYOK_SET_LOOSE.map(tool),
    graph as never,
    { setLooseOfferedToolNames: BYOK_SET_LOOSE },
  ).map((item) => item.function.name);
  assert.ok(
    reopened.length > 0,
    `eval signature is force_final_no_tools + graph_final_only followed by a nonempty set-loose frontier (BYOK leftover companions); got ${reopened.join(",") || "none"}`,
  );
  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(
      BYOK_SET_LOOSE.map(tool),
      graph as never,
      {
        setLooseOfferedToolNames: BYOK_SET_LOOSE,
        sealForForcedFinal: true,
      },
    ).map((item) => item.function.name),
    [],
    "force_final + paid graph seals the leftover brief instead of looping it",
  );

  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate:
        "Selected option B from the two fetched URLs and recorded the project idea brief.",
      acceptanceMissing: ["plan:final:final_output", "verifier:final:final_relevance"],
      hasReadyToollessFinalNode: true,
      setLooseDeliveryStillUnpaid: false,
      pendingRequiredWriteCount: 0,
    }),
    true,
    "ready tool-less final + only final_output/final_relevance must finishRun(final)",
  );
});

test("compound unpaid set-loose delivery and unpaid citations stay red", () => {
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
  assert.equal(decision.action, "force_final_no_tools");

  assert.equal(
    heldFinalProjectionHasUnpaidProofDebtV1([
      "plan:final:final_relevance",
      "receipt:write_receipt",
    ]),
    true,
  );
  assert.equal(
    heldFinalProjectionHasUnpaidProofDebtV1([
      "verifier:citation_coverage:research",
    ]),
    true,
  );
  assert.equal(
    heldFinalProjectionHasUnpaidProofDebtV1([
      "set_loose:note_reflection",
      "linear_hierarchy",
    ]),
    true,
  );
  assert.equal(
    heldFinalProjectionHasUnpaidProofDebtV1([
      "plan:final:final_output",
      "plan:final:final_relevance",
    ]),
    false,
  );

  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate: "Compound draft naming Linear and GitHub URLs.",
      acceptanceMissing: ["plan:final:final_relevance"],
      hasReadyToollessFinalNode: true,
      setLooseDeliveryStillUnpaid: true,
      pendingRequiredWriteCount: 0,
    }),
    false,
    "unpaid set-loose delivery is a real red",
  );
  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate: "Cited draft without receipts.",
      acceptanceMissing: [
        "verifier:citation_coverage:research",
        "plan:final:final_relevance",
      ],
      hasReadyToollessFinalNode: true,
      setLooseDeliveryStillUnpaid: false,
      pendingRequiredWriteCount: 0,
    }),
    false,
    "unpaid citations stay red even beside final_relevance",
  );
  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate: "Receipt-backed synthesis already projected.",
      acceptanceMissing: [],
      hasReadyToollessFinalNode: true,
      setLooseDeliveryStillUnpaid: false,
      pendingRequiredWriteCount: 0,
    }),
    true,
    "an already-paid held candidate closes instead of reopening the menu",
  );
  assert.equal(
    shouldAcceptHeldFinalProjectionCandidateV1({
      loopAction: decision.action,
      graphFinalOnly: true,
      heldCandidate: "Ready tool-less final still owes only projection.",
      acceptanceMissing: [
        "mission_plan_incomplete",
        "plan:final:final_output",
        "verifier:final:final_relevance",
      ],
      hasReadyToollessFinalNode: true,
      setLooseDeliveryStillUnpaid: false,
      pendingRequiredWriteCount: 0,
    }),
    true,
  );
});

test("unpaid claim-grounding keeps citation gather on a sealed terminal frontier", () => {
  assert.equal(
    unpaidProofRequiresCitationGatherV1([
      "verifier:claim_grounding:quote_mismatch",
      "plan:final:final_relevance",
    ]),
    true,
  );
  assert.equal(
    unpaidProofRequiresCitationGatherV1(["verifier:citation_coverage:research"]),
    true,
  );
  assert.equal(
    unpaidProofRequiresCitationGatherV1([
      "receipt:write_receipt",
      "plan:final:final_output",
    ]),
    false,
    "write receipts stay sealed; they are not citation gather",
  );
  assert.equal(
    unpaidProofRequiresCitationGatherV1(["create_project_idea_brief"]),
    false,
  );

  const queued = paidByokBriefQueuedFinalGraph();
  const graph = {
    ...queued,
    nodes: {
      ...queued.nodes,
      final: {
        ...queued.nodes.final,
        status: "ready",
      },
    },
  };
  assert.equal(
    missionGraphTerminalProjectionSealsToolFrontierV1(graph as never),
    true,
  );

  const catalog = [
    "create_project_idea_brief",
    "web_search",
    "web_fetch",
    "verify_citation",
    "read_source_section",
    "append_to_current_file",
  ].map(tool);

  assert.deepEqual(
    constrainToolsToMissionGraphFrontier(catalog, graph as never, {
      setLooseOfferedToolNames: [
        "create_project_idea_brief",
        "web_search",
        "append_to_current_file",
      ],
    }).map((item) => item.function.name),
    [],
    "without the gather exception the terminal seal still empties leftover Soft-union",
  );

  const gathered: string[] = constrainToolsToMissionGraphFrontier(catalog, graph as never, {
    setLooseOfferedToolNames: [
      "create_project_idea_brief",
      "web_search",
      "append_to_current_file",
    ],
    keepCitationGatherOnSealedFrontier: true,
  }).map((item) => item.function.name);
  assert.equal(gathered.includes("create_project_idea_brief"), false);
  assert.equal(gathered.includes("append_to_current_file"), false);
  assert.deepEqual(
    gathered,
    [...CITATION_GROUNDING_GATHER_TOOL_NAMES],
    "sealed terminal + unpaid claims offers gather tools, not leftover brief/write companions",
  );

  const queuedSealed = constrainToolsToMissionGraphFrontier(catalog, queued as never, {
    setLooseOfferedToolNames: BYOK_SET_LOOSE,
    sealForForcedFinal: true,
    keepCitationGatherOnSealedFrontier: true,
  }).map((item) => item.function.name);
  assert.deepEqual(queuedSealed, [...CITATION_GROUNDING_GATHER_TOOL_NAMES]);

  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph: graph as never,
      candidateToolNames: gathered,
      allowDynamicReadContinuation: false,
      admittedCompanionToolNames: [...CITATION_GROUNDING_GATHER_TOOL_NAMES],
    }),
    [...CITATION_GROUNDING_GATHER_TOOL_NAMES],
    "refusal messages may name the same gather tools the sealed frontier offered",
  );
  assert.deepEqual(
    authoritativeRefusalFrontierToolNamesV1({
      graph: graph as never,
      candidateToolNames: gathered,
      allowDynamicReadContinuation: false,
    }),
    [],
    "without the companion list the authority stays fail-closed",
  );

  const unpaidClaims = ["verifier:claim_grounding:quote_mismatch"];
  assert.equal(
    sealedFrontierShouldKeepCitationGatherV1({
      graph: graph as never,
      unpaidAcceptanceMissing: unpaidClaims,
    }),
    true,
  );
  assert.equal(
    sealedFrontierShouldKeepCitationGatherV1({
      graph: graph as never,
      unpaidAcceptanceMissing: unpaidClaims,
      inFinalizationReserve: true,
    }),
    false,
    "in-run finalization reserve stays tool-less so maxSteps still caps searches",
  );
  assert.equal(
    sealedFrontierShouldKeepCitationGatherV1({
      graph: graph as never,
      unpaidAcceptanceMissing: unpaidClaims,
      explicitSingleWebFetchOnly: true,
    }),
    false,
    "exact cache fetch-only must not regain web_search",
  );
  assert.equal(
    sealedFrontierShouldKeepCitationGatherV1({
      graph: queued as never,
      unpaidAcceptanceMissing: unpaidClaims,
    }),
    false,
    "a queued final is not a terminal seal; do not widen the catalog",
  );

  assert.deepEqual(
    citationGatherUnpaidMissingV1({
      liveMissing: ["write_receipt"],
      lastFinalOutput: "",
      persistedMissing: ["verifier:claim_grounding:quote_mismatch"],
    }),
    ["write_receipt", "verifier:claim_grounding:quote_mismatch"],
    "Continue with an empty draft still sees the previous segment's unpaid quotes",
  );
  assert.deepEqual(
    citationGatherUnpaidMissingV1({
      liveMissing: ["write_receipt"],
      lastFinalOutput: "a live draft",
      persistedMissing: ["verifier:claim_grounding:quote_mismatch"],
      heldCandidateMissing: ["verifier:claim_grounding:ungrounded:claim:s-1"],
    }),
    ["write_receipt"],
    "a live draft's missing set is authoritative; do not keep stale quote debt",
  );
  assert.equal(
    unpaidProofRequiresCitationGatherV1(
      citationGatherUnpaidMissingV1({
        liveMissing: [],
        lastFinalOutput: "",
        heldCandidateMissing: ["claim_grounding:quote_mismatch:claim:s-1"],
      }),
    ),
    true,
    "in-run rejected drafts keep citation gather after lastFinalOutput is cleared",
  );
});

test("unpaid citation gather is required tool work, not a legitimate prose finish", () => {
  const afterPaidGraphTools = {
    route: "tool_required",
    successfulToolCount: 8,
    codeExactFrontier: false,
    pendingRequiredWriteCount: 0,
    missingRequiredWebToolCount: 0,
    requiredVaultTraversalStillMissing: false,
  };
  assert.equal(
    proseAnswerCannotFinishMissionV1(afterPaidGraphTools),
    false,
    "paid graph tools with no gather debt may finish in prose",
  );
  assert.equal(
    proseAnswerCannotFinishMissionV1({
      ...afterPaidGraphTools,
      citationGatherStillUnpaid: true,
    }),
    true,
    "BYOK after Linear still owes verify_citation; do not skip first-strike steering",
  );
  assert.equal(
    proseAnswerCannotFinishMissionV1({
      route: "tool_required",
      successfulToolCount: 0,
      codeExactFrontier: false,
      pendingRequiredWriteCount: 0,
      missingRequiredWebToolCount: 0,
      requiredVaultTraversalStillMissing: false,
    }),
    true,
    "zero successful tools on a tool_required route still cannot finish in prose",
  );
  assert.equal(
    shouldKeepLoopOpenForCitationGatherStallV1({
      citationGatherStillUnpaid: true,
      executableFrontier: true,
      stepBelowLimit: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepLoopOpenForCitationGatherStallV1({
      citationGatherStillUnpaid: true,
      executableFrontier: true,
      stepBelowLimit: false,
    }),
    false,
    "step budget remains the hard stop",
  );
  assert.equal(
    shouldKeepLoopOpenForCitationGatherStallV1({
      citationGatherStillUnpaid: false,
      executableFrontier: true,
      stepBelowLimit: true,
    }),
    false,
    "the ordinary two-strike breaker still applies when gather is not offered",
  );
});
