/**
 * How the code workspace's reading and finding tools reach a model.
 *
 * Every other tool result is slimmed to a whitelist of keys inside an
 * 8,000-character JSON envelope, and an object's `content` becomes a few
 * query-ranked evidence passages. That is right for a web page and wrong for
 * code: a model editing a file needs the exact lines it will change, with
 * their numbers, and a model looking for something needs the matching lines,
 * not a list of paths and scores. So the three code tools are rendered here as
 * text, numbered and bounded:
 *
 * - `code_workspace_read`: the file's lines, `  41  text`, under a header
 *   `path · lines 41–180 of 612 · sha256:…`, ending with the exact call that
 *   reads on when the answer had to stop before the end. Its budget is a run
 *   option (`codeReadBudgetChars`), 7,000 characters by default so the answer
 *   still fits the 8,000-character envelope, and up to 60,000 for a host
 *   whose model can take it.
 * - `code_workspace_search`: `path:line:column: text` lines, with context
 *   lines as `path-line- text`, headed by what was searched and skipped.
 * - `code_workspace_list`: an indented tree, folders ending in `/`.
 *
 * Every budget is measured on the JSON-escaped text, because that is what is
 * sent. Pure: no file system, no agent-layer imports.
 */

export const DEFAULT_CODE_READ_BUDGET_CHARS_V1 = 7_000;
export const MIN_CODE_READ_BUDGET_CHARS_V1 = 2_000;
export const MAX_CODE_READ_BUDGET_CHARS_V1 = 60_000;
/** Search and listing renderings stay inside the 8,000-character envelope. */
export const CODE_FINDING_RENDER_BUDGET_CHARS_V1 = 6_800;
/** A search hit or context line longer than this is shown cut. */
const MAX_SEARCH_LINE_CHARS = 300;
const MAX_SKIPPED_NAMED = 8;

/** Clamp a host-supplied code-read budget; anything unusable is the default. */
export function normalizeCodeReadBudgetCharsV1(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CODE_READ_BUDGET_CHARS_V1;
  }
  return Math.min(
    MAX_CODE_READ_BUDGET_CHARS_V1,
    Math.max(MIN_CODE_READ_BUDGET_CHARS_V1, Math.trunc(value)),
  );
}

export interface CodeLineSpanV1 {
  /** Offset of the line's first character. */
  start: number;
  /** Offset just past the line's text, before its line break. */
  end: number;
  /** Offset of the next line (just past the line break). */
  next: number;
}

/**
 * The lines of a text as an editor and a compiler number them: `\r\n`, `\r`
 * and `\n` each end a line, and a final line break does not start another
 * line. An empty text has no lines.
 */
export function codeLineSpansV1(content: string): CodeLineSpanV1[] {
  const spans: CodeLineSpanV1[] = [];
  const breaks = /\r\n|\r|\n/gu;
  let start = 0;
  for (let match = breaks.exec(content); match; match = breaks.exec(content)) {
    spans.push({ start, end: match.index, next: match.index + match[0].length });
    start = match.index + match[0].length;
  }
  if (start < content.length) {
    spans.push({ start, end: content.length, next: content.length });
  }
  return spans;
}

/** Characters this text costs inside a JSON string. */
export function jsonEscapedLengthV1(text: string): number {
  return JSON.stringify(text).length - 2;
}

export interface CodeModelRenderingV1 {
  summary: string;
  output: Record<string, unknown>;
  /** True when the rendering left out part of what the tool returned. */
  truncated: boolean;
  evidenceRefs?: string[];
}

// ---------------------------------------------------------------------------
// code_workspace_read

export function renderCodeWorkspaceReadForModelV1(
  output: Record<string, unknown>,
  budgetChars: number,
): CodeModelRenderingV1 | null {
  if (typeof output.path !== "string" || typeof output.content !== "string") {
    return null;
  }
  const path = output.path;
  const content = output.content;
  const sha256 = typeof output.sha256 === "string" ? output.sha256 : null;
  const workspaceId = typeof output.workspaceId === "string" ? output.workspaceId : null;
  const spans = codeLineSpansV1(content);
  const firstLine = positiveInteger(output.startLine) ?? 1;
  const returnedEnd = spans.length === 0 ? firstLine - 1 : firstLine + spans.length - 1;
  const totalLines = Math.max(positiveIntegerOrZero(output.totalLines) ?? returnedEnd, returnedEnd);
  const crlf = /\r\n/u.test(content);
  const width = String(Math.max(1, totalLines)).length;

  // The header names the lines actually shown, which are known only after the
  // budget has been spent; it is costed at the longest it could be.
  const headerFor = (lastShown: number) => {
    const parts = [
      path,
      totalLines === 0
        ? "empty file"
        : spans.length === 0
          ? `no lines (the file has ${totalLines})`
          : `lines ${firstLine}–${lastShown} of ${totalLines}`,
    ];
    if (sha256) parts.push(sha256);
    if (crlf) parts.push("CRLF line endings");
    return parts.join(" · ");
  };

  const lines: string[] = [headerFor(returnedEnd)];
  let used = jsonEscapedLengthV1(lines[0]!) + 2;
  // Leave room for the closing "read on" line (the path and workspace are in
  // it once each) and, for a CRLF file, the note about line endings.
  const reserve = 180 + jsonEscapedLengthV1(path) +
    (workspaceId ? jsonEscapedLengthV1(workspaceId) : 0) + (crlf ? 120 : 0);
  const available = Math.max(400, budgetChars - reserve);
  let shownEnd = firstLine - 1;
  let clippedLine: number | null = null;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const number = firstLine + index;
    const text = content.slice(span.start, span.end);
    const rendered = `${String(number).padStart(width)}  ${text}`;
    const cost = jsonEscapedLengthV1(rendered) + 2;
    if (used + cost > available) {
      if (index === 0) {
        // One line longer than the whole budget: show its start, say so, and
        // still move the reader on to the next line.
        const room = Math.max(80, available - used - 120);
        const head = cutToEscapedLength(text, room);
        lines.push(
          `${String(number).padStart(width)}  ${head} … [line ${number} cut: it has ${text.length.toLocaleString("en-US")} characters]`,
        );
        shownEnd = number;
        clippedLine = number;
      }
      break;
    }
    lines.push(rendered);
    used += cost;
    shownEnd = number;
  }

  if (spans.length > 0) lines[0] = headerFor(shownEnd);
  const requestedEnd = returnedEnd;
  const cutByBudget = shownEnd < requestedEnd || clippedLine !== null;
  const nextStartLine = shownEnd < totalLines ? shownEnd + 1 : null;
  if (nextStartLine !== null) {
    const call: Record<string, unknown> = {};
    if (workspaceId) call.workspaceId = workspaceId;
    call.path = path;
    call.startLine = nextStartLine;
    if (shownEnd < requestedEnd && requestedEnd < totalLines) {
      call.lineCount = requestedEnd - shownEnd;
    }
    const why = cutByBudget
      ? `Shown to line ${shownEnd} of ${totalLines} to fit this answer.`
      : `Lines ${nextStartLine}–${totalLines} follow.`;
    lines.push(`[${why} Read on: code_workspace_read ${JSON.stringify(call)}]`);
  }
  if (crlf) {
    lines.push("[This file uses CRLF line endings: a multi-line oldText for code_workspace_patch must use \\r\\n.]");
  }
  const shownStart = spans.length === 0 ? null : firstLine;
  const rangeWords = shownStart === null
    ? totalLines === 0 ? "the empty file" : "no lines"
    : `lines ${shownStart}–${shownEnd} of ${totalLines}`;
  return {
    summary: `Read ${path} ${rangeWords}.`,
    truncated: cutByBudget,
    evidenceRefs: [path],
    output: {
      path,
      ...(sha256 ? { sha256 } : {}),
      startLine: shownStart ?? firstLine,
      endLine: shownEnd,
      totalLines,
      nextStartLine,
      wholeFile: totalLines === 0 || (shownStart === 1 && nextStartLine === null && !cutByBudget),
      numberedLines: lines.join("\n"),
    },
  };
}

// ---------------------------------------------------------------------------
// code_workspace_search

interface SearchHitShape {
  path: string;
  line: number;
  column: number;
  preview: string;
  before: Array<{ line: number; text: string }>;
  after: Array<{ line: number; text: string }>;
}

export function renderCodeWorkspaceSearchForModelV1(
  output: Record<string, unknown>,
  budgetChars = CODE_FINDING_RENDER_BUDGET_CHARS_V1,
): CodeModelRenderingV1 | null {
  if (!Array.isArray(output.results)) return null;
  const hits: SearchHitShape[] = [];
  for (const item of output.results) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.preview !== "string") continue;
    const line = positiveInteger(item.line);
    const column = positiveInteger(item.column) ?? 1;
    if (line === null) continue;
    hits.push({
      path: item.path,
      line,
      column,
      preview: item.preview,
      before: contextLines(item.before),
      after: contextLines(item.after),
    });
  }
  const query = typeof output.query === "string" ? output.query : "";
  const regex = output.regex === true;
  const caseSensitive = output.caseSensitive === true;
  const matchCount = positiveIntegerOrZero(output.matchCount) ?? hits.length;
  const filesSearched = positiveIntegerOrZero(output.filesSearched);
  const filesSkipped = positiveIntegerOrZero(output.filesSkipped) ?? 0;
  const fileCount = new Set(hits.map((hit) => hit.path)).size;

  const what = regex ? `/${query}/${caseSensitive ? "" : "i"}` : JSON.stringify(query);
  const scope = typeof output.path === "string" && output.path ? ` in ${output.path}/` : "";
  const filters: string[] = [];
  if (Array.isArray(output.include) && output.include.length > 0) {
    filters.push(`include ${output.include.filter((value) => typeof value === "string").join(", ")}`);
  }
  if (Array.isArray(output.exclude) && output.exclude.length > 0) {
    filters.push(`exclude ${output.exclude.filter((value) => typeof value === "string").join(", ")}`);
  }
  const counted = matchCount === 0
    ? "no matches"
    : `${matchCount.toLocaleString("en-US")} ${matchCount === 1 ? "match" : "matches"}${matchCount > hits.length ? ` (the first ${hits.length} returned)` : ""} in ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const searchedWords = filesSearched === null
    ? ""
    : ` · ${filesSearched.toLocaleString("en-US")} ${filesSearched === 1 ? "file" : "files"} searched${filesSkipped > 0 ? `, ${filesSkipped} skipped` : ""}`;
  const order = regex ? "in file order" : "best match first";
  const header = `Search for ${what}${scope}${filters.length ? ` (${filters.join("; ")})` : ""}: ${counted}${searchedWords}${matchCount > 0 ? ` · ${order}` : ""}`;

  const lines: string[] = [header];
  if (hits.some((hit) => hit.before.length > 0 || hit.after.length > 0)) {
    lines.push("Matches are path:line:column: text; context lines are path-line- text.");
  }
  const skippedLine = describeSkipped(output);
  const stoppedLine = describeStopped(output);
  const trailer = [skippedLine, stoppedLine].filter((value): value is string => Boolean(value));
  let used = lines.reduce((total, line) => total + jsonEscapedLengthV1(line) + 2, 0);
  const reserved = trailer.reduce((total, line) => total + jsonEscapedLengthV1(line) + 2, 0) + 220;
  const available = Math.max(600, budgetChars - reserved);

  const withContext = hits.some((hit) => hit.before.length > 0 || hit.after.length > 0);
  let shown = 0;
  let lastPath: string | null = null;
  let lastLinePrinted = 0;
  for (const hit of hits) {
    const samePath = lastPath === hit.path;
    const printedBefore = samePath ? lastLinePrinted : 0;
    const blockStart = hit.before[0]?.line ?? hit.line;
    const block: string[] = [];
    if (withContext && shown > 0 && !(samePath && blockStart <= printedBefore + 1)) block.push("--");
    for (const entry of hit.before) {
      if (entry.line <= printedBefore) continue;
      block.push(`${hit.path}-${entry.line}- ${clipLine(entry.text)}`);
    }
    block.push(`${hit.path}:${hit.line}:${hit.column}: ${clipLine(hit.preview)}`);
    let lastInBlock = hit.line;
    for (const entry of hit.after) {
      block.push(`${hit.path}-${entry.line}- ${clipLine(entry.text)}`);
      lastInBlock = Math.max(lastInBlock, entry.line);
    }
    const cost = block.reduce((total, line) => total + jsonEscapedLengthV1(line) + 2, 0);
    if (used + cost > available) break;
    lines.push(...block);
    used += cost;
    shown += 1;
    lastPath = hit.path;
    lastLinePrinted = Math.max(printedBefore, lastInBlock);
  }
  const cut = shown < hits.length;
  if (cut) {
    lines.push(
      `[Showing ${shown} of the ${hits.length} returned matches to fit this answer. Narrow with path, include or exclude, or a more exact query.]`,
    );
  } else if (matchCount > hits.length) {
    lines.push(
      `[${(matchCount - hits.length).toLocaleString("en-US")} more matches were not returned (limit ${hits.length}). Narrow with path, include or exclude, or a more exact query.]`,
    );
  }
  lines.push(...trailer);
  return {
    summary: `code_workspace_search found ${counted}.`,
    truncated: cut,
    output: {
      query,
      regex,
      matchCount,
      shownMatches: shown,
      ...(filesSearched === null ? {} : { filesSearched }),
      filesSkipped,
      lines: lines.join("\n"),
    },
  };
}

function describeSkipped(output: Record<string, unknown>): string | null {
  const counts = isRecord(output.skippedByReason) ? output.skippedByReason : null;
  const named = Array.isArray(output.skipped)
    ? output.skipped.filter((entry): entry is { path: string; reason: string } =>
        isRecord(entry) && typeof entry.path === "string" && typeof entry.reason === "string")
    : [];
  if (!counts && named.length === 0) return null;
  const entries = counts
    ? Object.entries(counts).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0,
      )
    : [];
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0 && named.length === 0) return null;
  const parts = entries.map(([reason, count]) => `${count} ${SKIP_WORDS[reason] ?? reason}`);
  const examples = named
    .slice(0, MAX_SKIPPED_NAMED)
    .map((entry) => `${entry.path} (${SKIP_WORDS[entry.reason] ?? entry.reason})`);
  const counted = total > 0
    ? `Skipped ${total} ${total === 1 ? "entry" : "entries"} it could not search: ${parts.join(", ")}.`
    : "Skipped entries it could not search.";
  return examples.length > 0
    ? `${counted} For example: ${examples.join(", ")}${named.length > examples.length ? ", …" : ""}.`
    : counted;
}

const SKIP_WORDS: Record<string, string> = {
  binary: "binary",
  too_large: "over 2 MiB",
  link: "link (not followed)",
  nested_git: "nested .git",
  hard_link: "hard-linked",
  unreadable: "unreadable",
  unsupported: "not a regular file",
};

function describeStopped(output: Record<string, unknown>): string | null {
  switch (output.stoppedReason) {
    case "entry_cap":
      return "[The walk stopped at its entry limit, so later files were not searched. Narrow with path or include.]";
    case "candidate_cap":
      return "[The search stopped collecting at its match limit. Narrow with path, include or a more exact query.]";
    case "time_budget":
      return "[The search ran out of time, so later files were not searched. Narrow with path or include, or simplify the expression.]";
    default:
      return null;
  }
}

function contextLines(value: unknown): Array<{ line: number; text: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ line: number; text: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.text !== "string") continue;
    const line = positiveInteger(entry.line);
    if (line !== null) out.push({ line, text: entry.text });
  }
  return out;
}

function clipLine(text: string): string {
  return text.length > MAX_SEARCH_LINE_CHARS ? `${text.slice(0, MAX_SEARCH_LINE_CHARS)} …` : text;
}

// ---------------------------------------------------------------------------
// code_workspace_list

interface TreeEntryShape {
  path: string;
  kind: string;
  bytes: number;
  depth: number;
  note: string | null;
}

export function renderCodeWorkspaceListForModelV1(
  output: Record<string, unknown>,
  budgetChars = CODE_FINDING_RENDER_BUDGET_CHARS_V1,
): CodeModelRenderingV1 | null {
  if (!Array.isArray(output.entries)) return null;
  const root = typeof output.path === "string" ? output.path : "";
  const entries: TreeEntryShape[] = [];
  for (const item of output.entries) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.kind !== "string") continue;
    entries.push({
      path: item.path,
      kind: item.kind,
      bytes: positiveIntegerOrZero(item.bytes) ?? 0,
      depth: positiveInteger(item.depth) ?? 1,
      note: typeof item.note === "string" ? item.note : null,
    });
  }
  const files = positiveIntegerOrZero(output.files) ?? entries.filter((entry) => entry.kind === "file").length;
  const directories = positiveIntegerOrZero(output.directories) ??
    entries.filter((entry) => entry.kind === "directory").length;
  const maxDepth = positiveInteger(output.maxDepth) ?? 1;
  const recursive = output.recursive === true;
  const glob = typeof output.glob === "string" && output.glob ? output.glob : null;
  const headerParts = [
    root ? `${root}/` : "./ (workspace root)",
    recursive ? `${maxDepth} ${maxDepth === 1 ? "level" : "levels"} deep` : "one level",
  ];
  if (glob) headerParts.push(`files matching ${glob}`);
  headerParts.push(`${directories} ${directories === 1 ? "folder" : "folders"}, ${files} ${files === 1 ? "file" : "files"}`);
  const lines: string[] = [headerParts.join(" · "), root ? `${root}/` : "./"];
  const stoppedAt = typeof output.stoppedAt === "string" ? output.stoppedAt : null;
  const toolCut = output.truncated === true;
  const notesSeen = new Set(entries.map((entry) => entry.note).filter((note): note is string => Boolean(note)));
  const tail: string[] = [];
  if (notesSeen.has("dependency_or_build")) {
    tail.push("[Folders marked [dependency or build] are left out; list one by its path to see inside.]");
  }
  if (notesSeen.has("not_expanded")) {
    tail.push("[Folders marked [not expanded] go deeper than maxDepth; raise maxDepth or list one by its path.]");
  }
  if (toolCut) {
    tail.push(`[Stopped${stoppedAt ? ` at ${stoppedAt}` : ""} at the listing limit. List a narrower path, or add a glob.]`);
  }
  let used = lines.reduce((total, line) => total + jsonEscapedLengthV1(line) + 2, 0);
  const reserved = tail.reduce((total, line) => total + jsonEscapedLengthV1(line) + 2, 0) + 240;
  const available = Math.max(600, budgetChars - reserved);
  let shown = 0;
  let cutAt: string | null = null;
  for (const entry of entries) {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const indent = "  ".repeat(Math.max(1, entry.depth));
    let rendered: string;
    if (entry.kind === "directory") {
      rendered = `${indent}${name}/${NOTE_WORDS[entry.note ?? ""] ?? ""}`;
    } else if (entry.kind === "file") {
      rendered = `${indent}${name}  [${formatBytes(entry.bytes)}]`;
    } else {
      rendered = `${indent}${name}${NOTE_WORDS[entry.note ?? entry.kind] ?? "  [not a regular file]"}`;
    }
    const cost = jsonEscapedLengthV1(rendered) + 2;
    if (used + cost > available) {
      cutAt = entry.path;
      break;
    }
    lines.push(rendered);
    used += cost;
    shown += 1;
  }
  if (entries.length === 0) {
    lines.push(glob ? "  (no files match)" : "  (empty)");
  }
  if (cutAt) {
    lines.push(
      `[Shown ${shown} of ${entries.length} entries to fit this answer; stopped before ${cutAt}. List a narrower path, lower maxDepth, or add a glob.]`,
    );
  }
  lines.push(...tail);
  return {
    summary: `code_workspace_list returned ${entries.length} ${entries.length === 1 ? "entry" : "entries"} under ${root || "the workspace root"}.`,
    truncated: cutAt !== null,
    output: {
      path: root,
      entryCount: entries.length,
      shownEntries: shown,
      tree: lines.join("\n"),
    },
  };
}

const NOTE_WORDS: Record<string, string> = {
  dependency_or_build: "  [dependency or build]",
  not_expanded: "  [not expanded]",
  link: "  [link, not followed]",
  nested_git: "  [nested .git, not listed]",
  unsupported: "  [not a regular file]",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------

function cutToEscapedLength(text: string, limit: number): string {
  if (jsonEscapedLengthV1(text) <= limit) return text;
  let low = 0;
  let high = Math.min(text.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonEscapedLengthV1(text.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  let cut = text.slice(0, low);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function positiveIntegerOrZero(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
