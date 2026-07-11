import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";
import {
  extractRequestedVisibleTitle,
  isPlaceholderNoteBasename,
} from "./titleIntent";

const MAX_MISSION_TITLE_CHARS = 60;

export interface PlaceholderRenameReceipt {
  toolName: "rename_current_file";
  operation: "rename_current_file";
  path: string;
  toPath: string;
  title: string;
  previousTitle: string;
  changed: true;
  message: string;
  output: {
    path: string;
    toPath: string;
    title: string;
    previousTitle: string;
    changed: true;
    operation: "rename_current_file";
    bytesWritten: 0;
  };
}

/**
 * Prefer a leading H1, then an explicit title in the mission, then a short
 * mission-derived phrase. Reject empty / still-placeholder titles.
 */
export function resolveWritebackVisibleTitle(input: {
  leadingH1?: string | null;
  writtenMarkdown?: string | null;
  prompt: string;
  basename: string;
}): string | null {
  const fromH1 =
    cleanTitleCandidate(input.leadingH1) ??
    cleanTitleCandidate(extractLeadingH1Title(input.writtenMarkdown ?? ""));
  if (fromH1) {
    return fromH1;
  }

  const fromPrompt = cleanTitleCandidate(
    extractRequestedVisibleTitle(input.prompt, input.writtenMarkdown ?? ""),
  );
  if (fromPrompt) {
    return fromPrompt;
  }

  const fromMission = cleanTitleCandidate(deriveTitleFromMission(input.prompt));
  if (fromMission && !isPlaceholderNoteBasename(fromMission)) {
    return fromMission;
  }

  return null;
}

export function extractLeadingH1Title(markdown: string): string | null {
  const match =
    /^(?:[ \t]*\r?\n)*(?: {0,3})#(?:[ \t]+)(.+?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/.exec(
      markdown,
    );
  return match?.[1]?.trim() || null;
}

export function sanitizeFileBasename(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
}

export function getFolderPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex === -1 ? "" : `${path.slice(0, slashIndex + 1)}`;
}

export function allocateUniqueMarkdownPath(
  preferredPath: string,
  exists: (path: string) => boolean,
): string {
  if (!exists(preferredPath)) {
    return preferredPath;
  }

  const match = /^(.*?)(\.md)$/i.exec(preferredPath);
  const stem = match?.[1] ?? preferredPath;
  const ext = match?.[2] ?? ".md";
  let suffix = 2;
  while (exists(`${stem} ${suffix}${ext}`)) {
    suffix += 1;
  }
  return `${stem} ${suffix}${ext}`;
}

/**
 * After append/replace writeback onto Untitled / Untitled N, rename the file
 * from the resolved visible title. Returns null when no rename is needed.
 */
export async function maybeAutoRenamePlaceholderNote(input: {
  toolContext: ToolExecutionContext;
  prompt: string;
  leadingH1?: string | null;
  writtenMarkdown?: string | null;
  kind: "append" | "replace" | "edit";
}): Promise<PlaceholderRenameReceipt | null> {
  if (input.kind === "edit") {
    return null;
  }

  const file = resolveActiveMarkdownFile(input.toolContext);
  if (!file || !isPlaceholderNoteBasename(file.basename)) {
    return null;
  }

  const title = resolveWritebackVisibleTitle({
    leadingH1: input.leadingH1,
    writtenMarkdown: input.writtenMarkdown,
    prompt: input.prompt,
    basename: file.basename,
  });
  if (!title) {
    return null;
  }

  const safeBasename = sanitizeFileBasename(title);
  if (!safeBasename || isPlaceholderNoteBasename(safeBasename)) {
    return null;
  }
  if (safeBasename === file.basename) {
    return null;
  }

  const folder = getFolderPath(file.path);
  const preferred = normalizeVaultPath(`${folder}${safeBasename}.md`, {
    requireMarkdown: true,
  });
  const toPath = allocateUniqueMarkdownPath(preferred, (path) =>
    Boolean(getAbstractFile(input.toolContext, path)),
  );

  const fromPath = file.path;
  const previousTitle = file.basename;
  await renameVaultFile(input.toolContext, file, toPath);

  return {
    toolName: "rename_current_file",
    operation: "rename_current_file",
    path: fromPath,
    toPath,
    title: safeBasename,
    previousTitle,
    changed: true,
    message: `Renamed placeholder note from ${fromPath} to ${toPath}.`,
    output: {
      path: fromPath,
      toPath,
      title: safeBasename,
      previousTitle,
      changed: true,
      operation: "rename_current_file",
      bytesWritten: 0,
    },
  };
}

function cleanTitleCandidate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isPlaceholderNoteBasename(cleaned)) {
    return null;
  }
  if (/^(notes?|response|answer|output|result|draft)$/i.test(cleaned)) {
    return null;
  }
  return cleaned.slice(0, MAX_MISSION_TITLE_CHARS).trim() || null;
}

function deriveTitleFromMission(prompt: string): string | null {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const stripped = compact
    .replace(
      /^(?:please\s+)?(?:write|draft|compose|generate|create|stream|append|add)\b[\s\S]{0,40}?\b(?:me\s+)?(?:a\s+|an\s+|the\s+)?/i,
      "",
    )
    .replace(
      /\b(?:and\s+)?(?:stream|append|write|save|put)\b[\s\S]{0,40}\b(?:to|onto|on)\b[\s\S]{0,40}\b(?:page|note|file)\b.*$/i,
      "",
    )
    .replace(/\bwith\s+the\s+title\b.*$/i, "")
    .replace(/\b\d+\s*words?\b.*$/i, "")
    .replace(/[.?!:;]+$/g, "")
    .trim();

  if (!stripped || stripped.length < 3) {
    return null;
  }

  const words = stripped.split(/\s+/).slice(0, 8);
  return words.join(" ");
}

function resolveActiveMarkdownFile(
  toolContext: ToolExecutionContext,
): TFile | null {
  const file =
    toolContext.getCurrentMarkdownFile?.() ??
    toolContext.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    return null;
  }
  return file;
}

function getAbstractFile(
  toolContext: ToolExecutionContext,
  path: string,
): unknown {
  const vault = toolContext.app.vault as {
    getAbstractFileByPath?: (path: string) => unknown;
    getFileByPath?: (path: string) => unknown;
  };
  return vault.getAbstractFileByPath?.(path) ?? vault.getFileByPath?.(path) ?? null;
}

async function renameVaultFile(
  toolContext: ToolExecutionContext,
  file: TFile,
  toPath: string,
): Promise<void> {
  const vault = toolContext.app.vault as unknown as {
    rename?: (file: unknown, newPath: string) => Promise<void>;
  };
  if (typeof vault.rename !== "function") {
    throw new Error("Vault rename is not available.");
  }
  await vault.rename(file, toPath);
}
