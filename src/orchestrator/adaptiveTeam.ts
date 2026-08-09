import type {
  AgentParticipant,
  OrchestratorSnapshotV1,
  OrchestratorWorkNode,
  SpecialistMode,
  WorkNodeStatus,
} from "./types";
import { createSpecialistRepairStateV2 } from "./specialistRecovery";

export const ADAPTIVE_TEAM_PARTICIPANT_IDS = ["lead", "specialist"] as const;

export interface AdaptiveTeamScaffoldV2 {
  participants: [AgentParticipant, AgentParticipant];
  nodes: OrchestratorWorkNode[];
  nodeIds: {
    root: string;
    specialist: string;
    handoff: string;
    lead: string;
    verify: string;
  };
  specialistModes: SpecialistMode[];
}

/**
 * Projection-only scaffold for the one Lead + one Adaptive Specialist team.
 * It never replaces or advances MissionGraph; callers project authoritative
 * graph progress into these nodes.
 */
export function createAdaptiveTeamScaffoldV2(input: {
  runId: string;
  mission: string;
  specialistModes: readonly SpecialistMode[];
  specialistMaxSteps: number;
  specialistMaxToolCalls: number;
  specialistMaxMinutes: number;
  leadMaxSteps?: number;
  leadMaxToolCalls?: number;
  leadMaxMinutes?: number;
  now?: Date;
}): AdaptiveTeamScaffoldV2 {
  const now = (input.now ?? new Date()).toISOString();
  const specialistModes = normalizeSpecialistModes(input.specialistModes);
  const specialistMode = specialistModes[0];
  const root = `${input.runId}:mission`;
  const specialist = `${input.runId}:specialist`;
  const handoff = `${input.runId}:handoff`;
  const lead = `${input.runId}:lead`;
  const verify = `${input.runId}:verify`;
  const budget = (modelSteps: number, toolCalls: number, wallClockMs: number) => ({
    modelSteps: { used: 0, limit: Math.max(0, Math.trunc(modelSteps)) },
    toolCalls: { used: 0, limit: Math.max(0, Math.trunc(toolCalls)) },
    wallClockMs: { used: 0, limit: Math.max(0, Math.trunc(wallClockMs)) },
  });
  const participants: [AgentParticipant, AgentParticipant] = [
    {
      id: "lead",
      role: "lead",
      displayName: "Lead",
      status: "planning",
      currentNodeId: root,
      budget: budget(
        input.leadMaxSteps ?? 100,
        input.leadMaxToolCalls ?? 200,
        (input.leadMaxMinutes ?? 30) * 60_000,
      ),
      handoffStatus: "none",
      startedAt: now,
      updatedAt: now,
    },
    {
      id: "specialist",
      role: "specialist",
      displayName: "Adaptive Specialist",
      status: "queued",
      currentNodeId: specialist,
      budget: budget(
        input.specialistMaxSteps,
        input.specialistMaxToolCalls,
        input.specialistMaxMinutes * 60_000,
      ),
      handoffStatus: "none",
      specialistMode,
      repairState: createSpecialistRepairStateV2(),
      updatedAt: now,
    },
  ];
  const node = (
    id: string,
    parentId: string | null,
    childIds: string[],
    kind: OrchestratorWorkNode["kind"],
    title: string,
    status: WorkNodeStatus,
    ownerId: "lead" | "specialist",
    dependencyIds: string[] = [],
  ): OrchestratorWorkNode => ({
    id,
    parentId,
    childIds,
    kind,
    title,
    status,
    ownerId,
    dependencyIds,
    evidenceIds: [],
    receiptIds: [],
    artifactIds: [],
    createdAt: now,
    updatedAt: now,
  });
  return {
    participants,
    nodes: [
      node(
        root,
        null,
        [specialist, handoff, lead, verify],
        "mission",
        input.mission,
        "running",
        "lead",
      ),
      node(
        specialist,
        root,
        [],
        workKindForMode(specialistMode),
        `Adaptive Specialist: ${specialistModes.map(specialistModeLabel).join(" → ")}`,
        "ready",
        "specialist",
      ),
      node(
        handoff,
        root,
        [],
        "handoff",
        "Validate proof-bearing Specialist handoff",
        "queued",
        "lead",
        [specialist],
      ),
      node(
        lead,
        root,
        [],
        "mission",
        "Lead verifies and executes authorized workflow",
        "queued",
        "lead",
        [handoff],
      ),
      node(
        verify,
        root,
        [],
        "verify",
        "Verify MissionGraph acceptance and receipts",
        "queued",
        "lead",
        [lead],
      ),
    ],
    nodeIds: { root, specialist, handoff, lead, verify },
    specialistModes,
  };
}

export function normalizeSpecialistModes(
  values: readonly SpecialistMode[],
): SpecialistMode[] {
  const modes = [...new Set(values)].filter(isSpecialistMode);
  return modes.length > 0 ? modes : ["researcher"];
}

export function isAdaptiveTeamParticipantSet(
  participants: Readonly<Record<string, AgentParticipant>>,
): boolean {
  const ids = Object.keys(participants).sort();
  return (
    ids.length === 2 &&
    ids[0] === "lead" &&
    ids[1] === "specialist" &&
    participants.lead?.role === "lead" &&
    participants.specialist?.role === "specialist"
  );
}

export function specialistModeLabel(mode: SpecialistMode): string {
  switch (mode) {
    case "researcher":
      return "researcher";
    case "linear_planner":
      return "Linear planner";
    case "code_builder":
      return "code builder";
    case "code_reviewer":
      return "code reviewer";
    case "recovery_verifier":
      return "recovery verifier";
  }
}

function workKindForMode(mode: SpecialistMode): OrchestratorWorkNode["kind"] {
  if (mode === "researcher" || mode === "linear_planner") return "research";
  if (mode === "code_builder") return "code";
  return "verify";
}

function isSpecialistMode(value: SpecialistMode): boolean {
  return (
    value === "researcher" ||
    value === "linear_planner" ||
    value === "code_builder" ||
    value === "code_reviewer" ||
    value === "recovery_verifier"
  );
}
