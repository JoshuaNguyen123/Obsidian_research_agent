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
import { collectRequiredDependencyIds, isMissionGraphAcceptablyComplete as isMissionGraphAcceptablyCompleteFromAuthority, missionGraphNodeIsTerminalV1 } from "./missionGraphAuthority";
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
  return Object.values(graph.nodes).filter((node) =>
    isReadyMissionGraphSlotForToolV1(node, toolName),
  ).length;
}

/**
 * One node-level answer to "may this tool run right now?".
 *
 * MissionGraphSession admits a call only from a `ready` node whose current
 * frontier expects the tool. Anything that decides what to offer, what to
 * schedule, or what to tell the model to call instead has to ask the same
 * question, or the run offers a tool authority will refuse and the model
 * cannot tell the difference between "wrong tool" and "wrong moment".
 */
export function isReadyMissionGraphSlotForToolV1(
  node: MissionGraphV3["nodes"][string],
  toolName: string,
): boolean {
  return (
    node.status === "ready" &&
    getMissionGraphNodeFrontierToolNames(node).includes(toolName)
  );
}

/**
 * Exact ready-frontier tool names. This is the corrective payload an authority
 * rejection owes the model: naming what was refused teaches it nothing, and a
 * model told only that it was wrong will rationally try again.
 */
export function readyMissionGraphFrontierToolNamesV1(
  graph: MissionGraphV3 | null | undefined,
): string[] {
  if (!graph) return [];
  return [
    ...new Set(
      Object.values(graph.nodes)
        .filter((node) => node.status === "ready")
        .flatMap(getMissionGraphNodeFrontierToolNames)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * THE one answer to "may this run materialize a bounded dynamic read node for a
 * read-effect capability grant that has no ready node?".
 *
 * Both sides of that question must read this and nothing else:
 *   OFFER     `constrainToolsToMissionGraphFrontier`'s `includeCapabilityReads`
 *             (which unions every read-effect grant in
 *             `graph.capabilityEnvelope.tools` into the offered menu) and its
 *             `allowDynamicReadContinuation`.
 *   AUTHORITY `MissionGraphSession.beginToolExecution`'s
 *             `allowDynamicReadContinuation`, via AgentRunner's
 *             `beginMissionGraphTool`.
 *
 * They used to compute it separately and differed by exactly one disjunct
 * (`setLooseCompoundEnabled ||`, present only on the offer side), so a set-loose
 * run over an exact planned frontier advertised capability reads and then
 * refused every one of them. That is the OFFER-side half of instance #17; the
 * refusal-side half is `authoritativeRefusalFrontierToolNamesV1` below.
 *
 * Why the AUTHORITY was the side out of step, not the offer:
 *
 *   `setLooseCompoundEnabled` entered the menu builder in 3fbe93e, in the same
 *   edit that stopped handing the exact `stepGraph` to
 *   `bindExactWorkspaceDestinationToolSchemas` under set-loose
 *   (`missionGraphUsesExactPlannedFrontier && !setLooseCompoundEnabled`). Both
 *   halves of that edit say one thing: a set-loose compound run deliberately
 *   opts out of exact-planned-frontier narrowing and expands to the stage
 *   Soft-union. The host even names the decision — the whole purpose of
 *   `mayBypassMissionGraphStartForSetLooseSoftCompanion` is to let an unplanned
 *   Soft companion run on such a turn — but that verdict never reached the gate
 *   that refuses: the bypass calls `beginToolExecution` with
 *   `optionalDynamicContinuation` only, so `allowDynamicReadContinuation ===
 *   false` refused the very call the bypass had just authorized. The offer was
 *   intentional. The authority simply never learned that set-loose exists.
 *
 * Fail closed, by construction — this can never make an unplanned MUTATION
 * ready:
 *   - It unlocks exactly one branch of `beginToolExecution`: the one reached
 *     only after `grant.effect === "read"`. A grant with any other effect is
 *     judged by a different branch (completed template + continuation reserve
 *     node) that never reads this flag.
 *   - A tool absent from `graph.capabilityEnvelope.tools` is refused before
 *     this flag is consulted, so "set loose" widens nothing beyond the envelope
 *     the mission's own plan authored.
 *   - The node it permits is bounded: one tool call, zero external actions,
 *     envelope-derived wall clock, envelope retry ceiling.
 */
export function missionGraphRunAdmitsDynamicReadContinuationV1(input: {
  /** AgentRunner's `missionGraphUsesExactPlannedFrontier`. */
  usesExactPlannedFrontier: boolean;
  /** AgentRunner's `setLooseCompoundEnabled`. */
  setLooseCompoundEnabled: boolean;
}): boolean {
  // A non-exact plan has always materialized bounded dynamic reads.
  if (input.usesExactPlannedFrontier !== true) return true;
  // An exact planned frontier admits them only on the set-loose compound runs
  // whose menu builder has offered them since 3fbe93e.
  return input.setLooseCompoundEnabled === true;
}

/**
 * THE one answer to "which tool names may a host MESSAGE name, given that the
 * mission-graph authority will judge whatever the model calls next?".
 *
 * Every message that tells a model what to call — an off-frontier refusal, an
 * authority rejection, a repeated-invalid-call corrective, the routing card's
 * `preferredNext` — must build its list from here and from nothing else.
 *
 * Why this exists (instance #17 of "two subsystems disagree", live compound
 * run on main @3860ee6):
 *
 *   step 21  the step-menu gate refused `append_file` and advertised
 *            "Ready frontier tool(s) now: read_current_file,
 *             list_markdown_files, read_file, read_template, web_search,
 *             web_fetch. Preferred next: read_current_file. Call that exact
 *             name."
 *   step 22  the model called `read_current_file` — the exact name it was
 *            ordered to call — and the mission-graph authority refused it with
 *            `mission_graph_authority_blocked` and
 *            "Ready frontier tool(s) now: none."
 *
 * The refusal had printed `stepAllowedToolNames`, which is the OFFERED menu:
 * `constrainToolsToMissionGraphFrontier` unions every read-effect grant in
 * `graph.capabilityEnvelope.tools` into it whenever `includeCapabilityReads`
 * is set (AgentRunner passes `setLooseCompoundEnabled || dynamicRead...`),
 * while the authority that admits the call passes only
 * `allowDynamicReadContinuation: dynamicReadContinuationAllowed()`. On a
 * set-loose run over an exact planned frontier those two disagree by exactly
 * the capability-read set, so the host advertised a six-item menu on which
 * nothing was callable and then blamed the model for calling from it.
 *
 * Fail closed: when the graph admits nothing, this returns `[]` and the
 * message seats must say so rather than name a tool. Under-reporting a name
 * the authority would in fact have admitted is safe — the model is told less;
 * over-reporting is the defect, because everything the model is told must be
 * true.
 *
 * `candidateToolNames` (optional) is the seat's own menu. When supplied the
 * result is the intersection in MENU order, so a seat never names a tool the
 * model has no schema for; when omitted the result is the bare authority list.
 */
export function authoritativeRefusalFrontierToolNamesV1(input: {
  graph: MissionGraphV3 | null | undefined;
  candidateToolNames?: readonly string[] | null;
  excludeToolNames?: readonly string[] | null;
  /**
   * Exactly AgentRunner's `dynamicReadContinuationAllowed()`, i.e. the
   * `allowDynamicReadContinuation` the runner hands `beginToolExecution`.
   * When it is true the authority materializes a bounded dynamic read node
   * for any read-effect grant, so those names really are callable and omitting
   * them would starve the message. When it is false — an exact planned
   * frontier — `beginToolExecution` refuses them with "not ready in the exact
   * authoritative mission graph", which is precisely the step-22 refusal
   * above. Default false: a seat that does not know fails closed.
   */
  allowDynamicReadContinuation?: boolean;
}): string[] {
  const clean = (names: readonly string[] | null | undefined): string[] => [
    ...new Set((names ?? []).map((name) => name.trim()).filter(Boolean)),
  ];
  const excluded = new Set(clean(input.excludeToolNames));
  const candidates =
    input.candidateToolNames == null ? null : clean(input.candidateToolNames);
  const graph = input.graph;
  if (!graph) {
    // No graph means no MissionGraphSession, so `beginMissionGraphTool` returns
    // null and refuses nothing. There is no second authority to contradict, and
    // the seat's own menu IS the truth.
    return (candidates ?? []).filter((name) => !excluded.has(name));
  }
  const admitsDynamicRead = (name: string): boolean =>
    input.allowDynamicReadContinuation === true &&
    graph.capabilityEnvelope.tools[name]?.effect === "read";
  const readySet = new Set(readyMissionGraphFrontierToolNamesV1(graph));
  const admits = (name: string): boolean =>
    !excluded.has(name) && (readySet.has(name) || admitsDynamicRead(name));
  if (candidates === null) {
    return [
      ...new Set([
        ...readySet,
        ...(input.allowDynamicReadContinuation === true
          ? Object.entries(graph.capabilityEnvelope.tools)
              .filter(([, grant]) => grant.effect === "read")
              .map(([name]) => name)
          : []),
      ]),
    ].filter((name) => !excluded.has(name));
  }
  return candidates.filter(admits);
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
    id === "final" ? true : missionGraphNodeIsTerminalV1(node),
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
