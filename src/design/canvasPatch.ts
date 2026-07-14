import {
  assertValidJsonCanvas,
  validateJsonCanvas,
  type JsonCanvas,
  type JsonCanvasEdge,
  type JsonCanvasNode,
} from "./jsonCanvas";

export type CanvasPatchOperation =
  | CanvasAddNodeOperation
  | CanvasUpdateNodeOperation
  | CanvasRemoveNodeOperation
  | CanvasAddEdgeOperation
  | CanvasUpdateEdgeOperation
  | CanvasRemoveEdgeOperation
  | CanvasAutoLayoutOperation;

export interface CanvasAddNodeOperation {
  op: "add_node";
  node: JsonCanvasNode;
}

export interface CanvasUpdateNodeOperation {
  op: "update_node";
  id: string;
  changes: Partial<JsonCanvasNode> & { id?: never };
}

export interface CanvasRemoveNodeOperation {
  op: "remove_node";
  id: string;
}

export interface CanvasAddEdgeOperation {
  op: "add_edge";
  edge: JsonCanvasEdge;
}

export interface CanvasUpdateEdgeOperation {
  op: "update_edge";
  id: string;
  changes: Partial<Omit<JsonCanvasEdge, "id">> & { id?: never };
}

export interface CanvasRemoveEdgeOperation {
  op: "remove_edge";
  id: string;
}

export type CanvasAutoLayoutDirection = "row" | "column" | "grid";

export interface CanvasAutoLayoutOperation {
  op: "auto_layout";
  /** Nodes are always laid out in their existing Canvas order. */
  nodeIds?: readonly string[];
  direction?: CanvasAutoLayoutDirection;
  columns?: number;
  originX?: number;
  originY?: number;
  gapX?: number;
  gapY?: number;
}

export interface CanvasNodePosition {
  id: string;
  x: number;
  y: number;
}

export type CanvasAutoLayoutHook = (
  canvas: Readonly<JsonCanvas>,
  operation: Readonly<CanvasAutoLayoutOperation>,
) => readonly CanvasNodePosition[];

export interface ApplyCanvasPatchOptions {
  autoLayout?: CanvasAutoLayoutHook;
}

export interface CanvasPatchPreservationMetadata {
  inputNodeCount: number;
  outputNodeCount: number;
  inputEdgeCount: number;
  outputEdgeCount: number;
  preservedNodeIds: string[];
  preservedEdgeIds: string[];
  untouchedNodeIds: string[];
  untouchedEdgeIds: string[];
  addedNodeIds: string[];
  updatedNodeIds: string[];
  removedNodeIds: string[];
  addedEdgeIds: string[];
  updatedEdgeIds: string[];
  removedEdgeIds: string[];
  autoLaidOutNodeIds: string[];
  preservedTopLevelKeys: string[];
}

export interface CanvasPatchResult {
  canvas: JsonCanvas;
  preservation: CanvasPatchPreservationMetadata;
}

const DEFAULT_GAP_X = 80;
const DEFAULT_GAP_Y = 80;
const MAX_CANVAS_PATCH_OPERATIONS = 100;
const NODE_TYPES = new Set(["text", "file", "link", "group"]);
const EDGE_SIDES = new Set(["top", "right", "bottom", "left"]);
const EDGE_ENDS = new Set(["none", "arrow"]);
const GROUP_BACKGROUND_STYLES = new Set(["cover", "ratio", "repeat"]);

/**
 * Converts an untrusted tool argument into the bounded patch contract. The
 * parser rejects prototype-bearing/non-JSON values and extra operation keys so
 * callers cannot smuggle behavior or authority beside a recognized operation.
 */
export function parseCanvasPatchOperations(value: unknown): CanvasPatchOperation[] {
  if (!Array.isArray(value)) {
    throw new Error("Canvas patch operations must be an array.");
  }
  if (value.length < 1 || value.length > MAX_CANVAS_PATCH_OPERATIONS) {
    throw new Error(
      `Canvas patch operations must contain between 1 and ${MAX_CANVAS_PATCH_OPERATIONS} items.`,
    );
  }

  const safeOperations = cloneJsonSafeValue(
    value,
    "Canvas patch operations",
    new Set<object>(),
  );
  if (!Array.isArray(safeOperations)) {
    throw new Error("Canvas patch operations must be an array.");
  }

  return safeOperations.map((candidate, index) => {
    const label = `Canvas patch operations[${index}]`;
    const operation = parseJsonSafePlainObject(candidate, label);
    const op = getRequiredPlainString(operation, "op", label);
    switch (op) {
      case "add_node":
        assertExactObjectKeys(operation, ["op", "node"], ["op", "node"], label);
        return {
          op,
          node: parseCanvasNode(operation.node, `${label}.node`),
        };

      case "update_node":
        assertExactObjectKeys(
          operation,
          ["op", "id", "changes"],
          ["op", "id", "changes"],
          label,
        );
        return {
          op,
          id: getRequiredStableId(operation, "id", label),
          changes: parseNodeChanges(operation.changes, `${label}.changes`),
        };

      case "remove_node":
        assertExactObjectKeys(operation, ["op", "id"], ["op", "id"], label);
        return { op, id: getRequiredStableId(operation, "id", label) };

      case "add_edge":
        assertExactObjectKeys(operation, ["op", "edge"], ["op", "edge"], label);
        return {
          op,
          edge: parseCanvasEdge(operation.edge, `${label}.edge`),
        };

      case "update_edge":
        assertExactObjectKeys(
          operation,
          ["op", "id", "changes"],
          ["op", "id", "changes"],
          label,
        );
        return {
          op,
          id: getRequiredStableId(operation, "id", label),
          changes: parseEdgeChanges(operation.changes, `${label}.changes`),
        };

      case "remove_edge":
        assertExactObjectKeys(operation, ["op", "id"], ["op", "id"], label);
        return { op, id: getRequiredStableId(operation, "id", label) };

      case "auto_layout":
        assertExactObjectKeys(
          operation,
          [
            "op",
            "nodeIds",
            "direction",
            "columns",
            "originX",
            "originY",
            "gapX",
            "gapY",
          ],
          ["op"],
          label,
        );
        return parseAutoLayoutOperation(operation, label);

      default:
        throw new Error(`${label}.op is unsupported: ${op}.`);
    }
  });
}

/**
 * Applies stable-id Canvas operations without mutating the input. Untouched
 * objects retain their order and reference, while updated objects are shallow
 * merged so unrecognized JSON Canvas fields survive the patch.
 */
export function applyCanvasPatch(
  canvas: JsonCanvas,
  operations: readonly CanvasPatchOperation[],
  options: ApplyCanvasPatchOptions = {},
): CanvasPatchResult {
  assertValidJsonCanvas(canvas);

  const originalNodeIds = canvas.nodes.map((node) => node.id);
  const originalEdgeIds = canvas.edges.map((edge) => edge.id);
  const scheduledEdgeRemovals = new Set(
    operations
      .filter((operation): operation is CanvasRemoveEdgeOperation =>
        operation.op === "remove_edge"
      )
      .map((operation) => operation.id),
  );
  const working: JsonCanvas = {
    ...canvas,
    nodes: [...canvas.nodes],
    edges: [...canvas.edges],
  };

  const addedNodeIds = new Set<string>();
  const updatedNodeIds = new Set<string>();
  const removedNodeIds = new Set<string>();
  const addedEdgeIds = new Set<string>();
  const updatedEdgeIds = new Set<string>();
  const removedEdgeIds = new Set<string>();
  const autoLaidOutNodeIds = new Set<string>();

  operations.forEach((operation, operationIndex) => {
    const label = `Canvas patch operation ${operationIndex + 1} (${operation.op})`;
    switch (operation.op) {
      case "add_node": {
        const id = requireStableId(operation.node.id, `${label}.node.id`);
        assertIdAvailable(working, id, label);
        working.nodes.push(operation.node);
        addedNodeIds.add(id);
        break;
      }

      case "update_node": {
        const id = requireStableId(operation.id, `${label}.id`);
        assertStableIdNotPatched(operation.changes, label);
        const index = findNodeIndex(working, id, label);
        working.nodes[index] = {
          ...working.nodes[index],
          ...operation.changes,
          id,
        } as JsonCanvasNode;
        updatedNodeIds.add(id);
        break;
      }

      case "remove_node": {
        const id = requireStableId(operation.id, `${label}.id`);
        const index = findNodeIndex(working, id, label);
        const incidentEdgeIds = working.edges
          .filter((edge) => edge.fromNode === id || edge.toNode === id)
          .map((edge) => edge.id);
        const survivingIncidentEdges = incidentEdgeIds.filter(
          (edgeId) => !scheduledEdgeRemovals.has(edgeId),
        );
        if (survivingIncidentEdges.length > 0) {
          throw new Error(
            `${label} cannot remove node ${id}; incident edges must be removed in the same patch: ${survivingIncidentEdges.join(", ")}.`,
          );
        }
        working.nodes.splice(index, 1);
        removedNodeIds.add(id);
        break;
      }

      case "add_edge": {
        const id = requireStableId(operation.edge.id, `${label}.edge.id`);
        assertIdAvailable(working, id, label);
        assertEdgeEndpointsExist(working, operation.edge, label);
        working.edges.push(operation.edge);
        addedEdgeIds.add(id);
        break;
      }

      case "update_edge": {
        const id = requireStableId(operation.id, `${label}.id`);
        assertStableIdNotPatched(operation.changes, label);
        const index = findEdgeIndex(working, id, label);
        const updated = {
          ...working.edges[index],
          ...operation.changes,
          id,
        } as JsonCanvasEdge;
        assertEdgeEndpointsExist(working, updated, label);
        working.edges[index] = updated;
        updatedEdgeIds.add(id);
        break;
      }

      case "remove_edge": {
        const id = requireStableId(operation.id, `${label}.id`);
        const index = findEdgeIndex(working, id, label);
        working.edges.splice(index, 1);
        removedEdgeIds.add(id);
        break;
      }

      case "auto_layout": {
        const selectedIds = resolveAutoLayoutNodeIds(working, operation, label);
        const positions = (options.autoLayout ?? deterministicCanvasAutoLayout)(
          working,
          operation,
        );
        const positionById = validateAutoLayoutPositions(
          positions,
          selectedIds,
          label,
        );
        working.nodes = working.nodes.map((node) => {
          const position = positionById.get(node.id);
          if (!position) return node;
          updatedNodeIds.add(node.id);
          autoLaidOutNodeIds.add(node.id);
          return { ...node, x: position.x, y: position.y };
        });
        break;
      }

      default:
        assertNever(operation);
    }
  });

  const validation = validateJsonCanvas(working);
  if (!validation.ok) {
    throw new Error(
      `Canvas patch produced an invalid Canvas: ${validation.errors.join(" ")}`,
    );
  }

  const finalNodeIdSet = new Set(working.nodes.map((node) => node.id));
  const finalEdgeIdSet = new Set(working.edges.map((edge) => edge.id));
  const mutatedNodeIds = new Set([
    ...addedNodeIds,
    ...updatedNodeIds,
    ...removedNodeIds,
  ]);
  const mutatedEdgeIds = new Set([
    ...addedEdgeIds,
    ...updatedEdgeIds,
    ...removedEdgeIds,
  ]);

  return {
    canvas: working,
    preservation: {
      inputNodeCount: canvas.nodes.length,
      outputNodeCount: working.nodes.length,
      inputEdgeCount: canvas.edges.length,
      outputEdgeCount: working.edges.length,
      preservedNodeIds: originalNodeIds.filter(
        (id) => finalNodeIdSet.has(id) && !removedNodeIds.has(id),
      ),
      preservedEdgeIds: originalEdgeIds.filter(
        (id) => finalEdgeIdSet.has(id) && !removedEdgeIds.has(id),
      ),
      untouchedNodeIds: originalNodeIds.filter(
        (id) => finalNodeIdSet.has(id) && !mutatedNodeIds.has(id),
      ),
      untouchedEdgeIds: originalEdgeIds.filter(
        (id) => finalEdgeIdSet.has(id) && !mutatedEdgeIds.has(id),
      ),
      addedNodeIds: orderedIds(working.nodes, addedNodeIds),
      updatedNodeIds: orderedIds(working.nodes, updatedNodeIds),
      removedNodeIds: originalNodeIds.filter((id) => removedNodeIds.has(id)),
      addedEdgeIds: orderedIds(working.edges, addedEdgeIds),
      updatedEdgeIds: orderedIds(working.edges, updatedEdgeIds),
      removedEdgeIds: originalEdgeIds.filter((id) => removedEdgeIds.has(id)),
      autoLaidOutNodeIds: orderedIds(working.nodes, autoLaidOutNodeIds),
      preservedTopLevelKeys: Object.keys(canvas).filter(
        (key) => key !== "nodes" && key !== "edges",
      ),
    },
  };
}

/** A predictable grid/row/column hook that preserves node sizes and order. */
export const deterministicCanvasAutoLayout: CanvasAutoLayoutHook = (
  canvas,
  operation,
) => {
  const label = "Canvas auto-layout";
  const selectedIds = resolveAutoLayoutNodeIds(canvas, operation, label);
  const selectedIdSet = new Set(selectedIds);
  const selectedNodes = canvas.nodes.filter((node) => selectedIdSet.has(node.id));
  if (selectedNodes.length === 0) return [];

  const direction = operation.direction ?? "grid";
  const gapX = getNonNegativeInteger(operation.gapX, DEFAULT_GAP_X, "gapX");
  const gapY = getNonNegativeInteger(operation.gapY, DEFAULT_GAP_Y, "gapY");
  const originX = getInteger(
    operation.originX,
    Math.min(...selectedNodes.map((node) => node.x)),
    "originX",
  );
  const originY = getInteger(
    operation.originY,
    Math.min(...selectedNodes.map((node) => node.y)),
    "originY",
  );
  const maxWidth = Math.max(...selectedNodes.map((node) => node.width));
  const maxHeight = Math.max(...selectedNodes.map((node) => node.height));
  const columns = getAutoLayoutColumns(
    selectedNodes.length,
    direction,
    operation.columns,
  );

  return selectedNodes.map((node, index) => ({
    id: node.id,
    x: originX + (index % columns) * (maxWidth + gapX),
    y: originY + Math.floor(index / columns) * (maxHeight + gapY),
  }));
};

function assertIdAvailable(canvas: JsonCanvas, id: string, label: string): void {
  if (
    canvas.nodes.some((node) => node.id === id) ||
    canvas.edges.some((edge) => edge.id === id)
  ) {
    throw new Error(`${label} cannot add duplicate Canvas id: ${id}.`);
  }
}

function findNodeIndex(canvas: JsonCanvas, id: string, label: string): number {
  const index = canvas.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new Error(`${label} references missing node id: ${id}.`);
  return index;
}

function findEdgeIndex(canvas: JsonCanvas, id: string, label: string): number {
  const index = canvas.edges.findIndex((edge) => edge.id === id);
  if (index < 0) throw new Error(`${label} references missing edge id: ${id}.`);
  return index;
}

function assertEdgeEndpointsExist(
  canvas: JsonCanvas,
  edge: JsonCanvasEdge,
  label: string,
): void {
  const nodeIds = new Set(canvas.nodes.map((node) => node.id));
  if (!nodeIds.has(edge.fromNode)) {
    throw new Error(`${label} references missing fromNode id: ${edge.fromNode}.`);
  }
  if (!nodeIds.has(edge.toNode)) {
    throw new Error(`${label} references missing toNode id: ${edge.toNode}.`);
  }
}

function assertStableIdNotPatched(changes: object, label: string): void {
  if (Object.prototype.hasOwnProperty.call(changes, "id")) {
    throw new Error(`${label} cannot change a stable Canvas id.`);
  }
}

function requireStableId(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty stable Canvas id.`);
  }
  return value;
}

function resolveAutoLayoutNodeIds(
  canvas: Readonly<JsonCanvas>,
  operation: Readonly<CanvasAutoLayoutOperation>,
  label: string,
): string[] {
  if (operation.nodeIds === undefined) {
    return canvas.nodes.map((node) => node.id);
  }

  const requestedIds = operation.nodeIds.map((id, index) =>
    requireStableId(id, `${label}.nodeIds[${index}]`)
  );
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new Error(`${label}.nodeIds must not contain duplicate ids.`);
  }
  const requestedIdSet = new Set(requestedIds);
  const missingIds = requestedIds.filter(
    (id) => !canvas.nodes.some((node) => node.id === id),
  );
  if (missingIds.length > 0) {
    throw new Error(`${label} references missing node ids: ${missingIds.join(", ")}.`);
  }

  return canvas.nodes
    .filter((node) => requestedIdSet.has(node.id))
    .map((node) => node.id);
}

function validateAutoLayoutPositions(
  positions: readonly CanvasNodePosition[],
  selectedIds: readonly string[],
  label: string,
): Map<string, CanvasNodePosition> {
  const selectedIdSet = new Set(selectedIds);
  const positionById = new Map<string, CanvasNodePosition>();
  positions.forEach((position, index) => {
    const id = requireStableId(position.id, `${label} result[${index}].id`);
    if (!selectedIdSet.has(id)) {
      throw new Error(`${label} returned an unrequested node id: ${id}.`);
    }
    if (positionById.has(id)) {
      throw new Error(`${label} returned duplicate position for node id: ${id}.`);
    }
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
      throw new Error(`${label} positions must use integer x and y values.`);
    }
    positionById.set(id, position);
  });

  const missingIds = selectedIds.filter((id) => !positionById.has(id));
  if (missingIds.length > 0) {
    throw new Error(`${label} did not return positions for: ${missingIds.join(", ")}.`);
  }
  return positionById;
}

function getAutoLayoutColumns(
  count: number,
  direction: CanvasAutoLayoutDirection,
  requestedColumns: number | undefined,
): number {
  if (requestedColumns !== undefined) {
    if (!Number.isInteger(requestedColumns) || requestedColumns <= 0) {
      throw new Error("Canvas auto-layout columns must be a positive integer.");
    }
    return Math.min(count, requestedColumns);
  }
  if (direction === "column") return 1;
  if (direction === "row") return count;
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function getInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate)) {
    throw new Error(`Canvas auto-layout ${label} must be an integer.`);
  }
  return candidate;
}

function getNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const candidate = getInteger(value, fallback, label);
  if (candidate < 0) {
    throw new Error(`Canvas auto-layout ${label} must not be negative.`);
  }
  return candidate;
}

function orderedIds<T extends { id: string }>(
  items: readonly T[],
  ids: ReadonlySet<string>,
): string[] {
  return items.filter((item) => ids.has(item.id)).map((item) => item.id);
}

function parseCanvasNode(value: unknown, label: string): JsonCanvasNode {
  const node = parseJsonSafePlainObject(value, label);
  const validation = validateJsonCanvas({ nodes: [node], edges: [] });
  if (!validation.ok) {
    throw new Error(`${label} is invalid: ${validation.errors.join(" ")}`);
  }
  return node as unknown as JsonCanvasNode;
}

function parseCanvasEdge(value: unknown, label: string): JsonCanvasEdge {
  const edge = parseJsonSafePlainObject(value, label);
  getRequiredStableId(edge, "id", label);
  getRequiredStableId(edge, "fromNode", label);
  getRequiredStableId(edge, "toNode", label);
  validateOptionalEnumField(edge, "fromSide", EDGE_SIDES, label);
  validateOptionalEnumField(edge, "toSide", EDGE_SIDES, label);
  validateOptionalEnumField(edge, "fromEnd", EDGE_ENDS, label);
  validateOptionalEnumField(edge, "toEnd", EDGE_ENDS, label);
  validateOptionalStringField(edge, "color", label);
  validateOptionalStringField(edge, "label", label);
  return edge as unknown as JsonCanvasEdge;
}

function parseNodeChanges(
  value: unknown,
  label: string,
): CanvasUpdateNodeOperation["changes"] {
  const changes = parseJsonSafePlainObject(value, label);
  if (hasOwn(changes, "id")) {
    throw new Error(`${label} cannot include id; Canvas ids are stable.`);
  }
  validateOptionalEnumField(changes, "type", NODE_TYPES, label);
  validateOptionalIntegerField(changes, "x", label);
  validateOptionalIntegerField(changes, "y", label);
  validateOptionalPositiveIntegerField(changes, "width", label);
  validateOptionalPositiveIntegerField(changes, "height", label);
  for (const key of [
    "color",
    "text",
    "file",
    "subpath",
    "url",
    "label",
    "background",
  ]) {
    validateOptionalStringField(changes, key, label);
  }
  validateOptionalEnumField(
    changes,
    "backgroundStyle",
    GROUP_BACKGROUND_STYLES,
    label,
  );
  return changes as CanvasUpdateNodeOperation["changes"];
}

function parseEdgeChanges(
  value: unknown,
  label: string,
): CanvasUpdateEdgeOperation["changes"] {
  const changes = parseJsonSafePlainObject(value, label);
  if (hasOwn(changes, "id")) {
    throw new Error(`${label} cannot include id; Canvas ids are stable.`);
  }
  validateOptionalStableIdField(changes, "fromNode", label);
  validateOptionalStableIdField(changes, "toNode", label);
  validateOptionalEnumField(changes, "fromSide", EDGE_SIDES, label);
  validateOptionalEnumField(changes, "toSide", EDGE_SIDES, label);
  validateOptionalEnumField(changes, "fromEnd", EDGE_ENDS, label);
  validateOptionalEnumField(changes, "toEnd", EDGE_ENDS, label);
  validateOptionalStringField(changes, "color", label);
  validateOptionalStringField(changes, "label", label);
  return changes as CanvasUpdateEdgeOperation["changes"];
}

function parseAutoLayoutOperation(
  value: Record<string, unknown>,
  label: string,
): CanvasAutoLayoutOperation {
  const nodeIds = hasOwn(value, "nodeIds")
    ? parseStableIdArray(value.nodeIds, `${label}.nodeIds`)
    : undefined;
  const direction = hasOwn(value, "direction")
    ? getEnumValue(
        value.direction,
        new Set<CanvasAutoLayoutDirection>(["row", "column", "grid"]),
        `${label}.direction`,
      )
    : undefined;
  const columns = getOptionalParsedInteger(value, "columns", label, {
    minimum: 1,
  });
  const originX = getOptionalParsedInteger(value, "originX", label);
  const originY = getOptionalParsedInteger(value, "originY", label);
  const gapX = getOptionalParsedInteger(value, "gapX", label, { minimum: 0 });
  const gapY = getOptionalParsedInteger(value, "gapY", label, { minimum: 0 });
  return {
    op: "auto_layout",
    ...(nodeIds !== undefined ? { nodeIds } : {}),
    ...(direction !== undefined ? { direction } : {}),
    ...(columns !== undefined ? { columns } : {}),
    ...(originX !== undefined ? { originX } : {}),
    ...(originY !== undefined ? { originY } : {}),
    ...(gapX !== undefined ? { gapX } : {}),
    ...(gapY !== undefined ? { gapY } : {}),
  };
}

function parseStableIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of stable Canvas ids.`);
  }
  return value.map((id, index) => {
    if (typeof id !== "string") {
      throw new Error(`${label}[${index}] must be a string.`);
    }
    return requireStableId(id, `${label}[${index}]`);
  });
}

function getRequiredStableId(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  return requireStableId(
    getRequiredPlainString(value, key, label),
    `${label}.${key}`,
  );
}

function getRequiredPlainString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  if (!hasOwn(value, key) || typeof value[key] !== "string") {
    throw new Error(`${label}.${key} must be a string.`);
  }
  return value[key];
}

function validateOptionalStableIdField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (!hasOwn(value, key)) return;
  if (typeof value[key] !== "string") {
    throw new Error(`${label}.${key} must be a string.`);
  }
  requireStableId(value[key], `${label}.${key}`);
}

function validateOptionalStringField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (hasOwn(value, key) && typeof value[key] !== "string") {
    throw new Error(`${label}.${key} must be a string.`);
  }
}

function validateOptionalIntegerField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (hasOwn(value, key) && !Number.isInteger(value[key])) {
    throw new Error(`${label}.${key} must be an integer.`);
  }
}

function validateOptionalPositiveIntegerField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): void {
  if (!hasOwn(value, key)) return;
  if (!Number.isInteger(value[key]) || (value[key] as number) <= 0) {
    throw new Error(`${label}.${key} must be a positive integer.`);
  }
}

function validateOptionalEnumField<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
  label: string,
): void {
  if (!hasOwn(value, key)) return;
  getEnumValue(value[key], allowed, `${label}.${key}`);
}

function getEnumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(", ")}.`);
  }
  return value as T;
}

function getOptionalParsedInteger(
  value: Record<string, unknown>,
  key: string,
  label: string,
  bounds: { minimum?: number } = {},
): number | undefined {
  if (!hasOwn(value, key)) return undefined;
  const candidate = value[key];
  if (!Number.isInteger(candidate)) {
    throw new Error(`${label}.${key} must be an integer.`);
  }
  if (bounds.minimum !== undefined && (candidate as number) < bounds.minimum) {
    throw new Error(`${label}.${key} must be at least ${bounds.minimum}.`);
  }
  return candidate as number;
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported keys: ${unknownKeys.join(", ")}.`);
  }
  const missingKeys = required.filter((key) => !hasOwn(value, key));
  if (missingKeys.length > 0) {
    throw new Error(`${label} is missing required keys: ${missingKeys.join(", ")}.`);
  }
}

function parseJsonSafePlainObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const parsed = cloneJsonSafeValue(value, label, new Set<object>());
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON-safe plain object.`);
  }
  return parsed;
}

function cloneJsonSafeValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${label} contains a value that is not JSON-safe.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${label} contains a circular reference.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const allowedKeys = new Set([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      const unsupportedKeys = Reflect.ownKeys(value).filter(
        (key) => typeof key !== "string" || !allowedKeys.has(key),
      );
      if (unsupportedKeys.length > 0) {
        throw new Error(`${label} arrays must not contain custom or symbol keys.`);
      }
      const cloned: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw new Error(`${label} must not contain sparse array entries.`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${label}[${index}] must be an enumerable data property.`);
        }
        cloned.push(
          cloneJsonSafeValue(descriptor.value, `${label}[${index}]`, ancestors),
        );
      }
      return cloned;
    }

    if (!isPlainObject(value)) {
      throw new Error(`${label} must contain only JSON-safe plain objects.`);
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(`${label} plain objects must not contain symbol keys.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${label}.${key} must be an enumerable data property.`);
      }
      Object.defineProperty(result, key, {
        value: cloneJsonSafeValue(descriptor.value, `${label}.${key}`, ancestors),
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Canvas patch operation: ${String(value)}`);
}
