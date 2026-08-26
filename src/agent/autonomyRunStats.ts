/**
 * Autonomy / team run metrics — pure aggregation for Chat stats + daily-use.
 *
 * // INTEGRATOR: Increment from approval broker, continue segments, each
 * // tool-schema offer, stage restart, runResearchTeamMission, and Lead loop.
 */

import type { AutonomyEffectClass } from "./autonomyEffectClass";

export interface AutonomyRunStatsTeamV1 {
  researcherSteps: number;
  leadSteps: number;
  handoffAccepted: boolean | null;
  usableSourceCount: number;
}

export interface AutonomyRunStatsV1 {
  version: 1;
  continueCount: number;
  approvalCountByEffectClass: {
    soft: number;
    bound: number;
    hard: number;
  };
  toolsOffered: { avg: number; max: number; samples: number; sum: number };
  stageRestartCount: number;
  /**
   * Reactive prose-steering escalations injected by the step loop after
   * consecutive prose-only responses left required frontier work unpaid.
   * Counts only the bounded pre-breaker escalation seat, not the first-strike
   * frontier correction. Census contract field name — do not rename.
   */
  prose_steering_injections?: number;
  /**
   * Successful model calls in this run whose response carried no work at all —
   * no tool call and no renderable prose. Counted because the provider bills
   * these as successes (11/11 "successful" calls in the run that motivated
   * this field) and nothing else in the record separates them from real work.
   * Census contract field name — do not rename.
   */
  unproductive_model_responses?: number;
  /**
   * Longest streak of CONSECUTIVE unproductive responses. The streak, not the
   * total, is what distinguishes "the model stopped answering" from "the model
   * hiccuped twice"; it is the value the stop reads.
   * Census contract field name — do not rename.
   */
  max_consecutive_unproductive_model_responses?: number;
  softOnly: boolean;
  elapsedMs?: number;
  team?: AutonomyRunStatsTeamV1;
}

export function createAutonomyRunStats(): AutonomyRunStatsV1 {
  return {
    version: 1,
    continueCount: 0,
    approvalCountByEffectClass: { soft: 0, bound: 0, hard: 0 },
    toolsOffered: { avg: 0, max: 0, samples: 0, sum: 0 },
    stageRestartCount: 0,
    prose_steering_injections: 0,
    unproductive_model_responses: 0,
    max_consecutive_unproductive_model_responses: 0,
    softOnly: true,
    team: {
      researcherSteps: 0,
      leadSteps: 0,
      handoffAccepted: null,
      usableSourceCount: 0,
    },
  };
}

export function recordToolsOffered(
  stats: AutonomyRunStatsV1,
  count: number,
): void {
  const n = Math.max(0, Math.floor(count));
  stats.toolsOffered.samples += 1;
  stats.toolsOffered.sum += n;
  stats.toolsOffered.max = Math.max(stats.toolsOffered.max, n);
  stats.toolsOffered.avg =
    stats.toolsOffered.samples > 0
      ? stats.toolsOffered.sum / stats.toolsOffered.samples
      : 0;
}

export function recordApproval(
  stats: AutonomyRunStatsV1,
  effectClass: AutonomyEffectClass,
): void {
  stats.approvalCountByEffectClass[effectClass] += 1;
  if (effectClass !== "soft") {
    stats.softOnly = false;
  }
}

export function recordContinue(stats: AutonomyRunStatsV1): void {
  stats.continueCount += 1;
}

export function recordStageRestart(stats: AutonomyRunStatsV1): void {
  stats.stageRestartCount += 1;
}

export function recordProseSteeringInjection(stats: AutonomyRunStatsV1): void {
  stats.prose_steering_injections = (stats.prose_steering_injections ?? 0) + 1;
}

/**
 * Record one model response that carried no work. `consecutive` is the current
 * streak INCLUDING this response, so the peak is a max, not a sum — the caller
 * owns the streak counter because only it knows what resets it.
 */
export function recordUnproductiveModelResponse(
  stats: AutonomyRunStatsV1,
  consecutive: number,
): void {
  stats.unproductive_model_responses =
    (stats.unproductive_model_responses ?? 0) + 1;
  stats.max_consecutive_unproductive_model_responses = Math.max(
    stats.max_consecutive_unproductive_model_responses ?? 0,
    Math.max(0, Math.floor(consecutive)),
  );
}

export function recordResearcherStep(stats: AutonomyRunStatsV1): void {
  ensureTeam(stats).researcherSteps += 1;
}

export function recordLeadStep(stats: AutonomyRunStatsV1): void {
  ensureTeam(stats).leadSteps += 1;
}

export function recordHandoffAccepted(
  stats: AutonomyRunStatsV1,
  accepted: boolean,
): void {
  ensureTeam(stats).handoffAccepted = accepted;
}

export function recordUsableSources(
  stats: AutonomyRunStatsV1,
  count: number,
): void {
  ensureTeam(stats).usableSourceCount = Math.max(0, Math.floor(count));
}

export function finalizeAutonomyRunStats(
  stats: AutonomyRunStatsV1,
  input: { elapsedMs?: number; softOnly?: boolean } = {},
): AutonomyRunStatsV1 {
  if (typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs)) {
    stats.elapsedMs = Math.max(0, Math.floor(input.elapsedMs));
  }
  if (typeof input.softOnly === "boolean") {
    stats.softOnly = input.softOnly;
  } else {
    const approvals = stats.approvalCountByEffectClass;
    stats.softOnly =
      approvals.bound === 0 &&
      approvals.hard === 0 &&
      stats.softOnly !== false;
  }
  if (stats.toolsOffered.samples > 0) {
    stats.toolsOffered.avg =
      stats.toolsOffered.sum / stats.toolsOffered.samples;
  }
  return { ...stats, team: stats.team ? { ...stats.team } : undefined };
}

function ensureTeam(stats: AutonomyRunStatsV1): AutonomyRunStatsTeamV1 {
  if (!stats.team) {
    stats.team = {
      researcherSteps: 0,
      leadSteps: 0,
      handoffAccepted: null,
      usableSourceCount: 0,
    };
  }
  return stats.team;
}
