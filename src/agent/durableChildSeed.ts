import type { ToolExecutionContext } from "../tools/types";
import { MAX_AGENT_STEPS } from "../tools/constants";
import {
  createMissionLedger,
  readMissionLedgerByRunId,
  writeMissionLedger,
  type MissionLedger,
} from "./missionLedger";
import {
  createMissionRuntimeSnapshot,
  readMissionRuntimeSnapshotByRunId,
  writeMissionRuntimeSnapshot,
} from "./runStore";

export interface DurableChildSeedInput {
  childRunId: string;
  rootMissionId: string;
  mission: string;
  currentNotePath?: string | null;
  parentSegmentId?: string;
  segmentIndex: number;
  priorSegmentIds: string[];
  remainingModelSteps: number;
  remainingToolCalls: number;
  now?: Date;
}

/**
 * Creates an exact child ledger and runtime snapshot before the durable root
 * points at that child. A crash can therefore resume only this child (with its
 * inherited proof/WAL state), never an unrelated newest Agent Runs file.
 */
export async function seedDurableChildRun(
  context: ToolExecutionContext,
  input: DurableChildSeedInput,
): Promise<void> {
  const now = input.now ?? context.now?.() ?? new Date();
  const priorLedger = input.parentSegmentId
    ? (await readMissionLedgerByRunId(context, input.parentSegmentId))?.ledger
    : undefined;
  const priorRuntime = input.parentSegmentId
    ? (await readMissionRuntimeSnapshotByRunId(context, input.parentSegmentId))
        ?.snapshot
    : undefined;
  const hardCap = Math.max(
    1,
    Math.min(MAX_AGENT_STEPS, Math.floor(input.remainingModelSteps)),
  );
  const toolCap = Math.max(0, Math.floor(input.remainingToolCalls));
  const ledger = priorLedger
    ? cloneLedgerForChild(priorLedger, input.childRunId, hardCap, toolCap, now)
    : createMissionLedger({
        runId: input.childRunId,
        mission: input.mission,
        route: "durable_segment_seed",
        loopBudget: {
          hardCap,
          toolStepBudget: Math.min(toolCap, hardCap),
          finalizationReserve: Math.min(4, hardCap),
          expectedTools: [],
          stopWhenSatisfied: true,
        },
        now,
      });
  const ledgerWrite = await writeMissionLedger(context, ledger);
  if (!ledgerWrite) {
    throw new Error("Unable to persist the durable child mission ledger.");
  }

  const snapshot = createMissionRuntimeSnapshot({
    runId: input.childRunId,
    originalMission: priorRuntime?.originalMission ?? priorLedger?.mission ?? input.mission,
    currentNotePath:
      priorRuntime?.currentNotePath ?? input.currentNotePath ?? undefined,
    rootRunId: priorRuntime?.lineage.rootRunId ?? input.rootMissionId,
    segmentId: input.childRunId,
    segmentIndex: input.segmentIndex,
    parentSegmentId: input.parentSegmentId,
    priorSegmentIds: input.priorSegmentIds,
    status: "running",
    lastSafeStep: priorRuntime?.lastSafeStep ?? priorLedger?.lastSafeStep ?? 0,
    missionPlan: priorRuntime?.missionPlan ?? priorLedger?.missionPlan,
    researchPlan: priorRuntime?.researchPlan ?? priorLedger?.researchPlan,
    evidence: priorRuntime?.evidence ?? priorLedger?.evidence ?? [],
    receipts: priorRuntime?.receipts ?? [],
    operationGoals: priorRuntime?.operationGoals ?? {},
    recovery: priorRuntime?.recovery,
    operationJournal: priorRuntime?.operationJournal ?? [],
    acceptance: priorRuntime?.acceptance,
    notes: [
      ...(priorRuntime?.notes ?? []),
      `Durable root ${input.rootMissionId} seeded this child before activation.`,
    ],
    createdAt: now,
    updatedAt: now,
  });
  const snapshotWrite = await writeMissionRuntimeSnapshot(context, snapshot);
  if (!snapshotWrite) {
    throw new Error("Unable to persist the durable child runtime snapshot.");
  }
}

function cloneLedgerForChild(
  prior: MissionLedger,
  childRunId: string,
  hardCap: number,
  toolCap: number,
  now: Date,
): MissionLedger {
  const ledger = JSON.parse(JSON.stringify(prior)) as MissionLedger;
  ledger.revision = 0;
  ledger.runId = childRunId;
  ledger.status = "running";
  ledger.updatedAt = now.toISOString();
  ledger.continuationCommand = `continue run ${childRunId}`;
  ledger.loopBudget = {
    ...ledger.loopBudget,
    hardCap: Math.min(hardCap, Math.max(1, ledger.loopBudget.hardCap)),
    toolStepBudget: Math.min(
      toolCap,
      Math.max(0, ledger.loopBudget.toolStepBudget),
    ),
    finalizationReserve: Math.min(
      hardCap,
      Math.max(0, ledger.loopBudget.finalizationReserve),
    ),
  };
  if (ledger.missionPlan) {
    ledger.missionPlan = {
      ...ledger.missionPlan,
      runId: childRunId,
      updatedAt: now.toISOString(),
    };
  }
  return ledger;
}
