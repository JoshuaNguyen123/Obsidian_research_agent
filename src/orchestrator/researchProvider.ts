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
  const strategies: ResearchRetrievalStrategy[] = [
    "cached_section",
    "provider_fetch",
    "browser_extract",
    ...(input.documentLike ? (["document_extract"] as const) : []),
  ];
  const candidates = strategies.map((strategy, index) => ({
    id: `primary-${index + 1}`,
    url: primary,
    strategy,
    query: input.query,
  }));
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
