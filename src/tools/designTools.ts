import type { TFile } from "obsidian";
import {
  verifyCanvasArtifact,
  verifySvgArtifact,
} from "../agent/verification";
import {
  buildLayoutCanvas,
  type CanvasConnectionMode,
  type CanvasLayoutConnection,
  type CanvasLayoutDiagramType,
  type CanvasLayoutDirection,
  type CanvasLayoutItem,
  type CanvasLayoutItemKind,
} from "../design/layout";
import {
  assertValidJsonCanvas,
  stringifyJsonCanvas,
  type JsonCanvas,
} from "../design/jsonCanvas";
import {
  renderSvgWireframe,
  type SvgWireframeShape,
} from "../design/svgDesign";
import { createDesignPackageTool } from "../agent/design/CreateDesignPackageTool";
import { hasReviseDesignIntent } from "../agent/codeDesignIntent";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  isRecord,
  normalizeVaultPath,
} from "./validation";

const DESIGN_INTENT_PATTERN =
  /\b(create|make|draw|generate|build|draft|render|save|write)\b[\s\S]{0,120}\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flow|architecture)\b|\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flow|architecture)\b[\s\S]{0,120}\b(create|make|draw|generate|build|draft|render|save|write)\b/i;

export function createDesignTools(): AgentTool[] {
  return [
    createDesignCanvasTool,
    updateDesignCanvasTool,
    createSvgDesignTool,
    createDesignPackageTool,
  ];
}

export const createDesignCanvasTool: AgentTool = {
  name: "create_design_canvas",
  description:
    "Create a new Obsidian JSON Canvas artifact for diagrams, user flows, or architecture maps.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .canvas path to create.",
      },
      title: {
        type: "string",
        description: "Optional title used when generating layout nodes.",
      },
      canvas: {
        type: "object",
        description: "Optional complete JSON Canvas object with nodes and edges arrays.",
      },
      nodes: {
        type: "array",
        items: { type: "object" },
        description: "Optional JSON Canvas nodes.",
      },
      edges: {
        type: "array",
        items: { type: "object" },
        description: "Optional JSON Canvas edges.",
      },
      items: {
        type: "array",
        items: { type: "object" },
        description: "Optional layout items with title/text/kind/lane/url/file/color.",
      },
      diagramType: {
        type: "string",
        enum: [
          "sequence",
          "user_flow",
          "ui_flow",
          "logistics_system",
          "service_blueprint",
          "project_ideation",
          "architecture",
          "mind_map",
        ],
        description: "Generated diagram style for layout items.",
      },
      direction: {
        type: "string",
        enum: ["row", "column", "grid"],
        description: "Generated layout direction.",
      },
      connect: {
        type: "string",
        enum: ["none", "sequence"],
        description: "Auto-connect layout items. Defaults to sequence.",
      },
      connections: {
        type: "array",
        items: { type: "object" },
        description: "Optional explicit edges with from/to ids, labels, colors, and sides.",
      },
      createFolders: {
        type: "boolean",
        description: "Create missing parent folders. Defaults to true.",
      },
      open: {
        type: "boolean",
        description: "Open the created file in Obsidian after writing.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertDesignIntent(context, "create_design_canvas");
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".canvas");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;
    const open = getOptionalBoolean(args, "open") ?? false;

    assertPathDoesNotExist(context, path);
    await ensureParentFolder(context, path, createFolders);

    reportProgress(context, `Planning canvas design for ${path}...`);
    const canvas = getCanvasFromArgs(args);
    const diagramType = getDiagramType(args.diagramType);
    const canvasSummary = summarizeCanvas(canvas, diagramType);
    reportProgress(context, canvasSummary);
    const content = stringifyJsonCanvas(canvas);
    const preflight = verifyCanvasArtifact(content);
    if (!preflight.ok) {
      throw new Error(`Canvas preflight verification failed: ${preflight.errors.join(" ")}`);
    }
    reportProgress(context, "Canvas structure validated; writing artifact...");

    const file = await context.app.vault.create(path, content);
    const readBack = await context.app.vault.read(file);
    const verification = verifyCanvasArtifact(readBack);
    if (!verification.ok) {
      throw new Error(`Canvas read-back verification failed: ${verification.errors.join(" ")}`);
    }

    const opened = open ? await openCreatedFile(context, file) : false;

    return {
      path,
      operation: "create",
      diagramType,
      bytesWritten: getByteLength(content),
      nodeCount: verification.nodeCount,
      edgeCount: verification.edgeCount,
      summary: canvasSummary,
      opened,
    };
  },
};

export const updateDesignCanvasTool: AgentTool = {
  name: "update_design_canvas",
  description:
    "Revise an existing Obsidian JSON Canvas artifact with backup, read-back verification, and a receipt. Requires explicit revise/update design intent.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .canvas path to update.",
      },
      title: {
        type: "string",
        description: "Optional title used when generating layout nodes.",
      },
      canvas: {
        type: "object",
        description: "Optional complete JSON Canvas object with nodes and edges arrays.",
      },
      nodes: {
        type: "array",
        items: { type: "object" },
        description: "Optional JSON Canvas nodes.",
      },
      edges: {
        type: "array",
        items: { type: "object" },
        description: "Optional JSON Canvas edges.",
      },
      items: {
        type: "array",
        items: { type: "object" },
        description: "Optional layout items with title/text/kind/lane/url/file/color.",
      },
      diagramType: {
        type: "string",
        enum: [
          "sequence",
          "user_flow",
          "ui_flow",
          "logistics_system",
          "service_blueprint",
          "project_ideation",
          "architecture",
          "mind_map",
        ],
      },
      direction: {
        type: "string",
        enum: ["row", "column", "grid"],
      },
      connect: {
        type: "string",
        enum: ["none", "sequence"],
      },
      connections: {
        type: "array",
        items: { type: "object" },
      },
      open: {
        type: "boolean",
        description: "Open the updated file in Obsidian after writing.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    if (!hasReviseDesignIntent(context.originalPrompt)) {
      throw new ToolExecutionError(
        "intent_required",
        "update_design_canvas requires explicit revise/update/edit design intent.",
      );
    }
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".canvas");
    const open = getOptionalBoolean(args, "open") ?? false;
    const file = context.app.vault.getFileByPath(path);
    if (!file) {
      throw new Error(`Canvas not found: ${path}`);
    }

    const previous = await context.app.vault.read(file);
    const backupPath = await backupDesignArtifact(context, path, previous);
    reportProgress(context, `Updating canvas design for ${path}...`);
    const canvas = getCanvasFromArgs(args);
    const diagramType = getDiagramType(args.diagramType);
    const canvasSummary = summarizeCanvas(canvas, diagramType);
    reportProgress(context, canvasSummary);
    const content = stringifyJsonCanvas(canvas);
    const preflight = verifyCanvasArtifact(content);
    if (!preflight.ok) {
      throw new Error(`Canvas preflight verification failed: ${preflight.errors.join(" ")}`);
    }

    await context.app.vault.modify(file, content);
    const readBack = await context.app.vault.read(file);
    const verification = verifyCanvasArtifact(readBack);
    if (!verification.ok) {
      throw new Error(`Canvas read-back verification failed: ${verification.errors.join(" ")}`);
    }

    const opened = open ? await openCreatedFile(context, file) : false;
    return {
      path,
      operation: "update",
      diagramType,
      bytesWritten: getByteLength(content),
      nodeCount: verification.nodeCount,
      edgeCount: verification.edgeCount,
      summary: canvasSummary,
      backupPath,
      opened,
      receipt: {
        operation: "update",
        path,
        backupPath,
        bytesWritten: getByteLength(content),
      },
    };
  },
};

export const createSvgDesignTool: AgentTool = {
  name: "create_svg_design",
  description:
    "Create a new escaped SVG diagram or wireframe from structured shape instructions.",
  parameters: {
    type: "object",
    required: ["path", "shapes"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .svg path to create.",
      },
      title: {
        type: "string",
        description: "SVG title and aria label.",
      },
      width: {
        type: "integer",
        description: "SVG viewport width.",
      },
      height: {
        type: "integer",
        description: "SVG viewport height.",
      },
      shapes: {
        type: "array",
        items: { type: "object" },
        description: "Structured shapes: rect, text, line, arrow, circle, ellipse, diamond, or cylinder.",
      },
      createFolders: {
        type: "boolean",
        description: "Create missing parent folders. Defaults to true.",
      },
      open: {
        type: "boolean",
        description: "Open the created file in Obsidian after writing.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertDesignIntent(context, "create_svg_design");
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".svg");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;
    const open = getOptionalBoolean(args, "open") ?? false;

    assertPathDoesNotExist(context, path);
    await ensureParentFolder(context, path, createFolders);

    reportProgress(context, `Planning SVG design for ${path}...`);
    const shapes = getShapes(args);
    const shapeTypes = [...new Set(shapes.map((shape) => shape.type))];
    reportProgress(
      context,
      `SVG design planned: ${shapes.length} shapes (${shapeTypes.join(", ")}).`,
    );
    const content = renderSvgWireframe({
      title: getOptionalString(args, "title"),
      width: getOptionalInteger(args, "width"),
      height: getOptionalInteger(args, "height"),
      shapes,
    });
    const preflight = verifySvgArtifact(content);
    if (!preflight.ok) {
      throw new Error(`SVG preflight verification failed: ${preflight.errors.join(" ")}`);
    }
    reportProgress(context, "SVG structure validated; writing artifact...");

    const file = await context.app.vault.create(path, content);
    const readBack = await context.app.vault.read(file);
    const verification = verifySvgArtifact(readBack);
    if (!verification.ok) {
      throw new Error(`SVG read-back verification failed: ${verification.errors.join(" ")}`);
    }

    const opened = open ? await openCreatedFile(context, file) : false;

    return {
      path,
      operation: "create",
      bytesWritten: getByteLength(content),
      shapeCount: shapes.length,
      shapeTypes,
      opened,
    };
  },
};

function assertDesignIntent(context: ToolExecutionContext, toolName: string) {
  if (!DESIGN_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new ToolExecutionError(
      "intent_required",
      `${toolName} requires explicit design, canvas, diagram, wireframe, layout, or SVG creation intent.`,
    );
  }
}

function reportProgress(context: ToolExecutionContext, message: string) {
  context.reportProgress?.(message);
}

function summarizeCanvas(
  canvas: JsonCanvas,
  diagramType: CanvasLayoutDiagramType,
): string {
  const lanes = canvas.nodes
    .filter((node) => node.type === "group" && typeof node.label === "string")
    .map((node) => String(node.label));
  const laneSummary = lanes.length > 0 ? ` across ${lanes.length} lanes` : "";
  return `Canvas ${formatDiagramType(diagramType)} planned: ${canvas.nodes.length} nodes, ${canvas.edges.length} edges${laneSummary}.`;
}

function formatDiagramType(diagramType: CanvasLayoutDiagramType): string {
  return diagramType.replace(/_/g, " ");
}

function normalizeArtifactPath(path: string, extension: ".canvas" | ".svg"): string {
  const normalized = normalizeVaultPath(path);
  if (!normalized.toLowerCase().endsWith(extension)) {
    throw new ToolExecutionError(
      "unsafe_path",
      `Artifact path must end with ${extension}.`,
    );
  }

  return normalized;
}

function getCanvasFromArgs(args: Record<string, unknown>): JsonCanvas {
  if (args.canvas !== undefined) {
    assertValidJsonCanvas(args.canvas);
    return args.canvas;
  }

  if (args.nodes !== undefined || args.edges !== undefined) {
    const canvas = {
      nodes: Array.isArray(args.nodes) ? args.nodes : [],
      edges: Array.isArray(args.edges) ? args.edges : [],
    };
    assertValidJsonCanvas(canvas);
    return canvas;
  }

  return buildLayoutCanvas({
    title: getOptionalString(args, "title"),
    items: getLayoutItems(args),
    direction: getDirection(args.direction),
    connect: getConnect(args.connect),
    diagramType: getDiagramType(args.diagramType),
    connections: getConnections(args.connections),
  });
}

function getLayoutItems(args: Record<string, unknown>): CanvasLayoutItem[] {
  if (!Array.isArray(args.items)) {
    const title = getOptionalString(args, "title") ?? "Design";
    return [{ title }];
  }

  return args.items.map((item, index) => {
    if (!isRecord(item)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `items[${index}] must be an object.`,
      );
    }

    const title = typeof item.title === "string" ? item.title : `Item ${index + 1}`;
    return {
      id: typeof item.id === "string" ? item.id : undefined,
      type:
        item.type === "text" ||
        item.type === "file" ||
        item.type === "link" ||
        item.type === "group"
          ? item.type
          : undefined,
      kind: getItemKind(item.kind, index),
      title,
      text: typeof item.text === "string" ? item.text : undefined,
      file: typeof item.file === "string" ? item.file : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      lane: typeof item.lane === "string" ? item.lane : undefined,
      color: typeof item.color === "string" ? item.color : undefined,
    };
  });
}

function getDirection(value: unknown): CanvasLayoutDirection | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "row" || value === "column" || value === "grid") {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    "direction must be row, column, or grid.",
  );
}

function getDiagramType(value: unknown): CanvasLayoutDiagramType {
  if (value === undefined) {
    return "sequence";
  }

  if (
    value === "sequence" ||
    value === "user_flow" ||
    value === "ui_flow" ||
    value === "logistics_system" ||
    value === "service_blueprint" ||
    value === "project_ideation" ||
    value === "architecture" ||
    value === "mind_map"
  ) {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    "diagramType must be sequence, user_flow, ui_flow, logistics_system, service_blueprint, project_ideation, architecture, or mind_map.",
  );
}

function getConnect(value: unknown): CanvasConnectionMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "none" || value === "sequence") {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    "connect must be none or sequence.",
  );
}

function getConnections(value: unknown): CanvasLayoutConnection[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "connections must be an array.",
    );
  }

  return value.map((connection, index) => {
    if (!isRecord(connection)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `connections[${index}] must be an object.`,
      );
    }

    return {
      from: getShapeString(connection, "from", index),
      to: getShapeString(connection, "to", index),
      label: getOptionalShapeString(connection, "label", index),
      color: getOptionalShapeString(connection, "color", index),
      fromSide: getCanvasSide(connection.fromSide, index, "fromSide"),
      toSide: getCanvasSide(connection.toSide, index, "toSide"),
    };
  });
}

function getCanvasSide(
  value: unknown,
  index: number,
  field: string,
): CanvasLayoutConnection["fromSide"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "top" || value === "right" || value === "bottom" || value === "left") {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    `connections[${index}].${field} must be top, right, bottom, or left.`,
  );
}

function getItemKind(value: unknown, index: number): CanvasLayoutItemKind | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === "step" ||
    value === "persona" ||
    value === "actor" ||
    value === "screen" ||
    value === "decision" ||
    value === "service" ||
    value === "resource" ||
    value === "database" ||
    value === "queue" ||
    value === "milestone" ||
    value === "risk" ||
    value === "metric" ||
    value === "dependency" ||
    value === "note" ||
    value === "external"
  ) {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    `items[${index}].kind must be step, persona, actor, screen, decision, service, resource, database, queue, milestone, risk, metric, dependency, note, or external.`,
  );
}

function getShapes(args: Record<string, unknown>): SvgWireframeShape[] {
  if (!Array.isArray(args.shapes) || args.shapes.length === 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "create_svg_design requires at least one shape.",
    );
  }

  return args.shapes.map((shape, index) => {
    if (!isRecord(shape)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `shapes[${index}] must be an object.`,
      );
    }

    return normalizeShape(shape, index);
  });
}

function normalizeShape(
  shape: Record<string, unknown>,
  index: number,
): SvgWireframeShape {
  const type = shape.type;
  const base = {
    id: getOptionalShapeString(shape, "id", index),
    stroke: getOptionalShapeString(shape, "stroke", index),
    strokeWidth: getOptionalShapeNumber(shape, "strokeWidth", index),
    fill: getOptionalShapeString(shape, "fill", index),
  };

  if (type === "rect") {
    return {
      ...base,
      type,
      x: getShapeNumber(shape, "x", index),
      y: getShapeNumber(shape, "y", index),
      width: getPositiveShapeNumber(shape, "width", index),
      height: getPositiveShapeNumber(shape, "height", index),
      rx: getOptionalShapeNumber(shape, "rx", index),
      label: getOptionalShapeString(shape, "label", index),
    };
  }

  if (type === "text") {
    return {
      ...base,
      type,
      x: getShapeNumber(shape, "x", index),
      y: getShapeNumber(shape, "y", index),
      text: getShapeString(shape, "text", index),
      fontSize: getOptionalShapeNumber(shape, "fontSize", index),
      anchor: getTextAnchor(shape.anchor, index),
    };
  }

  if (type === "line" || type === "arrow") {
    return {
      ...base,
      type,
      x1: getShapeNumber(shape, "x1", index),
      y1: getShapeNumber(shape, "y1", index),
      x2: getShapeNumber(shape, "x2", index),
      y2: getShapeNumber(shape, "y2", index),
      label: getOptionalShapeString(shape, "label", index),
    };
  }

  if (type === "circle") {
    return {
      ...base,
      type,
      cx: getShapeNumber(shape, "cx", index),
      cy: getShapeNumber(shape, "cy", index),
      r: getPositiveShapeNumber(shape, "r", index),
      label: getOptionalShapeString(shape, "label", index),
    };
  }

  if (type === "ellipse") {
    return {
      ...base,
      type,
      cx: getShapeNumber(shape, "cx", index),
      cy: getShapeNumber(shape, "cy", index),
      rx: getPositiveShapeNumber(shape, "rx", index),
      ry: getPositiveShapeNumber(shape, "ry", index),
      label: getOptionalShapeString(shape, "label", index),
    };
  }

  if (type === "diamond") {
    return {
      ...base,
      type,
      x: getShapeNumber(shape, "x", index),
      y: getShapeNumber(shape, "y", index),
      width: getPositiveShapeNumber(shape, "width", index),
      height: getPositiveShapeNumber(shape, "height", index),
      label: getOptionalShapeString(shape, "label", index),
    };
  }

  if (type === "cylinder") {
    return {
      ...base,
      type,
      x: getShapeNumber(shape, "x", index),
      y: getShapeNumber(shape, "y", index),
      width: getPositiveShapeNumber(shape, "width", index),
      height: getPositiveShapeNumber(shape, "height", index),
      label: getOptionalShapeString(shape, "label", index),
    };
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    `shapes[${index}].type must be rect, text, line, arrow, circle, ellipse, diamond, or cylinder.`,
  );
}

function getShapeString(
  shape: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = shape[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `shapes[${index}].${key} must be a non-empty string.`,
    );
  }

  return value;
}

function getOptionalShapeString(
  shape: Record<string, unknown>,
  key: string,
  index: number,
): string | undefined {
  const value = shape[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ToolExecutionError(
      "invalid_arguments",
      `shapes[${index}].${key} must be a string when provided.`,
    );
  }

  return value;
}

function getShapeNumber(
  shape: Record<string, unknown>,
  key: string,
  index: number,
): number {
  const value = shape[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `shapes[${index}].${key} must be a finite number.`,
    );
  }

  return value;
}

function getOptionalShapeNumber(
  shape: Record<string, unknown>,
  key: string,
  index: number,
): number | undefined {
  const value = shape[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `shapes[${index}].${key} must be a finite number when provided.`,
    );
  }

  return value;
}

function getPositiveShapeNumber(
  shape: Record<string, unknown>,
  key: string,
  index: number,
): number {
  const value = getShapeNumber(shape, key, index);
  if (value <= 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `shapes[${index}].${key} must be greater than zero.`,
    );
  }

  return value;
}

function getTextAnchor(
  value: unknown,
  index: number,
): "start" | "middle" | "end" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "start" || value === "middle" || value === "end") {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    `shapes[${index}].anchor must be start, middle, or end when provided.`,
  );
}

function assertPathDoesNotExist(context: ToolExecutionContext, path: string) {
  const vault = context.app.vault as unknown as {
    getAbstractFileByPath?: (path: string) => unknown;
  };
  if (context.app.vault.getFileByPath(path) || vault.getAbstractFileByPath?.(path)) {
    throw new Error(`Path already exists: ${path}`);
  }
}

async function backupDesignArtifact(
  context: ToolExecutionContext,
  path: string,
  content: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const basename = path.split("/").pop() ?? "design.canvas";
  const backupPath = `.agent-backups/${basename}.${stamp}.bak`;
  await ensureParentFolder(context, backupPath, true);
  const existing = context.app.vault.getFileByPath(backupPath);
  if (existing) {
    await context.app.vault.modify(existing, content);
  } else {
    await context.app.vault.create(backupPath, content);
  }
  return backupPath;
}

async function ensureParentFolder(
  context: ToolExecutionContext,
  path: string,
  createMissing: boolean,
) {
  const parentPath = getParentFolderPath(path);
  if (!parentPath) {
    return;
  }

  if (context.app.vault.getFolderByPath(parentPath)) {
    return;
  }

  if (!createMissing) {
    throw new Error(`Destination folder not found: ${parentPath}`);
  }

  await ensureFolderPath(context, parentPath);
}

async function ensureFolderPath(
  context: ToolExecutionContext,
  path: string,
) {
  const parts = path.split("/");
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    if (context.app.vault.getFileByPath(currentPath)) {
      throw new Error(`Cannot create folder because a file exists at: ${currentPath}`);
    }

    if (!context.app.vault.getFolderByPath(currentPath)) {
      try {
        await context.app.vault.createFolder(currentPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Obsidian can race adapter vs metadata cache; treat existing folder as ok.
        if (
          /already exists/i.test(message) &&
          context.app.vault.getFolderByPath(currentPath)
        ) {
          continue;
        }
        if (/already exists/i.test(message)) {
          continue;
        }
        throw error;
      }
    }
  }
}

async function openCreatedFile(
  context: ToolExecutionContext,
  file: TFile,
): Promise<boolean> {
  const workspace = context.app.workspace as unknown as {
    getLeaf?: (newLeaf?: boolean) => {
      openFile?: (file: TFile) => Promise<void>;
    };
  };
  const leaf = workspace.getLeaf?.(false);
  if (!leaf?.openFile) {
    return false;
  }

  await leaf.openFile(file);
  return true;
}

function getParentFolderPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex === -1 ? "" : path.slice(0, slashIndex);
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
