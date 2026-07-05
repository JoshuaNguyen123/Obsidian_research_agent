export type JsonCanvasNodeType = "text" | "file" | "link" | "group";
export type JsonCanvasSide = "top" | "right" | "bottom" | "left";
export type JsonCanvasEnd = "none" | "arrow";

export interface JsonCanvas {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

export interface JsonCanvasBaseNode {
  id: string;
  type: JsonCanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  [key: string]: unknown;
}

export interface JsonCanvasTextNode extends JsonCanvasBaseNode {
  type: "text";
  text: string;
}

export interface JsonCanvasFileNode extends JsonCanvasBaseNode {
  type: "file";
  file: string;
  subpath?: string;
}

export interface JsonCanvasLinkNode extends JsonCanvasBaseNode {
  type: "link";
  url: string;
}

export interface JsonCanvasGroupNode extends JsonCanvasBaseNode {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
}

export type JsonCanvasNode =
  | JsonCanvasTextNode
  | JsonCanvasFileNode
  | JsonCanvasLinkNode
  | JsonCanvasGroupNode;

export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: JsonCanvasSide;
  fromEnd?: JsonCanvasEnd;
  toNode: string;
  toSide?: JsonCanvasSide;
  toEnd?: JsonCanvasEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface JsonCanvasValidationResult {
  ok: boolean;
  errors: string[];
  nodeCount: number;
  edgeCount: number;
}

const NODE_TYPES = new Set<JsonCanvasNodeType>(["text", "file", "link", "group"]);
const SIDES = new Set<JsonCanvasSide>(["top", "right", "bottom", "left"]);
const ENDS = new Set<JsonCanvasEnd>(["none", "arrow"]);
const GROUP_BACKGROUND_STYLES = new Set(["cover", "ratio", "repeat"]);

export function validateJsonCanvas(value: unknown): JsonCanvasValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ["Canvas must be a JSON object."],
      nodeCount: 0,
      edgeCount: 0,
    };
  }

  const nodes = value.nodes;
  const edges = value.edges;
  if (!Array.isArray(nodes)) {
    errors.push("Canvas top-level nodes must be an array.");
  }

  if (!Array.isArray(edges)) {
    errors.push("Canvas top-level edges must be an array.");
  }

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return {
      ok: false,
      errors,
      nodeCount: Array.isArray(nodes) ? nodes.length : 0,
      edgeCount: Array.isArray(edges) ? edges.length : 0,
    };
  }

  const allIds = new Map<string, string>();
  const nodeIds = new Set<string>();

  nodes.forEach((node, index) => {
    validateNode(node, index, errors, allIds, nodeIds);
  });

  edges.forEach((edge, index) => {
    validateEdge(edge, index, errors, allIds, nodeIds);
  });

  return {
    ok: errors.length === 0,
    errors,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

export function assertValidJsonCanvas(value: unknown): asserts value is JsonCanvas {
  const result = validateJsonCanvas(value);
  if (!result.ok) {
    throw new Error(`Invalid JSON Canvas: ${result.errors.join(" ")}`);
  }
}

export function parseJsonCanvas(text: string): JsonCanvas {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON Canvas JSON: ${getErrorMessage(error)}`);
  }

  assertValidJsonCanvas(parsed);
  return parsed;
}

export function stringifyJsonCanvas(canvas: JsonCanvas): string {
  assertValidJsonCanvas(canvas);
  return `${JSON.stringify(canvas, null, 2)}\n`;
}

function validateNode(
  value: unknown,
  index: number,
  errors: string[],
  allIds: Map<string, string>,
  nodeIds: Set<string>,
) {
  const label = `nodes[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  const id = validateString(value.id, `${label}.id`, errors);
  if (id) {
    registerId(id, label, errors, allIds);
    nodeIds.add(id);
  }

  const type = validateString(value.type, `${label}.type`, errors);
  if (type && !NODE_TYPES.has(type as JsonCanvasNodeType)) {
    errors.push(`${label}.type must be one of text, file, link, or group.`);
  }

  validateInteger(value.x, `${label}.x`, errors);
  validateInteger(value.y, `${label}.y`, errors);
  validatePositiveInteger(value.width, `${label}.width`, errors);
  validatePositiveInteger(value.height, `${label}.height`, errors);
  validateCanvasColor(value.color, `${label}.color`, errors);

  if (type === "text") {
    validateString(value.text, `${label}.text`, errors);
  }

  if (type === "file") {
    validateString(value.file, `${label}.file`, errors);
    if (value.subpath !== undefined) {
      const subpath = validateString(value.subpath, `${label}.subpath`, errors);
      if (subpath && !subpath.startsWith("#")) {
        errors.push(`${label}.subpath must start with #.`);
      }
    }
  }

  if (type === "link") {
    const url = validateString(value.url, `${label}.url`, errors);
    if (url) {
      validateHttpUrl(url, `${label}.url`, errors);
    }
  }

  if (type === "group") {
    validateOptionalString(value.label, `${label}.label`, errors);
    validateOptionalString(value.background, `${label}.background`, errors);
    if (
      value.backgroundStyle !== undefined &&
      (typeof value.backgroundStyle !== "string" ||
        !GROUP_BACKGROUND_STYLES.has(value.backgroundStyle))
    ) {
      errors.push(`${label}.backgroundStyle must be cover, ratio, or repeat.`);
    }
  }
}

function validateEdge(
  value: unknown,
  index: number,
  errors: string[],
  allIds: Map<string, string>,
  nodeIds: Set<string>,
) {
  const label = `edges[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }

  const id = validateString(value.id, `${label}.id`, errors);
  if (id) {
    registerId(id, label, errors, allIds);
  }

  const fromNode = validateString(value.fromNode, `${label}.fromNode`, errors);
  const toNode = validateString(value.toNode, `${label}.toNode`, errors);
  if (fromNode && !nodeIds.has(fromNode)) {
    errors.push(`${label}.fromNode references missing node: ${fromNode}.`);
  }

  if (toNode && !nodeIds.has(toNode)) {
    errors.push(`${label}.toNode references missing node: ${toNode}.`);
  }

  validateSide(value.fromSide, `${label}.fromSide`, errors);
  validateSide(value.toSide, `${label}.toSide`, errors);
  validateEnd(value.fromEnd, `${label}.fromEnd`, errors);
  validateEnd(value.toEnd, `${label}.toEnd`, errors);
  validateCanvasColor(value.color, `${label}.color`, errors);
  validateOptionalString(value.label, `${label}.label`, errors);
}

function validateString(
  value: unknown,
  label: string,
  errors: string[],
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty string.`);
    return null;
  }

  return value;
}

function validateOptionalString(
  value: unknown,
  label: string,
  errors: string[],
) {
  if (value !== undefined && typeof value !== "string") {
    errors.push(`${label} must be a string when provided.`);
  }
}

function validateInteger(value: unknown, label: string, errors: string[]) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${label} must be an integer.`);
  }
}

function validatePositiveInteger(
  value: unknown,
  label: string,
  errors: string[],
) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    errors.push(`${label} must be a positive integer.`);
  }
}

function validateSide(value: unknown, label: string, errors: string[]) {
  if (value !== undefined && (typeof value !== "string" || !SIDES.has(value as JsonCanvasSide))) {
    errors.push(`${label} must be top, right, bottom, or left when provided.`);
  }
}

function validateEnd(value: unknown, label: string, errors: string[]) {
  if (value !== undefined && (typeof value !== "string" || !ENDS.has(value as JsonCanvasEnd))) {
    errors.push(`${label} must be none or arrow when provided.`);
  }
}

function validateCanvasColor(value: unknown, label: string, errors: string[]) {
  if (value === undefined) {
    return;
  }

  if (typeof value !== "string") {
    errors.push(`${label} must be a string when provided.`);
    return;
  }

  if (/^[1-6]$/.test(value) || /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value)) {
    return;
  }

  errors.push(`${label} must be a preset color 1-6 or a hex color.`);
}

function validateHttpUrl(value: string, label: string, errors: string[]) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${label} must be a valid URL.`);
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push(`${label} must use http or https.`);
  }

  if (url.username || url.password) {
    errors.push(`${label} must not include credentials.`);
  }
}

function registerId(
  id: string,
  label: string,
  errors: string[],
  allIds: Map<string, string>,
) {
  const existing = allIds.get(id);
  if (existing) {
    errors.push(`${label}.id duplicates ${existing}.id: ${id}.`);
    return;
  }

  allIds.set(id, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
