import type { HttpResponse, HttpTransport } from "../model/types";
import {
  canonicalizeSourceCandidate,
  type ResearchSourceType,
} from "../orchestrator/sourceCandidateLedger";
import { atomEntries, collapseWhitespace, stripJats, xmlText } from "./atomText";

/**
 * Keyless, official, safe web-search fallbacks. The primary search path is the
 * configured Ollama-compatible `/web_search`; when that provider errors, is
 * unauthenticated, or returns nothing, these public APIs keep research alive
 * without a single point of failure and without any extra API key:
 *   - Wikipedia REST search — general knowledge.
 *   - OpenAlex works — scholarly literature (polite, keyless pool).
 *   - arXiv Atom — preprints, the only free full-text-adjacent physics/CS index.
 *   - Crossref works — the DOI registry; broadest journal coverage.
 *   - PubMed E-utilities — biomedical literature.
 *
 * Every provider is defensive: a failure returns an empty list rather than
 * throwing, so one provider being down never blocks the others or the caller.
 *
 * Deliberately absent: any general web index. Every keyless one is either an
 * HTML scrape of a search engine (fragile and against its terms) or key-gated.
 * General-web coverage is the configured primary provider's job; this tier's
 * job is the academic breadth the primary provider does not have.
 */

export interface FreeSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** ISO-8601 date or bare year when the provider reports one. */
  publishedAt?: string;
  /** Provider-derived type hint; ranking treats it as a prior, not a verdict. */
  sourceTypeHint?: ResearchSourceType;
  /** Which free provider surfaced this result. */
  provider?: string;
}

export interface FreeSearchInput {
  transport: HttpTransport;
  query: string;
  maxResults: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const REQUEST_HEADERS: Record<string, string> = {
  // Wikipedia, OpenAlex, Crossref and NCBI all ask API clients to identify
  // themselves; Crossref's "polite pool" gives identified clients better
  // service, and NCBI rate-limits anonymous callers harder.
  "User-Agent": "AgenticResearcher/0.4 (+https://github.com/JoshuaNguyen123/Obsidian_research_agent)",
  Accept: "application/json",
};

const CROSSREF_API = "https://api.crossref.org/works";
const ARXIV_API = "https://export.arxiv.org/api/query";
const PUBMED_ESEARCH =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_ESUMMARY =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

const MAX_SNIPPET_CHARS = 400;

/**
 * Reciprocal-rank-fusion constant. 60 is the value from the original Cormack
 * et al. formulation and is what every RRF implementation defaults to: large
 * enough that the top few ranks are not winner-take-all, small enough that
 * agreement between providers still dominates a single provider's ordering.
 */
const RRF_K = 60;

interface RankedResult {
  result: FreeSearchResult;
  score: number;
  /** Best (lowest) rank this URL achieved in any single provider's list. */
  bestRank: number;
  providerCount: number;
}

/**
 * Run every free provider, fuse their rankings, de-duplicate, and bound the
 * count.
 *
 * Fusion is reciprocal rank rather than the previous round-robin interleave:
 * a result three providers surfaced is far more likely to be the right source
 * than one that only a single provider ranked first, and round-robin could not
 * express that at all — it took one from each list in turn regardless of
 * agreement.
 */
export async function runFreeSearchFallback(
  input: FreeSearchInput,
): Promise<FreeSearchResult[]> {
  const perProvider = Math.max(1, Math.min(10, input.maxResults));
  const providerInput = { ...input, maxResults: perProvider };
  const batches = await Promise.all([
    safeProvider(() => wikipediaSearch(providerInput)),
    safeProvider(() => openAlexSearch(providerInput)),
    safeProvider(() => arxivSearch(providerInput)),
    safeProvider(() => crossrefSearch(providerInput)),
    safeProvider(() => pubmedSearch(providerInput)),
  ]);

  const fused = new Map<string, RankedResult>();
  for (const batch of batches) {
    // A single provider can return the same canonical URL twice (Crossref does
    // this for corrections); only its best rank should contribute.
    const seenInBatch = new Set<string>();
    for (let rank = 0; rank < batch.length; rank += 1) {
      const result = batch[rank];
      const key = canonicalUrlKey(result);
      if (!key || seenInBatch.has(key)) continue;
      seenInBatch.add(key);
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += contribution;
        existing.providerCount += 1;
        if (rank < existing.bestRank) {
          existing.bestRank = rank;
          // Prefer the richer record when two providers describe one work:
          // whichever ranked it higher usually has the better metadata.
          existing.result = mergeResults(existing.result, result);
        } else {
          existing.result = mergeResults(result, existing.result);
        }
        continue;
      }
      fused.set(key, {
        result,
        score: contribution,
        bestRank: rank,
        providerCount: 1,
      });
    }
  }

  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.providerCount - left.providerCount ||
        left.bestRank - right.bestRank,
    )
    .slice(0, Math.max(0, input.maxResults))
    .map((entry) => entry.result);
}

export async function wikipediaSearch(
  input: FreeSearchInput,
): Promise<FreeSearchResult[]> {
  const url =
    "https://en.wikipedia.org/w/rest.php/v1/search/page?" +
    `q=${encodeURIComponent(input.query)}&limit=${clampLimit(input.maxResults)}`;
  const body = await getJson(input, url);
  const pages = isRecord(body) && Array.isArray(body.pages) ? body.pages : [];
  const results: FreeSearchResult[] = [];
  for (const page of pages) {
    if (!isRecord(page) || typeof page.key !== "string") continue;
    const title = typeof page.title === "string" ? page.title : page.key;
    results.push({
      title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`,
      snippet: stripHtml(
        typeof page.excerpt === "string"
          ? page.excerpt
          : typeof page.description === "string"
            ? page.description
            : "",
      ),
      sourceTypeHint: "web",
      provider: "wikipedia",
    });
  }
  return results;
}

export async function openAlexSearch(
  input: FreeSearchInput,
): Promise<FreeSearchResult[]> {
  const url =
    "https://api.openalex.org/works?" +
    `search=${encodeURIComponent(input.query)}&per-page=${clampLimit(input.maxResults)}`;
  const body = await getJson(input, url);
  const works = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  const results: FreeSearchResult[] = [];
  for (const work of works) {
    if (!isRecord(work)) continue;
    const url = openAlexWorkUrl(work);
    if (!url) continue;
    const title =
      typeof work.display_name === "string"
        ? work.display_name
        : typeof work.title === "string"
          ? work.title
          : url;
    results.push({
      title,
      url,
      snippet: openAlexSnippet(work),
      publishedAt:
        typeof work.publication_date === "string" && work.publication_date
          ? work.publication_date
          : typeof work.publication_year === "number"
            ? String(work.publication_year)
            : undefined,
      sourceTypeHint: "paper",
      provider: "openalex",
    });
  }
  return results;
}

/**
 * arXiv's Atom API. Returns the `/abs/` landing page rather than `/pdf/`
 * deliberately: the abstract page is HTML the existing fetch path can parse,
 * and the PDF rewriter can still reach full text from it.
 */
export async function arxivSearch(
  input: FreeSearchInput,
): Promise<FreeSearchResult[]> {
  const limit = clampLimit(input.maxResults);
  const url =
    `${ARXIV_API}?search_query=${encodeURIComponent(`all:${input.query}`)}` +
    `&start=0&max_results=${limit}`;
  const xml = await getText(input, url);
  const results: FreeSearchResult[] = [];
  for (const entry of atomEntries(xml, limit)) {
    const rawId = collapseWhitespace(xmlText(entry, "id"));
    const arxivId = /arxiv\.org\/abs\/([^\s"<]+)/iu.exec(rawId)?.[1];
    if (!arxivId) continue;
    const title = collapseWhitespace(xmlText(entry, "title"));
    if (!title || /^error$/iu.test(title)) continue;
    const published = collapseWhitespace(xmlText(entry, "published"));
    results.push({
      title,
      url: `https://arxiv.org/abs/${arxivId}`,
      snippet: collapseWhitespace(xmlText(entry, "summary")).slice(
        0,
        MAX_SNIPPET_CHARS,
      ),
      publishedAt: published || undefined,
      sourceTypeHint: "paper",
      provider: "arxiv",
    });
  }
  return results;
}

/** Crossref works search — the DOI registry, so the broadest journal coverage. */
export async function crossrefSearch(
  input: FreeSearchInput,
): Promise<FreeSearchResult[]> {
  const url =
    `${CROSSREF_API}?query.bibliographic=${encodeURIComponent(input.query)}` +
    `&rows=${clampLimit(input.maxResults)}&select=DOI,URL,title,abstract,container-title,issued`;
  const body = await getJson(input, url);
  const message = isRecord(body) && isRecord(body.message) ? body.message : null;
  const items = message && Array.isArray(message.items) ? message.items : [];
  const results: FreeSearchResult[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const doi = typeof item.DOI === "string" ? item.DOI.trim() : "";
    const url =
      typeof item.URL === "string" && /^https?:\/\//iu.test(item.URL)
        ? item.URL
        : doi
          ? `https://doi.org/${doi}`
          : null;
    if (!url) continue;
    const title = firstString(item.title);
    if (!title) continue;
    const venue = firstString(item["container-title"]);
    const issued = crossrefIssuedDate(item.issued);
    const abstract =
      typeof item.abstract === "string" ? stripJats(item.abstract) : "";
    results.push({
      title,
      url,
      snippet: [
        [venue, issued?.slice(0, 4)].filter(Boolean).join(", "),
        abstract,
      ]
        .filter(Boolean)
        .join(" — ")
        .slice(0, MAX_SNIPPET_CHARS),
      publishedAt: issued,
      sourceTypeHint: "paper",
      provider: "crossref",
    });
  }
  return results;
}

/**
 * PubMed via NCBI E-utilities. Two hops by design — `esearch` returns bare
 * PMIDs and `esummary` turns them into records — so a failure in either hop
 * yields an empty list rather than half-formed results.
 */
export async function pubmedSearch(
  input: FreeSearchInput,
): Promise<FreeSearchResult[]> {
  const limit = clampLimit(input.maxResults);
  const searchUrl =
    `${PUBMED_ESEARCH}?db=pubmed&retmode=json&retmax=${limit}` +
    `&term=${encodeURIComponent(input.query)}`;
  const searchBody = await getJson(input, searchUrl);
  const esearch =
    isRecord(searchBody) && isRecord(searchBody.esearchresult)
      ? searchBody.esearchresult
      : null;
  const ids = (Array.isArray(esearch?.idlist) ? esearch.idlist : [])
    .filter((id): id is string => typeof id === "string" && /^\d+$/u.test(id))
    .slice(0, limit);
  if (ids.length === 0) return [];

  const summaryUrl = `${PUBMED_ESUMMARY}?db=pubmed&retmode=json&id=${ids.join(",")}`;
  const summaryBody = await getJson(input, summaryUrl);
  const records =
    isRecord(summaryBody) && isRecord(summaryBody.result)
      ? summaryBody.result
      : null;
  if (!records) return [];

  const results: FreeSearchResult[] = [];
  // Iterate `ids`, not the response's key order: E-utilities preserves
  // relevance order in `idlist` but the result object's key order is not
  // guaranteed, and rank is what the fusion step consumes.
  for (const id of ids) {
    const record = records[id];
    if (!isRecord(record)) continue;
    const title = collapseWhitespace(
      typeof record.title === "string" ? stripHtml(record.title) : "",
    );
    if (!title) continue;
    const source = typeof record.source === "string" ? record.source : "";
    const pubdate = typeof record.pubdate === "string" ? record.pubdate : "";
    results.push({
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      snippet: [source, pubdate].filter(Boolean).join(", ").slice(0, MAX_SNIPPET_CHARS),
      publishedAt: normalizePubmedDate(pubdate),
      sourceTypeHint: "paper",
      provider: "pubmed",
    });
  }
  return results;
}

async function getJson(input: FreeSearchInput, url: string): Promise<unknown> {
  const response = await getResponse(input, url);
  if (response.json !== undefined) return response.json;
  if (typeof response.text === "string" && response.text.trim()) {
    return JSON.parse(response.text);
  }
  return null;
}

async function getText(input: FreeSearchInput, url: string): Promise<string> {
  const response = await getResponse(input, {
    url,
    // arXiv serves Atom; asking for JSON gets us an unhelpful error page.
    accept: "application/atom+xml",
  });
  if (typeof response.text === "string") return response.text;
  return "";
}

async function getResponse(
  input: FreeSearchInput,
  target: string | { url: string; accept: string },
): Promise<HttpResponse> {
  const url = typeof target === "string" ? target : target.url;
  const headers =
    typeof target === "string"
      ? REQUEST_HEADERS
      : { ...REQUEST_HEADERS, Accept: target.accept };
  const response: HttpResponse = await input.transport({
    url,
    method: "GET",
    headers,
    throw: false,
    timeoutMs: input.timeoutMs,
    abortSignal: input.signal,
  });
  if (response.status >= 400) {
    throw new Error(`Free search provider returned HTTP ${response.status}.`);
  }
  return response;
}

async function safeProvider(
  run: () => Promise<FreeSearchResult[]>,
): Promise<FreeSearchResult[]> {
  try {
    return (await run()).filter((result) => result.url.trim());
  } catch {
    return [];
  }
}

/**
 * Prefer non-empty fields from `preferred`, falling back to `fallback`. Used
 * when two providers describe the same work and one has richer metadata.
 */
function mergeResults(
  preferred: FreeSearchResult,
  fallback: FreeSearchResult,
): FreeSearchResult {
  return {
    title: preferred.title.trim() || fallback.title,
    url: preferred.url,
    snippet:
      preferred.snippet.trim().length >= fallback.snippet.trim().length
        ? preferred.snippet
        : fallback.snippet,
    publishedAt: preferred.publishedAt ?? fallback.publishedAt,
    sourceTypeHint: preferred.sourceTypeHint ?? fallback.sourceTypeHint,
    provider: preferred.provider ?? fallback.provider,
  };
}

function openAlexWorkUrl(work: Record<string, unknown>): string | null {
  const primaryLocation = isRecord(work.primary_location)
    ? work.primary_location
    : undefined;
  const landing =
    primaryLocation && typeof primaryLocation.landing_page_url === "string"
      ? primaryLocation.landing_page_url
      : undefined;
  if (landing && /^https?:\/\//i.test(landing)) return landing;
  if (typeof work.doi === "string" && work.doi.trim()) {
    return work.doi.startsWith("http")
      ? work.doi
      : `https://doi.org/${work.doi.replace(/^doi:/i, "")}`;
  }
  if (typeof work.id === "string" && /^https?:\/\//i.test(work.id)) {
    return work.id;
  }
  return null;
}

function openAlexSnippet(work: Record<string, unknown>): string {
  const venue =
    isRecord(work.primary_location) &&
    isRecord(work.primary_location.source) &&
    typeof work.primary_location.source.display_name === "string"
      ? work.primary_location.source.display_name
      : undefined;
  const year =
    typeof work.publication_year === "number"
      ? String(work.publication_year)
      : undefined;
  const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
  const provenance = [venue, year].filter(Boolean).join(", ");
  return [provenance, abstract].filter(Boolean).join(" — ").slice(0, MAX_SNIPPET_CHARS);
}

/** OpenAlex ships abstracts as a word→positions inverted index; rebuild it. */
function reconstructOpenAlexAbstract(value: unknown): string {
  if (!isRecord(value)) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(value)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number" && position >= 0 && position < 400) {
        slots[position] = word;
      }
    }
  }
  return slots.filter((word) => typeof word === "string").join(" ").slice(0, 300);
}

/** Crossref dates arrive as `{ "date-parts": [[2024, 3, 14]] }`. */
function crossrefIssuedDate(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value["date-parts"])) return undefined;
  const parts = value["date-parts"][0];
  if (!Array.isArray(parts) || typeof parts[0] !== "number") return undefined;
  const [year, month, day] = parts;
  const pad = (part: unknown): string =>
    typeof part === "number" ? String(part).padStart(2, "0") : "01";
  if (typeof month !== "number") return String(year);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * PubMed pubdates are free text ("2024 Mar 14", "2023 Winter", "2024"). Recover
 * a year, and a month when it is unambiguous; anything else stays a bare year
 * so downstream freshness scoring never trusts an invented day.
 */
function normalizePubmedDate(value: string): string | undefined {
  const year = /\b(1[89]\d{2}|20\d{2})\b/u.exec(value)?.[1];
  if (!year) return undefined;
  const month = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/iu.exec(value)?.[1];
  if (!month) return year;
  const index = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ].indexOf(month.toLowerCase());
  if (index < 0) return year;
  return `${year}-${String(index + 1).padStart(2, "0")}`;
}

function firstString(value: unknown): string {
  if (typeof value === "string") return collapseWhitespace(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) return collapseWhitespace(entry);
    }
  }
  return "";
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Canonical de-duplication key.
 *
 * Delegates to the source-candidate ledger's canonicalizer so the fallback tier
 * and the worker's candidate ledger agree on what "the same source" means. The
 * previous local implementation keyed on `hostname + pathname`, which silently
 * collapsed every result from a query-parameter-addressed site — `?id=1` and
 * `?id=2` were treated as one page — and so could drop distinct sources before
 * they were ever offered.
 */
function canonicalUrlKey(result: FreeSearchResult): string | null {
  const key = canonicalizeSourceCandidate({
    url: result.url,
    title: result.title,
    provider: result.provider,
  });
  return key.trim() ? key : null;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(10, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
