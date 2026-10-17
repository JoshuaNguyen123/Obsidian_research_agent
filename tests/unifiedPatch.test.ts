import assert from "node:assert/strict";
import test from "node:test";

import {
  UnifiedPatchErrorV1,
  describeUnifiedPatchFileV1,
  parseUnifiedPatchV1,
  planUnifiedPatchFileV1,
  type UnifiedPatchErrorCodeV1,
} from "../extensions/code/workspaces/UnifiedPatchV1";

const NL = "\n";
const lines = (...text: string[]) => text.join(NL) + NL;

function refused(code: UnifiedPatchErrorCodeV1, run: () => unknown, words?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof UnifiedPatchErrorV1, String(error));
    assert.equal(error.code, code, error.message);
    if (words) assert.match(error.message, words);
    return true;
  });
}

function applyOne(patch: string, current: string | null) {
  const [file] = parseUnifiedPatchV1(patch);
  return { file: file!, plan: planUnifiedPatchFileV1(file!, current) };
}

test("a git diff over three files: a change, a new file and a delete", () => {
  const patch = lines(
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,4 @@",
    " import { a } from \"./a\";",
    "+import { b } from \"./b\";",
    " ",
    "-export const value = a;",
    "+export const value = a + b;",
    "diff --git a/src/b.ts b/src/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+export const b = 2;",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-one",
    "-two",
  );
  const files = parseUnifiedPatchV1(patch);
  assert.deepEqual(files.map((file) => [file.kind, file.path, file.fromPath]), [
    ["modify", "src/app.ts", null],
    ["add", "src/b.ts", null],
    ["delete", "old.txt", null],
  ]);
  const app = planUnifiedPatchFileV1(files[0]!, lines("import { a } from \"./a\";", "", "export const value = a;"));
  assert.equal(app.after, lines("import { a } from \"./a\";", "import { b } from \"./b\";", "", "export const value = a + b;"));
  assert.deepEqual([app.added, app.removed], [2, 1]);
  assert.equal(planUnifiedPatchFileV1(files[1]!, null).after, lines("export const b = 2;"));
  const removed = planUnifiedPatchFileV1(files[2]!, lines("one", "two"));
  assert.deepEqual(removed, { after: null, added: 0, removed: 2 });
  assert.equal(describeUnifiedPatchFileV1(files[0]!, app), "src/app.ts: +2 −1");
  assert.equal(describeUnifiedPatchFileV1(files[1]!, { added: 1, removed: 0 }), "src/b.ts: new file, +1 −0");
});

test("a hunk applies where its lines are, whatever its numbers say, and only there", () => {
  const before = lines("a", "b", "c", "d", "e");
  const { plan } = applyOne(lines("--- a/f.txt", "+++ b/f.txt", "@@ -40,3 +40,3 @@", " b", "-c", "+C", " d"), before);
  assert.equal(plan.after, lines("a", "b", "C", "d", "e"));
  // Counts that are wrong are recounted from the lines.
  const recounted = applyOne(lines("--- a/f.txt", "+++ b/f.txt", "@@ -2,9 +2,1 @@", " b", "-c", "+C"), before);
  assert.equal(recounted.plan.after, lines("a", "b", "C", "d", "e"));
  // A header with no numbers at all.
  const bare = applyOne(lines("--- f.txt", "+++ f.txt", "@@ @@", " d", "-e", "+E"), before);
  assert.equal(bare.plan.after, lines("a", "b", "c", "d", "E"));
});

test("a hunk that matches twice applies only at the line its header names", () => {
  const before = lines("x", "same", "y", "same", "z");
  const atFour = applyOne(lines("--- a/f", "+++ b/f", "@@ -4 +4 @@", "-same", "+changed"), before);
  assert.equal(atFour.plan.after, lines("x", "same", "y", "changed", "z"));
  refused("patch_hunk_ambiguous", () => applyOne(lines("--- a/f", "+++ b/f", "@@ @@", "-same", "+changed"), before), /matches 2 places/u);
  refused("patch_hunk_ambiguous", () => applyOne(lines("--- a/f", "+++ b/f", "@@ -3 +3 @@", "-same", "+changed"), before));
});

test("a hunk whose context does not match says which hunk, and what differs", () => {
  const before = lines("function f() {", "    return 1;", "}");
  refused(
    "patch_hunk_mismatch",
    () => applyOne(lines("--- a/f.ts", "+++ b/f.ts", "@@ -1,3 +1,3 @@", " function f() {", "-  return 1;", "+  return 2;", " }"), before),
    /Hunk 1 of f\.ts does not apply.*different spacing or indentation/u,
  );
  refused(
    "patch_hunk_mismatch",
    () =>
      applyOne(
        lines("--- a/f.ts", "+++ b/f.ts", "@@ -1 +1 @@", "-function f() {", "+function g() {", "@@ -2 +2 @@", "-    return 9;", "+    return 2;"),
        before,
      ),
    /^Hunk 2 of f\.ts does not apply/u,
  );
});

test("hunks apply in order and never overlap", () => {
  const before = lines("1", "2", "3", "4", "5", "6");
  const { plan } = applyOne(
    lines("--- a/n", "+++ b/n", "@@ -1,2 +1,2 @@", " 1", "-2", "+two", "@@ -5,2 +5,2 @@", "-5", "+five", " 6"),
    before,
  );
  assert.equal(plan.after, lines("1", "two", "3", "4", "five", "6"));
  refused(
    "patch_hunk_mismatch",
    () => applyOne(lines("--- a/n", "+++ b/n", "@@ -4 +4 @@", "-4", "+four", "@@ -2 +2 @@", "-2", "+two"), before),
    /after line 4/u,
  );
});

test("CRLF files keep their line breaks, and the final newline follows the markers", () => {
  const crlf = "one\r\ntwo\r\nthree\r\n";
  const { plan } = applyOne(lines("--- a/w.txt", "+++ b/w.txt", "@@ -2 +2,2 @@", "-two", "+TWO", "+two and a half"), crlf);
  assert.equal(plan.after, "one\r\nTWO\r\ntwo and a half\r\nthree\r\n");
  // A patch written with CRLF line breaks reads the same.
  const patched = applyOne("--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-one\r\n+ONE\r\n", crlf);
  assert.equal(patched.plan.after, "ONE\r\ntwo\r\nthree\r\n");
  // Adding a final newline to a file that had none.
  const noNewline = applyOne(
    lines("--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b"),
    "a\nb",
  );
  assert.equal(noNewline.plan.after, "a\nb\n");
  // Taking it away again.
  const dropped = applyOne(
    lines("--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " a", "-b", "+b", "\\ No newline at end of file"),
    "a\nb\n",
  );
  assert.equal(dropped.plan.after, "a\nb");
  // Appending after a last line without a newline keeps that state at the new end.
  const appended = applyOne(lines("--- a/x", "+++ b/x", "@@ -2 +2,2 @@", " b", "+c"), "a\nb");
  assert.equal(appended.plan.after, "a\nb\nc");
});

test("an empty context line the diff tool wrote without its space still reads as context", () => {
  const before = lines("a", "", "b");
  const { plan } = applyOne(["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " a", "", "-b", "+B", "", ""].join(NL), before);
  assert.equal(plan.after, lines("a", "", "B"));
});

test("a rename carries its hunks to the new path, and a rename alone keeps the text", () => {
  const renamed = parseUnifiedPatchV1(
    lines(
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-export const name = \"old\";",
      "+export const name = \"new\";",
      "diff --git a/docs/a.md b/docs/b.md",
      "similarity index 100%",
      "rename from docs/a.md",
      "rename to docs/b.md",
    ),
  );
  assert.deepEqual(renamed.map((file) => [file.kind, file.fromPath, file.path]), [
    ["rename", "src/old.ts", "src/new.ts"],
    ["rename", "docs/a.md", "docs/b.md"],
  ]);
  assert.equal(planUnifiedPatchFileV1(renamed[0]!, lines("export const name = \"old\";")).after, lines("export const name = \"new\";"));
  assert.equal(planUnifiedPatchFileV1(renamed[1]!, "# A\n").after, "# A\n");
  assert.equal(describeUnifiedPatchFileV1(renamed[1]!, { added: 0, removed: 0 }), "docs/a.md → docs/b.md: renamed, +0 −0");
});

test("a delete must remove the file's whole text, or name no lines", () => {
  const patch = lines("--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-one");
  refused("patch_delete_mismatch", () => applyOne(patch, lines("one", "two")));
  assert.equal(applyOne(lines("--- a/gone.txt", "+++ /dev/null"), lines("one", "two")).plan.removed, 2);
});

test("what the patch cannot express is refused in words", () => {
  refused("patch_empty", () => parseUnifiedPatchV1("  \n"));
  refused("patch_empty", () => parseUnifiedPatchV1("Just a message.\n"));
  refused("patch_invalid", () => parseUnifiedPatchV1(lines("@@ -1 +1 @@", "-a", "+b")), /before any --- and \+\+\+/u);
  refused("patch_binary_unsupported", () => parseUnifiedPatchV1(lines("diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ")));
  refused("patch_mode_unsupported", () => parseUnifiedPatchV1(lines("diff --git a/s.sh b/s.sh", "old mode 100644", "new mode 100755")));
  refused("patch_copy_unsupported", () => parseUnifiedPatchV1(lines("diff --git a/a b/b", "copy from a", "copy to b")));
  refused("patch_path_invalid", () => parseUnifiedPatchV1(lines("--- a/../escape.txt", "+++ b/../escape.txt", "@@ -1 +1 @@", "-a", "+b")));
  refused("patch_path_invalid", () => parseUnifiedPatchV1(lines("--- /etc/passwd", "+++ /etc/passwd", "@@ -1 +1 @@", "-a", "+b")));
  refused("patch_path_invalid", () => parseUnifiedPatchV1(lines("--- a/.git/config", "+++ b/.git/config", "@@ -1 +1 @@", "-a", "+b")));
  refused("patch_duplicate_path", () => parseUnifiedPatchV1(lines(
    "--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b",
    "--- a/f", "+++ b/f", "@@ -2 +2 @@", "-c", "+d",
  )));
  refused("patch_invalid", () => parseUnifiedPatchV1(lines("--- /dev/null", "+++ b/new", "@@ -0,0 +1,2 @@", " context", "+added")), /can only add lines/u);
  refused("patch_invalid", () => parseUnifiedPatchV1(lines("--- a/f", "+++ b/f", "@@ -1 +1 @@", " same")), /changes nothing/u);
  refused("patch_no_change", () => applyOne(lines("--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+a"), lines("a")));
  const many = Array.from({ length: 101 }, (_, index) => lines(`--- a/f${index}`, `+++ b/f${index}`, "@@ -1 +1 @@", "-a", "+b")).join("");
  refused("patch_too_many_files", () => parseUnifiedPatchV1(many), /at most 100/u);
  refused("patch_hunk_mismatch", () => applyOne(lines("--- a/missing", "+++ b/missing", "@@ -1 +1 @@", "-a", "+b"), null), /does not exist/u);
});

test("text before and between file sections is not part of the change", () => {
  const files = parseUnifiedPatchV1(lines(
    "Rename the helper and its caller.",
    "",
    "Index: src/a.ts",
    "===================================================================",
    "--- src/a.ts\t2026-10-16 10:00:00",
    "+++ src/a.ts\t2026-10-16 10:01:00",
    "@@ -1 +1 @@",
    "-old()",
    "+renamed()",
  ));
  assert.deepEqual(files.map((file) => [file.kind, file.path]), [["modify", "src/a.ts"]]);
});
