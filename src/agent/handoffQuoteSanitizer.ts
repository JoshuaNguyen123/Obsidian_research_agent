/**
 * Capture-time verification of researcher-handoff quotations.
 *
 * A researcher handoff or continuation evidence summary is model prose, and a
 * quoted span inside it attributed to a fetched source is the model's own
 * transcription until proven otherwise. The write-time claim ledger already
 * refuses such spans (`claim_grounding:quote_mismatch`), but by then the
 * writer has trusted the handoff and the mission pays a repair loop to
 * rediscover the true bytes. This pass runs the SAME verbatim predicate the
 * write-time verifier uses — `quoteAppearsVerbatim`, nothing fuzzier — at the
 * point where researcher prose becomes writer-consumed evidence, so a bad
 * capture is corrected or defused before anyone downstream trusts it.
 *
 * Per attributed quote, in preference order:
 * 1. Verbatim in an attributed passage → untouched.
 * 2. Verbatim in a different accepted passage → the quote text is replaced
 *    with the passage's actual bytes and the attribution is corrected.
 * 3. Not verbatim anywhere in the store → downgraded to an explicit
 *    paraphrase with the quotation marks removed, so the writer can never
 *    lift it as quotable bytes.
 *
 * Quotes with no adjacent source/passage reference are left alone: rhetorical
 * quotes and titles are not presented as captures, and the write-time ledger
 * still enforces whatever the writer ultimately claims. This pass adds a
 * checkpoint at the capture end; it never replaces the write-time enforcer.
 */

import type { ClaimPassageRef } from "./claimLedger";
import { collectPassageIdsFromText } from "./claimLedger";
import type { MissionEvidence } from "./missionLedger";
import {
  createQuotedSpanPattern,
  findQuoteRawSpan,
  quoteAppearsVerbatim,
} from "./quoteMatch";

/** Fallback attribution window around a quote when its line cites nothing. */
const ATTRIBUTION_WINDOW_CHARS = 240;

const PARAPHRASE_MARKER =
  "[paraphrase — not verbatim in the cited source; re-fetch before quoting]";

export interface HandoffQuoteSanitationResult {
  text: string;
  /** Quotes that matched an attributed passage verbatim and were left alone. */
  verifiedCount: number;
  /** Quotes found verbatim in a different accepted passage and reattributed. */
  reattributedCount: number;
  /** Quotes found nowhere in the passage store and downgraded to paraphrase. */
  downgradedCount: number;
}

interface QuoteEdit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Verify every source-attributed quotation in `text` against the cached
 * passage store and rewrite the ones the store cannot back.
 *
 * `passages` are the accepted claim passages (cached source bytes) the
 * write-time verifier will later check against; `evidence` optionally maps
 * URL-only attributions ("from <url>") to their passage ids. With an empty
 * store the text is returned unchanged: there is nothing to verify against,
 * and a fabricated passage id already fails closed at write time.
 */
export function sanitizeHandoffQuotes(input: {
  text: string;
  passages: ClaimPassageRef[];
  evidence?: MissionEvidence[];
}): HandoffQuoteSanitationResult {
  const text = input.text ?? "";
  const passages = input.passages.filter(
    (passage) => passage.id && passage.text?.trim(),
  );
  const result: HandoffQuoteSanitationResult = {
    text,
    verifiedCount: 0,
    reattributedCount: 0,
    downgradedCount: 0,
  };
  if (!text.trim() || passages.length === 0) {
    return result;
  }

  const passageById = new Map(passages.map((passage) => [passage.id, passage]));
  const edits: QuoteEdit[] = [];
  const pattern = createQuotedSpanPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const quoteStart = match.index;
    const quoteEnd = match.index + match[0].length;
    const quote = match[1].replace(/\s+/g, " ").trim();
    if (!quote) continue;

    const window = attributionWindow(text, quoteStart, quoteEnd);
    const citedIds = collectPassageIdsFromText(window.text);
    const knownCitedIds = citedIds.filter((id) => passageById.has(id));
    const urlCandidateIds =
      knownCitedIds.length === 0
        ? passageIdsForUrlsInWindow(window.text, input.evidence, passageById)
        : [];
    const attributedIds = knownCitedIds.length > 0 ? knownCitedIds : urlCandidateIds;
    if (attributedIds.length === 0) {
      // No resolvable attribution: either an unadorned rhetorical quote, or a
      // citation of a passage the store never accepted — the latter is the
      // write-time fabricated_passage_id case, not a capture we can verify.
      continue;
    }

    const verbatimIn = attributedIds.find((id) =>
      quoteAppearsVerbatim(quote, passageById.get(id)?.text ?? ""),
    );
    if (verbatimIn) {
      result.verifiedCount += 1;
      continue;
    }

    // Prefer a sibling accepted passage of the source the researcher cited —
    // the live failure shape is a correct quote pinned to the wrong passage
    // range of the right source — before considering other sources' passages.
    const verbatimMatches = passages.filter((passage) =>
      quoteAppearsVerbatim(quote, passage.text),
    );
    const attributedSourceKeys = new Set(
      attributedIds.flatMap((id) => passageSourceKeys(passageById.get(id), id)),
    );
    const rehomed =
      verbatimMatches.find((passage) =>
        passageSourceKeys(passage, passage.id).some((key) =>
          attributedSourceKeys.has(key),
        ),
      ) ?? verbatimMatches[0];
    if (rehomed) {
      // The bytes are real but the attribution is wrong. Present the
      // passage's actual bytes (the model's transcription may still differ
      // cosmetically) and point the citation at the passage that has them.
      const rawOffset = findQuoteRawSpan(quote, rehomed.text);
      const trueBytes = rawOffset
        ? rehomed.text.slice(rawOffset.start, rawOffset.end)
        : quote;
      edits.push({
        start: quoteStart + 1,
        end: quoteEnd - 1,
        replacement: trueBytes,
      });
      const swap = singleCitedIdOccurrence(
        text,
        window,
        knownCitedIds,
        quoteStart,
        quoteEnd,
      );
      if (swap && swap.id !== rehomed.id) {
        edits.push({
          start: swap.start,
          end: swap.end,
          replacement: rehomed.id,
        });
      } else if (!swap) {
        edits.push({
          start: quoteEnd,
          end: quoteEnd,
          replacement: ` [${rehomed.id}]`,
        });
      }
      result.reattributedCount += 1;
      continue;
    }

    // Nowhere in the store: the span is the model's own prose. Strip the
    // quotation marks so nothing downstream can mistake it for quotable
    // bytes, and say so where the writer will read it.
    edits.push({
      start: quoteStart,
      end: quoteEnd,
      replacement: `${quote} ${PARAPHRASE_MARKER}`,
    });
    result.downgradedCount += 1;
  }

  result.text = applyEdits(text, edits);
  return result;
}

interface AttributionWindow {
  start: number;
  end: number;
  text: string;
}

/**
 * The span whose citations attribute a quote: the quote's own line, widened
 * to a bounded window when the line cites nothing (prose often cites on the
 * sentence after the quotation).
 */
function attributionWindow(
  text: string,
  quoteStart: number,
  quoteEnd: number,
): AttributionWindow {
  const lineStart = text.lastIndexOf("\n", quoteStart - 1) + 1;
  const lineEndIndex = text.indexOf("\n", quoteEnd);
  const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
  const line = text.slice(lineStart, lineEnd);
  if (collectPassageIdsFromText(line).length > 0) {
    return { start: lineStart, end: lineEnd, text: line };
  }
  const start = Math.max(0, quoteStart - ATTRIBUTION_WINDOW_CHARS);
  const end = Math.min(text.length, quoteEnd + ATTRIBUTION_WINDOW_CHARS);
  return { start, end, text: text.slice(start, end) };
}

/**
 * Keys identifying the source a passage was extracted from: its evidence id
 * and the `source:<hash>` prefix of a source-scoped passage id. Two passages
 * sharing either key are sibling windows over the same fetched source.
 */
function passageSourceKeys(
  passage: ClaimPassageRef | undefined,
  id: string,
): string[] {
  const keys: string[] = [];
  if (passage?.evidenceId) keys.push(`evidence:${passage.evidenceId}`);
  const prefix = /^(source:[a-z0-9]+):passage:/iu.exec(id)?.[1];
  if (prefix) keys.push(prefix.toLowerCase());
  return keys;
}

/** Passage ids attributed via a bare source URL appearing next to the quote. */
function passageIdsForUrlsInWindow(
  window: string,
  evidence: MissionEvidence[] | undefined,
  passageById: Map<string, ClaimPassageRef>,
): string[] {
  if (!evidence || evidence.length === 0) return [];
  const ids: string[] = [];
  for (const item of evidence) {
    const url = item.url?.trim();
    if (!url || !window.includes(url)) continue;
    for (const id of item.passageIds ?? []) {
      if (passageById.has(id) && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * When the window cites exactly one known passage id, locate its occurrence
 * (outside the quote itself) so the citation can be corrected in place. With
 * zero or several cited ids there is no unambiguous token to rewrite; the
 * caller appends the correct id after the quote instead.
 */
function singleCitedIdOccurrence(
  text: string,
  window: AttributionWindow,
  knownCitedIds: string[],
  quoteStart: number,
  quoteEnd: number,
): { id: string; start: number; end: number } | null {
  if (knownCitedIds.length !== 1) return null;
  const id = knownCitedIds[0];
  let searchFrom = window.start;
  while (searchFrom < window.end) {
    const index = text.indexOf(id, searchFrom);
    if (index < 0 || index >= window.end) return null;
    const end = index + id.length;
    // Token boundaries: never rewrite an occurrence embedded in a longer id
    // (e.g. the cited range as a prefix of a wider passage range).
    const boundedStart = index === 0 || !/[a-z0-9:._-]/iu.test(text[index - 1]);
    const boundedEnd = end >= text.length || !/[a-z0-9_-]/iu.test(text[end]);
    if (boundedStart && boundedEnd && (end <= quoteStart || index >= quoteEnd)) {
      return { id, start: index, end };
    }
    searchFrom = end;
  }
  return null;
}

function applyEdits(text: string, edits: QuoteEdit[]): string {
  if (edits.length === 0) return text;
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let output = text;
  for (const edit of ordered) {
    output =
      output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}
