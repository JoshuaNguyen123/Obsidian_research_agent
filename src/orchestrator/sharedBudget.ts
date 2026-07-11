import type { AgentParticipantBudget } from "./types";

export type BudgetResource = "modelSteps" | "toolCalls" | "wallClockMs";

export interface SharedBudgetLimits {
  modelSteps: number;
  toolCalls: number;
  wallClockMs: number;
  finalizationReserveModelSteps?: number;
}

export interface ParticipantBudgetRegistration {
  limits: Omit<SharedBudgetLimits, "finalizationReserveModelSteps">;
  canUseFinalizationReserve?: boolean;
}

export interface BudgetConsumptionRequest {
  participantId: string;
  resource: BudgetResource;
  amount?: number;
  allowFinalizationReserve?: boolean;
}

export type BudgetRejectionReason =
  | "unknown_participant"
  | "invalid_amount"
  | "participant_limit"
  | "root_limit"
  | "finalization_reserve";

export interface BudgetConsumptionResult {
  accepted: boolean;
  reason?: BudgetRejectionReason;
  snapshot: SharedBudgetSnapshotV1;
}

export interface SharedBudgetParticipantState {
  limits: Record<BudgetResource, number>;
  used: Record<BudgetResource, number>;
  canUseFinalizationReserve: boolean;
}

export interface SharedBudgetSnapshotV1 {
  version: 1;
  limits: Record<BudgetResource, number> & {
    finalizationReserveModelSteps: number;
  };
  used: Record<BudgetResource, number>;
  participants: Record<string, SharedBudgetParticipantState>;
}

/**
 * Synchronous all-or-nothing accounting. JavaScript cannot interleave two
 * calls while one is executing, so validating and committing in one turn
 * makes concurrent worker attempts atomic without locks or awaits.
 */
export class SharedBudget {
  private readonly limits: SharedBudgetSnapshotV1["limits"];
  private readonly used = emptyCounters();
  private readonly participants = new Map<string, SharedBudgetParticipantState>();

  constructor(limits: SharedBudgetLimits) {
    this.limits = {
      modelSteps: normalizeLimit(limits.modelSteps),
      toolCalls: normalizeLimit(limits.toolCalls),
      wallClockMs: normalizeLimit(limits.wallClockMs),
      finalizationReserveModelSteps: Math.min(
        normalizeLimit(limits.modelSteps),
        normalizeLimit(limits.finalizationReserveModelSteps ?? 0),
      ),
    };
  }

  registerParticipant(
    participantId: string,
    registration: ParticipantBudgetRegistration,
  ): void {
    const id = participantId.trim();
    if (!id) throw new Error("Participant id is required.");
    if (this.participants.has(id)) {
      throw new Error(`Participant ${id} is already registered.`);
    }
    this.participants.set(id, {
      limits: {
        modelSteps: normalizeLimit(registration.limits.modelSteps),
        toolCalls: normalizeLimit(registration.limits.toolCalls),
        wallClockMs: normalizeLimit(registration.limits.wallClockMs),
      },
      used: emptyCounters(),
      canUseFinalizationReserve:
        registration.canUseFinalizationReserve === true,
    });
  }

  tryConsume(request: BudgetConsumptionRequest): BudgetConsumptionResult {
    return this.tryConsumeMany([request]);
  }

  tryConsumeMany(
    requests: readonly BudgetConsumptionRequest[],
  ): BudgetConsumptionResult {
    const rootDelta = emptyCounters();
    const participantDeltas = new Map<string, Record<BudgetResource, number>>();

    for (const request of requests) {
      const participant = this.participants.get(request.participantId);
      if (!participant) return this.rejected("unknown_participant");
      const amount = request.amount ?? 1;
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return this.rejected("invalid_amount");
      }
      const delta = participantDeltas.get(request.participantId) ?? emptyCounters();
      delta[request.resource] += amount;
      participantDeltas.set(request.participantId, delta);
      rootDelta[request.resource] += amount;

      if (
        participant.used[request.resource] + delta[request.resource] >
        participant.limits[request.resource]
      ) {
        return this.rejected("participant_limit");
      }
      const nextRoot = this.used[request.resource] + rootDelta[request.resource];
      if (nextRoot > this.limits[request.resource]) {
        return this.rejected("root_limit");
      }
      if (request.resource === "modelSteps") {
        const ordinaryLimit =
          this.limits.modelSteps - this.limits.finalizationReserveModelSteps;
        const mayUseReserve =
          request.allowFinalizationReserve === true &&
          participant.canUseFinalizationReserve;
        if (!mayUseReserve && nextRoot > ordinaryLimit) {
          return this.rejected("finalization_reserve");
        }
      }
    }

    for (const resource of RESOURCES) this.used[resource] += rootDelta[resource];
    for (const [participantId, delta] of participantDeltas) {
      const participant = this.participants.get(participantId)!;
      for (const resource of RESOURCES) {
        participant.used[resource] += delta[resource];
      }
    }
    return { accepted: true, snapshot: this.getSnapshot() };
  }

  getSnapshot(): SharedBudgetSnapshotV1 {
    return {
      version: 1,
      limits: { ...this.limits },
      used: { ...this.used },
      participants: Object.fromEntries(
        [...this.participants].map(([id, participant]) => [
          id,
          {
            limits: { ...participant.limits },
            used: { ...participant.used },
            canUseFinalizationReserve: participant.canUseFinalizationReserve,
          },
        ]),
      ),
    };
  }

  toParticipantBudget(participantId: string): AgentParticipantBudget | null {
    const participant = this.participants.get(participantId);
    if (!participant) return null;
    return {
      modelSteps: {
        used: participant.used.modelSteps,
        limit: participant.limits.modelSteps,
      },
      toolCalls: {
        used: participant.used.toolCalls,
        limit: participant.limits.toolCalls,
      },
      wallClockMs: {
        used: participant.used.wallClockMs,
        limit: participant.limits.wallClockMs,
      },
    };
  }

  private rejected(reason: BudgetRejectionReason): BudgetConsumptionResult {
    return { accepted: false, reason, snapshot: this.getSnapshot() };
  }
}

const RESOURCES: readonly BudgetResource[] = [
  "modelSteps",
  "toolCalls",
  "wallClockMs",
];

function emptyCounters(): Record<BudgetResource, number> {
  return { modelSteps: 0, toolCalls: 0, wallClockMs: 0 };
}

function normalizeLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

