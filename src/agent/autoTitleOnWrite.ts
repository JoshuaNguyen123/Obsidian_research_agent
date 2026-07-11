import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";
import {
  getFirstH1,
  sanitizeFileBasename,
} from "../tools/noteTitles";
import {
  isExplicitVisibleFileRenameIntent,
  isPlaceholderNoteBasename,
} from "./titleIntent";
import {
  allocateUniqueMarkdownPath,
  getFolderPath,
  maybeAutoRenamePlaceholderNote,
  type PlaceholderRenameReceipt,
} from "./placeholderNoteTitle";

const KEEP_TITLE_PATTERN =
  /\b(?:keep|preserve|do\s+not\s+change|don'?t\s+change|leave)\b[\s\S]{0,40}\b(?:title|name|filename|file\s+name)\b|\b(?:without|no)\s+(?:renaming|retitling|title\s+change)\b/i;

const GENERIC_BASENAMES = new Set([
  "untitled",
  "new note",
  "note",
  "notes",
  "draft",
  "document",
  "page",
  "temp",
  "temporary",
]);

const MIN_SUBSTANTIAL_WRITE_CHARS = 120;
const MIN_APPEND_CHARS_FOR_TITLE = 80;
const MAX_AUTO_TITLE_CHARS = 60;

export interface AutoTitleDecision {
  title: string | null;
  reason: string;
  skip: boolean;
}

/**
 * True for Untitled / Untitled N and other generic basenames that should not
 * stick as the visible note title after a real write.
 */
export function isGenericBasename(basename: string): boolean {
  const trimmed = basename.trim();
  if (!trimmed) return true;
  if (isPlaceholderNoteBasename(trimmed)) return true;
  const stem = trimmed.replace(/\.md$/i, "").trim().toLowerCase();
  if (GENERIC_BASENAMES.has(stem)) return true;
  return /^untitled(?:\s+\d+)?$/i.test(stem) || /^new\s+note(?:\s+\d+)?$/i.test(stem);
}

export function shouldSkipAutoTitle(input: {
  prompt: string;
  kind: "append" | "replace" | "edit";
  writtenChars?: number;
  autoTitleOnWrite?: boolean;
}): boolean {
  if (input.autoTitleOnWrite === false) {
    return true;
  }
  if (input.kind === "edit") {
    return true;
  }
  if (KEEP_TITLE_PATTERN.test(input.prompt)) {
    return true;
  }
  if (isExplicitVisibleFileRenameIntent(input.prompt)) {
    // Explicit rename is handled by rename_current_file / title intent path.
    return true;
  }
  const chars = input.writtenChars ?? 0;
  if (input.kind === "append" && chars > 0 && chars < MIN_APPEND_CHARS_FOR_TITLE) {
    return true;
  }
  return false;
}

/**
 * Prefer a leading H1, then a short mission-derived phrase. Reject empty /
 * still-generic titles.
 */
export function deriveAutoTitle(input: {
  prompt: string;
  writtenMarkdown?: string | null;
  basename: string;
}): string | null {
  const fromH1 = cleanTitleCandidate(getFirstH1(input.writtenMarkdown ?? "")?.text);
  if (fromH1) {
    return fromH1;
  }

  const fromMission = cleanTitleCandidate(deriveTitleFromMission(input.prompt));
  if (fromMission && !isGenericBasename(fromMission)) {
    return fromMission;
  }

  return null;
}

export function decideAutoTitle(input: {
  prompt: string;
  kind: "append" | "replace" | "edit";
  writtenMarkdown?: string | null;
  basename: string;
  writtenChars?: number;
  autoTitleOnWrite?: boolean;
}): AutoTitleDecision {
  if (
    shouldSkipAutoTitle({
      prompt: input.prompt,
      kind: input.kind,
      writtenChars: input.writtenChars,
      autoTitleOnWrite: input.autoTitleOnWrite,
    })
  ) {
    return { title: null, reason: "skipped_by_policy", skip: true };
  }

  const markdown = input.writtenMarkdown ?? "";
  const generic = isGenericBasename(input.basename);

  // Conservative: only rename visible file/tab for Untitled/generic basenames.
  // Named notes already get markdown H1/frontmatter updates from stream writeback.
  if (!generic) {
    return {
      title: null,
      reason: "basename_not_generic",
      skip: true,
    };
  }

  const title = deriveAutoTitle({
    prompt: input.prompt,
    writtenMarkdown: markdown,
    basename: input.basename,
  });
  if (!title) {
    return { title: null, reason: "no_safe_title", skip: true };
  }

  const safe = sanitizeFileBasename(title);
  if (!safe || isGenericBasename(safe) || safe === input.basename) {
    return { title: null, reason: "title_unchanged_or_generic", skip: true };
  }

  return { title: safe, reason: "generic_basename", skip: false };
}

/**
 * Runner-owned auto-title after stream/tool write. Prefer the existing
 * placeholder rename path when the note is still Untitled; otherwise rename
 * when policy allows (generic basename or substantial write + leading H1).
 */
export async function maybeAutoTitleAfterWrite(input: {
  toolContext: ToolExecutionContext;
  prompt: string;
  leadingH1?: string | null;
  writtenMarkdown?: string | null;
  kind: "append" | "replace" | "edit";
  writtenChars?: number;
}): Promise<PlaceholderRenameReceipt | null> {
  const settings = input.toolContext.settings as {
    autoTitleOnWrite?: boolean;
  };
  if (settings.autoTitleOnWrite === false) {
    return null;
  }

  const placeholder = await maybeAutoRenamePlaceholderNote({
    toolContext: {
      ...input.toolContext,
      autoTitleAuthorized: true,
    },
    prompt: input.prompt,
    leadingH1: input.leadingH1,
    writtenMarkdown: input.writtenMarkdown,
    kind: input.kind,
  });
  if (placeholder) {
    return placeholder;
  }

  const file = resolveActiveMarkdownFile(input.toolContext);
  if (!file) {
    return null;
  }

  const markdown =
    input.writtenMarkdown ??
    input.toolContext.getCurrentMarkdownContent?.(file) ??
    null;
  const decision = decideAutoTitle({
    prompt: input.prompt,
    kind: input.kind,
    writtenMarkdown: markdown,
    basename: file.basename,
    writtenChars: input.writtenChars ?? markdown?.length,
    autoTitleOnWrite: true,
  });
  if (decision.skip || !decision.title) {
    return null;
  }

  const folder = getFolderPath(file.path);
  const preferred = normalizeVaultPath(`${folder}${decision.title}.md`, {
    requireMarkdown: true,
  });
  const toPath = allocateUniqueMarkdownPath(preferred, (path) =>
    Boolean(getAbstractFile(input.toolContext, path)),
  );
  if (toPath === file.path) {
    return null;
  }

  const fromPath = file.path;
  const previousTitle = file.basename;
  await renameVaultFile(input.toolContext, file, toPath);

  return {
    toolName: "rename_current_file",
    operation: "rename_current_file",
    path: fromPath,
    toPath,
    title: decision.title,
    previousTitle,
    changed: true,
    message: `Auto-titled note from ${fromPath} to ${toPath}.`,
    output: {
      path: fromPath,
      toPath,
      title: decision.title,
      previousTitle,
      changed: true,
      operation: "rename_current_file",
      bytesWritten: 0,
    },
  };
}

function cleanTitleCandidate(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || isGenericBasename(cleaned)) return null;
  if (/^(notes?|response|answer|output|result|draft)$/i.test(cleaned)) {
    return null;
  }
  return cleaned.slice(0, MAX_AUTO_TITLE_CHARS).trim() || null;
}

function deriveTitleFromMission(prompt: string): string | null {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return null;

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

  if (!stripped || stripped.length < 3) return null;
  return stripped.split(/\s+/).slice(0, 8).join(" ");
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
