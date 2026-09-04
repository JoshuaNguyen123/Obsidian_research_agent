import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace packages are installed as links from node_modules into this
 * repository, and npm writes those links as absolute paths. Building against
 * another checkout's node_modules — the usual shortcut when building inside a
 * git worktree — therefore points every `@agentic-researcher/*` import at the
 * checkout that ran `npm install`, while relative imports still resolve inside
 * the checkout being built.
 *
 * esbuild then bundles both copies of every workspace module. The bundle stays
 * valid, so nothing fails; it just carries two instances of every workspace
 * module, so `instanceof` and module-level singletons diverge between the
 * copies, and its minified names all shift, which reads exactly like a
 * non-deterministic toolchain and fails check:bundle-parity against artifacts
 * that are in fact correct.
 *
 * There are two ways to arrive there, and only the first one is a link:
 *
 *   - `<repoRoot>/node_modules/@agentic-researcher/*` exists but points into
 *     another checkout — a shared or junctioned node_modules.
 *   - `<repoRoot>/node_modules` does not exist at all. This is the default
 *     state of every fresh git worktree, and it is the worse case: node and
 *     esbuild walk up out of the checkout and resolve `@agentic-researcher/*`
 *     from the parent checkout. Measured 2026-09-04 in a worktree under
 *     `.claude/worktrees/`, before `npm ci`: 563 bundle inputs with 33
 *     workspace modules duplicated and a 102KB-larger main.js, the whole time
 *     this check reported that links resolve inside the checkout.
 *
 * Enumerating the scope directory can only ever see the first case; an absent
 * directory read as "nothing can be resolving out of the checkout", which is
 * backwards. So resolve each declared workspace package the way the bundler
 * resolves it — the first `node_modules/@agentic-researcher/<name>` found
 * walking up from the checkout — and demand that it land inside the checkout.
 */
export const WORKSPACE_LINK_SCOPE = "@agentic-researcher";

export const WORKSPACE_LINK_REINSTALL_HINT =
  "run npm install in this checkout instead of sharing another checkout's node_modules";

export function findStrayWorkspaceLinks(repoRoot, links) {
  const root = path.resolve(repoRoot);
  return links.filter(({ resolved }) => {
    const target = path.resolve(resolved);
    return target !== root && !target.startsWith(root + path.sep);
  });
}

export function formatStrayWorkspaceLinkError(repoRoot, stray) {
  const detail = stray
    .map(({ name, resolved }) => `  ${WORKSPACE_LINK_SCOPE}/${name} -> ${resolved}`)
    .join("\n");
  return [
    `Workspace links escape the checkout being built (${repoRoot}).`,
    detail,
    "Every workspace module would be bundled twice — once from this checkout and once from the linked one —",
    "so the bundle will not match the committed artifacts.",
    `Each name above resolves the way the bundler resolves it: the first node_modules/${WORKSPACE_LINK_SCOPE}/<name>`,
    "found walking up from the checkout. A checkout with no node_modules of its own resolves out of its parent.",
    WORKSPACE_LINK_REINSTALL_HINT,
  ].join("\n");
}

/**
 * The node_modules directories a bundler consults for a bare import, nearest
 * first. This is the lookup node and esbuild share, and it is the whole reason
 * an uninstalled checkout still resolves: the walk does not stop at the
 * checkout root.
 */
export function nodeModulesSearchPaths(fromDir) {
  const searchPaths = [];
  let dir = path.resolve(fromDir);
  for (;;) {
    if (path.basename(dir) !== "node_modules") {
      searchPaths.push(path.join(dir, "node_modules"));
    }
    const parent = path.dirname(dir);
    if (parent === dir) return searchPaths;
    dir = parent;
  }
}

async function expandWorkspaceGlobs(repoRoot, patterns) {
  const directories = [];
  for (const pattern of patterns) {
    const normalized = pattern.replaceAll("\\", "/");
    if (!normalized.includes("*")) {
      directories.push(path.resolve(repoRoot, normalized));
      continue;
    }
    if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
      // Guessing at a glob shape is how this check went blind the first time.
      throw new Error(
        `Unsupported workspace glob "${pattern}" in package.json. ` +
          "Extend expandWorkspaceGlobs in scripts/check-workspace-links.mjs so the " +
          "packages it matches keep being checked.",
      );
    }
    const parent = path.resolve(repoRoot, normalized.slice(0, -2));
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      // A glob whose directory does not exist matches no packages, so there is
      // nothing here to resolve out of the checkout.
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(path.join(parent, entry.name));
    }
  }
  return directories;
}

/**
 * Every workspace package name the root package.json declares, as the bare
 * name within WORKSPACE_LINK_SCOPE.
 */
export async function readWorkspacePackageNames(repoRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  const names = [];
  for (const directory of await expandWorkspaceGlobs(repoRoot, patterns)) {
    let declared;
    try {
      declared = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ).name;
    } catch {
      // A directory that npm would not treat as a workspace either.
      continue;
    }
    if (typeof declared !== "string") continue;
    if (!declared.startsWith(`${WORKSPACE_LINK_SCOPE}/`)) {
      throw new Error(
        `Workspace package "${declared}" (${directory}) is outside ${WORKSPACE_LINK_SCOPE}, ` +
          "so this check would not cover it. Extend WORKSPACE_LINK_SCOPE in " +
          "scripts/check-workspace-links.mjs to cover the new scope.",
      );
    }
    names.push(declared.slice(WORKSPACE_LINK_SCOPE.length + 1));
  }
  return names;
}

/**
 * Resolve each declared workspace package the way the bundler would, from the
 * checkout being built. `unresolved` names are not installed anywhere on the
 * walk, so nothing can be bundled from a stray checkout and the build reports
 * the missing import itself.
 */
export async function resolveWorkspacePackages(repoRoot) {
  const searchPaths = nodeModulesSearchPaths(repoRoot);
  const names = await readWorkspacePackageNames(repoRoot);
  const resolved = [];
  const unresolved = [];
  await Promise.all(
    names.map(async (name) => {
      for (const searchPath of searchPaths) {
        try {
          // realpath is the existence check and the canonicalisation at once,
          // and it follows the symlink or junction the way esbuild does.
          const target = await realpath(
            path.join(searchPath, WORKSPACE_LINK_SCOPE, name),
          );
          resolved.push({ name, resolved: target });
          return;
        } catch {
          // Not installed at this level; keep walking up.
        }
      }
      unresolved.push(name);
    }),
  );
  resolved.sort((left, right) => left.name.localeCompare(right.name));
  unresolved.sort((left, right) => left.localeCompare(right));
  return { resolved, unresolved };
}

export async function readWorkspaceLinks(repoRoot) {
  const scopeDir = path.join(repoRoot, "node_modules", WORKSPACE_LINK_SCOPE);
  let names;
  try {
    names = await readdir(scopeDir);
  } catch {
    // No installed workspace scope here. That is not "nothing to check" — see
    // resolveWorkspacePackages, which is what catches this case — but there is
    // no link in this checkout to read.
    return [];
  }
  return Promise.all(
    names.map(async (name) => ({
      name,
      resolved: await realpath(path.join(scopeDir, name)),
    })),
  );
}

export async function validateWorkspaceLinks(repoRoot) {
  const root = await realpath(repoRoot);
  const [installed, walked] = await Promise.all([
    // Links installed here can name packages the workspaces globs no longer
    // declare; the walk covers packages that are not installed here at all.
    readWorkspaceLinks(root),
    resolveWorkspacePackages(root),
  ]);
  const stray = [];
  const seen = new Set();
  for (const link of findStrayWorkspaceLinks(root, [
    ...installed,
    ...walked.resolved,
  ])) {
    if (seen.has(link.name)) continue;
    seen.add(link.name);
    stray.push(link);
  }
  if (stray.length > 0) {
    throw new Error(formatStrayWorkspaceLinkError(root, stray));
  }
  return walked;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { resolved, unresolved } = await validateWorkspaceLinks(repoRoot);
  if (resolved.length === 0) {
    console.log(
      `No workspace package resolves from this checkout (${unresolved.length} declared); ` +
        "run npm install before building.",
    );
    return;
  }
  const total = resolved.length + unresolved.length;
  console.log(
    `Workspace links resolve inside this checkout (${resolved.length}/${total} declared packages).`,
  );
  if (unresolved.length > 0) {
    console.log(
      `Not installed anywhere on the resolution walk: ${unresolved.join(", ")}. ` +
        "The build reports these as missing imports.",
    );
  }
}

const direct = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (direct) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
