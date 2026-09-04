import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DIGEST_DIAGNOSTICS_V1,
  buildValidationFailureDigestV1,
  parseCheckDiagnosticsV1,
  type ValidationCheckOutputV1,
} from "../extensions/code/repair/validationFailureDigestV1";

/*
 * A red fast validation used to hand the repair pass an exit code and a
 * SHA-256 of the whole output. `code_repair_status` -- the thing the agent
 * reads to decide what to change -- carried neither, only receipt ids and a
 * stage name. These fixtures are verbatim output shapes from the runners a
 * workspace actually uses, so the parser is pinned against what the tools
 * print rather than against what would be convenient.
 */

function check(overrides: Partial<ValidationCheckOutputV1>): ValidationCheckOutputV1 {
  return { label: "npm run build", exitCode: 1, stdout: "", stderr: "", ...overrides };
}

test("tsc diagnostics keep file, position, code, and message", () => {
  const found = parseCheckDiagnosticsV1(
    check({
      label: "npm run typecheck",
      stdout: [
        "src/game/board.ts(12,5): error TS2304: Cannot find name 'Cell'.",
        "src/game/board.ts(31,18): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        "src/util.ts(4,1): warning TS6133: 'unused' is declared but its value is never read.",
      ].join("\n"),
    }),
  );
  assert.equal(found.length, 3);
  assert.deepEqual(
    { ...found[0]!, signature: undefined },
    {
      check: "npm run typecheck",
      format: "tsc",
      file: "src/game/board.ts",
      line: 12,
      column: 5,
      severity: "error",
      code: "TS2304",
      message: "Cannot find name 'Cell'.",
      signature: undefined,
    },
  );
  assert.equal(found[2]!.severity, "warning");
});

test("eslint stylish output attaches each finding to the file above it", () => {
  const found = parseCheckDiagnosticsV1(
    check({
      label: "npm run lint",
      stdout: [
        "",
        "/repo/src/index.js",
        "   3:10  error    'fs' is defined but never used  no-unused-vars",
        "  11:1   warning  Unexpected console statement    no-console",
        "",
        "/repo/src/other.js",
        "   7:5   error    Missing semicolon               semi",
        "",
        "✖ 3 problems (2 errors, 1 warning)",
      ].join("\n"),
    }),
  );
  const eslint = found.filter((entry) => entry.format === "eslint");
  assert.equal(eslint.length, 3);
  assert.equal(eslint[0]!.file, "/repo/src/index.js");
  assert.equal(eslint[0]!.line, 3);
  assert.equal(eslint[0]!.code, "no-unused-vars");
  assert.equal(eslint[1]!.severity, "warning");
  assert.equal(eslint[2]!.file, "/repo/src/other.js", "the second file must not inherit the first");
});

test("a python traceback resolves to the frame that raised", () => {
  const found = parseCheckDiagnosticsV1(
    check({
      label: "python -m pytest",
      stderr: [
        "Traceback (most recent call last):",
        '  File "/work/app/main.py", line 3, in <module>',
        "    run()",
        '  File "/work/app/engine.py", line 41, in run',
        "    return board[index]",
        "IndexError: list index out of range",
      ].join("\n"),
    }),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.file, "/work/app/engine.py");
  assert.equal(found[0]!.line, 41, "the deepest frame is where it broke, not the entry point");
  assert.equal(found[0]!.code, "IndexError");
  assert.equal(found[0]!.message, "list index out of range");
});

test("node --test failures name the test and the assertion location", () => {
  const found = parseCheckDiagnosticsV1(
    check({
      label: "npm test",
      stdout: [
        "✔ passing case (1.2ms)",
        "✖ resolves a ticket by id (176.3126ms)",
        "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
        "",
        "  43 !== 42",
        "",
        "      at TestContext.<anonymous> (/repo/tests/tickets.test.ts:112:12)",
        "      at async Test.run (node:internal/test_runner/test:1313:7)",
      ].join("\n"),
    }),
  );
  const names = found.map((entry) => entry.message);
  assert.ok(
    names.some((message) => message.includes("resolves a ticket by id")),
    `failing test name must survive: ${JSON.stringify(names)}`,
  );
  const assertion = found.find((entry) => entry.code === "AssertionError");
  assert.ok(assertion, `assertion must be parsed: ${JSON.stringify(found)}`);
  assert.equal(assertion.file, "/repo/tests/tickets.test.ts");
  assert.equal(assertion.line, 112);
  assert.equal(assertion.column, 12);
  // A passing test is not a diagnostic.
  assert.ok(!names.some((message) => message.includes("passing case")));
});

test("gcc-style and pytest summary lines are recognised", () => {
  const gnu = parseCheckDiagnosticsV1(
    check({ label: "make", stderr: "src/main.c:18:9: error: 'count' undeclared (first use in this function)" }),
  );
  assert.equal(gnu[0]!.file, "src/main.c");
  assert.equal(gnu[0]!.line, 18);
  assert.equal(gnu[0]!.column, 9);

  const pytest = parseCheckDiagnosticsV1(
    check({
      label: "pytest",
      stdout: [
        "tests/test_board.py:24: AssertionError",
        "FAILED tests/test_board.py::test_wins - AssertionError: assert 0 == 1",
      ].join("\n"),
    }),
  );
  assert.equal(pytest.length, 2);
  assert.equal(pytest[0]!.file, "tests/test_board.py");
  assert.equal(pytest[0]!.line, 24);
  assert.equal(pytest[1]!.code, "test_wins");
});

test("unrecognised output degrades to its first substantive line, never to nothing", () => {
  const found = parseCheckDiagnosticsV1(
    check({
      label: "npm run build",
      stdout: "\n> app@1.0.0 build\n> some-bundler\n",
      stderr: "\nnpm ERR!\nbundler: could not resolve entry point ./src/main\nnpm ERR!\n",
    }),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.format, "unstructured");
  assert.equal(found[0]!.message, "bundler: could not resolve entry point ./src/main");
});

test("only failed checks contribute, and the summary names them", () => {
  const digest = buildValidationFailureDigestV1([
    check({ label: "npm run lint", exitCode: 0, stdout: "clean" }),
    check({
      label: "npm run typecheck",
      exitCode: 2,
      stdout: "src/a.ts(1,1): error TS1005: ';' expected.",
    }),
  ]);
  assert.deepEqual(digest.failedChecks, ["npm run typecheck"]);
  assert.equal(digest.diagnostics.length, 1);
  assert.match(digest.summary, /1 check failed \(npm run typecheck\)/u);
  assert.match(digest.summary, /1 error in 1 file/u);
  assert.match(digest.summary, /first: src\/a\.ts:1 TS1005/u);
});

test("errors rank above warnings and located diagnostics above unlocated ones", () => {
  const digest = buildValidationFailureDigestV1([
    check({
      label: "npm run lint",
      stdout: [
        "/repo/a.ts",
        "  2:1  warning  Unexpected console statement  no-console",
        "  9:1  error    Missing semicolon             semi",
      ].join("\n"),
    }),
  ]);
  assert.equal(digest.diagnostics[0]!.severity, "error");
  assert.equal(digest.diagnostics[1]!.severity, "warning");
});

test("the digest says which problems survived the previous repair cycle", () => {
  const before = [
    check({
      label: "npm run typecheck",
      stdout: [
        "src/a.ts(10,3): error TS2304: Cannot find name 'alpha'.",
        "src/b.ts(20,3): error TS2304: Cannot find name 'beta'.",
      ].join("\n"),
    }),
  ];
  const previous = before.flatMap((entry) => parseCheckDiagnosticsV1(entry));

  const after = buildValidationFailureDigestV1(
    [
      check({
        label: "npm run typecheck",
        stdout: [
          // 'alpha' fixed. 'beta' survives, and has MOVED DOWN four lines
          // because of the edit above it -- still the same problem.
          "src/b.ts(24,3): error TS2304: Cannot find name 'beta'.",
          "src/c.ts(2,1): error TS1005: ';' expected.",
        ].join("\n"),
      }),
    ],
    previous,
  );
  assert.deepEqual(after.unresolved, ["src/b.ts|TS2304|Cannot find name 'beta'."]);
  assert.deepEqual(after.resolved, ["src/a.ts|TS2304|Cannot find name 'alpha'."]);
  assert.deepEqual(after.introduced, ["src/c.ts|TS1005|';' expected."]);
  assert.match(after.summary, /1 unresolved, 1 fixed, 1 new since the previous cycle/u);
});

test("a repair that changed nothing reports every diagnostic as unresolved", () => {
  const output = check({
    label: "npm run typecheck",
    stdout: "src/a.ts(10,3): error TS2304: Cannot find name 'alpha'.",
  });
  const digest = buildValidationFailureDigestV1([output], parseCheckDiagnosticsV1(output));
  assert.equal(digest.unresolved.length, 1);
  assert.equal(digest.resolved.length, 0);
  assert.equal(digest.introduced.length, 0);
});

test("a flood of diagnostics is capped and says so", () => {
  const digest = buildValidationFailureDigestV1([
    check({
      label: "npm run typecheck",
      stdout: Array.from(
        { length: MAX_DIGEST_DIAGNOSTICS_V1 + 15 },
        (_, index) => `src/f${index}.ts(1,1): error TS2304: Cannot find name 'x${index}'.`,
      ).join("\n"),
    }),
  ]);
  assert.equal(digest.diagnostics.length, MAX_DIGEST_DIAGNOSTICS_V1);
  assert.equal(digest.truncated, true);
  assert.ok(digest.summary.length <= 1_200);
});

test("a passing validation produces no digest content", () => {
  const digest = buildValidationFailureDigestV1([
    check({ label: "npm test", exitCode: 0, stdout: "ok" }),
  ]);
  assert.deepEqual(digest.diagnostics, []);
  assert.deepEqual(digest.failedChecks, []);
  assert.equal(digest.summary, "All checks passed.");
});

test("parsing never throws on hostile output", () => {
  for (const payload of ["", "  ", "a".repeat(200_000), "(((:::)))", "✖".repeat(500)]) {
    assert.doesNotThrow(() =>
      buildValidationFailureDigestV1([check({ stdout: payload, stderr: payload })]),
    );
  }
});
