import type {
  JsonCanvas,
  JsonCanvasEdge,
  JsonCanvasNode,
  JsonCanvasSide,
} from "./jsonCanvas";

export const MAX_CANVAS_QA_REPAIR_PASSES = 2;
export const MAX_CANVAS_COORDINATE = 1_000_000;
export const MAX_CANVAS_NODE_SIZE = 100_000;

const DEFAULT_EDGE_CROSSING_LIMIT = 3;
const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 180;
const DEFAULT_GROUP_WIDTH = 440;
const DEFAULT_GROUP_HEIGHT = 260;
const LAYOUT_GAP = 80;
const TEXT_HORIZONTAL_PADDING = 32;
const TEXT_VERTICAL_PADDING = 24;
const ESTIMATED_CHARACTER_WIDTH = 7;
const ESTIMATED_LINE_HEIGHT = 20;

export type CanvasQaIssueKind =
  | "invalid_bounds"
  | "node_overlap"
  | "text_truncation"
  | "edge_node_intersection"
  | "disconnected_component"
  | "excessive_edge_crossings";

export type CanvasQaRepairKind =
  | "normalize_bounds"
  | "resize_text_node"
  | "move_node"
  | "relayout_crossings";

export interface CanvasQaBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasQaIssue {
  id: string;
  kind: CanvasQaIssueKind;
  severity: "error" | "warning";
  message: string;
  nodeIds: string[];
  edgeIds: string[];
  metrics?: Record<string, number>;
}

export interface CanvasQaRepair {
  id: string;
  pass: number;
  kind: CanvasQaRepairKind;
  nodeId: string;
  issueIds: string[];
  before: CanvasQaBounds;
  after: CanvasQaBounds;
}

export interface CanvasQaOptions {
  autoRepair?: boolean;
  maxRepairPasses?: number;
  maxEdgeCrossings?: number;
}

export interface CanvasQaReport {
  ok: boolean;
  canvas: JsonCanvas;
  issues: CanvasQaIssue[];
  repairs: CanvasQaRepair[];
  passCount: number;
}

interface Point {
  x: number;
  y: number;
}

interface EdgeGeometry {
  edge: JsonCanvasEdge;
  from: Point;
  to: Point;
}

const ISSUE_ORDER: Record<CanvasQaIssueKind, number> = {
  invalid_bounds: 0,
  node_overlap: 1,
  text_truncation: 2,
  edge_node_intersection: 3,
  disconnected_component: 4,
  excessive_edge_crossings: 5,
};

/**
 * Runs deterministic structural/layout QA. The input is never mutated. When
 * enabled, repair is best-effort and is always capped at two passes.
 */
export function runCanvasQa(
  input: JsonCanvas,
  options: CanvasQaOptions = {},
): CanvasQaReport {
  let canvas = cloneCanvas(input);
  let issues = inspectCanvasQa(canvas, options);
  const repairs: CanvasQaRepair[] = [];
  let passCount = 0;
  const maximumPasses = options.autoRepair === true
    ? normalizeRepairPassLimit(options.maxRepairPasses)
    : 0;

  while (issues.length > 0 && passCount < maximumPasses) {
    passCount += 1;
    const passRepairs = repairCanvasPass(canvas, issues, passCount, options);
    repairs.push(...passRepairs);
    issues = inspectCanvasQa(canvas, options);
    if (passRepairs.length === 0) break;
  }

  return {
    ok: issues.length === 0,
    canvas,
    issues,
    repairs,
    passCount,
  };
}

/** Returns normalized, stable issue records without changing the canvas. */
export function inspectCanvasQa(
  canvas: JsonCanvas,
  options: CanvasQaOptions = {},
): CanvasQaIssue[] {
  const issues: CanvasQaIssue[] = [];
  const nodes = [...canvas.nodes].sort(compareNodes);
  const edges = [...canvas.edges].sort((left, right) => left.id.localeCompare(right.id));
  const validNodes = nodes.filter(hasValidBounds);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (!hasValidBounds(node)) {
      issues.push(issue({
        kind: "invalid_bounds",
        severity: "error",
        nodeIds: [node.id],
        message: `Node ${node.id} has invalid or unsafe bounds.`,
      }));
      continue;
    }
    const estimate = estimateTextTruncation(node);
    if (estimate && estimate.requiredLines > estimate.availableLines) {
      issues.push(issue({
        kind: "text_truncation",
        severity: "warning",
        nodeIds: [node.id],
        message: `Node ${node.id} is estimated to need ${estimate.requiredLines} lines but has room for ${estimate.availableLines}.`,
        metrics: estimate,
      }));
    }
  }

  for (let leftIndex = 0; leftIndex < validNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < validNodes.length; rightIndex += 1) {
      const left = validNodes[leftIndex];
      const right = validNodes[rightIndex];
      if (!rectanglesOverlap(bounds(left), bounds(right))) continue;
      if (isExpectedGroupContainment(left, right)) continue;
      issues.push(issue({
        kind: "node_overlap",
        severity: "error",
        nodeIds: [left.id, right.id],
        message: `Nodes ${left.id} and ${right.id} overlap.`,
      }));
    }
  }

  const edgeGeometry = edges
    .map((edge) => edgeToGeometry(edge, nodeById))
    .filter((value): value is EdgeGeometry => value !== null);
  for (const geometry of edgeGeometry) {
    for (const node of validNodes) {
      if (
        node.type === "group" ||
        node.id === geometry.edge.fromNode ||
        node.id === geometry.edge.toNode
      ) {
        continue;
      }
      if (!segmentIntersectsRectInterior(geometry.from, geometry.to, bounds(node))) continue;
      issues.push(issue({
        kind: "edge_node_intersection",
        severity: "error",
        nodeIds: [node.id],
        edgeIds: [geometry.edge.id],
        message: `Edge ${geometry.edge.id} intersects node ${node.id}.`,
      }));
    }
  }

  issues.push(...disconnectedComponentIssues(nodes, edges));

  const crossingPairs = findEdgeCrossings(edgeGeometry);
  const crossingLimit = normalizeCrossingLimit(options.maxEdgeCrossings);
  if (crossingPairs.length > crossingLimit) {
    const edgeIds = [...new Set(crossingPairs.flat())].sort();
    issues.push(issue({
      kind: "excessive_edge_crossings",
      severity: "warning",
      edgeIds,
      message: `Canvas has ${crossingPairs.length} edge crossings; the limit is ${crossingLimit}.`,
      metrics: {
        crossingCount: crossingPairs.length,
        crossingLimit,
      },
    }));
  }

  return issues.sort(compareIssues);
}

function repairCanvasPass(
  canvas: JsonCanvas,
  initialIssues: CanvasQaIssue[],
  pass: number,
  options: CanvasQaOptions,
): CanvasQaRepair[] {
  const repairs: CanvasQaRepair[] = [];

  for (const node of [...canvas.nodes].sort(compareNodes)) {
    if (!hasValidBounds(node)) {
      updateNodeBounds(
        canvas,
        node.id,
        normalizeNodeBounds(node),
        "normalize_bounds",
        pass,
        matchingIssueIds(initialIssues, node.id, "invalid_bounds"),
        repairs,
      );
    }
  }

  let currentIssues = inspectCanvasQa(canvas, options);
  for (const truncation of currentIssues.filter(
    (item) => item.kind === "text_truncation",
  )) {
    const nodeId = truncation.nodeIds[0];
    const node = canvas.nodes.find((candidate) => candidate.id === nodeId);
    const requiredLines = truncation.metrics?.requiredLines;
    if (!node || requiredLines === undefined || !hasValidBounds(node)) continue;
    const targetHeight = Math.min(
      MAX_CANVAS_NODE_SIZE,
      Math.max(node.height, requiredLines * ESTIMATED_LINE_HEIGHT + TEXT_VERTICAL_PADDING),
    );
    updateNodeBounds(
      canvas,
      node.id,
      { ...bounds(node), height: targetHeight },
      "resize_text_node",
      pass,
      [truncation.id],
      repairs,
    );
  }

  separateOverlappingNodes(canvas, pass, repairs);

  currentIssues = inspectCanvasQa(canvas, options);
  moveIntersectedNodes(canvas, currentIssues, pass, repairs);

  currentIssues = inspectCanvasQa(canvas, options);
  const crossingIssue = currentIssues.find(
    (item) => item.kind === "excessive_edge_crossings",
  );
  if (crossingIssue) {
    relayoutCrossingNodes(canvas, crossingIssue, pass, repairs);
  }

  return repairs;
}

function separateOverlappingNodes(
  canvas: JsonCanvas,
  pass: number,
  repairs: CanvasQaRepair[],
): void {
  const ordered = [...canvas.nodes].sort((left, right) => {
    const titleDifference = Number(isTitleNode(right)) - Number(isTitleNode(left));
    return titleDifference || compareNodes(left, right);
  });
  const placed: JsonCanvasNode[] = [];

  for (const node of ordered) {
    if (!hasValidBounds(node) || node.type === "group") continue;
    if (isTitleNode(node)) {
      placed.push(node);
      continue;
    }
    let current = canvas.nodes.find((candidate) => candidate.id === node.id) ?? node;
    let attempts = 0;
    while (attempts <= ordered.length) {
      const collisions = placed.filter(
        (candidate) =>
          hasValidBounds(candidate) &&
          rectanglesOverlap(bounds(current), bounds(candidate)),
      );
      if (collisions.length === 0) break;
      const nextY = Math.max(...collisions.map((candidate) => candidate.y + candidate.height)) + LAYOUT_GAP;
      const overlappingIssueIds = collisions.flatMap((candidate) =>
        matchingPairIssueIds(current.id, candidate.id, "node_overlap"),
      );
      updateNodeBounds(
        canvas,
        current.id,
        { ...bounds(current), y: clampPosition(nextY, current.height) },
        "move_node",
        pass,
        overlappingIssueIds,
        repairs,
      );
      current = canvas.nodes.find((candidate) => candidate.id === current.id) ?? current;
      attempts += 1;
    }
    placed.push(current);
  }
}

function moveIntersectedNodes(
  canvas: JsonCanvas,
  issues: CanvasQaIssue[],
  pass: number,
  repairs: CanvasQaRepair[],
): void {
  const intersections = issues
    .filter((item) => item.kind === "edge_node_intersection")
    .sort(compareIssues);
  const byNode = new Map<string, CanvasQaIssue[]>();
  for (const intersection of intersections) {
    const nodeId = intersection.nodeIds[0];
    const entries = byNode.get(nodeId) ?? [];
    entries.push(intersection);
    byNode.set(nodeId, entries);
  }
  const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(canvas.edges.map((edge) => [edge.id, edge]));

  for (const [nodeId, nodeIssues] of [...byNode.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const node = nodeById.get(nodeId);
    if (!node || node.type === "group" || isTitleNode(node) || !hasValidBounds(node)) continue;
    const geometries = nodeIssues
      .flatMap((item) => item.edgeIds)
      .map((edgeId) => edgeById.get(edgeId))
      .filter((edge): edge is JsonCanvasEdge => Boolean(edge))
      .map((edge) => edgeToGeometry(edge, nodeById))
      .filter((value): value is EdgeGeometry => value !== null);
    if (geometries.length === 0) continue;
    const nextY = Math.max(
      node.y,
      ...geometries.map((geometry) => Math.max(geometry.from.y, geometry.to.y)),
    ) + LAYOUT_GAP;
    updateNodeBounds(
      canvas,
      node.id,
      { ...bounds(node), y: clampPosition(nextY, node.height) },
      "move_node",
      pass,
      nodeIssues.map((item) => item.id),
      repairs,
    );
  }
}

function relayoutCrossingNodes(
  canvas: JsonCanvas,
  crossingIssue: CanvasQaIssue,
  pass: number,
  repairs: CanvasQaRepair[],
): void {
  const nodes = canvas.nodes
    .filter((node) => hasValidBounds(node) && node.type !== "group" && !isTitleNode(node))
    .sort(compareNodes);
  if (nodes.length < 3) return;
  const radius = Math.max(300, Math.ceil(nodes.length * 90));
  const minimumX = Math.min(...nodes.map((node) => node.x));
  const minimumY = Math.min(...nodes.map((node) => node.y));
  const titleBottom = Math.max(
    minimumY,
    ...canvas.nodes.filter(isTitleNode).map((node) => node.y + node.height + LAYOUT_GAP),
  );
  const centerX = minimumX + radius;
  const centerY = Math.max(minimumY + radius, titleBottom + radius);

  nodes.forEach((node, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / nodes.length;
    const x = clampPosition(
      Math.round(centerX + Math.cos(angle) * radius - node.width / 2),
      node.width,
    );
    const y = clampPosition(
      Math.round(centerY + Math.sin(angle) * radius - node.height / 2),
      node.height,
    );
    updateNodeBounds(
      canvas,
      node.id,
      { ...bounds(node), x, y },
      "relayout_crossings",
      pass,
      [crossingIssue.id],
      repairs,
    );
  });
}

function disconnectedComponentIssues(
  nodes: JsonCanvasNode[],
  edges: JsonCanvasEdge[],
): CanvasQaIssue[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) continue;
    adjacency.get(edge.fromNode)?.add(edge.toNode);
    adjacency.get(edge.toNode)?.add(edge.fromNode);
  }
  const contentIds = nodes
    .filter((node) => node.type !== "group" && !isTitleNode(node))
    .map((node) => node.id)
    .sort();
  if (contentIds.length <= 1) return [];

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of contentIds) {
    if (visited.has(start)) continue;
    const queue = [start];
    const contentComponent = new Set<string>();
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (contentIds.includes(current)) contentComponent.add(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    if (contentComponent.size > 0) {
      components.push([...contentComponent].sort());
    }
  }
  if (components.length <= 1) return [];
  components.sort(
    (left, right) => right.length - left.length || left[0].localeCompare(right[0]),
  );
  return components.slice(1).map((component) => issue({
    kind: "disconnected_component",
    severity: "warning",
    nodeIds: component,
    message: `Disconnected Canvas component contains: ${component.join(", ")}.`,
  }));
}

function findEdgeCrossings(geometry: EdgeGeometry[]): Array<[string, string]> {
  const crossings: Array<[string, string]> = [];
  for (let leftIndex = 0; leftIndex < geometry.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.length; rightIndex += 1) {
      const left = geometry[leftIndex];
      const right = geometry[rightIndex];
      if (edgesShareNode(left.edge, right.edge)) continue;
      if (!segmentsProperlyCross(left.from, left.to, right.from, right.to)) continue;
      crossings.push([left.edge.id, right.edge.id].sort() as [string, string]);
    }
  }
  return crossings.sort(([leftA, leftB], [rightA, rightB]) =>
    leftA.localeCompare(rightA) || leftB.localeCompare(rightB));
}

function edgeToGeometry(
  edge: JsonCanvasEdge,
  nodeById: Map<string, JsonCanvasNode>,
): EdgeGeometry | null {
  const fromNode = nodeById.get(edge.fromNode);
  const toNode = nodeById.get(edge.toNode);
  if (!fromNode || !toNode || !hasValidBounds(fromNode) || !hasValidBounds(toNode)) {
    return null;
  }
  const fromSide = edge.fromSide ?? inferredSide(fromNode, toNode);
  const toSide = edge.toSide ?? inferredSide(toNode, fromNode);
  return {
    edge,
    from: nodeAnchor(fromNode, fromSide),
    to: nodeAnchor(toNode, toSide),
  };
}

function inferredSide(from: JsonCanvasNode, to: JsonCanvasNode): JsonCanvasSide {
  const fromCenter = center(from);
  const toCenter = center(to);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function nodeAnchor(node: JsonCanvasNode, side: JsonCanvasSide): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
  }
}

function center(node: JsonCanvasNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function segmentIntersectsRectInterior(from: Point, to: Point, rect: CanvasQaBounds): boolean {
  const inset = 1;
  const left = rect.x + inset;
  const right = rect.x + rect.width - inset;
  const top = rect.y + inset;
  const bottom = rect.y + rect.height - inset;
  if (left >= right || top >= bottom) return false;
  let minimum = 0;
  let maximum = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (const [p, q] of [
    [-dx, from.x - left],
    [dx, right - from.x],
    [-dy, from.y - top],
    [dy, bottom - from.y],
  ] as Array<[number, number]>) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return maximum > 0 && minimum < 1;
}

function segmentsProperlyCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  const epsilon = 1e-9;
  return first * second < -epsilon && third * fourth < -epsilon;
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function edgesShareNode(left: JsonCanvasEdge, right: JsonCanvasEdge): boolean {
  return (
    left.fromNode === right.fromNode ||
    left.fromNode === right.toNode ||
    left.toNode === right.fromNode ||
    left.toNode === right.toNode
  );
}

function estimateTextTruncation(
  node: JsonCanvasNode,
): { requiredLines: number; availableLines: number; charactersPerLine: number } | null {
  if (node.type !== "text" || !node.text.trim() || !hasValidBounds(node)) return null;
  const charactersPerLine = Math.max(
    1,
    Math.floor((node.width - TEXT_HORIZONTAL_PADDING) / ESTIMATED_CHARACTER_WIDTH),
  );
  const availableLines = Math.max(
    1,
    Math.floor((node.height - TEXT_VERTICAL_PADDING) / ESTIMATED_LINE_HEIGHT),
  );
  const requiredLines = node.text.split(/\r?\n/u).reduce((total, rawLine) => {
    const line = rawLine.replace(/^#{1,6}\s+/u, "").replace(/[*_`]/gu, "");
    return total + Math.max(1, Math.ceil(line.length / charactersPerLine));
  }, 0);
  return { requiredLines, availableLines, charactersPerLine };
}

function hasValidBounds(node: JsonCanvasNode): boolean {
  const values = [node.x, node.y, node.width, node.height];
  if (values.some((value) => !Number.isSafeInteger(value))) return false;
  if (node.width <= 0 || node.height <= 0) return false;
  if (node.width > MAX_CANVAS_NODE_SIZE || node.height > MAX_CANVAS_NODE_SIZE) return false;
  return (
    node.x >= -MAX_CANVAS_COORDINATE &&
    node.y >= -MAX_CANVAS_COORDINATE &&
    node.x + node.width <= MAX_CANVAS_COORDINATE &&
    node.y + node.height <= MAX_CANVAS_COORDINATE
  );
}

function normalizeNodeBounds(node: JsonCanvasNode): CanvasQaBounds {
  const fallbackWidth = node.type === "group" ? DEFAULT_GROUP_WIDTH : DEFAULT_NODE_WIDTH;
  const fallbackHeight = node.type === "group" ? DEFAULT_GROUP_HEIGHT : DEFAULT_NODE_HEIGHT;
  const width = normalizeDimension(node.width, fallbackWidth);
  const height = normalizeDimension(node.height, fallbackHeight);
  return {
    x: normalizePosition(node.x, width),
    y: normalizePosition(node.y, height),
    width,
    height,
  };
}

function normalizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_CANVAS_NODE_SIZE, Math.max(1, Math.round(value)));
}

function normalizePosition(value: number, size: number): number {
  if (!Number.isFinite(value)) return 0;
  return clampPosition(Math.round(value), size);
}

function clampPosition(value: number, size: number): number {
  return Math.min(
    MAX_CANVAS_COORDINATE - size,
    Math.max(-MAX_CANVAS_COORDINATE, Math.round(value)),
  );
}

function rectanglesOverlap(left: CanvasQaBounds, right: CanvasQaBounds): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function contains(outer: CanvasQaBounds, inner: CanvasQaBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function isExpectedGroupContainment(left: JsonCanvasNode, right: JsonCanvasNode): boolean {
  return (
    (left.type === "group" && contains(bounds(left), bounds(right))) ||
    (right.type === "group" && contains(bounds(right), bounds(left)))
  );
}

function isTitleNode(node: JsonCanvasNode): boolean {
  return (
    node.type === "text" &&
    (/^canvas-title(?:-node)?$/iu.test(node.id) || node.id === "title")
  );
}

function bounds(node: JsonCanvasNode): CanvasQaBounds {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function updateNodeBounds(
  canvas: JsonCanvas,
  nodeId: string,
  nextBounds: CanvasQaBounds,
  kind: CanvasQaRepairKind,
  pass: number,
  issueIds: string[],
  repairs: CanvasQaRepair[],
): void {
  const index = canvas.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return;
  const node = canvas.nodes[index];
  const before = bounds(node);
  if (sameBounds(before, nextBounds)) return;
  canvas.nodes[index] = { ...node, ...nextBounds } as JsonCanvasNode;
  repairs.push({
    id: `canvas-qa-repair:${pass}:${kind}:${nodeId}:${repairs.length + 1}`,
    pass,
    kind,
    nodeId,
    issueIds: [...new Set(issueIds)].sort(),
    before,
    after: { ...nextBounds },
  });
}

function sameBounds(left: CanvasQaBounds, right: CanvasQaBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function matchingIssueIds(
  issues: CanvasQaIssue[],
  nodeId: string,
  kind: CanvasQaIssueKind,
): string[] {
  return issues
    .filter((item) => item.kind === kind && item.nodeIds.includes(nodeId))
    .map((item) => item.id)
    .sort();
}

function matchingPairIssueIds(
  leftId: string,
  rightId: string,
  kind: CanvasQaIssueKind,
): string[] {
  return [issue({
    kind,
    severity: "error",
    nodeIds: [leftId, rightId],
    message: "",
  }).id];
}

function issue(input: {
  kind: CanvasQaIssueKind;
  severity: "error" | "warning";
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
  metrics?: Record<string, number>;
}): CanvasQaIssue {
  const nodeIds = [...new Set(input.nodeIds ?? [])].sort();
  const edgeIds = [...new Set(input.edgeIds ?? [])].sort();
  const subject = [...nodeIds.map((id) => `node:${id}`), ...edgeIds.map((id) => `edge:${id}`)]
    .join("|") || "canvas";
  return {
    id: `canvas-qa:${input.kind}:${subject}`,
    kind: input.kind,
    severity: input.severity,
    message: input.message,
    nodeIds,
    edgeIds,
    ...(input.metrics ? { metrics: { ...input.metrics } } : {}),
  };
}

function compareNodes(left: JsonCanvasNode, right: JsonCanvasNode): number {
  return left.id.localeCompare(right.id) || left.y - right.y || left.x - right.x;
}

function compareIssues(left: CanvasQaIssue, right: CanvasQaIssue): number {
  return ISSUE_ORDER[left.kind] - ISSUE_ORDER[right.kind] || left.id.localeCompare(right.id);
}

function normalizeRepairPassLimit(value: number | undefined): number {
  if (value === undefined) return MAX_CANVAS_QA_REPAIR_PASSES;
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_CANVAS_QA_REPAIR_PASSES, Math.max(0, Math.trunc(value)));
}

function normalizeCrossingLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_EDGE_CROSSING_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_EDGE_CROSSING_LIMIT;
  return Math.min(10_000, Math.max(0, Math.trunc(value)));
}

function cloneCanvas(canvas: JsonCanvas): JsonCanvas {
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => ({ ...node })) as JsonCanvasNode[],
    edges: canvas.edges.map((edge) => ({ ...edge })),
  };
}
