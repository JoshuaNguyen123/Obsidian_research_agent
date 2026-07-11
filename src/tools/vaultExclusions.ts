export const GENERATED_OR_CACHE_PATH_PATTERNS = [
  /^\.agent-backups\//i,
  /^\.obsidian\//i,
  /^\.trash\//i,
  /^trash\//i,
  /^Agent Runs\//i,
  /^Agent Sources\//i,
  /^Agent Memory\//i,
];

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
