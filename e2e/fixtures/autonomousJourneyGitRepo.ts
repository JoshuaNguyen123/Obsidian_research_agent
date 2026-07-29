import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AutonomousJourneyPythonFixture {
  root: string;
  baseSha: string;
  marker: string;
  runAcceptance(worktreeRoot?: string): Promise<string>;
  assertProtectedContract(directoryRoot: string): Promise<void>;
  snapshotTree(directoryRoot: string): Promise<Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>>;
  inspectWorktree(worktreeRoot: string): Promise<{
    head: string;
    commitCount: number;
    status: string;
    changedPaths: string[];
    moduleSource: string;
    readme: string;
  }>;
  removeOwnedWorktree(worktreeRoot: string, branch: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Real behavioral contract for the final BYOK journey.
 *
 * The repository starts red: its protected acceptance suite imports a public
 * CRDT API that does not exist yet. The issue tells the agent the public
 * behavior, but not which tools to call or how to implement it. Passing this
 * fixture therefore proves executable behavior instead of marker-shaped text.
 */
export async function createAutonomousJourneyPythonFixture(
  marker: string,
): Promise<AutonomousJourneyPythonFixture> {
  const safeMarker = marker.replace(/[^A-Za-z0-9_]/gu, "_");
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "agentic-autonomous-journey-")),
  );
  try {
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(
    path.join(root, ".gitignore"),
    ["__pycache__/", "*.py[cod]", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "README.md"),
    "# CRDT sync library\n\nImplementation pending.\n",
    "utf8",
  );
  const verifierSource = [
      "from pathlib import Path",
      "import subprocess",
      "import sys",
      "",
      `MARKER = ${JSON.stringify(safeMarker)}`,
      "readme = Path('README.md').read_text(encoding='utf-8')",
      "if MARKER not in readme:",
      "    print(f'README.md must include proof marker {MARKER}', file=sys.stderr)",
      "    raise SystemExit(1)",
      "result = subprocess.run(",
      "    [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_crdt_contract.py', '-v', '-f'],",
      "    check=False,",
      ")",
      "raise SystemExit(result.returncode)",
      "",
    ].join("\n");
  await writeFile(
    path.join(root, "scripts", "verify_project.py"),
    verifierSource,
    "utf8",
  );
  const acceptanceSource = [
      "import unittest",
      "",
      "from crdt_sync import GCounter, ORSet, PROOF_MARKER",
      "",
      "",
      "class GCounterContract(unittest.TestCase):",
      "    def test_increment_merge_and_value(self):",
      "        left = GCounter('left')",
      "        right = GCounter('right')",
      "        left.increment()",
      "        left.increment(2)",
      "        right.increment(4)",
      "        left.merge(right)",
      "        right.merge(left)",
      "        self.assertEqual(left.value, 7)",
      "        self.assertEqual(right.value, 7)",
      "",
      "    def test_merge_is_idempotent_and_never_decreases(self):",
      "        left = GCounter('left')",
      "        right = GCounter('right')",
      "        left.increment(3)",
      "        right.increment(2)",
      "        left.merge(right)",
      "        first = left.value",
      "        left.merge(right)",
      "        self.assertEqual(left.value, first)",
      "        right.merge(left)",
      "        self.assertEqual(right.value, first)",
      "",
      "",
      "class ORSetContract(unittest.TestCase):",
      "    def test_observed_remove_and_concurrent_add(self):",
      "        left = ORSet('left')",
      "        right = ORSet('right')",
      "        left.add('alpha')",
      "        right.merge(left)",
      "        left.remove('alpha')",
      "        right.add('alpha')",
      "        left.merge(right)",
      "        right.merge(left)",
      "        self.assertIn('alpha', left.value)",
      "        self.assertEqual(left.value, right.value)",
      "",
      "    def test_remove_after_observing_all_tags_converges(self):",
      "        left = ORSet('left')",
      "        right = ORSet('right')",
      "        left.add('alpha')",
      "        right.add('alpha')",
      "        left.merge(right)",
      "        right.merge(left)",
      "        left.remove('alpha')",
      "        right.merge(left)",
      "        left.merge(right)",
      "        self.assertNotIn('alpha', left.value)",
      "        self.assertEqual(left.value, right.value)",
      "",
      "",
      "class DeliveryContract(unittest.TestCase):",
      "    def test_marker_identifies_this_run(self):",
      `        self.assertEqual(PROOF_MARKER, ${JSON.stringify(safeMarker)})`,
      "",
      "",
      "if __name__ == '__main__':",
      "    unittest.main()",
      "",
    ].join("\n");
  await writeFile(
    path.join(root, "tests", "test_crdt_contract.py"),
    acceptanceSource,
    "utf8",
  );
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Agentic Researcher"]);
  await git(root, [
    "config",
    "user.email",
    "agentic-researcher@example.invalid",
  ]);
  await git(root, [
    "add",
    "--",
    ".gitignore",
    "README.md",
    "scripts/verify_project.py",
    "tests/test_crdt_contract.py",
  ]);
  await git(root, ["commit", "-m", "seed protected CRDT acceptance contract"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    await rm(root, { recursive: true, force: true });
    throw new Error("Autonomous journey fixture did not produce a full Git SHA.");
  }

  return {
    root,
    baseSha,
    marker: safeMarker,
    async runAcceptance(worktreeRoot = root) {
      const verified = await requireFixturePath(root, worktreeRoot);
      await assertProtectedFile(
        verified,
        "scripts/verify_project.py",
        verifierSource,
      );
      await assertProtectedFile(
        verified,
        "tests/test_crdt_contract.py",
        acceptanceSource,
      );
      const output = await runPython(verified, [
        "-B",
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests",
        "-p",
        "test_crdt_contract.py",
        "-v",
        "-f",
      ]);
      const readme = await readFile(path.join(verified, "README.md"), "utf8");
      if (!readme.includes(safeMarker)) {
        throw new Error(`README.md must include proof marker ${safeMarker}.`);
      }
      return output;
    },
    async assertProtectedContract(directoryRoot) {
      const verified = await realpath(directoryRoot);
      await assertProtectedFile(
        verified,
        "scripts/verify_project.py",
        verifierSource,
      );
      await assertProtectedFile(
        verified,
        "tests/test_crdt_contract.py",
        acceptanceSource,
      );
    },
    snapshotTree: (directoryRoot) => snapshotDirectoryTree(directoryRoot),
    async inspectWorktree(worktreeRoot) {
      const verified = await requireFixturePath(root, worktreeRoot);
      const changed = await git(verified, [
        "diff",
        "--name-only",
        baseSha,
        "HEAD",
        "--",
      ]);
      const commitCountText = await git(verified, [
        "rev-list",
        "--count",
        `${baseSha}..HEAD`,
      ]);
      const commitCount = Number.parseInt(commitCountText, 10);
      if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
        throw new Error(
          `Unable to count fixture commits from ${baseSha}: ${commitCountText}`,
        );
      }
      return {
        head: await git(verified, ["rev-parse", "HEAD"]),
        commitCount,
        status: await git(verified, ["status", "--short"]),
        changedPaths: changed.split(/\r?\n/gu).filter(Boolean).sort(),
        moduleSource: await readFile(
          path.join(verified, "crdt_sync.py"),
          "utf8",
        ),
        readme: await readFile(path.join(verified, "README.md"), "utf8"),
      };
    },
    async removeOwnedWorktree(worktreeRoot, branch) {
      if (!branch.startsWith("codex/workspace-")) {
        throw new Error(`Refusing to remove non-agent branch: ${branch}`);
      }
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      const observedBranch = await git(verified, ["branch", "--show-current"]);
      if (observedBranch !== branch) {
        throw new Error(
          `Owned worktree branch changed before cleanup: expected ${branch}, observed ${observedBranch || "(detached)"}.`,
        );
      }
      await git(root, ["worktree", "remove", "--force", verified]);
      await git(root, ["branch", "-D", branch]);
      const pathSurvived = await lstat(verified).then(
        () => true,
        (error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? false : Promise.reject(error),
      );
      if (pathSurvived) {
        throw new Error(`Owned worktree path survived cleanup: ${verified}`);
      }
      const listed = await git(root, ["worktree", "list", "--porcelain"]);
      const listedWorktrees = listed
        .split(/\r?\n/gu)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => path.normalize(line.slice("worktree ".length).trim()));
      if (listedWorktrees.includes(path.normalize(verified))) {
        throw new Error(`Owned worktree remains registered after cleanup: ${verified}`);
      }
      if (await gitLocalBranchExists(root, branch)) {
        throw new Error(`Owned worktree branch survived cleanup: ${branch}`);
      }
    },
    cleanup: () => cleanupFixtureRoot(root),
  };
  } catch (error) {
    try {
      await cleanupFixtureRoot(root);
    } catch (cleanupError) {
      throw new Error(
        `Autonomous journey fixture setup failed and cleanup was incomplete: setup=${errorText(error)} cleanup=${errorText(cleanupError)}`,
      );
    }
    throw error;
  }
}

async function requireFixturePath(
  repositoryRoot: string,
  candidateRoot: string,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const candidate = await realpath(candidateRoot);
  if (candidate === root) {
    return root;
  }
  return requireOwnedWorktree(root, candidate);
}

async function assertProtectedFile(
  root: string,
  relativePath: string,
  expected: string,
): Promise<void> {
  const actual = await readFile(path.join(root, relativePath), "utf8");
  if (actual !== expected) {
    throw new Error(`Protected acceptance file changed: ${relativePath}`);
  }
}

async function snapshotDirectoryTree(
  directoryRoot: string,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const root = await realpath(directoryRoot);
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  let totalBytes = 0;
  const walk = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split("/"))
      : root;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (
        relativePath === ".git" ||
        relativePath.startsWith(".git/")
      ) {
        continue;
      }
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Autonomous journey tree contains a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Autonomous journey tree contains a non-file entry: ${relativePath}`);
      }
      const bytes = await readFile(absolutePath);
      totalBytes += bytes.length;
      if (files.length >= 1_000 || totalBytes > 32 * 1024 * 1024) {
        throw new Error("Autonomous journey tree exceeds the bounded proof snapshot.");
      }
      files.push({
        path: relativePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    }
  };
  await walk("");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function cleanupFixtureRoot(repositoryRoot: string): Promise<void> {
  const root = path.resolve(repositoryRoot);
  if (
    normalizePathCase(path.dirname(root)) !==
      normalizePathCase(path.resolve(tmpdir())) ||
    !path.basename(root).startsWith("agentic-autonomous-journey-")
  ) {
    throw new Error(`Refusing to clean an unowned fixture root: ${root}`);
  }
  const linkedWorktrees = await git(root, [
    "worktree",
    "list",
    "--porcelain",
  ])
    .then((listed) =>
      listed
        .split(/\r?\n/gu)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => path.resolve(line.slice("worktree ".length).trim()))
        .filter((candidate) => path.normalize(candidate) !== path.normalize(root)),
    )
    .catch(() => []);
  const failures: string[] = [];
  for (const worktree of linkedWorktrees) {
    try {
      await git(root, ["worktree", "remove", "--force", worktree]);
    } catch (gitError) {
      try {
        await assertOwnedWorktreePointer(root, worktree);
        await rm(worktree, { recursive: true, force: true });
      } catch (fallbackError) {
        failures.push(
          `linked worktree ${worktree}: git=${errorText(gitError)} fallback=${errorText(fallbackError)}`,
        );
      }
    }
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    failures.push(`fixture root ${root}: ${errorText(error)}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Autonomous journey fixture cleanup was incomplete: ${failures.join("; ")}`,
    );
  }
}

async function assertOwnedWorktreePointer(
  repositoryRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const candidate = await realpath(worktreeRoot);
  const pointer = await readFile(path.join(candidate, ".git"), "utf8");
  const match = /^gitdir:\s*(.+)\s*$/iu.exec(pointer.trim());
  if (!match) {
    throw new Error(`Linked worktree lacks a gitdir pointer: ${candidate}`);
  }
  const gitDirectory = path.resolve(candidate, match[1]);
  const expectedPrefix = `${path.resolve(repositoryRoot, ".git", "worktrees")}${path.sep}`;
  if (
    !normalizePathCase(gitDirectory).startsWith(
      normalizePathCase(expectedPrefix),
    )
  ) {
    throw new Error(`Worktree pointer is not owned by the fixture: ${candidate}`);
  }
}

function normalizePathCase(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requireOwnedWorktree(
  repositoryRoot: string,
  candidateRoot: string,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const candidate = await realpath(candidateRoot);
  if (candidate === root) {
    throw new Error("The repository root is not an owned disposable worktree.");
  }
  const listed = await git(root, ["worktree", "list", "--porcelain"]);
  const worktrees = listed
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.normalize(line.slice("worktree ".length).trim()));
  if (!worktrees.some((item) => item === path.normalize(candidate))) {
    throw new Error(`Path is not a worktree owned by the fixture: ${candidate}`);
  }
  return candidate;
}

async function runPython(cwd: string, args: string[]): Promise<string> {
  const executable = process.platform === "win32" ? "python" : "python3";
  const { stdout, stderr } = await execFileAsync(executable, args, {
    cwd,
    timeout: 120_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 60_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitLocalBranchExists(
  repositoryRoot: string,
  branch: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        cwd: repositoryRoot,
        timeout: 60_000,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return true;
  } catch (error) {
    const exitCode =
      typeof error === "object" && error !== null && "code" in error
        ? Number((error as { code?: unknown }).code)
        : Number.NaN;
    if (exitCode === 1) return false;
    throw error;
  }
}
