import { MAX_TOOL_RESULT_CHARS } from "./constants";
import { ToolExecutionError, ToolExecutionResult } from "./types";

const BLOCKED_VAULT_ROOTS = new Set([
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
