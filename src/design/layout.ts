import type {
  JsonCanvas,
  JsonCanvasEdge,
  JsonCanvasNode,
  JsonCanvasNodeType,
} from "./jsonCanvas";
import { assertValidJsonCanvas } from "./jsonCanvas";

export type CanvasLayoutDirection = "row" | "column" | "grid";
export type CanvasConnectionMode = "none" | "sequence";

export interface CanvasLayoutItem {
  id?: string;
  type?: JsonCanvasNodeType;
  title: string;
  text?: string;
  file?: string;
  url?: string;
  color?: string;
}

export interface CanvasLayoutInput {
  title?: string;
  items: CanvasLayoutItem[];
  direction?: CanvasLayoutDirection;
  connect?: CanvasConnectionMode;
}

const DEFAULT_NODE_WIDTH = 360;
const DEFAULT_NODE_HEIGHT = 180;
const DEFAULT_GAP_X = 80;
const DEFAULT_GAP_Y = 80;

export function buildLayoutCanvas(input: CanvasLayoutInput): JsonCanvas {
  const items = input.items.length > 0
    ? input.items
    : [{ title: input.title ?? "Design", text: "" }];
  const columns = getColumnCount(items.length, input.direction ?? "grid");
  const titleNode = input.title && input.items.length > 0
    ? buildTitleNode(input.title, items)
    : null;
  const itemNodes = items.map((item, index) =>
    buildLayoutNode(item, index, columns),
  );
  const nodes = titleNode ? [titleNode, ...offsetNodes(itemNodes, 220)] : itemNodes;
  const edges =
    (input.connect ?? "sequence") === "sequence"
      ? buildSequenceEdges(nodes)
      : [];
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
): JsonCanvasNode {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const base = {
    id: normalizeId(item.id, index),
    x: column * (DEFAULT_NODE_WIDTH + DEFAULT_GAP_X),
    y: row * (DEFAULT_NODE_HEIGHT + DEFAULT_GAP_Y),
    width: DEFAULT_NODE_WIDTH,
    height: DEFAULT_NODE_HEIGHT,
    color: item.color,
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

  if (title && body) {
    return `# ${title}\n\n${body}`;
  }

  if (title) {
    return `# ${title}`;
  }

  return body;
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
