import { CanvasWriter } from "./CanvasWriter";
import {
  CreateDesignPackageInput,
  DesignItemKind,
  DesignPackageKind,
} from "./DesignPackageTypes";
import type { AgentTool, ToolExecutionContext } from "../../tools/types";
import { ToolExecutionError } from "../../tools/types";
import {
  getOptionalString,
  getRequiredString,
  isRecord,
} from "../../tools/validation";

const DESIGN_PACKAGE_INTENT_PATTERN =
  /\b(create|make|draw|generate|build|draft|map|design|package)\b[\s\S]{0,160}\b(ui\s*flow|logistics|service\s*blueprint|architecture|project\s*ideation|mind\s*map|canvas|design\s*package|workflow|system)\b|\b(ui\s*flow|logistics|service\s*blueprint|architecture|project\s*ideation|mind\s*map|canvas|design\s*package|workflow|system)\b[\s\S]{0,160}\b(create|make|draw|generate|build|draft|map|design|package)\b/i;

export const createDesignPackageTool: AgentTool = {
  name: "create_design_package",
  descriptor: {
    version: 1,
    name: "create_design_package",
    capability: {
      system: "vault",
      resourceType: "design_package",
      action: "create",
    },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: { preparation: "optional", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "optional",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind: "artifact",
  },
  description:
    "Create a paired Obsidian Canvas plus markdown brief for UI flows, logistics systems, service blueprints, architecture maps, project ideation, or mind maps.",
  parameters: {
    type: "object",
    required: ["title", "kind", "items", "edges"],
    properties: {
      title: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "ui_flow",
          "logistics_system",
          "service_blueprint",
          "project_ideation",
          "architecture",
          "mind_map",
        ],
      },
      targetFolder: { type: "string" },
      items: {
        type: "array",
        items: { type: "object" },
      },
      edges: {
        type: "array",
        items: { type: "object" },
      },
      briefMarkdown: { type: "string" },
      overwrite: { type: "boolean" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertDesignPackageIntent(context);
    const input = parseInput(args);
    context.reportProgress?.(`Planning design package ${input.title}...`);
    const result = await new CanvasWriter(context.app.vault).createPackage(input);
    context.reportProgress?.(
      `Design package written: ${result.canvasPath} and ${result.briefPath}.`,
    );

    return {
      ...result,
      path: result.briefPath,
      operation: "create",
      artifacts: [
        { kind: "canvas", path: result.canvasPath, title: input.title },
        { kind: "note", path: result.briefPath, title: input.title },
      ],
      summary: `Created design package with ${result.itemCount} items and ${result.edgeCount} edges.`,
    };
  },
};

function parseInput(args: Record<string, unknown>): CreateDesignPackageInput {
  const kind = getDesignPackageKind(args.kind);
  const items = parseItems(args.items);
  const edges = parseEdges(args.edges);
  const overwrite = args.overwrite;
  if (overwrite !== undefined && overwrite !== false) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "create_design_package only supports overwrite=false.",
    );
  }

  return {
    title: getRequiredString(args, "title"),
    kind,
    targetFolder: getOptionalString(args, "targetFolder"),
    items,
    edges,
    briefMarkdown: getOptionalString(args, "briefMarkdown"),
    overwrite: false,
  };
}

function parseItems(value: unknown): CreateDesignPackageInput["items"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "items must include at least one design package item.",
    );
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ToolExecutionError("invalid_arguments", `items[${index}] must be an object.`);
    }
    return {
      id: getFieldString(item, "id", index),
      kind: getDesignItemKind(item.kind, index),
      title: getFieldString(item, "title", index),
      summary: getFieldString(item, "summary", index),
      details: getOptionalStringArray(item.details, index, "details"),
      metadata: getOptionalMetadata(item.metadata, index),
    };
  });
}

function parseEdges(value: unknown): CreateDesignPackageInput["edges"] {
  if (!Array.isArray(value)) {
    throw new ToolExecutionError("invalid_arguments", "edges must be an array.");
  }

  return value.map((edge, index) => {
    if (!isRecord(edge)) {
      throw new ToolExecutionError("invalid_arguments", `edges[${index}] must be an object.`);
    }
    return {
      id: getFieldString(edge, "id", index),
      from: getFieldString(edge, "from", index),
      to: getFieldString(edge, "to", index),
      label: typeof edge.label === "string" ? edge.label : undefined,
    };
  });
}

function assertDesignPackageIntent(context: ToolExecutionContext) {
  if (!DESIGN_PACKAGE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new ToolExecutionError(
      "intent_required",
      "create_design_package requires explicit design package, UI flow, logistics, service blueprint, architecture, project ideation, mind map, or Canvas intent.",
    );
  }
}

function getDesignPackageKind(value: unknown): DesignPackageKind {
  if (
    value === "ui_flow" ||
    value === "logistics_system" ||
    value === "service_blueprint" ||
    value === "project_ideation" ||
    value === "architecture" ||
    value === "mind_map"
  ) {
    return value;
  }

  throw new ToolExecutionError("invalid_arguments", "Invalid design package kind.");
}

function getDesignItemKind(value: unknown, index: number): DesignItemKind {
  if (
    value === "persona" ||
    value === "screen" ||
    value === "actor" ||
    value === "service" ||
    value === "resource" ||
    value === "queue" ||
    value === "database" ||
    value === "milestone" ||
    value === "risk" ||
    value === "metric" ||
    value === "dependency" ||
    value === "decision" ||
    value === "note"
  ) {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    `items[${index}].kind is not a supported design item kind.`,
  );
}

function getFieldString(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `items/edges[${index}].${key} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function getOptionalStringArray(
  value: unknown,
  index: number,
  key: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `items[${index}].${key} must be an array of strings when provided.`,
    );
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function getOptionalMetadata(
  value: unknown,
  index: number,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `items[${index}].metadata must be an object when provided.`,
    );
  }

  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      metadata[key] = item;
    }
  }
  return metadata;
}
