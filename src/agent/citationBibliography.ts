import type { MissionEvidence } from "./missionLedger";
import { SOURCE_SCOPED_PASSAGE_ID_PATTERN } from "./claimLedger";

/**
 * Turns the citation tokens a proof-gated draft carries into something a reader
 * can use.
 *
 * The tokens exist so the runner can verify that a sentence is backed by a span
 * of a fetched source; `source:1f3a9c:passage:1200-1900` is exactly the right
 * shape for that and exactly the wrong thing to leave in someone's note. This
 * converts each one to a Markdown footnote marker and appends one definition per
 * source, with its title, URL, the character ranges that were cited, and the
 * date it was read.
 *
 * Three rules the rest of the writeback path depends on:
 *
 * - **Append-only, and nothing is lost.** Nothing above the Sources section is
 *   rewritten except the tokens themselves, which become `[^n]` in place. Each
 *   token reappears verbatim in its footnote definition, so the payload still
 *   contains every citation the runner's proof contract checks for, and a
 *   reader who wants the exact span still has it.
 * - **Never invent a citation.** A token whose source is not in the mission's
 *   evidence is left exactly as it is. A visible token is a defect a reader can
 *   see and report; a fabricated source entry is one they cannot.
 * - **Idempotent.** A body that already carries footnote definitions is
 *   returned unchanged, so a retry, a correction pass, or a second write of the
 *   same draft cannot append the section twice.
 */

export interface BibliographyEntryV1 {
  /** Footnote number, 1-based, in order of first citation in the body. */
  marker: number;
  sourceId: string;
  title: string;
  url?: string;
  vaultPath?: string;
  /**
   * The passage tokens of this source that the draft cited, verbatim. They
   * stay in the document, in the footnote definition: the runner's proof
   * contract is checked against the payload's tokens, so removing them from the
   * body entirely turns a verified write into an unverifiable one, and a reader
   * checking a claim wants the exact span anyway.
   */
  tokens: string[];
  /** Character ranges, derived from the tokens for display. */
  ranges: string[];
}

export interface BibliographyResultV1 {
  content: string;
  entries: BibliographyEntryV1[];
  /** Tokens whose source the mission's evidence does not describe; left as-is. */
  unresolvedTokens: string[];
  changed: boolean;
}

export const SOURCES_HEADING_V1 = "## Sources";

/** A body that already has footnote definitions has already been rendered. */
const FOOTNOTE_DEFINITION_PATTERN = /^\[\^\d+\]:/mu;

function sourceIdOf(token: string): string | null {
  const match = /^(source:[a-z0-9]+):passage:(\d+)-(\d+)$/iu.exec(token);
  return match ? match[1]! : null;
}

function rangeOf(token: string): string | null {
  const match = /:passage:(\d+)-(\d+)$/u.exec(token);
  return match ? `${match[1]}-${match[2]}` : null;
}

/**
 * Index the mission's evidence by the source id its passages carry, so a token
 * can be resolved without a scan per citation.
 */
function indexEvidenceBySource(
  evidence: readonly MissionEvidence[],
): Map<string, MissionEvidence> {
  const bySource = new Map<string, MissionEvidence>();
  for (const record of evidence) {
    const ids = new Set<string>();
    if (record.sourceId) ids.add(record.sourceId);
    for (const passageId of [
      ...(record.passageId ? [record.passageId] : []),
      ...(record.passageIds ?? []),
    ]) {
      const sourceId = sourceIdOf(passageId);
      if (sourceId) ids.add(sourceId);
    }
    for (const id of ids) {
      // First writer wins: evidence is appended over a run, and the earliest
      // record is the one whose title and URL were read from the fetch itself.
      if (!bySource.has(id)) bySource.set(id, record);
    }
  }
  return bySource;
}

function describeEntry(entry: BibliographyEntryV1, accessedOn: string | null): string {
  const location = entry.url ?? entry.vaultPath ?? "";
  const cited = entry.ranges.length > 0 ? ` chars ${entry.ranges.join(", ")}` : "";
  const accessed = accessedOn ? `, accessed ${accessedOn}` : "";
  const head = location
    ? `[^${entry.marker}]: ${entry.title} — ${location} (cited${cited}${accessed})`
    : `[^${entry.marker}]: ${entry.title} (cited${cited}${accessed})`;
  return `${head} ${entry.tokens.join(" ")}`;
}

export function renderCitedNoteBodyV1({
  content,
  evidence,
  now = () => new Date(),
}: {
  content: string;
  evidence: readonly MissionEvidence[];
  now?: () => Date;
}): BibliographyResultV1 {
  const unchanged = (): BibliographyResultV1 => ({
    content,
    entries: [],
    unresolvedTokens: [],
    changed: false,
  });
  if (!content.trim()) return unchanged();
  if (FOOTNOTE_DEFINITION_PATTERN.test(content)) return unchanged();

  const pattern = new RegExp(SOURCE_SCOPED_PASSAGE_ID_PATTERN.source, "gi");
  const tokens = content.match(pattern) ?? [];
  if (tokens.length === 0) return unchanged();

  const bySource = indexEvidenceBySource(evidence);
  const entries: BibliographyEntryV1[] = [];
  const entryBySource = new Map<string, BibliographyEntryV1>();
  const unresolved = new Set<string>();

  for (const token of tokens) {
    const sourceId = sourceIdOf(token);
    if (!sourceId) continue;
    const record = bySource.get(sourceId);
    if (!record) {
      unresolved.add(token);
      continue;
    }
    let entry = entryBySource.get(sourceId);
    if (!entry) {
      entry = {
        marker: entries.length + 1,
        sourceId,
        title: record.title?.trim() || sourceId,
        ...(record.url ? { url: record.url } : {}),
        ...(record.path ? { vaultPath: record.path } : {}),
        tokens: [],
        ranges: [],
      };
      entries.push(entry);
      entryBySource.set(sourceId, entry);
    }
    if (!entry.tokens.includes(token)) entry.tokens.push(token);
    const range = rangeOf(token);
    if (range && !entry.ranges.includes(range)) entry.ranges.push(range);
  }

  if (entries.length === 0) {
    return { ...unchanged(), unresolvedTokens: [...unresolved] };
  }

  // Drafts cite either bare or in square brackets. A bracketed token has to be
  // consumed whole: leaving the brackets around the marker produces `[[^1]]`,
  // which Obsidian reads as the start of a wikilink, not a footnote.
  const source = SOURCE_SCOPED_PASSAGE_ID_PATTERN.source;
  const replaced = content.replace(
    new RegExp(`\\[(${source})\\]|(${source})`, "gi"),
    (match, bracketed?: string, bare?: string) => {
      const token = bracketed ?? bare ?? match;
      const sourceId = sourceIdOf(token);
      const entry = sourceId ? entryBySource.get(sourceId) : undefined;
      return entry ? `[^${entry.marker}]` : match;
    },
  );

  const accessedOn = (() => {
    try {
      return now().toISOString().slice(0, 10);
    } catch {
      return null;
    }
  })();
  const section = [
    SOURCES_HEADING_V1,
    "",
    ...entries.map((entry) => describeEntry(entry, accessedOn)),
  ].join("\n");
  const separator = replaced.endsWith("\n") ? "\n" : "\n\n";

  return {
    content: `${replaced}${separator}${section}\n`,
    entries,
    unresolvedTokens: [...unresolved],
    changed: true,
  };
}
