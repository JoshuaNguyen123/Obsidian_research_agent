import { normalizeOrchestratorSnapshot } from "../orchestrator/orchestratorStore";
import type {
  AgentParticipantStatus,
  OrchestratorRunStatus,
  OrchestratorSnapshotV1,
  WorkNodeStatus,
} from "../orchestrator/types";
import type {
  TopLevelMissionTerminalDecisionV1,
  TopLevelMissionTerminalKindV1,
} from "./topLevelMissionTerminal";

export const TOP_LEVEL_CHILD_TERMINAL_CHECKPOINT_VERSION = 1 as const;

/**
 * Restart-only bridge for the narrow interval after a child executor has
 * stopped but before MissionGraphV3 has persisted its terminal parent view.
 */
export interface TopLevelChildTerminalCheckpointV1 {
  version: typeof TOP_LEVEL_CHILD_TERMINAL_CHECKPOINT_VERSION;
  parentRunId: string;
  childRunId: string;
  terminal: TopLevelMissionTerminalDecisionV1;
  observedAt: string;
}

export function createTopLevelChildTerminalCheckpointV1(input: {
  parentRunId: string;
  childRunId: string;
  terminal: TopLevelMissionTerminalDecisionV1;
  observedAt?: string;
}): TopLevelChildTerminalCheckpointV1 {
  const parentRunId = input.parentRunId.trim();
  const childRunId = input.childRunId.trim();
  if (!parentRunId || !childRunId) {
    throw new Error("Terminal checkpoint requires parent and child run IDs.");
  }
  return {
    version: TOP_LEVEL_CHILD_TERMINAL_CHECKPOINT_VERSION,
    parentRunId,
    childRunId,
    terminal: { ...input.terminal },
    observedAt: normalizeTimestamp(input.observedAt) ?? new Date().toISOString(),
  };
}

export function parseTopLevelChildTerminalCheckpointV1(
  value: unknown,
): TopLevelChildTerminalCheckpointV1 | null {
  if (!isRecord(value) || value.version !== TOP_LEVEL_CHILD_TERMINAL_CHECKPOINT_VERSION) {
    return null;
  }
  const parentRunId = nonEmptyString(value.parentRunId);
  const childRunId = nonEmptyString(value.childRunId);
  const observedAt = normalizeTimestamp(value.observedAt);
  const terminal = parseTerminalDecision(value.terminal);
  if (!parentRunId || !childRunId || !observedAt || !terminal) return null;
  return {
    version: TOP_LEVEL_CHILD_TERMINAL_CHECKPOINT_VERSION,
    parentRunId,
    childRunId,
    terminal,
    observedAt,
  };
}

/**
 * Reconciles only the canonical top-level dispatch/final projection. Unknown
 * graph shapes remain on the generic orphan-recovery path.
 */
export function reconcileTopLevelChildTerminalProjectionV1(
  value: unknown,
  checkpointValue: unknown,
): OrchestratorSnapshotV1 | null {
  const snapshot = normalizeOrchestratorSnapshot(value);
  const checkpoint = parseTopLevelChildTerminalCheckpointV1(checkpointValue);
  if (
    !snapshot ||
    !checkpoint ||
    snapshot.status !== "running" ||
    snapshot.runId !== checkpoint.parentRunId ||
    checkpoint.childRunId !== checkpoint.parentRunId ||
    !snapshot.nodes.dispatch ||
    !snapshot.nodes.final
  ) {
    return null;
  }

  const runStatus = terminalRunStatus(checkpoint.terminal.kind);
  const nodeStatus = terminalNodeStatus(checkpoint.terminal.kind);
  const participantStatus = terminalParticipantStatus(checkpoint.terminal.kind);
  const updatedAt = monotonicTimestamp(snapshot.updatedAt, checkpoint.observedAt);
  const blocker =
    checkpoint.terminal.kind === "complete"
      ? undefined
      : checkpoint.terminal.message;

  const nodes = Object.fromEntries(
    Object.entries(snapshot.nodes).map(([id, node]) => [
      id,
      id === "dispatch" || id === "final"
        ? {
            ...node,
            status: nodeStatus,
            lastAction: checkpoint.terminal.message,
            updatedAt,
            ...(blocker ? { blocker } : {}),
          }
        : node,
    ]),
  );
  const participants = Object.fromEntries(
    Object.entries(snapshot.participants).map(([id, participant]) => [
      id,
      id === "lead"
        ? {
            ...participant,
            status: participantStatus,
            currentNodeId: null,
            lastAction: checkpoint.terminal.message,
            updatedAt,
            ...(blocker ? { blocker } : {}),
          }
        : participant,
    ]),
  );

  return normalizeOrchestratorSnapshot({
    ...snapshot,
    status: runStatus,
    nodes,
    participants,
    merge: {
      ...snapshot.merge,
      status: checkpoint.terminal.kind === "complete" ? "complete" : "blocked",
      verificationStatus:
        checkpoint.terminal.kind === "complete"
          ? "passed"
          : checkpoint.terminal.kind === "failed"
            ? "failed"
            : "blocked",
      integrationStatus:
        checkpoint.terminal.kind === "failed"
          ? "failed"
          : snapshot.merge.integrationStatus,
      ...(blocker ? { blocker } : {}),
      updatedAt,
    },
    sequence: Math.min(Number.MAX_SAFE_INTEGER, snapshot.sequence + 1),
    updatedAt,
  });
}

function terminalRunStatus(
  kind: TopLevelMissionTerminalKindV1,
): OrchestratorRunStatus {
  return kind;
}

function terminalNodeStatus(kind: TopLevelMissionTerminalKindV1): WorkNodeStatus {
  if (kind === "complete") return "complete";
  if (kind === "cancelled") return "cancelled";
  return "blocked";
}

function terminalParticipantStatus(
  kind: TopLevelMissionTerminalKindV1,
): AgentParticipantStatus {
  return kind;
}

function parseTerminalDecision(
  value: unknown,
): TopLevelMissionTerminalDecisionV1 | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const kind = terminalKind(value.kind);
  const code = nonEmptyString(value.code);
  const message = nonEmptyString(value.message);
  const requiredAction =
    value.requiredAction === null
      ? null
      : typeof value.requiredAction === "string"
        ? value.requiredAction.trim() || null
        : undefined;
  if (!kind || !code || !message || requiredAction === undefined) return null;
  return { version: 1, kind, code, message, requiredAction };
}

function terminalKind(value: unknown): TopLevelMissionTerminalKindV1 | null {
  return value === "complete" ||
    value === "blocked" ||
    value === "cancelled" ||
    value === "failed"
    ? value
    : null;
}

function monotonicTimestamp(prior: string, observed: string): string {
  const priorMs = Date.parse(prior);
  const observedMs = Date.parse(observed);
  return new Date(
    Math.max(
      Number.isFinite(priorMs) ? priorMs + 1 : 0,
      Number.isFinite(observedMs) ? observedMs : Date.now(),
    ),
  ).toISOString();
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
