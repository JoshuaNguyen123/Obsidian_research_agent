/**
 * MissionGraph pure selectors and gates: completion checks, frontier
 * counting, and step-budget reconciliation over the authoritative graph.
 * Extracted verbatim from AgentRunner.ts (Cluster C of the monolith
 * extraction), sibling of missionGraphFrontier; bodies are byte-identical.
 */

import { type ModelToolCall, type ModelToolDefinition } from "../model/types";
import {
  getCurrentMissionCompositeLifecycleActionV1,
  getMissionCompositeLifecycleSpecV1,
  getMissionCompositeLifecycleStateV1,
  type MissionGraphV3,
} from "../../packages/headless-runtime/src/missionGraphV3";
import { type MissionAcceptanceResult } from "./missionAcceptance";
import { collectRequiredDependencyIds, isMissionGraphAcceptablyComplete as isMissionGraphAcceptablyCompleteFromAuthority } from "./missionGraphAuthority";
import { type MissionEvidence } from "./missionLedger";
import { getString, isRecord } from "./recordUtils";
import type { MissionEvidenceAttestationV1 } from "../AgentRunner";

/**
 * Terminal acceptance only requires the final node and its transitive host
 * prerequisites. Optional catalog reads that joined as siblings may remain
 * unread without forcing a budget downgrade after a successful write.
 */
export function isMissionGraphAcceptablyComplete(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  return isMissionGraphAcceptablyCompleteFromAuthority(graph);
}

export function isReceiptBackedFinalProjectionReady(input: {
  acceptance: MissionAcceptanceResult;
  graph: MissionGraphV3 | null | undefined;
  frontierToolNames: readonly string[];
  /**
   * True only for the canonical accepted-research issue + note + backlink
   * receipt. Generic actions and cross-receipt proof composition cannot invoke
   * this pre-emission projection.
   */
  hasCompletedAcceptedResearchPublicationProof: boolean;
}): boolean {
  if (
    !input.hasCompletedAcceptedResearchPublicationProof ||
    input.frontierToolNames.length > 0 ||
    !hasOnlyFinalProjectionProofDebt(input.acceptance)
  ) {
    return false;
  }
  const graph = input.graph;
  if (!graph) return false;
  const finalNode =
    graph.nodes.final ??
    Object.values(graph.nodes).find(
      (node) =>
        node.allowedTools.length === 0 &&
        node.completionContract.requiredEvidenceKinds.some((kind) =>
          /final-output|final-relevance/iu.test(kind),
        ) &&
        node.status !== "complete" &&
        node.status !== "cancelled",
    );
  if (
    !finalNode ||
    (finalNode.status !== "queued" && finalNode.status !== "ready")
  ) {
    return false;
  }
  return finalNode.dependencyIds.every(
    (dependencyId) => graph.nodes[dependencyId]?.status === "complete",
  );
}

export function hasOnlyFinalProjectionProofDebt(
  acceptance: MissionAcceptanceResult,
): boolean {
  return (
    acceptance.missing.length > 0 &&
    acceptance.missing.every(
      (item) =>
        item === "final_output" ||
        /(?:^|:)final_relevance$/u.test(item) ||
        /(?:^|:)final_output$/u.test(item),
    )
  );
}

export function collectMissionGraphTransitiveDependencyIds(
  graph: MissionGraphV3,
  rootId: string,
): Set<string> {
  // Preserve export name; skip optional-* enrichment nodes so they cannot
  // re-enter the required set via a mistaken dependency edge.
  return collectRequiredDependencyIds(graph, rootId);
}

export function toMissionEvidenceAttestation(
  evidence: MissionEvidence,
): MissionEvidenceAttestationV1 {
  const passageIds = [
    ...(evidence.passageId ? [evidence.passageId] : []),
    ...(evidence.passageIds ?? []),
  ];
  return {
    schemaVersion: 1,
    id: evidence.id,
    kind: evidence.kind,
    ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
    passageIds: [...new Set(passageIds)],
    ...(evidence.usableSource === undefined
      ? {}
      : { usableSource: evidence.usableSource }),
    ...(evidence.parserStatus
      ? { parserStatus: evidence.parserStatus }
      : {}),
    confidence: evidence.confidence,
  };
}

/**
 * Count exact ready graph slots for one tool name. Parallel preparation must
 * never reserve more calls than these slots: a model may emit duplicate safe
 * reads in one response, but the second call cannot consume a node after the
 * first call advances the authoritative frontier.
 */
export function countReadyMissionGraphToolSlots(
  graph: MissionGraphV3,
  toolName: string,
): number {
  return Object.values(graph.nodes).filter(
    (node) =>
      node.status === "ready" &&
      getMissionGraphNodeFrontierToolNames(node).includes(toolName),
  ).length;
}

export function findExactGraphBoundToolCallIndex(
  toolCalls: readonly ModelToolCall[],
  startIndex: number,
  toolName: string,
  exactPath: string,
): number {
  for (let index = startIndex; index < toolCalls.length; index += 1) {
    const candidate = toolCalls[index];
    if (
      candidate?.name === toolName &&
      getString(candidate.arguments.path) === exactPath
    ) {
      return index;
    }
  }
  return -1;
}

export function getMissionGraphFrontierDestinationSelector(
  graph: MissionGraphV3 | null | undefined,
  stepTools: readonly ModelToolDefinition[],
): string | null {
  if (!graph || stepTools.length !== 1) return null;
  const toolName = stepTools[0]?.function.name;
  const selectors = new Set(
    Object.values(graph.nodes)
      .filter(
        (node) =>
          (node.status === "ready" || node.status === "running") &&
          toolName !== undefined &&
          getMissionGraphNodeFrontierToolNames(node).includes(toolName),
      )
      .map(getMissionGraphNodeCurrentSelector)
      .filter((value): value is string => typeof value === "string"),
  );
  return selectors.size === 1 ? [...selectors][0]! : null;
}

export function getMissionGraphNodeFrontierToolNames(
  node: MissionGraphV3["nodes"][string],
): string[] {
  const action = getSafeMissionCompositeLifecycleActionV1(node);
  return action ? [action.toolName] : [...node.allowedTools];
}

export function getMissionGraphNodeCurrentSelector(
  node: MissionGraphV3["nodes"][string],
): string | null {
  const action = getSafeMissionCompositeLifecycleActionV1(node);
  if (action) return action.selector;
  return getMissionGraphNodeSelector(node);
}

export function getSafeMissionCompositeLifecycleSpecV1(
  node: MissionGraphV3["nodes"][string],
) {
  return isRecord(node.inputs) && node.inputs.lifecycle
    ? getMissionCompositeLifecycleSpecV1(node)
    : null;
}

export function getSafeMissionCompositeLifecycleStateV1(
  node: MissionGraphV3["nodes"][string],
) {
  return getSafeMissionCompositeLifecycleSpecV1(node) && isRecord(node.outputs)
    ? getMissionCompositeLifecycleStateV1(node)
    : null;
}

export function getSafeMissionCompositeLifecycleActionV1(
  node: MissionGraphV3["nodes"][string],
) {
  return getSafeMissionCompositeLifecycleSpecV1(node) && isRecord(node.outputs)
    ? getCurrentMissionCompositeLifecycleActionV1(node)
    : null;
}

/**
 * After a resume, segment-local expected-tool accounting starts empty even
 * though the durable graph already proved every tool node. The graph is the
 * declared authority: when every non-final node is terminal and only the
 * final synthesis node remains open, the loop must steer to the final
 * answer instead of reoffering tools until the no-progress circuit fires.
 */
export function missionGraphOnlyFinalSynthesisRemainsV1(
  graph: Pick<MissionGraphV3, "nodes"> | null | undefined,
): boolean {
  const nodes = graph?.nodes;
  if (!nodes) return false;
  const final = nodes.final;
  if (!final) return false;
  if (final.status !== "ready" && final.status !== "queued") return false;
  return Object.entries(nodes).every(([id, node]) =>
    id === "final"
      ? true
      : node.status === "complete" || node.status === "cancelled",
  );
}

/**
 * One conventional graph node consumes one successful tool step. Composite
 * lifecycle nodes consume one step per durable action, so count their
 * remaining actions rather than treating an entire stage as one call. The
 * caller still applies the configured hard cap and finalization reserve; this
 * helper changes capacity accounting only and never expands graph authority.
 */
export function countOutstandingMissionGraphToolActions(
  nodes: readonly MissionGraphV3["nodes"][string][],
): number {
  return nodes.reduce((total, node) => {
    const lifecycle = getSafeMissionCompositeLifecycleSpecV1(node);
    if (!lifecycle) return total + 1;
    const state = getSafeMissionCompositeLifecycleStateV1(node);
    return total + Math.max(
      0,
      lifecycle.actions.length - (state?.actionCursor ?? 0),
    );
  }, 0);
}

export function reconcileOutstandingMissionGraphToolStepBudget(input: {
  hardCap: number;
  finalizationReserve: number;
  toolStepBudget: number;
  nodes: readonly MissionGraphV3["nodes"][string][];
}): number {
  const outstandingActions = countOutstandingMissionGraphToolActions(
    input.nodes,
  );
  // Exact graphs still consume a model step when the model proposes a stale
  // alias, requests a read before the ready mutation, or needs one bounded
  // routing correction. Reserving only one step per successful action forces
  // otherwise healthy multi-file repair graphs across a continuation boundary
  // and discards intentionally run-local validation context. Keep the margin
  // proportional and tightly capped; it changes step capacity only, never the
  // graph frontier, mutation authority, or per-node retry ceiling.
  const routingRecoverySlack = Math.min(
    16,
    Math.ceil(outstandingActions / 2),
  );
  return Math.min(
    Math.max(0, input.hardCap - input.finalizationReserve),
    Math.max(
      input.toolStepBudget,
      outstandingActions + routingRecoverySlack,
    ),
  );
}

/**
 * Composite nodes aggregate proof kinds for final stage completion, but one
 * tool result advances exactly one durable lifecycle action. Map that result
 * to the current action's proof contract so an earlier/later action's sorted
 * receipt kind cannot be attached to the wrong operation.
 */
export function resolveMissionGraphExecutionProofContractV1(
  node: MissionGraphV3["nodes"][string] | null | undefined,
): {
  requiredEvidenceKinds: string[];
  requiredReceiptKinds: string[];
} {
  if (!node) {
    return { requiredEvidenceKinds: [], requiredReceiptKinds: [] };
  }
  const action = getSafeMissionCompositeLifecycleActionV1(node);
  return {
    requiredEvidenceKinds: [
      ...(action?.requiredEvidenceKinds ??
        node.completionContract.requiredEvidenceKinds),
    ],
    requiredReceiptKinds: [
      ...(action?.requiredReceiptKinds ??
        node.completionContract.requiredReceiptKinds),
    ],
  };
}

export function findReadyMissionGraphToolNodes(
  graph: MissionGraphV3,
  toolName: string,
  selector: string,
): Array<MissionGraphV3["nodes"][string]> {
  return Object.values(graph.nodes).filter(
    (node) =>
      node.status === "ready" &&
      getMissionGraphNodeFrontierToolNames(node).length === 1 &&
      getMissionGraphNodeFrontierToolNames(node)[0] === toolName &&
      getMissionGraphNodeCurrentSelector(node) === selector,
  );
}

export function getMissionGraphNodeSelector(
  node: MissionGraphV3["nodes"][string],
): string | null {
  if (node.destination?.selector) return node.destination.selector;
  const resource = isRecord(node.inputs) ? node.inputs.resource : undefined;
  return isRecord(resource) &&
    resource.kind === "binding" &&
    typeof resource.selector === "string"
    ? resource.selector
    : null;
}
