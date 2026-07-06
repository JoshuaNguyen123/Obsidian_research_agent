import type { TFile } from "obsidian";
import { BACKUP_FOLDER, MAX_LISTED_FILES } from "./constants";
import type { AgentTool, ToolExecutionContext } from "./types";
import {
  getOptionalInteger,
  getOptionalString,
  getRequiredStringArray,
  normalizeVaultPath,
} from "./validation";

const DEFAULT_RELATED_LIMIT = 10;
const MAX_RELATED_LIMIT = 20;
const MAX_PROFILE_CHARS = 8000;
const GRAPH_LINK_INTENT_PATTERN =
  /\b(connect|link|links|linked|graph|backlink|backlinks|related|relationship|relationships|reference|references)\b/i;

interface MetadataCacheLike {
  resolvedLinks?: Record<string, Record<string, number>>;
  unresolvedLinks?: Record<string, Record<string, number>>;
  getFileCache?: (file: TFile) => MetadataFileCacheLike | null;
  getFirstLinkpathDest?: (linktext: string, sourcePath: string) => TFile | null;
}

interface MetadataFileCacheLike {
  links?: Array<{
    link: string;
    displayText?: string;
    original?: string;
  }>;
  tags?: Array<{ tag: string }>;
  headings?: Array<{ heading: string; level: number }>;
  frontmatter?: Record<string, unknown>;
}

interface NoteProfile {
  path: string;
  basename: string;
  title: string;
  aliases: string[];
  tags: string[];
  headings: Array<{ heading: string; level: number }>;
  headingTerms: Set<string>;
  terms: Set<string>;
  outgoing: Map<string, number>;
  backlinks: Map<string, number>;
  unresolved: Map<string, number>;
  content: string;
}

interface RelatedNoteResult {
  path: string;
  basename: string;
  title: string;
  aliases: string[];
  tags: string[];
  score: number;
  reasons: string[];
  alreadyLinked: boolean;
  snippet: string;
}

export function createGraphTools(): AgentTool[] {
  return [
    getNoteGraphContextTool,
    findRelatedNotesTool,
    suggestNoteLinksTool,
    linkRelatedNotesInCurrentFileTool,
  ];
}

export const getNoteGraphContextTool: AgentTool = {
  name: "get_note_graph_context",
  description:
    "Inspect explicit Obsidian graph context for the current note or a vault-relative markdown path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional vault-relative markdown path. Omit to inspect the active note.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const file = resolveMarkdownFile(context, getOptionalString(args, "path"));
    const profile = await buildNoteProfile(context, file);

    return {
      source: {
        path: profile.path,
        basename: profile.basename,
        title: profile.title,
      },
      aliases: profile.aliases,
      tags: profile.tags,
      headings: profile.headings,
      outgoingLinks: formatLinkMap(context, profile.outgoing),
      backlinks: formatLinkMap(context, profile.backlinks),
      unresolvedLinks: [...profile.unresolved.entries()].map(([target, count]) => ({
        target,
        count,
      })),
      graphNeighbors: formatGraphNeighbors(context, profile),
    };
  },
};

export const findRelatedNotesTool: AgentTool = {
  name: "find_related_notes",
  description:
    "Find notes related to the current note, a vault-relative markdown path, or a query using local graph and content heuristics.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional vault-relative markdown path. Omit to use the active note when query is absent.",
      },
      query: {
        type: "string",
        description: "Optional text query to compare against vault notes.",
      },
      limit: {
        type: "integer",
        description: "Maximum related notes to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = getOptionalString(args, "path");
    const query = getOptionalString(args, "query")?.trim();
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_RELATED_LIMIT,
      1,
      MAX_RELATED_LIMIT,
    );
    const baseFile = path || !query ? resolveMarkdownFile(context, path) : null;
    const results = await findRelatedNotes(context, { baseFile, query, limit });

    return {
      source: baseFile
        ? {
            path: baseFile.path,
            basename: baseFile.basename,
          }
        : null,
      query: query || null,
      limit,
      results,
    };
  },
};

export const suggestNoteLinksTool: AgentTool = {
  name: "suggest_note_links",
  description:
    "Suggest wiki links that could connect the current note or a vault-relative markdown path to related notes. Does not modify notes.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional vault-relative markdown path. Omit to inspect the active note.",
      },
      limit: {
        type: "integer",
        description: "Maximum link suggestions to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const file = resolveMarkdownFile(context, getOptionalString(args, "path"));
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_RELATED_LIMIT,
      1,
      MAX_RELATED_LIMIT,
    );
    const related = await findRelatedNotes(context, { baseFile: file, limit });

    return {
      source: {
        path: file.path,
        basename: file.basename,
      },
      suggestions: related.map((result) => ({
        targetPath: result.path,
        displayText: result.basename,
        wikiLink: buildWikiLink(result.path, result.basename),
        score: result.score,
        reasons: result.reasons,
        alreadyLinked: result.alreadyLinked,
        snippet: result.snippet,
      })),
    };
  },
};

export const linkRelatedNotesInCurrentFileTool: AgentTool = {
  name: "link_related_notes_in_current_file",
  description:
    "Insert inline wiki links for related notes in the active markdown note after creating a backup.",
  parameters: {
    type: "object",
    properties: {
      targetPaths: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional vault-relative markdown paths to link. Omit to use top local related-note suggestions.",
      },
      limit: {
        type: "integer",
        description: "Maximum related note links to insert when targetPaths is omitted.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    if (!GRAPH_LINK_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "link_related_notes_in_current_file requires the user to explicitly ask to connect, link, graph, or relate notes.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current =
      context.getCurrentMarkdownContent?.(file) ??
      (await context.app.vault.read(file));
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_RELATED_LIMIT,
      1,
      MAX_RELATED_LIMIT,
    );
    const targetPathsArg = args.targetPaths;
    const targetPaths =
      targetPathsArg === undefined
        ? null
        : getRequiredStringArray(args, "targetPaths").map((path) =>
            normalizeVaultPath(path, { requireMarkdown: true }),
          );
    const candidates =
      targetPaths === null
        ? await findRelatedNotes(context, { baseFile: file, limit })
        : await buildTargetRelatedResults(context, file, targetPaths);
    const edit = applyInlineRelatedLinks(current, candidates);

    if (edit.insertedLinks.length === 0) {
      return {
        path: file.path,
        operation: "link_related_notes",
        changed: false,
        insertedLinks: [],
        skipped: edit.skipped,
        bytesWritten: 0,
      };
    }

    const backupPath = await backupMarkdownFile(context, file, current);
    await context.app.vault.modify(file, edit.updated);

    return {
      path: file.path,
      operation: "link_related_notes",
      changed: true,
      backupPath,
      insertedLinks: edit.insertedLinks,
      skipped: edit.skipped,
      bytesWritten: getByteLength(edit.updated),
      bytesAdded: getByteLength(edit.updated) - getByteLength(current),
    };
  },
};

async function findRelatedNotes(
  context: ToolExecutionContext,
  {
    baseFile,
    query,
    limit,
  }: {
    baseFile: TFile | null;
    query?: string;
    limit: number;
  },
): Promise<RelatedNoteResult[]> {
  const profiles = await buildVaultProfiles(context);
  const baseProfile = baseFile ? profiles.get(baseFile.path) ?? null : null;
  const queryTerms = new Set(tokenize(query ?? ""));
  const results: RelatedNoteResult[] = [];

  for (const profile of profiles.values()) {
    if (baseProfile && profile.path === baseProfile.path) {
      continue;
    }

    const scored = scoreRelatedProfile({ baseProfile, queryTerms, profile });
    if (scored.score <= 0) {
      continue;
    }

    results.push({
      path: profile.path,
      basename: profile.basename,
      title: profile.title,
      aliases: profile.aliases,
      tags: profile.tags,
      score: scored.score,
      reasons: scored.reasons,
      alreadyLinked: baseProfile?.outgoing.has(profile.path) ?? false,
      snippet: buildProfileSnippet(profile, scored.matchedTerms),
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

async function buildTargetRelatedResults(
  context: ToolExecutionContext,
  file: TFile,
  targetPaths: string[],
): Promise<RelatedNoteResult[]> {
  const profiles = await buildVaultProfiles(context);
  const baseProfile = profiles.get(file.path) ?? null;
  const results: RelatedNoteResult[] = [];

  for (const path of targetPaths) {
    const targetFile = getMarkdownFileByPath(context, path);
    const profile = profiles.get(targetFile.path);
    if (!profile) {
      continue;
    }
    const scored = scoreRelatedProfile({
      baseProfile,
      queryTerms: new Set(),
      profile,
    });
    results.push({
      path: profile.path,
      basename: profile.basename,
      title: profile.title,
      aliases: profile.aliases,
      tags: profile.tags,
      score: scored.score,
      reasons: scored.reasons.length > 0 ? scored.reasons : ["user_selected"],
      alreadyLinked: baseProfile?.outgoing.has(profile.path) ?? false,
      snippet: buildProfileSnippet(profile, scored.matchedTerms),
    });
  }

  return results;
}

function scoreRelatedProfile({
  baseProfile,
  queryTerms,
  profile,
}: {
  baseProfile: NoteProfile | null;
  queryTerms: Set<string>;
  profile: NoteProfile;
}): { score: number; reasons: string[]; matchedTerms: Set<string> } {
  let score = 0;
  const reasons: string[] = [];
  const matchedTerms = new Set<string>();

  if (baseProfile) {
    if (baseProfile.outgoing.has(profile.path)) {
      score += 100;
      reasons.push("direct_link");
    }
    if (baseProfile.backlinks.has(profile.path)) {
      score += 95;
      reasons.push("backlink");
    }

    const sharedTags = intersectArrays(baseProfile.tags, profile.tags);
    if (sharedTags.length > 0) {
      score += Math.min(40, sharedTags.length * 20);
      reasons.push(`shared_tag:${sharedTags.slice(0, 3).join(",")}`);
    }

    const titleOverlap = intersectSets(
      new Set(tokenize(baseProfile.title)),
      new Set(tokenize(profile.title)),
    );
    if (titleOverlap.length > 0) {
      score += Math.min(30, titleOverlap.length * 10);
      reasons.push("title_terms");
      titleOverlap.forEach((term) => matchedTerms.add(term));
    }

    const headingOverlap = intersectSets(
      baseProfile.headingTerms,
      profile.headingTerms,
    );
    if (headingOverlap.length > 0) {
      score += Math.min(25, headingOverlap.length * 5);
      reasons.push("shared_heading_terms");
      headingOverlap.forEach((term) => matchedTerms.add(term));
    }

    const termOverlap = intersectSets(baseProfile.terms, profile.terms);
    if (termOverlap.length > 0) {
      score += Math.min(45, termOverlap.length * 3);
      reasons.push("content_overlap");
      termOverlap.slice(0, 8).forEach((term) => matchedTerms.add(term));
    }

    const sharedNeighbors = intersectSets(
      new Set([...baseProfile.outgoing.keys(), ...baseProfile.backlinks.keys()]),
      new Set([...profile.outgoing.keys(), ...profile.backlinks.keys()]),
    );
    if (sharedNeighbors.length > 0) {
      score += Math.min(24, sharedNeighbors.length * 8);
      reasons.push("shared_neighbor");
    }
  }

  if (queryTerms.size > 0) {
    const profileTerms = new Set([
      ...profile.terms,
      ...tokenize(profile.title),
      ...profile.tags.flatMap((tag) => tokenize(tag)),
      ...profile.aliases.flatMap((alias) => tokenize(alias)),
    ]);
    const queryOverlap = intersectSets(queryTerms, profileTerms);
    if (queryOverlap.length > 0) {
      score += Math.min(80, queryOverlap.length * 12);
      reasons.push("query_overlap");
      queryOverlap.forEach((term) => matchedTerms.add(term));
    }
  }

  return { score, reasons: dedupeStrings(reasons), matchedTerms };
}

async function buildVaultProfiles(
  context: ToolExecutionContext,
): Promise<Map<string, NoteProfile>> {
  const cacheKey = "graph:vault_profiles:v1";
  const graphProfiles =
    context.runtimeCache?.graphProfiles ??
    (context.runtimeCache
      ? (context.runtimeCache.graphProfiles = new Map<string, unknown>())
      : undefined);
  const cachedProfiles = graphProfiles?.get(cacheKey);
  if (cachedProfiles instanceof Map) {
    return cachedProfiles as Map<string, NoteProfile>;
  }

  const profiles = new Map<string, NoteProfile>();
  const files = context.app.vault
    .getFiles()
    .filter((file) => file.extension === "md" && !isBlockedSystemPath(file.path))
    .slice(0, MAX_LISTED_FILES);

  for (const file of files) {
    profiles.set(file.path, await buildNoteProfile(context, file));
  }

  graphProfiles?.set(cacheKey, profiles);
  return profiles;
}

async function buildNoteProfile(
  context: ToolExecutionContext,
  file: TFile,
): Promise<NoteProfile> {
  const metadataCache = getMetadataCache(context);
  const cache = metadataCache.getFileCache?.(file) ?? null;
  const content = truncateForProfile(await context.app.vault.cachedRead(file));
  const headings = readHeadings(cache, content);
  const aliases = readAliases(cache);
  const tags = readTags(cache, content);
  const title = readTitle(cache, content, file);
  const outgoing = readResolvedOutgoing(context, file, cache);
  const backlinks = readBacklinks(context, file);
  const unresolved = readUnresolvedOutgoing(context, file, cache);
  const headingTerms = new Set(headings.flatMap((heading) => tokenize(heading.heading)));
  const terms = new Set([
    ...tokenize(title),
    ...aliases.flatMap((alias) => tokenize(alias)),
    ...tags.flatMap((tag) => tokenize(tag)),
    ...headingTerms,
    ...tokenize(content),
  ]);

  return {
    path: file.path,
    basename: file.basename,
    title,
    aliases,
    tags,
    headings,
    headingTerms,
    terms,
    outgoing,
    backlinks,
    unresolved,
    content,
  };
}

function resolveMarkdownFile(
  context: ToolExecutionContext,
  path: string | undefined,
): TFile {
  if (!path) {
    return getActiveMarkdownFile(context);
  }

  return getMarkdownFileByPath(
    context,
    normalizeVaultPath(path, { requireMarkdown: true }),
  );
}

function getActiveMarkdownFile(context: ToolExecutionContext): TFile {
  const file =
    context.getCurrentMarkdownFile?.() ?? context.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    throw new Error(
      "An active markdown file is required. Open or focus a markdown note before using graph tools.",
    );
  }

  return file;
}

function getMarkdownFileByPath(context: ToolExecutionContext, path: string): TFile {
  const file = context.app.vault.getFileByPath(path);
  if (!file || file.extension !== "md") {
    throw new Error(`Markdown file not found: ${path}`);
  }

  return file;
}

function getMetadataCache(context: ToolExecutionContext): MetadataCacheLike {
  return (
    (context.app as unknown as { metadataCache?: MetadataCacheLike })
      .metadataCache ?? {}
  );
}

function readResolvedOutgoing(
  context: ToolExecutionContext,
  file: TFile,
  cache: MetadataFileCacheLike | null,
): Map<string, number> {
  const metadataCache = getMetadataCache(context);
  const outgoing = new Map<string, number>();
  const resolved = metadataCache.resolvedLinks?.[file.path] ?? {};

  for (const [targetPath, count] of Object.entries(resolved)) {
    if (!isSafeMarkdownVaultPath(targetPath)) {
      continue;
    }
    outgoing.set(targetPath, count);
  }

  for (const link of cache?.links ?? []) {
    const dest = metadataCache.getFirstLinkpathDest?.(link.link, file.path);
    if (dest?.extension === "md" && isSafeMarkdownVaultPath(dest.path)) {
      outgoing.set(dest.path, Math.max(outgoing.get(dest.path) ?? 0, 1));
    }
  }

  return outgoing;
}

function readBacklinks(
  context: ToolExecutionContext,
  file: TFile,
): Map<string, number> {
  const backlinks = new Map<string, number>();
  const resolvedLinks = getMetadataCache(context).resolvedLinks ?? {};

  for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
    if (
      sourcePath === file.path ||
      !isSafeMarkdownVaultPath(sourcePath) ||
      !Object.prototype.hasOwnProperty.call(targets, file.path)
    ) {
      continue;
    }

    backlinks.set(sourcePath, targets[file.path]);
  }

  return backlinks;
}

function readUnresolvedOutgoing(
  context: ToolExecutionContext,
  file: TFile,
  cache: MetadataFileCacheLike | null,
): Map<string, number> {
  const unresolved = new Map<string, number>();
  const raw = getMetadataCache(context).unresolvedLinks?.[file.path] ?? {};

  for (const [target, count] of Object.entries(raw)) {
    unresolved.set(target, count);
  }

  for (const link of cache?.links ?? []) {
    const dest = getMetadataCache(context).getFirstLinkpathDest?.(link.link, file.path);
    if (!dest) {
      unresolved.set(link.link, Math.max(unresolved.get(link.link) ?? 0, 1));
    }
  }

  return unresolved;
}

function readHeadings(
  cache: MetadataFileCacheLike | null,
  content: string,
): Array<{ heading: string; level: number }> {
  const cached = cache?.headings
    ?.filter((heading) => heading.heading.trim())
    .map((heading) => ({
      heading: heading.heading.trim(),
      level: heading.level,
    }));

  if (cached && cached.length > 0) {
    return cached;
  }

  return [...content.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map(
    (match) => ({
      heading: match[2].trim(),
      level: match[1].length,
    }),
  );
}

function readTitle(
  cache: MetadataFileCacheLike | null,
  content: string,
  file: TFile,
): string {
  const frontmatterTitle = cache?.frontmatter?.title;
  if (typeof frontmatterTitle === "string" && frontmatterTitle.trim()) {
    return frontmatterTitle.trim();
  }

  const firstHeading = readHeadings(cache, content)[0]?.heading;
  return firstHeading || file.basename;
}

function readAliases(cache: MetadataFileCacheLike | null): string[] {
  const frontmatter = cache?.frontmatter ?? {};
  return dedupeStrings([
    ...frontmatterValueToStrings(frontmatter.alias),
    ...frontmatterValueToStrings(frontmatter.aliases),
  ]);
}

function readTags(cache: MetadataFileCacheLike | null, content: string): string[] {
  const cacheTags = cache?.tags?.map((tag) => normalizeTag(tag.tag)) ?? [];
  const frontmatterTags = frontmatterValueToStrings(cache?.frontmatter?.tags).map(
    normalizeTag,
  );
  const inlineTags = [...content.matchAll(/(^|\s)#([A-Za-z0-9/_-]+)/g)].map(
    (match) => normalizeTag(match[2]),
  );

  return dedupeStrings([...cacheTags, ...frontmatterTags, ...inlineTags]).filter(
    Boolean,
  );
}

function frontmatterValueToStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function applyInlineRelatedLinks(
  markdown: string,
  candidates: RelatedNoteResult[],
): {
  updated: string;
  insertedLinks: Array<{
    targetPath: string;
    label: string;
    wikiLink: string;
    reasons: string[];
  }>;
  skipped: Array<{ targetPath: string; reason: string }>;
} {
  let updated = markdown;
  const insertedLinks: Array<{
    targetPath: string;
    label: string;
    wikiLink: string;
    reasons: string[];
  }> = [];
  const skipped: Array<{ targetPath: string; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.alreadyLinked) {
      skipped.push({ targetPath: candidate.path, reason: "already_linked" });
      continue;
    }

    const labels = getCandidateLabels(candidate);
    let inserted = false;

    for (const label of labels) {
      const match = findUnprotectedLabelMatch(updated, label);
      if (!match) {
        continue;
      }

      const wikiLink = buildWikiLink(candidate.path, match.text);
      updated = `${updated.slice(0, match.start)}${wikiLink}${updated.slice(match.end)}`;
      insertedLinks.push({
        targetPath: candidate.path,
        label: match.text,
        wikiLink,
        reasons: candidate.reasons,
      });
      inserted = true;
      break;
    }

    if (!inserted) {
      skipped.push({
        targetPath: candidate.path,
        reason: "no_exact_unlinked_text_match",
      });
    }
  }

  return { updated, insertedLinks, skipped };
}

function findUnprotectedLabelMatch(
  markdown: string,
  label: string,
): { start: number; end: number; text: string } | null {
  if (label.trim().length < 3) {
    return null;
  }

  const protectedRanges = getProtectedMarkdownRanges(markdown);
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegExp(label)})(?=$|[^\\p{L}\\p{N}_])`, "giu");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    if (!rangeOverlaps(protectedRanges, start, end)) {
      return { start, end, text: markdown.slice(start, end) };
    }
  }

  return null;
}

function getProtectedMarkdownRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  collectRange(markdown, /^(?:---|\+\+\+)\r?\n[\s\S]*?\r?\n(?:---|\+\+\+)\r?\n?/y, ranges);
  collectRanges(markdown, /```[\s\S]*?```/g, ranges);
  collectRanges(markdown, /~~~[\s\S]*?~~~/g, ranges);
  collectRanges(markdown, /\[\[[\s\S]*?\]\]/g, ranges);
  collectRanges(markdown, /!\[[^\]]*]\([^)]+\)/g, ranges);
  collectRanges(markdown, /\[[^\]]+]\([^)]+\)/g, ranges);
  collectRanges(markdown, /`[^`]*`/g, ranges);
  return ranges;
}

function collectRange(
  text: string,
  pattern: RegExp,
  ranges: Array<[number, number]>,
) {
  const match = pattern.exec(text);
  if (match) {
    ranges.push([match.index, match.index + match[0].length]);
  }
}

function collectRanges(
  text: string,
  pattern: RegExp,
  ranges: Array<[number, number]>,
) {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
}

function rangeOverlaps(ranges: Array<[number, number]>, start: number, end: number) {
  return ranges.some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
}

function formatLinkMap(
  context: ToolExecutionContext,
  links: Map<string, number>,
): Array<{ path: string; basename: string; count: number; exists: boolean }> {
  return [...links.entries()].map(([path, count]) => {
    const file = context.app.vault.getFileByPath(path);
    return {
      path,
      basename: file?.basename ?? path.replace(/\.md$/i, "").split("/").pop() ?? path,
      count,
      exists: Boolean(file),
    };
  });
}

function formatGraphNeighbors(context: ToolExecutionContext, profile: NoteProfile) {
  const neighbors = new Map<
    string,
    { path: string; basename: string; linkTypes: string[]; count: number }
  >();

  for (const [path, count] of profile.outgoing.entries()) {
    const file = context.app.vault.getFileByPath(path);
    neighbors.set(path, {
      path,
      basename: file?.basename ?? path,
      linkTypes: ["outgoing"],
      count,
    });
  }

  for (const [path, count] of profile.backlinks.entries()) {
    const file = context.app.vault.getFileByPath(path);
    const existing = neighbors.get(path);
    if (existing) {
      existing.linkTypes.push("backlink");
      existing.count += count;
      continue;
    }
    neighbors.set(path, {
      path,
      basename: file?.basename ?? path,
      linkTypes: ["backlink"],
      count,
    });
  }

  return [...neighbors.values()].sort((a, b) => b.count - a.count);
}

function buildProfileSnippet(
  profile: NoteProfile,
  matchedTerms: Set<string>,
): string {
  const content = profile.content.replace(/\s+/g, " ").trim();
  if (!content) {
    return "";
  }

  for (const term of matchedTerms) {
    const index = content.toLowerCase().indexOf(term.toLowerCase());
    if (index >= 0) {
      const start = Math.max(0, index - 80);
      const end = Math.min(content.length, index + 180);
      return `${start > 0 ? "... " : ""}${content.slice(start, end).trim()}${
        end < content.length ? " ..." : ""
      }`;
    }
  }

  return content.slice(0, 240);
}

function getCandidateLabels(candidate: RelatedNoteResult): string[] {
  return dedupeStrings([
    candidate.title,
    candidate.basename,
    ...candidate.aliases,
  ]).sort((a, b) => b.length - a.length);
}

function buildWikiLink(path: string, label: string): string {
  const target = path.replace(/\.md$/i, "");
  return target === label ? `[[${target}]]` : `[[${target}|${label}]]`;
}

function truncateForProfile(content: string): string {
  return content.length <= MAX_PROFILE_CHARS
    ? content
    : content.slice(0, MAX_PROFILE_CHARS);
}

function tokenize(text: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "with",
  ]);

  return (text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu) ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !stopWords.has(term));
}

function intersectArrays(left: string[], right: string[]): string[] {
  return intersectSets(new Set(left), new Set(right));
}

function intersectSets<T>(left: Set<T>, right: Set<T>): T[] {
  return [...left].filter((item) => right.has(item));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

function isSafeMarkdownVaultPath(path: string): boolean {
  try {
    normalizeVaultPath(path, { requireMarkdown: true });
    return true;
  } catch {
    return false;
  }
}

function isBlockedSystemPath(path: string): boolean {
  return /^(?:\.agent-backups|\.obsidian|\.trash|trash)(?:\/|$)/i.test(path);
}

async function backupMarkdownFile(
  context: ToolExecutionContext,
  file: TFile,
  content: string,
): Promise<string> {
  if (!context.app.vault.getFolderByPath(BACKUP_FOLDER)) {
    await context.app.vault.createFolder(BACKUP_FOLDER);
  }

  const timestamp = (context.now?.() ?? new Date()).getTime();
  const basename = file.basename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "untitled";
  let backupPath = `${BACKUP_FOLDER}/${timestamp}-${basename}.md`;
  let suffix = 1;

  while (context.app.vault.getFileByPath(backupPath)) {
    backupPath = `${BACKUP_FOLDER}/${timestamp}-${basename}-${suffix}.md`;
    suffix += 1;
  }

  await context.app.vault.create(backupPath, content);
  return backupPath;
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
