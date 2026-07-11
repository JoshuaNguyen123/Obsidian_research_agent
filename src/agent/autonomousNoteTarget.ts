/**
 * Host-owned safe allocation and lazy creation for active-or-new-note output.
 * Does not weaken create_file intent checks; runner invokes this path only.
 */

import type { App, TFile } from "obsidian";
import { normalizeVaultPath } from "../tools/validation";
import {
  allocateUniqueMarkdownPath,
  getFolderPath,
  sanitizeFileBasename,
} from "./placeholderNoteTitle";

const UNSAFE_FOLDER_SEGMENTS = new Set([
  ".obsidian",
  ".git",
  ".agent-backups",
  "node_modules",
]);

export interface AutonomousNoteTargetPlan {
  /** Vault-relative markdown path; unique and not yet created. */
  path: string;
  folder: string;
  basename: string;
  reason:
    | "explicit_folder"
    | "active_parent"
    | "obsidian_new_file_parent"
    | "vault_root";
}

export interface ResolveAutonomousNoteTargetInput {
  app: App;
  /** Optional vault-relative folder or file path from user intent. */
  explicitFolderOrPath?: string | null;
  /** Parent folder of the active note when creating a sibling. */
  activeNotePath?: string | null;
  /** Preferred basename without .md (Untitled until auto-title). */
  preferredBasename?: string;
  exists?: (path: string) => boolean;
}

export function resolveAutonomousNoteTarget(
  input: ResolveAutonomousNoteTargetInput,
): AutonomousNoteTargetPlan {
  const exists =
    input.exists ??
    ((path: string) => Boolean(input.app.vault.getAbstractFileByPath(path)));
  const preferredBasename = sanitizeFileBasename(
    input.preferredBasename?.trim() || "Untitled",
  ) || "Untitled";

  let folder = "";
  let reason: AutonomousNoteTargetPlan["reason"] = "vault_root";

  const explicit = normalizeSafeFolder(input.explicitFolderOrPath);
  if (explicit !== null) {
    folder = explicit;
    reason = "explicit_folder";
  } else if (input.activeNotePath) {
    try {
      const active = normalizeVaultPath(input.activeNotePath, {
        requireMarkdown: true,
      });
      folder = getFolderPath(active).replace(/\/$/, "");
      reason = "active_parent";
    } catch {
      // fall through
    }
  }

  if (reason === "vault_root" || (folder === "" && reason !== "explicit_folder")) {
    const parent = resolveObsidianNewFileParent(input.app);
    if (parent !== null) {
      folder = parent;
      reason = "obsidian_new_file_parent";
    } else {
      folder = "";
      reason = "vault_root";
    }
  }

  assertSafeFolder(folder);
  const preferredPath = folder
    ? `${folder}/${preferredBasename}.md`
    : `${preferredBasename}.md`;
  const uniquePath = allocateUniqueMarkdownPath(preferredPath, exists);
  const normalized = normalizeVaultPath(uniquePath, { requireMarkdown: true });

  return {
    path: normalized,
    folder: getFolderPath(normalized).replace(/\/$/, ""),
    basename: normalized.replace(/^.*\//, "").replace(/\.md$/i, ""),
    reason,
  };
}

/**
 * Create a markdown note only when first safe content is ready.
 * Never overwrites; returns the created TFile.
 */
export async function createAutonomousNoteTarget(input: {
  app: App;
  path: string;
  initialContent?: string;
}): Promise<{ file: TFile; path: string; bytesWritten: number }> {
  const path = normalizeVaultPath(input.path, { requireMarkdown: true });
  if (input.app.vault.getAbstractFileByPath(path)) {
    throw new Error(`Autonomous note target already exists: ${path}`);
  }

  const folder = getFolderPath(path).replace(/\/$/, "");
  if (folder) {
    await ensureFolderTree(input.app, folder);
  }

  const content = input.initialContent ?? "";
  const file = await input.app.vault.create(path, content);
  return {
    file,
    path: file.path,
    bytesWritten: new TextEncoder().encode(content).length,
  };
}

export async function renameAutonomousNoteViaFileManager(input: {
  app: App;
  file: TFile;
  toPath: string;
}): Promise<TFile> {
  const toPath = normalizeVaultPath(input.toPath, { requireMarkdown: true });
  if (input.app.vault.getAbstractFileByPath(toPath)) {
    throw new Error(`Rename target already exists: ${toPath}`);
  }
  const fileManager = input.app.fileManager as {
    renameFile?: (file: TFile, newPath: string) => Promise<void>;
  };
  if (typeof fileManager.renameFile === "function") {
    await fileManager.renameFile(input.file, toPath);
  } else {
    await input.app.vault.rename(input.file, toPath);
  }
  const renamed = input.app.vault.getFileByPath(toPath);
  if (!renamed) {
    throw new Error(`Rename succeeded but file missing at ${toPath}`);
  }
  return renamed;
}

function resolveObsidianNewFileParent(app: App): string | null {
  try {
    const fileManager = app.fileManager as {
      getNewFileParent?: (sourcePath?: string) => { path: string } | null;
    };
    const parent = fileManager.getNewFileParent?.("");
    if (parent && typeof parent.path === "string") {
      const normalized = parent.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (normalized === "/" || normalized === "") {
        return "";
      }
      assertSafeFolder(normalized);
      return normalized;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeSafeFolder(value: string | null | undefined): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  let raw = value.trim().replace(/\\/g, "/");
  if (raw.toLowerCase().endsWith(".md")) {
    raw = getFolderPath(raw).replace(/\/$/, "");
  }
  raw = raw.replace(/^\/+|\/+$/g, "");
  if (!raw) {
    return "";
  }
  try {
    // Treat as a folder path: append a dummy file for normalize, then strip.
    const asFile = normalizeVaultPath(`${raw}/.keep.md`, {
      requireMarkdown: true,
    });
    const folder = getFolderPath(asFile).replace(/\/$/, "");
    assertSafeFolder(folder);
    return folder;
  } catch {
    return null;
  }
}

function assertSafeFolder(folder: string): void {
  if (!folder) {
    return;
  }
  if (
    folder.includes("..") ||
    folder.includes("\\") ||
    /^[a-zA-Z]:/.test(folder) ||
    folder.startsWith("/")
  ) {
    throw new Error(`Unsafe autonomous note folder: ${folder}`);
  }
  for (const segment of folder.split("/")) {
    if (!segment) {
      continue;
    }
    if (UNSAFE_FOLDER_SEGMENTS.has(segment.toLowerCase())) {
      throw new Error(`Unsafe autonomous note folder segment: ${segment}`);
    }
  }
}

async function ensureFolderTree(app: App, folder: string): Promise<void> {
  const parts = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (app.vault.getAbstractFileByPath(current)) {
      continue;
    }
    try {
      await app.vault.createFolder(current);
    } catch (error) {
      if (!app.vault.getAbstractFileByPath(current)) {
        throw error;
      }
    }
  }
}
