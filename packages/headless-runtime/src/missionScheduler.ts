export const MAX_PARALLEL_MISSION_READ_NODES = 3 as const;

export type SchedulableMissionEffect =
  | "read"
  | "reversible_mutation"
  | "destructive_mutation"
  | "execution"
  | "publish";

export interface SchedulableMissionDescriptor {
  effect: SchedulableMissionEffect;
  execution: {
    parallelSafe: boolean;
  };
}

export interface SchedulableMissionNode {
  id: string;
  status: "ready" | "queued" | "running" | "blocked" | "complete";
  descriptor: SchedulableMissionDescriptor;
  resourceKeys: string[];
}

export interface MissionNodeBatch {
  nodeIds: string[];
  mode: "parallel_read" | "serial" | "none";
  requiresExclusiveResourceLock: boolean;
}

export function selectMissionNodeBatch(input: {
  nodes: SchedulableMissionNode[];
  lockedResourceKeys?: ReadonlySet<string>;
}): MissionNodeBatch {
  const locked = input.lockedResourceKeys ?? new Set<string>();
  const ready = input.nodes.filter(
    (node) => node.status === "ready" && !hasLockedResource(node, locked),
  );
  const first = ready[0];
  if (!first) {
    return {
      nodeIds: [],
      mode: "none",
      requiresExclusiveResourceLock: false,
    };
  }

  if (!isDescriptorApprovedParallelRead(first.descriptor)) {
    return {
      nodeIds: [first.id],
      mode: "serial",
      requiresExclusiveResourceLock: first.descriptor.effect !== "read",
    };
  }

  const nodeIds: string[] = [];
  for (const node of ready) {
    if (!isDescriptorApprovedParallelRead(node.descriptor)) {
      break;
    }
    nodeIds.push(node.id);
    if (nodeIds.length === MAX_PARALLEL_MISSION_READ_NODES) {
      break;
    }
  }
  return {
    nodeIds,
    mode: nodeIds.length > 1 ? "parallel_read" : "serial",
    requiresExclusiveResourceLock: false,
  };
}

export function isDescriptorApprovedParallelRead(
  descriptor: SchedulableMissionDescriptor | null | undefined,
): boolean {
  return Boolean(
    descriptor?.effect === "read" && descriptor.execution.parallelSafe === true,
  );
}

export function missionNodeRequiresExclusiveResourceLock(
  descriptor: SchedulableMissionDescriptor,
): boolean {
  return descriptor.effect !== "read";
}

function hasLockedResource(
  node: SchedulableMissionNode,
  locked: ReadonlySet<string>,
): boolean {
  return node.resourceKeys.some((resourceKey) => locked.has(resourceKey));
}
