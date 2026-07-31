/**
 * Verbatim quote matching, shared by the `verify_citation` tool and the claim
 * ledger's automatic quote-span check.
 *
 * One normalizer, one caller-visible contract: a quote is verbatim when it
 * appears in the source text after whitespace collapsing, case folding, and
 * smart-quote folding — and only then. Nothing here does fuzzy or semantic
 * matching; a paraphrase must fail, because the whole point of the check is to
 * catch text the model wrote rather than read.
 *
 * Pure and Obsidian-free so both the tool path and the ledger path can use it
 * without a vault, and so a run scores identically live and replayed.
 */

/**
 * Fold the cosmetic differences that survive an honest copy-paste — smart
 * quotes, case, and whitespace runs — while preserving every word.
 *
 * Kept byte-for-byte identical to the original `verify_citation` normalizer so
 * that extracting it cannot flip a previously `unsupported` quote to
 * `supported`. Widening it (dash folding, ligatures, non-breaking spaces) is a
 * deliberate rigor decision, not a refactor, and belongs in its own change with
 * its own test corpus.
 */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim();
}

/** True when `quote` appears verbatim in `source` under {@link normalizeForMatch}. */
export function quoteAppearsVerbatim(quote: string, source: string): boolean {
  const needle = normalizeForMatch(quote);
  if (!needle) return false;
  return normalizeForMatch(source).includes(needle);
}

/**
 * First index of `quote` within `source`, in normalized space, or -1. Callers
 * use this only for reporting; offsets are not comparable to raw-text offsets
 * because normalization changes lengths.
 */
export function findQuoteOffset(quote: string, source: string): number {
  const needle = normalizeForMatch(quote);
  if (!needle) return -1;
  return normalizeForMatch(source).indexOf(needle);
}
