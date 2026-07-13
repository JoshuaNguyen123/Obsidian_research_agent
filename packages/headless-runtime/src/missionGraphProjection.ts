import type {
  MissionGraphV3,
  MissionNodeStatusV3,
  MissionNodeV3,
} from "./missionGraphV3";

export interface MissionGraphNodeProjectionV1 {
  id: string;
  objective: string;
  executorId: string;
  executionHost: MissionNodeV3["executionHost"];
  status: MissionNodeStatusV3;
  attempts: number;
  maxAttempts: number;
  evidenceIds: string[];
  receiptIds: string[];
  blocker: MissionNodeV3["blocker"];
}

export interface MissionGraphRunDetailsProjectionV1 {
  missionId: string;
  objective: string;
  revision: number;
  routingSource: MissionGraphV3["routing"]["source"];
  routingFallbackReason: string | null;
  activeNode: MissionGraphNodeProjectionV1 | null;
  readyNodeIds: string[];
  completedNodeCount: number;
  totalNodeCount: number;
  nextAction: string;
}

const ACTIVE_STATUS_PRIORITY: MissionNodeStatusV3[] = [
  "running",
  "waiting_approval",
  "waiting_obsidian",
  "verifying",
  "ready",
  "blocked",
  "queued",
];

export function projectMissionGraphRunDetails(
  graph: MissionGraphV3,
): MissionGraphRunDetailsProjectionV1 {
  const nodes = topologicallyOrderNodes(graph);
  const active = selectActiveNode(nodes);
  return {
    missionId: graph.missionId,
    objective: graph.objective,
    revision: graph.revision,
    routingSource: graph.routing.source,
    routingFallbackReason: graph.routing.fallbackReason,
    activeNode: active ? projectNode(active) : null,
    readyNodeIds: nodes
      .filter((node) => node.status === "ready")
      .map((node) => node.id),
    completedNodeCount: nodes.filter((node) => node.status === "complete").length,
    totalNodeCount: nodes.length,
    nextAction: describeNextAction(active),
  };
}

export function topologicallyOrderNodes(graph: MissionGraphV3): MissionNodeV3[] {
  const nodes = Object.values(graph.nodes);
  const inDegree = new Map(nodes.map((node) => [node.id, node.dependencyIds.length]));
  const dependants = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependencyId of node.dependencyIds) {
      const current = dependants.get(dependencyId) ?? [];
      current.push(node.id);
      dependants.set(dependencyId, current);
    }
  }
  const ready = nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort();
  const ordered: MissionNodeV3[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = graph.nodes[id];
    if (!node) {
      continue;
    }
    ordered.push(node);
    for (const dependantId of (dependants.get(id) ?? []).sort()) {
      const next = (inDegree.get(dependantId) ?? 0) - 1;
      inDegree.set(dependantId, next);
      if (next === 0) {
        ready.push(dependantId);
        ready.sort();
      }
    }
  }
  return ordered.length === nodes.length
    ? ordered
    : [...nodes].sort((left, right) => left.id.localeCompare(right.id));
}

function selectActiveNode(nodes: MissionNodeV3[]): MissionNodeV3 | null {
  for (const status of ACTIVE_STATUS_PRIORITY) {
    const node = nodes.find((candidate) => candidate.status === status);
    if (node) {
      return node;
    }
  }
  return null;
}

function projectNode(node: MissionNodeV3): MissionGraphNodeProjectionV1 {
  return {
    id: node.id,
    objective: node.objective,
    executorId: node.executorId,
    executionHost: node.executionHost,
    status: node.status,
    attempts: node.retries.attempts,
    maxAttempts: node.retries.maxAttempts,
    evidenceIds: node.evidence.map((item) => item.id),
    receiptIds: node.receipts.map((item) => item.id),
    blocker: node.blocker ? { ...node.blocker } : null,
  };
}

function describeNextAction(node: MissionNodeV3 | null): string {
  if (!node) {
    return "Mission graph is terminal.";
  }
  if (node.blocker?.requiredAction) {
    return node.blocker.requiredAction;
  }
  switch (node.status) {
    case "ready":
      return `Execute ${node.objective}`;
    case "running":
      return `Continue ${node.objective}`;
    case "waiting_approval":
      return `Await approval for ${node.objective}`;
    case "waiting_obsidian":
      return `Reconnect Obsidian for ${node.objective}`;
    case "verifying":
      return `Verify ${node.objective}`;
    case "blocked":
      return node.blocker?.message ?? `Resolve blocker for ${node.objective}`;
    case "queued":
      return `Wait for dependencies before ${node.objective}`;
    case "complete":
    case "cancelled":
      return "Mission graph is terminal.";
  }
}
