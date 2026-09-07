import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

import {
  SANDBOX_ARGUMENT_LIMITS_V1,
  SCRATCH_PYTHON_CHECK_BOOTSTRAP_V1,
  SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1,
  SCRATCH_PYTHON_LINE_ESCAPE_V1,
  scratchPythonContractCheckArgsV1,
} from "../extensions/code/ScratchPythonValidationV1";

/**
 * The checker runs under the sandbox's pinned Python, so these tests run it
 * under a real interpreter too. A missing interpreter FAILS rather than skips:
 * a silently skipped proof is how a validation gap survives in the first
 * place, which is the very defect this file exists for.
 */
function resolvePython(): { command: string; leading: string[] } {
  const candidates: Array<{ command: string; leading: string[] }> = [
    { command: "python", leading: [] },
    { command: "python3", leading: [] },
    { command: "py", leading: ["-3"] },
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.leading, "--version"], {
      encoding: "utf8",
    });
    if (probe.status === 0 && /^Python 3\./u.test(`${probe.stdout}${probe.stderr}`.trim())) {
      return candidate;
    }
  }
  throw new Error(
    "No Python 3 interpreter was found (tried python, python3, py -3). " +
      "This test runs the delivered validation for real; it must not be skipped.",
  );
}

const PYTHON = resolvePython();

function runChecker(files: Record<string, string>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "scratch-python-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const result = spawnSync(
      PYTHON.command,
      [...PYTHON.leading, ...scratchPythonContractCheckArgsV1()],
      { cwd: root, encoding: "utf8" },
    );
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the exact cohort-14 delivery is caught: annotated four-tuple unpacked as two", () => {
  // Verbatim shape of the delivered number-guessing game whose main() died
  // with "ValueError: too many values to unpack (expected 2)" on launch,
  // after three green validations.
  const result = runChecker({
    "main.py": [
      "from typing import Dict, Tuple",
      "",
      "DIFFICULTIES: Dict[str, Tuple[str, int, int, int]] = {",
      '    "1": ("Easy", 1, 50, 10),',
      "}",
      "",
      "",
      "def choose_difficulty() -> Tuple[str, int, int, int]:",
      '    choice = input("Your choice (1/2/3): ").strip()',
      "    while choice not in DIFFICULTIES:",
      '        choice = input("  Invalid choice. Enter 1, 2, or 3: ").strip()',
      "    return DIFFICULTIES[choice]",
      "",
      "",
      "def main() -> int:",
      "    key, (label, low, high, max_attempts) = choose_difficulty()",
      "    print(key, label, low, high, max_attempts)",
      "    return 0",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 1, `checker should fail; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stderr, /main\.py:16/u);
  assert.match(result.stderr, /choose_difficulty\(\) returns 4 value\(s\)/u);
  assert.match(result.stderr, /its return annotation/u);
  assert.match(result.stderr, /unpacks 2/u);
  assert.match(result.stderr, /ValueError/u);
});

test("the corrected program passes, so the checker admits the repair", () => {
  const result = runChecker({
    "main.py": [
      "from typing import Dict, Tuple",
      "",
      "DIFFICULTIES: Dict[str, Tuple[str, int, int, int]] = {",
      '    "1": ("Easy", 1, 50, 10),',
      "}",
      "",
      "",
      "def choose_difficulty() -> Tuple[str, Tuple[str, int, int, int]]:",
      '    choice = "1"',
      "    return choice, DIFFICULTIES[choice]",
      "",
      "",
      "def main() -> int:",
      "    key, (label, low, high, max_attempts) = choose_difficulty()",
      "    print(key, label, low, high, max_attempts)",
      "    return 0",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 0, `checker should pass; stderr=${result.stderr}`);
  assert.match(result.stdout, /Python validation passed: 1 file\(s\)/u);
});

test("return statements outrank a stale annotation, and are themselves checked", () => {
  const result = runChecker({
    "app.py": [
      "from typing import Tuple",
      "",
      "",
      "def pair() -> Tuple[int, int]:",
      "    return 1, 2, 3",
      "",
      "",
      "def use() -> None:",
      "    left, right = pair()",
      "    print(left, right)",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 1, `checker should fail; stdout=${result.stdout}`);
  assert.match(result.stderr, /pair\(\) returns 3 value\(s\) according to its return statements/u);
  assert.match(result.stderr, /app\.py:9/u);
});

test("a syntax error is still reported, so the old compile guarantee is kept", () => {
  const result = runChecker({ "broken.py": "def oops(:\n    pass\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /broken\.py:1: does not compile/u);
});

test("ambiguity and starred targets are never reported", () => {
  const result = runChecker({
    // A starred target absorbs any arity; a computed return has no fixed
    // arity; two same-named functions disagree; a method is not a bare Name
    // call. None of these is a provable ValueError, so none may be flagged.
    "quiet.py": [
      "from typing import Tuple",
      "",
      "",
      "def pair() -> Tuple[int, int]:",
      "    return 1, 2",
      "",
      "",
      "def dynamic():",
      "    return compute()",
      "",
      "",
      "def compute():",
      "    return (1, 2, 3)",
      "",
      "",
      "def varying(flag):",
      "    if flag:",
      "        return 1, 2",
      "    return 1, 2, 3",
      "",
      "",
      "def run():",
      "    first, *rest = pair()",
      "    a, b, c = dynamic()",
      "    x, y = varying(True)",
      "    print(first, rest, a, b, c, x, y)",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 0, `no finding expected; stderr=${result.stderr}`);
});

test("every file in the workspace is checked, not just the entry point", () => {
  const result = runChecker({
    "main.py": "print('fine')\n",
    "pkg/helpers.py": [
      "from typing import Tuple",
      "",
      "",
      "def triple() -> Tuple[int, int, int]:",
      "    return 1, 2, 3",
      "",
      "",
      "def caller():",
      "    a, b = triple()",
      "    return a, b",
      "",
    ].join("\n"),
    "__pycache__/ignored.py": "def oops(:\n",
    ".venv/skipped.py": "def oops(:\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /helpers\.py:9/u);
  assert.doesNotMatch(result.stderr, /ignored\.py/u, "__pycache__ is skipped");
  assert.doesNotMatch(result.stderr, /skipped\.py/u, "dot-directories are skipped");
});

test("the checker writes nothing into the workspace it validates", () => {
  // compileall left a __pycache__ behind in the folder the user receives;
  // an inline -c program must not add anything to a delivered workspace.
  const root = mkdtempSync(path.join(tmpdir(), "scratch-python-clean-"));
  try {
    writeFileSync(path.join(root, "main.py"), "print('hello')\n", "utf8");
    const result = spawnSync(
      PYTHON.command,
      [...PYTHON.leading, ...scratchPythonContractCheckArgsV1()],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(root), ["main.py"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the scratch catalog runs this checker and no longer shells out to compileall", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "extensions", "code", "CodeExtensionRuntimeV2.ts"),
    "utf8",
  );
  assert.match(source, /scratchPythonContractCheckArgsV1\(\)/u);
  assert.doesNotMatch(
    source,
    /\["-m", "compileall", "-q", "\."\]/u,
    "the scratch python catalog must not fall back to a compile-only command",
  );
  const args = scratchPythonContractCheckArgsV1();
  assert.equal(args[0], "-c");
  assert.equal(args[1], SCRATCH_PYTHON_CHECK_BOOTSTRAP_V1);
  // Exactly what the bootstrap does: concatenate the arguments, then turn
  // every backslash-n escape back into a newline. The leading escape gives
  // the rebuilt program one leading newline, which Python ignores.
  const rebuilt = args.slice(2).join("").split(SCRATCH_PYTHON_LINE_ESCAPE_V1).join("\n");
  assert.equal(
    rebuilt,
    `\n${SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1}`,
    "the arguments after the bootstrap must rebuild the checker verbatim",
  );
});

test("no argument leads or trails with whitespace, which the profile parser would strip", () => {
  // RepositoryProfileV2's text() trims every argument and rejects an empty
  // one. An argument beginning with Python indentation would arrive
  // de-indented, so every Python validation would fail closed on an
  // IndentationError — which is how this shape was caught before shipping.
  for (const [index, argument] of scratchPythonContractCheckArgsV1().entries()) {
    assert.equal(argument, argument.trim(), `argument ${index} would be altered by trimming`);
    assert.ok(argument.length > 0, `argument ${index} is empty`);
  }
  const trailing = SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1.split("\n")
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line !== entry.line.replace(/\s+$/u, ""));
  assert.deepEqual(
    trailing.map((entry) => entry.index + 1),
    [],
    "a source line with trailing whitespace could end a chunk and be trimmed",
  );
});

test("the checker carries no backslash, so the line escape cannot be ambiguous", () => {
  // The bootstrap turns every backslash-n in an argument into a newline. A
  // backslash anywhere in the checker would therefore be rewritten mid-source
  // and the program would arrive corrupted in the sandbox.
  const offending = SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1.split("\n")
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes("\\"));
  assert.deepEqual(
    offending.map((entry) => `${entry.index + 1}: ${entry.line}`),
    [],
    "use chr(10) rather than an escape sequence",
  );
});

test("the argument vector obeys the sandbox provider spec's own limits", () => {
  // SpawnSandboxCommandRunnerV2 refuses a spec whose vector exceeds 256
  // arguments, or any argument over 1024 characters or containing a newline
  // or carriage return. A checker that violates these is not merely rejected
  // at review time — every Python validation would fail closed in the sandbox.
  const args = scratchPythonContractCheckArgsV1();
  assert.ok(
    args.length <= SANDBOX_ARGUMENT_LIMITS_V1.maxArguments,
    `argument count ${args.length} exceeds ${SANDBOX_ARGUMENT_LIMITS_V1.maxArguments}`,
  );
  for (const [index, argument] of args.entries()) {
    assert.ok(
      argument.length <= SANDBOX_ARGUMENT_LIMITS_V1.maxArgumentChars,
      `argument ${index} is ${argument.length} characters`,
    );
    assert.doesNotMatch(argument, /[\0\r\n]/u, `argument ${index} carries a control character`);
  }
  // The limits above must keep matching the parser that enforces them. The
  // profile is the tighter of the two gates and the one that actually refused
  // an earlier draft of this command with "validation args must contain 0-64
  // entries", so it is the one pinned here.
  const profile = readFileSync(
    path.join(REPO_ROOT, "extensions", "code", "repositories", "RepositoryProfileV2.ts"),
    "utf8",
  );
  assert.match(
    profile,
    new RegExp(
      `uniqueOrRepeatedStrings\\(\\s*record\\.args,\\s*"validation args",\\s*0,\\s*${SANDBOX_ARGUMENT_LIMITS_V1.maxArguments},\\s*${SANDBOX_ARGUMENT_LIMITS_V1.maxArgumentChars}`,
      "u",
    ),
    "the declared limits must match the profile parser that enforces them",
  );
});

test("a call to a module function with the wrong arguments is caught", () => {
  // A signature edited without its call sites is the most common shape in
  // generated code, and it compiles perfectly. Each of these raises TypeError
  // on every run.
  const cases: Array<[string, string, RegExp]> = [
    [
      "too many positional",
      "def play(low, high):\n    return low + high\n\n\ndef main():\n    return play(1, 2, 3)\n",
      /play\(\) takes at most 2 positional argument\(s\) but 3 were given/u,
    ],
    [
      "missing required",
      "def play(low, high, attempts):\n    return low\n\n\ndef main():\n    return play(1, 2)\n",
      /play\(\) is missing required argument\(s\): attempts/u,
    ],
    [
      "unexpected keyword",
      "def play(low, high):\n    return low\n\n\ndef main():\n    return play(low=1, hi=2)\n",
      /play\(\) got an unexpected keyword argument hi/u,
    ],
    [
      "duplicate argument",
      "def play(low, high):\n    return low\n\n\ndef main():\n    return play(1, low=2)\n",
      /play\(\) got multiple values for argument low/u,
    ],
    [
      "missing keyword-only",
      "def play(low, *, high):\n    return low\n\n\ndef main():\n    return play(1)\n",
      /play\(\) is missing required argument\(s\): high/u,
    ],
  ];
  for (const [label, source, expected] of cases) {
    const result = runChecker({ "main.py": source });
    assert.equal(result.status, 1, `${label}: expected a finding, stdout=${result.stdout}`);
    assert.match(result.stderr, expected, label);
    assert.match(result.stderr, /TypeError/u, label);
  }
});

test("calls the checker cannot be certain about are never reported", () => {
  // Defaults satisfied, *args/**kwargs on either side, a decorator that can
  // rewrite the signature, a name reassigned later, a method rather than a
  // bare name, and two same-named definitions. None is a provable TypeError.
  const quiet: Array<[string, string]> = [
    ["defaults", "def play(low, high=10, *, verbose=False):\n    return low\n\n\ndef main():\n    play(1)\n    play(1, 2)\n    play(1, high=3, verbose=True)\n"],
    ["varargs", "def play(*values, **options):\n    return len(values)\n\n\ndef main():\n    play(1, 2, 3, mode='fast')\n"],
    ["starred call", "def play(low, high):\n    return low\n\n\ndef main():\n    values = (1, 2)\n    play(*values)\n"],
    ["decorated", "import functools\n\n\ndef wrap(function):\n    @functools.wraps(function)\n    def inner(*args, **kwargs):\n        return function(1, 2)\n    return inner\n\n\n@wrap\ndef play(low, high):\n    return low\n\n\ndef main():\n    play()\n"],
    ["reassigned name", "def play(low, high):\n    return low\n\n\nplay = lambda *a: 0\n\n\ndef main():\n    play(1, 2, 3)\n"],
    ["method", "class Game:\n    def play(self, low, high):\n        return low\n\n\ndef main():\n    Game().play(1, 2)\n"],
    ["conditional definition", "import sys\n\nif sys.version_info >= (3, 0):\n    def play(low, high):\n        return low\nelse:\n    def play(low):\n        return low\n\n\ndef main():\n    play(1)\n"],
  ];
  for (const [label, source] of quiet) {
    const result = runChecker({ "main.py": source });
    assert.equal(result.status, 0, `${label}: false positive: ${result.stderr}`);
  }
});
