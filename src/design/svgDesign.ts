export type SvgWireframeShape =
  | SvgRectShape
  | SvgTextShape
  | SvgLineShape
  | SvgCircleShape;

export interface SvgWireframeInput {
  title?: string;
  width?: number;
  height?: number;
  shapes: SvgWireframeShape[];
}

export interface SvgBaseShape {
  id?: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
}

export interface SvgRectShape extends SvgBaseShape {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
  label?: string;
}

export interface SvgTextShape extends SvgBaseShape {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  anchor?: "start" | "middle" | "end";
}

export interface SvgLineShape extends SvgBaseShape {
  type: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}

export interface SvgCircleShape extends SvgBaseShape {
  type: "circle";
  cx: number;
  cy: number;
  r: number;
  label?: string;
}

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;
const DEFAULT_STROKE = "#5cff8d";
const DEFAULT_FILL = "#061007";

export function renderSvgWireframe(input: SvgWireframeInput): string {
  const width = getPositiveNumber(input.width, DEFAULT_WIDTH, "width");
  const height = getPositiveNumber(input.height, DEFAULT_HEIGHT, "height");
  const title = input.title?.trim() || "Design wireframe";
  const hasArrows = input.shapes.some((shape) => shape.type === "arrow");
  const body = input.shapes.map(renderShape).join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(title)}">`,
    `  <title>${escapeXml(title)}</title>`,
    hasArrows ? renderArrowMarker() : "",
    `  <rect x="0" y="0" width="${width}" height="${height}" fill="#020403"/>`,
    body,
    "</svg>",
    "",
  ].filter((line) => line !== "").join("\n");
}

export function countSvgShapes(svg: string): number {
  const matches = [...svg.matchAll(/<(rect|circle|ellipse|line|polyline|polygon|path|text)\b([^>]*)>/gi)];
  return matches.filter((match) => {
    const tagName = match[1].toLowerCase();
    const attributes = match[2];
    return tagName !== "rect" || !/\bx="0"\s+\by="0"/.test(attributes);
  }).length;
}

function renderShape(shape: SvgWireframeShape): string {
  switch (shape.type) {
    case "rect":
      return renderRect(shape);
    case "text":
      return renderText(shape);
    case "line":
    case "arrow":
      return renderLine(shape);
    case "circle":
      return renderCircle(shape);
  }
}

function renderRect(shape: SvgRectShape): string {
  const stroke = sanitizeColor(shape.stroke, DEFAULT_STROKE);
  const fill = sanitizeColor(shape.fill, DEFAULT_FILL);
  const label = shape.label
    ? `\n  ${renderText({
        type: "text",
        x: shape.x + 14,
        y: shape.y + 28,
        text: shape.label,
        fontSize: 16,
      })}`
    : "";

  return `  <rect${renderId(shape.id)} x="${shape.x}" y="${shape.y}" width="${getPositiveNumber(shape.width, 1, "shape.width")}" height="${getPositiveNumber(shape.height, 1, "shape.height")}" rx="${Math.max(0, shape.rx ?? 4)}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(stroke)}" stroke-width="${Math.max(1, shape.strokeWidth ?? 1)}"/>${label}`;
}

function renderText(shape: SvgTextShape): string {
  const fill = sanitizeColor(shape.fill, "#a8ffbf");
  const lines = shape.text.split(/\r?\n/);
  const tspans = lines.map((line, index) => {
    const dy = index === 0 ? 0 : Math.ceil((shape.fontSize ?? 16) * 1.25);
    return `<tspan x="${shape.x}" dy="${dy}">${escapeXml(line)}</tspan>`;
  }).join("");

  return `  <text${renderId(shape.id)} x="${shape.x}" y="${shape.y}" fill="${escapeAttribute(fill)}" font-family="Cascadia Mono, Lucida Console, monospace" font-size="${Math.max(8, shape.fontSize ?? 16)}" text-anchor="${shape.anchor ?? "start"}">${tspans}</text>`;
}

function renderLine(shape: SvgLineShape): string {
  const stroke = sanitizeColor(shape.stroke, DEFAULT_STROKE);
  const marker = shape.type === "arrow" ? ' marker-end="url(#agentic-arrow)"' : "";
  const label = shape.label
    ? `\n  ${renderText({
        type: "text",
        x: (shape.x1 + shape.x2) / 2,
        y: (shape.y1 + shape.y2) / 2 - 8,
        text: shape.label,
        fontSize: 13,
        anchor: "middle",
      })}`
    : "";

  return `  <line${renderId(shape.id)} x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" stroke="${escapeAttribute(stroke)}" stroke-width="${Math.max(1, shape.strokeWidth ?? 2)}"${marker}/>${label}`;
}

function renderCircle(shape: SvgCircleShape): string {
  const stroke = sanitizeColor(shape.stroke, DEFAULT_STROKE);
  const fill = sanitizeColor(shape.fill, DEFAULT_FILL);
  const label = shape.label
    ? `\n  ${renderText({
        type: "text",
        x: shape.cx,
        y: shape.cy + 5,
        text: shape.label,
        fontSize: 14,
        anchor: "middle",
      })}`
    : "";

  return `  <circle${renderId(shape.id)} cx="${shape.cx}" cy="${shape.cy}" r="${getPositiveNumber(shape.r, 1, "shape.r")}" fill="${escapeAttribute(fill)}" stroke="${escapeAttribute(stroke)}" stroke-width="${Math.max(1, shape.strokeWidth ?? 1)}"/>${label}`;
}

function renderArrowMarker(): string {
  return [
    "  <defs>",
    '    <marker id="agentic-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
    '      <path d="M 0 0 L 10 5 L 0 10 z" fill="#5cff8d"/>',
    "    </marker>",
    "  </defs>",
  ].join("\n");
}

function renderId(id: string | undefined): string {
  if (!id) {
    return "";
  }

  return ` id="${escapeAttribute(id)}"`;
}

function getPositiveNumber(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return candidate;
}

function sanitizeColor(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  if (/javascript:|url\s*\(/i.test(candidate)) {
    throw new Error("SVG color values cannot reference scripts or URLs.");
  }

  if (!/^[#a-zA-Z0-9(),.%\s-]+$/.test(candidate)) {
    throw new Error("SVG color values contain unsupported characters.");
  }

  return candidate;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replace(/"/g, "&quot;");
}
