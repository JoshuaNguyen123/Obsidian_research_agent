import type { MissionEvidence } from "./missionLedger";
import { getEvidencePassageIdentifiers } from "./missionPlan";

export const MAX_RESEARCH_CLAIMS = 40;

export type ResearchClaimStatus =
  | "ungrounded"
  | "grounded"
  | "exempt"
  | "invalid_citation";

export interface ClaimQuoteSpan {
  passageId: string;
  quote: string;
  startChar?: number;
  endChar?: number;
}

export interface ResearchClaim {
  id: string;
  text: string;
  status: ResearchClaimStatus;
  passageIds: string[];
  quoteSpans?: ClaimQuoteSpan[];
  subquestionId?: string;
  conflictIds?: string[];
}

export interface ClaimPassageRef {
  id: string;
  text: string;
  evidenceId?: string;
  subquestionId?: string;
}

export type ClaimLedgerStatus = "pass" | "fail" | "skipped" | "needs_more_work";

export interface ClaimLedger {
  version: 1;
  status: ClaimLedgerStatus;
  claims: ResearchClaim[];
  knownPassageIds: string[];
  missing: string[];
  reasons: string[];
  nextAction?: string;
  requireQuoteSpans: boolean;
}

export interface BuildClaimLedgerInput {
  draft: string;
  evidence?: MissionEvidence[];
  passages?: ClaimPassageRef[];
  /** Mission prompt, research mode, or route label used by shouldRequireClaimGrounding. */
  prompt?: string;
  mode?: string;
  requireQuoteSpans?: boolean;
  /** When true, run claim grounding even if prompt/mode heuristics would skip. */
  forceRequire?: boolean;
  maxClaims?: number;
}

const PASSAGE_ID_PATTERN =
  /\bsource:[a-z0-9]+:passage:\d+-\d+\b/gi;
/** Legacy/simple passage markers that are not nested inside source-scoped ids. */
const SIMPLE_PASSAGE_ID_PATTERN =
  /(?<!source:[a-z0-9]+:)\bpassage:[a-z0-9][a-z0-9:_-]*\b/gi;
const QUOTE_PATTERN = /[“"]([^”"]{8,400})[”"]/g;

const CLAIM_STOP_TERMS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "could",
  "from",
  "have",
  "into",
  "more",
  "most",
  "other",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "findings",
  "supported",
  "according",
  "source",
  "sources",
  "passage",
  "passages",
]);

/**
 * Claim-level grounding is required for explicit deep/cited/quote/verify research.
 * Ordinary chat answers, short URL-citation web summaries, and "current/latest"
 * market writebacks that only auto-activate deep_web stay skippable — those still
 * use fetched-source / URL citation acceptance, not passage-id claim ledgers.
 *
 * Passing a bare mode token (`deep_web`, `deep_vault`, `deep_hybrid`, `passage`)
 * still returns true for unit tests and forced ledger builds; AgentRunner must
 * gate on the user prompt, not researchPlan.mode alone.
 */
export function shouldRequireClaimGrounding(promptOrMode: string): boolean {
  const value = promptOrMode.replace(/\s+/g, " ").trim();
  if (!value) {
    return false;
  }
  if (/^(chat_answer|none|source)$/i.test(value)) {
    return false;
  }
  if (/^(deep_web|deep_vault|deep_hybrid|passage)$/i.test(value)) {
    return true;
  }
  if (
    /\b(?:summarize|summary|brief)\b/i.test(value) &&
    !/\b(?:cite|cited|citation|citations|passage|passages|quote|quoted|quotations|verify|fact[-\s]?check|deep\s+research|long[-\s]?running|exhaustive)\b/i.test(
      value,
    )
  ) {
    return false;
  }
  // "current online dating market" alone is not claim-ledger work.
  return /\b(?:cite|cited|citation|citations|passage|passages|quote|quoted|quotations|text[-\s]?level\s+quotation|verify|fact[-\s]?check|deep\s+research|long[-\s]?running\s+(?:research|co-?research)|long\s+research|exhaustive\s+(?:research|investigation))\b/i.test(
    value,
  );
}

export function shouldRequireQuoteSpans(promptOrMode: string): boolean {
  const value = promptOrMode.replace(/\s+/g, " ").trim();
  return /\b(?:quote|quoted|quotations?|text[-\s]?level\s+quotation)\b/i.test(
    value,
  );
}

export function extractClaimsFromDraft(
  draft: string,
  options: { maxClaims?: number } = {},
): ResearchClaim[] {
  const maxClaims = clampInteger(
    options.maxClaims ?? MAX_RESEARCH_CLAIMS,
    1,
    MAX_RESEARCH_CLAIMS,
  );
  const sentences = splitClaimSentences(draft);
  const claims: ResearchClaim[] = [];
  for (const text of sentences) {
    if (claims.length >= maxClaims) {
      break;
    }
    if (!isCandidateClaimSentence(text)) {
      continue;
    }
    claims.push({
      id: `claim:${claims.length + 1}`,
      text,
      status: isExemptLimitationSentence(text) ? "exempt" : "ungrounded",
      passageIds: [],
      conflictIds: [],
    });
  }
  return claims;
}

export function collectPassageIdsFromText(text: string): string[] {
  const ids = [
    ...matchAllIds(text, PASSAGE_ID_PATTERN),
    ...matchAllIds(text, SIMPLE_PASSAGE_ID_PATTERN),
  ];
  return dedupeStrings(ids);
}

export function bindClaimsToPassages(
  claims: ResearchClaim[],
  draft: string,
  passages: ClaimPassageRef[],
  options: { knownPassageIds?: string[] } = {},
): ResearchClaim[] {
  const known = new Set(
    (options.knownPassageIds ?? passages.map((passage) => passage.id)).filter(
      Boolean,
    ),
  );
  const passageById = new Map(passages.map((passage) => [passage.id, passage]));
  const draftCitedIds = collectPassageIdsFromText(draft);

  return claims.map((claim) => {
    if (claim.status === "exempt" || isExemptLimitationSentence(claim.text)) {
      return {
        ...claim,
        status: "exempt" as const,
        passageIds: [],
        quoteSpans: undefined,
      };
    }

    const citedInClaim = collectPassageIdsFromText(claim.text);
    const fabricated = citedInClaim.filter((id) => !known.has(id));
    if (fabricated.length > 0) {
      return {
        ...claim,
        status: "invalid_citation" as const,
        passageIds: fabricated,
        quoteSpans: extractQuoteSpans(claim.text, fabricated),
      };
    }

    const overlapIds = passages
      .filter((passage) => lexicalOverlapScore(claim.text, passage.text) >= 2)
      .map((passage) => passage.id);
    // Softer threshold when the draft already cites real passages: one shared
    // content term is enough to attach an uncited material sentence to those
    // windows instead of failing the whole answer.
    const softOverlapIds = passages
      .filter((passage) => lexicalOverlapScore(claim.text, passage.text) >= 1)
      .map((passage) => passage.id);

    const boundIds = dedupeStrings([
      ...citedInClaim.filter((id) => known.has(id)),
      // Soft bind only when the draft already cites real passages and the claim
      // lexically overlaps a known passage window. Uncited drafts stay
      // ungrounded so claim_grounding can fail closed.
      ...(citedInClaim.length === 0 &&
      draftCitedIds.some((id) => known.has(id))
        ? overlapIds.length > 0
          ? overlapIds
          : softOverlapIds
        : []),
    ]);

    const quoteSpans = extractQuoteSpans(
      claim.text,
      boundIds.length > 0 ? boundIds : citedInClaim,
    ).map((span) => {
      const passage = passageById.get(span.passageId);
      if (!passage) {
        return span;
      }
      const index = passage.text.indexOf(span.quote);
      if (index < 0) {
        return span;
      }
      return {
        ...span,
        startChar: index,
        endChar: index + span.quote.length,
      };
    });

    if (boundIds.length === 0) {
      return {
        ...claim,
        status: "ungrounded" as const,
        passageIds: [],
        ...(quoteSpans.length > 0 ? { quoteSpans } : {}),
      };
    }

    const hasOverlapWhenTextAvailable =
      boundIds.every((id) => {
        const passage = passageById.get(id);
        if (!passage?.text.trim()) {
          return true;
        }
        return lexicalOverlapScore(claim.text, passage.text) >= 1;
      });

    return {
      ...claim,
      status: hasOverlapWhenTextAvailable
        ? ("grounded" as const)
        : ("ungrounded" as const),
      passageIds: boundIds,
      ...(quoteSpans.length > 0 ? { quoteSpans } : {}),
      ...(passages.find((passage) => boundIds.includes(passage.id))
        ?.subquestionId
        ? {
            subquestionId: passages.find((passage) =>
              boundIds.includes(passage.id),
            )?.subquestionId,
          }
        : {}),
    };
  });
}

export function validateClaimGrounding(
  claims: ResearchClaim[],
  options: {
    knownPassageIds: string[];
    passages?: ClaimPassageRef[];
    requireQuoteSpans?: boolean;
    draft?: string;
  },
): {
  ok: boolean;
  status: Exclude<ClaimLedgerStatus, "skipped">;
  missing: string[];
  reasons: string[];
  nextAction?: string;
  claims: ResearchClaim[];
} {
  const known = new Set(options.knownPassageIds.filter(Boolean));
  const passageById = new Map(
    (options.passages ?? []).map((passage) => [passage.id, passage]),
  );
  const missing: string[] = [];
  const reasons: string[] = [];
  let validQuoteSpanCount = 0;
  let materialClaimCount = 0;
  const draftIds = options.draft
    ? collectPassageIdsFromText(options.draft)
    : [];
  const fabricatedInDraft = draftIds.filter((id) => !known.has(id));
  if (fabricatedInDraft.length > 0) {
    missing.push("claim_grounding:fabricated_passage_id");
    reasons.push("fabricated_passage_id");
  }

  for (const claim of claims) {
    if (claim.status === "exempt") {
      continue;
    }
    materialClaimCount += 1;
    if (claim.status === "invalid_citation") {
      missing.push(`claim_grounding:fabricated:${claim.id}`);
      reasons.push("fabricated_passage_id");
      continue;
    }
    if (claim.status !== "grounded" || claim.passageIds.length === 0) {
      missing.push(`claim_grounding:ungrounded:${claim.id}`);
      reasons.push("ungrounded_material_claim");
      continue;
    }
    const unknownBound = claim.passageIds.filter((id) => !known.has(id));
    if (unknownBound.length > 0) {
      missing.push(`claim_grounding:fabricated:${claim.id}`);
      reasons.push("fabricated_passage_id");
      continue;
    }
    if (options.requireQuoteSpans) {
      const spans = claim.quoteSpans ?? [];
      for (const span of spans) {
        const passage = passageById.get(span.passageId);
        if (!passage) {
          missing.push(`claim_grounding:quote_passage:${claim.id}`);
          reasons.push("quote_span_unknown_passage");
          continue;
        }
        if (!passage.text.includes(span.quote)) {
          missing.push(`claim_grounding:quote_mismatch:${claim.id}`);
          reasons.push("quote_span_not_in_passage");
        } else {
          validQuoteSpanCount += 1;
        }
      }
    }
  }

  if (
    options.requireQuoteSpans &&
    materialClaimCount > 0 &&
    validQuoteSpanCount === 0
  ) {
    missing.push("claim_grounding:missing_quote_span");
    reasons.push("missing_quote_span");
  }

  const uniqueMissing = dedupeStrings(missing);
  const uniqueReasons = dedupeStrings(reasons);
  const ok = uniqueMissing.length === 0;
  return {
    ok,
    status: ok ? "pass" : "needs_more_work",
    missing: uniqueMissing,
    reasons: uniqueReasons,
    nextAction: ok
      ? undefined
      : uniqueReasons.includes("fabricated_passage_id")
        ? "Cite only persisted passage ids from gathered evidence."
        : uniqueReasons.includes("missing_quote_span") ||
            uniqueReasons.includes("quote_span_not_in_passage")
          ? "Include a quote span that appears inside the cited passage text."
          : "Ground each material claim with a persisted passage citation.",
    claims,
  };
}

export function buildClaimLedger(input: BuildClaimLedgerInput): ClaimLedger {
  const prompt = input.prompt ?? "";
  const mode = input.mode ?? "";
  const requireGrounding =
    input.forceRequire === true ||
    shouldRequireClaimGrounding(prompt) ||
    shouldRequireClaimGrounding(mode);
  const requireQuoteSpans =
    input.requireQuoteSpans === true ||
    shouldRequireQuoteSpans(prompt) ||
    shouldRequireQuoteSpans(mode);

  if (!requireGrounding) {
    return {
      version: 1,
      status: "skipped",
      claims: [],
      knownPassageIds: [],
      missing: [],
      reasons: ["claim_grounding_not_required"],
      requireQuoteSpans: false,
    };
  }

  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const knownPassageIds = dedupeStrings([
    ...evidence.flatMap((item) => getEvidencePassageIdentifiers(item)),
    ...(input.passages ?? []).map((passage) => passage.id),
  ]);
  const passages = resolvePassageRefs(input.passages, evidence);
  const extracted = extractClaimsFromDraft(input.draft, {
    maxClaims: input.maxClaims,
  });
  const bound = bindClaimsToPassages(extracted, input.draft, passages, {
    knownPassageIds,
  });
  const validated = validateClaimGrounding(bound, {
    knownPassageIds,
    passages,
    requireQuoteSpans,
    draft: input.draft,
  });

  return {
    version: 1,
    status: validated.status,
    claims: validated.claims,
    knownPassageIds,
    missing: validated.missing,
    reasons: validated.reasons,
    ...(validated.nextAction ? { nextAction: validated.nextAction } : {}),
    requireQuoteSpans,
  };
}

export function serializeClaimLedger(ledger: ClaimLedger): Record<string, unknown> {
  return {
    version: 1,
    status: ledger.status,
    claims: ledger.claims.map(serializeClaim),
    knownPassageIds: [...ledger.knownPassageIds],
    missing: [...ledger.missing],
    reasons: [...ledger.reasons],
    ...(ledger.nextAction ? { nextAction: ledger.nextAction } : {}),
    requireQuoteSpans: ledger.requireQuoteSpans === true,
  };
}

export function normalizeClaimLedger(value: unknown): ClaimLedger | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = normalizeLedgerStatus(value.status);
  if (!status) {
    return null;
  }
  const claims = Array.isArray(value.claims)
    ? value.claims
        .map(normalizeClaim)
        .filter((claim): claim is ResearchClaim => claim !== null)
        .slice(0, MAX_RESEARCH_CLAIMS)
    : [];
  return {
    version: 1,
    status,
    claims,
    knownPassageIds: dedupeStrings(getStringArray(value.knownPassageIds)).slice(
      0,
      128,
    ),
    missing: dedupeStrings(getStringArray(value.missing)).slice(0, 64),
    reasons: dedupeStrings(getStringArray(value.reasons)).slice(0, 32),
    ...(typeof value.nextAction === "string" && value.nextAction.trim()
      ? { nextAction: value.nextAction.trim().slice(0, 300) }
      : {}),
    requireQuoteSpans: value.requireQuoteSpans === true,
  };
}

export function claimGroundingAcceptanceDelta(ledger: ClaimLedger): {
  missing: string[];
  reasons: string[];
  nextAction?: string;
} {
  if (ledger.status === "skipped" || ledger.status === "pass") {
    return { missing: [], reasons: [] };
  }
  return {
    missing: [...ledger.missing],
    reasons: [
      "claim_grounding_incomplete",
      ...ledger.reasons,
    ],
    ...(ledger.nextAction ? { nextAction: ledger.nextAction } : {}),
  };
}

function resolvePassageRefs(
  passages: ClaimPassageRef[] | undefined,
  evidence: MissionEvidence[],
): ClaimPassageRef[] {
  if (passages && passages.length > 0) {
    return passages
      .filter((passage) => passage.id && passage.text !== undefined)
      .map((passage) => ({
        id: passage.id,
        text: passage.text,
        ...(passage.evidenceId ? { evidenceId: passage.evidenceId } : {}),
        ...(passage.subquestionId
          ? { subquestionId: passage.subquestionId }
          : {}),
      }));
  }
  // Evidence summaries are a bounded fallback when dossier passage texts are absent.
  return evidence.flatMap((item) => {
    const ids = getEvidencePassageIdentifiers(item);
    return ids.map((id) => ({
      id,
      text: item.summary ?? "",
      evidenceId: item.id,
    }));
  });
}

function splitClaimSentences(draft: string): string[] {
  const normalized = draft.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const chunks = normalized
    .split(/\n+/)
    .flatMap((line) => {
      const cleaned = line.replace(/^\s*[-*•]\s+/, "").trim();
      if (!cleaned) {
        return [];
      }
      return cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9“"([])/);
    })
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return chunks;
}

function isCandidateClaimSentence(text: string): boolean {
  if (text.length < 24) {
    return false;
  }
  if (/^#{1,6}\s/.test(text)) {
    return false;
  }
  if (/^(sources?|references?|citations?)\s*:?\s*$/i.test(text)) {
    return false;
  }
  // Pure citation / URL lines are not material claims.
  if (
    collectPassageIdsFromText(text).length > 0 &&
    tokenize(stripCitations(text)).length < 3
  ) {
    return false;
  }
  return tokenize(stripCitations(text)).length >= 3;
}

function isExemptLimitationSentence(text: string): boolean {
  return /\b(?:limitations?|confidence|uncertain(?:ty)?|may\s+vary|further\s+research(?:\s+is\s+needed)?|cannot\s+be\s+certain|with\s+(?:low|limited)\s+confidence|this\s+(?:summary|answer)\s+is\s+incomplete|evidence\s+is\s+(?:limited|incomplete|mixed))\b/i.test(
    text,
  );
}

function extractQuoteSpans(
  claimText: string,
  passageIds: string[],
): ClaimQuoteSpan[] {
  if (passageIds.length === 0) {
    return [];
  }
  const quotes: string[] = [];
  QUOTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_PATTERN.exec(claimText)) !== null) {
    const quote = match[1]?.replace(/\s+/g, " ").trim();
    if (quote) {
      quotes.push(quote);
    }
  }
  if (quotes.length === 0) {
    return [];
  }
  const primaryPassage = passageIds[0];
  return quotes.slice(0, 3).map((quote) => ({
    passageId: primaryPassage,
    quote,
  }));
}

function lexicalOverlapScore(left: string, right: string): number {
  const leftTerms = new Set(tokenize(stripCitations(left)));
  const rightTerms = new Set(tokenize(right));
  let score = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(
      (term) =>
        term.length >= 4 &&
        !CLAIM_STOP_TERMS.has(term) &&
        !/^\d+$/.test(term),
    );
}

function stripCitations(text: string): string {
  return text
    .replace(PASSAGE_ID_PATTERN, " ")
    .replace(SIMPLE_PASSAGE_ID_PATTERN, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\[\]()]/g, " ");
}

function matchAllIds(text: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[0]);
  }
  return ids;
}

function serializeClaim(claim: ResearchClaim): Record<string, unknown> {
  return {
    id: claim.id,
    text: claim.text,
    status: claim.status,
    passageIds: [...claim.passageIds],
    ...(claim.quoteSpans && claim.quoteSpans.length > 0
      ? {
          quoteSpans: claim.quoteSpans.map((span) => ({
            passageId: span.passageId,
            quote: span.quote,
            ...(span.startChar !== undefined
              ? { startChar: span.startChar }
              : {}),
            ...(span.endChar !== undefined ? { endChar: span.endChar } : {}),
          })),
        }
      : {}),
    ...(claim.subquestionId ? { subquestionId: claim.subquestionId } : {}),
    ...(claim.conflictIds && claim.conflictIds.length > 0
      ? { conflictIds: [...claim.conflictIds] }
      : {}),
  };
}

function normalizeClaim(value: unknown): ResearchClaim | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const text = getString(value.text);
  const status = normalizeClaimStatus(value.status);
  if (!id || !text || !status) {
    return null;
  }
  const passageIds = dedupeStrings(getStringArray(value.passageIds)).slice(0, 12);
  const quoteSpans = Array.isArray(value.quoteSpans)
    ? value.quoteSpans
        .map((span) => {
          if (!isRecord(span)) {
            return null;
          }
          const passageId = getString(span.passageId);
          const quote = getString(span.quote);
          if (!passageId || !quote) {
            return null;
          }
          return {
            passageId,
            quote: quote.slice(0, 400),
            ...(typeof span.startChar === "number"
              ? { startChar: Math.max(0, Math.trunc(span.startChar)) }
              : {}),
            ...(typeof span.endChar === "number"
              ? { endChar: Math.max(0, Math.trunc(span.endChar)) }
              : {}),
          } satisfies ClaimQuoteSpan;
        })
        .filter((span): span is ClaimQuoteSpan => span !== null)
        .slice(0, 6)
    : [];
  const conflictIds = dedupeStrings(getStringArray(value.conflictIds)).slice(
    0,
    12,
  );
  const subquestionId = getString(value.subquestionId);
  return {
    id: id.slice(0, 64),
    text: text.slice(0, 800),
    status,
    passageIds,
    ...(quoteSpans.length > 0 ? { quoteSpans } : {}),
    ...(subquestionId ? { subquestionId: subquestionId.slice(0, 64) } : {}),
    ...(conflictIds.length > 0 ? { conflictIds } : {}),
  };
}

function normalizeClaimStatus(value: unknown): ResearchClaimStatus | null {
  return value === "ungrounded" ||
    value === "grounded" ||
    value === "exempt" ||
    value === "invalid_citation"
    ? value
    : null;
}

function normalizeLedgerStatus(value: unknown): ClaimLedgerStatus | null {
  return value === "pass" ||
    value === "fail" ||
    value === "skipped" ||
    value === "needs_more_work"
    ? value
    : null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
