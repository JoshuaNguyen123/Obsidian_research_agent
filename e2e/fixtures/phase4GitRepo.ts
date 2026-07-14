import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Phase4GitFixture {
  root: string;
  baseSha: string;
  sourcePath: string;
  testPath: string;
  readSource(): Promise<string>;
  head(): Promise<string>;
  status(): Promise<string>;
  inspectWorktree(worktreeRoot: string): Promise<{
    head: string;
    status: string;
    source: string;
  }>;
  removeOwnedWorktree(worktreeRoot: string, branch: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * A bounded local repository with one deliberately broken implementation.
 * The initial commit is valid Git state; Phase 4 repair should change only
 * src/value.mjs, validate in fresh sandboxes, and create one local commit.
 */
export async function createPhase4GitFixture(
  marker: string,
): Promise<Phase4GitFixture> {
  // The trusted prompt binding and the workspace manager compare canonical
  // repository authority. Canonicalize at fixture creation so Windows 8.3
  // temp aliases and macOS /var aliases cannot make the prompt describe a
  // different root than the production tool verifies.
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "agentic-phase4-git-")),
  );
  const sourcePath = path.join(root, "src", "value.mjs");
  const testPath = path.join(root, "test", "value.test.mjs");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(testPath), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: `phase4-fixture-${marker.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
        private: true,
        type: "module",
        scripts: { test: "node --test test/value.test.mjs" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    sourcePath,
    [
      `export const fixtureMarker = ${JSON.stringify(marker)};`,
      "export function add(left, right) {",
      "  return left - right; // intentionally broken for the repair cycle",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    testPath,
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, fixtureMarker } from '../src/value.mjs';",
      "test('fixture repair', () => {",
      "  assert.equal(add(2, 2), 4);",
      `  assert.equal(fixtureMarker, ${JSON.stringify(marker)});`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Phase 4 E2E"]);
  await git(root, ["config", "user.email", "phase4-e2e@example.invalid"]);
  await git(root, ["add", "--", "package.json", "src/value.mjs", "test/value.test.mjs"]);
  await git(root, ["commit", "-m", "phase4 fixture baseline"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    await cleanupGitFixture(root);
    throw new Error("Phase 4 fixture did not produce a full Git SHA.");
  }
  return {
    root,
    baseSha,
    sourcePath,
    testPath,
    readSource: () => readFile(sourcePath, "utf8"),
    head: () => git(root, ["rev-parse", "HEAD"]),
    status: () => git(root, ["status", "--short"]),
    async inspectWorktree(worktreeRoot) {
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      return {
        head: await git(verified, ["rev-parse", "HEAD"]),
        status: await git(verified, ["status", "--short"]),
        source: await readFile(path.join(verified, "src", "value.mjs"), "utf8"),
      };
    },
    async removeOwnedWorktree(worktreeRoot, branch) {
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      await git(root, ["worktree", "remove", "--force", verified]);
      if (branch.startsWith("codex/workspace-")) {
        await git(root, ["branch", "-D", branch]).catch(() => "");
      }
    },
    cleanup: () => cleanupGitFixture(root),
  };
}

async function requireOwnedWorktree(
  repositoryRoot: string,
  worktreeRoot: string,
): Promise<string> {
  const verified = await realpath(worktreeRoot);
  if (path.basename(path.dirname(verified)).toLowerCase() !== "repository-worktrees") {
    throw new Error(`Phase 4 worktree is outside the owned repository-worktrees root: ${verified}`);
  }
  const listed = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
  const normalized = verified.replace(/\\/gu, "/").toLowerCase();
  const listedPaths = listed
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).replace(/\\/gu, "/").toLowerCase());
  if (!listedPaths.includes(normalized)) {
    throw new Error(`Git does not recognize the Phase 4 worktree: ${verified}`);
  }
  return verified;
}

async function git(
  cwd: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=NUL",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1_048_576,
    },
  );
  return stdout.trim();
}

async function cleanupGitFixture(root: string): Promise<void> {
  const verifiedRoot = await realpath(root).catch(() => null);
  if (!verifiedRoot) return;
  const verifiedTemp = await realpath(tmpdir());
  if (
    path.dirname(verifiedRoot) !== verifiedTemp ||
    !path.basename(verifiedRoot).startsWith("agentic-phase4-git-")
  ) {
    throw new Error(`Refusing to remove unowned Phase 4 Git fixture: ${verifiedRoot}`);
  }
  await rm(verifiedRoot, { recursive: true, force: true });
}
