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
