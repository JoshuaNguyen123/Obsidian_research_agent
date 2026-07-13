import type { TFile, Vault } from "obsidian";
import {
  buildLayoutCanvas,
  type CanvasLayoutDiagramType,
  type CanvasLayoutItemKind,
} from "../../design/layout";
import { stringifyJsonCanvas } from "../../design/jsonCanvas";
import { verifyCanvasArtifact } from "../verification";
import { ToolExecutionError } from "../../tools/types";
import { normalizeVaultPath } from "../../tools/validation";
import {
  CreateDesignPackageInput,
  CreateDesignPackageResult,
  DesignItemKind,
  DesignPackageKind,
} from "./DesignPackageTypes";
import { buildDesignPackageBrief } from "./MarkdownBriefWriter";
import {
  DiagramArtifactStore,
  DiagramArtifactStoreError,
} from "../../design/diagramArtifactStore";

export class CanvasWriter {
  constructor(private readonly vault: Vault) {}

  async createPackage(input: CreateDesignPackageInput): Promise<CreateDesignPackageResult> {
    validateInput(input);
    const folder = normalizeFolder(input.targetFolder ?? "Design Packages");
    const baseName = slugify(input.title);
    const canvas = buildLayoutCanvas({
      title: input.title,
      diagramType: toCanvasDiagramType(input.kind),
      items: input.items.map((item) => ({
        id: item.id,
        kind: toCanvasItemKind(item.kind),
        title: item.title,
        text: [
          item.summary,
          ...(item.details?.length ? ["", ...item.details.map((detail) => `- ${detail}`)] : []),
        ].join("\n"),
        lane: getLaneForItem(input.kind, item.kind),
      })),
      connections: input.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
      })),
      connect: input.edges.length > 0 ? "none" : "sequence",
    });
    const canvasContent = stringifyJsonCanvas(canvas);
    const preflight = verifyCanvasArtifact(canvasContent);
    if (!preflight.ok) {
      throw new Error(`Canvas preflight verification failed: ${preflight.errors.join(" ")}`);
    }

    await ensureFolder(this.vault, folder);
    let committed:
      | { canvasPath: string; briefPath: string; bytesWritten: number }
      | null = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const { canvasPath, briefPath } = this.uniquePackagePaths(
        folder,
        baseName,
        attempt,
      );
      const brief = buildDesignPackageBrief(input, canvasPath);
      try {
        const transaction = await new DiagramArtifactStore(this.vault).createMany([
          {
            path: canvasPath,
            content: canvasContent,
            validator: ({ content }) => verifyCanvasArtifact(content),
          },
          {
            path: briefPath,
            content: brief,
            validator: ({ content }) => ({
              ok: content.includes(input.title) && content.includes(canvasPath),
              errors: ["Design brief must retain its title and Canvas link."],
            }),
          },
        ]);
        if (transaction.status !== "committed") {
          throw new ToolExecutionError(
            transaction.status === "rollback_failed"
              ? "design_package_rollback_failed"
              : "design_package_rolled_back",
            transaction.error?.message ??
              "Design package creation failed and was rolled back.",
          );
        }
        committed = {
          canvasPath,
          briefPath,
          bytesWritten: transaction.artifacts.reduce(
            (total, artifact) => total + artifact.bytesWritten,
            0,
          ),
        };
        break;
      } catch (error) {
        if (
          error instanceof DiagramArtifactStoreError &&
          error.code === "path_exists"
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!committed) {
      throw new Error(`Unable to allocate unique package paths for ${baseName}.`);
    }

    return {
      canvasPath: committed.canvasPath,
      briefPath: committed.briefPath,
      itemCount: input.items.length,
      edgeCount: input.edges.length,
      bytesWritten: committed.bytesWritten,
    };
  }

  private uniquePackagePaths(
    folder: string,
    baseName: string,
    attempt: number,
  ): { canvasPath: string; briefPath: string } {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    return {
      canvasPath: `${folder}/${baseName}${suffix}.canvas`,
      briefPath: `${folder}/${baseName}${suffix}.md`,
    };
  }
}

function validateInput(input: CreateDesignPackageInput) {
  if (input.overwrite !== undefined && input.overwrite !== false) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "create_design_package does not support overwrite.",
    );
  }
  if (!input.title.trim()) {
    throw new ToolExecutionError("invalid_arguments", "Design package title is required.");
  }
  if (input.items.length === 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "create_design_package requires at least one item.",
    );
  }

  const itemIds = new Set(input.items.map((item) => item.id));
  if (itemIds.size !== input.items.length) {
    throw new ToolExecutionError("invalid_arguments", "Design package item ids must be unique.");
  }

  for (const edge of input.edges) {
    if (!itemIds.has(edge.from) || !itemIds.has(edge.to)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `Design edge ${edge.id} references a missing item.`,
      );
    }
  }
}

function normalizeFolder(folder: string): string {
  return normalizeVaultPath(
    folder
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, ""),
    { blockSystemPaths: true },
  );
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "design-package"
  );
}

async function ensureFolder(vault: Vault, folder: string): Promise<void> {
  const parts = folder.split("/");
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = vault.getAbstractFileByPath(current);

    if (!existing) {
      await vault.createFolder(current);
      continue;
    }

    if (isTFile(existing)) {
      throw new Error(`Cannot create folder because file exists: ${current}`);
    }
  }
}

function isTFile(value: unknown): value is TFile {
  return typeof value === "object" && value !== null && "extension" in value;
}

function toCanvasDiagramType(kind: DesignPackageKind): CanvasLayoutDiagramType {
  return kind;
}

function toCanvasItemKind(kind: DesignItemKind): CanvasLayoutItemKind {
  if (kind === "note") return "step";
  return kind;
}

function getLaneForItem(
  packageKind: DesignPackageKind,
  itemKind: DesignItemKind,
): string | undefined {
  if (packageKind === "service_blueprint") {
    if (itemKind === "persona" || itemKind === "actor") return "Actors";
    if (itemKind === "screen") return "Frontstage";
    if (itemKind === "service" || itemKind === "database" || itemKind === "queue") {
      return "Backstage";
    }
    if (itemKind === "metric" || itemKind === "risk") return "Management";
  }

  if (packageKind === "logistics_system") {
    if (itemKind === "resource" || itemKind === "queue") return "Flow";
    if (itemKind === "dependency" || itemKind === "risk") return "Constraints";
    if (itemKind === "metric") return "Control";
  }

  if (packageKind === "ui_flow") {
    if (itemKind === "persona" || itemKind === "actor") return "Actors";
    if (itemKind === "screen" || itemKind === "decision") return "Screens";
  }

  return undefined;
}
