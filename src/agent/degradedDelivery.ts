/**
 * Ship the verified subset, marked, instead of shipping nothing.
 *
 * When verification could not be completed within its correction budget, both
 * delivery sites used to discard the draft and emit a blocker message in its
 * place. That is honest, and for an authority or approval failure it is the
 * only safe answer. But for the failures that are purely "a claim could not be
 * matched to a source passage", throwing away the work is a worse answer than
 * handing it over with the gap named: the reader can act on eight verified
 * findings plus two flagged ones, and can act on nothing at all.
 *
 * The rules this module enforces, in order of how much they matter:
 *
 *  1. A mission that forbids note mutation ("do not write or edit any note",
 *     chat-only answers, exact-cache verification follow-ups) is never
 *     eligible for degraded vault delivery. A marked provisional draft is
 *     still a vault write, and the mission said no vault writes — the proof
 *     taxonomy below never gets a vote. (This closed the DU-02 hole, where a
 *     cache follow-up that said "do not write or edit any note" had its note
 *     replaced by a provisional verification draft.)
 *  2. A quotation that failed verbatim verification is never delivered. It is
 *     removed, exactly as the existing finalization repairs remove it. A
 *     fabricated quote with a caveat attached is still a fabricated quote.
 *  3. A non-quote claim that no passage supports is delivered with an inline
 *     marker, so a reader skimming the body cannot mistake it for verified.
 *  4. The note carries a `## Verification status` section stating what was and
 *     was not confirmed, and naming the outstanding proofs.
 *  5. Anything outside those two failure families — authority, approval,
 *     receipts, structural contract gaps — still fails closed, unchanged.
 *
 * A degraded delivery is a real delivery to the user and NOT a green run. The
 * caller records it as degraded so the eval record cannot mistake "shipped
 * with caveats" for "shipped verified".
 */

import type { ClaimLedger } from "./claimLedger";
import type { EvidenceConflict } from "./evidenceConflicts";

/**
 * Deliberately verbose. A short marker like `[?]` survives a copy-paste out of
 * the vault as noise; this one still says what it means wherever it lands.
 */
export const UNVERIFIED_CLAIM_MARKER_V1 =
  "[unverified — no cited source passage confirms this]";

export const DEGRADED_VERIFICATION_HEADING_V1 = "## Verification status";

export interface DegradedDeliveryDecisionV1 {
  eligible: boolean;
  /** Missing proofs a marked delivery can honestly discharge. */
  markable: string[];
  /** Missing proofs that must still fail closed. */
  blocking: string[];
  reason: string;
}

/**
 * Mission-level constraints the delivery seats know and the proof list does
 * not. `candidateAcceptance.missing` describes what verification could not
 * confirm; it says nothing about what the user told the agent it may touch.
 */
export interface DegradedDeliveryMissionContextV1 {
  /**
   * True when the mission explicitly forbids mutating notes — "do not write
   * or edit any note", chat-only answers, exact-cache verification
   * follow-ups (`hasExplicitNoNoteWriteIntent` in `noNoteWriteIntent.ts` is
   * the shared detector). When set, the decision is ineligible regardless of
   * which proofs are missing: a marked draft is still a write.
   */
  missionForbidsNoteMutation?: boolean;
}

export interface DegradedDeliveryResultV1 {
  content: string;
  markedClaimIds: string[];
  removedQuoteClaimIds: string[];
  verifiedClaimCount: number;
}

/**
 * True for the proof families a marked delivery can carry: a claim that no
 * passage grounds, and sources that genuinely disagree. Everything else —
 * citation coverage contracts, missing sections, verifier relevance, and every
 * authority or receipt proof — keeps the fail-closed path.
 */
export function isMarkableUnverifiedProofV1(item: string): boolean {
  return (
    item.includes("claim_grounding") || item.includes("open_evidence_conflicts")
  );
}

export function decideDegradedDeliveryV1(
  missing: string[],
  mission?: DegradedDeliveryMissionContextV1,
): DegradedDeliveryDecisionV1 {
  const markable = missing.filter(isMarkableUnverifiedProofV1);
  const blocking = missing.filter((item) => !isMarkableUnverifiedProofV1(item));
  // Mission authority outranks the proof taxonomy: this guard runs before any
  // family sorting so no combination of "benign" missing proofs can make a
  // forbidden write eligible. markable/blocking stay populated for Run
  // Details; they explain what verification found, not what may ship.
  if (mission?.missionForbidsNoteMutation) {
    return {
      eligible: false,
      markable,
      blocking,
      reason:
        "The mission forbids writing or editing notes, so no provisional draft may be delivered to the vault; the existing note stays unchanged.",
    };
  }
  if (missing.length === 0) {
    return {
      eligible: false,
      markable,
      blocking,
      reason: "Nothing is missing; this is not a degraded delivery.",
    };
  }
  if (blocking.length > 0) {
    return {
      eligible: false,
      markable,
      blocking,
      reason: `Proofs outside the markable families remain unmet: ${blocking.join(", ")}.`,
    };
  }
  return {
    eligible: true,
    markable,
    blocking,
    reason:
      "Every outstanding proof is an unverified claim or an open source disagreement, both of which can be delivered marked.",
  };
}

/**
 * Build the degraded artifact: quotes that failed verification removed,
 * unsupported claims marked, and a verification-status section appended.
 */
export function buildDegradedDeliveryV1(input: {
  content: string;
  missing: string[];
  ledger?: ClaimLedger | null;
  conflictSummaries?: string[];
}): DegradedDeliveryResultV1 {
  const ledger = input.ledger ?? null;
  const claims = ledger?.claims ?? [];
  const quoteFailedClaimIds = new Set(
    (ledger?.quoteCorrections ?? []).map((correction) => correction.claimId),
  );

  let content = input.content;
  const removedQuoteClaimIds: string[] = [];
  const markedClaimIds: string[] = [];

  // Rule 1: an unverifiable quotation leaves entirely. Only a claim whose text
  // appears exactly once is touched — the same discipline the existing
  // ungrounded-claim pruning uses, because an ambiguous match would cut a
  // sentence the verifier never complained about.
  for (const claim of claims) {
    if (!quoteFailedClaimIds.has(claim.id)) continue;
    const located = locateUniqueClaim(content, claim.text);
    if (!located) continue;
    content =
      content.slice(0, located.start) + content.slice(located.end);
    removedQuoteClaimIds.push(claim.id);
  }

  // Rule 2: everything else unsupported stays, wearing a marker.
  //
  // `invalid_citation` is marked alongside `ungrounded`. It means the claim
  // cites a passage that does not exist, which to a reader is indistinguishable
  // from a fabricated citation — leaving it bare would ship the one shape of
  // claim most likely to be trusted on sight.
  for (const claim of claims) {
    if (claim.status !== "ungrounded" && claim.status !== "invalid_citation") {
      continue;
    }
    if (quoteFailedClaimIds.has(claim.id)) continue;
    const located = locateUniqueClaim(content, claim.text);
    if (!located) continue;
    content =
      content.slice(0, located.end) +
      ` ${UNVERIFIED_CLAIM_MARKER_V1}` +
      content.slice(located.end);
    markedClaimIds.push(claim.id);
  }

  if (removedQuoteClaimIds.length > 0) {
    content = tidyAfterRemoval(content);
  }

  const verifiedClaimCount = claims.filter(
    (claim) => claim.status === "grounded" || claim.status === "exempt",
  ).length;

  return {
    content: `${content.trimEnd()}\n\n${buildDegradedVerificationSectionV1({
      missing: input.missing,
      markedClaimCount: markedClaimIds.length,
      removedQuoteCount: removedQuoteClaimIds.length,
      verifiedClaimCount,
      conflictSummaries: input.conflictSummaries ?? [],
    })}\n`,
    markedClaimIds,
    removedQuoteClaimIds,
    verifiedClaimCount,
  };
}

/**
 * The status section. Its wording is load-bearing for open conflicts: the
 * heading and the phrase "sources disagree" are what
 * `projectEvidenceConflictAcknowledgements` requires before it will treat a
 * contradiction as an acknowledged limitation rather than an unmet proof.
 */
export function buildDegradedVerificationSectionV1(input: {
  missing: string[];
  markedClaimCount: number;
  removedQuoteCount: number;
  verifiedClaimCount: number;
  conflictSummaries?: string[];
}): string {
  const lines = [
    DEGRADED_VERIFICATION_HEADING_V1,
    "",
    "This note was delivered before verification finished, so treat it as provisional.",
  ];

  if (input.verifiedClaimCount > 0) {
    lines.push(
      `Confirmed against a cited source passage: ${input.verifiedClaimCount} claim(s).`,
    );
  }
  if (input.markedClaimCount > 0) {
    lines.push(
      `Not confirmed: ${input.markedClaimCount} claim(s), each marked inline with "${UNVERIFIED_CLAIM_MARKER_V1}".`,
    );
  }
  if (input.removedQuoteCount > 0) {
    lines.push(
      `Removed: ${input.removedQuoteCount} quotation(s) that could not be matched verbatim to the source they cited. Unverified quotations are never delivered.`,
    );
  }
  const conflicts = input.conflictSummaries ?? [];
  if (
    conflicts.length > 0 ||
    input.missing.some((item) => item.includes("open_evidence_conflicts"))
  ) {
    // The subheading is load-bearing, not decoration. `projectEvidence-
    // ConflictAcknowledgements` recognizes a limitation only under a heading
    // it knows ("limitations", "source disagreements", …); under the parent
    // "Verification status" alone, this note would ship while the conflict
    // still counted as an unmet proof — delivered and unacknowledged at once.
    lines.push("", "### Source disagreements", "");
    lines.push(
      "Sources disagree on part of this material, and the disagreement is unresolved:",
    );
    for (const summary of conflicts.length > 0 ? conflicts : ["see the cited passages"]) {
      lines.push(`- ${summary}`);
    }
  }
  if (input.missing.length > 0) {
    lines.push("", `Outstanding proofs: ${input.missing.join(", ")}.`);
  }

  return lines.join("\n");
}

/**
 * One line per unresolved disagreement, naming the passages that disagree so a
 * reader can go look rather than take the banner's word for it.
 */
export function summarizeOpenEvidenceConflictsV1(
  conflicts: EvidenceConflict[] | null | undefined,
): string[] {
  return (conflicts ?? [])
    .filter((conflict) => conflict.status === "open")
    .map((conflict) =>
      conflict.passageIds.length > 0
        ? `${conflict.id}: passages ${conflict.passageIds.join(" vs ")}`
        : conflict.id,
    );
}

function locateUniqueClaim(
  content: string,
  claimText: string,
): { start: number; end: number } | null {
  const text = claimText.trim();
  if (!text) return null;
  const start = content.indexOf(text);
  if (start < 0) return null;
  if (content.indexOf(text, start + text.length) >= 0) return null;
  return { start, end: start + text.length };
}

function tidyAfterRemoval(content: string): string {
  return content
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]*(?=\r?$)/gmu, "")
    .replace(/[ \t]+(?=\r?$)/gmu, "")
    .replace(/\n[ \t]+\n/gu, "\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
