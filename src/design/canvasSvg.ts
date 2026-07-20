import {
  assertValidJsonCanvas,
  type JsonCanvas,
  type JsonCanvasEdge,
  type JsonCanvasNode,
  type JsonCanvasSide,
} from "./jsonCanvas";

export interface CanvasSvgOptions {
  title?: string;
  padding?: number;
}

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;
const DEFAULT_PADDING = 48;
const TEXT_LINE_HEIGHT = 20;
const MAX_SVG_NODES = 500;
const MAX_SVG_EDGES = 1_000;
const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MAX_NODE_DIMENSION = 8_192;
const MAX_VIEWPORT_DIMENSION = 65_536;

const PALETTE: Record<string, string> = {
  "1": "#ef4444",
  "2": "#f59e0b",
  "3": "#eab308",
  "4": "#22c55e",
  "5": "#06b6d4",
  "6": "#a855f7",
};

/**
 * Render a validated JSON Canvas as a passive, standalone SVG image.
 *
 * The exporter intentionally emits no scripts, stylesheets, foreign objects,
 * images, hyperlinks, or source URLs. File and link nodes are represented by
 * generic labels so an exported architecture image cannot disclose their
 * targets accidentally.
 */
export function renderJsonCanvasSvg(
  canvas: JsonCanvas,
  options: CanvasSvgOptions = {},
): string {
  assertValidJsonCanvas(canvas);
  assertSafeSvgGeometry(canvas);

  const padding = normalizePadding(options.padding);
  const bounds = getCanvasBounds(canvas.nodes, padding);
  if (
    bounds.width > MAX_VIEWPORT_DIMENSION ||
    bounds.height > MAX_VIEWPORT_DIMENSION
  ) {
    throw new Error(
      `Canvas SVG viewport must not exceed ${MAX_VIEWPORT_DIMENSION} pixels per dimension.`,
    );
  }
  const title = options.title?.trim() || "Canvas diagram";
  const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
  const groups = canvas.nodes.filter((node) => node.type === "group");
  const foregroundNodes = canvas.nodes.filter((node) => node.type !== "group");

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}" role="img" aria-label="${escapeAttribute(title)}">`,
    `  <title>${escapeXml(title)}</title>`,
    "  <defs>",
    "    <marker id=\"canvas-arrow\" markerWidth=\"10\" markerHeight=\"10\" refX=\"9\" refY=\"3\" orient=\"auto-start-reverse\" markerUnits=\"strokeWidth\">",
    "      <path d=\"M0,0 L0,6 L9,3 z\" fill=\"#5cff8d\"/>",
    "    </marker>",
    "  </defs>",
    `  <rect x="0" y="0" width="${bounds.width}" height="${bounds.height}" fill="#020403"/>`,
    `  <g transform="translate(${bounds.translateX} ${bounds.translateY})" font-family="Cascadia Mono, Lucida Console, monospace">`,
    ...groups.map((node) => renderGroupNode(node)),
    ...canvas.edges.map((edge) => renderEdge(edge, nodeById)),
    ...foregroundNodes.map((node) => renderForegroundNode(node)),
    "  </g>",
    "</svg>",
    "",
  ];

  return lines.join("\n");
}

function renderGroupNode(node: JsonCanvasNode): string {
  if (node.type !== "group") {
    return "";
  }

  const stroke = resolveColor(node.color, "#2ca85a");
  const label = node.label?.trim() || "Group";
  return [
    `    <g data-node-id="${escapeAttribute(node.id)}">`,
    `      <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="#07140a" fill-opacity="0.55" stroke="${stroke}" stroke-width="2" stroke-dasharray="8 6"/>`,
    `      <text x="${node.x + 16}" y="${node.y + 27}" fill="#a8ffbf" font-size="16" font-weight="700">${escapeXml(label)}</text>`,
    "    </g>",
  ].join("\n");
}

function renderForegroundNode(node: JsonCanvasNode): string {
  const stroke = resolveColor(node.color, "#5cff8d");
  const label = getSafeNodeLabel(node);
  const lines = fitTextLines(label, node.width, node.height);
  const textX = node.x + 16;
  const textY = node.y + 30;

  return [
    `    <g data-node-id="${escapeAttribute(node.id)}">`,
    `      <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="#061007" stroke="${stroke}" stroke-width="2"/>`,
    `      <text x="${textX}" y="${textY}" fill="#d7ffe2" font-size="15">${renderTspans(lines, textX)}</text>`,
    "    </g>",
  ].join("\n");
}

function renderEdge(
  edge: JsonCanvasEdge,
  nodeById: Map<string, JsonCanvasNode>,
): string {
  const fromNode = nodeById.get(edge.fromNode);
  const toNode = nodeById.get(edge.toNode);
  // Validation guarantees both nodes exist; retain this guard for defensive use
  // by callers compiled without runtime assertions.
  if (!fromNode || !toNode) {
    return "";
  }

  const sides = inferEdgeSides(fromNode, toNode, edge.fromSide, edge.toSide);
  const from = getSidePoint(fromNode, sides.from);
  const to = getSidePoint(toNode, sides.to);
  const stroke = resolveColor(edge.color, "#5cff8d");
  const markerStart = edge.fromEnd === "arrow"
    ? ' marker-start="url(#canvas-arrow)"'
    : "";
  // JSON Canvas defaults the destination end to an arrow when it is omitted.
  const markerEnd = edge.toEnd !== "none"
    ? ' marker-end="url(#canvas-arrow)"'
    : "";
  const label = edge.label?.trim();
  const labelMarkup = label
    ? `\n      <text x="${formatNumber((from.x + to.x) / 2)}" y="${formatNumber((from.y + to.y) / 2 - 9)}" fill="#a8ffbf" font-size="13" text-anchor="middle">${escapeXml(label)}</text>`
    : "";

  return `    <g data-edge-id="${escapeAttribute(edge.id)}">\n      <line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${stroke}" stroke-width="2"${markerStart}${markerEnd}/>${labelMarkup}\n    </g>`;
}

function getSafeNodeLabel(node: JsonCanvasNode): string {
  if (node.type === "text") {
    return node.text;
  }

  if (node.type === "file") {
    return "File reference";
  }

  if (node.type === "link") {
    return "External link";
  }

  return node.label?.trim() || "Group";
}

function fitTextLines(text: string, width: number, height: number): string[] {
  const maxCharacters = Math.max(8, Math.floor((width - 32) / 9));
  const maxLines = Math.max(1, Math.floor((height - 28) / TEXT_LINE_HEIGHT));
  const sourceLines = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .split(/\r?\n/u);
  const wrapped: string[] = [];

  for (const sourceLine of sourceLines) {
    const words = sourceLine.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      wrapped.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const chunks = splitLongWord(word, maxCharacters);
      for (const chunk of chunks) {
        const candidate = line ? `${line} ${chunk}` : chunk;
        if (candidate.length <= maxCharacters) {
          line = candidate;
        } else {
          wrapped.push(line);
          line = chunk;
        }
      }
    }
    if (line) {
      wrapped.push(line);
    }
  }

  if (wrapped.length <= maxLines) {
    return wrapped;
  }

  const visible = wrapped.slice(0, maxLines);
  const finalIndex = visible.length - 1;
  visible[finalIndex] = `${visible[finalIndex].slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`;
  return visible;
}

function splitLongWord(word: string, limit: number): string[] {
  if (word.length <= limit) {
    return [word];
  }

  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += limit) {
    chunks.push(word.slice(index, index + limit));
  }
  return chunks;
}

function renderTspans(lines: string[], x: number): string {
  return lines.map((line, index) => {
    const dy = index === 0 ? 0 : TEXT_LINE_HEIGHT;
    return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
  }).join("");
}

function inferEdgeSides(
  fromNode: JsonCanvasNode,
  toNode: JsonCanvasNode,
  fromSide?: JsonCanvasSide,
  toSide?: JsonCanvasSide,
): { from: JsonCanvasSide; to: JsonCanvasSide } {
  if (fromSide && toSide) {
    return { from: fromSide, to: toSide };
  }

  const fromCenter = getCenter(fromNode);
  const toCenter = getCenter(toNode);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const inferredFrom: JsonCanvasSide = horizontal
    ? (dx >= 0 ? "right" : "left")
    : (dy >= 0 ? "bottom" : "top");
  const inferredTo = oppositeSide(inferredFrom);
  return {
    from: fromSide ?? oppositeSide(toSide ?? inferredTo),
    to: toSide ?? oppositeSide(fromSide ?? inferredFrom),
  };
}

function getCenter(node: JsonCanvasNode): { x: number; y: number } {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

function getSidePoint(
  node: JsonCanvasNode,
  side: JsonCanvasSide,
): { x: number; y: number } {
  const center = getCenter(node);
  switch (side) {
    case "top":
      return { x: center.x, y: node.y };
    case "right":
      return { x: node.x + node.width, y: center.y };
    case "bottom":
      return { x: center.x, y: node.y + node.height };
    case "left":
      return { x: node.x, y: center.y };
  }
}

function oppositeSide(side: JsonCanvasSide): JsonCanvasSide {
  switch (side) {
    case "top":
      return "bottom";
    case "right":
      return "left";
    case "bottom":
      return "top";
    case "left":
      return "right";
  }
}

function getCanvasBounds(nodes: JsonCanvasNode[], padding: number) {
  if (nodes.length === 0) {
    return {
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      translateX: 0,
      translateY: 0,
    };
  }

  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return {
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
    translateX: padding - minX,
    translateY: padding - minY,
  };
}

function assertSafeSvgGeometry(canvas: JsonCanvas): void {
  if (canvas.nodes.length > MAX_SVG_NODES) {
    throw new Error(`Canvas SVG supports at most ${MAX_SVG_NODES} nodes.`);
  }
  if (canvas.edges.length > MAX_SVG_EDGES) {
    throw new Error(`Canvas SVG supports at most ${MAX_SVG_EDGES} edges.`);
  }
  for (const node of canvas.nodes) {
    if (
      Math.abs(node.x) > MAX_ABSOLUTE_COORDINATE ||
      Math.abs(node.y) > MAX_ABSOLUTE_COORDINATE
    ) {
      throw new Error(
        `Canvas SVG node coordinates must stay within +/-${MAX_ABSOLUTE_COORDINATE}.`,
      );
    }
    if (
      node.width > MAX_NODE_DIMENSION ||
      node.height > MAX_NODE_DIMENSION
    ) {
      throw new Error(
        `Canvas SVG node dimensions must not exceed ${MAX_NODE_DIMENSION} pixels.`,
      );
    }
  }
}

function normalizePadding(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PADDING;
  }
  if (!Number.isFinite(value) || value < 0 || value > 500) {
    throw new Error("Canvas SVG padding must be a finite number from 0 to 500.");
  }
  return Math.round(value);
}

function resolveColor(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return PALETTE[value] ?? value;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/u, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value)
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
