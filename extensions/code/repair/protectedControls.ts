import type {
  ProtectedControlClassificationV1,
} from "./types";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const EXACT_ROOT_FILES = new Set([
  ".dockerignore",
  ".gitattributes",
  ".gitconfig",
  ".gitignore",
  ".gitmodules",
  ".lfsconfig",
  ".npmrc",
  ".nvmrc",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "cmakelists.txt",
  "compose.yaml",
  "compose.yml",
  "deno.json",
  "deno.jsonc",
  "docker-compose.yaml",
  "docker-compose.yml",
  "dockerfile",
  "go.mod",
  "go.sum",
  "go.work",
  "gradle.properties",
  "gradlew",
  "gradlew.bat",
  "makefile",
  "mvnw",
  "mvnw.cmd",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "poetry.lock",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "rust-toolchain",
  "rust-toolchain.toml",
  "settings.gradle",
  "settings.gradle.kts",
  "uv.lock",
  "yarn.lock",
]);

/** Reject paths that cannot safely identify a repository-relative artifact. */
export function assertSafeRepositoryRelativePath(path: string): string {
  if (typeof path !== "string") throw new TypeError("Repository path must be a string.");
  const normalized = path.trim().replace(/^\.\//, "");
  if (!normalized) throw new Error("Repository path cannot be empty.");
  if (normalized.length > 512) throw new Error("Repository path exceeds 512 characters.");
  if (CONTROL_CHARACTER.test(normalized)) {
    throw new Error("Repository path contains a control character.");
  }
  if (normalized.includes("\\")) {
    throw new Error("Repository path must use forward slashes.");
  }
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Repository path must be relative.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Repository path contains an unsafe segment.");
  }
  return normalized;
}

export function classifyProtectedControlChanges(
  changedPaths: readonly string[],
  profileProtectedPatterns: readonly string[] = [],
): ProtectedControlClassificationV1 {
  const paths = [...new Set(changedPaths.map(assertSafeRepositoryRelativePath))].sort();
  const profilePatterns = profileProtectedPatterns.map(normalizeGlobPattern);
  const protectedPaths = paths.filter(
    (path) => isBuiltInProtectedControl(path) || profilePatterns.some((glob) => matchesGlob(path, glob)),
  );
  const doubleExactPaths = protectedPaths.filter(isDoubleExactControl);
  return {
    level:
      doubleExactPaths.length > 0
        ? "double_exact"
        : protectedPaths.length > 0
          ? "exact"
          : "none",
    protectedPaths,
    doubleExactPaths,
  };
}

export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = assertSafeRepositoryRelativePath(path);
  const normalizedPattern = normalizeGlobPattern(pattern);
  let source = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      const followedBySlash = normalizedPattern[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(character);
  }
  source += "$";
  return new RegExp(source, "i").test(normalizedPath);
}

function normalizeGlobPattern(pattern: string): string {
  if (typeof pattern !== "string") throw new TypeError("Protected path pattern must be a string.");
  let normalized = pattern.trim().replace(/^\.\//, "");
  if (!normalized || normalized.length > 512 || CONTROL_CHARACTER.test(normalized)) {
    throw new Error("Protected path pattern is invalid.");
  }
  if (normalized.includes("\\") || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Protected path pattern must be repository-relative and use forward slashes.");
  }
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Protected path pattern contains an unsafe segment.");
  }
  if (normalized.endsWith("/")) normalized += "**";
  return normalized;
}

function isDoubleExactControl(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower === ".github/workflows" ||
    lower.startsWith(".github/workflows/") ||
    lower === ".circleci" ||
    lower.startsWith(".circleci/") ||
    lower === ".githooks" ||
    lower.startsWith(".githooks/") ||
    lower === ".husky" ||
    lower.startsWith(".husky/") ||
    lower === ".git/hooks" ||
    lower.startsWith(".git/hooks/") ||
    lower === "hooks" ||
    lower.startsWith("hooks/") ||
    lower === ".gitlab-ci.yml" ||
    lower === "azure-pipelines.yml" ||
    lower === "jenkinsfile" ||
    lower === ".pre-commit-config.yaml"
  );
}

function isBuiltInProtectedControl(path: string): boolean {
  if (isDoubleExactControl(path)) return true;
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const rootName = segments[0];
  if (EXACT_ROOT_FILES.has(lower)) return true;
  if (segments.length === 1) {
    if (/^requirements(?:[-_.][a-z0-9-]+)?\.txt$/.test(lower)) return true;
    if (/^(?:build|settings)\.gradle(?:\.kts)?$/.test(lower)) return true;
    if (/^(?:dockerfile)(?:\.[a-z0-9_.-]+)?$/.test(lower)) return true;
    if (/^[a-z0-9_.-]+\.(?:sln|csproj|fsproj|vbproj)$/.test(lower)) return true;
  }
  if (rootName === ".github" && segments[1] === "actions") return true;
  if (rootName === "gradle" && segments[1] === "wrapper") return true;
  if (rootName === ".mvn" && segments[1] === "wrapper") return true;
  if (rootName === "scripts") {
    return segments.some((segment) => /(?:^|[-_.])(build|ci|install|release|setup|test)(?:[-_.]|$)/.test(segment));
  }
  return false;
}

function escapeRegExp(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}
