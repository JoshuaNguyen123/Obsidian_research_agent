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

export interface Phase4TypeScriptProjectFixture {
  root: string;
  baseSha: string;
  head(): Promise<string>;
  status(): Promise<string>;
  inspectWorktree(worktreeRoot: string): Promise<{
    head: string;
    status: string;
    changedPaths: string[];
    files: Record<string, string>;
  }>;
  removeOwnedWorktree(worktreeRoot: string, branch: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface Phase4PythonCheckersProjectFixture {
  root: string;
  baseSha: string;
  head(): Promise<string>;
  status(): Promise<string>;
  inspectWorktree(worktreeRoot: string): Promise<{
    head: string;
    status: string;
    changedPaths: string[];
    files: Record<string, string>;
  }>;
  removeOwnedWorktree(worktreeRoot: string, branch: string): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Empty-but-valid Node repository used by the protected real-model DU-03 lane.
 * The model must create two TypeScript modules, a runnable test, and README;
 * pre-existing build controls validate those exact artifacts without allowing
 * the mission to rewrite its own validation contract.
 */
export async function createPhase4TypeScriptProjectFixture(
  marker: string,
): Promise<Phase4TypeScriptProjectFixture> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "agentic-phase4-typescript-")),
  );
  const packageJson = {
    name: `phase4-typescript-${marker
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")}`,
    private: true,
    type: "module",
    scripts: {
      test: "node --test test/math.test.mjs",
      build: "node scripts/verify-project.mjs",
    },
  };
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "scripts", "import-simple-typescript.mjs"),
    [
      "import { readFile } from 'node:fs/promises';",
      "export async function importSimpleTypeScript(relativePath) {",
      "  const source = await readFile(relativePath, 'utf8');",
      "  const executable = source",
      "    .replace(/\\s+as\\s+const\\b/g, '')",
      "    .replace(/:\\s*number\\b/g, '');",
      "  return import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);",
      "}",
      "export default importSimpleTypeScript;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "scripts", "verify-project.mjs"),
    [
      "import assert from 'node:assert/strict';",
      "import { readFile } from 'node:fs/promises';",
      "const [math, index, testSource, readme] = await Promise.all([",
      "  readFile('src/math.ts', 'utf8'),",
      "  readFile('src/index.ts', 'utf8'),",
      "  readFile('test/math.test.mjs', 'utf8'),",
      "  readFile('README.md', 'utf8'),",
      "]);",
      "assert.match(math, /export\\s+function\\s+add/);",
      "assert.match(index, /(?:from\\s+|export\\s+\\*\\s+from\\s+)[\"']\\.\\/math(?:\\.js|\\.ts)?[\"']/);",
      "assert.match(testSource, /node:test/);",
      "assert.match(testSource, /import-simple-typescript\\.mjs/);",
      "assert.match(testSource, /importSimpleTypeScript\\([\\\"']src\\/math\\.ts[\\\"']\\)/);",
      "assert.doesNotMatch(testSource, /@jest|from ['\\\"]jest/);",
      "assert.match(readme, /npm\\s+test/i);",
      `assert.match(readme, /${marker.replace(/[^A-Za-z0-9_]/gu, "_")}/);`,
      "",
    ].join("\n"),
    "utf8",
  );
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Phase 4 E2E"]);
  await git(root, ["config", "user.email", "phase4-e2e@example.invalid"]);
  await git(root, [
    "add",
    "--",
    "package.json",
    "scripts/import-simple-typescript.mjs",
    "scripts/verify-project.mjs",
  ]);
  await git(root, ["commit", "-m", "phase4 TypeScript fixture baseline"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    await cleanupTypeScriptGitFixture(root);
    throw new Error("Phase 4 TypeScript fixture did not produce a full Git SHA.");
  }
  return {
    root,
    baseSha,
    head: () => git(root, ["rev-parse", "HEAD"]),
    status: () => git(root, ["status", "--short"]),
    async inspectWorktree(worktreeRoot) {
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      const changed = await git(verified, [
        "diff",
        "--name-only",
        baseSha,
        "HEAD",
        "--",
      ]);
      const expected = [
        "README.md",
        "src/index.ts",
        "src/math.ts",
        "test/math.test.mjs",
      ];
      return {
        head: await git(verified, ["rev-parse", "HEAD"]),
        status: await git(verified, ["status", "--short"]),
        changedPaths: changed.split(/\r?\n/gu).filter(Boolean).sort(),
        files: Object.fromEntries(
          await Promise.all(
            expected.map(async (relativePath) => [
              relativePath,
              await readFile(path.join(verified, ...relativePath.split("/")), "utf8"),
            ]),
          ),
        ),
      };
    },
    async removeOwnedWorktree(worktreeRoot, branch) {
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      await git(root, ["worktree", "remove", "--force", verified]);
      if (branch.startsWith("codex/workspace-")) {
        await git(root, ["branch", "-D", branch]).catch(() => "");
      }
    },
    cleanup: () => cleanupTypeScriptGitFixture(root),
  };
}

/**
 * Empty Python repository with a protected executable rules contract for the
 * compound checkers journey. The agent must create the package, CLI, tests,
 * and README; it cannot weaken the validation script that verifies setup,
 * mandatory captures, multi-jumps, promotion, king movement, and victory.
 */
export async function createPhase4PythonCheckersProjectFixture(
  marker: string,
): Promise<Phase4PythonCheckersProjectFixture> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "agentic-phase4-python-checkers-")),
  );
  const safeMarker = marker.replace(/[^A-Za-z0-9_]/gu, "_");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "scripts", "verify_project.py"),
    [
      "from pathlib import Path",
      "",
      "from checkers.game import (",
      "    BLACK,",
      "    BLACK_KING,",
      "    RED,",
      "    RED_KING,",
      "    CheckersGame,",
      ")",
      "from checkers.cli import main",
      "",
      "",
      "def empty_board():",
      "    return [[None for _column in range(8)] for _row in range(8)]",
      "",
      "",
      "initial = CheckersGame.initial()",
      "assert len(initial.board) == 8",
      "assert all(len(row) == 8 for row in initial.board)",
      "assert sum(piece in (RED, RED_KING) for row in initial.board for piece in row) == 12",
      "assert sum(piece in (BLACK, BLACK_KING) for row in initial.board for piece in row) == 12",
      "assert all(",
      "    piece is None or (row_index + column_index) % 2 == 1",
      "    for row_index, row in enumerate(initial.board)",
      "    for column_index, piece in enumerate(row)",
      "), 'initial pieces must occupy playable squares where (row + column) % 2 == 1'",
      "",
      "board = empty_board()",
      "board[5][0] = RED",
      "board[5][4] = RED",
      "board[4][1] = BLACK",
      "board[2][3] = BLACK",
      "capture = CheckersGame(board=board, turn=RED)",
      "expected_capture = {((5, 0), (3, 2))}",
      "actual_capture = set(capture.legal_moves())",
      "assert actual_capture == expected_capture, f'mandatory capture mismatch: {actual_capture!r}'",
      "assert capture.apply_move((5, 0), (3, 2)) is None",
      "assert capture.board[4][1] is None",
      "assert capture.turn == RED",
      "expected_continuation = {((3, 2), (1, 4))}",
      "actual_continuation = set(capture.legal_moves())",
      "assert actual_continuation == expected_continuation, f'multi-jump continuation mismatch: {actual_continuation!r}'",
      "assert capture.apply_move((3, 2), (1, 4)) is None",
      "assert capture.board[2][3] is None",
      "assert capture.turn == BLACK",
      "",
      "board = empty_board()",
      "board[1][2] = RED",
      "board[7][0] = BLACK",
      "promotion = CheckersGame(board=board, turn=RED)",
      "assert promotion.apply_move((1, 2), (0, 3)) is None",
      "assert promotion.board[0][3] == RED_KING",
      "",
      "board = empty_board()",
      "board[3][2] = RED_KING",
      "board[7][0] = BLACK",
      "king = CheckersGame(board=board, turn=RED)",
      "assert ((3, 2), (4, 3)) in king.legal_moves()",
      "",
      "board = empty_board()",
      "board[3][2] = RED",
      "finished = CheckersGame(board=board, turn=BLACK)",
      "assert finished.winner() == RED",
      "",
      "board = empty_board()",
      "board[0][1] = RED",
      "board[2][1] = BLACK",
      "immobile = CheckersGame(board=board, turn=RED)",
      "assert immobile.winner() == BLACK",
      "",
      "board = empty_board()",
      "board[5][0] = RED",
      "board[2][1] = BLACK",
      "ongoing = CheckersGame(board=board, turn=RED)",
      "assert ongoing.winner() is None",
      "assert callable(main)",
      "",
      "readme = Path('README.md').read_text(encoding='utf-8')",
      "assert 'python -m checkers.cli' in readme",
      "assert 'python -m unittest' in readme",
      "assert 'Research and Linear traceability' in readme",
      `assert ${JSON.stringify(safeMarker)} in readme`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "scripts", "verify_all.py"),
    [
      "import runpy",
      "import unittest",
      "",
      "",
      "runpy.run_module('scripts.verify_project', run_name='__main__')",
      "suite = unittest.defaultTestLoader.discover('tests', pattern='test_checkers.py')",
      "result = unittest.TextTestRunner(verbosity=1).run(suite)",
      "if not result.wasSuccessful():",
      "    raise SystemExit(1)",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Phase 4 E2E"]);
  await git(root, ["config", "user.email", "phase4-e2e@example.invalid"]);
  await git(root, [
    "add",
    "--",
    "scripts/verify_project.py",
    "scripts/verify_all.py",
  ]);
  await git(root, ["commit", "-m", "phase4 Python checkers fixture baseline"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    await cleanupPythonCheckersGitFixture(root);
    throw new Error("Phase 4 Python checkers fixture did not produce a full Git SHA.");
  }
  const expected = [
    "README.md",
    "checkers/__init__.py",
    "checkers/cli.py",
    "checkers/game.py",
    "tests/test_checkers.py",
  ];
  return {
    root,
    baseSha,
    head: () => git(root, ["rev-parse", "HEAD"]),
    status: () => git(root, ["status", "--short"]),
    async inspectWorktree(worktreeRoot) {
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      const changed = await git(verified, [
        "diff",
        "--name-only",
        baseSha,
        "HEAD",
        "--",
      ]);
      return {
        head: await git(verified, ["rev-parse", "HEAD"]),
        status: await git(verified, ["status", "--short"]),
        changedPaths: changed.split(/\r?\n/gu).filter(Boolean).sort(),
        files: Object.fromEntries(
          await Promise.all(
            expected.map(async (relativePath) => [
              relativePath,
              await readFile(path.join(verified, ...relativePath.split("/")), "utf8"),
            ]),
          ),
        ),
      };
    },
    async removeOwnedWorktree(worktreeRoot, branch) {
      const verified = await requireOwnedWorktree(root, worktreeRoot);
      await git(root, ["worktree", "remove", "--force", verified]);
      if (branch.startsWith("codex/workspace-")) {
        await git(root, ["branch", "-D", branch]).catch(() => "");
      }
    },
    cleanup: () => cleanupPythonCheckersGitFixture(root),
  };
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

async function cleanupTypeScriptGitFixture(root: string): Promise<void> {
  const verifiedRoot = await realpath(root).catch(() => null);
  if (!verifiedRoot) return;
  const verifiedTemp = await realpath(tmpdir());
  if (
    path.dirname(verifiedRoot) !== verifiedTemp ||
    !path.basename(verifiedRoot).startsWith("agentic-phase4-typescript-")
  ) {
    throw new Error(
      `Refusing to remove unowned Phase 4 TypeScript fixture: ${verifiedRoot}`,
    );
  }
  await rm(verifiedRoot, { recursive: true, force: true });
}

async function cleanupPythonCheckersGitFixture(root: string): Promise<void> {
  const verifiedRoot = await realpath(root).catch(() => null);
  if (!verifiedRoot) return;
  const verifiedTemp = await realpath(tmpdir());
  if (
    path.dirname(verifiedRoot) !== verifiedTemp ||
    !path.basename(verifiedRoot).startsWith("agentic-phase4-python-checkers-")
  ) {
    throw new Error(
      `Refusing to remove unowned Phase 4 Python checkers fixture: ${verifiedRoot}`,
    );
  }
  await rm(verifiedRoot, { recursive: true, force: true });
}
