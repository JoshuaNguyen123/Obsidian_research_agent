/**
 * File-name globs for the workspace's finding tools (`code_workspace_search`
 * `include`/`exclude`, `code_workspace_list` `glob`).
 *
 * The rules are the ones people know from ripgrep's `-g` and from
 * `.gitignore`, kept small enough to state in a tool description:
 *
 * - `*` is any run of characters inside one path segment, `?` one character,
 *   `[abc]` / `[!abc]` a character class, `{ts,tsx}` a choice.
 * - `**` is any number of whole segments, including none: `src/**` is
 *   everything under `src`, `**` + `/test_*.py` a test file at any depth.
 * - A pattern with no `/` is matched against the base name, so `*.ts` finds
 *   TypeScript at any depth and `node_modules` names that folder wherever it
 *   is. A pattern with a `/` is anchored at the workspace root (or at the
 *   folder being searched, whichever matches). A trailing `/` means "this
 *   folder and everything in it".
 * - Matching ignores case: workspace file systems on Windows and macOS do.
 *
 * Pure and dependency-free so a host can hold its own finder to the same
 * fixtures (a person and the agent should find the same files).
 */

export const MAX_WORKSPACE_GLOB_PATTERNS_V1 = 20;
export const MAX_WORKSPACE_GLOB_PATTERN_CHARS_V1 = 300;

export class WorkspaceGlobErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGlobErrorV1";
  }
}

export interface WorkspaceGlobV1 {
  /** The pattern as given, trimmed and with `\` read as `/`. */
  readonly pattern: string;
  /** True when the pattern names base names rather than root-anchored paths. */
  readonly basenameOnly: boolean;
  /** Does this workspace-relative path match? */
  matches(relativePath: string, searchRoot?: string): boolean;
  /**
   * Does this path, or any folder above it, match? This is how an exclude
   * pattern such as `dist` or `vendor/**` prunes a whole folder.
   */
  matchesPathOrAncestor(relativePath: string, searchRoot?: string): boolean;
}

/** Compile one glob. Throws WorkspaceGlobErrorV1 with a sentence for a bad one. */
export function compileWorkspaceGlobV1(rawPattern: string): WorkspaceGlobV1 {
  if (typeof rawPattern !== "string") {
    throw new WorkspaceGlobErrorV1("A glob must be a string.");
  }
  let pattern = rawPattern.trim().replace(/\\/gu, "/");
  if (!pattern) throw new WorkspaceGlobErrorV1("A glob cannot be empty.");
  if (pattern.length > MAX_WORKSPACE_GLOB_PATTERN_CHARS_V1) {
    throw new WorkspaceGlobErrorV1(
      `A glob can be at most ${MAX_WORKSPACE_GLOB_PATTERN_CHARS_V1} characters.`,
    );
  }
  if (/[\0\r\n]/u.test(pattern)) {
    throw new WorkspaceGlobErrorV1("A glob cannot contain control characters.");
  }
  while (pattern.startsWith("./")) pattern = pattern.slice(2);
  pattern = pattern.replace(/^\/+/u, "");
  if (pattern.endsWith("/")) pattern = `${pattern}**`;
  if (!pattern) throw new WorkspaceGlobErrorV1("A glob cannot be only slashes.");
  const basenameOnly = !pattern.includes("/");
  const expression = new RegExp(`^${globBodyToRegExpSource(pattern)}$`, "iu");
  const test = (candidate: string): boolean => expression.test(candidate);

  const candidatesFor = (relativePath: string, searchRoot?: string): string[] => {
    const normalized = normalizeRelative(relativePath);
    if (basenameOnly) {
      return [normalized.slice(normalized.lastIndexOf("/") + 1)];
    }
    const out = [normalized];
    const root = searchRoot ? normalizeRelative(searchRoot) : "";
    if (root && (normalized === root || normalized.startsWith(`${root}/`))) {
      const inner = normalized === root ? "" : normalized.slice(root.length + 1);
      if (inner) out.push(inner);
    }
    return out;
  };

  return {
    pattern,
    basenameOnly,
    matches(relativePath, searchRoot) {
      return candidatesFor(relativePath, searchRoot).some(test);
    },
    matchesPathOrAncestor(relativePath, searchRoot) {
      const normalized = normalizeRelative(relativePath);
      const segments = normalized.split("/").filter(Boolean);
      for (let length = segments.length; length >= 1; length -= 1) {
        const prefix = segments.slice(0, length).join("/");
        if (candidatesFor(prefix, searchRoot).some(test)) return true;
      }
      return false;
    },
  };
}

/**
 * Compile a list of globs from a tool argument. `undefined`/`null` is no
 * filter; anything else must be a string or an array of strings.
 */
export function compileWorkspaceGlobListV1(
  value: unknown,
  label: string,
): WorkspaceGlobV1[] {
  if (value === undefined || value === null) return [];
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) {
    throw new WorkspaceGlobErrorV1(`${label} must be a glob or a list of globs.`);
  }
  if (list.length > MAX_WORKSPACE_GLOB_PATTERNS_V1) {
    throw new WorkspaceGlobErrorV1(
      `${label} can hold at most ${MAX_WORKSPACE_GLOB_PATTERNS_V1} globs.`,
    );
  }
  const compiled: WorkspaceGlobV1[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") {
      throw new WorkspaceGlobErrorV1(`Every ${label} glob must be a string.`);
    }
    if (!entry.trim()) continue;
    try {
      compiled.push(compileWorkspaceGlobV1(entry));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new WorkspaceGlobErrorV1(`${label} glob ${JSON.stringify(entry)}: ${message}`);
    }
  }
  return compiled;
}

/**
 * The include/exclude rule shared by every finder: a file passes when no
 * exclude matches it or a folder above it, and, when includes are given, at
 * least one include matches it.
 */
export function workspaceGlobFilterAcceptsV1(
  relativePath: string,
  filter: {
    include: readonly WorkspaceGlobV1[];
    exclude: readonly WorkspaceGlobV1[];
    searchRoot?: string;
  },
): boolean {
  if (filter.exclude.some((glob) => glob.matchesPathOrAncestor(relativePath, filter.searchRoot))) {
    return false;
  }
  return (
    filter.include.length === 0 ||
    filter.include.some((glob) => glob.matches(relativePath, filter.searchRoot))
  );
}

/** May a walk skip this whole folder because an exclude names it? */
export function workspaceGlobFilterPrunesFolderV1(
  relativeFolder: string,
  filter: { exclude: readonly WorkspaceGlobV1[]; searchRoot?: string },
): boolean {
  return filter.exclude.some((glob) =>
    glob.matchesPathOrAncestor(relativeFolder, filter.searchRoot),
  );
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "").replace(/^\/+|\/+$/gu, "");
}

function globBodyToRegExpSource(pattern: string): string {
  let source = "";
  let index = 0;
  let braceDepth = 0;
  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const atSegmentStart = index === 0 || pattern[index - 1] === "/";
        const next = pattern[index + 2];
        if (atSegmentStart && next === "/") {
          // `**/` — zero or more whole segments.
          source += "(?:[^/]*/)*";
          index += 3;
          continue;
        }
        if (atSegmentStart && next === undefined) {
          // trailing `**` — everything below, or nothing when it follows a `/`.
          source = source.endsWith("/") ? `${source.slice(0, -1)}(?:/.*)?` : `${source}.*`;
          index += 2;
          continue;
        }
        // `**` inside a segment behaves like `*`.
        source += "[^/]*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (character === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      if (!body) throw new WorkspaceGlobErrorV1("A character class cannot be empty.");
      const escaped = body.replace(/[\\\]^]/gu, "\\$&");
      source += negated ? `[^/${escaped}]` : `[${escaped}]`;
      index = close + 1;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      if (braceDepth > 3) throw new WorkspaceGlobErrorV1("Choices can nest at most three deep.");
      source += "(?:";
      index += 1;
      continue;
    }
    if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
      source += ")";
      index += 1;
      continue;
    }
    if (character === "," && braceDepth > 0) {
      source += "|";
      index += 1;
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    index += 1;
  }
  if (braceDepth !== 0) throw new WorkspaceGlobErrorV1("A choice { … } is not closed.");
  return source;
}
