import { MAX_TOOL_RESULT_CHARS } from "./constants";
import { ToolExecutionError, ToolExecutionResult } from "./types";

export const BLOCKED_VAULT_ROOTS = new Set([
  ".agent-backups",
  ".obsidian",
  ".trash",
  "trash",
]);

interface VaultPathOptions {
  allowRoot?: boolean;
  requireMarkdown?: boolean;
  blockSystemPaths?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectNoArgs(args: Record<string, unknown>, toolName: string) {
  const keys = Object.keys(args);
  if (keys.length > 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `${toolName} does not accept arguments.`,
    );
  }
}

export function getRequiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be a non-empty string.`,
    );
  }

  return value;
}

export function getRequiredStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be an array of strings.`,
    );
  }

  if (value.length === 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to include at least one path.`,
    );
  }

  return value;
}

export function getString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be a string.`,
    );
  }

  return value;
}

export function getOptionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be a string.`,
    );
  }

  return value;
}

export function getOptionalInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be an integer.`,
    );
  }

  return value;
}

export function getOptionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be a boolean.`,
    );
  }

  return value;
}

export function assertSafeMarkdownPath(path: string) {
  normalizeVaultPath(path, { requireMarkdown: true });
}

/**
 * Non-markdown files a research note legitimately needs beside it: an exported
 * bibliography, an extracted data table, a small structured sidecar.
 *
 * This is a closed allowlist on a separate path, not a relaxation of
 * `assertSafeMarkdownPath`. Markdown-only tools keep rejecting every extension
 * in this list, and every other rejection in `normalizeVaultPath` — parent
 * traversal, absolute paths, drive letters, backslashes, empty segments, and
 * the `.obsidian` / `.trash` / `.agent-backups` roots — still applies first.
 *
 * Deliberately absent: anything executable or loadable (`.js`, `.mjs`, `.py`,
 * `.sh`, `.bat`, `.exe`), and anything Obsidian or a community plugin treats
 * as configuration. Widening this set is a safety decision, not a convenience
 * one — add an extension only with a research reason and a test.
 */
export const RESEARCH_DATA_FILE_EXTENSIONS: readonly string[] = [
  "bib",
  "ris",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "txt",
];

const RESEARCH_DATA_EXTENSION_SET = new Set(RESEARCH_DATA_FILE_EXTENSIONS);

export type VaultContentFileKind = "markdown" | "research_data";

export function getVaultPathExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension.
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

export function isResearchDataFilePath(path: string): boolean {
  return RESEARCH_DATA_EXTENSION_SET.has(getVaultPathExtension(path));
}

/**
 * Safe path for a file the agent may create beside a note: markdown, or one of
 * the allowlisted research data extensions. Returns which kind it is so the
 * caller can keep markdown-specific behavior (link rewriting, backups, note
 * indexing) off the data path.
 */
export function normalizeVaultContentPath(path: string): {
  path: string;
  kind: VaultContentFileKind;
} {
  const normalized = normalizeVaultPath(path);
  const extension = getVaultPathExtension(normalized);
  if (extension === "md") {
    return { path: normalized, kind: "markdown" };
  }
  if (RESEARCH_DATA_EXTENSION_SET.has(extension)) {
    return { path: normalized, kind: "research_data" };
  }
  throw new ToolExecutionError(
    "unsafe_path",
    `Only markdown files and research data files (${RESEARCH_DATA_FILE_EXTENSIONS.map(
      (candidate) => `.${candidate}`,
    ).join(", ")}) are allowed.`,
  );
}

export function normalizeVaultPath(
  path: string,
  {
    allowRoot = false,
    requireMarkdown = false,
    blockSystemPaths = true,
  }: VaultPathOptions = {},
): string {
  const normalized = path.trim().replace(/\/+$/, "");

  if (!normalized) {
    if (allowRoot) {
      return "";
    }

    throw new ToolExecutionError(
      "unsafe_path",
      "Unsafe path: a vault-relative path is required.",
    );
  }

  if (normalized.includes("..")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Unsafe path: parent traversal is not allowed.",
    );
  }

  if (normalized.includes("\\")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Unsafe path: backslashes are not allowed.",
    );
  }

  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Unsafe path: absolute paths are not allowed.",
    );
  }

  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === ".")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Unsafe path: empty or current-directory segments are not allowed.",
    );
  }

  if (blockSystemPaths && BLOCKED_VAULT_ROOTS.has(parts[0].toLowerCase())) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Unsafe path: system folders are not allowed.",
    );
  }

  if (requireMarkdown && !normalized.toLowerCase().endsWith(".md")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Only markdown files are allowed.",
    );
  }

  return normalized;
}

/**
 * Receipt/completion UI path check. Same vault-relative rules as writes:
 * `normalizeVaultPath` plus {@link BLOCKED_VAULT_ROOTS}, so `.obsidian/*.md`
 * cannot become a completion path. Notebooks are allowed beside markdown
 * because Results/Jupyter receipts use `.ipynb`.
 */
export function isSafeVaultResultPath(path: string): boolean {
  if (!path.trim()) {
    return false;
  }
  try {
    const normalized = normalizeVaultPath(path);
    return /\.(?:md|ipynb)$/iu.test(normalized);
  } catch {
    return false;
  }
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export function serializeToolResult(
  result: ToolExecutionResult,
  maxChars = MAX_TOOL_RESULT_CHARS,
): string {
  const serialized = JSON.stringify(result);
  if (serialized.length <= maxChars) {
    return serialized;
  }

  return JSON.stringify({
    ok: result.ok,
    toolName: result.toolName,
    truncated: true,
    output: truncateText(JSON.stringify(result.output ?? result.error), maxChars),
  });
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
