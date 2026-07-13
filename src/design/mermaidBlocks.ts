export const MERMAID_BLOCK_ID_MARKER_PREFIX = "<!-- agentic-mermaid:block-id=";
export const MERMAID_MAX_BYTES = 256 * 1024;
export const MERMAID_MAX_LINES = 5_000;
export const MERMAID_MARKDOWN_MAX_BYTES = 5 * 1024 * 1024;

const BLOCK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const BLOCK_ID_MARKER = /^ {0,3}<!-- agentic-mermaid:block-id=([a-z0-9][a-z0-9._-]{0,63}) -->[\t ]*$/u;
const ATX_HEADING = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*$/u;
const SETEXT_HEADING = /^ {0,3}(=+|-+)[\t ]*$/u;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

export type MermaidBlockSelector =
  | { kind: "heading"; heading: string }
  | { kind: "block_id"; blockId: string };

export interface MermaidHeadingMetadata {
  text: string;
  level: number;
  start: number;
  end: number;
  sectionEnd: number;
}

export interface MermaidBlockMetadata {
  index: number;
  blockId: string | null;
  heading: MermaidHeadingMetadata | null;
  markerStart: number | null;
  markerEnd: number | null;
  blockStart: number;
  blockEnd: number;
  contentStart: number;
  contentEnd: number;
  fence: "`" | "~";
  fenceLength: number;
  bytes: number;
}

export interface MermaidBlockReadResult {
  mermaid: string;
  metadata: MermaidBlockMetadata;
}

export interface MermaidSelectorMetadata {
  selector: MermaidBlockSelector;
  matched: boolean;
  block: MermaidBlockMetadata | null;
}

export interface MermaidBlockUpsertResult {
  operation: "insert" | "update";
  markdown: string;
  before: MermaidSelectorMetadata;
  after: MermaidSelectorMetadata;
  changedRange: {
    beforeStart: number;
    beforeEnd: number;
    afterStart: number;
    afterEnd: number;
  };
}

export class MermaidBlockError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MermaidBlockError";
  }
}

export function mermaidBlockIdMarker(blockIdInput: string): string {
  const blockId = validateBlockId(blockIdInput);
  return `${MERMAID_BLOCK_ID_MARKER_PREFIX}${blockId} -->`;
}

export function listMermaidBlocks(markdownInput: string): MermaidBlockMetadata[] {
  const markdown = validateMarkdown(markdownInput);
  return parseMarkdown(markdown).blocks.map(cloneBlockMetadata);
}

export function readMermaidBlock(
  markdownInput: string,
  selectorInput: MermaidBlockSelector,
): MermaidBlockReadResult {
  const markdown = validateMarkdown(markdownInput);
  const parsed = parseMarkdown(markdown);
  const selected = selectBlock(parsed, normalizeSelector(selectorInput), false);
  if (!selected.block) {
    throw new MermaidBlockError(
      "block_not_found",
      `No Mermaid block matches ${selectorLabel(selected.selector)}.`,
    );
  }
  return {
    mermaid: contentWithoutFenceSeparator(
      markdown.slice(selected.block.contentStart, selected.block.contentEnd),
    ),
    metadata: cloneBlockMetadata(selected.block),
  };
}

export function upsertMermaidBlock(
  markdownInput: string,
  selectorInput: MermaidBlockSelector,
  mermaidInput: string,
): MermaidBlockUpsertResult {
  const markdown = validateMarkdown(markdownInput);
  const selector = normalizeSelector(selectorInput);
  const mermaid = validateMermaidText(mermaidInput);
  const parsed = parseMarkdown(markdown);
  const beforeSelection = selectBlock(parsed, selector, true);
  const before: MermaidSelectorMetadata = {
    selector,
    matched: Boolean(beforeSelection.block),
    block: beforeSelection.block
      ? cloneBlockMetadata(beforeSelection.block)
      : null,
  };
  const eol = detectEol(markdown);
  let updated: string;
  let operation: MermaidBlockUpsertResult["operation"];
  let beforeStart: number;
  let beforeEnd: number;
  let afterStart: number;
  let afterEnd: number;

  if (beforeSelection.block) {
    const block = beforeSelection.block;
    const replacement = `${mermaid}${eol}`;
    updated = `${markdown.slice(0, block.contentStart)}${replacement}${markdown.slice(block.contentEnd)}`;
    operation = "update";
    beforeStart = block.contentStart;
    beforeEnd = block.contentEnd;
    afterStart = block.contentStart;
    afterEnd = block.contentStart + replacement.length;
  } else {
    const insertionOffset = selector.kind === "heading"
      ? requireUniqueHeading(parsed, selector.heading).sectionEnd
      : markdown.length;
    const fenced = selector.kind === "block_id"
      ? `${mermaidBlockIdMarker(selector.blockId)}${eol}\`\`\`mermaid${eol}${mermaid}${eol}\`\`\`${eol}`
      : `\`\`\`mermaid${eol}${mermaid}${eol}\`\`\`${eol}`;
    const insertion = insertionText(markdown, insertionOffset, fenced, eol);
    updated = `${markdown.slice(0, insertionOffset)}${insertion}${markdown.slice(insertionOffset)}`;
    operation = "insert";
    beforeStart = insertionOffset;
    beforeEnd = insertionOffset;
    afterStart = insertionOffset;
    afterEnd = insertionOffset + insertion.length;
  }

  validateMarkdown(updated);
  const afterSelection = selectBlock(parseMarkdown(updated), selector, false);
  if (!afterSelection.block) {
    throw new MermaidBlockError(
      "upsert_readback_failed",
      `Updated Markdown does not contain ${selectorLabel(selector)}.`,
    );
  }
  const readback = contentWithoutFenceSeparator(
    updated.slice(
      afterSelection.block.contentStart,
      afterSelection.block.contentEnd,
    ),
  );
  if (readback !== mermaid) {
    throw new MermaidBlockError(
      "upsert_readback_failed",
      "Updated Mermaid block failed exact text readback.",
    );
  }
  return {
    operation,
    markdown: updated,
    before,
    after: {
      selector,
      matched: true,
      block: cloneBlockMetadata(afterSelection.block),
    },
    changedRange: { beforeStart, beforeEnd, afterStart, afterEnd },
  };
}

export function validateMermaidText(value: string): string {
  if (typeof value !== "string") {
    throw new MermaidBlockError(
      "invalid_mermaid",
      "Mermaid content must be text.",
    );
  }
  const normalized = value.replace(/(?:\r\n|\n|\r)+$/u, "");
  const bytes = new TextEncoder().encode(normalized).byteLength;
  const lines = normalized.split(/\r\n|\n|\r/u);
  if (
    !normalized.trim() ||
    bytes > MERMAID_MAX_BYTES ||
    lines.length > MERMAID_MAX_LINES ||
    lines.some((line) => new TextEncoder().encode(line).byteLength > 4_096)
  ) {
    throw new MermaidBlockError(
      "mermaid_too_large",
      "Mermaid content must be non-empty and within fixed byte and line limits.",
    );
  }
  if (/```|~~~/u.test(normalized)) {
    dangerous("Mermaid content cannot contain Markdown fence delimiters.");
  }
  if (/%%\s*\{/iu.test(normalized)) {
    dangerous("Mermaid init/config directives are not allowed.");
  }
  if (/\b(?:securityLevel|htmlLabels|flowchart\.htmlLabels)\b/iu.test(normalized)) {
    dangerous("Mermaid security or HTML-label weakening is not allowed.");
  }
  if (/^\s*click\s+/imu.test(normalized)) {
    dangerous("Mermaid click and callback directives are not allowed.");
  }
  if (
    /(?:https?:\/\/|ftp:\/\/|file:|javascript:|data:|\/\/[^\s])/iu.test(normalized) ||
    /\b(?:href|xlink:href)\s*=/iu.test(normalized)
  ) {
    dangerous("Mermaid external links and active URL schemes are not allowed.");
  }
  if (/<\/?(?:script|iframe|object|embed|foreignObject|img|a)\b/iu.test(normalized)) {
    dangerous("Mermaid embedded active HTML is not allowed.");
  }
  return normalized;
}

interface ParsedMarkdown {
  markdown: string;
  lines: MarkdownLine[];
  headings: InternalHeading[];
  blocks: InternalBlock[];
}

interface MarkdownLine {
  index: number;
  start: number;
  textEnd: number;
  end: number;
  text: string;
}

interface FenceRange {
  startLine: number;
  endLine: number;
}

interface InternalHeading extends MermaidHeadingMetadata {
  contentStart: number;
}

interface InternalBlock extends MermaidBlockMetadata {}

function parseMarkdown(markdown: string): ParsedMarkdown {
  const lines = splitLines(markdown);
  const fenceRanges: FenceRange[] = [];
  const blocks: InternalBlock[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    const opening = FENCE_OPEN.exec(line.text);
    if (!opening) {
      lineIndex += 1;
      continue;
    }
    const delimiter = opening[1];
    const fence = delimiter[0] as "`" | "~";
    const fenceLength = delimiter.length;
    const info = opening[2].trim();
    const closingPattern = new RegExp(
      `^ {0,3}${fence === "`" ? "`" : "~"}{${fenceLength},}[\\t ]*$`,
      "u",
    );
    let closingIndex = -1;
    for (let candidate = lineIndex + 1; candidate < lines.length; candidate += 1) {
      if (closingPattern.test(lines[candidate].text)) {
        closingIndex = candidate;
        break;
      }
    }
    const endLine = closingIndex < 0 ? lines.length - 1 : closingIndex;
    fenceRanges.push({ startLine: lineIndex, endLine });
    if (info.toLowerCase() === "mermaid") {
      if (closingIndex < 0) {
        throw new MermaidBlockError(
          "unclosed_mermaid_fence",
          `Mermaid fence opened at line ${lineIndex + 1} is not closed.`,
        );
      }
      const marker = lineIndex > 0
        ? BLOCK_ID_MARKER.exec(lines[lineIndex - 1].text)
        : null;
      const markerLine = marker ? lines[lineIndex - 1] : null;
      const contentStart = line.end;
      const contentEnd = lines[closingIndex].start;
      blocks.push({
        index: blocks.length,
        blockId: marker?.[1] ?? null,
        heading: null,
        markerStart: markerLine?.start ?? null,
        markerEnd: markerLine?.end ?? null,
        blockStart: line.start,
        blockEnd: lines[closingIndex].end,
        contentStart,
        contentEnd,
        fence,
        fenceLength,
        bytes: new TextEncoder().encode(
          contentWithoutFenceSeparator(markdown.slice(contentStart, contentEnd)),
        ).byteLength,
      });
    }
    lineIndex = closingIndex < 0 ? lines.length : closingIndex + 1;
  }

  const fencedLines = new Set<number>();
  for (const range of fenceRanges) {
    for (let index = range.startLine; index <= range.endLine; index += 1) {
      fencedLines.add(index);
    }
  }
  const headings: InternalHeading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (fencedLines.has(index)) continue;
    const line = lines[index];
    const atx = ATX_HEADING.exec(line.text);
    if (atx) {
      const text = normalizeHeadingText(atx[2]);
      if (text) {
        headings.push({
          text,
          level: atx[1].length,
          start: line.start,
          end: line.end,
          contentStart: line.end,
          sectionEnd: markdown.length,
        });
      }
      continue;
    }
    const setext = SETEXT_HEADING.exec(line.text);
    if (!setext || index === 0 || fencedLines.has(index - 1)) continue;
    const titleLine = lines[index - 1];
    const text = titleLine.text.trim();
    if (!text || ATX_HEADING.test(titleLine.text)) continue;
    headings.push({
      text,
      level: setext[1][0] === "=" ? 1 : 2,
      start: titleLine.start,
      end: line.end,
      contentStart: line.end,
      sectionEnd: markdown.length,
    });
  }
  headings.sort((left, right) => left.start - right.start);
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const boundary = headings.slice(index + 1).find(
      (candidate) => candidate.level <= heading.level,
    );
    heading.sectionEnd = boundary?.start ?? markdown.length;
  }
  for (const block of blocks) {
    const heading = [...headings]
      .reverse()
      .find((candidate) =>
        candidate.contentStart <= block.blockStart &&
        block.blockStart < candidate.sectionEnd,
      );
    block.heading = heading ? cloneHeadingMetadata(heading) : null;
  }
  return { markdown, lines, headings, blocks };
}

function selectBlock(
  parsed: ParsedMarkdown,
  selector: MermaidBlockSelector,
  allowMissing: boolean,
): { selector: MermaidBlockSelector; block: InternalBlock | null } {
  let matches: InternalBlock[];
  if (selector.kind === "block_id") {
    matches = parsed.blocks.filter((block) => block.blockId === selector.blockId);
    if (matches.length > 1) {
      throw new MermaidBlockError(
        "ambiguous_block_id",
        `Mermaid block id is duplicated: ${selector.blockId}.`,
      );
    }
  } else {
    const heading = requireUniqueHeading(parsed, selector.heading);
    matches = parsed.blocks.filter((block) =>
      block.blockStart >= heading.contentStart &&
      block.blockStart < heading.sectionEnd,
    );
    if (matches.length > 1) {
      throw new MermaidBlockError(
        "ambiguous_heading_block",
        `Heading contains more than one Mermaid block: ${selector.heading}.`,
      );
    }
  }
  if (matches.length === 0 && !allowMissing) {
    throw new MermaidBlockError(
      "block_not_found",
      `No Mermaid block matches ${selectorLabel(selector)}.`,
    );
  }
  return { selector, block: matches[0] ?? null };
}

function requireUniqueHeading(
  parsed: ParsedMarkdown,
  headingText: string,
): InternalHeading {
  const matches = parsed.headings.filter((heading) => heading.text === headingText);
  if (matches.length === 0) {
    throw new MermaidBlockError(
      "heading_not_found",
      `Markdown heading does not exist: ${headingText}.`,
    );
  }
  if (matches.length > 1) {
    throw new MermaidBlockError(
      "ambiguous_heading",
      `Markdown heading is duplicated: ${headingText}.`,
    );
  }
  return matches[0];
}

function normalizeSelector(selector: MermaidBlockSelector): MermaidBlockSelector {
  if (!selector || typeof selector !== "object") {
    throw new MermaidBlockError(
      "invalid_selector",
      "Mermaid selector must be an exact heading or block id.",
    );
  }
  if (selector.kind === "heading") {
    if (
      typeof selector.heading !== "string" ||
      !selector.heading.trim() ||
      selector.heading !== selector.heading.trim() ||
      selector.heading.length > 300 ||
      /[\0\r\n]/u.test(selector.heading)
    ) {
      throw new MermaidBlockError(
        "invalid_selector",
        "Mermaid heading selector must be one exact heading text.",
      );
    }
    return { kind: "heading", heading: selector.heading };
  }
  if (selector.kind === "block_id") {
    return { kind: "block_id", blockId: validateBlockId(selector.blockId) };
  }
  throw new MermaidBlockError(
    "invalid_selector",
    "Mermaid selector kind must be heading or block_id.",
  );
}

function validateBlockId(value: unknown): string {
  if (typeof value !== "string" || !BLOCK_ID.test(value)) {
    throw new MermaidBlockError(
      "invalid_block_id",
      "Mermaid block id must use lowercase letters, digits, dots, underscores, or hyphens.",
    );
  }
  return value;
}

function validateMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    throw new MermaidBlockError(
      "invalid_markdown",
      "Markdown must be text.",
    );
  }
  if (new TextEncoder().encode(value).byteLength > MERMAID_MARKDOWN_MAX_BYTES) {
    throw new MermaidBlockError(
      "markdown_too_large",
      `Markdown exceeds ${MERMAID_MARKDOWN_MAX_BYTES} bytes.`,
    );
  }
  return value;
}

function splitLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  let index = 0;
  while (start < markdown.length) {
    let cursor = start;
    while (cursor < markdown.length && markdown[cursor] !== "\n" && markdown[cursor] !== "\r") {
      cursor += 1;
    }
    let end = cursor;
    if (cursor < markdown.length) {
      end = cursor + 1;
      if (markdown[cursor] === "\r" && markdown[cursor + 1] === "\n") end += 1;
    }
    lines.push({
      index,
      start,
      textEnd: cursor,
      end,
      text: markdown.slice(start, cursor),
    });
    index += 1;
    start = end;
  }
  if (markdown.length === 0 || /(?:\r\n|\n|\r)$/u.test(markdown)) {
    lines.push({
      index,
      start: markdown.length,
      textEnd: markdown.length,
      end: markdown.length,
      text: "",
    });
  }
  return lines;
}

function normalizeHeadingText(value: string): string {
  return value.replace(/[\t ]+#+[\t ]*$/u, "").trim();
}

function contentWithoutFenceSeparator(value: string): string {
  return value.replace(/(?:\r\n|\n|\r)$/u, "");
}

function insertionText(
  markdown: string,
  offset: number,
  fenced: string,
  eol: string,
): string {
  const before = markdown.slice(0, offset);
  const after = markdown.slice(offset);
  const leading = !before
    ? ""
    : before.endsWith(`${eol}${eol}`)
      ? ""
      : before.endsWith(eol)
        ? eol
        : `${eol}${eol}`;
  const trailing = !after || after.startsWith(eol) ? "" : eol;
  return `${leading}${fenced}${trailing}`;
}

function detectEol(markdown: string): string {
  const match = /\r\n|\n|\r/u.exec(markdown);
  return match?.[0] ?? "\n";
}

function cloneHeadingMetadata(
  heading: MermaidHeadingMetadata,
): MermaidHeadingMetadata {
  return {
    text: heading.text,
    level: heading.level,
    start: heading.start,
    end: heading.end,
    sectionEnd: heading.sectionEnd,
  };
}

function cloneBlockMetadata(block: MermaidBlockMetadata): MermaidBlockMetadata {
  return {
    ...block,
    heading: block.heading ? cloneHeadingMetadata(block.heading) : null,
  };
}

function selectorLabel(selector: MermaidBlockSelector): string {
  return selector.kind === "heading"
    ? `heading "${selector.heading}"`
    : `block id "${selector.blockId}"`;
}

function dangerous(message: string): never {
  throw new MermaidBlockError("dangerous_mermaid", message);
}
