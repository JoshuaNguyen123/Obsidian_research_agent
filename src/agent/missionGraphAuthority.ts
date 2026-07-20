import type { MissionGraphV3, MissionNodeV3 } from "../../packages/headless-runtime/src/missionGraphV3";

/**
 * Runtime authority helpers: MissionGraph is the source of truth.
 * Optional enrichment nodes (id prefix `optional-`) never gate acceptance.
 */

export function isOptionalMissionGraphNodeId(nodeId: string): boolean {
  return nodeId.startsWith("optional-");
}

export function isOptionalMissionGraphNode(
  nodeId: string,
  node: MissionNodeV3 | undefined,
): boolean {
  if (isOptionalMissionGraphNodeId(nodeId)) {
    return true;
  }
  // Defensive: host may also mark enrichment via objective prefix.
  const objective = node?.objective ?? "";
  return /^optional\b/i.test(objective);
}

export function partitionGraphNodes(graph: MissionGraphV3): {
  required: Array<{ id: string; node: MissionNodeV3 }>;
  optional: Array<{ id: string; node: MissionNodeV3 }>;
} {
  const required: Array<{ id: string; node: MissionNodeV3 }> = [];
  const optional: Array<{ id: string; node: MissionNodeV3 }> = [];
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (isOptionalMissionGraphNode(id, node)) {
      optional.push({ id, node });
    } else {
      required.push({ id, node });
    }
  }
  return { required, optional };
}

export function collectRequiredDependencyIds(
  graph: MissionGraphV3,
  rootId: string,
): Set<string> {
  const collected = new Set<string>();
  const stack = [...(graph.nodes[rootId]?.dependencyIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (collected.has(id) || isOptionalMissionGraphNodeId(id)) {
      continue;
    }
    collected.add(id);
    const node = graph.nodes[id];
    if (!node) {
      continue;
    }
    for (const dependencyId of node.dependencyIds) {
      if (
        !collected.has(dependencyId) &&
        !isOptionalMissionGraphNodeId(dependencyId)
      ) {
        stack.push(dependencyId);
      }
    }
  }
  return collected;
}

export function findFinalMissionGraphNode(
  graph: MissionGraphV3,
): { id: string; node: MissionNodeV3 } | null {
  if (graph.nodes.final) {
    return { id: "final", node: graph.nodes.final };
  }
  const entry = Object.entries(graph.nodes).find(
    ([, candidate]) =>
      candidate.allowedTools.length === 0 &&
      candidate.completionContract.requiredEvidenceKinds.some((kind) =>
        /final-output|final-relevance/i.test(kind),
      ),
  );
  return entry ? { id: entry[0], node: entry[1] } : null;
}

/**
 * Acceptance = final + host-required transitive deps only.
 * Optional sibling reads never block write_completed / final.
 */
export function isMissionGraphAcceptablyComplete(
  graph: MissionGraphV3 | null | undefined,
): boolean {
  if (!graph) {
    return true;
  }
  const final = findFinalMissionGraphNode(graph);
  if (!final) {
    const { required } = partitionGraphNodes(graph);
    return required.every(
      ({ node }) =>
        node.status === "complete" || node.status === "cancelled",
    );
  }
  if (final.node.status !== "complete" && final.node.status !== "cancelled") {
    return false;
  }
  const requiredIds = collectRequiredDependencyIds(graph, final.id);
  requiredIds.add(final.id);
  return [...requiredIds].every((id) => {
    if (isOptionalMissionGraphNodeId(id)) {
      return true;
    }
    const node = graph.nodes[id];
    return (
      node !== undefined &&
      (node.status === "complete" || node.status === "cancelled")
    );
  });
}

export function getRuntimeFrontierToolNames(
  graph: MissionGraphV3 | null | undefined,
): string[] {
  if (!graph) {
    return [];
  }
  const names = new Set<string>();
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (isOptionalMissionGraphNode(id, node)) {
      continue;
    }
    if (node.status !== "ready") {
      continue;
    }
    for (const tool of node.allowedTools) {
      names.add(tool);
    }
  }
  return [...names];
}
