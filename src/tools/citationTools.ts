import { createHash } from "node:crypto";

import type { HttpRequest } from "../model/types";
import type { AgentTool, ToolExecutionContext } from "./types";
import {
  findPinpointLocator,
  findQuoteRawOffset,
  normalizeForMatch,
} from "../agent/quoteMatch";
import { collapseWhitespace, stripJats, xmlText } from "./atomText";
import { requestWithRetry } from "./httpRetry";
import { readSourceSection } from "./sourceCache";
import {
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  isRecord,
  truncateText,
} from "./validation";

/**
 * Literature & citation tools. Read-only web/vault reads:
 * - resolve_citation: DOI / arXiv / free-text → one normalized record with
 *   verifiable provenance (Crossref and the arXiv Atom API).
 * - verify_citation: check a quote against an already-cached web source
 *   (the web_fetch cache), returning supported/unsupported/unverifiable.
 * - export_bibtex: pure formatter over resolved records; the model writes the
 *   file through the existing create_file tool.
 *
 * PDF / document bytes go through first-class `extract_document` (companion
 * `/document/extract_text`). These bibliographic tools stay metadata- and
 * quote-oriented: resolve/verify/export do not parse PDFs themselves.
 */

const CROSSREF_API = "https://api.crossref.org/works";
const ARXIV_API = "https://export.arxiv.org/api/query";
const PUBMED_ESUMMARY =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const MAX_ABSTRACT_CHARS = 1_200;
const MAX_AUTHORS = 24;
const MAX_SECTIONS_TO_SCAN = 12;
const MAX_BIBTEX_RECORDS = 50;
const CROSSREF_SEARCH_ROWS = 5;
/** Crossref relevance score is not 0–1; below this is a weak bibliographic hit. */
export const CROSSREF_SCORE_FLOOR = 40;
/** Jaccard token overlap required when the Crossref score is missing or low. */
export const CROSSREF_TITLE_SIMILARITY_FLOOR = 0.5;

export interface CitationRecordV1 {
  kind: "doi" | "arxiv" | "pubmed" | "search";
  sourceId: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  url: string | null;
  doi: string | null;
  arxivId: string | null;
  abstract: string | null;
}

export function createCitationTools(): AgentTool[] {
  return [resolveCitationTool, verifyCitationTool, exportBibtexTool];
}

const resolveCitationTool: AgentTool = {
  name: "resolve_citation",
  description:
    "Resolve a citation identifier (DOI, arXiv id/URL, or free-text title) into one normalized bibliographic record via Crossref or arXiv, with a stable sourceId for evidence tracking.",
  parameters: {
    type: "object",
    required: ["identifier"],
    properties: {
      identifier: {
        type: "string",
        description:
          "A DOI (10.xxxx/...), arXiv id (2401.12345 or hep-th/9901001) or URL, PMID, or a free-text title to search Crossref for.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const identifier = getRequiredString(args, "identifier").trim();
    if (!identifier) throw new Error("resolve_citation identifier cannot be empty.");
    const doi = extractDoi(identifier);
    if (doi) {
      const record = await resolveDoi(context, doi);
      return { status: "resolved", via: "crossref_doi", record };
    }
    const arxivId = extractArxivId(identifier);
    if (arxivId) {
      const record = await resolveArxiv(context, arxivId);
      return { status: "resolved", via: "arxiv", record };
    }
    const pubmedId = extractPubmedId(identifier);
    if (pubmedId) {
      const record = await resolvePubmed(context, pubmedId);
      return { status: "resolved", via: "pubmed", record };
    }
    const record = await searchCrossref(context, identifier);
    if (!record) {
      return {
        status: "not_found",
        via: "crossref_search",
        message:
          "No Crossref match for the title. Try the exact DOI or arXiv id.",
      };
    }
    return { status: "resolved", via: "crossref_search", record };
  },
};

const verifyCitationTool: AgentTool = {
  name: "verify_citation",
  description:
    "Verify a claimed quote against an already-cached web source (fetch it with web_fetch or extract_document first). Returns supported when the quote appears verbatim (whitespace-normalized), unsupported when the cached full text does not contain it, unverifiable when no cached source exists.",
  parameters: {
    type: "object",
    required: ["quote"],
    properties: {
      quote: {
        type: "string",
        description: "The quoted passage to verify (10–600 characters).",
      },
      url: {
        type: "string",
        description: "Source URL previously fetched with web_fetch.",
      },
      path: {
        type: "string",
        description: "Alternatively, the vault path of the cached source note.",
      },
      max_sections: {
        type: "integer",
        description: `Bounded number of cached sections to scan (default ${MAX_SECTIONS_TO_SCAN}).`,
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const quote = getRequiredString(args, "quote").trim();
    if (quote.length < 10 || quote.length > 600) {
      throw new Error("verify_citation quote must be 10–600 characters.");
    }
    const url = getOptionalString(args, "url")?.trim();
    const path = getOptionalString(args, "path")?.trim();
    if (!url && !path) {
      throw new Error("verify_citation requires url or path.");
    }
    const maxSections = Math.min(
      MAX_SECTIONS_TO_SCAN,
      Math.max(1, getOptionalInteger(args, "max_sections") ?? MAX_SECTIONS_TO_SCAN),
    );
    const needle = normalizeForMatch(quote);

    let first;
    try {
      first = await readSourceSection(context, { url, path }, 1);
    } catch {
      return {
        status: "unverifiable",
        message:
          "No cached source for this reference. Fetch it with web_fetch or extract_document first, then verify.",
      };
    }
    const sections = Math.min(first.sectionCount, maxSections);
    for (let section = 1; section <= sections; section += 1) {
      const cached =
        section === 1
          ? first
          : await readSourceSection(context, { url, path }, section);
      if (normalizeForMatch(cached.content).includes(needle)) {
        // A section index into our own cached copy is useless to a reader
        // holding a different edition. Where the source carries a real
        // pinpoint — chapter:verse, a statute section, a paragraph, a PDF page
        // — report that instead, because in primary-text disciplines the
        // pinpoint is the citation.
        const pinpoint = findPinpointLocator(
          cached.content,
          findQuoteRawOffset(quote, cached.content),
        );
        return {
          status: "supported",
          section,
          sectionCount: first.sectionCount,
          sourcePath: cached.vaultPath,
          sourceUrl: cached.url,
          contentHash: sha256(cached.content),
          // Echo the quote that was actually verified. Without it a supported
          // verification is unattributable downstream: the claim ledger cannot
          // tell which sentence this proof belongs to, so ten supported checks
          // still leave every claim ungrounded.
          quote,
          ...(pinpoint
            ? { pinpoint: { label: pinpoint.label, kind: pinpoint.kind } }
            : {}),
        };
      }
    }
    return {
      status: "unsupported",
      scannedSections: sections,
      sectionCount: first.sectionCount,
      message:
        first.sectionCount > sections
          ? "Quote not found in the scanned sections; raise max_sections to scan further."
          : "Quote not found anywhere in the cached full text.",
    };
  },
};

const exportBibtexTool: AgentTool = {
  name: "export_bibtex",
  description:
    "Format resolved citation records as BibTeX. Pure formatter: pass records returned by resolve_citation; write the output to a note with create_file.",
  parameters: {
    type: "object",
    required: ["records"],
    properties: {
      records: {
        type: "array",
        items: { type: "object" },
        maxItems: MAX_BIBTEX_RECORDS,
        description: "Citation records from resolve_citation.",
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const rawRecords = (args as Record<string, unknown>).records;
    if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
      throw new Error("export_bibtex requires at least one record.");
    }
    if (rawRecords.length > MAX_BIBTEX_RECORDS) {
      throw new Error(`export_bibtex accepts at most ${MAX_BIBTEX_RECORDS} records.`);
    }
    const entries = rawRecords.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new Error(`Record ${index + 1} is not an object.`);
      }
      return formatBibtexEntry(raw, index);
    });
    return { status: "formatted", count: entries.length, bibtex: entries.join("\n\n") };
  },
};

async function resolveDoi(
  context: ToolExecutionContext,
  doi: string,
): Promise<CitationRecordV1> {
  const payload = await getJson(
    context,
    `${CROSSREF_API}/${encodeURIComponent(doi)}`,
  );
  const message = isRecord(payload) && isRecord(payload.message) ? payload.message : null;
  if (!message) throw new Error(`Crossref returned no record for DOI ${doi}.`);
  return crossrefRecord(message, "doi");
}

async function searchCrossref(
  context: ToolExecutionContext,
  title: string,
): Promise<CitationRecordV1 | null> {
  const payload = await getJson(
    context,
    `${CROSSREF_API}?rows=${CROSSREF_SEARCH_ROWS}&query.bibliographic=${encodeURIComponent(title.slice(0, 256))}`,
  );
  const items =
    isRecord(payload) &&
    isRecord(payload.message) &&
    Array.isArray(payload.message.items)
      ? payload.message.items.filter(isRecord)
      : [];
  const match = pickCrossrefSearchMatch(items, title);
  return match ? crossrefRecord(match, "search") : null;
}

export function pickCrossrefSearchMatch(
  items: readonly Record<string, unknown>[],
  query: string,
): Record<string, unknown> | null {
  const ranked = items.map((item) => {
    const title = crossrefTitle(item);
    const score = typeof item.score === "number" && Number.isFinite(item.score)
      ? item.score
      : 0;
    return {
      item,
      score,
      similarity: bibliographicTitleSimilarity(query, title),
    };
  });
  const accepted = ranked.filter(
    (row) =>
      row.score >= CROSSREF_SCORE_FLOOR ||
      row.similarity >= CROSSREF_TITLE_SIMILARITY_FLOOR,
  );
  accepted.sort(
    (left, right) =>
      right.similarity - left.similarity || right.score - left.score,
  );
  return accepted[0]?.item ?? null;
}

export function bibliographicTitleSimilarity(query: string, title: string): number {
  const queryTokens = tokenizeBibliographicTitle(query);
  const titleTokens = tokenizeBibliographicTitle(title);
  if (queryTokens.size === 0 || titleTokens.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) intersection += 1;
  }
  return intersection / (queryTokens.size + titleTokens.size - intersection);
}

function tokenizeBibliographicTitle(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/gu, " ")
      .split(/\s+/u)
      .filter((token) => token.length > 1),
  );
}

function crossrefTitle(message: Record<string, unknown>): string {
  return Array.isArray(message.title)
    ? String(message.title[0] ?? "").trim()
    : String(message.title ?? "").trim();
}

function crossrefRecord(
  message: Record<string, unknown>,
  kind: "doi" | "search",
): CitationRecordV1 {
  const title = crossrefTitle(message);
  if (!title) throw new Error("Crossref record has no title.");
  const authors = Array.isArray(message.author)
    ? message.author
        .filter(isRecord)
        .slice(0, MAX_AUTHORS)
        .map((author) =>
          [author.given, author.family]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join(" "),
        )
        .filter(Boolean)
    : [];
  const issued = isRecord(message.issued) && Array.isArray(message.issued["date-parts"])
    ? message.issued["date-parts"]
    : null;
  const year =
    issued && Array.isArray(issued[0]) && Number.isInteger(issued[0][0])
      ? Number(issued[0][0])
      : null;
  const venue = Array.isArray(message["container-title"])
    ? String(message["container-title"][0] ?? "").trim() || null
    : null;
  const doi = typeof message.DOI === "string" ? message.DOI : null;
  const abstract =
    typeof message.abstract === "string"
      ? truncateText(stripJats(message.abstract), MAX_ABSTRACT_CHARS)
      : null;
  return {
    kind,
    sourceId: `citation:${doi ?? sha256(title).slice(0, 24)}`,
    title,
    authors,
    year,
    venue,
    url: typeof message.URL === "string" ? message.URL : doi ? `https://doi.org/${doi}` : null,
    doi,
    arxivId: null,
    abstract,
  };
}

async function resolveArxiv(
  context: ToolExecutionContext,
  arxivId: string,
): Promise<CitationRecordV1> {
  const xml = await getText(
    context,
    `${ARXIV_API}?id_list=${encodeURIComponent(arxivId)}&max_results=1`,
  );
  const entry = /<entry>([\s\S]*?)<\/entry>/u.exec(xml)?.[1];
  if (!entry || /<title>\s*Error\s*<\/title>/iu.test(entry)) {
    throw new Error(`arXiv returned no record for ${arxivId}.`);
  }
  const title = collapseWhitespace(xmlText(entry, "title"));
  if (!title) throw new Error(`arXiv record for ${arxivId} has no title.`);
  const authors = [...entry.matchAll(/<name>([^<]+)<\/name>/gu)]
    .map((match) => collapseWhitespace(match[1] ?? ""))
    .filter(Boolean)
    .slice(0, MAX_AUTHORS);
  const published = xmlText(entry, "published");
  const year = published ? Number(published.slice(0, 4)) || null : null;
  const abstract = collapseWhitespace(xmlText(entry, "summary"));
  return {
    kind: "arxiv",
    sourceId: `citation:arxiv:${arxivId}`,
    title,
    authors,
    year,
    venue: "arXiv",
    url: `https://arxiv.org/abs/${arxivId}`,
    doi: null,
    arxivId,
    abstract: abstract ? truncateText(abstract, MAX_ABSTRACT_CHARS) : null,
  };
}

export function extractDoi(identifier: string): string | null {
  const direct = /^10\.\d{4,9}\/\S+$/u.exec(identifier.trim());
  if (direct) return direct[0];
  const fromUrl = /doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/iu.exec(identifier);
  return fromUrl?.[1] ?? null;
}

const LEGACY_ARXIV_ID =
  "([a-z-]+(?:\\.[A-Za-z]{2})?\\/\\d{7})";

export function extractArxivId(identifier: string): string | null {
  const cleaned = identifier.trim();
  const modern = /^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/iu.exec(cleaned);
  if (modern) return `${modern[1]}${modern[2] ?? ""}`;
  const modernUrl = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?/iu.exec(
    cleaned,
  );
  if (modernUrl) return `${modernUrl[1]}${modernUrl[2] ?? ""}`;
  const legacy = new RegExp(`^(?:arxiv:)?${LEGACY_ARXIV_ID}(v\\d+)?$`, "iu").exec(
    cleaned,
  );
  if (legacy) return `${legacy[1]}${legacy[2] ?? ""}`;
  const legacyUrl = new RegExp(
    `arxiv\\.org/(?:abs|pdf)/${LEGACY_ARXIV_ID}(v\\d+)?`,
    "iu",
  ).exec(cleaned);
  return legacyUrl ? `${legacyUrl[1]}${legacyUrl[2] ?? ""}` : null;
}

export function extractPubmedId(identifier: string): string | null {
  const cleaned = identifier.trim();
  const labeled = /^(?:pmid:?\s*)(\d{5,8})$/iu.exec(cleaned);
  if (labeled) return labeled[1];
  const fromUrl = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,8})\b/iu.exec(cleaned);
  if (fromUrl) return fromUrl[1];
  const inline = /\bpmid:?\s*(\d{5,8})\b/iu.exec(cleaned);
  return inline?.[1] ?? null;
}

async function resolvePubmed(
  context: ToolExecutionContext,
  pmid: string,
): Promise<CitationRecordV1> {
  const payload = await getJson(
    context,
    `${PUBMED_ESUMMARY}?db=pubmed&retmode=json&rettype=abstract&id=${encodeURIComponent(pmid)}&retmax=1&tool=agentic-researcher`,
  );
  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
  const record = result && isRecord(result[pmid]) ? result[pmid] : null;
  if (!record) {
    throw new Error(`PubMed returned no record for PMID ${pmid}.`);
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) throw new Error(`PubMed record for PMID ${pmid} has no title.`);
  const authors = Array.isArray(record.authors)
    ? record.authors
        .filter(isRecord)
        .map((author) =>
          typeof author.name === "string" ? author.name.trim() : "",
        )
        .filter(Boolean)
        .slice(0, MAX_AUTHORS)
    : [];
  const pubdate = typeof record.pubdate === "string" ? record.pubdate : "";
  const yearMatch = /(\d{4})/u.exec(pubdate);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const venue =
    (typeof record.fulljournalname === "string" && record.fulljournalname.trim()) ||
    (typeof record.source === "string" && record.source.trim()) ||
    null;
  const elocation =
    typeof record.elocationid === "string"
      ? record.elocationid.replace(/^doi:\s*/iu, "")
      : "";
  const doi = extractDoi(elocation);
  return {
    kind: "pubmed",
    sourceId: `citation:pmid:${pmid}`,
    title,
    authors,
    year,
    venue,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    doi,
    arxivId: null,
    abstract: null,
  };
}

export function formatBibtexEntry(
  raw: Record<string, unknown>,
  index: number,
): string {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) throw new Error(`Record ${index + 1} has no title.`);
  const authors = Array.isArray(raw.authors)
    ? raw.authors.filter((author): author is string => typeof author === "string")
    : [];
  const year = Number.isInteger(raw.year) ? Number(raw.year) : null;
  const doi = typeof raw.doi === "string" && raw.doi ? raw.doi : null;
  const arxivId = typeof raw.arxivId === "string" && raw.arxivId ? raw.arxivId : null;
  const venue = typeof raw.venue === "string" && raw.venue ? raw.venue : null;
  const url = typeof raw.url === "string" && raw.url ? raw.url : null;
  const key = bibtexKey(authors[0] ?? title, year, index);
  const type = arxivId ? "misc" : venue ? "article" : "misc";
  const fields: Array<[string, string]> = [["title", `{${escapeBibtex(title)}}`]];
  if (authors.length > 0) {
    fields.push(["author", `{${authors.map(escapeBibtex).join(" and ")}}`]);
  }
  if (year !== null) fields.push(["year", `{${year}}`]);
  if (venue && !arxivId) fields.push(["journal", `{${escapeBibtex(venue)}}`]);
  if (doi) fields.push(["doi", `{${escapeBibtex(doi)}}`]);
  if (arxivId) {
    fields.push(["eprint", `{${escapeBibtex(arxivId)}}`]);
    fields.push(["archivePrefix", "{arXiv}"]);
  }
  if (url) fields.push(["url", `{${escapeBibtex(url)}}`]);
  const body = fields
    .map(([name, value]) => `  ${name} = ${value}`)
    .join(",\n");
  return `@${type}{${key},\n${body}\n}`;
}

function bibtexKey(seed: string, year: number | null, index: number): string {
  const stem = seed
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "")
    .slice(0, 20) || `ref${index + 1}`;
  return `${stem}${year ?? ""}`;
}

/** Escape BibTeX-significant characters; braces are balanced-wrapped values. */
function escapeBibtex(value: string): string {
  return value
    .replace(/\\/gu, "\\textbackslash{}")
    .replace(/([&%$#_])/gu, "\\$1")
    .replace(/~/gu, "\\textasciitilde{}")
    .replace(/\^/gu, "\\textasciicircum{}")
    .replace(/[{}]/gu, "");
}

async function getJson(context: ToolExecutionContext, url: string): Promise<unknown> {
  const response = await request(context, url, "application/json");
  if (response.json !== undefined) return response.json;
  try {
    return JSON.parse(response.text ?? "");
  } catch {
    throw new Error("Citation provider returned malformed JSON.");
  }
}

async function getText(context: ToolExecutionContext, url: string): Promise<string> {
  const response = await request(context, url, "application/atom+xml");
  return response.text ?? "";
}

async function request(
  context: ToolExecutionContext,
  url: string,
  accept: string,
) {
  const httpRequest: HttpRequest = {
    url,
    method: "GET",
    headers: { Accept: accept },
    throw: false,
    timeoutMs: Math.min(context.settings.requestTimeoutMs, 30_000),
    abortSignal: context.abortSignal,
  };
  // Crossref, arXiv and the NCBI endpoints answer a burst with 429 and a
  // Retry-After measured in a second or two. Handing that straight back ended
  // a citation lookup that one short wait would have completed.
  const response = await requestWithRetry(context.httpTransport, httpRequest);
  if (response.status === 404) {
    throw new Error("The citation provider has no record for this identifier.");
  }
  if (response.status === 429) {
    throw new Error(
      "The citation provider rate-limited this request; retry shortly.",
    );
  }
  if (response.status >= 400) {
    throw new Error(`Citation provider request failed with HTTP ${response.status}.`);
  }
  return response;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
