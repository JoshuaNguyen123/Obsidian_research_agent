/**
 * Graded mission scoring (G4).
 *
 * Agent quality is currently a single bit. The 260 unit test files assert
 * binary conditions, and `dailyUseRunMetrics.ts` — the closest thing to a
 * quality metric — reduces a whole run to
 * `acceptanceStatus: "pass" | "needs_more_work"`. `scripts/` has no eval
 * runner; the semantic-eval cache scores chunking, not missions.
 *
 * The consequence: a change that makes the agent *worse but still passing* is
 * undetectable. A run that satisfies acceptance while burning three times the
 * model calls, citing half the evidence, and recovering from four failures
 * looks identical to a clean first-try success.
 *
 * Everything a scorecard needs is already recorded. The mission ledger carries
 * acceptance criteria and what was missing, evidence entries with confidence,
 * receipts, and `providerUsage` (the write-only `ModelUsageAggregateV1`). This
 * module reads that data and produces graded dimensions plus a weighted total,
 * so two runs can be compared instead of merely passed or failed.
 *
 * It composes with `evaluateDailyUseAcceptanceV1` rather than replacing it:
 * acceptance stays the gate, the scorecard becomes the gradient. A scorecard
 * must never be able to turn a failed acceptance into a pass, which is why
 * `acceptancePassed` is carried through untouched and reported alongside.
 *
 * Pure and I/O-free, so it scores a live e2e run and a replayed durable ledger
 * identically — which is what makes a regression corpus possible later.
 *
 * ## Runtime and regression integration
 *
 * 1. At acceptance `AgentRunner` builds a `MissionScorecardInput` from the
 *    mission ledger and emits `onMissionScorecard`.
 * 2. `RunCoordinator` retains the latest scorecard; the daily-use fixture
 *    attaches it to the reporter record.
 * 3. Deterministic E2E wrappers compare those records with the checked-in
 *    baseline and fail only beyond the declared tolerance. Live/provider
 *    projects are intentionally not baselined.
 */

import {
  scoreResearchDepth,
  scoreSourceIndependence,
  type ResearchDepthInput,
} from "./researchDepthMetrics";
import { registrableDomain } from "./sourceSignals";

export type MissionScoreDimensionId =
  | "acceptance_coverage"
  | "evidence_grounding"
  | "receipt_coverage"
  | "recovery_cleanliness"
  | "source_independence"
  | "research_depth"
  | "model_call_efficiency"
  | "wall_clock_efficiency";

/**
 * Weights sum to 1. Acceptance and grounding dominate deliberately: this is a
 * research agent, so "did it do the job, with sources" must outrank "was it
 * cheap". Efficiency dimensions exist to make waste visible, not to reward
 * cutting the work short.
 *
 * The efficiency pair was cut from 0.10 to 0.05 each to fund the two research
 * dimensions. They had earned the reduction: across the baselined runs they sat
 * at 10/80, 6/47 and 11/56 model calls, and 94s/5400s, 70s/840s and 99s/2100s
 * wall clock — 5x to 57x headroom, meaning they scored a constant 1.0 and
 * carried 20% of the total while detecting nothing. `source_independence` and
 * `research_depth` measure the failure the changelog actually names (thin,
 * narrowly-sourced summaries) and vary with it.
 */
export const MISSION_SCORE_WEIGHTS: Readonly<
  Record<MissionScoreDimensionId, number>
> = {
  acceptance_coverage: 0.3,
  evidence_grounding: 0.25,
  receipt_coverage: 0.15,
  recovery_cleanliness: 0.1,
  source_independence: 0.05,
  research_depth: 0.05,
  model_call_efficiency: 0.05,
  wall_clock_efficiency: 0.05,
};

export interface MissionScorecardInput {
  /** Acceptance criteria the mission declared. */
  acceptanceCriteriaTotal: number;
  /** Criteria still unmet at completion (`acceptance.missing.length`). */
  acceptanceCriteriaMissing: number;
  /** Whether acceptance itself passed. Carried through, never recomputed. */
  acceptancePassed: boolean;
  /** Claims the final answer made that require support. */
  claimsRequiringEvidence: number;
  /** Claims actually backed by a ledger evidence entry or passage citation. */
  claimsWithEvidence: number;
  /** Mutations performed during the run. */
  mutationsPerformed: number;
  /** Mutations that returned a validated receipt. */
  mutationsWithReceipts: number;
  /** Recovery attempts planned by the recovery engine. */
  recoveryAttempts: number;
  /** Model calls actually made (`providerUsage.modelCallCount`). */
  modelCalls: number;
  /** Model calls the route budget expected. */
  modelCallBudget: number;
  wallClockMs: number;
  wallClockBudgetMs: number;
  /**
   * Research depth inputs. Optional so a non-research mission keeps scoring
   * without supplying them: an absent block means "no web sources required",
   * which both research dimensions treat as a vacuous 1 via the same empty-set
   * convention the coverage dimensions already use.
   */
  research?: ResearchDepthInput;
}

export interface MissionScoreDimension {
  id: MissionScoreDimensionId;
  /** 0..1, higher is better. */
  score: number;
  weight: number;
  detail: string;
}

export interface MissionScorecardV1 {
  version: 1;
  acceptancePassed: boolean;
  dimensions: MissionScoreDimension[];
  /** Weighted total, 0..1. */
  total: number;
}

export interface MissionScoreRegression {
  id: MissionScoreDimensionId;
  baseline: number;
  current: number;
  delta: number;
}

export function scoreMissionV1(
  input: MissionScorecardInput,
): MissionScorecardV1 {
  const dimensions: MissionScoreDimension[] = [
    dimension(
      "acceptance_coverage",
      ratioMet(input.acceptanceCriteriaTotal, input.acceptanceCriteriaMissing),
      `${input.acceptanceCriteriaTotal - clampCount(input.acceptanceCriteriaMissing, input.acceptanceCriteriaTotal)}/${input.acceptanceCriteriaTotal} criteria met`,
    ),
    dimension(
      "evidence_grounding",
      coverage(input.claimsWithEvidence, input.claimsRequiringEvidence),
      `${input.claimsWithEvidence}/${input.claimsRequiringEvidence} claims cited`,
    ),
    dimension(
      "receipt_coverage",
      coverage(input.mutationsWithReceipts, input.mutationsPerformed),
      `${input.mutationsWithReceipts}/${input.mutationsPerformed} mutations receipted`,
    ),
    dimension(
      "source_independence",
      input.research ? scoreSourceIndependence(input.research) : 1,
      input.research
        ? `${distinctDomainCount(input.research.usableSourceUrls)}/${input.research.requiredDistinctDomains} distinct domains`
        : "no web sources required",
    ),
    dimension(
      "research_depth",
      input.research ? scoreResearchDepth(input.research) : 1,
      input.research
        ? `${input.research.citedPassageCount} cited passages, ${distinctDomainCount(input.research.usableSourceUrls)} domains, ${input.research.quotedSpanCount} quotes, ${input.research.sectionCount} sections`
        : "no web sources required",
    ),
    dimension(
      "recovery_cleanliness",
      // Each recovery attempt is real friction the user paid for, even when the
      // run ultimately succeeded. Decay rather than step so one recovery is a
      // small mark and five is a serious one.
      decay(input.recoveryAttempts, 3),
      `${input.recoveryAttempts} recovery attempts`,
    ),
    dimension(
      "model_call_efficiency",
      budgetEfficiency(input.modelCalls, input.modelCallBudget),
      `${input.modelCalls}/${input.modelCallBudget} model calls`,
    ),
    dimension(
      "wall_clock_efficiency",
      budgetEfficiency(input.wallClockMs, input.wallClockBudgetMs),
      `${Math.round(input.wallClockMs / 1000)}s/${Math.round(input.wallClockBudgetMs / 1000)}s`,
    ),
  ];

  const total = dimensions.reduce(
    (sum, item) => sum + item.score * item.weight,
    0,
  );

  return {
    version: 1,
    acceptancePassed: input.acceptancePassed,
    dimensions,
    total: round4(total),
  };
}

/**
 * Dimensions that dropped against a baseline by more than `tolerance`.
 * Worst regression first.
 */
export function regressedAgainst(
  current: MissionScorecardV1,
  baseline: MissionScorecardV1,
  tolerance = 0.05,
): MissionScoreRegression[] {
  const baselineById = new Map(
    baseline.dimensions.map((item) => [item.id, item.score]),
  );

  return current.dimensions
    .flatMap((item) => {
      const previous = baselineById.get(item.id);
      if (previous === undefined) return [];
      const delta = round4(item.score - previous);
      return delta < -Math.abs(tolerance)
        ? [{ id: item.id, baseline: previous, current: item.score, delta }]
        : [];
    })
    .sort((left, right) => left.delta - right.delta);
}

/**
 * Fail-closed parser for a persisted scorecard.
 *
 * Runtime snapshots round-trip through markdown JSON blocks that anything may
 * have edited; a malformed card must degrade to "no scorecard recorded", never
 * to a card with invented numbers. Unknown dimension ids are rejected rather
 * than skipped so a snapshot written by a future dimension set does not
 * silently reload as a partial card.
 */
export function normalizeMissionScorecard(
  value: unknown,
): MissionScorecardV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.acceptancePassed !== "boolean") {
    return null;
  }
  if (!Array.isArray(record.dimensions) || record.dimensions.length === 0) {
    return null;
  }
  const knownIds = new Set(Object.keys(MISSION_SCORE_WEIGHTS));
  const seen = new Set<string>();
  const dimensions: MissionScoreDimension[] = [];
  for (const item of record.dimensions) {
    if (typeof item !== "object" || item === null) return null;
    const dim = item as Record<string, unknown>;
    if (
      typeof dim.id !== "string" ||
      !knownIds.has(dim.id) ||
      seen.has(dim.id) ||
      !isUnitInterval(dim.score) ||
      !isUnitInterval(dim.weight) ||
      typeof dim.detail !== "string"
    ) {
      return null;
    }
    seen.add(dim.id);
    dimensions.push({
      id: dim.id as MissionScoreDimensionId,
      score: round4(dim.score as number),
      weight: dim.weight as number,
      detail: dim.detail.slice(0, 400),
    });
  }
  if (!isUnitInterval(record.total)) return null;
  return {
    version: 1,
    acceptancePassed: record.acceptancePassed,
    dimensions,
    total: round4(record.total as number),
  };
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Compact Run Details / CI projection. */
export function formatMissionScorecard(card: MissionScorecardV1): string {
  return [
    `mission_score=${card.total.toFixed(3)} acceptance=${card.acceptancePassed ? "pass" : "needs_more_work"}`,
    ...card.dimensions.map(
      (item) => `- ${item.id}: ${item.score.toFixed(3)} (${item.detail})`,
    ),
  ].join("\n");
}

function dimension(
  id: MissionScoreDimensionId,
  score: number,
  detail: string,
): MissionScoreDimension {
  return {
    id,
    score: round4(clamp01(score)),
    weight: MISSION_SCORE_WEIGHTS[id],
    detail,
  };
}

/**
 * Coverage with an empty-set convention of 1. A run with no mutations has not
 * failed receipt coverage — it had nothing to receipt. Scoring it 0 would
 * punish read-only missions for being read-only.
 */
function coverage(covered: number, total: number): number {
  if (total <= 0) return 1;
  return clampCount(covered, total) / total;
}

function distinctDomainCount(urls: readonly string[]): number {
  const domains = new Set<string>();
  for (const url of urls) {
    const domain = registrableDomain(url);
    if (domain) domains.add(domain);
  }
  return domains.size;
}

function ratioMet(total: number, missing: number): number {
  if (total <= 0) return 1;
  return (total - clampCount(missing, total)) / total;
}

/**
 * Efficiency against a budget. At or under budget scores 1 — finishing early is
 * not extra credit, because rewarding it would pressure the agent to stop
 * short. Overruns decay smoothly so a 2x overrun is clearly worse than 1.1x.
 */
function budgetEfficiency(used: number, budget: number): number {
  if (!Number.isFinite(used) || used < 0) return 0;
  if (!Number.isFinite(budget) || budget <= 0) return 1;
  if (used <= budget) return 1;
  return budget / used;
}

/** Smooth decay: 0 occurrences scores 1, `halfLife` occurrences scores 0.5. */
function decay(count: number, halfLife: number): number {
  const occurrences = Math.max(0, count);
  if (occurrences === 0) return 1;
  return halfLife / (halfLife + occurrences);
}

function clampCount(value: number, max: number): number {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
