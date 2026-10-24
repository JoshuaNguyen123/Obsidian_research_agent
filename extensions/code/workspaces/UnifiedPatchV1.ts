import { assertWorkspaceRelativePathV2 } from "./WorkspaceManifestV2";

/**
 * A unified diff over a workspace's text files (CODE-7), read and applied
 * without Git: `code_workspace_apply_patch` changes several files as one
 * prepared action, and this is what it reads.
 *
 * What it accepts is what `git diff` and `diff -u` write: a `--- a/<path>`,
 * `+++ b/<path>` pair per file (an optional `diff --git` line and its
 * extended header before it), then `@@ -l,c +l,c @@` hunks of context, `-`
 * and `+` lines. A file is modified, added (`--- /dev/null`), deleted
 * (`+++ /dev/null`) or renamed (`rename from`/`rename to`, or two different
 * paths), its hunks applied to the renamed file's text. Binary changes, mode
 * changes and copies are refused in words, since a workspace edit is text.
 *
 * A hunk applies only where its context and removed lines match the file
 * exactly. The header's line numbers say where to look; they are not trusted
 * for anything else, so a hunk whose numbers are off still applies when its
 * lines are found once, and a hunk whose lines are found in more than one
 * place applies only at the place its numbers name. Counts in the header are
 * read the same way: they bound the hunk when they are right and are
 * recounted from its lines when they are not.
 */

export const UNIFIED_PATCH_MAX_FILES_V1 = 100;
export const UNIFIED_PATCH_MAX_CHARACTERS_V1 = 1_048_576;
export const UNIFIED_PATCH_MAX_HUNKS_PER_FILE_V1 = 200;

export type UnifiedPatchErrorCodeV1 =
  | "patch_empty"
  | "patch_too_large"
  | "patch_too_many_files"
  | "patch_invalid"
  | "patch_path_invalid"
  | "patch_duplicate_path"
  | "patch_binary_unsupported"
  | "patch_mode_unsupported"
  | "patch_copy_unsupported"
  | "patch_hunk_mismatch"
  | "patch_hunk_ambiguous"
  | "patch_delete_mismatch"
  | "patch_no_change";

export class UnifiedPatchErrorV1 extends Error {
  constructor(readonly code: UnifiedPatchErrorCodeV1, message: string) {
    super(message);
    this.name = "UnifiedPatchErrorV1";
  }
}

export interface UnifiedPatchLineV1 {
  kind: "context" | "remove" | "add";
  text: string;
}

export interface UnifiedPatchHunkV1 {
  /** 1-based, within its file. */
  index: number;
  /** The header's old-side start line, or null when the header names none (`@@ @@`). */
  oldStart: number | null;
  /** The header's old-side count, or null when it names none. */
  oldLines: number | null;
  lines: UnifiedPatchLineV1[];
  /** A `\ No newline at end of file` after the old side's last line. */
  oldEndsWithoutNewline: boolean;
  /** A `\ No newline at end of file` after the new side's last line. */
  newEndsWithoutNewline: boolean;
}

export type UnifiedPatchFileKindV1 = "modify" | "add" | "delete" | "rename";

export interface UnifiedPatchFileV1 {
  kind: UnifiedPatchFileKindV1;
  /** The file's path after the patch; for a delete, the file deleted. */
  path: string;
  /** For a rename, the path the file had. */
  fromPath: string | null;
  hunks: UnifiedPatchHunkV1[];
}

export interface UnifiedPatchFilePlanV1 {
  /** The file's text after the patch; null for a delete. */
  after: string | null;
  added: number;
  removed: number;
}

/** Read a unified diff into its files, in the order the patch names them. */
export function parseUnifiedPatchV1(patch: unknown): UnifiedPatchFileV1[] {
  if (typeof patch !== "string" || patch.trim() === "") {
    throw new UnifiedPatchErrorV1(
      "patch_empty",
      "The patch is empty. Give a unified diff: a --- a/<path> and +++ b/<path> line per file, then its @@ hunks.",
    );
  }
  if (patch.length > UNIFIED_PATCH_MAX_CHARACTERS_V1) {
    throw new UnifiedPatchErrorV1(
      "patch_too_large",
      `The patch is ${patch.length} characters; one patch is at most ${UNIFIED_PATCH_MAX_CHARACTERS_V1}. Split it.`,
    );
  }
  if (patch.includes("\0")) {
    throw new UnifiedPatchErrorV1("patch_binary_unsupported", "The patch holds a NUL byte; only text changes apply.");
  }
  const lines = patch.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: UnifiedPatchFileV1[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) {
      index = readGitSection(lines, index, files);
    } else if (isFileHeaderAt(lines, index)) {
      index = readFileSection(lines, index, files, null, null);
    } else if (isHunkHeader(line)) {
      throw new UnifiedPatchErrorV1(
        "patch_invalid",
        `Line ${index + 1} starts a hunk before any --- and +++ file header.`,
      );
    } else if (isBinaryMarker(line)) {
      throw binaryRefusal();
    } else {
      // A message, an "Index:" line, a separator: text outside a file's
      // section is not part of the change.
      index += 1;
    }
  }
  if (files.length === 0) {
    throw new UnifiedPatchErrorV1(
      "patch_empty",
      "The patch names no file. Give a unified diff: a --- a/<path> and +++ b/<path> line per file, then its @@ hunks.",
    );
  }
  if (files.length > UNIFIED_PATCH_MAX_FILES_V1) {
    throw new UnifiedPatchErrorV1(
      "patch_too_many_files",
      `The patch changes ${files.length} files; one patch changes at most ${UNIFIED_PATCH_MAX_FILES_V1}. Split it.`,
    );
  }
  const seen = new Set<string>();
  for (const file of files) {
    for (const touched of [file.path, ...(file.fromPath ? [file.fromPath] : [])]) {
      if (seen.has(touched)) {
        throw new UnifiedPatchErrorV1(
          "patch_duplicate_path",
          `The patch names ${touched} more than once; give each file one section.`,
        );
      }
      seen.add(touched);
    }
  }
  return files;
}

/**
 * What one file of the patch does to its text. `current` is the file's text
 * now, or null when it does not exist; an added file must not exist, every
 * other file must.
 */
export function planUnifiedPatchFileV1(
  file: UnifiedPatchFileV1,
  current: string | null,
): UnifiedPatchFilePlanV1 {
  const counted = countLines(file);
  if (file.kind === "add") {
    return { after: addedContent(file), ...counted };
  }
  if (current === null) {
    throw new UnifiedPatchErrorV1(
      "patch_hunk_mismatch",
      `${file.fromPath ?? file.path} does not exist, so the patch cannot change it.`,
    );
  }
  const source = splitText(current);
  if (file.kind === "delete") {
    assertWholeFileRemoved(file, source);
    return { after: null, added: 0, removed: source.lines.length };
  }
  if (file.hunks.length === 0) {
    // A rename that keeps the file's text.
    return { after: current, added: 0, removed: 0 };
  }
  const after = applyHunks(file, source);
  if (after === current && file.kind === "modify") {
    throw new UnifiedPatchErrorV1("patch_no_change", `The patch leaves ${file.path} as it is.`);
  }
  return { after, ...counted };
}

/** `src/a.ts: +12 −3`, the line the model and the approval read per file. */
export function describeUnifiedPatchFileV1(
  file: Pick<UnifiedPatchFileV1, "kind" | "path" | "fromPath">,
  counts: { added: number; removed: number },
): string {
  const lines = `+${counts.added} −${counts.removed}`;
  if (file.kind === "add") return `${file.path}: new file, ${lines}`;
  if (file.kind === "delete") return `${file.path}: deleted to the workspace trash, ${lines}`;
  if (file.kind === "rename") return `${file.fromPath} → ${file.path}: renamed, ${lines}`;
  return `${file.path}: ${lines}`;
}

function readGitSection(lines: string[], start: number, files: UnifiedPatchFileV1[]): number {
  const header = lines[start]!;
  const git = { newFile: false, deleted: false, renameFrom: null as string | null, renameTo: null as string | null };
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("--- ") || isHunkHeader(line) || line.startsWith("diff --git ")) break;
    if (line.startsWith("new file mode ")) git.newFile = true;
    else if (line.startsWith("deleted file mode ")) git.deleted = true;
    else if (line.startsWith("rename from ")) git.renameFrom = gitPath(line.slice("rename from ".length));
    else if (line.startsWith("rename to ")) git.renameTo = gitPath(line.slice("rename to ".length));
    else if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      throw new UnifiedPatchErrorV1(
        "patch_mode_unsupported",
        "The patch changes a file's mode; a workspace edit changes text only. Leave the mode lines out.",
      );
    } else if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
      throw new UnifiedPatchErrorV1(
        "patch_copy_unsupported",
        "The patch copies a file; give the copy as a new file (--- /dev/null) instead.",
      );
    } else if (isBinaryMarker(line)) {
      throw binaryRefusal();
    } else if (
      line.startsWith("index ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ")
    ) {
      continue;
    } else {
      break;
    }
  }
  if (isFileHeaderAt(lines, index)) {
    return readFileSection(lines, index, files, git, null);
  }
  const paths = gitHeaderPaths(header);
  if (isHunkHeader(lines[index] ?? "")) {
    if (!paths) {
      throw new UnifiedPatchErrorV1(
        "patch_invalid",
        `Line ${start + 1} names its files in a way that cannot be read; add the --- a/<path> and +++ b/<path> lines.`,
      );
    }
    return readFileSection(lines, index, files, git, paths);
  }
  // No content: a rename that keeps the text, or an empty file added or deleted.
  if (git.renameFrom && git.renameTo) {
    files.push(fileOf("rename", git.renameTo, git.renameFrom, []));
  } else if (git.newFile && paths) {
    files.push(fileOf("add", paths.newPath, null, []));
  } else if (git.deleted && paths) {
    files.push(fileOf("delete", paths.oldPath, null, []));
  } else {
    throw new UnifiedPatchErrorV1(
      "patch_invalid",
      `The section at line ${start + 1} changes nothing: it has no --- and +++ lines and no hunks.`,
    );
  }
  return index;
}

function readFileSection(
  lines: string[],
  start: number,
  files: UnifiedPatchFileV1[],
  git: { newFile: boolean; deleted: boolean; renameFrom: string | null; renameTo: string | null } | null,
  headerPaths: { oldPath: string; newPath: string } | null,
): number {
  let oldPath: string;
  let newPath: string;
  let index = start;
  if (headerPaths) {
    oldPath = headerPaths.oldPath;
    newPath = headerPaths.newPath;
  } else {
    const oldRaw = headerPath(lines[index]!.slice(4));
    const newRaw = headerPath(lines[index + 1]!.slice(4));
    const prefixed = oldRaw !== DEV_NULL && newRaw !== DEV_NULL
      ? oldRaw.startsWith("a/") && newRaw.startsWith("b/")
      : oldRaw === DEV_NULL ? newRaw.startsWith("b/") : oldRaw.startsWith("a/");
    oldPath = oldRaw === DEV_NULL ? DEV_NULL : prefixed ? oldRaw.slice(2) : oldRaw;
    newPath = newRaw === DEV_NULL ? DEV_NULL : prefixed ? newRaw.slice(2) : newRaw;
    index += 2;
  }
  const hunks: UnifiedPatchHunkV1[] = [];
  const label = newPath === DEV_NULL ? oldPath : newPath;
  while (index < lines.length && isHunkHeader(lines[index]!)) {
    if (hunks.length >= UNIFIED_PATCH_MAX_HUNKS_PER_FILE_V1) {
      throw new UnifiedPatchErrorV1(
        "patch_too_large",
        `${label} has more than ${UNIFIED_PATCH_MAX_HUNKS_PER_FILE_V1} hunks; split the patch.`,
      );
    }
    const read = readHunk(lines, index, hunks.length + 1, label);
    hunks.push(read.hunk);
    index = read.next;
  }
  if (oldPath === DEV_NULL && newPath === DEV_NULL) {
    throw new UnifiedPatchErrorV1("patch_invalid", `Line ${start + 1} names no file on either side.`);
  }
  if (oldPath === DEV_NULL) {
    if (hunks.some((hunk) => hunk.lines.some((line) => line.kind !== "add"))) {
      throw new UnifiedPatchErrorV1(
        "patch_invalid",
        `${newPath} is a new file, so its hunks can only add lines.`,
      );
    }
    files.push(fileOf("add", newPath, null, hunks));
  } else if (newPath === DEV_NULL) {
    if (hunks.some((hunk) => hunk.lines.some((line) => line.kind === "add"))) {
      throw new UnifiedPatchErrorV1(
        "patch_invalid",
        `${oldPath} is deleted, so its hunks can only remove lines.`,
      );
    }
    files.push(fileOf("delete", oldPath, null, hunks));
  } else if (git?.renameFrom && git.renameTo) {
    files.push(fileOf("rename", git.renameTo, git.renameFrom, hunks));
  } else if (oldPath !== newPath) {
    files.push(fileOf("rename", newPath, oldPath, hunks));
  } else {
    if (hunks.length === 0) {
      throw new UnifiedPatchErrorV1("patch_invalid", `The section for ${newPath} has no hunks.`);
    }
    files.push(fileOf("modify", newPath, null, hunks));
  }
  return index;
}

function readHunk(
  lines: string[],
  start: number,
  hunkIndex: number,
  label: string,
): { hunk: UnifiedPatchHunkV1; next: number } {
  const header = parseHunkHeader(lines[start]!, start);
  let remainingOld = header.oldLines;
  let remainingNew = header.newLines;
  const counted = remainingOld !== null && remainingNew !== null;
  const body: UnifiedPatchLineV1[] = [];
  let oldEndsWithoutNewline = false;
  let newEndsWithoutNewline = false;
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("\\")) {
      const previous = body.at(-1);
      if (!previous) {
        throw new UnifiedPatchErrorV1(
          "patch_invalid",
          `Line ${index + 1}: a "\\ No newline" marker must follow a line of the hunk.`,
        );
      }
      if (previous.kind !== "add") oldEndsWithoutNewline = true;
      if (previous.kind !== "remove") newEndsWithoutNewline = true;
      continue;
    }
    const countsLeft = counted && ((remainingOld ?? 0) > 0 || (remainingNew ?? 0) > 0);
    if (countsLeft) {
      // While the header's counts say lines remain, a line is the hunk's
      // unless it plainly is not (counts too high end the hunk here).
      if (line !== "" && !BODY_PREFIXES.includes(line[0]!)) break;
    } else {
      if (isHunkHeader(line) || line.startsWith("diff --git ") || isFileHeaderAt(lines, index)) break;
      if (line === "" ? blankRunEndsHunk(lines, index) : !BODY_PREFIXES.includes(line[0]!)) break;
    }
    const kind: UnifiedPatchLineV1["kind"] =
      line === "" || line[0] === " " ? "context" : line[0] === "-" ? "remove" : "add";
    body.push({ kind, text: line === "" ? "" : line.slice(1) });
    if (counted) {
      if (kind !== "add") remainingOld = (remainingOld ?? 0) - 1;
      if (kind !== "remove") remainingNew = (remainingNew ?? 0) - 1;
    }
  }
  if (body.length === 0) {
    throw new UnifiedPatchErrorV1("patch_invalid", `Hunk ${hunkIndex} of ${label} has no lines.`);
  }
  if (!body.some((line) => line.kind !== "context")) {
    throw new UnifiedPatchErrorV1("patch_invalid", `Hunk ${hunkIndex} of ${label} changes nothing.`);
  }
  return {
    hunk: {
      index: hunkIndex,
      oldStart: header.oldStart,
      oldLines: header.oldLines,
      lines: body,
      oldEndsWithoutNewline,
      newEndsWithoutNewline,
    },
    next: index,
  };
}

interface TextLineV1 {
  text: string;
  /** Whether the line's break is CRLF. */
  cr: boolean;
}

interface SplitTextV1 {
  lines: TextLineV1[];
  endsWithNewline: boolean;
  /** Whether most of the file's line breaks are CRLF: the break a new line gets. */
  crlf: boolean;
}

function splitText(content: string): SplitTextV1 {
  if (content === "") return { lines: [], endsWithNewline: false, crlf: false };
  const parts = content.split("\n");
  const endsWithNewline = parts[parts.length - 1] === "";
  if (endsWithNewline) parts.pop();
  let breaks = 0;
  let crlfBreaks = 0;
  const lines = parts.map((part, index) => {
    const terminated = index < parts.length - 1 || endsWithNewline;
    if (!terminated) return { text: part, cr: false };
    breaks += 1;
    if (part.endsWith("\r")) {
      crlfBreaks += 1;
      return { text: part.slice(0, -1), cr: true };
    }
    return { text: part, cr: false };
  });
  const crlf = breaks > 0 && crlfBreaks * 2 > breaks;
  // An unterminated last line takes the file's usual break if a line comes after it.
  if (!endsWithNewline && lines.length > 0) lines[lines.length - 1]!.cr = crlf;
  return { lines, endsWithNewline, crlf };
}

function joinText(lines: readonly TextLineV1[], endsWithNewline: boolean): string {
  let out = "";
  lines.forEach((line, index) => {
    out += line.text;
    if (index < lines.length - 1 || endsWithNewline) out += line.cr ? "\r\n" : "\n";
  });
  return out;
}

function applyHunks(file: UnifiedPatchFileV1, source: SplitTextV1): string {
  const out: TextLineV1[] = [];
  let cursor = 0;
  let endsWithNewline = source.endsWithNewline;
  for (const hunk of file.hunks) {
    const expected = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const at = expected.length === 0
      ? insertionPoint(file, hunk, source, cursor)
      : matchPoint(file, hunk, source, expected, cursor);
    out.push(...source.lines.slice(cursor, at));
    let position = at;
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        out.push(source.lines[position]!);
        position += 1;
      } else if (line.kind === "remove") {
        position += 1;
      } else {
        out.push({ text: line.text, cr: source.crlf });
      }
    }
    cursor = position;
    if (cursor === source.lines.length) {
      if (source.lines.length === 0) endsWithNewline = !hunk.newEndsWithoutNewline;
      else if (hunk.newEndsWithoutNewline || hunk.oldEndsWithoutNewline) {
        endsWithNewline = !hunk.newEndsWithoutNewline;
      }
    }
  }
  out.push(...source.lines.slice(cursor));
  return joinText(out, out.length > 0 && endsWithNewline);
}

function insertionPoint(
  file: UnifiedPatchFileV1,
  hunk: UnifiedPatchHunkV1,
  source: SplitTextV1,
  cursor: number,
): number {
  let at: number;
  if (hunk.oldStart === null) {
    if (source.lines.length !== 0) {
      throw new UnifiedPatchErrorV1(
        "patch_hunk_mismatch",
        `Hunk ${hunk.index} of ${file.path} only adds lines and names no line number, so where they go is not known. Add context lines around them.`,
      );
    }
    at = 0;
  } else {
    // "-k,0" adds after line k.
    at = hunk.oldLines === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1);
  }
  if (at < cursor || at > source.lines.length) {
    throw new UnifiedPatchErrorV1(
      "patch_hunk_mismatch",
      `Hunk ${hunk.index} of ${file.path} adds lines after line ${at}, which is not in the file (${source.lines.length} lines) after the hunk before it.`,
    );
  }
  return at;
}

function matchPoint(
  file: UnifiedPatchFileV1,
  hunk: UnifiedPatchHunkV1,
  source: SplitTextV1,
  expected: readonly string[],
  cursor: number,
): number {
  const matches = findMatches(source.lines, expected, cursor, (a, b) => a === b);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const hint = hunk.oldStart !== null ? Math.max(0, hunk.oldStart - 1) : null;
    if (hint !== null && matches.includes(hint)) return hint;
    throw new UnifiedPatchErrorV1(
      "patch_hunk_ambiguous",
      `Hunk ${hunk.index} of ${file.path} matches ${matches.length} places${matches.length > MAX_REPORTED_MATCHES ? " or more" : ""} (lines ${matches.slice(0, 5).map((at) => at + 1).join(", ")}); add context lines, or a line number that names one of them.`,
    );
  }
  const spacing = findMatches(source.lines, expected, cursor, (a, b) => a.trim() === b.trim());
  const first = expected[0] ?? "";
  const quoted = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  throw new UnifiedPatchErrorV1(
    "patch_hunk_mismatch",
    `Hunk ${hunk.index} of ${file.path} does not apply: its ${expected.length} context and removed line(s), from "${quoted}", are not in the file as written` +
      (cursor > 0 ? ` after line ${cursor}` : "") +
      (spacing.length > 0
        ? `. The file has them at line ${spacing[0]! + 1} with different spacing or indentation; copy the lines exactly as code_workspace_read shows them.`
        : ". Read the file again and make the hunk from its lines as they are."),
  );
}

const MAX_REPORTED_MATCHES = 50;

function findMatches(
  lines: readonly TextLineV1[],
  expected: readonly string[],
  from: number,
  same: (fileLine: string, patchLine: string) => boolean,
): number[] {
  const matches: number[] = [];
  for (let at = from; at + expected.length <= lines.length; at += 1) {
    let ok = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (!same(lines[at + offset]!.text, expected[offset]!)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matches.push(at);
      if (matches.length > MAX_REPORTED_MATCHES) break;
    }
  }
  return matches;
}

function assertWholeFileRemoved(file: UnifiedPatchFileV1, source: SplitTextV1): void {
  if (file.hunks.length === 0) return;
  const removed = file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text));
  const whole =
    removed.length === source.lines.length &&
    removed.every((text, index) => text === source.lines[index]!.text);
  if (!whole) {
    throw new UnifiedPatchErrorV1(
      "patch_delete_mismatch",
      `The patch deletes ${file.path}, but its lines are not the file's whole text as it is now. Read the file again, or give the delete with no hunks.`,
    );
  }
}

function addedContent(file: UnifiedPatchFileV1): string {
  const lines = file.hunks.flatMap((hunk) => hunk.lines.map((line) => ({ text: line.text, cr: false })));
  if (lines.length === 0) return "";
  const last = file.hunks[file.hunks.length - 1]!;
  return joinText(lines, !last.newEndsWithoutNewline);
}

function countLines(file: UnifiedPatchFileV1): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "remove") removed += 1;
    }
  }
  return { added, removed };
}

const DEV_NULL = "/dev/null";
const BODY_PREFIXES = [" ", "+", "-"];

function fileOf(
  kind: UnifiedPatchFileKindV1,
  rawPath: string,
  rawFromPath: string | null,
  hunks: UnifiedPatchHunkV1[],
): UnifiedPatchFileV1 {
  return {
    kind,
    path: workspacePath(rawPath),
    fromPath: rawFromPath === null ? null : workspacePath(rawFromPath),
    hunks,
  };
}

function workspacePath(raw: string): string {
  try {
    return assertWorkspaceRelativePathV2(raw.replace(/^\.\//u, ""), "patch path");
  } catch (error) {
    throw new UnifiedPatchErrorV1(
      "patch_path_invalid",
      `The patch names ${JSON.stringify(raw)}, which is not a path inside the workspace: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function headerPath(raw: string): string {
  // diff -u puts a tab and a timestamp after the name.
  const name = raw.split("\t")[0]!.trimEnd();
  if (name.startsWith("\"")) {
    throw new UnifiedPatchErrorV1(
      "patch_path_invalid",
      `The patch quotes the path ${name}; name a file whose path needs quoting with code_workspace_patch instead.`,
    );
  }
  return name;
}

function gitPath(raw: string): string {
  return headerPath(raw);
}

function gitHeaderPaths(header: string): { oldPath: string; newPath: string } | null {
  const rest = header.slice("diff --git ".length);
  if (!rest.startsWith("a/")) return null;
  const parts = rest.split(" b/");
  if (parts.length !== 2) return null;
  return { oldPath: parts[0]!.slice(2), newPath: parts[1]! };
}

function isFileHeaderAt(lines: readonly string[], index: number): boolean {
  return Boolean(lines[index]?.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "));
}

function isHunkHeader(line: string): boolean {
  return line.startsWith("@@");
}

function isBinaryMarker(line: string): boolean {
  return line.startsWith("GIT binary patch") || (line.startsWith("Binary files ") && line.endsWith(" differ"));
}

function binaryRefusal(): UnifiedPatchErrorV1 {
  return new UnifiedPatchErrorV1(
    "patch_binary_unsupported",
    "The patch changes a binary file; a workspace edit changes text only.",
  );
}

function blankRunEndsHunk(lines: readonly string[], index: number): boolean {
  let next = index;
  while (next < lines.length && lines[next] === "") next += 1;
  if (next >= lines.length) return true;
  const line = lines[next]!;
  return (
    isHunkHeader(line) ||
    line.startsWith("diff --git ") ||
    isFileHeaderAt(lines, next) ||
    !(BODY_PREFIXES.includes(line[0]!) || line.startsWith("\\"))
  );
}

function parseHunkHeader(
  line: string,
  index: number,
): { oldStart: number | null; oldLines: number | null; newLines: number | null } {
  if (/^@@\s*(?:@@.*)?$/u.test(line)) return { oldStart: null, oldLines: null, newLines: null };
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (!match) {
    throw new UnifiedPatchErrorV1(
      "patch_invalid",
      `Line ${index + 1} is not a hunk header: write it as @@ -<line>,<count> +<line>,<count> @@.`,
    );
  }
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}
