import type { SecretDescriptionV1 } from "../../../packages/core-api/src/secretStoreV1";
import type { LinearCapabilityGate } from "./types";
import type {
  LinearCapabilitySnapshotV1,
  LinearDiscoveredWorkflowStateV1,
} from "./LinearCapabilityDiscovery";

export interface LinearQueueSelectionV1 {
  teamId: string;
  projectId: string;
  startedStateId: string;
  completedStateId: string;
  blockedStateId?: string;
}

export interface LinearQueueConfigurationStatusV1 {
  ready: boolean;
  reason: string;
}

export interface ReconciledLinearSelectionsV1 extends LinearQueueSelectionV1 {
  changed: boolean;
}

/**
 * Derives the bounded fixed-operation catalog from connection evidence. The
 * persisted legacy ceiling is deliberately not authoritative.
 */
export function deriveLinearCapabilityGate(
  snapshot: LinearCapabilitySnapshotV1 | null,
): LinearCapabilityGate {
  if (!hasCapability(snapshot, "authenticated_connection")) return 0;
  // Queue and ticket publication need the issue/comment catalog (gate 1).
  // Project readback is allowed only when project discovery also succeeded.
  return hasCapability(snapshot, "project_selection") ? 2 : 1;
}

export function evaluateLinearQueueConfiguration(
  snapshot: LinearCapabilitySnapshotV1 | null,
  selection: LinearQueueSelectionV1,
): LinearQueueConfigurationStatusV1 {
  if (!snapshot || !hasCapability(snapshot, "authenticated_connection")) {
    return blocked("Test the Linear connection to discover this workspace.");
  }
  if (!hasCapability(snapshot, "team_selection")) {
    return blocked("The Linear connection did not return an available team.");
  }
  if (!hasCapability(snapshot, "project_selection")) {
    return blocked("The Linear connection did not return an available project.");
  }
  if (!hasCapability(snapshot, "workflow_state_selection")) {
    return blocked("The Linear connection did not return workflow states.");
  }
  const team = snapshot.teams.find((candidate) => candidate.id === selection.teamId);
  if (!team) return blocked("Select a connection-derived Linear team.");
  const project = snapshot.projects.find(
    (candidate) => candidate.id === selection.projectId,
  );
  if (!project) return blocked("Select a connection-derived Linear queue project.");
  if (project.teamIds.length > 0 && !project.teamIds.includes(team.id)) {
    return blocked("The selected Linear project is not associated with the selected team.");
  }
  const started = findTeamState(snapshot, selection.startedStateId, team.id);
  if (!started) return blocked("Select a started workflow state for the chosen team.");
  const completed = findTeamState(snapshot, selection.completedStateId, team.id);
  if (!completed) return blocked("Select a completed workflow state for the chosen team.");
  if (
    selection.blockedStateId &&
    !findTeamState(snapshot, selection.blockedStateId, team.id)
  ) {
    return blocked("Select a blocked workflow state for the chosen team or leave it unset.");
  }
  return {
    ready: true,
    reason: `Queue bindings are verified against ${snapshot.workspace.name ?? snapshot.workspace.id}.`,
  };
}

/** Preserve matching legacy IDs, otherwise choose only an unambiguous option. */
export function reconcileLinearSelections(
  snapshot: LinearCapabilitySnapshotV1,
  selection: LinearQueueSelectionV1,
): ReconciledLinearSelectionsV1 {
  const teamId = selectKnownOrOnly(
    selection.teamId,
    snapshot.teams.map((item) => item.id),
  );
  const projects = snapshot.projects.filter(
    (item) => !teamId || item.teamIds.length === 0 || item.teamIds.includes(teamId),
  );
  const projectId = selectKnownOrOnly(
    selection.projectId,
    projects.map((item) => item.id),
  );
  const states = snapshot.workflowStates.filter(
    (item) => !teamId || item.teamId === null || item.teamId === teamId,
  );
  const startedStateId = selectKnownOrOnly(
    selection.startedStateId,
    states.filter((item) => item.type === "started").map((item) => item.id),
  );
  const completedStateId = selectKnownOrOnly(
    selection.completedStateId,
    states.filter((item) => item.type === "completed").map((item) => item.id),
  );
  const blockedStateId = selection.blockedStateId
    ? selectKnownOrOnly(selection.blockedStateId, states.map((item) => item.id))
    : "";
  const next = {
    teamId,
    projectId,
    startedStateId,
    completedStateId,
    blockedStateId,
  };
  return {
    ...next,
    changed:
      next.teamId !== selection.teamId ||
      next.projectId !== selection.projectId ||
      next.startedStateId !== selection.startedStateId ||
      next.completedStateId !== selection.completedStateId ||
      next.blockedStateId !== (selection.blockedStateId ?? ""),
  };
}

/** Strict, secret-free boundary for the persisted opaque reference metadata. */
export function normalizeLinearCredentialReference(
  value: unknown,
): SecretDescriptionV1 | null {
  if (!isRecord(value)) return null;
  const exactKeys = [
    "version",
    "referenceId",
    "label",
    "metadata",
    "backend",
    "persistent",
    "createdAt",
    "updatedAt",
  ];
  if (
    Object.keys(value).length !== exactKeys.length ||
    exactKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    return null;
  }
  if (
    value.version !== 1 ||
    typeof value.referenceId !== "string" ||
    !/^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/.test(value.referenceId) ||
    typeof value.label !== "string" ||
    value.label.length < 1 ||
    value.label.length > 256 ||
    typeof value.backend !== "string" ||
    value.backend.length < 1 ||
    value.backend.length > 256 ||
    typeof value.persistent !== "boolean" ||
    typeof value.createdAt !== "string" ||
    !isCanonicalTimestamp(value.createdAt) ||
    typeof value.updatedAt !== "string" ||
    !isCanonicalTimestamp(value.updatedAt) ||
    !isRecord(value.metadata)
  ) {
    return null;
  }
  const metadata: Record<string, string> = {};
  const allowed = new Set(["account", "actor", "credentialKind", "provider", "scope"]);
  for (const [key, item] of Object.entries(value.metadata)) {
    if (!allowed.has(key) || typeof item !== "string" || item.length > 500) return null;
    metadata[key] = item;
  }
  return {
    version: 1,
    referenceId: value.referenceId,
    label: value.label,
    metadata,
    backend: value.backend,
    persistent: value.persistent,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function hasCapability(
  snapshot: LinearCapabilitySnapshotV1 | null,
  id: LinearCapabilitySnapshotV1["capabilities"][number]["id"],
): boolean {
  return snapshot?.capabilities.some(
    (capability) => capability.id === id && capability.enabled,
  ) === true;
}

function findTeamState(
  snapshot: LinearCapabilitySnapshotV1,
  stateId: string,
  teamId: string,
): LinearDiscoveredWorkflowStateV1 | undefined {
  return snapshot.workflowStates.find(
    (state) => state.id === stateId && (state.teamId === null || state.teamId === teamId),
  );
}

function selectKnownOrOnly(current: string, choices: string[]): string {
  if (current && choices.includes(current)) return current;
  return choices.length === 1 ? choices[0] : "";
}

function blocked(reason: string): LinearQueueConfigurationStatusV1 {
  return { ready: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
