import assert from "node:assert/strict";
import test from "node:test";

import {
  EOL_HYGIENE_REPAIR_HINT,
  chunkPathArguments,
  findEolDriftedFiles,
  formatEolDriftReport,
  parseEolHygieneArgs,
} from "../scripts/check-eol-hygiene.mjs";

const line = (worktree: string, attrs: string, file: string, index = "lf") =>
  `i/${index}    w/${worktree}  attr/${attrs} \t${file}`;

test("a worktree form that contradicts the pinned form is drift", () => {
  const output = [
    line("crlf", "text=auto eol=lf", "companion/config.py"),
    line("mixed", "text=auto eol=lf", "companion/server.py"),
    line("lf", "text=auto eol=lf", "companion/auth.py"),
    "",
  ].join("\n");
  assert.deepEqual(findEolDriftedFiles(output), [
    { file: "companion/config.py", worktree: "crlf", pinned: "lf" },
    { file: "companion/server.py", worktree: "mixed", pinned: "lf" },
  ]);
});

test("a file pinned to crlf drifts when the worktree holds lf", () => {
  const output = [
    line("crlf", "text eol=crlf", "scripts/setup-wsl2-sandbox.ps1"),
    line("lf", "text eol=crlf", "scripts/record.ps1"),
  ].join("\n");
  assert.deepEqual(findEolDriftedFiles(output), [
    { file: "scripts/record.ps1", worktree: "lf", pinned: "crlf" },
  ]);
});

test("files with no pinned form and no line endings are not drift", () => {
  const output = [
    // Binary: .gitattributes marks it -text, so no form is demanded.
    line("-text", "-text", "public/demo.mp4", "-text"),
    // Attributes unspecified: nothing to contradict.
    line("crlf", "", "vendor/generated.txt"),
    // A single-line file satisfies either pin.
    line("none", "text=auto eol=lf", "companion/VERSION"),
    // text=auto let a binary file through the * pattern: it is binary on both
    // sides, so eol=lf never applied to it.
    line("-text", "text=auto eol=lf", "public/logo.ico", "-text"),
  ].join("\n");
  assert.deepEqual(findEolDriftedFiles(output), []);
  assert.deepEqual(findEolDriftedFiles(""), []);
});

test("a text file the worktree no longer reads as text is drift", () => {
  const output = line("-text", "text=auto eol=lf", "companion/auth.py");
  assert.deepEqual(findEolDriftedFiles(output), [
    { file: "companion/auth.py", worktree: "-text", pinned: "lf" },
  ]);
});

test("paths keep every character after the tab separator", () => {
  const output = line("crlf", "text=auto eol=lf", "companion/static/ruffle host.html");
  assert.deepEqual(findEolDriftedFiles(output), [
    {
      file: "companion/static/ruffle host.html",
      worktree: "crlf",
      pinned: "lf",
    },
  ]);
});

test("the report counts the drift and elides a long tail", () => {
  const drifted = Array.from({ length: 12 }, (_value, index) => ({
    file: `companion/file${index}.py`,
    worktree: "crlf",
    pinned: "lf",
  }));
  const report = formatEolDriftReport(drifted);
  assert.match(report, /12 tracked file\(s\): 12 pinned to lf but holding crlf/u);
  assert.match(report, /companion\/file0\.py/u);
  assert.match(report, /\.\.\.and 2 more/u);
  assert.equal(report.includes("companion/file10.py"), false);
});

test("the repair batches its git arguments so a wide drift still fits a command line", () => {
  const files = Array.from({ length: 451 }, (_value, index) => `file${index}.py`);
  const chunks = chunkPathArguments(files);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [200, 200, 51]);
  assert.deepEqual(chunks.flat(), files, "every file survives the batching");
  assert.deepEqual(chunkPathArguments([]), []);
  assert.deepEqual(chunkPathArguments(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
});

test("--fix is the opt-in repair mode", () => {
  assert.deepEqual(parseEolHygieneArgs([]), { fix: false });
  assert.deepEqual(parseEolHygieneArgs(["--fix"]), { fix: true });
  assert.match(EOL_HYGIENE_REPAIR_HINT, /--fix/u);
});
