/**
 * YAML frontmatter for generated research notes.
 *
 * Obsidian treats frontmatter as first-class: tags become navigable, dates
 * become sortable, and properties become queryable by Dataview and search.
 * Research output that lands without any of it is a dead end in a graph-native
 * app — readable once, then unfindable.
 *
 * This is applied only to notes the agent *creates* (the research pack), never
 * injected into a note the user already owns: prepending YAML to someone's
 * existing note is a destructive edit, not an enhancement.
 *
 * Pure and Obsidian-free so the escaping rules are testable without a vault.
 */

export interface ResearchNoteFrontmatterInput {
  title: string;
  /** ISO-8601 creation timestamp. */
  created: string;
  /** Extra tags beyond the always-present "research". */
  tags?: string[];
  /** Count of distinct sources the pack was built from. */
  sourceCount?: number;
  /** Stated confidence, when the run produced one. */
  confidence?: string;
  /** Run id, so a note can be traced back to the mission that wrote it. */
  runId?: string;
}

const BASE_TAG = "research";
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 40;

/** Render the frontmatter block, including both `---` fences and a trailing blank line. */
export function buildResearchNoteFrontmatter(
  input: ResearchNoteFrontmatterInput,
): string {
  const lines = [
    "---",
    `title: ${yamlScalar(input.title)}`,
    `created: ${yamlScalar(input.created)}`,
    `tags: [${buildTagList(input.tags).join(", ")}]`,
  ];
  if (typeof input.sourceCount === "number" && Number.isFinite(input.sourceCount)) {
    lines.push(`sources: ${Math.max(0, Math.trunc(input.sourceCount))}`);
  }
  if (input.confidence?.trim()) {
    lines.push(`confidence: ${yamlScalar(input.confidence.trim())}`);
  }
  if (input.runId?.trim()) {
    lines.push(`agent-run-id: ${yamlScalar(input.runId.trim())}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** Prepend frontmatter to a body, unless the body already carries some. */
export function withResearchNoteFrontmatter(
  body: string,
  input: ResearchNoteFrontmatterInput,
): string {
  // Never stack two frontmatter blocks: Obsidian reads only the first, and the
  // second would render as a stray horizontal rule mid-note.
  if (/^﻿?---\r?\n/.test(body)) return body;
  return `${buildResearchNoteFrontmatter(input)}${body}`;
}

/**
 * Normalize a title into a tag: lowercase, non-alphanumerics to hyphens.
 * Returns null when nothing usable survives, so a title of "???" adds no tag
 * rather than an empty one.
 */
export function toResearchTag(value: string): string | null {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_TAG_CHARS)
    .replace(/-+$/u, "");
  // A tag starting with a digit is not a valid Obsidian tag on its own.
  if (!slug || /^\d/u.test(slug)) return null;
  return slug;
}

function buildTagList(extra: string[] | undefined): string[] {
  const tags = [BASE_TAG];
  for (const candidate of extra ?? []) {
    const tag = toResearchTag(candidate);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * Quote a YAML scalar whenever it could otherwise change the document's
 * structure. Titles routinely contain colons ("Study: a review"), and a raw
 * colon-space silently turns one property into a nested map.
 */
function yamlScalar(value: string): string {
  const normalized = value.replace(/\r?\n/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return '""';
  const needsQuote =
    /[:#\-?,\[\]{}&*!|>'"%@`]/u.test(normalized) ||
    /^\s|\s$/u.test(value) ||
    /^(?:true|false|null|yes|no|on|off|~)$/iu.test(normalized) ||
    /^[\d.]+$/u.test(normalized);
  if (!needsQuote) return normalized;
  return `"${normalized.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}
