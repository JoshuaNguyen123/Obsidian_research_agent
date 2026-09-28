import type { ClaimLedger, ClaimPassageRef, ResearchClaim } from "../agent/claimLedger";
import { fingerprintCanonicalJson } from "../agent/queue/fingerprint";
import type { DecisionRuntimeV1 } from "./decisionRuntime";
import type { DecisionModelModeV1 } from "./decisionSettings";
import {
  assessClaimSupportV1,
  claimFingerprintV1,
  claimSupportBlockerV1,
  claimSupportMissingTokensV1,
  confidentClaimFailuresV1,
  emptyClaimSupportLedgerV1,
  holdClaimSupportCandidateV1,
  recordClaimSupportAssessmentV1,
  standingRejectionsV1,
  type ClaimSupportAssessmentV1,
  type ClaimSupportLedgerV1,
  type ClaimSupportRejectionV1,
} from "./claimSupportAssessment";

/**
 * The decision half of the staged-draft claim check, kept out of the runner so
 * it can be tested directly. The runner owns staging, repair, streaming and
 * commit; this decides, for one staged candidate that already passed the
 * deterministic citation and quote checks, whether to accept it, spend the one
 * Jev-triggered repair on specific claims, or hold it.
 */

/**
 * The ledger's claims that belong to this exact candidate: their recorded
 * offsets still slice it to the same words. A ledger from another draft (or a
 * resumed one, whose offsets are never persisted) contributes nothing.
 */
export function claimsForCandidateV1(
  ledger: ClaimLedger | null,
  candidate: string,
): ResearchClaim[] {
  if (!ledger) return [];
  return ledger.claims.filter(
    (claim) =>
      typeof claim.draftStart === "number" &&
      typeof claim.draftEnd === "number" &&
      claim.draftStart >= 0 &&
      claim.draftEnd <= candidate.length &&
      claim.draftEnd > claim.draftStart &&
      candidate.slice(claim.draftStart, claim.draftEnd).replace(/\s+/gu, " ").trim() === claim.text,
  );
}

export type StagedClaimSupportOutcomeV1 =
  | {
      action: "accept";
      ledger: ClaimSupportLedgerV1;
      assessment: ClaimSupportAssessmentV1 | null;
      /** Why the candidate may proceed, for Run Details. */
      reason: "supported" | "not_applicable" | "unavailable" | "unassessed";
    }
  | {
      action: "repair";
      ledger: ClaimSupportLedgerV1;
      assessment: ClaimSupportAssessmentV1 | null;
      /** Claim-scoped acceptance tokens (`claim_support:<verdict>:<claimId>`). */
      tokens: string[];
      rejections: ClaimSupportRejectionV1[];
    }
  | {
      action: "hold";
      ledger: ClaimSupportLedgerV1;
      assessment: ClaimSupportAssessmentV1 | null;
      blocker: string;
      rejections: ClaimSupportRejectionV1[];
    };

/**
 * Enabled only. Ask about the candidate's grounded claims, record the answer,
 * and decide. A failure is a confident finding from this check or a standing
 * rejection of the same claim words bound to the same passages — so an outage
 * after a recorded rejection can never clear it, while an outage with nothing
 * on record leaves the existing verification authoritative (recorded as a
 * skipped check). Throws only an AbortError.
 */
export async function evaluateStagedClaimSupportV1(input: {
  runtime: DecisionRuntimeV1;
  ledger: ClaimSupportLedgerV1 | null;
  candidate: string;
  claimLedger: ClaimLedger | null;
  passages: readonly ClaimPassageRef[];
  /** False once the one Jev repair is spent or the correction budget refuses. */
  repairAvailable: boolean;
  abortSignal?: AbortSignal;
  now: () => Date;
}): Promise<StagedClaimSupportOutcomeV1> {
  let ledger = input.ledger ?? emptyClaimSupportLedgerV1("enabled");
  if (ledger.mode !== "enabled") ledger = { ...ledger, mode: "enabled" };
  const claims = claimsForCandidateV1(input.claimLedger, input.candidate);
  const assessment = await assessClaimSupportV1({
    runtime: input.runtime,
    candidateText: input.candidate,
    claims,
    passages: input.passages,
    abortSignal: input.abortSignal,
  });
  if (assessment.status !== "not_applicable") {
    ledger = recordClaimSupportAssessmentV1(ledger, assessment, claims, input.now());
  }
  const rejections = standingRejectionsV1(ledger, claims);
  if (rejections.length === 0) {
    return {
      action: "accept",
      ledger,
      assessment,
      reason:
        assessment.status === "not_applicable"
          ? "not_applicable"
          : assessment.status === "unavailable"
            ? "unavailable"
            : assessment.coverage.wholeDraft
              ? "supported"
              : "unassessed",
    };
  }
  const tokens = claimSupportMissingTokensV1(
    rejections.map((rejection) => ({
      claimId:
        // A standing rejection names the claim by its words; the current
        // candidate's id for those words is what a repair must address.
        claims.find(
          (claim) =>
            claim.passageIds.length > 0 &&
            claimFingerprintV1(claim.text, claim.passageIds) === rejection.claimFingerprint,
        )?.id ?? rejection.claimId,
      passageIds: rejection.passageIds,
      status: "decided",
      verdict: rejection.verdict,
      proposed: rejection.verdict,
      probabilities: null,
    })),
  );
  if (input.repairAvailable) {
    return { action: "repair", ledger, assessment, tokens, rejections };
  }
  const held = holdForClaimSupportRejectionsV1({
    ledger,
    candidate: input.candidate,
    rejections,
    now: input.now,
  });
  return { action: "hold", ledger: held.ledger, assessment, blocker: held.blocker, rejections };
}

/**
 * Hold a candidate for the rejections it still carries: the draft itself is
 * kept (bounded) in the run record with the blocker the user is shown, so
 * Run Details and a Continue can see exactly what was held and why.
 */
export function holdForClaimSupportRejectionsV1(input: {
  ledger: ClaimSupportLedgerV1;
  candidate: string;
  rejections: readonly ClaimSupportRejectionV1[];
  now: () => Date;
}): { ledger: ClaimSupportLedgerV1; blocker: string } {
  const blocker = claimSupportBlockerV1(input.rejections);
  return {
    ledger: holdClaimSupportCandidateV1(input.ledger, {
      candidateText: input.candidate,
      candidateFingerprint: fingerprintCanonicalJson({ candidate: input.candidate }),
      blocker,
      now: input.now(),
    }),
    blocker,
  };
}

/**
 * Standing rejections a candidate still carries, with no new question asked.
 * Used where a draft ships without passing the claim check (degraded
 * delivery), so a recorded rejection is never shipped as a caveat.
 */
export function standingClaimSupportHoldV1(input: {
  ledger: ClaimSupportLedgerV1 | null;
  candidate: string;
  claimLedger: ClaimLedger | null;
}): ClaimSupportRejectionV1[] {
  if (!input.ledger || input.ledger.mode !== "enabled") return [];
  return standingRejectionsV1(input.ledger, claimsForCandidateV1(input.claimLedger, input.candidate));
}

/**
 * Shadow: ask and record what Enabled would have done, change nothing. Never
 * throws — an abort or outage is simply not recorded as a finding.
 */
export async function shadowStagedClaimSupportV1(input: {
  runtime: DecisionRuntimeV1;
  ledger: ClaimSupportLedgerV1 | null;
  candidate: string;
  claimLedger: ClaimLedger | null;
  passages: readonly ClaimPassageRef[];
  abortSignal?: AbortSignal;
  now: () => Date;
}): Promise<{ ledger: ClaimSupportLedgerV1; assessment: ClaimSupportAssessmentV1 } | null> {
  try {
    const claims = claimsForCandidateV1(input.claimLedger, input.candidate);
    const assessment = await assessClaimSupportV1({
      runtime: input.runtime,
      candidateText: input.candidate,
      claims,
      passages: input.passages,
      abortSignal: input.abortSignal,
    });
    if (assessment.status === "not_applicable") return null;
    const base = input.ledger ?? emptyClaimSupportLedgerV1("shadow");
    return {
      ledger: recordClaimSupportAssessmentV1(
        base.mode === "enabled" ? base : { ...base, mode: "shadow" },
        assessment,
        claims,
        input.now(),
      ),
      assessment,
    };
  } catch {
    return null;
  }
}

/** One line for traces and Run Details: coverage first, then what it found. */
export function describeClaimSupportAssessmentV1(
  assessment: ClaimSupportAssessmentV1,
  mode: DecisionModelModeV1,
): string {
  const prefix = mode === "enabled" ? "Jev claim check" : "Jev claim check (shadow, writeback unchanged)";
  if (assessment.status === "not_applicable") {
    return `${prefix}: no grounded, passage-bound claims to check.`;
  }
  if (assessment.status === "unavailable") {
    return `${prefix}: unavailable (${assessment.fallbackReason ?? "no answer"}); the existing verification decides.`;
  }
  const failures = confidentClaimFailuresV1(assessment);
  const contradicted = failures.filter((finding) => finding.verdict === "contradicted").length;
  const insufficient = failures.length - contradicted;
  const { eligible, decided, excluded, unassessed } = assessment.coverage;
  const coverage =
    decided === eligible
      ? `all ${eligible} claim${eligible === 1 ? "" : "s"} decided`
      : `${decided} of ${eligible} claims decided (${unassessed} unassessed${excluded > 0 ? `, ${excluded} of them not sent: ${exclusionSummary(assessment)}` : ""})`;
  const found =
    failures.length === 0
      ? "none contradicted or unsupported"
      : [
          contradicted > 0 ? `${contradicted} contradicted` : "",
          insufficient > 0 ? `${insufficient} unsupported` : "",
        ]
          .filter(Boolean)
          .join(", ");
  return `${prefix}: ${coverage}; ${found}.`;
}

const EXCLUSION_WORDS: Record<string, string> = {
  over_claim_cap: "over the 24-claim cap",
  claim_too_long: "claim too long",
  passage_too_long: "passage too long",
  too_many_passages: "too many passages",
  no_passage_text: "passage text unavailable",
  batch_too_large: "too large to send",
};

function exclusionSummary(assessment: ClaimSupportAssessmentV1): string {
  const counts = new Map<string, number>();
  for (const finding of assessment.findings) {
    if (finding.status !== "excluded" || !finding.exclusion) continue;
    counts.set(finding.exclusion, (counts.get(finding.exclusion) ?? 0) + 1);
  }
  return [...counts]
    .map(([reason, count]) => `${count} ${EXCLUSION_WORDS[reason] ?? reason}`)
    .join(", ");
}
