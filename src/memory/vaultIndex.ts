import type { TFile } from "obsidian";
import { MAX_LISTED_FILES } from "../tools/constants";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";

interface MetadataCacheLike {
  getFileCache?: (file: TFile) => MetadataFileCacheLike | null;
}

interface MetadataFileCacheLike {
  headings?: Array<{ heading: string; level: number }>;
  tags?: Array<{ tag: string }>;
  links?: Array<{ link: string; displayText?: string; original?: string }>;
  frontmatter?: Record<string, unknown>;
}

export interface VaultIndexFileMetadata {
  path: string;
  basename: string;
  extension: string;
  mtime: number;
  headings: Array<{ heading: string; level: number }>;
  tags: string[];
  links: Array<{ link: string; displayText?: string; original?: string }>;
}

export interface VaultMetadataIndex {
  files: VaultIndexFileMetadata[];
  truncated: boolean;
  limit: number;
}

export interface BuildVaultMetadataIndexOptions {
  folder?: string;
  limit?: number;
  includeNonMarkdown?: boolean;
}

export function buildVaultMetadataIndex(
  context: ToolExecutionContext,
  {
    folder,
    limit = MAX_LISTED_FILES,
    includeNonMarkdown = false,
  }: BuildVaultMetadataIndexOptions = {},
): VaultMetadataIndex {
  const folderPath =
    folder === undefined
      ? null
      : normalizeVaultPath(folder, { allowRoot: true });
  const cappedLimit = clampPositiveInteger(limit, 1, MAX_LISTED_FILES);
  const metadataCache = getMetadataCache(context);
  const files = context.app.vault
    .getFiles()
    .filter((file) => includeNonMarkdown || file.extension === "md")
    .filter((file) => !isBlockedSystemPath(file.path))
    .filter((file) => isFileInFolder(file.path, folderPath))
    .sort(compareFilesByPath)
    .map((file) => formatFileMetadata(file, metadataCache));

  return {
    files: files.slice(0, cappedLimit),
    truncated: files.length > cappedLimit,
    limit: cappedLimit,
  };
}

function formatFileMetadata(
  file: TFile,
  metadataCache: MetadataCacheLike,
): VaultIndexFileMetadata {
  const cache = metadataCache.getFileCache?.(file) ?? null;

  return {
    path: file.path,
    basename: file.basename,
    extension: file.extension.toLowerCase(),
    mtime: getFileMtime(file),
    headings: readHeadings(cache),
    tags: readTags(cache),
    links: readLinks(cache),
  };
}

function getMetadataCache(context: ToolExecutionContext): MetadataCacheLike {
  return (
    (context.app as unknown as { metadataCache?: MetadataCacheLike })
      .metadataCache ?? {}
  );
}

function readHeadings(
  cache: MetadataFileCacheLike | null,
): Array<{ heading: string; level: number }> {
  return (cache?.headings ?? [])
    .filter(
      (heading) =>
        typeof heading.heading === "string" &&
        typeof heading.level === "number" &&
        Number.isFinite(heading.level),
    )
    .map((heading) => ({
      heading: heading.heading,
      level: heading.level,
    }));
}

function readTags(cache: MetadataFileCacheLike | null): string[] {
  return dedupeStrings([
    ...(cache?.tags ?? []).map((tag) => normalizeTag(tag.tag)),
    ...frontmatterValueToStrings(cache?.frontmatter?.tags).map(normalizeTag),
    ...frontmatterValueToStrings(cache?.frontmatter?.tag).map(normalizeTag),
  ]).filter(Boolean);
}

function readLinks(
  cache: MetadataFileCacheLike | null,
): Array<{ link: string; displayText?: string; original?: string }> {
  return (cache?.links ?? [])
    .filter((link) => typeof link.link === "string" && link.link.trim())
    .map((link) => ({
      link: link.link,
      ...(typeof link.displayText === "string"
        ? { displayText: link.displayText }
        : {}),
      ...(typeof link.original === "string" ? { original: link.original } : {}),
    }));
}

function frontmatterValueToStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((item) => frontmatterValueToStrings(item))
      .filter(Boolean);
  }

  return [];
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function getFileMtime(file: TFile): number {
  const mtime = file.stat?.mtime;
  return typeof mtime === "number" && Number.isFinite(mtime) ? mtime : 0;
}

function isFileInFolder(path: string, folderPath: string | null): boolean {
  if (folderPath === null || folderPath === "") {
    return true;
  }

  return path.startsWith(`${folderPath}/`);
}

function compareFilesByPath(left: TFile, right: TFile): number {
  return left.path.localeCompare(right.path);
}

function isBlockedSystemPath(path: string): boolean {
  return /^(?:\.agent-backups|\.obsidian|\.trash|trash)(?:\/|$)/i.test(path);
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}
