import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  WORKSPACE_LINK_REINSTALL_HINT,
  findStrayWorkspaceLinks,
  formatStrayWorkspaceLinkError,
  readWorkspaceLinks,
  validateWorkspaceLinks,
} from "../scripts/check-workspace-links.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

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

test("this checkout's own workspace links resolve inside it", async () => {
  const links = await readWorkspaceLinks(repoRoot);
  // An install-less checkout has nothing to validate; a linked one must not
  // reach past its own root.
  for (const link of links) {
    assert.equal(
      path.resolve(link.resolved).startsWith(path.resolve(repoRoot)),
      true,
      `${link.name} resolves outside the checkout: ${link.resolved}`,
    );
  }
  await validateWorkspaceLinks(repoRoot);
});
