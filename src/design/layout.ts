import type {
  JsonCanvas,
  JsonCanvasEdge,
  JsonCanvasNode,
  JsonCanvasNodeType,
} from "./jsonCanvas";
import { assertValidJsonCanvas } from "./jsonCanvas";

export type CanvasLayoutDirection = "row" | "column" | "grid";
export type CanvasLayoutDiagramType =
  | "sequence"
  | "user_flow"
  | "ui_flow"
  | "logistics_system"
  | "service_blueprint"
  | "project_ideation"
  | "architecture"
  | "mind_map"
  | "distributed_system"
  | "business_process"
  | "manufacturing_process";
export type CanvasConnectionMode = "none" | "sequence";
export type CanvasLayoutItemKind =
  | "step"
  | "branch"
  | "persona"
  | "actor"
  | "screen"
  | "decision"
  | "service"
  | "resource"
  | "database"
  | "queue"
  | "milestone"
  | "risk"
  | "metric"
  | "dependency"
  | "note"
  | "external"
  | "client"
  | "gateway"
  | "worker"
  | "broker"
  | "cache"
  | "external_system"
  | "event"
  | "process"
  | "subprocess"
  | "document"
  | "supplier"
  | "material"
  | "inventory"
  | "operation"
  | "workcell"
  | "facility"
  | "inspection"
  | "control"
  | "output";

export interface CanvasLayoutItem {
  id?: string;
  type?: JsonCanvasNodeType;
  kind?: CanvasLayoutItemKind;
  title: string;
  text?: string;
  file?: string;
  url?: string;
  lane?: string;
  color?: string;
}

export interface CanvasLayoutConnection {
  from: string;
  to: string;
  label?: string;
  color?: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
}

export interface CanvasLayoutInput {
  title?: string;
  items: CanvasLayoutItem[];
  direction?: CanvasLayoutDirection;
  connect?: CanvasConnectionMode;
  diagramType?: CanvasLayoutDiagramType;
  connections?: CanvasLayoutConnection[];
}

const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 180;
const DEFAULT_GAP_X = 80;
const DEFAULT_GAP_Y = 80;

export function buildLayoutCanvas(input: CanvasLayoutInput): JsonCanvas {
  const items = input.items.length > 0
    ? input.items
    : [{ title: input.title ?? "Design", text: "" }];
  const diagramType = input.diagramType ?? "sequence";
  if (
    diagramType === "user_flow" ||
    diagramType === "ui_flow" ||
    diagramType === "service_blueprint" ||
    diagramType === "logistics_system" ||
    diagramType === "architecture" ||
    diagramType === "distributed_system" ||
    diagramType === "business_process" ||
    diagramType === "manufacturing_process"
  ) {
    return buildLaneCanvas(input, items, diagramType);
  }

  const columns = getColumnCount(items.length, input.direction ?? "grid");
  const titleNode = input.title && input.items.length > 0
    ? buildTitleNode(input.title, items)
    : null;
  const itemNodes = items.map((item, index) =>
    buildLayoutNode(item, index, columns, diagramType),
  );
  const nodes = titleNode ? [titleNode, ...offsetNodes(itemNodes, 220)] : itemNodes;
  const edges = buildLayoutEdges(input, nodes);
  const canvas = { nodes, edges };
  assertValidJsonCanvas(canvas);
  return canvas;
}

function buildLaneCanvas(
  input: CanvasLayoutInput,
  items: CanvasLayoutItem[],
  diagramType: CanvasLayoutDiagramType,
): JsonCanvas {
  const lanes = uniqueLaneNames(items, diagramType);
  const titleNode = input.title ? buildTitleNode(input.title, items) : null;
  const yOffset = titleNode ? 220 : 0;
  const laneItemCounters = new Map<string, number>();
  const laneCounts = new Map<string, number>();
  for (const lane of lanes) {
    laneCounts.set(lane, items.filter((item) => getItemLane(item, diagramType) === lane).length);
  }

  const groupNodes = lanes.map((lane, index) => {
    const laneCount = Math.max(1, laneCounts.get(lane) ?? 1);
    return buildLaneGroupNode(lane, index, laneCount, yOffset);
  });
  const itemNodes = items.map((item, index) => {
    const lane = getItemLane(item, diagramType);
    const laneIndex = Math.max(0, lanes.indexOf(lane));
    const column = laneItemCounters.get(lane) ?? 0;
    laneItemCounters.set(lane, column + 1);
    return buildLaneItemNode(item, index, laneIndex, column, diagramType, yOffset);
  });
  const nodes = titleNode
    ? [titleNode, ...groupNodes, ...itemNodes]
    : [...groupNodes, ...itemNodes];
  const edges = buildLayoutEdges(input, itemNodes);
  const canvas = { nodes, edges };
  assertValidJsonCanvas(canvas);
  return canvas;
}

function buildTitleNode(title: string, items: CanvasLayoutItem[]): JsonCanvasNode {
  const id = items.some((item) => item.id === "canvas-title")
    ? "canvas-title-node"
    : "canvas-title";
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    width: DEFAULT_NODE_WIDTH * 2,
    height: 120,
    color: "4",
    text: `# ${title.trim()}`,
  };
}

function offsetNodes(nodes: JsonCanvasNode[], yOffset: number): JsonCanvasNode[] {
  return nodes.map((node) => ({
    ...node,
    y: node.y + yOffset,
  }));
}

function buildLayoutNode(
  item: CanvasLayoutItem,
  index: number,
  columns: number,
  diagramType: CanvasLayoutDiagramType,
): JsonCanvasNode {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const base = {
    id: normalizeId(item.id, index),
    x: column * (DEFAULT_NODE_WIDTH + DEFAULT_GAP_X),
    y: row * (DEFAULT_NODE_HEIGHT + DEFAULT_GAP_Y),
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    color: item.color ?? getDefaultCanvasColor(item, diagramType),
  };
  const type = item.type ?? getItemType(item);

  if (type === "link") {
    return {
      ...base,
      type,
      url: item.url ?? "https://example.com",
    };
  }

  if (type === "file") {
    return {
      ...base,
      type,
      file: item.file ?? item.title,
    };
  }

  if (type === "group") {
    return {
      ...base,
      type,
      label: item.title,
      width: DEFAULT_NODE_WIDTH + 80,
      height: DEFAULT_NODE_HEIGHT + 80,
    };
  }

  return {
    ...base,
    type: "text",
    text: formatTextNode(item),
  };
}

function buildSequenceEdges(nodes: JsonCanvasNode[]): JsonCanvasEdge[] {
  const edges: JsonCanvasEdge[] = [];

  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push({
      id: normalizeId(undefined, index, "edge"),
      fromNode: nodes[index].id,
      fromSide: "right",
      toNode: nodes[index + 1].id,
      toSide: "left",
      toEnd: "arrow",
    });
  }

  return edges;
}

function buildLayoutEdges(
  input: CanvasLayoutInput,
  nodes: JsonCanvasNode[],
): JsonCanvasEdge[] {
  if (input.connections?.length) {
    return input.connections.map((connection, index) => ({
      id: normalizeId(undefined, index, "edge"),
      fromNode: connection.from,
      fromSide: connection.fromSide ?? "right",
      toNode: connection.to,
      toSide: connection.toSide ?? "left",
      toEnd: "arrow",
      label: connection.label,
      color: connection.color,
    }));
  }

  if ((input.connect ?? "sequence") !== "sequence") {
    return [];
  }

  return buildSequenceEdges(nodes);
}

function buildLaneGroupNode(
  lane: string,
  index: number,
  laneItemCount: number,
  yOffset: number,
): JsonCanvasNode {
  return {
    id: normalizeId(`lane-${slugifyId(lane)}`, index, "lane"),
    type: "group",
    x: 0,
    y: yOffset + index * (DEFAULT_NODE_HEIGHT + DEFAULT_GAP_Y + 120),
    width: laneItemCount * DEFAULT_NODE_WIDTH + Math.max(0, laneItemCount - 1) * DEFAULT_GAP_X + 80,
    height: DEFAULT_NODE_HEIGHT + 80,
    color: "2",
    label: lane,
  };
}

function buildLaneItemNode(
  item: CanvasLayoutItem,
  index: number,
  laneIndex: number,
  column: number,
  diagramType: CanvasLayoutDiagramType,
  yOffset: number,
): JsonCanvasNode {
  const base = buildLayoutNode(item, index, 1, diagramType);
  return {
    ...base,
    x: 40 + column * (DEFAULT_NODE_WIDTH + DEFAULT_GAP_X),
    y: yOffset + laneIndex * (DEFAULT_NODE_HEIGHT + DEFAULT_GAP_Y + 120) + 40,
  };
}

function uniqueLaneNames(
  items: CanvasLayoutItem[],
  diagramType: CanvasLayoutDiagramType,
): string[] {
  const lanes = [
    ...new Set(
      items.length > 0
        ? items.map((item) => getItemLane(item, diagramType))
        : [getDefaultLane(diagramType)],
    ),
  ];
  const preferredOrder = getPreferredLaneOrder(diagramType);
  return [
    ...preferredOrder.filter((lane) => lanes.includes(lane)),
    ...lanes.filter((lane) => !preferredOrder.includes(lane)),
  ];
}

function getItemLane(
  item: CanvasLayoutItem,
  diagramType: CanvasLayoutDiagramType,
): string {
  return item.lane?.trim() || inferCanvasLane(diagramType, item.kind);
}

/**
 * Infers a stable system tier or process swimlane. An item's explicit lane
 * always wins, allowing a model to express a specific trust zone, owner, or
 * plant area without losing useful defaults for simpler prompts.
 */
export function inferCanvasLane(
  diagramType: CanvasLayoutDiagramType,
  itemKind?: CanvasLayoutItemKind,
): string {
  if (diagramType === "distributed_system") {
    if (itemKind === "client" || itemKind === "gateway") return "Clients & Edge";
    if (itemKind === "queue" || itemKind === "broker" || itemKind === "event") {
      return "Messaging";
    }
    if (itemKind === "database" || itemKind === "cache" || itemKind === "inventory") {
      return "Data & State";
    }
    if (
      itemKind === "metric" ||
      itemKind === "risk" ||
      itemKind === "control" ||
      itemKind === "inspection"
    ) {
      return "Operations & Governance";
    }
    if (
      itemKind === "external" ||
      itemKind === "external_system" ||
      itemKind === "dependency"
    ) {
      return "External Systems";
    }
    return "Compute & Services";
  }

  if (diagramType === "business_process") {
    if (itemKind === "persona" || itemKind === "actor" || itemKind === "client") {
      return "Participants";
    }
    if (
      itemKind === "service" ||
      itemKind === "screen" ||
      itemKind === "database" ||
      itemKind === "document" ||
      itemKind === "external_system"
    ) {
      return "Systems & Records";
    }
    if (
      itemKind === "metric" ||
      itemKind === "risk" ||
      itemKind === "control" ||
      itemKind === "inspection" ||
      itemKind === "output"
    ) {
      return "Controls & Outcomes";
    }
    return "Process Flow";
  }

  if (diagramType === "manufacturing_process") {
    if (itemKind === "supplier" || itemKind === "material") {
      return "Inputs & Suppliers";
    }
    if (itemKind === "inventory" || itemKind === "queue" || itemKind === "resource") {
      return "Material Flow";
    }
    if (
      itemKind === "inspection" ||
      itemKind === "control" ||
      itemKind === "risk" ||
      itemKind === "metric" ||
      itemKind === "decision"
    ) {
      return "Quality & Control";
    }
    if (
      itemKind === "service" ||
      itemKind === "database" ||
      itemKind === "external_system" ||
      itemKind === "gateway"
    ) {
      return "Systems & Automation";
    }
    if (itemKind === "output") return "Outputs & Distribution";
    return "Production";
  }

  if (diagramType === "service_blueprint") {
    if (itemKind === "persona" || itemKind === "actor") return "Actors";
    if (itemKind === "screen") return "Frontstage";
    if (itemKind === "service" || itemKind === "database" || itemKind === "queue") {
      return "Backstage";
    }
    if (itemKind === "metric" || itemKind === "risk") return "Management";
  }

  if (diagramType === "logistics_system") {
    if (itemKind === "resource" || itemKind === "queue") return "Flow";
    if (itemKind === "dependency" || itemKind === "risk") return "Constraints";
    if (itemKind === "metric") return "Control";
  }

  if (diagramType === "ui_flow") {
    if (itemKind === "persona" || itemKind === "actor") return "Actors";
    if (itemKind === "screen" || itemKind === "decision") return "Screens";
  }

  return getDefaultLane(diagramType);
}

function getPreferredLaneOrder(diagramType: CanvasLayoutDiagramType): string[] {
  if (diagramType === "distributed_system") {
    return [
      "Clients & Edge",
      "Compute & Services",
      "Messaging",
      "Data & State",
      "Operations & Governance",
      "External Systems",
    ];
  }
  if (diagramType === "business_process") {
    return ["Participants", "Process Flow", "Systems & Records", "Controls & Outcomes"];
  }
  if (diagramType === "manufacturing_process") {
    return [
      "Inputs & Suppliers",
      "Material Flow",
      "Production",
      "Quality & Control",
      "Systems & Automation",
      "Outputs & Distribution",
    ];
  }
  return [];
}

function getDefaultLane(diagramType: CanvasLayoutDiagramType): string {
  if (diagramType === "architecture") {
    return "System";
  }

  if (diagramType === "user_flow" || diagramType === "ui_flow") {
    return "User Journey";
  }

  if (diagramType === "service_blueprint") {
    return "Service";
  }

  if (diagramType === "logistics_system") {
    return "Operations";
  }

  if (diagramType === "distributed_system") {
    return "Compute & Services";
  }

  if (diagramType === "business_process") {
    return "Process Flow";
  }

  if (diagramType === "manufacturing_process") {
    return "Production";
  }

  return "Flow";
}

function getColumnCount(count: number, direction: CanvasLayoutDirection): number {
  if (direction === "column") {
    return 1;
  }

  if (direction === "row") {
    return Math.max(1, count);
  }

  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

function getItemType(item: CanvasLayoutItem): JsonCanvasNodeType {
  if (item.url) {
    return "link";
  }

  if (item.file) {
    return "file";
  }

  return "text";
}

function formatTextNode(item: CanvasLayoutItem): string {
  const title = item.title.trim();
  const body = item.text?.trim() ?? "";
  const kind = item.kind ? `_${formatKind(item.kind)}_\n\n` : "";

  if (title && body) {
    return `# ${title}\n\n${kind}${body}`;
  }

  if (title) {
    return `# ${title}${kind ? `\n\n${kind.trimEnd()}` : ""}`;
  }

  return body;
}

function formatKind(kind: CanvasLayoutItemKind): string {
  return kind.replace(/_/g, " ");
}

function getDefaultCanvasColor(
  item: CanvasLayoutItem,
  diagramType: CanvasLayoutDiagramType,
): string | undefined {
  if (
    item.kind === "decision" ||
    item.kind === "risk" ||
    item.kind === "inspection" ||
    item.kind === "control"
  ) {
    return "3";
  }

  if (
    item.kind === "branch" ||
    item.kind === "database" ||
    item.kind === "queue" ||
    item.kind === "resource" ||
    item.kind === "metric" ||
    item.kind === "broker" ||
    item.kind === "cache" ||
    item.kind === "inventory" ||
    item.kind === "material" ||
    item.kind === "document"
  ) {
    return "5";
  }

  if (
    item.kind === "external" ||
    item.kind === "external_system" ||
    item.kind === "dependency" ||
    item.kind === "supplier" ||
    item.kind === "output"
  ) {
    return "6";
  }

  if (
    item.kind === "milestone" ||
    item.kind === "event" ||
    item.kind === "client" ||
    item.kind === "actor" ||
    item.kind === "persona"
  ) {
    return "2";
  }

  if (
    diagramType === "architecture" ||
    diagramType === "service_blueprint" ||
    diagramType === "distributed_system" ||
    diagramType === "business_process" ||
    diagramType === "manufacturing_process"
  ) {
    return "4";
  }

  if (diagramType === "user_flow" || diagramType === "ui_flow") {
    return "2";
  }

  return undefined;
}

function normalizeId(
  value: string | undefined,
  index: number,
  prefix = "node",
): string {
  if (value && /^[a-zA-Z0-9_-]+$/.test(value)) {
    return value;
  }

  const seed = prefix === "edge" ? index + 10_000 : index + 1;
  return seed.toString(16).padStart(16, "0");
}

function slugifyId(value: string): string {
  const slug = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "lane";
}
