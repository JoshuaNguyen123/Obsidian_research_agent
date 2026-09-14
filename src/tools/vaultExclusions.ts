/**
 * Folders this plugin writes to itself. Anything under one of them is our own
 * output — a backup, a cached page, a run note, an index shard, an extracted
 * research memory — and must not come back as if it were the user's own note.
 *
 * These are the *default* names. Two of them are settings the user can point
 * elsewhere, which is why every caller derives its roots from the live
 * settings through {@link vaultExclusionRootsFromSettingsV1} rather than
 * trusting this list alone.
 */
export const GENERATED_OR_CACHE_PATH_PATTERNS = [
  /^\.agent-backups\//i,
  /^\.obsidian\//i,
  /^\.trash\//i,
  /^trash\//i,
  /^Agent Runs\//i,
  /^Agent Sources\//i,
  /^Agent Memory\//i,
  /^Agent Research Memory\//i,
];

/**
 * Settings that name a folder this plugin writes to.
 *
 * `isVaultPathExcluded` has always taken `extraRoots`, and no caller has ever
 * passed any — so the exclusion list was the hardcoded defaults and nothing
 * else. Two consequences, both silent. A user who moved the semantic index or
 * the research-memory folder in settings had the plugin's own output indexed
 * and returned as vault evidence. And `Agent Research Memory` was not in the
 * default list at all, so on a stock install the agent could retrieve its own
 * generated summaries of past research and cite them as if they were notes the
 * user had written.
 */
export interface VaultExclusionSettingsV1 {
  semanticIndexFolder?: string;
  researchMemoryFolder?: string;
  researchHubNote?: string;
}

export function vaultExclusionRootsFromSettingsV1(
  settings: VaultExclusionSettingsV1 | undefined | null,
): string[] {
  if (!settings) return [];
  return [settings.semanticIndexFolder, settings.researchMemoryFolder]
    .map((folder) => (typeof folder === "string" ? folder.trim() : ""))
    .filter((folder) => folder.length > 0);
}

export function isGeneratedOrCachePath(
  path: string,
  extraFolders: string[] = [],
): boolean {
  const normalized = normalizePathForMatch(path);
  if (!normalized) {
    return false;
  }
  if (GENERATED_OR_CACHE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return extraFolders
    .map(normalizeFolderForMatch)
    .filter((folder): folder is string => Boolean(folder))
    .some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}

export function filterUserMarkdownPaths(
  paths: string[],
  extraFolders: string[] = [],
): string[] {
  return paths.filter(
    (path) => /\.md$/i.test(path) && !isGeneratedOrCachePath(path, extraFolders),
  );
}

export function isVaultPathExcluded(
  path: string,
  options: { includeDerived?: boolean; extraRoots?: string[] } = {},
): boolean {
  if (options.includeDerived === false) {
    return isSystemVaultPath(path, options.extraRoots ?? []);
  }
  return isGeneratedOrCachePath(path, options.extraRoots ?? []);
}

export function isSourceCachePath(path: string): boolean {
  const normalized = normalizePathForMatch(path);
  return normalized === "Agent Sources" || normalized.startsWith("Agent Sources/");
}

export function isPathUnderVaultFolder(path: string, folder: string): boolean {
  const normalized = normalizePathForMatch(path).replace(/\/+$/g, "");
  const normalizedFolder = normalizeFolderForMatch(folder);
  return Boolean(
    normalizedFolder &&
      (normalized === normalizedFolder || normalized.startsWith(`${normalizedFolder}/`)),
  );
}

function isSystemVaultPath(path: string, extraFolders: string[]): boolean {
  const normalized = normalizePathForMatch(path);
  return (
    /^(?:\.agent-backups|\.obsidian|\.trash|trash|Agent Runs)(?:\/|$)/i.test(
      normalized,
    ) ||
    extraFolders
      .map(normalizeFolderForMatch)
      .filter((folder): folder is string => Boolean(folder))
      .some((folder) => normalized === folder || normalized.startsWith(`${folder}/`))
  );
}

function normalizePathForMatch(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeFolderForMatch(path: string): string | null {
  const normalized = normalizePathForMatch(path).replace(/\/+$/g, "");
  return normalized || null;
}
