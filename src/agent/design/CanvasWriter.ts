import type { TFile, Vault } from "obsidian";
import {
  buildLayoutCanvas,
  inferCanvasLane,
  type CanvasLayoutDiagramType,
  type CanvasLayoutItemKind,
} from "../../design/layout";
import { stringifyJsonCanvas } from "../../design/jsonCanvas";
import { renderJsonCanvasSvg } from "../../design/canvasSvg";
import { verifyCanvasArtifact, verifySvgArtifact } from "../verification";
import { ToolExecutionError } from "../../tools/types";
import { normalizeVaultPath } from "../../tools/validation";
import {
  CreateDesignPackageInput,
  CreateDesignPackageResult,
  DesignItemKind,
  DesignPackageKind,
} from "./DesignPackageTypes";
import { buildDesignPackageBrief } from "./MarkdownBriefWriter";
import { assessDesignPackage } from "./DesignPackageAssessment";
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
        lane: item.lane?.trim() || getLaneForItem(input.kind, item.kind),
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
    const assessment = assessDesignPackage(input);
    const includeSvg = input.includeSvg ?? isDomainPackage(input.kind);
    const svgContent = includeSvg
      ? renderJsonCanvasSvg(canvas, { title: input.title })
      : undefined;
    const svgPreflight = svgContent ? verifySvgArtifact(svgContent) : null;
    if (svgPreflight && !svgPreflight.ok) {
      throw new Error(`SVG preflight verification failed: ${svgPreflight.errors.join(" ")}`);
    }


    await ensureFolder(this.vault, folder);
    let committed:
      | { canvasPath: string; svgPath?: string; briefPath: string; bytesWritten: number }
      | null = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const { canvasPath, svgPath, briefPath } = this.uniquePackagePaths(
        folder,
        baseName,
        attempt,
      );
      const brief = buildDesignPackageBrief(input, canvasPath, includeSvg ? svgPath : undefined);
      try {
        const transaction = await new DiagramArtifactStore(this.vault).createMany([
          {
            path: canvasPath,
            content: canvasContent,
            validator: ({ content }) => verifyCanvasArtifact(content),
          },
          ...(svgContent
            ? [{
                path: svgPath,
                content: svgContent,
                validator: ({ content }: { content: string }) => verifySvgArtifact(content),
              }]
            : []),
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
          ...(svgContent ? { svgPath } : {}),
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
      ...(committed.svgPath ? { svgPath: committed.svgPath } : {}),
      assessment,
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
  ): { canvasPath: string; svgPath: string; briefPath: string } {
    const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
    return {
      canvasPath: `${folder}/${baseName}${suffix}.canvas`,
      svgPath: `${folder}/${baseName}${suffix}.svg`,
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
  if (input.items.length > 80) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "create_design_package supports at most 80 items.",
    );
  }
  if (input.edges.length > 160) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "create_design_package supports at most 160 edges.",
    );
  }
  if (isDomainPackage(input.kind) && (input.items.length < 3 || input.edges.length < 2)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "Distributed-system and business/manufacturing-process packages require at least 3 items and 2 explicit flows.",
    );
  }

  for (const item of input.items) {
    if (!item.id.trim() || !item.title.trim() || !item.summary.trim()) {
      throw new ToolExecutionError("invalid_arguments", "Design package items require id, title, and summary.");
    }
  }


  const itemIds = new Set(input.items.map((item) => item.id));
  if (itemIds.size !== input.items.length) {
    throw new ToolExecutionError("invalid_arguments", "Design package item ids must be unique.");
  }

  const edgeIds = new Set(input.edges.map((edge) => edge.id));
  if (edgeIds.size !== input.edges.length) {
    throw new ToolExecutionError("invalid_arguments", "Design package edge ids must be unique.");
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


function isDomainPackage(kind: DesignPackageKind): boolean {
  return kind === "distributed_system" ||
    kind === "business_process" ||
    kind === "manufacturing_process";
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
  const inferred = inferCanvasLane(packageKind, toCanvasItemKind(itemKind));
  const genericDefault = inferCanvasLane(packageKind);
  return inferred === genericDefault ? undefined : inferred;
}
