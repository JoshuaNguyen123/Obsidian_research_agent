export const MAX_SAFE_SVG_BYTES = 2_000_000;
export const MAX_SAFE_SVG_ELEMENTS = 5_000;
export const MAX_SAFE_SVG_DEPTH = 64;
export const MAX_SAFE_SVG_PATCH_OPERATIONS = 100;

const MAX_TEXT_CHARS = 20_000;
const MAX_ATTRIBUTE_CHARS = 20_000;
const MAX_ABSOLUTE_NUMBER = 1_000_000;

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "marker",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "tspan",
  "title",
  "desc",
  "use",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
]);

const CONTAINER_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "marker",
  "clippath",
  "lineargradient",
  "radialgradient",
]);

const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc"]);

const GLOBAL_ATTRIBUTES = new Set([
  "id",
  "class",
  "transform",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "fill-opacity",
  "opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "vector-effect",
]);

const ELEMENT_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  svg: new Set([
    "xmlns", "xmlns:xlink", "version", "width", "height", "viewbox",
    "preserveaspectratio", "role", "aria-label",
  ]),
  g: new Set(["role", "aria-label"]),
  defs: new Set(),
  marker: new Set([
    "viewbox", "refx", "refy", "markerwidth", "markerheight", "orient",
    "markerunits", "preserveaspectratio",
  ]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry"]),
  circle: new Set(["cx", "cy", "r"]),
  ellipse: new Set(["cx", "cy", "rx", "ry"]),
  line: new Set(["x1", "y1", "x2", "y2", "marker-start", "marker-mid", "marker-end"]),
  polyline: new Set(["points", "marker-start", "marker-mid", "marker-end"]),
  polygon: new Set(["points", "marker-start", "marker-mid", "marker-end"]),
  path: new Set(["d", "pathlength", "marker-start", "marker-mid", "marker-end"]),
  text: new Set([
    "x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
    "text-anchor", "dominant-baseline", "letter-spacing", "xml:space",
  ]),
  tspan: new Set([
    "x", "y", "dx", "dy", "font-family", "font-size", "font-weight",
    "text-anchor", "dominant-baseline", "letter-spacing", "xml:space",
  ]),
  title: new Set(),
  desc: new Set(),
  use: new Set(["href", "xlink:href", "x", "y", "width", "height"]),
  clippath: new Set(["clippathunits"]),
  lineargradient: new Set([
    "x1", "y1", "x2", "y2", "gradientunits", "gradienttransform", "spreadmethod",
  ]),
  radialgradient: new Set([
    "cx", "cy", "r", "fx", "fy", "fr", "gradientunits", "gradienttransform", "spreadmethod",
  ]),
  stop: new Set(["offset", "stop-color", "stop-opacity"]),
};

const NUMBER_ATTRIBUTES = new Set([
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "fx", "fy", "dx", "dy",
  "width", "height", "r", "rx", "ry", "fr", "refx", "refy", "markerwidth",
  "markerheight", "stroke-width", "stroke-opacity", "fill-opacity", "opacity",
  "font-size", "letter-spacing", "pathlength", "stop-opacity",
]);

const POSITIVE_ATTRIBUTES = new Set([
  "width", "height", "r", "markerwidth", "markerheight", "stroke-width", "font-size",
]);

const NON_NEGATIVE_ATTRIBUTES = new Set(["rx", "ry", "fr", "pathlength"]);
const COLOR_ATTRIBUTES = new Set(["fill", "stroke", "stop-color"]);
const LOCAL_REFERENCE_ATTRIBUTES = new Set(["marker-start", "marker-mid", "marker-end"]);

export type SvgQaIssueKind = "invalid_bounds" | "out_of_bounds" | "text_overflow";

export interface SvgQaIssue {
  id: string;
  kind: SvgQaIssueKind;
  severity: "error" | "warning";
  elementId: string | null;
  elementIndex: number;
  message: string;
  metrics?: Record<string, number>;
}

export interface SvgQaReport {
  ok: boolean;
  issues: SvgQaIssue[];
  canvasBounds: SvgBounds | null;
}

export interface SvgBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafeSvgElementSummary {
  tagName: string;
  id: string | null;
  depth: number;
  attributes: Record<string, string>;
}

export interface SafeSvgDocument {
  byteLength: number;
  elementCount: number;
  stableIds: string[];
  elements: SafeSvgElementSummary[];
  qa: SvgQaReport;
}

export type SvgPatchOperation =
  | {
      op: "update_text";
      id: string;
      text: string;
    }
  | {
      op: "update_attributes";
      id: string;
      attributes: Record<string, string | number | null>;
    }
  | {
      op: "remove_element";
      id: string;
    }
  | {
      op: "add_shape";
      parentId: string;
      shape: SafeSvgShape;
    };

export type SafeSvgShape =
  | SafeSvgRectShape
  | SafeSvgCircleShape
  | SafeSvgEllipseShape
  | SafeSvgLineShape
  | SafeSvgTextShape;

interface SafeSvgShapeBase {
  id: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export interface SafeSvgRectShape extends SafeSvgShapeBase {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
  ry?: number;
}

export interface SafeSvgCircleShape extends SafeSvgShapeBase {
  type: "circle";
  cx: number;
  cy: number;
  r: number;
}

export interface SafeSvgEllipseShape extends SafeSvgShapeBase {
  type: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface SafeSvgLineShape extends SafeSvgShapeBase {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SafeSvgTextShape extends SafeSvgShapeBase {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  anchor?: "start" | "middle" | "end";
}

export interface SvgPreservationMetadata {
  originalBytes: number;
  patchedBytes: number;
  operationCount: number;
  targetedIds: string[];
  addedIds: string[];
  removedIds: string[];
  retainedStableIds: string[];
  preservedStartTagIds: string[];
  stableIdOrderPreserved: boolean;
  unrelatedSourceSlicesPreserved: true;
}

export interface SvgPatchResult {
  content: string;
  document: SafeSvgDocument;
  preservation: SvgPreservationMetadata;
}

/** Strictly parses the untrusted model payload used by the SVG patch tool. */
export function parseSvgPatchOperations(value: unknown): SvgPatchOperation[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_SAFE_SVG_PATCH_OPERATIONS
  ) {
    throw new Error(
      `SVG patches require 1-${MAX_SAFE_SVG_PATCH_OPERATIONS} operations.`,
    );
  }
  return value.map((operation, index) =>
    normalizeOperation(operation as SvgPatchOperation, index),
  );
}

interface ParsedAttribute {
  name: string;
  normalizedName: string;
  value: string;
}

interface ParsedElement {
  tagName: string;
  normalizedTagName: string;
  id: string | null;
  attributes: ParsedAttribute[];
  depth: number;
  parentIndex: number | null;
  openStart: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  rawOpenTag: string;
}

interface ParsedDocumentInternal {
  source: string;
  byteLength: number;
  elements: ParsedElement[];
  rootIndex: number;
  idToIndex: Map<string, number>;
  qa: SvgQaReport;
}

/** Parses and validates the bounded safe SVG subset used by the patcher. */
export function parseSafeSvg(source: string): SafeSvgDocument {
  return publicDocument(parseSvgInternal(source));
}

/** Applies ID-scoped patches while preserving every untouched source slice. */
export function applySafeSvgPatch(
  source: string,
  operations: readonly SvgPatchOperation[],
): SvgPatchResult {
  if (!Array.isArray(operations) || operations.length > MAX_SAFE_SVG_PATCH_OPERATIONS) {
    throw new Error(`SVG patches accept at most ${MAX_SAFE_SVG_PATCH_OPERATIONS} operations.`);
  }
  const original = parseSvgInternal(source);
  const targetedIds = new Set<string>();
  const addedIds = new Set<string>();
  const removedIds = new Set<string>();
  let content = source;

  operations.forEach((rawOperation, index) => {
    const operation = normalizeOperation(rawOperation, index);
    const current = parseSvgInternal(content);
    switch (operation.op) {
      case "update_text": {
        const element = requireElementById(current, operation.id);
        if (!TEXT_ELEMENTS.has(element.normalizedTagName) || element.selfClosing) {
          throw new Error(`SVG element ${operation.id} does not support text replacement.`);
        }
        validateText(operation.text, "SVG replacement text");
        content = replaceRange(
          content,
          element.openEnd,
          element.closeStart,
          escapeXml(operation.text),
        );
        targetedIds.add(operation.id);
        break;
      }
      case "update_attributes": {
        const element = requireElementById(current, operation.id);
        content = replaceRange(
          content,
          element.openStart,
          element.openEnd,
          renderUpdatedOpenTag(element, operation.attributes),
        );
        targetedIds.add(operation.id);
        break;
      }
      case "remove_element": {
        const element = requireElementById(current, operation.id);
        if (current.rootIndex === current.idToIndex.get(operation.id)) {
          throw new Error("The SVG root element cannot be removed.");
        }
        content = replaceRange(content, element.openStart, element.end, "");
        targetedIds.add(operation.id);
        removedIds.add(operation.id);
        break;
      }
      case "add_shape": {
        const shapeMarkup = renderSafeShape(operation.shape);
        if (current.idToIndex.has(operation.shape.id)) {
          throw new Error(`SVG id already exists: ${operation.shape.id}.`);
        }
        const parent = requireElementById(current, operation.parentId);
        if (!CONTAINER_ELEMENTS.has(parent.normalizedTagName) || parent.selfClosing) {
          throw new Error("SVG shapes can only be added to a non-self-closing container.");
        }
        content = insertBeforeClosingTag(content, parent, shapeMarkup);
        targetedIds.add(operation.parentId);
        addedIds.add(operation.shape.id);
        break;
      }
    }
    // Every intermediate document must remain independently safe and parseable.
    parseSvgInternal(content);
  });

  const patched = parseSvgInternal(content);
  const originalIds = original.elements.flatMap((element) => element.id ? [element.id] : []);
  const patchedIds = patched.elements.flatMap((element) => element.id ? [element.id] : []);
  const retainedStableIds = originalIds.filter((id) => patched.idToIndex.has(id));
  const actualAddedIds = patchedIds.filter((id) => !original.idToIndex.has(id));
  const actualRemovedIds = originalIds.filter((id) => !patched.idToIndex.has(id));
  const originalOrderRetained = originalIds.filter((id) => patched.idToIndex.has(id));
  const patchedOriginalOrder = patchedIds.filter((id) => original.idToIndex.has(id));
  const preservedStartTagIds = retainedStableIds.filter((id) => {
    const before = original.elements[original.idToIndex.get(id)!];
    const after = patched.elements[patched.idToIndex.get(id)!];
    return before.rawOpenTag === after.rawOpenTag;
  });

  return {
    content,
    document: publicDocument(patched),
    preservation: {
      originalBytes: original.byteLength,
      patchedBytes: patched.byteLength,
      operationCount: operations.length,
      targetedIds: [...targetedIds].sort(),
      addedIds: [...new Set([...addedIds, ...actualAddedIds])].sort(),
      removedIds: [...new Set([...removedIds, ...actualRemovedIds])].sort(),
      retainedStableIds,
      preservedStartTagIds,
      stableIdOrderPreserved:
        JSON.stringify(originalOrderRetained) === JSON.stringify(patchedOriginalOrder),
      unrelatedSourceSlicesPreserved: true,
    },
  };
}

function parseSvgInternal(source: string): ParsedDocumentInternal {
  const byteLength = validateBoundedUtf8(source);
  const elements: ParsedElement[] = [];
  const idToIndex = new Map<string, number>();
  const stack: number[] = [];
  let cursor = 0;
  let rootIndex = -1;
  let rootClosed = false;

  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening < 0) {
      validateTextFragment(source.slice(cursor), stack.length > 0);
      cursor = source.length;
      break;
    }
    validateTextFragment(source.slice(cursor, opening), stack.length > 0);

    if (source.startsWith("<!--", opening)) {
      const end = source.indexOf("-->", opening + 4);
      if (end < 0) throw new Error("SVG comment is not closed.");
      const comment = source.slice(opening + 4, end);
      if (comment.includes("--")) throw new Error("SVG comments cannot contain --.");
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", opening)) {
      const end = source.indexOf("?>", opening + 2);
      if (end < 0) throw new Error("SVG processing instruction is not closed.");
      const instruction = source.slice(opening, end + 2);
      if (
        rootIndex >= 0 ||
        !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>$/u.test(instruction)
      ) {
        throw new Error("Only a bounded XML declaration is allowed before the SVG root.");
      }
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", opening)) {
      throw new Error("SVG DOCTYPE, entities, CDATA, and declarations are not allowed.");
    }

    const tagEnd = findTagEnd(source, opening);
    const rawTag = source.slice(opening, tagEnd);
    if (/^<\//u.test(rawTag)) {
      const closing = /^<\/\s*([A-Za-z][A-Za-z0-9_-]*)\s*>$/u.exec(rawTag);
      if (!closing || stack.length === 0) throw new Error("SVG closing tag is invalid.");
      const currentIndex = stack.pop()!;
      const current = elements[currentIndex];
      if (current.normalizedTagName !== closing[1].toLowerCase()) {
        throw new Error(`SVG closing tag ${closing[1]} does not match ${current.tagName}.`);
      }
      current.closeStart = opening;
      current.end = tagEnd;
      if (stack.length === 0) rootClosed = true;
      cursor = tagEnd;
      continue;
    }

    const parsedOpen = parseOpenTag(rawTag);
    if (!ALLOWED_ELEMENTS.has(parsedOpen.normalizedTagName)) {
      if (parsedOpen.normalizedTagName === "script" || parsedOpen.normalizedTagName === "foreignobject") {
        throw new Error(`Unsafe SVG element is not allowed: ${parsedOpen.tagName}.`);
      }
      if (parsedOpen.normalizedTagName === "image" || parsedOpen.normalizedTagName === "style") {
        throw new Error(`External or CSS-bearing SVG element is not allowed: ${parsedOpen.tagName}.`);
      }
      throw new Error(`Unsupported SVG element: ${parsedOpen.tagName}.`);
    }
    if (stack.length >= MAX_SAFE_SVG_DEPTH) {
      throw new Error(`SVG nesting exceeds ${MAX_SAFE_SVG_DEPTH} levels.`);
    }
    if (stack.length === 0) {
      if (rootIndex >= 0 || rootClosed) throw new Error("SVG must contain exactly one root element.");
      if (parsedOpen.normalizedTagName !== "svg") throw new Error("SVG root element must be <svg>.");
    }
    const id = validateElementAttributes(parsedOpen.normalizedTagName, parsedOpen.attributes);
    const index = elements.length;
    if (index >= MAX_SAFE_SVG_ELEMENTS) {
      throw new Error(`SVG exceeds ${MAX_SAFE_SVG_ELEMENTS} elements.`);
    }
    if (id) {
      if (idToIndex.has(id)) throw new Error(`SVG id is duplicated: ${id}.`);
      idToIndex.set(id, index);
    }
    const element: ParsedElement = {
      tagName: parsedOpen.tagName,
      normalizedTagName: parsedOpen.normalizedTagName,
      id,
      attributes: parsedOpen.attributes,
      depth: stack.length,
      parentIndex: stack.length > 0 ? stack[stack.length - 1] : null,
      openStart: opening,
      openEnd: tagEnd,
      closeStart: tagEnd,
      end: tagEnd,
      selfClosing: parsedOpen.selfClosing,
      rawOpenTag: rawTag,
    };
    elements.push(element);
    if (rootIndex < 0) rootIndex = index;
    if (parsedOpen.selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(index);
    }
    cursor = tagEnd;
  }

  if (rootIndex < 0 || stack.length > 0 || !rootClosed) {
    throw new Error("SVG root is missing or contains unclosed elements.");
  }
  const document: ParsedDocumentInternal = {
    source,
    byteLength,
    elements,
    rootIndex,
    idToIndex,
    qa: { ok: true, issues: [], canvasBounds: null },
  };
  document.qa = inspectSvgQa(document);
  return document;
}

function parseOpenTag(rawTag: string): {
  tagName: string;
  normalizedTagName: string;
  attributes: ParsedAttribute[];
  selfClosing: boolean;
} {
  const selfClosing = /\/\s*>$/u.test(rawTag);
  const body = rawTag.slice(1, rawTag.length - (selfClosing ? 2 : 1)).trim();
  const nameMatch = /^([A-Za-z][A-Za-z0-9_-]*)/u.exec(body);
  if (!nameMatch) throw new Error("SVG opening tag name is invalid.");
  const tagName = nameMatch[1];
  const attributes = parseAttributes(body.slice(nameMatch[0].length));
  return { tagName, normalizedTagName: tagName.toLowerCase(), attributes, selfClosing };
}

function parseAttributes(source: string): ParsedAttribute[] {
  const attributes: ParsedAttribute[] = [];
  const names = new Set<string>();
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    const nameMatch = /^([A-Za-z_:][A-Za-z0-9_.:-]*)/u.exec(source.slice(cursor));
    if (!nameMatch) throw new Error("SVG attribute name is invalid.");
    const name = nameMatch[1];
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error(`SVG attribute is duplicated: ${name}.`);
    names.add(normalizedName);
    cursor += nameMatch[0].length;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") throw new Error(`SVG attribute ${name} requires a quoted value.`);
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") throw new Error(`SVG attribute ${name} must be quoted.`);
    const valueStart = cursor + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) throw new Error(`SVG attribute ${name} is not closed.`);
    const value = decodeXmlEntities(source.slice(valueStart, valueEnd));
    if (value.length > MAX_ATTRIBUTE_CHARS) throw new Error(`SVG attribute ${name} is too large.`);
    attributes.push({ name, normalizedName, value });
    cursor = valueEnd + 1;
  }
  return attributes;
}

function validateElementAttributes(tagName: string, attributes: ParsedAttribute[]): string | null {
  let id: string | null = null;
  for (const attribute of attributes) {
    const name = attribute.normalizedName;
    if (/^on[a-z]/u.test(name)) throw new Error(`SVG event handler is not allowed: ${attribute.name}.`);
    const allowed = GLOBAL_ATTRIBUTES.has(name) || ELEMENT_ATTRIBUTES[tagName]?.has(name) || /^data-[a-z0-9_-]+$/u.test(name);
    if (!allowed) throw new Error(`SVG attribute ${attribute.name} is not allowed on <${tagName}>.`);
    validateAttributeValue(tagName, name, attribute.value);
    if (name === "id") {
      id = requireStableId(attribute.value, "SVG element id");
    }
  }
  return id;
}

function validateAttributeValue(tagName: string, name: string, value: string): void {
  validateAttributeText(value, `SVG attribute ${name}`);
  if (name === "xmlns") {
    if (tagName !== "svg" || value !== "http://www.w3.org/2000/svg") {
      throw new Error("SVG xmlns must use the standard SVG namespace on the root.");
    }
    return;
  }
  if (name === "xmlns:xlink") {
    if (tagName !== "svg" || value !== "http://www.w3.org/1999/xlink") {
      throw new Error("SVG xlink namespace is invalid.");
    }
    return;
  }
  if (name === "href" || name === "xlink:href") {
    if (tagName !== "use" || !/^#[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value)) {
      throw new Error("SVG href values must be local fragment references on <use>.");
    }
    return;
  }
  if (LOCAL_REFERENCE_ATTRIBUTES.has(name)) {
    if (value !== "none" && !/^url\(#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\)$/u.test(value)) {
      throw new Error(`SVG ${name} must be a local marker reference.`);
    }
    return;
  }
  if (/url\s*\(/iu.test(value)) throw new Error("SVG CSS url() values are not allowed.");
  if (COLOR_ATTRIBUTES.has(name)) {
    validateColor(value, `SVG ${name}`);
    return;
  }
  if (NUMBER_ATTRIBUTES.has(name)) {
    const numeric = parseSvgNumber(value, name === "width" || name === "height");
    if (POSITIVE_ATTRIBUTES.has(name) && numeric <= 0) {
      throw new Error(`SVG ${name} must be positive.`);
    }
    if (NON_NEGATIVE_ATTRIBUTES.has(name) && numeric < 0) {
      throw new Error(`SVG ${name} must be non-negative.`);
    }
    if (["opacity", "fill-opacity", "stroke-opacity", "stop-opacity"].includes(name) && (numeric < 0 || numeric > 1)) {
      throw new Error(`SVG ${name} must be between 0 and 1.`);
    }
    return;
  }
  if (name === "viewbox") {
    const values = parseNumberList(value, 4, "SVG viewBox");
    if (values[2] <= 0 || values[3] <= 0) throw new Error("SVG viewBox dimensions must be positive.");
    return;
  }
  if (name === "points") {
    const values = parseNumberList(value, null, "SVG points");
    if (values.length < 4 || values.length % 2 !== 0) throw new Error("SVG points require coordinate pairs.");
    return;
  }
  if (name === "d") {
    if (!value.trim() || !/^[MmZzLlHhVvCcSsQqTtAaEe0-9+.,\s-]+$/u.test(value)) {
      throw new Error("SVG path data contains unsupported commands or characters.");
    }
    return;
  }
  if (name === "transform" || name === "gradienttransform") {
    if (!/^(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+.,\s-]+\)(?:\s+(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+.,\s-]+\))*$/u.test(value)) {
      throw new Error(`SVG ${name} is invalid.`);
    }
    return;
  }
  if (name === "offset") {
    const normalized = value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
      throw new Error("SVG gradient stop offset must be between 0 and 1.");
    }
    return;
  }
  validateEnumeratedAttribute(name, value);
}

function validateEnumeratedAttribute(name: string, value: string): void {
  const enums: Record<string, readonly string[]> = {
    role: ["img", "presentation"],
    "text-anchor": ["start", "middle", "end"],
    "dominant-baseline": ["auto", "middle", "central", "hanging", "text-before-edge", "text-after-edge"],
    "stroke-linecap": ["butt", "round", "square"],
    "stroke-linejoin": ["miter", "round", "bevel"],
    "vector-effect": ["none", "non-scaling-stroke"],
    "xml:space": ["default", "preserve"],
    markerunits: ["strokeWidth", "userSpaceOnUse"],
    gradientunits: ["objectBoundingBox", "userSpaceOnUse"],
    clippathunits: ["objectBoundingBox", "userSpaceOnUse"],
    spreadmethod: ["pad", "reflect", "repeat"],
  };
  const allowed = enums[name];
  if (allowed && !allowed.includes(value)) throw new Error(`SVG ${name} value is invalid.`);
  if (name === "orient" && !["auto", "auto-start-reverse"].includes(value)) {
    parseSvgNumber(value, false);
  }
  if (name === "font-family" && !/^[A-Za-z0-9 ,._-]+$/u.test(value)) {
    throw new Error("SVG font-family contains unsupported characters.");
  }
  if (name === "font-weight" && !/^(?:normal|bold|bolder|lighter|[1-9]00)$/u.test(value)) {
    throw new Error("SVG font-weight is invalid.");
  }
  if (name === "stroke-dasharray" && value !== "none") {
    const values = parseNumberList(value, null, "SVG stroke-dasharray");
    if (values.some((entry) => entry < 0)) throw new Error("SVG stroke-dasharray cannot be negative.");
  }
}

function inspectSvgQa(document: ParsedDocumentInternal): SvgQaReport {
  const root = document.elements[document.rootIndex];
  const canvasBounds = rootCanvasBounds(root);
  const issues: SvgQaIssue[] = [];
  if (!canvasBounds) {
    issues.push(qaIssue("invalid_bounds", "error", root, document.rootIndex, "SVG root requires positive width/height or a valid viewBox."));
  }
  document.elements.forEach((element, index) => {
    if (index === document.rootIndex) return;
    const shapeBounds = elementBounds(element);
    if (shapeBounds === "invalid") {
      issues.push(qaIssue("invalid_bounds", "error", element, index, `SVG <${element.tagName}> has incomplete or invalid bounds.`));
      return;
    }
    if (shapeBounds && canvasBounds && !containsBounds(canvasBounds, shapeBounds)) {
      issues.push(qaIssue(
        "out_of_bounds",
        "warning",
        element,
        index,
        `SVG <${element.tagName}> extends outside the root bounds.`,
        { x: shapeBounds.x, y: shapeBounds.y, width: shapeBounds.width, height: shapeBounds.height },
      ));
    }
    if (element.normalizedTagName === "text" && canvasBounds) {
      const overflow = estimateTextOverflow(document, element, canvasBounds);
      if (overflow) {
        issues.push(qaIssue(
          "text_overflow",
          "warning",
          element,
          index,
          `SVG text is estimated to extend outside the root bounds.`,
          overflow,
        ));
      }
    }
  });
  issues.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return { ok: issues.length === 0, issues, canvasBounds };
}

function rootCanvasBounds(root: ParsedElement): SvgBounds | null {
  const attributes = attributeMap(root);
  const viewBox = attributes.get("viewbox");
  if (viewBox) {
    const values = parseNumberList(viewBox, 4, "SVG viewBox");
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }
  const width = optionalNumber(attributes.get("width"));
  const height = optionalNumber(attributes.get("height"));
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return { x: 0, y: 0, width, height };
}

function elementBounds(element: ParsedElement): SvgBounds | "invalid" | null {
  const attributes = attributeMap(element);
  const number = (name: string, fallback?: number): number | null => {
    const value = optionalNumber(attributes.get(name));
    return value === null ? fallback ?? null : value;
  };
  switch (element.normalizedTagName) {
    case "rect": {
      const x = number("x", 0)!;
      const y = number("y", 0)!;
      const width = number("width");
      const height = number("height");
      return width !== null && height !== null && width > 0 && height > 0
        ? { x, y, width, height }
        : "invalid";
    }
    case "circle": {
      const cx = number("cx", 0)!;
      const cy = number("cy", 0)!;
      const radius = number("r");
      return radius !== null && radius > 0
        ? { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 }
        : "invalid";
    }
    case "ellipse": {
      const cx = number("cx", 0)!;
      const cy = number("cy", 0)!;
      const rx = number("rx");
      const ry = number("ry");
      return rx !== null && ry !== null && rx > 0 && ry > 0
        ? { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }
        : "invalid";
    }
    case "line": {
      const x1 = number("x1", 0)!;
      const y1 = number("y1", 0)!;
      const x2 = number("x2", 0)!;
      const y2 = number("y2", 0)!;
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    }
    case "polyline":
    case "polygon": {
      const points = attributes.get("points");
      if (!points) return "invalid";
      const values = parseNumberList(points, null, "SVG points");
      const xs = values.filter((_value, index) => index % 2 === 0);
      const ys = values.filter((_value, index) => index % 2 === 1);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    default:
      return null;
  }
}

function estimateTextOverflow(
  document: ParsedDocumentInternal,
  element: ParsedElement,
  canvas: SvgBounds,
): Record<string, number> | null {
  if (element.selfClosing) return null;
  const attributes = attributeMap(element);
  const x = optionalNumber(attributes.get("x")) ?? 0;
  const y = optionalNumber(attributes.get("y")) ?? 0;
  const fontSize = optionalNumber(attributes.get("font-size")) ?? 16;
  const text = extractElementText(document.source, element);
  if (!text) return null;
  const lines = text.split(/\r?\n/u);
  const estimatedWidth = Math.max(...lines.map((line) => line.length * fontSize * 0.6));
  const estimatedHeight = Math.max(1, lines.length) * fontSize * 1.2;
  const anchor = attributes.get("text-anchor") ?? "start";
  const left = anchor === "middle" ? x - estimatedWidth / 2 : anchor === "end" ? x - estimatedWidth : x;
  const top = y - fontSize;
  const estimated = { x: left, y: top, width: estimatedWidth, height: estimatedHeight };
  return containsBounds(canvas, estimated)
    ? null
    : { estimatedWidth, estimatedHeight, x: left, y: top };
}

function renderUpdatedOpenTag(
  element: ParsedElement,
  updates: Record<string, string | number | null>,
): string {
  assertPlainRecord(updates, "SVG attribute updates");
  const updateEntries = Object.entries(updates).sort(([left], [right]) => left.localeCompare(right));
  const updateMap = new Map<string, { originalName: string; value: string | null }>();
  for (const [name, rawValue] of updateEntries) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === "id" || normalizedName === "xmlns" || normalizedName === "xmlns:xlink") {
      throw new Error(`SVG stable identity/namespace attribute cannot be changed: ${name}.`);
    }
    if (rawValue !== null && typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw new Error(`SVG attribute ${name} must be a string, number, or null.`);
    }
    const value = rawValue === null ? null : typeof rawValue === "number" ? formatNumber(rawValue) : rawValue;
    if (value !== null) {
      validateElementAttributes(element.normalizedTagName, [{ name, normalizedName, value }]);
    } else if (!GLOBAL_ATTRIBUTES.has(normalizedName) && !ELEMENT_ATTRIBUTES[element.normalizedTagName]?.has(normalizedName)) {
      throw new Error(`SVG attribute ${name} is not allowed on <${element.tagName}>.`);
    }
    updateMap.set(normalizedName, { originalName: name, value });
  }
  const rendered: ParsedAttribute[] = [];
  for (const attribute of element.attributes) {
    const update = updateMap.get(attribute.normalizedName);
    if (!update) rendered.push(attribute);
    else {
      updateMap.delete(attribute.normalizedName);
      if (update.value !== null) rendered.push({ ...attribute, value: update.value });
    }
  }
  for (const [normalizedName, update] of [...updateMap.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (update.value !== null) rendered.push({ name: update.originalName, normalizedName, value: update.value });
  }
  const attributes = rendered.map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`).join("");
  return `<${element.tagName}${attributes}${element.selfClosing ? "/" : ""}>`;
}

function renderSafeShape(rawShape: SafeSvgShape): string {
  const shape = normalizeShape(rawShape);
  const attributes: Array<[string, string | number | undefined]> = [["id", shape.id]];
  switch (shape.type) {
    case "rect":
      attributes.push(["x", shape.x], ["y", shape.y], ["width", shape.width], ["height", shape.height], ["rx", shape.rx], ["ry", shape.ry]);
      break;
    case "circle":
      attributes.push(["cx", shape.cx], ["cy", shape.cy], ["r", shape.r]);
      break;
    case "ellipse":
      attributes.push(["cx", shape.cx], ["cy", shape.cy], ["rx", shape.rx], ["ry", shape.ry]);
      break;
    case "line":
      attributes.push(["x1", shape.x1], ["y1", shape.y1], ["x2", shape.x2], ["y2", shape.y2]);
      break;
    case "text":
      attributes.push(["x", shape.x], ["y", shape.y], ["font-size", shape.fontSize], ["text-anchor", shape.anchor]);
      break;
  }
  attributes.push(["fill", shape.fill], ["stroke", shape.stroke], ["stroke-width", shape.strokeWidth], ["opacity", shape.opacity]);
  const renderedAttributes = attributes
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttribute(typeof value === "number" ? formatNumber(value) : value)}"`)
    .join("");
  return shape.type === "text"
    ? `<text${renderedAttributes}>${escapeXml(shape.text)}</text>`
    : `<${shape.type}${renderedAttributes}/>`;
}

function normalizeShape(rawShape: SafeSvgShape): SafeSvgShape {
  assertPlainRecord(rawShape, "SVG shape");
  const type = rawShape.type;
  if (!["rect", "circle", "ellipse", "line", "text"].includes(type)) {
    throw new Error("SVG add_shape supports rect, circle, ellipse, line, or text.");
  }
  requireStableId(rawShape.id, "SVG shape id");
  const commonKeys = ["type", "id", "fill", "stroke", "strokeWidth", "opacity"];
  const keysByType: Record<string, string[]> = {
    rect: [...commonKeys, "x", "y", "width", "height", "rx", "ry"],
    circle: [...commonKeys, "cx", "cy", "r"],
    ellipse: [...commonKeys, "cx", "cy", "rx", "ry"],
    line: [...commonKeys, "x1", "y1", "x2", "y2"],
    text: [...commonKeys, "x", "y", "text", "fontSize", "anchor"],
  };
  assertOnlyKeys(rawShape, keysByType[type], "SVG shape");
  const attributes: ParsedAttribute[] = [];
  const add = (name: string, value: unknown, required = false) => {
    if (value === undefined && !required) return;
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`SVG shape ${name} is invalid.`);
    attributes.push({ name, normalizedName: name.toLowerCase(), value: typeof value === "number" ? formatNumber(value) : value });
  };
  add("id", rawShape.id, true);
  add("fill", rawShape.fill);
  add("stroke", rawShape.stroke);
  add("stroke-width", rawShape.strokeWidth);
  add("opacity", rawShape.opacity);
  switch (type) {
    case "rect":
      add("x", rawShape.x, true); add("y", rawShape.y, true); add("width", rawShape.width, true); add("height", rawShape.height, true); add("rx", rawShape.rx); add("ry", rawShape.ry);
      break;
    case "circle":
      add("cx", rawShape.cx, true); add("cy", rawShape.cy, true); add("r", rawShape.r, true);
      break;
    case "ellipse":
      add("cx", rawShape.cx, true); add("cy", rawShape.cy, true); add("rx", rawShape.rx, true); add("ry", rawShape.ry, true);
      break;
    case "line":
      add("x1", rawShape.x1, true); add("y1", rawShape.y1, true); add("x2", rawShape.x2, true); add("y2", rawShape.y2, true);
      break;
    case "text":
      add("x", rawShape.x, true); add("y", rawShape.y, true); add("font-size", rawShape.fontSize); add("text-anchor", rawShape.anchor);
      validateText(rawShape.text, "SVG shape text");
      break;
  }
  validateElementAttributes(type, attributes);
  return { ...rawShape };
}

function normalizeOperation(operation: SvgPatchOperation, index: number): SvgPatchOperation {
  assertPlainRecord(operation, `SVG patch operation ${index + 1}`);
  switch (operation.op) {
    case "update_text":
      assertOnlyKeys(operation, ["op", "id", "text"], "SVG update_text operation");
      requireStableId(operation.id, "SVG target id");
      validateText(operation.text, "SVG replacement text");
      return operation;
    case "update_attributes":
      assertOnlyKeys(operation, ["op", "id", "attributes"], "SVG update_attributes operation");
      requireStableId(operation.id, "SVG target id");
      assertPlainRecord(operation.attributes, "SVG attribute updates");
      return operation;
    case "remove_element":
      assertOnlyKeys(operation, ["op", "id"], "SVG remove_element operation");
      requireStableId(operation.id, "SVG target id");
      return operation;
    case "add_shape":
      assertOnlyKeys(operation, ["op", "parentId", "shape"], "SVG add_shape operation");
      requireStableId(operation.parentId, "SVG parent id");
      normalizeShape(operation.shape);
      return operation;
    default:
      throw new Error(`Unsupported SVG patch operation at index ${index}.`);
  }
}

function insertBeforeClosingTag(source: string, parent: ParsedElement, markup: string): string {
  const beforeClose = source.slice(parent.openEnd, parent.closeStart);
  const lineEnding = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingWhitespace = /(?:\r?\n)?[ \t]*$/u.exec(beforeClose)?.[0] ?? "";
  const insertionStart = parent.closeStart - trailingWhitespace.length;
  const parentIndent = "  ".repeat(parent.depth);
  const childIndent = "  ".repeat(parent.depth + 1);
  const insertion = `${lineEnding}${childIndent}${markup}${lineEnding}${parentIndent}`;
  return replaceRange(source, insertionStart, parent.closeStart, insertion);
}

function requireElementById(document: ParsedDocumentInternal, id: string): ParsedElement {
  requireStableId(id, "SVG target id");
  const index = document.idToIndex.get(id);
  if (index === undefined) throw new Error(`SVG element id was not found: ${id}.`);
  return document.elements[index];
}

function publicDocument(document: ParsedDocumentInternal): SafeSvgDocument {
  return {
    byteLength: document.byteLength,
    elementCount: document.elements.length,
    stableIds: document.elements.flatMap((element) => element.id ? [element.id] : []),
    elements: document.elements.map((element) => ({
      tagName: element.tagName,
      id: element.id,
      depth: element.depth,
      attributes: Object.fromEntries(element.attributes.map((attribute) => [attribute.name, attribute.value])),
    })),
    qa: {
      ...document.qa,
      issues: document.qa.issues.map((item) => ({ ...item, ...(item.metrics ? { metrics: { ...item.metrics } } : {}) })),
      canvasBounds: document.qa.canvasBounds ? { ...document.qa.canvasBounds } : null,
    },
  };
}

function qaIssue(
  kind: SvgQaIssueKind,
  severity: "error" | "warning",
  element: ParsedElement,
  elementIndex: number,
  message: string,
  metrics?: Record<string, number>,
): SvgQaIssue {
  const elementId = element.id;
  return {
    id: `svg-qa:${kind}:${elementId ?? `${element.normalizedTagName}-${elementIndex}`}`,
    kind,
    severity,
    elementId,
    elementIndex,
    message,
    ...(metrics ? { metrics: { ...metrics } } : {}),
  };
}

function attributeMap(element: ParsedElement): Map<string, string> {
  return new Map(element.attributes.map((attribute) => [attribute.normalizedName, attribute.value]));
}

function extractElementText(source: string, element: ParsedElement): string {
  const inner = source.slice(element.openEnd, element.closeStart)
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<[^>]+>/gu, "");
  return decodeXmlEntities(inner).replace(/\s+/gu, " ").trim();
}

function containsBounds(outer: SvgBounds, inner: SvgBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function optionalNumber(value: string | undefined): number | null {
  return value === undefined ? null : parseSvgNumber(value, true);
}

function parseSvgNumber(value: string, allowPx: boolean): number {
  const pattern = allowPx
    ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:px)?$/u
    : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
  if (!pattern.test(value.trim())) throw new Error(`SVG numeric value is invalid: ${value}.`);
  const numeric = Number(value.trim().replace(/px$/u, ""));
  if (!Number.isFinite(numeric) || Math.abs(numeric) > MAX_ABSOLUTE_NUMBER) {
    throw new Error("SVG numeric value exceeds the safe range.");
  }
  return numeric;
}

function parseNumberList(value: string, exactLength: number | null, label: string): number[] {
  const tokens = value.trim().split(/[\s,]+/u).filter(Boolean);
  if (exactLength !== null && tokens.length !== exactLength) throw new Error(`${label} requires ${exactLength} numbers.`);
  if (tokens.length === 0 || tokens.length > 10_000) throw new Error(`${label} contains an invalid number count.`);
  return tokens.map((token) => parseSvgNumber(token, false));
}

function validateColor(value: string, label: string): void {
  if (/url\s*\(|javascript\s*:|data\s*:/iu.test(value)) throw new Error(`${label} cannot reference URLs.`);
  if (
    !/^(?:none|transparent|currentColor|#[0-9a-fA-F]{3,8}|[A-Za-z]+|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\))$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
}

function validateText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_TEXT_CHARS) {
    throw new Error(`${label} must be a string of at most ${MAX_TEXT_CHARS} characters.`);
  }
  validateAttributeText(value, label);
  validateBoundedUtf8(value, MAX_TEXT_CHARS * 4);
}

function validateAttributeText(value: string, label: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
}

function validateTextFragment(value: string, insideRoot: boolean): void {
  if (!insideRoot && value.trim()) throw new Error("SVG cannot contain text outside its root element.");
  validateAttributeText(value, "SVG text");
  decodeXmlEntities(value);
}

function validateBoundedUtf8(value: unknown, maximumBytes = MAX_SAFE_SVG_BYTES): number {
  if (typeof value !== "string") throw new Error("SVG source must be a UTF-8 string.");
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > maximumBytes) throw new Error(`SVG exceeds ${maximumBytes} UTF-8 bytes.`);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  if (decoded !== value) throw new Error("SVG source contains invalid Unicode scalar values.");
  return encoded.byteLength;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&([^;]+);/gu, (_match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const hexadecimal = /^#x([0-9a-fA-F]+)$/u.exec(entity);
    const decimal = /^#([0-9]+)$/u.exec(entity);
    const codePoint = hexadecimal
      ? Number.parseInt(hexadecimal[1], 16)
      : decimal
        ? Number.parseInt(decimal[1], 10)
        : Number.NaN;
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error(`SVG contains an unsupported entity: &${entity};.`);
    }
    const character = String.fromCodePoint(codePoint);
    validateAttributeText(character, "SVG entity");
    return character;
  });
}

function findTagEnd(source: string, opening: number): number {
  let quote: string | null = null;
  for (let index = opening + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index + 1;
  }
  throw new Error("SVG tag is not closed.");
}

function requireStableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value)) {
    throw new Error(`${label} must be a stable XML id.`);
  }
  return value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_NUMBER) {
    throw new Error("SVG number exceeds the safe range.");
  }
  return String(Math.round(value * 1_000_000) / 1_000_000);
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function replaceRange(source: string, start: number, end: number, replacement: string): string {
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
}

function assertOnlyKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
}
