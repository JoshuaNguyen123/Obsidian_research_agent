/**
 * Chat-facing autonomy / team stats formatters (kept separate from agentViewCopy
 * for parallel ownership with A-UI).
 */

import type { AutonomyRunStatsV1 } from "../agent/autonomyRunStats";

export function formatAutonomyStatsLine(
  stats: AutonomyRunStatsV1 | null | undefined,
): string {
  if (!stats) {
    return "—";
  }
  const approvals =
    stats.approvalCountByEffectClass.soft +
    stats.approvalCountByEffectClass.bound +
    stats.approvalCountByEffectClass.hard;
  const path = stats.softOnly ? "Soft path" : "Mixed path";
  const tools =
    stats.toolsOffered.samples > 0
      ? `${Math.round(stats.toolsOffered.avg)} tools avg`
      : "tools —";
  return `${path} · ${stats.continueCount} continues · ${approvals} approvals · ${tools}`;
}

export function formatTeamStatsLine(
  stats: AutonomyRunStatsV1 | null | undefined,
): string | null {
  const team = stats?.team;
  if (!team) return null;
  const handoff =
    team.handoffAccepted === null
      ? "handoff —"
      : team.handoffAccepted
        ? "handoff OK"
        : "handoff rejected";
  return `Team sources: ${team.usableSourceCount} · R${team.researcherSteps}/L${team.leadSteps} · ${handoff}`;
}
