import type {
  ResearchSourceType,
  SourceQualitySignals,
} from "../orchestrator/sourceCandidateLedger";
import type { MissionEvidence } from "./missionLedger";

/**
 * Provider-neutral ranking signals for a search result.
 *
 * `scoreSourceCandidate` in the source-candidate ledger has always computed a
 * real weighted score — `quality*45 + freshness*20 + fetchability*25 + type
 * authority` — but every call site fed it either a literal constant or a value
 * derived from the source type. Freshness and fetchability therefore
 * contributed a fixed offset to every candidate, and candidate ordering
 * collapsed to exactly the source-type ordering. This module supplies the three
 * signals independently so the score means what it says.
 *
 * Pure and Obsidian-free, in the style of `researchEffortPolicy.ts` and
 * `deadLinkCheck.ts`, so it is unit-testable without a vault and so a run ranks
 * identically live and replayed.
 *
 * Design rule: when a signal is genuinely unknown, return the constant the code
 * used before this module existed. An absent publication date must not make a
 * source look stale — it must make it look exactly as it did yesterday.
 */

/** The freshness value used before real dates were available. */
export const UNKNOWN_FRESHNESS = 0.65;
/** The fetchability value used before URL-shape priors existed. */
export const BASE_FETCHABILITY = 0.75;

/**
 * Years after which a dated source has lost half its freshness. Three years is
 * a deliberate compromise: fast-moving fields want ~1, historical and
 * foundational work wants ~10, and the runner cannot tell which it is holding.
 */
const FRESHNESS_HALF_LIFE_YEARS = 3;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
/** Even a very old source retains some value; never score it to zero. */
const MIN_FRESHNESS = 0.15;

/**
 * Multi-part public suffixes common enough to matter for "distinct domains".
 * A full Public Suffix List would be thousands of entries and a dependency;
 * this covers the country-code academic and government hosts that actually
 * appear in research results. An unlisted suffix falls back to the last two
 * labels, which is correct for every generic TLD.
 */
const MULTI_PART_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "org.uk", "net.uk", "sch.uk",
  "ac.jp", "co.jp", "go.jp", "or.jp",
  "com.au", "edu.au", "gov.au", "org.au",
  "co.nz", "ac.nz", "govt.nz",
  "com.br", "org.br", "gov.br",
  "co.in", "ac.in", "gov.in", "res.in",
  "com.cn", "edu.cn", "gov.cn", "ac.cn",
  "co.za", "ac.za", "gov.za",
  "com.sg", "edu.sg", "gov.sg",
  "co.kr", "ac.kr", "go.kr",
]);

/** Hosts that reliably serve parseable open-access HTML. */
const OPEN_ACCESS_HOSTS = [
  "arxiv.org",
  "ar5iv.labs.arxiv.org",
  "pmc.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "europepmc.org",
  "plos.org",
  "biorxiv.org",
  "medrxiv.org",
  "openalex.org",
  "wikipedia.org",
  "nature.com/articles",
];

/**
 * Hosts that usually answer a fetch with an abstract-and-paywall interstitial.
 * These are still worth surfacing — the abstract alone can settle a question —
 * but they should rank below a source we can actually read.
 */
const PAYWALL_HOSTS = [
  "sciencedirect.com",
  "link.springer.com",
  "onlinelibrary.wiley.com",
  "jstor.org",
  "tandfonline.com",
  "ieeexplore.ieee.org",
  "dl.acm.org",
  "cambridge.org/core",
  "academic.oup.com",
  "journals.sagepub.com",
];

export interface SourceSignalInput {
  url: string;
  title?: string;
  snippet?: string;
  /** ISO-8601 date or bare year, when the provider reports one. */
  publishedAt?: string;
  /** Provider-supplied type hint; used only when the URL/title say nothing. */
  sourceTypeHint?: ResearchSourceType;
  now?: Date;
}

export interface SourceSignals extends SourceQualitySignals {
  sourceType: ResearchSourceType;
}

/** Derive all four ranking inputs for one candidate. */
export function inferSourceSignals(input: SourceSignalInput): SourceSignals {
  const url = input.url ?? "";
  const title = input.title ?? "";
  const sourceType = inferSourceType(url, title, input.sourceTypeHint);
  return {
    sourceType,
    quality: inferQuality({ url, title, snippet: input.snippet, sourceType }),
    freshness: inferFreshness(input.publishedAt, input.now),
    fetchability: inferFetchability(url),
  };
}

/**
 * Classify a source by URL and title.
 *
 * Two corrections to the worker's original private helper, both of which only
 * ever made classification *less* accurate:
 *
 *  - URL-shaped patterns (`.pdf`, `.gov`) are now tested against the URL alone.
 *    The original matched them against `url + " " + title`, and both patterns
 *    are anchored with `(?:$|[?#])` or `(?:\/|$)`, so appending a title moved
 *    the anchor out of reach: `https://x/a.pdf` classified as `pdf` only when
 *    the title happened to be empty, and as `web` the rest of the time.
 *  - A provider type hint can break a tie that would otherwise fall through to
 *    the generic `web`, but never downgrades a confident URL-derived verdict.
 *
 * Keyword patterns still read the combined text, which is where a title like
 * "2024 journal study" is the only available signal.
 */
export function inferSourceType(
  urlValue: string,
  title: string,
  hint?: ResearchSourceType,
): ResearchSourceType {
  const url = (urlValue ?? "").toLowerCase();
  const lower = `${urlValue} ${title}`.toLowerCase();
  if (/\.pdf(?:$|[?#])/.test(url)) return "pdf";
  if (/\.(docx?|pptx?|xlsx?|epub)(?:$|[?#])/.test(url)) return "document";
  if (/arxiv\.org|doi\.org|\b(journal|study|paper|research)\b/.test(lower)) return "paper";
  if (/\.gov(?:\/|$|[?#])/.test(url) || /\b(official|documentation|docs)\b/.test(lower)) {
    return "official";
  }
  if (/\b(primary source|transcript|dataset)\b/.test(lower)) return "primary";
  if (/\b(news|press|reuters|associated press)\b/.test(lower)) return "news";
  // A scholarly provider knows its own corpus better than a URL regex does.
  if (hint && hint !== "web") return hint;
  return "web";
}

/**
 * Content/authority estimate in 0..1.
 *
 * Starts from the type prior the worker used, then adds terms that vary
 * independently of type — registrable-domain authority, an explicit DOI, and
 * snippet length as a proxy for how much text the page will actually yield.
 */
export function inferQuality(input: {
  url: string;
  title?: string;
  snippet?: string;
  sourceType?: ResearchSourceType;
}): number {
  const sourceType =
    input.sourceType ?? inferSourceType(input.url, input.title ?? "");
  let score = typeQualityPrior(sourceType);

  const host = hostOf(input.url);
  if (host) {
    const suffix = host.split(".").pop() ?? "";
    if (suffix === "gov" || suffix === "mil" || suffix === "int") score += 0.08;
    else if (suffix === "edu") score += 0.06;
    else if (/\.(gov|ac|edu)\.[a-z]{2}$/u.test(host)) score += 0.06;
    if (OPEN_ACCESS_HOSTS.some((known) => hostMatches(host, known))) score += 0.04;
  }

  // A registered DOI means a citable, versioned record behind the link.
  if (/\bdoi\.org\/10\.\d{4,9}\//iu.test(input.url) || /\b10\.\d{4,9}\//u.test(input.url)) {
    score += 0.05;
  }

  // Snippet length is the cheapest available signal for whether a page will
  // yield extractable passages; an empty snippet often means a JS shell.
  const snippet = (input.snippet ?? "").trim();
  if (snippet.length >= 200) score += 0.04;
  else if (snippet.length > 0 && snippet.length < 40) score -= 0.05;

  return clamp01(score);
}

/**
 * Freshness in 0..1 from a publication date, decaying on a three-year half
 * life. Returns {@link UNKNOWN_FRESHNESS} when no usable date is present, so an
 * undated source ranks exactly where it did before dates were available.
 */
export function inferFreshness(publishedAt?: string, now?: Date): number {
  const published = parsePublishedAt(publishedAt);
  if (!published) return UNKNOWN_FRESHNESS;
  const reference = now ?? new Date();
  const ageYears = (reference.getTime() - published.getTime()) / MS_PER_YEAR;
  // A future date is a provider bug, not a scoop; treat it as brand new.
  if (!Number.isFinite(ageYears) || ageYears <= 0) return 1;
  const decayed = 2 ** (-ageYears / FRESHNESS_HALF_LIFE_YEARS);
  return clamp01(Math.max(MIN_FRESHNESS, decayed));
}

/**
 * Probability the source can be fetched *and parsed*, in 0..1.
 *
 * This is about the parser, not the network: a PDF returns HTTP 200 and then
 * yields no passages, which costs a whole fetch attempt and a source-lease
 * slot. Ranking readable pages higher is the cheapest way to spend the budget
 * on sources that can actually become evidence.
 */
export function inferFetchability(urlValue: string): number {
  const url = urlValue.toLowerCase();
  const host = hostOf(urlValue);

  if (/\.pdf(?:$|[?#])/u.test(url)) return 0.35;
  if (/\.(docx?|pptx?|xlsx?|epub)(?:$|[?#])/u.test(url)) return 0.3;

  if (host) {
    if (PAYWALL_HOSTS.some((known) => hostMatches(host, known) || url.includes(known))) {
      return 0.3;
    }
    if (hostMatches(host, "arxiv.org")) {
      // /abs/ is HTML; /pdf/ is not, and is handled by the rewriter.
      return /\/pdf\//u.test(url) ? 0.4 : 0.9;
    }
    if (
      hostMatches(host, "pmc.ncbi.nlm.nih.gov") ||
      hostMatches(host, "europepmc.org") ||
      hostMatches(host, "wikipedia.org")
    ) {
      return 0.9;
    }
    // doi.org is a redirector: it resolves reliably but often lands on a
    // publisher page we cannot read, so it sits between the two.
    if (hostMatches(host, "doi.org")) return 0.6;
    const suffix = host.split(".").pop() ?? "";
    if (suffix === "gov" || suffix === "mil") return 0.85;
  }

  return BASE_FETCHABILITY;
}

/**
 * Registrable domain ("eTLD+1") for a URL, lowercased, or null.
 *
 * Used for domain-independence counting: `journals.example.com` and
 * `www.example.com` are one source of authority, not two.
 */
export function registrableDomain(urlValue: string): string | null {
  const host = hostOf(urlValue);
  if (!host) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function typeQualityPrior(type: ResearchSourceType): number {
  if (type === "primary" || type === "official") return 0.9;
  if (type === "paper") return 0.85;
  if (type === "pdf" || type === "document") return 0.7;
  if (type === "vault") return 0.65;
  if (type === "news") return 0.62;
  return 0.5;
}

/** Accepts a full ISO date, `YYYY-MM`, or a bare `YYYY`. */
function parsePublishedAt(value?: string): Date | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (/^\d{4}$/u.test(trimmed)) {
    // A bare year is only known to mid-year precision; anchoring to July
    // avoids systematically over- or under-aging every undated-month source.
    return new Date(Date.UTC(Number(trimmed), 6, 1));
  }
  if (/^\d{4}-\d{2}$/u.test(trimmed)) {
    const [year, month] = trimmed.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 15));
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hostOf(urlValue: string): string | null {
  const trimmed = (urlValue ?? "").trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/** True when `host` is `known` or a subdomain of it. */
function hostMatches(host: string, known: string): boolean {
  const base = known.split("/")[0];
  return host === base || host.endsWith(`.${base}`);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ------------------------------------------------------------------------- *
 * Web search result ranking (Cluster D2, moved verbatim from AgentRunner.ts)
 *
 * The single-agent loop's own result ranking and domain-diversity selection.
 * It predates the candidate-signal scoring above and uses a coarser authority
 * heuristic; the two coexist deliberately — this ranks raw search output for
 * the next fetch, the signals above rank ledger candidates. Unifying the
 * heuristics would change live routing and belongs in its own change.
 * ------------------------------------------------------------------------- */

export function getFirstWebSearchResultUrl(output: unknown): string | null {
  return getWebSearchResultUrls(output)[0] ?? null;
}

export function getWebSearchResultUrls(output: unknown): string[] {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return [];
  }

  const urls: string[] = [];
  for (const result of output.results) {
    if (!isRecord(result) || typeof result.url !== "string") {
      continue;
    }

    const url = result.url.trim();
    if (/^https?:\/\//i.test(url) && !urls.includes(url)) {
      urls.push(url);
    }
  }

  return urls;
}

export function rankWebSearchResultUrls(output: unknown, query: string): string[] {
  if (!isRecord(output) || !Array.isArray(output.results)) {
    return [];
  }
  const queryTerms = getSourceRankingTerms(query);
  return output.results
    .map((result, index) => {
      if (!isRecord(result) || typeof result.url !== "string") return null;
      const url = result.url.trim();
      if (!/^https?:\/\//i.test(url)) return null;
      const text = [result.title, result.snippet, result.content, url]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
      const relevance = queryTerms.reduce(
        (score, term) => score + (text.includes(term) ? 1 : 0),
        0,
      );
      const authority = /(?:\.gov|\.edu|doi\.org|arxiv\.org|docs?\.)/i.test(url)
        ? 0.25
        : 0;
      return { url, index, score: relevance + authority };
    })
    .filter(
      (item): item is { url: string; index: number; score: number } => item !== null,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.url)
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

export function getSourceRankingTerms(value: string): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "before",
    "cite",
    "cited",
    "citation",
    "current",
    "include",
    "multiple",
    "research",
    "source",
    "sources",
    "that",
    "their",
    "this",
    "verify",
    "with",
  ]);
  return [
    ...new Set(
      (value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter(
        (term) => !stopWords.has(term),
      ),
    ),
  ].slice(0, 40);
}

export function selectDomainDiverseUrls(
  candidateUrls: string[],
  alreadyFetchedUrls: string[],
  limit: number,
): string[] {
  if (limit <= 0) {
    return [];
  }

  const fetched = new Set(alreadyFetchedUrls);
  const usedDomains = new Set(
    alreadyFetchedUrls
      .map(getUrlHostname)
      .filter((domain): domain is string => Boolean(domain)),
  );
  const selected: string[] = [];
  const deferred: string[] = [];

  for (const url of candidateUrls) {
    if (fetched.has(url)) {
      continue;
    }
    const hostname = getUrlHostname(url);
    if (hostname && !usedDomains.has(hostname)) {
      selected.push(url);
      usedDomains.add(hostname);
    } else {
      deferred.push(url);
    }
    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const url of deferred) {
    if (selected.length >= limit) {
      break;
    }
    if (!selected.includes(url)) {
      selected.push(url);
    }
  }

  return selected;
}

export function getFetchedWebSourceUrls(evidence: MissionEvidence[]): string[] {
  return [
    ...new Set(
      evidence
        .filter((item) => item.kind === "web_source" || Boolean(item.url))
        .map((item) => item.url)
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

export function getUrlHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
