import { registrableDomain } from "./sourceSignals";

/**
 * Deterministic depth proxies for a research deliverable.
 *
 * The changelog names "thin research summaries" as the reason cheaper models
 * fail the flagship journey, and nothing in the harness measured it: a run that
 * fetched four sources and cited one scored the same as a run that used all
 * four. These two metrics close that hole.
 *
 * Deliberately *not* an LLM judge. `missionScorecard`'s contract is that it is
 * pure and I/O-free so a live run and a replayed durable ledger score
 * identically; a judge would make the regression gate nondeterministic and
 * unreplayable. These are cheap structural proxies instead — they cannot tell
 * you the prose is good, only that there is enough sourced substance for it to
 * possibly be.
 */

/**
 * Distinct sources beyond which more breadth stops improving the score.
 * Four independent domains is a genuinely well-sourced answer; a run citing
 * twenty should not outrank it on count alone.
 */
const SOURCE_BREADTH_TARGET = 4;
/** Quoted spans beyond which more quoting stops improving the score. */
const QUOTE_TARGET = 3;
/** Structural sections beyond which more sections stop improving the score. */
const SECTION_TARGET = 4;

export interface ResearchDepthInput {
  /** URLs of sources that were fetched, parsed, and content-hash distinct. */
  usableSourceUrls: readonly string[];
  /** Distinct domains the plan required, if any. */
  requiredDistinctDomains: number;
  /** Claims in the final answer that required support. */
  claimsRequiringEvidence: number;
  /** Distinct passage identifiers actually cited in the final answer. */
  citedPassageCount: number;
  /** Verified verbatim quote spans in the final answer. */
  quotedSpanCount: number;
  /** Markdown sections in the deliverable. */
  sectionCount: number;
}

/**
 * How much of the required source *independence* the run actually achieved,
 * counting registrable domains rather than URLs so three pages of one site
 * count once.
 *
 * Empty-set convention 1, consistent with the scorecard's existing `coverage`:
 * a mission that required no web sources has not failed independence.
 */
export function scoreSourceIndependence(input: ResearchDepthInput): number {
  const required = Math.max(0, Math.trunc(input.requiredDistinctDomains));
  if (required <= 0) return 1;
  const domains = new Set<string>();
  for (const url of input.usableSourceUrls) {
    const domain = registrableDomain(url);
    if (domain) domains.add(domain);
  }
  return clamp01(domains.size / required);
}

/**
 * Blended depth proxy in 0..1.
 *
 * Four independent signals, equally weighted, each saturating at a target so
 * no single one can be gamed by repetition:
 *
 *  - citation density — cited passages per claim needing support
 *  - source breadth   — distinct domains actually drawn on
 *  - quotation        — verified verbatim spans, the hardest signal to fake
 *  - structure        — sections, the cheapest signal and so no more than a quarter
 *
 * A summary that cites one source once in one section scores near zero; one
 * that cites several sources across a structured report scores near one.
 */
export function scoreResearchDepth(input: ResearchDepthInput): number {
  const claims = Math.max(0, Math.trunc(input.claimsRequiringEvidence));
  // With no claims needing support there is nothing to be thin about; fall back
  // to the structural signals rather than scoring an unsourced run highly.
  const citationDensity =
    claims > 0 ? clamp01(input.citedPassageCount / claims) : 0;

  const domains = new Set<string>();
  for (const url of input.usableSourceUrls) {
    const domain = registrableDomain(url);
    if (domain) domains.add(domain);
  }
  const breadth = clamp01(domains.size / SOURCE_BREADTH_TARGET);
  const quotation = clamp01(Math.max(0, input.quotedSpanCount) / QUOTE_TARGET);
  const structure = clamp01(Math.max(0, input.sectionCount) / SECTION_TARGET);

  return round4((citationDensity + breadth + quotation + structure) / 4);
}

/** Count markdown headings, the cheap structural proxy used above. */
export function countMarkdownSections(text: string): number {
  let count = 0;
  for (const line of (text ?? "").split(/\r?\n/u)) {
    if (/^[ \t]{0,3}#{1,6}[ \t]+\S/u.test(line)) count += 1;
  }
  return count;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
