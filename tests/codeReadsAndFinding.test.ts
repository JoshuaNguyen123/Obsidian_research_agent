import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScopedExtensionContextV1 } from "../packages/core-api/src";
import {
  codeWorkspaceReadRangeV2,
  createCodeWorkspaceToolContributionsV2,
} from "../extensions/code/workspaceTools";
import {
  WorkspaceManagerErrorV2,
  WorkspaceManagerV2,
  compileWorkspaceGlobV1,
  compileWorkspaceGlobListV1,
  workspaceGlobFilterAcceptsV1,
} from "../extensions/code/workspaces";
import {
  DEFAULT_CODE_READ_BUDGET_CHARS_V1,
  MAX_CODE_READ_BUDGET_CHARS_V1,
  codeLineSpansV1,
  normalizeCodeReadBudgetCharsV1,
} from "../src/model/codeWorkspacePayloadV1";
import {
  MAX_CODE_WRITE_DIAGNOSTICS_CHARS_V1,
  serializeToolResultForModel,
} from "../src/model/toolResultPayload";
import {
  forgetPartialWorkspaceReadObservationsV1,
  getPartialWorkspaceReadRefusalV1,
  rememberVerifiedWorkspaceReadResult,
} from "../src/agent/verifiedWorkspaceBinding";
import type { AgentRuntimeCache, ToolExecutionResult } from "../src/tools/types";

/*
 * CODE-2, CODE-3 and CODE-5 (core half). A model editing code is shown the
 * exact lines it reads, numbered, in ranges that page through a long file;
 * its search answers with the matching lines and its listing with a tree;
 * and an edit's diagnostics, when a host supplies them, survive the
 * serializer. Each test reads what the model is actually sent: the string
 * serializeToolResultForModel returns.
 */

const SHA = `sha256:${"a".repeat(64)}`;

function sixHundredLineFile(): string {
  return Array.from(
    { length: 600 },
    (_, index) => `export const value${index + 1} = compute(${index + 1}, "line ${index + 1} of the fixture");`,
  ).join("\n") + "\n";
}

function readResult(
  content: string,
  args: Record<string, unknown> = {},
  filePath = "src/big.ts",
): ToolExecutionResult {
  return {
    ok: true,
    toolName: "code_workspace_read",
    output: codeWorkspaceReadRangeV2(
      "ws-1",
      { path: filePath, content, bytes: Buffer.byteLength(content), sha256: SHA },
      args,
    ),
  };
}

function shown(serialized: string): { envelope: Record<string, any>; lines: Map<number, string>; text: string } {
  const envelope = JSON.parse(serialized) as Record<string, any>;
  const text = envelope.output.numberedLines as string;
  const lines = new Map<number, string>();
  for (const line of text.split("\n").slice(1)) {
    const match = /^ *(\d+) {2}(.*)$/su.exec(line);
    if (match) lines.set(Number(match[1]), match[2]!);
  }
  return { envelope, lines, text };
}

test("a code read reaches the model as numbered lines, not evidence passages, inside today's envelope", () => {
  const content = sixHundredLineFile();
  const fileLines = content.split("\n");
  const serialized = serializeToolResultForModel(readResult(content));
  assert.ok(serialized.length <= 8_000, `default answer is ${serialized.length} characters`);
  const { envelope, lines, text } = shown(serialized);
  assert.equal(envelope.toolName, "code_workspace_read");
  assert.equal(envelope.status, "success");
  assert.equal(envelope.output.contentEvidence, undefined, "code reads leave the evidence extractor");
  assert.equal(envelope.output.content, undefined, "the raw text is shown numbered, not as content");
  assert.equal(envelope.output.sha256, SHA);
  assert.equal(envelope.output.totalLines, 600);
  assert.equal(envelope.truncated, true);
  const shownEnd = envelope.output.endLine as number;
  assert.ok(shownEnd > 60 && shownEnd < 200, `the default page holds ${shownEnd} lines`);
  assert.equal(text.split("\n")[0], `src/big.ts · lines 1–${shownEnd} of 600 · ${SHA}`);
  // Right-aligned to the width of the last line number, then two spaces.
  assert.match(text, /\n {2}1 {2}export const value1 = /u);
  for (let line = 1; line <= shownEnd; line += 1) {
    assert.equal(lines.get(line), fileLines[line - 1], `line ${line} is shown exactly`);
  }
  assert.equal(envelope.output.nextStartLine, shownEnd + 1);
  const readOn = text.split("\n").at(-1)!;
  assert.equal(
    readOn,
    `[Shown to line ${shownEnd} of 600 to fit this answer. Read on: code_workspace_read {"workspaceId":"ws-1","path":"src/big.ts","startLine":${shownEnd + 1}}]`,
  );
});

test("following the read-on call pages through every line of the file exactly once", () => {
  const content = sixHundredLineFile();
  const fileLines = content.split("\n");
  const seen = new Map<number, string>();
  let startLine: number | null = 1;
  let pages = 0;
  while (startLine !== null) {
    pages += 1;
    assert.ok(pages < 20, "paging terminates");
    const serialized = serializeToolResultForModel(readResult(content, startLine === 1 ? {} : { startLine }));
    assert.ok(serialized.length <= 8_000);
    const { envelope, lines, text } = shown(serialized);
    assert.equal(
      text.split("\n")[0],
      `src/big.ts · lines ${startLine}–${envelope.output.endLine} of 600 · ${SHA}`,
    );
    assert.equal(Math.min(...lines.keys()), startLine, "a page starts where the last one stopped");
    assert.equal(Math.max(...lines.keys()), envelope.output.endLine);
    for (const [line, value] of lines) {
      assert.equal(seen.has(line), false, `line ${line} is shown once`);
      seen.set(line, value);
    }
    const next = envelope.output.nextStartLine as number | null;
    if (next !== null) {
      assert.match(text, new RegExp(`"startLine":${next}\\}\\]$`, "u"), "the answer names the next call");
    }
    startLine = next;
  }
  assert.ok(pages >= 4, `the guided budget pages a 600-line file (${pages} pages)`);
  assert.equal(seen.size, 600);
  for (let line = 1; line <= 600; line += 1) assert.equal(seen.get(line), fileLines[line - 1]);
});

test("a host may give a capable model the whole file in one answer", () => {
  const content = sixHundredLineFile();
  const serialized = serializeToolResultForModel(readResult(content), {
    codeReadBudgetChars: 60_000,
  });
  assert.ok(serialized.length <= 61_000, `answer is ${serialized.length} characters`);
  const { envelope, lines, text } = shown(serialized);
  assert.equal(lines.size, 600);
  assert.equal(envelope.output.endLine, 600);
  assert.equal(envelope.output.nextStartLine, null);
  assert.equal(envelope.output.wholeFile, true);
  assert.equal(envelope.truncated, false);
  assert.doesNotMatch(text, /Read on/u);
});

test("a requested range says what follows, and a range cut by the budget reads on inside the range", () => {
  const content = sixHundredLineFile();
  const small = shown(serializeToolResultForModel(readResult(content, { startLine: 10, lineCount: 5 })));
  assert.match(small.text.split("\n")[0]!, /^src\/big\.ts · lines 10–14 of 600 · /u);
  assert.deepEqual([...small.lines.keys()], [10, 11, 12, 13, 14]);
  assert.equal(
    small.text.split("\n").at(-1),
    '[Lines 15–600 follow. Read on: code_workspace_read {"workspaceId":"ws-1","path":"src/big.ts","startLine":15}]',
  );
  assert.equal(small.envelope.truncated, false);

  const wide = shown(serializeToolResultForModel(readResult(content, { startLine: 100, lineCount: 400 })));
  const end = wide.envelope.output.endLine as number;
  assert.ok(end < 499);
  assert.match(
    wide.text.split("\n").at(-1)!,
    new RegExp(`"startLine":${end + 1},"lineCount":${499 - end}\\}\\]$`, "u"),
    "the read-on call finishes the range that was asked for",
  );
});

test("the tool returns the exact text of the requested lines and the whole file's fingerprint", () => {
  const content = "first\r\nsecond\nthird\rfourth\n";
  const read = codeWorkspaceReadRangeV2(
    "ws",
    { path: "a.txt", content, bytes: content.length, sha256: SHA },
    { startLine: 2, lineCount: 2 },
  );
  assert.equal(read.content, "second\nthird\r");
  assert.equal(read.totalLines, 4);
  assert.equal(read.startLine, 2);
  assert.equal(read.endLine, 3);
  assert.equal(read.nextStartLine, 4);
  assert.equal(read.truncated, true);
  assert.equal(read.wholeFile, false);
  assert.equal(read.sha256, SHA, "sha256 is always the whole file's");

  const whole = codeWorkspaceReadRangeV2("ws", { path: "a.txt", content, bytes: 1, sha256: SHA }, {});
  assert.equal(whole.content, content, "a whole read is byte-for-byte the file");
  assert.equal(whole.wholeFile, true);
  assert.equal(whole.nextStartLine, null);

  const empty = codeWorkspaceReadRangeV2("ws", { path: "e.py", content: "", bytes: 0, sha256: SHA }, {});
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.wholeFile, true);

  assert.throws(
    () => codeWorkspaceReadRangeV2("ws", { path: "a.txt", content, bytes: 1, sha256: SHA }, { startLine: 9 }),
    (error: unknown) =>
      error instanceof WorkspaceManagerErrorV2 &&
      error.code === "line_out_of_range" &&
      /startLine 9 is past the end of a\.txt, which has 4 lines\./u.test(error.message),
  );
  assert.throws(
    () => codeWorkspaceReadRangeV2("ws", { path: "a.txt", content, bytes: 1, sha256: SHA }, { lineCount: 0 }),
    /lineCount must be a whole number/u,
  );
  assert.deepEqual(codeLineSpansV1("a\nb\n").length, 2, "a final line break does not start a line");
  assert.deepEqual(codeLineSpansV1("a\nb").length, 2);
  assert.deepEqual(codeLineSpansV1("").length, 0);
});

test("a CRLF file is shown without carriage returns and says how its lines end", () => {
  const content = "alpha\r\nbeta\r\n";
  const { envelope, lines, text } = shown(serializeToolResultForModel(readResult(content, {}, "win.py")));
  assert.equal(lines.get(1), "alpha");
  assert.equal(lines.get(2), "beta");
  assert.match(text.split("\n")[0]!, / · CRLF line endings$/u);
  assert.match(text, /must use \\r\\n/u);
  assert.equal(envelope.output.wholeFile, true);
});

test("a line longer than the whole budget is shown cut and the reader moves on", () => {
  const content = `${"x".repeat(200_000)}\nnext();\n`;
  const serialized = serializeToolResultForModel(readResult(content, {}, "min.js"));
  assert.ok(serialized.length <= 8_000);
  const { envelope, text } = shown(serialized);
  assert.match(text, /\[line 1 cut: it has 200,000 characters\]/u);
  assert.equal(envelope.output.nextStartLine, 2);
  assert.match(text, /"startLine":2\}\]$/u);
});

test("the code read budget is clamped, and no other tool's answer changes with it", () => {
  assert.equal(normalizeCodeReadBudgetCharsV1(undefined), DEFAULT_CODE_READ_BUDGET_CHARS_V1);
  assert.equal(normalizeCodeReadBudgetCharsV1(Number.NaN), DEFAULT_CODE_READ_BUDGET_CHARS_V1);
  assert.equal(normalizeCodeReadBudgetCharsV1(100), 2_000);
  assert.equal(normalizeCodeReadBudgetCharsV1(10_000_000), MAX_CODE_READ_BUDGET_CHARS_V1);
  const research: ToolExecutionResult = {
    ok: true,
    toolName: "read_file",
    output: { path: "Notes/a.md", content: sixHundredLineFile() },
  };
  const plain = serializeToolResultForModel(research);
  assert.equal(serializeToolResultForModel(research, { codeReadBudgetChars: 60_000 }), plain);
  assert.ok(JSON.parse(plain).output.contentEvidence, "research reads keep the evidence extractor");
  const failed: ToolExecutionResult = {
    ok: false,
    toolName: "code_workspace_read",
    error: { code: "path_not_found", message: "src/missing.ts does not exist." },
  };
  assert.deepEqual(JSON.parse(serializeToolResultForModel(failed)), {
    toolName: "code_workspace_read",
    status: "error",
    summary: "src/missing.ts does not exist.",
    truncated: false,
  });
});

test("a partial read never stands in for a whole-file read when replacing the file", () => {
  const cache: AgentRuntimeCache = { toolResults: new Map(), verifiedWorkspaceReads: new Map() };
  const context = { rootMissionId: "run-1" };
  const content = sixHundredLineFile();
  const call = (args: Record<string, unknown>) => ({
    name: "code_workspace_read",
    arguments: { workspaceId: "ws-1", path: "src/big.ts", ...args },
  });
  rememberVerifiedWorkspaceReadResult(cache, call({ startLine: 1, lineCount: 50 }), context, readResult(content, { startLine: 1, lineCount: 50 }));
  assert.equal(cache.verifiedWorkspaceReads!.size, 0, "a range is not recorded as a whole read");
  const write = {
    name: "code_workspace_write_expected",
    arguments: { workspaceId: "ws-1", path: "src/big.ts", content: "x", expectedSha256: SHA },
  };
  const refusal = getPartialWorkspaceReadRefusalV1(cache, write);
  assert.equal(refusal?.code, "workspace_read_partial");
  assert.equal(
    refusal?.message,
    "Only lines 1–50 of src/big.ts (600 lines) were read, so replacing the whole file could drop lines that were never seen. Read the rest first (code_workspace_read without startLine or lineCount, or read on to the last line), or change only the lines you read with code_workspace_patch.",
  );
  assert.equal(
    getPartialWorkspaceReadRefusalV1(cache, { ...write, name: "code_workspace_patch" }),
    null,
    "a patch's exact-once match is unchanged",
  );
  assert.equal(
    getPartialWorkspaceReadRefusalV1(cache, { ...write, arguments: { ...write.arguments, path: "src/other.ts" } }),
    null,
    "a file that was not read is not refused here",
  );

  // Reading on to the end covers the file.
  rememberVerifiedWorkspaceReadResult(cache, call({ startLine: 51 }), context, readResult(content, { startLine: 51 }));
  assert.equal(getPartialWorkspaceReadRefusalV1(cache, write), null, "every line was read across pages");

  // A gap is still a partial read.
  const gapped: AgentRuntimeCache = { toolResults: new Map(), verifiedWorkspaceReads: new Map() };
  rememberVerifiedWorkspaceReadResult(gapped, call({ lineCount: 10 }), context, readResult(content, { lineCount: 10 }));
  rememberVerifiedWorkspaceReadResult(gapped, call({ startLine: 20 }), context, readResult(content, { startLine: 20 }));
  assert.match(getPartialWorkspaceReadRefusalV1(gapped, write)?.message ?? "", /^Only lines 1–10, 20–600 of src\/big\.ts/u);

  // A whole read of the same version binds as it always did.
  rememberVerifiedWorkspaceReadResult(gapped, call({}), context, readResult(content));
  assert.equal(gapped.verifiedWorkspaceReads!.size, 1);
  assert.equal(gapped.partialWorkspaceReads?.size ?? 0, 0);
  assert.equal(getPartialWorkspaceReadRefusalV1(gapped, write), null);
  // A later range of the same version leaves the whole read standing.
  rememberVerifiedWorkspaceReadResult(gapped, call({ startLine: 5, lineCount: 1 }), context, readResult(content, { startLine: 5, lineCount: 1 }));
  assert.equal(gapped.verifiedWorkspaceReads!.size, 1);
  assert.equal(getPartialWorkspaceReadRefusalV1(gapped, write), null);
  // A range of a newer version proves the whole read stale.
  const newer: ToolExecutionResult = {
    ok: true,
    toolName: "code_workspace_read",
    output: { ...(readResult(content, { startLine: 5, lineCount: 1 }).output as object), sha256: `sha256:${"b".repeat(64)}` },
  };
  rememberVerifiedWorkspaceReadResult(gapped, call({ startLine: 5, lineCount: 1 }), context, newer);
  assert.equal(gapped.verifiedWorkspaceReads!.size, 0);
  assert.match(getPartialWorkspaceReadRefusalV1(gapped, write)?.message ?? "", /^Only line 5 of src\/big\.ts \(600 lines\) was read/u);
  // Writing the file forgets what was read of it.
  forgetPartialWorkspaceReadObservationsV1(gapped, "ws-1", "src/big.ts");
  assert.equal(getPartialWorkspaceReadRefusalV1(gapped, write), null);

  // An older read output without range fields is a whole read, as before.
  const legacy: AgentRuntimeCache = { toolResults: new Map(), verifiedWorkspaceReads: new Map() };
  rememberVerifiedWorkspaceReadResult(legacy, call({}), context, {
    ok: true,
    toolName: "code_workspace_read",
    output: { path: "src/big.ts", sha256: SHA, content: "short\n" },
  });
  assert.equal(legacy.verifiedWorkspaceReads!.size, 1);
});

test("the runner refuses a full replacement after a partial read before any graph binding", async () => {
  const source = await readFile(path.join("src", "AgentRunner.ts"), "utf8");
  const refusal = source.indexOf("getPartialWorkspaceReadRefusalV1(\n        runtimeCache,");
  const graphBinding = source.indexOf(
    'toolCall.name === "code_workspace_write_expected" &&\n      missionGraphExecution &&',
  );
  assert.ok(refusal > 0 && graphBinding > refusal, "the partial-read refusal runs first");
  const runner = source.slice(
    source.indexOf("export async function runAgentMission({"),
    source.indexOf("\nasync function readInitialCurrentNote("),
  );
  // Every transcript answer in a run is serialized with the run's options, so
  // a host's code-read budget reaches every code read the model is shown.
  const bare = runner.match(/serializeToolResultForModel\([A-Za-z_$][\w$]*(?:\[[\w$]+\])?\)/gu) ?? [];
  assert.deepEqual(bare, []);
  assert.match(runner, /codeReadBudgetChars: normalizeCodeReadBudgetCharsV1\(codeReadBudgetChars\)/u);
});

test("globs follow ripgrep's and .gitignore's rules", () => {
  const ts = compileWorkspaceGlobV1("*.ts");
  assert.equal(ts.matches("a.ts"), true);
  assert.equal(ts.matches("src/deep/a.ts"), true);
  assert.equal(ts.matches("a.tsx"), false);
  assert.equal(ts.matches("src/A.TS"), true, "matching ignores case");
  const tree = compileWorkspaceGlobV1("src/**");
  assert.equal(tree.matches("src/a/b.ts"), true);
  assert.equal(tree.matches("src"), true);
  assert.equal(tree.matches("srcx/a.ts"), false);
  const tests = compileWorkspaceGlobV1("**/test_*.py");
  assert.equal(tests.matches("test_a.py"), true);
  assert.equal(tests.matches("pkg/sub/test_b.py"), true);
  assert.equal(tests.matches("pkg/sub/b_test.py"), false);
  const choice = compileWorkspaceGlobV1("*.{ts,tsx}");
  assert.equal(choice.matches("x.tsx"), true);
  assert.equal(choice.matches("x.js"), false);
  const klass = compileWorkspaceGlobV1("file[0-9].txt");
  assert.equal(klass.matches("file7.txt"), true);
  assert.equal(compileWorkspaceGlobV1("file[!0-9].txt").matches("file7.txt"), false);
  assert.equal(compileWorkspaceGlobV1("docs/").matches("docs/a/b.md"), true, "a trailing slash is the whole folder");
  const anchored = compileWorkspaceGlobV1("app/*.py");
  assert.equal(anchored.matches("src/app/main.py"), false);
  assert.equal(anchored.matches("src/app/main.py", "src"), true, "or anchored at the folder searched");
  const dist = compileWorkspaceGlobV1("dist");
  assert.equal(dist.matchesPathOrAncestor("dist/a/b.js"), true);
  assert.equal(dist.matchesPathOrAncestor("src/distance.ts"), false);
  assert.equal(
    workspaceGlobFilterAcceptsV1("src/a.ts", {
      include: compileWorkspaceGlobListV1(["*.ts"], "include"),
      exclude: compileWorkspaceGlobListV1(["src/gen/**"], "exclude"),
    }),
    true,
  );
  assert.equal(
    workspaceGlobFilterAcceptsV1("src/gen/a.ts", {
      include: compileWorkspaceGlobListV1(["*.ts"], "include"),
      exclude: compileWorkspaceGlobListV1(["src/gen/**"], "exclude"),
    }),
    false,
  );
  assert.throws(() => compileWorkspaceGlobV1("{a,b"), /not closed/u);
  assert.throws(() => compileWorkspaceGlobListV1(Array(21).fill("*.ts"), "include"), /at most 20/u);
  assert.throws(() => compileWorkspaceGlobListV1(5, "include"), /must be a glob or a list of globs/u);
});

async function workspaceFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `code-finding-${name}-`));
  let milliseconds = Date.parse("2026-10-16T08:00:00.000Z");
  let sequence = 0;
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: root,
    now: () => new Date((milliseconds += 1)),
    randomId: () => `finding-${++sequence}`,
  });
  await manager.createScratchWorkspace({ workspaceId: "ws", ownerRunId: "run-find" });
  const workspaceRoot = (await manager.loadManifest("ws")).canonicalRoot;
  const put = async (relative: string, content: string | Uint8Array) => {
    const absolute = path.join(workspaceRoot, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  };
  return { root, manager, workspaceRoot, put, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("search takes a regular expression, globs and context, and skips what it cannot read", async () => {
  const fixture = await workspaceFixture("search");
  try {
    await fixture.put("src/alpha.ts", [
      "import { load } from './io';",
      "",
      "export function alphaTicket(id: string) {",
      "  return load(id);",
      "}",
      "alphaTicket('a');",
    ].join("\n"));
    await fixture.put("src/beta.py", "def alphaHelper():\n    return 1\n");
    await fixture.put("dist/bundle.js", "alphaTicket(1);alphaTicket(2);\n");
    await fixture.put("assets/logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]));
    await fixture.put("data/huge.txt", `alphaTicket(${"0".repeat(2 * 1024 * 1024)})\n`);
    await fixture.put("vendored/lib/.git/config", "[core]\n");
    await fixture.put("vendored/lib/alpha.c", "int alphaTicket(void);\n");
    let linked = false;
    try {
      await symlink(path.join(fixture.workspaceRoot, "src"), path.join(fixture.workspaceRoot, "linked"), "junction");
      linked = true;
    } catch {
      // Some systems refuse to make links for an unprivileged user.
    }

    const report = await fixture.manager.searchDetailed("ws", "alpha[A-Z]\\w+\\(", {
      regex: true,
      caseSensitive: true,
      contextLines: 1,
    });
    assert.deepEqual(
      report.results.map((hit) => `${hit.path}:${hit.line}:${hit.column}`),
      ["dist/bundle.js:1:1", "src/alpha.ts:3:17", "src/alpha.ts:6:1", "src/beta.py:1:5", "vendored/lib/alpha.c:1:5"],
      "regex hits are in file and line order",
    );
    assert.equal(report.matchCount, 5);
    assert.deepEqual(report.results[1]!.before, [{ line: 2, text: "" }]);
    assert.deepEqual(report.results[1]!.after, [{ line: 4, text: "  return load(id);" }]);
    assert.equal(report.skippedByReason.binary, 1);
    assert.equal(report.skippedByReason.too_large, 1);
    assert.equal(report.skippedByReason.nested_git, 1);
    if (linked) assert.equal(report.skippedByReason.link, 1);
    assert.equal(report.filesSkipped, linked ? 4 : 3);
    assert.equal(report.filesSearched, 4);

    const filtered = await fixture.manager.searchDetailed("ws", "alphaTicket", {
      include: ["*.ts", "*.js"],
      exclude: ["dist"],
    });
    assert.deepEqual([...new Set(filtered.results.map((hit) => hit.path))], ["src/alpha.ts"]);
    assert.equal(filtered.results[0]!.matchKind, "definition", "a literal query is still ranked");

    // The older entry point keeps its array of hits.
    const plain = await fixture.manager.search("ws", "alphaTicket", { limit: 2 });
    assert.equal(Array.isArray(plain), true);
    assert.equal(plain.length, 2);
    assert.equal("before" in plain[0]!, false);

    await assert.rejects(
      fixture.manager.searchDetailed("ws", "alpha(", { regex: true }),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "invalid_regex" &&
        /not a valid JavaScript regular expression/u.test(error.message),
    );
    await assert.rejects(
      fixture.manager.searchDetailed("ws", "(a+)+$", { regex: true }),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "regex_too_costly",
    );
    await assert.rejects(
      fixture.manager.searchDetailed("ws", "x", { include: ["{a,b"] }),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "invalid_glob",
    );

    const serialized = serializeToolResultForModel({ ok: true, toolName: "code_workspace_search", output: { workspaceId: "ws", ...report } });
    const envelope = JSON.parse(serialized);
    const text = envelope.output.lines as string;
    assert.match(text.split("\n")[0]!, /^Search for \/alpha\[A-Z\]\\w\+\\\(\/: 5 matches in 4 files · 4 files searched, \d skipped · in file order$/u);
    // Adjacent context runs on without a separator; a jump to another file
    // or a gap is marked with --, as grep does.
    assert.match(
      text,
      /\ndist\/bundle\.js:1:1: alphaTicket\(1\);alphaTicket\(2\);\n--\nsrc\/alpha\.ts-2- \nsrc\/alpha\.ts:3:17: export function alphaTicket\(id: string\) \{\nsrc\/alpha\.ts-4-   return load\(id\);\nsrc\/alpha\.ts-5- \}\nsrc\/alpha\.ts:6:1: alphaTicket\('a'\);\n--\nsrc\/beta\.py:1:5: def alphaHelper\(\):\nsrc\/beta\.py-2-     return 1\n/u,
    );
    assert.match(text, /\nSkipped \d entries it could not search: /u);
    assert.match(text, /1 binary/u);
    assert.match(text, /1 over 2 MiB/u);
    assert.match(text, /1 nested \.git/u);
    assert.match(text, /For example: .*assets\/logo\.png \(binary\)/u);
    assert.equal(envelope.truncated, false);
  } finally {
    await fixture.cleanup();
  }
});

test("a search answer with many long matches stays inside the envelope and says it was cut", () => {
  const results = Array.from({ length: 200 }, (_, index) => ({
    path: `src/module${index}.ts`,
    line: index + 1,
    column: 3,
    preview: `const needle${index} = ${"x".repeat(450)};`,
    score: 10,
    matchKind: "text",
    before: [{ line: index, text: "y".repeat(200) }],
    after: [],
  }));
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_workspace_search",
    output: {
      query: "needle",
      regex: false,
      caseSensitive: false,
      path: "",
      include: [],
      exclude: [],
      results,
      matchCount: 950,
      filesSearched: 300,
      filesSkipped: 0,
      skipped: [],
      skippedByReason: {},
      truncated: true,
      stoppedReason: null,
    },
  });
  assert.ok(serialized.length <= 8_000, `search answer is ${serialized.length}`);
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.truncated, true);
  assert.match(envelope.output.lines, /\[Showing \d+ of the 200 returned matches to fit this answer\./u);
  assert.match(envelope.output.lines, /^Search for "needle": 950 matches \(the first 200 returned\) in 200 files/u);
});

test("a listing is an indented tree that leaves dependency and build folders closed", async () => {
  const fixture = await workspaceFixture("list");
  try {
    await fixture.put("README.md", "# Readme\n");
    await fixture.put("src/app/main.py", "print('hi')\n");
    await fixture.put("src/app/util.py", "X = 1\n");
    await fixture.put("src/app/__pycache__/main.cpython-312.pyc", "compiled");
    await fixture.put("node_modules/pkg/index.js", "module.exports = 1;\n");
    await fixture.put("docs/a/b/c/d/e/deep.md", "deep\n");

    const tree = await fixture.manager.listTree("ws", "", { recursive: true });
    const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("node_modules")?.note, "dependency_or_build");
    assert.equal(byPath.has("node_modules/pkg"), false, "a dependency folder is not opened");
    assert.equal(byPath.get("src/app/__pycache__")?.note, "dependency_or_build");
    assert.equal(byPath.get("docs/a/b/c/d")?.note, "not_expanded", "the default depth is five levels");
    assert.equal(byPath.get("src/app/main.py")?.depth, 3);

    const inside = await fixture.manager.listTree("ws", "node_modules", { recursive: true });
    assert.deepEqual(inside.entries.map((entry) => entry.path), ["node_modules/pkg", "node_modules/pkg/index.js"]);

    const python = await fixture.manager.listTree("ws", "", { recursive: true, glob: "**/*.py" });
    assert.deepEqual(python.entries.map((entry) => entry.path), ["src", "src/app", "src/app/main.py", "src/app/util.py"]);

    const flat = await fixture.manager.listTree("ws", "", {});
    assert.deepEqual(flat.entries.map((entry) => entry.path), ["docs", "node_modules", "README.md", "src"].sort((a, b) => a.localeCompare(b)));
    await assert.rejects(
      fixture.manager.listTree("ws", "README.md", {}),
      (error: unknown) => error instanceof WorkspaceManagerErrorV2 && error.code === "not_a_directory",
    );

    const serialized = serializeToolResultForModel({ ok: true, toolName: "code_workspace_list", output: tree });
    assert.ok(serialized.length <= 8_000);
    const text = JSON.parse(serialized).output.tree as string;
    assert.match(text, /^\.\/ \(workspace root\) · 5 levels deep · \d+ folders, \d+ files\n\.\//u);
    assert.match(text, /\n {2}src\/\n {4}app\/\n {6}__pycache__\/ {2}\[dependency or build\]\n {6}main\.py {2}\[12 B\]\n/u);
    assert.match(text, /\n {2}node_modules\/ {2}\[dependency or build\]\n/u);
    assert.match(text, /\[Folders marked \[dependency or build\] are left out; list one by its path to see inside\.\]/u);
    assert.match(text, /\[Folders marked \[not expanded\] go deeper than maxDepth/u);
  } finally {
    await fixture.cleanup();
  }
});

test("a listing too long for one answer says where it stopped", () => {
  const entries = Array.from({ length: 1_500 }, (_, index) => ({
    path: `src/generated/file-${String(index).padStart(4, "0")}.ts`,
    kind: "file",
    bytes: 2_048,
    depth: 2,
    note: null,
  }));
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_workspace_list",
    output: {
      path: "",
      recursive: true,
      maxDepth: 5,
      glob: null,
      entries: [{ path: "src", kind: "directory", bytes: 0, depth: 1, note: null }, ...entries],
      files: 1_500,
      directories: 1,
      truncated: true,
      stoppedAt: "src/generated/",
    },
  });
  assert.ok(serialized.length <= 8_000, `listing answer is ${serialized.length}`);
  const envelope = JSON.parse(serialized);
  assert.equal(envelope.truncated, true);
  assert.match(envelope.output.tree, /\[Shown \d+ of 1501 entries to fit this answer; stopped before src\/generated\/file-\d{4}\.ts\./u);
  assert.match(envelope.output.tree, /\[Stopped at src\/generated\/ at the listing limit\./u);
});

test("the code tools' schemas accept the new reading and finding arguments", async () => {
  const fixture = await workspaceFixture("schemas");
  try {
    const tools = new Map(
      createCodeWorkspaceToolContributionsV2({ manager: fixture.manager, isForegroundUserMission: () => true })
        .map((item) => [item.tool.name, item.tool]),
    );
    const properties = (name: string) => Object.keys(tools.get(name)!.parameters.properties ?? {});
    assert.deepEqual(properties("code_workspace_read"), ["workspaceId", "path", "startLine", "lineCount"]);
    assert.deepEqual(
      properties("code_workspace_search"),
      ["workspaceId", "query", "path", "caseSensitive", "limit", "regex", "include", "exclude", "contextLines"],
    );
    assert.deepEqual(properties("code_workspace_list"), ["workspaceId", "path", "recursive", "maxDepth", "glob"]);
    assert.deepEqual(properties("code_workspace_stat"), ["workspaceId", "path"], "stat is unchanged");
    assert.match(tools.get("code_workspace_read")!.description, /number and the two spaces are not part of the file/u);

    await fixture.put("src/a.py", "one\ntwo\nthree\n");
    const context: ScopedExtensionContextV1 = {
      version: 1,
      extensionId: "agentic-researcher-code",
      missionId: "run-find",
      operationId: "operation-1",
      originalPrompt: "Read the code.",
      abortSignal: new AbortController().signal,
      now: () => new Date("2026-10-16T08:00:00.000Z"),
      reportProgress: () => undefined,
    };
    const read = await tools.get("code_workspace_read")!.execute(
      { workspaceId: "ws", path: "src/a.py", startLine: 2, lineCount: 1 },
      context,
    ) as Record<string, unknown>;
    assert.equal(read.content, "two\n");
    assert.equal(read.sha256, `sha256:${createHash("sha256").update("one\ntwo\nthree\n").digest("hex")}`);
    assert.equal(read.nextStartLine, 3);
    const list = await tools.get("code_workspace_list")!.execute({ workspaceId: "ws", glob: "*.py" }, context) as Record<string, unknown>;
    assert.equal(list.recursive, true, "a glob implies a recursive listing");
    const search = await tools.get("code_workspace_search")!.execute(
      { workspaceId: "ws", query: "^t", regex: true, include: ["*.py"], contextLines: 0 },
      context,
    ) as Record<string, unknown>;
    assert.equal(search.matchCount, 2);
    assert.equal(search.workspaceId, "ws");
    await assert.rejects(
      tools.get("code_workspace_search")!.execute({ workspaceId: "ws", query: "t", contextLines: 7 }, context),
      /contextLines must be a whole number from 0 to 3/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an edit's diagnostics are kept after the receipt and bounded", () => {
  const receipt = {
    version: 2,
    id: "receipt-1",
    workspaceId: "ws",
    operation: "patch",
    path: "src/a.ts",
    beforeSha256: SHA,
    afterSha256: `sha256:${"c".repeat(64)}`,
  };
  const diagnostics = "After this edit: 1 error (1 new).\nsrc/a.ts:3:5 error Type 'string' is not assignable to type 'number'. (new)";
  for (const toolName of ["code_workspace_patch", "code_workspace_write_expected", "code_workspace_create_file", "code_workspace_append"]) {
    const envelope = JSON.parse(serializeToolResultForModel({
      ok: true,
      toolName,
      output: { status: "ok", operation: "patch", path: "src/a.ts", relatedPath: null, receipt, diagnostics },
    }));
    assert.equal(envelope.output.diagnostics, diagnostics, toolName);
    const keys = Object.keys(envelope.output);
    assert.ok(keys.indexOf("diagnostics") > keys.indexOf("receipt"), "diagnostics come after the receipt");
    assert.equal(envelope.omittedKeys?.includes("diagnostics") ?? false, false);
  }
  const long = `After this edit: 90 errors (90 new).\n${"src/a.ts:1:1 error something is wrong here\n".repeat(200)}`;
  const bounded = JSON.parse(serializeToolResultForModel({
    ok: true,
    toolName: "code_workspace_patch",
    output: { status: "ok", operation: "patch", path: "src/a.ts", receipt, diagnostics: long },
  }));
  assert.ok(bounded.output.diagnostics.length <= MAX_CODE_WRITE_DIAGNOSTICS_CHARS_V1);
  assert.match(bounded.output.diagnostics, /^After this edit: 90 errors/u);
  assert.match(bounded.output.diagnostics, /\n\[diagnostics cut\]$/u);
  assert.equal(bounded.truncated, true);
  const other = JSON.parse(serializeToolResultForModel({
    ok: true,
    toolName: "append_to_current_file",
    output: { operation: "append", path: "Note.md", diagnostics },
  }));
  assert.equal(other.output.diagnostics, undefined, "only the code write tools carry diagnostics");
});
