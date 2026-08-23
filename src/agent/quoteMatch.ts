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

/**
 * First index of `quote` within `source`, in the ORIGINAL text's coordinates,
 * or -1.
 *
 * `findQuoteOffset` deliberately reports normalized-space offsets, which are
 * useless for pointing at anything in the real document. This walks the same
 * normalization while remembering where each surviving character came from, so
 * a verified quote can be located in the text a reader will actually open.
 */
export function findQuoteRawOffset(quote: string, source: string): number {
  const needle = normalizeForMatch(quote);
  if (!needle) return -1;
  const { normalized, rawIndex } = normalizeWithIndex(source);
  const found = normalized.indexOf(needle);
  if (found < 0) return -1;
  return rawIndex[found] ?? -1;
}

/** Normalize exactly as {@link normalizeForMatch} does, keeping a source map. */
function normalizeWithIndex(value: string): {
  normalized: string;
  rawIndex: number[];
} {
  const folded = value
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"');
  // Character-for-character so far: toLowerCase can change length for a few
  // exotic code points, so verify before trusting the 1:1 mapping.
  const oneToOne = folded.length === value.length;
  const chars: string[] = [];
  const rawIndex: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < folded.length; index += 1) {
    const char = folded[index]!;
    if (/\s/u.test(char)) {
      pendingSpace = chars.length > 0;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      rawIndex.push(oneToOne ? index : 0);
      pendingSpace = false;
    }
    chars.push(char);
    rawIndex.push(oneToOne ? index : 0);
  }
  return { normalized: chars.join(""), rawIndex };
}

/** A citation pinpoint a reader can follow in any edition of the source. */
export interface PinpointLocatorV1 {
  /** Rendered pinpoint, e.g. "3:16", "§ 12", "¶ 4", "p. 7". */
  label: string;
  kind: "verse" | "section" | "paragraph" | "page" | "heading";
  /** Offset of the marker in the source text. */
  offset: number;
}

/**
 * The nearest structural marker at or before `offset`.
 *
 * In primary-text disciplines the pinpoint *is* the citation: "John 3:16",
 * "§ 230(c)(1)", "Institutes II.1.1". A section index into our own cached copy
 * is useless to a reader holding a different edition, and a page number is the
 * only pinpoint a PDF has. Nearest-preceding wins, with the more specific
 * marker breaking a tie at the same position.
 */
export function findPinpointLocator(
  text: string,
  offset: number,
): PinpointLocatorV1 | null {
  if (offset < 0) return null;
  const head = text.slice(0, Math.min(offset + 1, text.length));
  const candidates: PinpointLocatorV1[] = [];
  const collect = (
    pattern: RegExp,
    kind: PinpointLocatorV1["kind"],
    render: (match: RegExpExecArray) => string,
  ) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = pattern.exec(head)) !== null) {
      last = match;
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    if (last) {
      candidates.push({ label: render(last), kind, offset: last.index });
    }
  };

  // Chapter:verse — anchored to a line start or a bracket so an ordinary
  // ratio or timestamp in prose is not read as scripture.
  collect(
    /(?:^|\n|\[|\()\s*(\d{1,3}):(\d{1,3})(?:[-–]\d{1,3})?/gu,
    "verse",
    (match) => `${match[1]}:${match[2]}`,
  );
  collect(/§+\s*(\d+[\w.()-]*)/gu, "section", (match) => `§ ${match[1]}`);
  collect(/¶+\s*(\d+)/gu, "paragraph", (match) => `¶ ${match[1]}`);
  // "## Page 7" is what the companion's PDF extractor emits; "[p. 7]" is the
  // conventional inline form.
  collect(
    /(?:^|\n)#{1,6}\s*page\s+(\d+)|\[p{1,2}\.?\s*(\d+)\]/giu,
    "page",
    (match) => `p. ${match[1] ?? match[2]}`,
  );
  collect(
    /(?:^|\n)(#{1,6})\s+(.{1,80}?)\s*(?=\n|$)/gu,
    "heading",
    (match) => match[2].trim(),
  );

  if (candidates.length === 0) return null;
  const specificity: Record<PinpointLocatorV1["kind"], number> = {
    verse: 5,
    section: 4,
    paragraph: 3,
    page: 2,
    heading: 1,
  };
  return candidates.sort(
    (left, right) =>
      right.offset - left.offset ||
      specificity[right.kind] - specificity[left.kind],
  )[0]!;
}
