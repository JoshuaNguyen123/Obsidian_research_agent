import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WORKSPACE_LINK_REINSTALL_HINT,
  findStrayWorkspaceLinks,
  formatStrayWorkspaceLinkError,
  nodeModulesSearchPaths,
  readWorkspaceLinks,
  readWorkspacePackageNames,
  resolveWorkspacePackages,
  validateWorkspaceLinks,
} from "../scripts/check-workspace-links.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * A checkout that declares `names` as workspace packages, laid out inside a
 * parent directory that owns the only installed copy of them — the shape of a
 * git worktree under a checkout that ran `npm install`.
 */
async function makeNestedCheckout(
  names: readonly string[],
  { installedLocally = false }: { installedLocally?: boolean } = {},
): Promise<{ parent: string; checkout: string; cleanup: () => Promise<void> }> {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "ws-links-")));
  const checkout = path.join(parent, "checkout");
  await mkdir(path.join(checkout, "packages"), { recursive: true });
  await writeFile(
    path.join(checkout, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  );
  for (const name of names) {
    const source = path.join(checkout, "packages", name);
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ name: `@agentic-researcher/${name}` }),
    );
    // The parent always owns a copy; only `installedLocally` also installs one
    // in the checkout, so the two cases differ by nothing but the local
    // node_modules the resolution walk is supposed to prefer.
    for (const root of installedLocally ? [parent, checkout] : [parent]) {
      const installed = path.join(root, "node_modules", "@agentic-researcher", name);
      await mkdir(installed, { recursive: true });
      await writeFile(
        path.join(installed, "package.json"),
        JSON.stringify({ name: `@agentic-researcher/${name}` }),
      );
    }
  }
  return {
    parent,
    checkout,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

test("links resolving inside the checkout being built are accepted", () => {
  const root = path.resolve("/repo");
  const links = [
    { name: "core-api", resolved: path.join(root, "packages", "core-api") },
    { name: "code-capability", resolved: path.join(root, "extensions", "code") },
  ];
  assert.deepEqual(findStrayWorkspaceLinks(root, links), []);
  assert.deepEqual(findStrayWorkspaceLinks(root, []), []);
});

test("a link into another checkout is stray even when the path looks similar", () => {
  const root = path.resolve("/repo");
  const sibling = path.resolve("/repo-probe");
  const links = [
    { name: "core-api", resolved: path.join(root, "packages", "core-api") },
    { name: "headless-runtime", resolved: path.join(sibling, "packages", "headless-runtime") },
  ];
  assert.deepEqual(findStrayWorkspaceLinks(root, links), [
    { name: "headless-runtime", resolved: path.join(sibling, "packages", "headless-runtime") },
  ]);
});

test("the error names the stray link and how to fix it", () => {
  const root = path.resolve("/repo");
  const stray = [
    { name: "headless-runtime", resolved: path.resolve("/elsewhere/packages/headless-runtime") },
  ];
  const message = formatStrayWorkspaceLinkError(root, stray);
  assert.match(message, /@agentic-researcher\/headless-runtime ->/u);
  assert.match(message, /bundled twice/u);
  assert.equal(message.includes(WORKSPACE_LINK_REINSTALL_HINT), true);
});

test("the resolution walk is the bundler's: nearest node_modules first, never nested", () => {
  const root = path.resolve("/a/b");
  assert.deepEqual(nodeModulesSearchPaths(root).slice(0, 2), [
    path.join(root, "node_modules"),
    path.join(path.resolve("/a"), "node_modules"),
  ]);
  // A node_modules ancestor contributes its parent's directory, not
  // node_modules/node_modules.
  const nested = path.join(root, "node_modules", "pkg");
  assert.deepEqual(nodeModulesSearchPaths(nested).slice(0, 2), [
    path.join(nested, "node_modules"),
    path.join(root, "node_modules"),
  ]);
});

test("a checkout with no node_modules of its own resolves out of its parent", async () => {
  // The regression: `<repoRoot>/node_modules/@agentic-researcher` being absent
  // used to read as "nothing can be resolving out of the checkout", which is
  // exactly backwards — it is the default state of a fresh git worktree, and
  // every workspace import lands in the parent checkout instead.
  const { parent, checkout, cleanup } = await makeNestedCheckout([
    "core-api",
    "headless-runtime",
  ]);
  try {
    const { resolved, unresolved } = await resolveWorkspacePackages(checkout);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(
      resolved.map((entry) => entry.resolved),
      [
        path.join(parent, "node_modules", "@agentic-researcher", "core-api"),
        path.join(parent, "node_modules", "@agentic-researcher", "headless-runtime"),
      ],
    );

    await assert.rejects(
      validateWorkspaceLinks(checkout),
      (error: Error) => {
        assert.match(error.message, /@agentic-researcher\/core-api ->/u);
        assert.match(error.message, /@agentic-researcher\/headless-runtime ->/u);
        assert.equal(error.message.includes(parent), true);
        assert.equal(error.message.includes(WORKSPACE_LINK_REINSTALL_HINT), true);
        return true;
      },
    );

    // The old scope-directory read is what went quiet here, and still is: the
    // walk is the part that has to speak.
    assert.deepEqual(await readWorkspaceLinks(checkout), []);
  } finally {
    await cleanup();
  }
});

test("a checkout that installed its own workspace packages resolves inside itself", async () => {
  // Same parent install as the failing case above; the local node_modules is
  // the only difference, so this pins that the walk prefers it rather than
  // failing on any parent copy at all.
  const { checkout, cleanup } = await makeNestedCheckout(["core-api"], {
    installedLocally: true,
  });
  try {
    const { resolved, unresolved } = await resolveWorkspacePackages(checkout);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(
      resolved.map((entry) => entry.resolved),
      [path.join(checkout, "node_modules", "@agentic-researcher", "core-api")],
    );
    await validateWorkspaceLinks(checkout);
  } finally {
    await cleanup();
  }
});

test("an installed link pointing at another checkout is still stray", async (t) => {
  const { parent, checkout, cleanup } = await makeNestedCheckout(["core-api"]);
  try {
    const scopeDir = path.join(checkout, "node_modules", "@agentic-researcher");
    await mkdir(scopeDir, { recursive: true });
    const outside = path.join(parent, "node_modules", "@agentic-researcher", "core-api");
    try {
      await symlink(
        outside,
        path.join(scopeDir, "core-api"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("This filesystem does not permit test symlink creation.");
      return;
    }
    const links = await readWorkspaceLinks(checkout);
    assert.deepEqual(links, [{ name: "core-api", resolved: outside }]);
    await assert.rejects(validateWorkspaceLinks(checkout), /core-api ->/u);
  } finally {
    await cleanup();
  }
});

test("a workspace package installed nowhere is left to the bundler to report", async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "ws-links-")));
  try {
    const checkout = path.join(parent, "checkout");
    const source = path.join(checkout, "packages", "absent-probe");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ name: "@agentic-researcher/absent-probe" }),
    );
    const { resolved, unresolved } = await resolveWorkspacePackages(checkout);
    assert.deepEqual(resolved, []);
    assert.deepEqual(unresolved, ["absent-probe"]);
    // Nothing resolves out of the checkout, so there is no silent duplication;
    // the build fails loudly on the missing import instead.
    await validateWorkspaceLinks(checkout);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the check refuses to go quiet on a package shape it cannot cover", async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "ws-links-")));
  try {
    const checkout = path.join(parent, "checkout");
    await mkdir(path.join(checkout, "packages", "other"), { recursive: true });
    await writeFile(
      path.join(checkout, "packages", "other", "package.json"),
      JSON.stringify({ name: "@somewhere-else/other" }),
    );
    await writeFile(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    await assert.rejects(
      readWorkspacePackageNames(checkout),
      /outside @agentic-researcher/u,
    );

    await writeFile(
      path.join(checkout, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/**/deep"] }),
    );
    await assert.rejects(
      readWorkspacePackageNames(checkout),
      /Unsupported workspace glob/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("every workspace package this repo declares is covered by the check", async () => {
  const names = await readWorkspacePackageNames(repoRoot);
  assert.equal(names.length > 0, true, "workspace glob expansion found no packages");
  // The two the duplication was measured on, so a glob that stops matching
  // packages/* cannot pass this quietly.
  assert.equal(names.includes("core-api"), true);
  assert.equal(names.includes("headless-runtime"), true);
});

test("this checkout's own workspace links resolve inside it", async () => {
  // Environment-dependent by design: this fails in a checkout that never ran
  // npm install, because that checkout resolves @agentic-researcher/* out of a
  // parent checkout and would bundle every workspace module twice. The fix is
  // to install in this checkout, the same as for the build.
  const links = await readWorkspaceLinks(repoRoot);
  for (const link of links) {
    assert.equal(
      path.resolve(link.resolved).startsWith(path.resolve(repoRoot)),
      true,
      `${link.name} resolves outside the checkout: ${link.resolved}`,
    );
  }
  await validateWorkspaceLinks(repoRoot);
});
