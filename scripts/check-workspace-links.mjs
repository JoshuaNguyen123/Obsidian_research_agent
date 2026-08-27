import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace packages are installed as links from node_modules into this
 * repository, and npm writes those links as absolute paths. Sharing one
 * node_modules across checkouts — the usual shortcut when building inside a
 * git worktree — therefore points every `@agentic-researcher/*` import at the
 * checkout that ran `npm install`, while relative imports still resolve inside
 * the checkout being built.
 *
 * esbuild then bundles both copies of every workspace module. The bundle stays
 * valid, so nothing fails; it just grows and its minified names all shift,
 * which reads exactly like a non-deterministic toolchain and fails
 * check:bundle-parity against artifacts that are in fact correct.
 *
 * Resolving each link and demanding it land inside the checkout being built
 * turns that silent duplication into a build error naming the stray checkout.
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
    WORKSPACE_LINK_REINSTALL_HINT,
  ].join("\n");
}

export async function readWorkspaceLinks(repoRoot) {
  const scopeDir = path.join(repoRoot, "node_modules", WORKSPACE_LINK_SCOPE);
  let names;
  try {
    names = await readdir(scopeDir);
  } catch {
    // No installed workspace scope: nothing can be resolving out of the
    // checkout, and the bundle build reports any genuinely missing import.
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
  const stray = findStrayWorkspaceLinks(root, await readWorkspaceLinks(root));
  if (stray.length > 0) {
    throw new Error(formatStrayWorkspaceLinkError(root, stray));
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await validateWorkspaceLinks(repoRoot);
  console.log("Workspace links resolve inside this checkout.");
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
