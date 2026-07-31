import type { MissionEvidence } from "./missionLedger";
import type { ClaimLedger } from "./claimLedger";
import type { ResearchPlan } from "./researchPlan";
import {
  countMarkdownSections,
  type ResearchDepthInput,
} from "./researchDepthMetrics";

/**
 * Assemble the `research` block for `scoreMissionV1` from what the mission
 * loop already tracks.
 *
 * The `source_independence` and `research_depth` scorecard dimensions shipped
 * wired into the formula but with no production caller supplying their inputs,
 * so both scored a permanent vacuous 1.0 — the exact "thin research summary"
 * regression they exist to catch stayed invisible. This module closes that
 * loop; it must be in place before any baseline record is harvested, or the
 * baselines encode the vacuous scores and the (expensive) real-AI rebaseline
 * has to be bought twice.
 *
 * Returns `undefined` for missions with no web-bearing research plan: a code
 * or chat mission has nothing to be "thin" about, and the scorecard's
 * empty-set convention (absent block → both dimensions 1.0) is the correct
 * verdict there, by design rather than by accident.
 *
 * Pure and Obsidian-free, per the policy-module convention, so a live run and
 * a replayed durable ledger produce identical signals.
 */

const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface BuildMissionResearchSignalsInput {
  researchPlan: Pick<ResearchPlan, "mode" | "sourceRequirements"> | null | undefined;
  evidence: readonly MissionEvidence[];
  claimLedger: Pick<ClaimLedger, "claims"> | null | undefined;
  finalOutput: string;
}

export function buildMissionResearchSignalsV1(
  input: BuildMissionResearchSignalsInput,
): ResearchDepthInput | undefined {
  const plan = input.researchPlan;
  if (!plan || plan.mode === "none") return undefined;
  const requiredSources = plan.sourceRequirements?.minFetchedSources ?? 0;
  if (requiredSources <= 0) return undefined;

  // Usable, content-hash-distinct source URLs — the same mirror-collapsing
  // rule the acceptance stats apply, so the scorecard and the gate agree on
  // what counts as an independent source. Evidence without a verifiable hash
  // keeps its own URL identity: absence of proof of duplication is not proof
  // of duplication.
  const seenHashes = new Set<string>();
  const seenUrls = new Set<string>();
  const usableSourceUrls: string[] = [];
  for (const item of input.evidence) {
    if (item.kind !== "web_source" || item.usableSource !== true) continue;
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url || seenUrls.has(url)) continue;
    const hash =
      typeof item.contentHash === "string" &&
      CONTENT_HASH_PATTERN.test(item.contentHash)
        ? item.contentHash
        : null;
    if (hash) {
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
    }
    seenUrls.add(url);
    usableSourceUrls.push(url);
  }

  const claims = input.claimLedger?.claims ?? [];
  const materialClaims = claims.filter((claim) => claim.status !== "exempt");
  const citedPassageIds = new Set<string>();
  let quotedSpanCount = 0;
  for (const claim of claims) {
    for (const passageId of claim.passageIds ?? []) {
      if (passageId) citedPassageIds.add(passageId);
    }
    quotedSpanCount += claim.quoteSpans?.length ?? 0;
  }

  return {
    usableSourceUrls,
    requiredDistinctDomains: Math.max(
      0,
      plan.sourceRequirements?.minDistinctDomains ?? 0,
    ),
    claimsRequiringEvidence: materialClaims.length,
    citedPassageCount: citedPassageIds.size,
    quotedSpanCount,
    sectionCount: countMarkdownSections(input.finalOutput),
  };
}
