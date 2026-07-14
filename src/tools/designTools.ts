import type { TFile } from "obsidian";
import {
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  withPreparedActionFingerprint,
} from "../agent/actions/canonicalize";
import type {
  ActionReceipt,
  JsonValue,
  PreparedAction,
  PreparedActionResult,
  ToolDescriptor,
} from "../agent/actions";
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
  applyCanvasPatch,
  parseCanvasPatchOperations,
} from "../design/canvasPatch";
import {
  DiagramArtifactStore,
  sha256DiagramContent,
} from "../design/diagramArtifactStore";
import {
  MAX_CANVAS_QA_REPAIR_PASSES,
  runCanvasQa,
} from "../design/diagramQa";
import {
  renderSvgWireframe,
  type SvgWireframeShape,
} from "../design/svgDesign";
import {
  applySafeSvgPatch,
  parseSafeSvg,
  parseSvgPatchOperations,
} from "../design/svgPatch";
import { createDesignPackageTool } from "../agent/design/CreateDesignPackageTool";
import {
  hasDesignIntent,
  hasReviseDesignIntent,
} from "../agent/codeDesignIntent";
import type {
  AgentTool,
  AgentToolActionExecution,
  ToolExecutionContext,
} from "./types";
import { ToolExecutionError } from "./types";
import {
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  isRecord,
  normalizeVaultPath,
} from "./validation";

export function createDesignTools(): AgentTool[] {
  return [
    createDesignCanvasTool,
    readDesignCanvasTool,
    updateDesignCanvasTool,
    createSvgDesignTool,
    readSvgDesignTool,
    updateSvgDesignTool,
    createDesignPackageTool,
  ];
}

export const createDesignCanvasTool: AgentTool = {
  name: "create_design_canvas",
  descriptor: designArtifactMutationDescriptor(
    "create_design_canvas",
    "canvas",
    "create",
  ),
  description:
    "Create and open a new Obsidian JSON Canvas artifact for diagrams, user flows, or architecture maps.",
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
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: ["text", "file", "link", "group"],
            },
            kind: {
              type: "string",
              enum: [
                "step",
                "branch",
                "persona",
                "actor",
                "screen",
                "decision",
                "service",
                "resource",
                "database",
                "queue",
                "milestone",
                "risk",
                "metric",
                "dependency",
                "note",
                "external",
              ],
            },
            title: { type: "string" },
            text: { type: "string" },
            file: { type: "string" },
            url: { type: "string" },
            lane: { type: "string" },
            color: { type: "string" },
          },
          additionalProperties: false,
        },
        description:
          "Optional layout items. kind is visual metadata; use branch for government or organizational branches.",
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
        description: "Open the created file in Obsidian after writing. Defaults to true.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertDesignIntent(context, "create_design_canvas");
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".canvas");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;
    const open = getOptionalBoolean(args, "open") ?? true;

    // Parse and verify every model-provided field before touching the vault.
    // This keeps invalid arguments provably retryable instead of leaving a
    // failed mutation intent that continuation must conservatively reconcile.
    const canvas = getCanvasFromArgs(args);
    const diagramType = getDiagramType(args.diagramType);
    const canvasSummary = summarizeCanvas(canvas, diagramType);
    const content = stringifyJsonCanvas(canvas);
    const preflight = verifyCanvasArtifact(content);
    if (!preflight.ok) {
      throw new Error(`Canvas preflight verification failed: ${preflight.errors.join(" ")}`);
    }

    assertPathDoesNotExist(context, path);
    await ensureParentFolder(context, path, createFolders);

    reportProgress(context, `Planning canvas design for ${path}...`);
    reportProgress(context, canvasSummary);
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

export const readDesignCanvasTool: AgentTool = {
  name: "read_design_canvas",
  descriptor: designArtifactReadDescriptor("read_design_canvas", "canvas"),
  description:
    "Read an existing Obsidian JSON Canvas as normalized structure with its exact SHA-256 precondition hash.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .canvas path to read.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".canvas");
    const artifact = await new DiagramArtifactStore(context.app.vault).read(path);
    const canvas = JSON.parse(artifact.content) as unknown;
    assertValidJsonCanvas(canvas);
    return {
      path,
      operation: "read",
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
      canvas,
    };
  },
};

export const updateDesignCanvasTool: AgentTool = {
  name: "update_design_canvas",
  descriptor: {
    version: 1,
    name: "update_design_canvas",
    capability: { system: "vault", resourceType: "canvas", action: "update" },
    effect: "reversible_mutation",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
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
    "Patch an existing Obsidian JSON Canvas by stable node/edge ids. Requires a fresh baseHash, exact approval, backup, read-back verification, and rollback on failure.",
  parameters: {
    type: "object",
    required: ["path", "baseHash", "operations"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .canvas path to update.",
      },
      baseHash: {
        type: "string",
        description: "Exact SHA-256 returned by read_design_canvas.",
      },
      operations: {
        type: "array",
        items: { type: "object" },
        description:
          "Stable-id add/update/remove node or edge operations, or deterministic auto_layout.",
      },
      open: {
        type: "boolean",
        description: "Open the updated file in Obsidian after writing.",
      },
    },
    additionalProperties: false,
  },
  async execute() {
    throw new ToolExecutionError(
      "preparation_required",
      "update_design_canvas must be prepared and exactly approved before mutation.",
      { mutationState: "not_applied" },
    );
  },
  prepare: (args, context) => prepareDesignCanvasUpdate(args, context),
  executePrepared: (action, context) =>
    executePreparedDesignCanvasUpdate(action, context),
};

export const createSvgDesignTool: AgentTool = {
  name: "create_svg_design",
  descriptor: designArtifactMutationDescriptor(
    "create_svg_design",
    "svg",
    "create",
  ),
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

export const readSvgDesignTool: AgentTool = {
  name: "read_svg_design",
  descriptor: designArtifactReadDescriptor("read_svg_design", "svg"),
  description:
    "Read an existing safe SVG diagram as normalized structure with its exact SHA-256 precondition hash.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .svg path to read.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".svg");
    const artifact = await new DiagramArtifactStore(context.app.vault).read(path);
    const document = parseSafeSvg(artifact.content);
    return {
      path,
      operation: "read",
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      elementCount: document.elementCount,
      stableIds: document.stableIds,
      qa: document.qa,
      document,
    };
  },
};

export const updateSvgDesignTool: AgentTool = {
  name: "update_svg_design",
  descriptor: {
    version: 1,
    name: "update_svg_design",
    capability: { system: "vault", resourceType: "svg", action: "update" },
    effect: "reversible_mutation",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
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
    "Patch an existing safe SVG by stable element ids. Requires a fresh baseHash, exact approval, backup, read-back verification, and rollback on failure.",
  parameters: {
    type: "object",
    required: ["path", "baseHash", "operations"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .svg path to update.",
      },
      baseHash: {
        type: "string",
        description: "Exact SHA-256 returned by read_svg_design.",
      },
      operations: {
        type: "array",
        items: { type: "object" },
        description:
          "Stable-id update_text, update_attributes, remove_element, or add_shape operations.",
      },
      open: {
        type: "boolean",
        description: "Open the updated SVG in Obsidian after writing.",
      },
    },
    additionalProperties: false,
  },
  async execute() {
    throw new ToolExecutionError(
      "preparation_required",
      "update_svg_design must be prepared and exactly approved before mutation.",
      { mutationState: "not_applied" },
    );
  },
  prepare: (args, context) => prepareSvgDesignUpdate(args, context),
  executePrepared: (action, context) => executePreparedSvgDesignUpdate(action, context),
};

async function prepareDesignCanvasUpdate(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    if (!hasReviseDesignIntent(context.originalPrompt)) {
      throw new ToolExecutionError(
        "intent_required",
        "update_design_canvas requires explicit revise/update/edit design intent.",
      );
    }
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".canvas");
    const baseHash = getRequiredString(args, "baseHash");
    const operations = parseCanvasPatchOperations(args.operations);
    const open = getOptionalBoolean(args, "open") ?? false;
    const store = new DiagramArtifactStore(context.app.vault);
    const current = await store.read(path);
    if (current.sha256 !== baseHash) {
      throw new ToolExecutionError(
        "vault_precondition_changed",
        "Canvas baseHash no longer matches the persisted artifact; read it again before preparing a patch.",
        { mutationState: "not_applied" },
      );
    }
    const canvas = JSON.parse(current.content) as unknown;
    assertValidJsonCanvas(canvas);
    const patch = applyCanvasPatch(canvas, operations);
    const qa = runCanvasQa(patch.canvas, {
      autoRepair: true,
      maxRepairPasses: MAX_CANVAS_QA_REPAIR_PASSES,
    });
    const blockingQaIssues = qa.issues.filter((issue) => issue.severity === "error");
    if (blockingQaIssues.length > 0) {
      throw new ToolExecutionError(
        "canvas_qa_failed",
        `Canvas QA still has blocking issues after ${qa.passCount} repair pass(es): ${blockingQaIssues.map((issue) => issue.message).join(" ")}`,
        { mutationState: "not_applied" },
      );
    }
    const content = stringifyJsonCanvas(qa.canvas);
    const verification = verifyCanvasArtifact(content);
    if (!verification.ok) {
      throw new ToolExecutionError(
        "canvas_patch_invalid",
        `Canvas patch preflight failed: ${verification.errors.join(" ")}`,
        { mutationState: "not_applied" },
      );
    }
    const expectedAfterSha256 = await sha256DiagramContent(content);
    const normalizedOperations = JSON.parse(
      JSON.stringify(operations),
    ) as JsonValue;
    const preservation = JSON.parse(
      JSON.stringify(patch.preservation),
    ) as JsonValue;
    const qaReport = JSON.parse(JSON.stringify({
      issues: qa.issues,
      repairs: qa.repairs,
      passCount: qa.passCount,
    })) as JsonValue;
    const preparedAt = designNow(context);
    const runId = context.runId?.trim() || `design-run-${designToken()}`;
    const toolCallId = context.operationId?.trim() || `design-call-${designToken()}`;
    const actionIdHash = await sha256Fingerprint({
      runId,
      toolCallId,
      toolName: "update_design_canvas",
      path,
      baseHash,
      expectedAfterSha256,
    });
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: `design-action-${actionIdHash.slice(7, 39)}`,
      runId,
      toolCallId,
      toolName: "update_design_canvas",
      target: {
        system: "vault",
        resourceType: "canvas",
        id: path,
        path,
        revision: baseHash,
      },
      relatedResources: [],
      normalizedArgs: {
        path,
        baseHash,
        operations: normalizedOperations,
        content,
        expectedAfterSha256,
        preservation,
        qa: qaReport,
        open,
      },
      preview: {
        summary: `Apply ${operations.length} stable-id Canvas patch operation(s) to ${path}.`,
        destination: path,
        before: {
          sha256: baseHash,
          nodes: canvas.nodes.length,
          edges: canvas.edges.length,
        },
        after: {
          sha256: expectedAfterSha256,
          nodes: qa.canvas.nodes.length,
          edges: qa.canvas.edges.length,
        },
        outboundPayload: { operations: normalizedOperations },
        warnings: [
          "The current Canvas hash is checked again immediately before mutation.",
          "A verified backup is created and failed readback or validation is rolled back.",
          ...qa.issues
            .filter((issue) => issue.severity === "warning")
            .map((issue) => `Canvas QA warning: ${issue.message}`),
        ],
        outboundBytes: getByteLength(content),
      },
      expectedTargetRevision: baseHash,
      idempotencyKey: `${runId}:${toolCallId}:update_design_canvas`,
      reconciliationKey: `vault:canvas:${path}`,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + 120_000).toISOString(),
    });
    return { ok: true, action };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof ToolExecutionError
          ? error.code
          : "canvas_patch_preparation_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function executePreparedDesignCanvasUpdate(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertPreparedDesignBinding(action, context);
  const path = requirePreparedDesignString(action, "path");
  const baseHash = requirePreparedDesignString(action, "baseHash");
  const content = requirePreparedDesignString(action, "content");
  const expectedAfterSha256 = requirePreparedDesignString(
    action,
    "expectedAfterSha256",
  );
  const startedAt = designNow(context).toISOString();
  const store = new DiagramArtifactStore(context.app.vault, {
    onStage: (stage) => reportProgress(
      context,
      `Canvas transaction: ${stage.replace(/_/gu, " ")}.`,
    ),
  });
  const update = await store.update({
    path,
    expectedSha256: baseHash,
    content,
    validator: ({ content: persisted }) => validatePersistedCanvas(persisted),
  });
  if (update.status !== "committed" || update.afterSha256 !== expectedAfterSha256) {
    throw new ToolExecutionError(
      update.status === "rollback_failed"
        ? "canvas_patch_rollback_failed"
        : "canvas_patch_rolled_back",
      update.error?.message ?? "Canvas patch did not commit and was rolled back.",
      {
        mutationState:
          update.status === "rollback_failed" ? "may_have_applied" : "not_applied",
        details: {
          path,
          backupPath: update.backupPath,
          rollbackStatus: update.rollbackStatus,
          finalSha256: update.finalSha256,
        },
      },
    );
  }
  const file = context.app.vault.getFileByPath(path);
  const open = action.normalizedArgs.open === true;
  const opened = open && file ? await openCreatedFile(context, file) : false;
  const committedAt = designNow(context).toISOString();
  const receipt = await createDesignActionReceipt({
    action,
    context,
    startedAt,
    committedAt,
    observedRevision: update.afterSha256,
    backupPath: update.backupPath,
    bytesWritten: update.bytesWritten,
  });
  return {
    mutationState: "applied",
    receipt,
    output: {
      path,
      operation: "update",
      beforeSha256: update.beforeSha256,
      afterSha256: update.afterSha256,
      backupPath: update.backupPath,
      backupSha256: update.backupSha256,
      bytesWritten: update.bytesWritten,
      preservation: action.normalizedArgs.preservation,
      qa: action.normalizedArgs.qa,
      rollbackStatus: update.rollbackStatus,
      opened,
      receipt: update,
    },
  };
}

async function prepareSvgDesignUpdate(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    if (!hasReviseDesignIntent(context.originalPrompt)) {
      throw new ToolExecutionError(
        "intent_required",
        "update_svg_design requires explicit revise/update/edit design intent.",
      );
    }
    const path = normalizeArtifactPath(getRequiredString(args, "path"), ".svg");
    const baseHash = getRequiredString(args, "baseHash");
    const operations = parseSvgPatchOperations(args.operations);
    const open = getOptionalBoolean(args, "open") ?? false;
    const store = new DiagramArtifactStore(context.app.vault);
    const current = await store.read(path);
    if (current.sha256 !== baseHash) {
      throw new ToolExecutionError(
        "vault_precondition_changed",
        "SVG baseHash no longer matches the persisted artifact; read it again before preparing a patch.",
        { mutationState: "not_applied" },
      );
    }
    const before = parseSafeSvg(current.content);
    const patch = applySafeSvgPatch(current.content, operations);
    const blockingQaIssues = patch.document.qa.issues.filter(
      (issue) => issue.severity === "error",
    );
    if (blockingQaIssues.length > 0) {
      throw new ToolExecutionError(
        "svg_qa_failed",
        `SVG QA has blocking issues: ${blockingQaIssues.map((issue) => issue.message).join(" ")}`,
        { mutationState: "not_applied" },
      );
    }
    const content = patch.content;
    const expectedAfterSha256 = await sha256DiagramContent(content);
    const normalizedOperations = JSON.parse(JSON.stringify(operations)) as JsonValue;
    const preservation = JSON.parse(JSON.stringify(patch.preservation)) as JsonValue;
    const qaReport = JSON.parse(JSON.stringify(patch.document.qa)) as JsonValue;
    const preparedAt = designNow(context);
    const runId = context.runId?.trim() || `design-run-${designToken()}`;
    const toolCallId = context.operationId?.trim() || `design-call-${designToken()}`;
    const actionIdHash = await sha256Fingerprint({
      runId,
      toolCallId,
      toolName: "update_svg_design",
      path,
      baseHash,
      expectedAfterSha256,
    });
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: `design-action-${actionIdHash.slice(7, 39)}`,
      runId,
      toolCallId,
      toolName: "update_svg_design",
      target: {
        system: "vault",
        resourceType: "svg",
        id: path,
        path,
        revision: baseHash,
      },
      relatedResources: [],
      normalizedArgs: {
        path,
        baseHash,
        operations: normalizedOperations,
        content,
        expectedAfterSha256,
        preservation,
        qa: qaReport,
        open,
      },
      preview: {
        summary: `Apply ${operations.length} stable-id SVG patch operation(s) to ${path}.`,
        destination: path,
        before: {
          sha256: baseHash,
          elements: before.elementCount,
          stableIds: before.stableIds.length,
        },
        after: {
          sha256: expectedAfterSha256,
          elements: patch.document.elementCount,
          stableIds: patch.document.stableIds.length,
        },
        outboundPayload: { operations: normalizedOperations },
        warnings: [
          "The current SVG hash is checked again immediately before mutation.",
          "A verified backup is created and failed readback or validation is rolled back.",
          ...patch.document.qa.issues
            .filter((issue) => issue.severity === "warning")
            .map((issue) => `SVG QA warning: ${issue.message}`),
        ],
        outboundBytes: getByteLength(content),
      },
      expectedTargetRevision: baseHash,
      idempotencyKey: `${runId}:${toolCallId}:update_svg_design`,
      reconciliationKey: `vault:svg:${path}`,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + 120_000).toISOString(),
    });
    return { ok: true, action };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof ToolExecutionError
          ? error.code
          : "svg_patch_preparation_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function executePreparedSvgDesignUpdate(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertPreparedSvgBinding(action, context);
  const path = requirePreparedDesignString(action, "path");
  const baseHash = requirePreparedDesignString(action, "baseHash");
  const content = requirePreparedDesignString(action, "content");
  const expectedAfterSha256 = requirePreparedDesignString(
    action,
    "expectedAfterSha256",
  );
  const startedAt = designNow(context).toISOString();
  const store = new DiagramArtifactStore(context.app.vault);
  const update = await store.update({
    path,
    expectedSha256: baseHash,
    content,
    validator: ({ content: persisted }) => validatePersistedSvg(persisted),
  });
  if (update.status !== "committed" || update.afterSha256 !== expectedAfterSha256) {
    throw new ToolExecutionError(
      update.status === "rollback_failed"
        ? "svg_patch_rollback_failed"
        : "svg_patch_rolled_back",
      update.error?.message ?? "SVG patch did not commit and was rolled back.",
      {
        mutationState:
          update.status === "rollback_failed" ? "may_have_applied" : "not_applied",
        details: {
          path,
          backupPath: update.backupPath,
          rollbackStatus: update.rollbackStatus,
          finalSha256: update.finalSha256,
        },
      },
    );
  }
  const file = context.app.vault.getFileByPath(path);
  const open = action.normalizedArgs.open === true;
  const opened = open && file ? await openCreatedFile(context, file) : false;
  const committedAt = designNow(context).toISOString();
  const receipt = await createSvgActionReceipt({
    action,
    context,
    startedAt,
    committedAt,
    observedRevision: update.afterSha256,
    backupPath: update.backupPath,
    bytesWritten: update.bytesWritten,
  });
  return {
    mutationState: "applied",
    receipt,
    output: {
      path,
      operation: "update",
      beforeSha256: update.beforeSha256,
      afterSha256: update.afterSha256,
      backupPath: update.backupPath,
      backupSha256: update.backupSha256,
      bytesWritten: update.bytesWritten,
      preservation: action.normalizedArgs.preservation,
      qa: action.normalizedArgs.qa,
      rollbackStatus: update.rollbackStatus,
      opened,
      receipt: update,
    },
  };
}

async function assertPreparedSvgBinding(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<void> {
  if (
    action.toolName !== "update_svg_design" ||
    !(await verifyPreparedActionFingerprint(action))
  ) {
    throw new ToolExecutionError(
      "fingerprint_mismatch",
      "Prepared SVG patch identity or fingerprint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  const authorization = context.authorizedAction;
  if (
    !authorization ||
    authorization.preparedActionId !== action.id ||
    authorization.payloadFingerprint !== action.payloadFingerprint ||
    !authorization.grantId.trim()
  ) {
    throw new ToolExecutionError(
      "authorization_mismatch",
      "Prepared SVG patch lacks its exact authority binding.",
      { mutationState: "not_applied" },
    );
  }
}

async function createSvgActionReceipt(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  startedAt: string;
  committedAt: string;
  observedRevision: string;
  backupPath: string;
  bytesWritten: number;
}): Promise<ActionReceipt> {
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    observedRevision: input.observedRevision,
  });
  return {
    version: 1,
    id: `design-receipt-${receiptHash.slice(7, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: "update",
    resource: { ...input.action.target },
    relatedResources: [
      {
        system: "vault",
        resourceType: "svg_backup",
        id: input.backupPath,
        path: input.backupPath,
      },
    ],
    message: `Patched ${input.action.target.path} with exact hash readback and verified backup.`,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId: input.context.authorizedAction!.grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt: input.committedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: input.committedAt,
      observedRevision: input.observedRevision,
      observedFingerprint: input.observedRevision,
    },
    effects: {
      bytesWritten: input.bytesWritten,
      affectedCount: 1,
      changedFields: [input.action.target.path ?? "svg"],
    },
  };
}

async function assertPreparedDesignBinding(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<void> {
  if (
    action.toolName !== "update_design_canvas" ||
    !(await verifyPreparedActionFingerprint(action))
  ) {
    throw new ToolExecutionError(
      "fingerprint_mismatch",
      "Prepared Canvas patch identity or fingerprint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  const authorization = context.authorizedAction;
  if (
    !authorization ||
    authorization.preparedActionId !== action.id ||
    authorization.payloadFingerprint !== action.payloadFingerprint ||
    !authorization.grantId.trim()
  ) {
    throw new ToolExecutionError(
      "authorization_mismatch",
      "Prepared Canvas patch lacks its exact authority binding.",
      { mutationState: "not_applied" },
    );
  }
}

function requirePreparedDesignString(
  action: PreparedAction,
  key: string,
): string {
  const value = action.normalizedArgs[key];
  if (typeof value !== "string" || !value) {
    throw new ToolExecutionError(
      "invalid_prepared_action",
      `Prepared Canvas patch is missing ${key}.`,
      { mutationState: "not_applied" },
    );
  }
  return value;
}

async function createDesignActionReceipt(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  startedAt: string;
  committedAt: string;
  observedRevision: string;
  backupPath: string;
  bytesWritten: number;
}): Promise<ActionReceipt> {
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    observedRevision: input.observedRevision,
  });
  return {
    version: 1,
    id: `design-receipt-${receiptHash.slice(7, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: "update",
    resource: { ...input.action.target },
    relatedResources: [
      {
        system: "vault",
        resourceType: "canvas_backup",
        id: input.backupPath,
        path: input.backupPath,
      },
    ],
    message: `Patched ${input.action.target.path} with exact hash readback and verified backup.`,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId: input.context.authorizedAction!.grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt: input.committedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: input.committedAt,
      observedRevision: input.observedRevision,
      observedFingerprint: input.observedRevision,
    },
    effects: {
      bytesWritten: input.bytesWritten,
      affectedCount: 1,
      changedFields: [input.action.target.path ?? "canvas"],
    },
  };
}

function designArtifactReadDescriptor(
  name: string,
  resourceType: string,
): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system: "vault", resourceType, action: "read" },
    effect: "read",
    risk: "low",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "none",
    },
    execution: { preparation: "none", cacheable: true, parallelSafe: true },
    durability: {
      journal: false,
      receipt: false,
      readback: "none",
      reconciliation: "none",
    },
    allowedPrincipals: ["single_agent", "lead", "researcher"],
  };
}

function designArtifactMutationDescriptor(
  name: string,
  resourceType: string,
  action: "create" | "update",
): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system: "vault", resourceType, action },
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
  };
}

function designNow(context: ToolExecutionContext): Date {
  return context.now?.() ?? new Date();
}

let designSequence = 0;
function designToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  designSequence += 1;
  return `${Date.now().toString(36)}-${designSequence.toString(36)}`;
}

function validatePersistedCanvas(content: string): {
  ok: boolean;
  errors: string[];
} {
  const structural = verifyCanvasArtifact(content);
  if (!structural.ok) {
    return { ok: false, errors: structural.errors };
  }
  try {
    const canvas = JSON.parse(content) as unknown;
    assertValidJsonCanvas(canvas);
    const qa = runCanvasQa(canvas);
    const errors = qa.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function validatePersistedSvg(content: string): {
  ok: boolean;
  errors: string[];
} {
  try {
    const document = parseSafeSvg(content);
    const errors = document.qa.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function assertDesignIntent(context: ToolExecutionContext, toolName: string) {
  if (!hasDesignIntent(context.originalPrompt)) {
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

  if (typeof value !== "string") {
    throw new ToolExecutionError(
      "invalid_arguments",
      `items[${index}].kind must be a string when provided.`,
    );
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "step" ||
    normalized === "branch" ||
    normalized === "persona" ||
    normalized === "actor" ||
    normalized === "screen" ||
    normalized === "decision" ||
    normalized === "service" ||
    normalized === "resource" ||
    normalized === "database" ||
    normalized === "queue" ||
    normalized === "milestone" ||
    normalized === "risk" ||
    normalized === "metric" ||
    normalized === "dependency" ||
    normalized === "note" ||
    normalized === "external"
  ) {
    return normalized;
  }

  // Visual kind affects only labels and colors, not Canvas authority or data
  // safety. Provider-created semantic labels such as "government" should not
  // abort an otherwise valid artifact; render them with the neutral note style.
  return "note";
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
