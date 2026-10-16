/**
 * Folders a walk of a code workspace leaves out unless it is asked for them.
 *
 * `WORKSPACE_INVENTORY_IGNORED_DIRECTORIES_V1` is the set sandbox staging and
 * the repository-profile inventory have always skipped (it moved here from
 * CodeExtensionRuntimeV2 unchanged, so staging behaves exactly as before).
 * Listing adds the Python caches on top: they are build output too, and a
 * tree full of `__pycache__` folders is noise to a reader.
 *
 * Names are compared lower-cased.
 */
export const WORKSPACE_INVENTORY_IGNORED_DIRECTORIES_V1: ReadonlySet<string> = new Set([
  ".git",
  ".agent-backups",
  ".cache",
  ".gradle",
  ".idea",
  ".next",
  ".pytest_cache",
  ".venv",
  ".vscode",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "vendor",
]);

export const WORKSPACE_LISTING_SKIPPED_DIRECTORIES_V1: ReadonlySet<string> = new Set([
  ...WORKSPACE_INVENTORY_IGNORED_DIRECTORIES_V1,
  "__pycache__",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
]);

/** Is this folder name one a listing leaves out unless asked? */
export function isWorkspaceListingSkippedDirectoryV1(name: string): boolean {
  return WORKSPACE_LISTING_SKIPPED_DIRECTORIES_V1.has(name.toLowerCase());
}
