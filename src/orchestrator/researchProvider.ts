import { evaluateSourceUsability } from "../agent/sourceUsability";

export type ResearchRetrievalStrategy =
  | "cached_section"
  | "provider_fetch"
  | "browser_extract"
  | "document_extract"
  | "alternate_result";

export interface ResearchRetrievalCandidate {
  id: string;
  url: string;
  title?: string;
  strategy: ResearchRetrievalStrategy;
  query?: string;
}

export interface ResearchRetrievalOutput {
  title: string;
  url: string;
  content: string;
  parserStatus?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ResearchRetrievalProvider {
  id: string;
  strategies: ResearchRetrievalStrategy[];
  retrieve(
    candidate: ResearchRetrievalCandidate,
    signal?: AbortSignal,
  ): Promise<ResearchRetrievalOutput | null>;
}

export interface ResearchRetrievalAttempt {
  candidateId: string;
  providerId: string;
  strategy: ResearchRetrievalStrategy;
  status: "usable" | "empty" | "unparsed" | "error" | "unsupported";
  reason?: string;
}

export interface ResearchRetrievalResult {
  output: ResearchRetrievalOutput | null;
  passageIds: string[];
  attempts: ResearchRetrievalAttempt[];
  exhausted: boolean;
}

/**
 * Provider-neutral, fail-closed retrieval. A provider response is accepted
 * only after passage extraction succeeds; empty/unparsed output transparently
 * falls through the ordered cache/browser/document/alternate candidates.
 */
export async function retrieveUsableResearchSource(input: {
  candidates: ResearchRetrievalCandidate[];
  providers: ResearchRetrievalProvider[];
  signal?: AbortSignal;
  maxAttempts?: number;
}): Promise<ResearchRetrievalResult> {
  const attempts: ResearchRetrievalAttempt[] = [];
  const maxAttempts = Math.min(20, Math.max(1, input.maxAttempts ?? 10));
  for (const candidate of dedupeCandidates(input.candidates)) {
    for (const provider of input.providers) {
      if (attempts.length >= maxAttempts) {
        return { output: null, passageIds: [], attempts, exhausted: true };
      }
      if (!provider.strategies.includes(candidate.strategy)) {
        attempts.push({
          candidateId: candidate.id,
          providerId: provider.id,
          strategy: candidate.strategy,
          status: "unsupported",
        });
        continue;
      }
      if (input.signal?.aborted) {
        throw new Error("Research retrieval was cancelled.");
      }
      try {
        const output = await provider.retrieve(candidate, input.signal);
        if (!output) {
          attempts.push({
            candidateId: candidate.id,
            providerId: provider.id,
            strategy: candidate.strategy,
            status: "empty",
            reason: "provider_returned_no_output",
          });
          continue;
        }
        const usability = evaluateSourceUsability({
          content: output.content,
          sourceLocator: output.url || candidate.url,
          query: candidate.query,
          parserStatus: output.parserStatus,
        });
        attempts.push({
          candidateId: candidate.id,
          providerId: provider.id,
          strategy: candidate.strategy,
          status: usability.usable
            ? "usable"
            : usability.reason === "parser_failed"
              ? "unparsed"
              : "empty",
          reason: usability.reason,
        });
        if (usability.usable) {
          return {
            output,
            passageIds: usability.passageIds,
            attempts,
            exhausted: false,
          };
        }
      } catch (error) {
        attempts.push({
          candidateId: candidate.id,
          providerId: provider.id,
          strategy: candidate.strategy,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { output: null, passageIds: [], attempts, exhausted: true };
}

export function buildResearchFallbackCandidates(input: {
  url: string;
  alternateUrls?: string[];
  query?: string;
  documentLike?: boolean;
}): ResearchRetrievalCandidate[] {
  const primary = input.url.trim();
  const candidates: ResearchRetrievalCandidate[] = [
    { id: "primary-1", url: primary, strategy: "cached_section", query: input.query },
    { id: "primary-2", url: primary, strategy: "provider_fetch", query: input.query },
  ];

  // Before spending a browser or document-extract attempt on a PDF, try the
  // open HTML edition of the same work. This is the cheap substitute for a PDF
  // parser: the repository ships with no runtime dependencies, and a
  // dependency-free extractor would be thousands of lines of high-bug-density
  // code for a partial result, whereas these publishers already serve the same
  // text as parseable HTML at a derivable URL.
  for (const [index, url] of buildOpenHtmlEquivalents(primary).entries()) {
    candidates.push({
      id: `html-equivalent-${index + 1}`,
      url,
      // Deliberately `provider_fetch`: the strategy union is provider-declared,
      // so a novel strategy would match no provider and never be attempted.
      strategy: "provider_fetch",
      query: input.query,
    });
  }

  candidates.push({
    id: "primary-3",
    url: primary,
    strategy: "browser_extract",
    query: input.query,
  });
  if (input.documentLike) {
    candidates.push({
      id: "primary-4",
      url: primary,
      strategy: "document_extract",
      query: input.query,
    });
  }

  for (const [index, url] of (input.alternateUrls ?? []).slice(0, 5).entries()) {
    candidates.push({
      id: `alternate-${index + 1}`,
      url,
      strategy: "alternate_result",
      query: input.query,
    });
  }
  return candidates;
}

/**
 * Derive open, parseable HTML editions of a PDF or landing-page URL.
 *
 * Pure and network-free by contract: every rewrite is a URL-shape
 * transformation a publisher guarantees, never a lookup. That rules out
 * resolving a bare DOI (which needs a redirect) and mapping a PMID to a PMCID
 * (which needs NCBI's id converter); for those we return what can be derived
 * and let the ordinary fallback chain handle the rest.
 *
 * Order matters: the most faithful full-text edition comes first.
 */
export function buildOpenHtmlEquivalents(value: string): string[] {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return [];
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const path = url.pathname;
  const equivalents: string[] = [];

  // arXiv: /pdf/<id> and the 10.48550 DOI both map to the abstract page, and
  // ar5iv renders the full LaTeX source as HTML.
  const arxivId =
    /^\/pdf\/(.+?)(?:\.pdf)?$/u.exec(path)?.[1] ??
    (host === "doi.org"
      ? /^\/10\.48550\/arxiv\.(.+)$/iu.exec(path)?.[1]
      : undefined);
  if (arxivId && (host === "arxiv.org" || host === "doi.org")) {
    const bare = arxivId.replace(/v\d+$/u, "");
    equivalents.push(`https://arxiv.org/abs/${arxivId}`);
    equivalents.push(`https://ar5iv.labs.arxiv.org/html/${bare}`);
  }

  // PubMed exposes no PMCID without a lookup, but Europe PMC addresses the
  // same record by PMID directly.
  const pmid = host === "pubmed.ncbi.nlm.nih.gov" ? /^\/(\d+)\/?$/u.exec(path)?.[1] : undefined;
  if (pmid) {
    equivalents.push(`https://europepmc.org/article/MED/${pmid}`);
  }

  // PMC serves the article body as HTML one level up from its PDF.
  const pmcId = /^\/articles\/(PMC\d+)\//iu.exec(path)?.[1];
  if (pmcId && host.endsWith("ncbi.nlm.nih.gov") && /\/pdf\//iu.test(path)) {
    equivalents.push(`https://pmc.ncbi.nlm.nih.gov/articles/${pmcId}/`);
  }

  // The preprint servers append .full.pdf to an HTML page that already exists.
  if ((host.endsWith("biorxiv.org") || host.endsWith("medrxiv.org")) && /\.full\.pdf$/u.test(path)) {
    equivalents.push(`${url.origin}${path.replace(/\.full\.pdf$/u, ".full")}`);
  }

  const normalizedPrimary = normalizeUrl(trimmed);
  return dedupeStrings(equivalents).filter(
    (candidate) => normalizeUrl(candidate) !== normalizedPrimary,
  );
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function dedupeCandidates(
  candidates: ResearchRetrievalCandidate[],
): ResearchRetrievalCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.strategy}:${normalizeUrl(candidate.url)}`;
    if (!candidate.url.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}
