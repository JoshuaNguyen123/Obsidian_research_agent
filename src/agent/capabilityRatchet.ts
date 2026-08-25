/**
 * Evidence-based capability ratchet (B4).
 *
 * Barriers should come down as the system demonstrates reliability — via a
 * durable, evidence-derived mechanism, not another hard-coded constant. This
 * module turns the graded evidence the agent already records
 * (`MissionScorecardV1`, emitted per mission and merged by `RunCoordinator`)
 * into a small durable tier record with asymmetric transition rules:
 *
 * - **Loosens slowly.** One tier up only after
 *   {@link CAPABILITY_RATCHET_PROMOTION_STREAK} consecutive applicable
 *   scorecards from distinct runs, each with acceptance passed and a weighted
 *   total at or above {@link CAPABILITY_RATCHET_GREEN_TOTAL}.
 * - **Tightens fast.** A single regression — failed acceptance, or a total
 *   below {@link CAPABILITY_RATCHET_REGRESSION_TOTAL} — drops the tier
 *   straight back to 0.
 * - **Every transition is explained.** Each tier change is written to the
 *   record with the evidence that justified it (run ids, timestamps, totals),
 *   so a later reader can tell why a limit is where it is.
 *
 * First consumer: the Linear capability gate. The connection-discovery
 * snapshot still derives the base gate 0–3 exactly as before (the ratchet can
 * never substitute for missing connection evidence); an earned extension of
 * +1 unlocks gate 4 (labels-as-entities, issue/project/initiative relations,
 * label bindings, initiative↔project links) and +2 unlocks gate 5 (customer
 * objects). Mutations at every gate remain independently subject to prepared
 * approval and provider readback — the ratchet widens the fixed catalog the
 * model may request, never the approval or safety machinery around it.
 *
 * NEVER-RATCHET: this module must stay a pure function of its own record and
 * scorecards. It must not be imported by — and must not import — approval
 * scoping, sandbox containment, the verified push gateway, reconciliation
 * conservatism, or repository-deletion confirmation. A pin test asserts both
 * directions. A ratchet tier may raise a default but may never remove or
 * exceed a user-facing configured cap; configured ceilings still clamp.
 *
 * Pure and I/O-free; the host persists the record in local plugin data (it is
 * host-local reliability evidence, deliberately not bound to a specific
 * vault).
 */

import type { MissionScorecardV1 } from "./missionScorecard";
import { deriveLinearCapabilityGate } from "../integrations/linear/LinearSettingsState";
import type { LinearCapabilitySnapshotV1 } from "../integrations/linear/LinearCapabilityDiscovery";
import type { LinearCapabilityGate } from "../integrations/linear/types";

export const CAPABILITY_RATCHET_STATE_VERSION = 1 as const;
/** The one capability family this record currently governs. */
export const CAPABILITY_RATCHET_CAPABILITY_ID = "linear_tool_families" as const;
/** Weighted total at or above which a passing scorecard counts toward promotion. */
export const CAPABILITY_RATCHET_GREEN_TOTAL = 0.8;
/** Weighted total below which even a passing scorecard is a regression. */
export const CAPABILITY_RATCHET_REGRESSION_TOTAL = 0.6;
/** Distinct-run green scorecards required for one promotion. */
export const CAPABILITY_RATCHET_PROMOTION_STREAK = 5;
/** Earned extension tiers beyond the snapshot-derived base gate. */
export const CAPABILITY_RATCHET_MAX_TIER = 2;
const MAX_RATCHET_TRANSITIONS = 32;

export type CapabilityRatchetEvidenceClass = "green" | "neutral" | "regression";

/** One scorecard observation that justified (or will justify) a transition. */
export interface CapabilityRatchetEvidenceV1 {
  runId: string;
  at: string;
  total: number;
  acceptancePassed: boolean;
}

export interface CapabilityRatchetTransitionV1 {
  at: string;
  fromTier: number;
  toTier: number;
  reason: "promotion" | "regression";
  /** The exact observations that justified this transition. */
  evidence: CapabilityRatchetEvidenceV1[];
}

export interface CapabilityRatchetStateV1 {
  version: typeof CAPABILITY_RATCHET_STATE_VERSION;
  capabilityId: typeof CAPABILITY_RATCHET_CAPABILITY_ID;
  /** Earned tier, 0..{@link CAPABILITY_RATCHET_MAX_TIER}. */
  tier: number;
  /** Distinct-run green observations accumulated toward the next promotion. */
  streak: CapabilityRatchetEvidenceV1[];
  /** Why the tier is where it is, oldest first, bounded. */
  transitions: CapabilityRatchetTransitionV1[];
  updatedAt: string;
}

export interface CapabilityRatchetObservationV1 {
  /**
   * Root run identity for green deduplication. A compound run emits one merged
   * scorecard per segment; distinct-run counting is what makes "sustained"
   * mean five missions, not five segments of one mission. `null` (identity not
   * yet established) still tightens on a regression but never counts as green.
   */
  runId: string | null;
  at: string;
  scorecard: MissionScorecardV1;
}

export interface CapabilityRatchetObservationResult {
  state: CapabilityRatchetStateV1;
  changed: boolean;
}

export function createCapabilityRatchetState(
  at: string,
): CapabilityRatchetStateV1 {
  return {
    version: CAPABILITY_RATCHET_STATE_VERSION,
    capabilityId: CAPABILITY_RATCHET_CAPABILITY_ID,
    tier: 0,
    streak: [],
    transitions: [],
    updatedAt: at,
  };
}

/**
 * Shared classification predicate. Green requires an applicable measurement:
 * a card whose every dimension was inapplicable carries a vacuous total of 1
 * and must not buy trust.
 */
export function classifyCapabilityRatchetEvidence(
  scorecard: MissionScorecardV1,
): CapabilityRatchetEvidenceClass {
  if (
    !scorecard.acceptancePassed ||
    scorecard.total < CAPABILITY_RATCHET_REGRESSION_TOTAL
  ) {
    return "regression";
  }
  const measuredSomething = scorecard.dimensions.some(
    (dimension) => dimension.applicable !== false,
  );
  if (measuredSomething && scorecard.total >= CAPABILITY_RATCHET_GREEN_TOTAL) {
    return "green";
  }
  return "neutral";
}

/**
 * Fold one scorecard observation into the record. Pure: returns a new state
 * and never mutates the input. `changed: false` means the caller has nothing
 * to persist.
 */
export function observeCapabilityRatchetScorecard(
  state: CapabilityRatchetStateV1,
  observation: CapabilityRatchetObservationV1,
): CapabilityRatchetObservationResult {
  const classification = classifyCapabilityRatchetEvidence(
    observation.scorecard,
  );
  const evidence: CapabilityRatchetEvidenceV1 = {
    runId: observation.runId ?? "unattributed",
    at: observation.at,
    total: observation.scorecard.total,
    acceptancePassed: observation.scorecard.acceptancePassed,
  };

  if (classification === "regression") {
    if (state.tier === 0 && state.streak.length === 0) {
      return { state, changed: false };
    }
    const transitions =
      state.tier > 0
        ? boundTransitions([
            ...state.transitions,
            {
              at: observation.at,
              fromTier: state.tier,
              toTier: 0,
              reason: "regression" as const,
              evidence: [evidence],
            },
          ])
        : state.transitions.map(cloneTransition);
    return {
      state: {
        ...state,
        tier: 0,
        streak: [],
        transitions,
        updatedAt: observation.at,
      },
      changed: true,
    };
  }

  if (classification === "neutral") {
    if (state.streak.length === 0) return { state, changed: false };
    return {
      state: {
        ...state,
        streak: [],
        transitions: state.transitions.map(cloneTransition),
        updatedAt: observation.at,
      },
      changed: true,
    };
  }

  // Green. Loosening requires attributable evidence.
  if (observation.runId === null) return { state, changed: false };

  const existingIndex = state.streak.findIndex(
    (entry) => entry.runId === evidence.runId,
  );
  let streak: CapabilityRatchetEvidenceV1[];
  if (existingIndex >= 0) {
    const existing = state.streak[existingIndex];
    if (existing.at === evidence.at && existing.total === evidence.total) {
      return { state, changed: false };
    }
    // A later merged card for the same run refreshes that run's entry rather
    // than counting the run twice.
    streak = state.streak.map((entry, index) =>
      index === existingIndex ? evidence : { ...entry },
    );
  } else {
    streak = [...state.streak.map((entry) => ({ ...entry })), evidence];
  }

  if (
    streak.length >= CAPABILITY_RATCHET_PROMOTION_STREAK &&
    state.tier < CAPABILITY_RATCHET_MAX_TIER
  ) {
    const nextTier = state.tier + 1;
    return {
      state: {
        ...state,
        tier: nextTier,
        streak: [],
        transitions: boundTransitions([
          ...state.transitions,
          {
            at: observation.at,
            fromTier: state.tier,
            toTier: nextTier,
            reason: "promotion" as const,
            evidence: streak,
          },
        ]),
        updatedAt: observation.at,
      },
      changed: true,
    };
  }

  return {
    state: {
      ...state,
      // At the maximum tier the streak stays bounded instead of growing
      // without limit; the newest observations are the ones retained.
      streak: streak.slice(-CAPABILITY_RATCHET_PROMOTION_STREAK),
      transitions: state.transitions.map(cloneTransition),
      updatedAt: observation.at,
    },
    changed: true,
  };
}

/** Earned extension for the Linear gate. Absent or malformed earns nothing. */
export function earnedLinearGateExtension(
  state: CapabilityRatchetStateV1 | null | undefined,
): 0 | 1 | 2 {
  if (!state) return 0;
  if (state.tier === 1) return 1;
  if (state.tier >= CAPABILITY_RATCHET_MAX_TIER) return 2;
  return 0;
}

/**
 * The one production predicate for the ratcheted Linear gate. The snapshot
 * still derives the base gate; the earned extension applies only on top of a
 * fully-bound connection (base gate 3).
 */
export function deriveRatchetedLinearCapabilityGate(
  snapshot: LinearCapabilitySnapshotV1 | null,
  state: CapabilityRatchetStateV1 | null | undefined,
): LinearCapabilityGate {
  return deriveLinearCapabilityGate(snapshot, {
    earnedExtension: earnedLinearGateExtension(state),
  });
}

/**
 * Fail-closed parser for the persisted record. A malformed record must
 * degrade to `null` (the caller starts over at tier 0), never to a record
 * with invented trust.
 */
export function normalizeCapabilityRatchetState(
  value: unknown,
): CapabilityRatchetStateV1 | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== CAPABILITY_RATCHET_STATE_VERSION ||
    value.capabilityId !== CAPABILITY_RATCHET_CAPABILITY_ID ||
    !isTier(value.tier) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    !Array.isArray(value.streak) ||
    value.streak.length > CAPABILITY_RATCHET_PROMOTION_STREAK ||
    !Array.isArray(value.transitions) ||
    value.transitions.length > MAX_RATCHET_TRANSITIONS
  ) {
    return null;
  }
  const streak: CapabilityRatchetEvidenceV1[] = [];
  const seenRunIds = new Set<string>();
  for (const item of value.streak) {
    const evidence = normalizeEvidence(item);
    if (!evidence || seenRunIds.has(evidence.runId)) return null;
    seenRunIds.add(evidence.runId);
    streak.push(evidence);
  }
  const transitions: CapabilityRatchetTransitionV1[] = [];
  for (const item of value.transitions) {
    if (!isRecord(item)) return null;
    if (
      !isCanonicalTimestamp(item.at) ||
      !isTier(item.fromTier) ||
      !isTier(item.toTier) ||
      (item.reason !== "promotion" && item.reason !== "regression") ||
      !Array.isArray(item.evidence) ||
      item.evidence.length === 0 ||
      item.evidence.length > CAPABILITY_RATCHET_PROMOTION_STREAK
    ) {
      return null;
    }
    if (item.reason === "promotion" && item.toTier !== item.fromTier + 1) {
      return null;
    }
    if (item.reason === "regression" && item.toTier !== 0) return null;
    const evidence: CapabilityRatchetEvidenceV1[] = [];
    for (const entry of item.evidence) {
      const normalized = normalizeEvidence(entry);
      if (!normalized) return null;
      evidence.push(normalized);
    }
    transitions.push({
      at: item.at,
      fromTier: item.fromTier,
      toTier: item.toTier,
      reason: item.reason,
      evidence,
    });
  }
  return {
    version: CAPABILITY_RATCHET_STATE_VERSION,
    capabilityId: CAPABILITY_RATCHET_CAPABILITY_ID,
    tier: value.tier,
    streak,
    transitions,
    updatedAt: value.updatedAt,
  };
}

function normalizeEvidence(value: unknown): CapabilityRatchetEvidenceV1 | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    value.runId.length > 256 ||
    !isCanonicalTimestamp(value.at) ||
    typeof value.total !== "number" ||
    !Number.isFinite(value.total) ||
    value.total < 0 ||
    value.total > 1 ||
    typeof value.acceptancePassed !== "boolean"
  ) {
    return null;
  }
  return {
    runId: value.runId,
    at: value.at,
    total: value.total,
    acceptancePassed: value.acceptancePassed,
  };
}

function boundTransitions(
  transitions: CapabilityRatchetTransitionV1[],
): CapabilityRatchetTransitionV1[] {
  return transitions.slice(-MAX_RATCHET_TRANSITIONS).map(cloneTransition);
}

function cloneTransition(
  transition: CapabilityRatchetTransitionV1,
): CapabilityRatchetTransitionV1 {
  return {
    ...transition,
    evidence: transition.evidence.map((entry) => ({ ...entry })),
  };
}

function isTier(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= CAPABILITY_RATCHET_MAX_TIER
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
