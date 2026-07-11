import type { MissionPlan, MissionPlanAction } from "./missionPlan";
import {
  advanceMissionPlanFromBlocker,
  type MissionPlanAdvanceResult,
} from "./missionPlanAdvance";
import { formatFailureCopy, phaseGateFailureCopy, policyBlockFailureCopy } from "./failureCopy";

export interface RecoveryInput {
  plan: MissionPlan;
  reason: "tool_failed" | "stalled" | "missing_proof" | "policy_blocked" | "model_offtrack";
  failedAction?: string;
  allowedToolNames: string[];
  attemptedActions: string[];
  maxAttemptsPerNode?: number;
}

export interface RecoveryAttempt {
  id: string;
  nodeId?: string;
  reason: RecoveryInput["reason"];
  failedAction?: string;
  selectedAction: MissionPlanAction;
  status: "planned" | "applied" | "failed" | "exhausted";
  message: string;
}

export interface RecoveryDecision {
  status: "recover" | "block" | "continue";
  attempts: RecoveryAttempt[];
  updatedAction?: MissionPlanAction;
  blocker?: string;
}

export function planRecovery(input: RecoveryInput): RecoveryDecision {
  const active = input.plan.tasks.find((task) => task.id === input.plan.activeTaskId) ??
    input.plan.tasks.find((task) => task.status !== "complete" && task.status !== "blocked");
  if (!active) {
    return { status: "continue", attempts: [] };
  }
  const attemptsForNode = input.attemptedActions.filter((item) =>
    item.startsWith(`${active.id}:`),
  ).length;
  const maxAttempts = input.maxAttemptsPerNode ?? 2;
  if (attemptsForNode >= maxAttempts || input.reason === "policy_blocked") {
    return {
      status: "block",
      attempts: [],
      blocker:
        input.reason === "policy_blocked"
          ? formatFailureCopy(
              /phase|gather|analyze/i.test(
                `${input.failedAction ?? ""} ${input.plan.activeTaskId ?? ""}`,
              )
                ? phaseGateFailureCopy(
                    undefined,
                    "The active safety policy does not allow this write until research proof unlocks the phase.",
                  )
                : policyBlockFailureCopy(
                    input.failedAction ?? "requested action",
                    "The active safety policy does not allow this action without a safer scope or approval.",
                  ),
            )
          : formatFailureCopy({
              what: "Recovery attempts were exhausted for the active mission task.",
              why: `The runner already tried ${attemptsForNode} alternate path(s) for this node.`,
              next: "Inspect Run Details, adjust the mission scope, then continue from the saved ledger.",
            }),
    };
  }
  const alternative = chooseAlternativeTool(input.allowedToolNames, input.failedAction);
  if (!alternative) {
    return {
      status: "block",
      attempts: [],
      blocker: formatFailureCopy({
        what: "No alternate allowed tool is available for recovery.",
        why: "The remaining tool set cannot replace the failed or stalled action.",
        next: "Broaden allowed tools or change the mission approach, then continue from the saved ledger.",
      }),
    };
  }
  const action: MissionPlanAction = {
    kind: "tool",
    taskId: active.id,
    toolName: alternative,
    summary: `Recover by using ${alternative} instead of repeating ${input.failedAction ?? "the stalled action"}.`,
  };
  return {
    status: "recover",
    updatedAction: action,
    attempts: [
      {
        id: `recovery-${active.id}-${attemptsForNode + 1}`,
        nodeId: active.id,
        reason: input.reason,
        failedAction: input.failedAction,
        selectedAction: action,
        status: "planned",
        message: action.summary,
      },
    ],
  };
}

export function applyRecoveryToPlan(
  plan: MissionPlan,
  decision: RecoveryDecision,
): MissionPlan {
  if (decision.status === "block") {
    const activeTaskId = plan.activeTaskId;
    return {
      ...plan,
      status: "blocked",
      tasks: plan.tasks.map((task) =>
        task.id === activeTaskId ? { ...task, status: "blocked", blocker: decision.blocker } : task,
      ),
      nextAction: {
        kind: "blocker",
        taskId: activeTaskId ?? undefined,
        summary: decision.blocker ?? "Recovery blocked.",
      },
    };
  }
  return decision.updatedAction ? { ...plan, nextAction: decision.updatedAction } : plan;
}

function chooseAlternativeTool(
  allowedToolNames: string[],
  failedAction?: string,
): string | undefined {
  const readFallbacks = [
    "web_search",
    "web_fetch",
    "semantic_search_notes",
    "inspect_vault_context",
    "read_markdown_files",
    "read_file",
    "list_markdown_files",
  ];
  return readFallbacks.find(
    (tool) => allowedToolNames.includes(tool) && tool !== failedAction,
  );
}

export type BoundedRecoveryAction = "retry" | "replan" | "block";

export interface BoundedRecoveryAttempt {
  signature: string;
  action: BoundedRecoveryAction;
  reason: string;
  createdAt: string;
}

export interface RecoveryState {
  version: 1;
  attempts: BoundedRecoveryAttempt[];
  maxAttempts: number;
  maxStoredAttempts: number;
  totalAttempts: number;
  signatureCounts: Record<string, number>;
  updatedAt: string;
}

export interface BoundedRecoveryInput {
  plan: MissionPlan;
  failure: {
    source: string;
    message: string;
    retryable?: boolean;
    requiresReplan?: boolean;
  };
  state?: RecoveryState;
  maxAttempts?: number;
  maxStoredAttempts?: number;
  now?: Date;
}

export interface BoundedRecoveryDecision {
  action: BoundedRecoveryAction;
  signature: string;
  attemptsUsed: number;
  attemptsRemaining: number;
  reason: string;
  state: RecoveryState;
  planAdvance?: MissionPlanAdvanceResult;
}

export function decideRecoveryAction({
  plan,
  failure,
  state,
  maxAttempts,
  maxStoredAttempts,
  now = new Date(),
}: BoundedRecoveryInput): BoundedRecoveryDecision {
  const signature = getFailureSignature(failure.source, failure.message);
  const previousState = normalizeRecoveryState(state, {
    maxAttempts: maxAttempts ?? state?.maxAttempts ?? 2,
    maxStoredAttempts:
      maxStoredAttempts ?? state?.maxStoredAttempts ?? DEFAULT_MAX_STORED_ATTEMPTS,
    now,
  });
  const previousAttempts = previousState.attempts;
  const attemptsUsed = previousState.signatureCounts[signature] ?? 0;
  const boundedMaxAttempts = Math.max(
    0,
    Math.floor(maxAttempts ?? previousState.maxAttempts),
  );
  const boundedMaxStoredAttempts = normalizeMaxStoredAttempts(
    maxStoredAttempts ?? previousState.maxStoredAttempts,
  );
  const action = chooseBoundedRecoveryAction({
    attemptsUsed,
    maxAttempts: boundedMaxAttempts,
    retryable: failure.retryable !== false,
    requiresReplan: failure.requiresReplan === true,
  });
  const reason =
    action === "block"
      ? `Recovery attempts exhausted for ${failure.source}.`
      : action === "replan"
        ? `Replan around ${failure.source}: ${failure.message}`
        : `Retry ${failure.source}: ${failure.message}`;
  const attempt: BoundedRecoveryAttempt = {
    signature,
    action,
    reason,
    createdAt: now.toISOString(),
  };
  const attempts = [...previousAttempts, attempt].slice(
    -boundedMaxStoredAttempts,
  );
  const signatureCounts = boundSignatureCounts(
    {
      ...previousState.signatureCounts,
      [signature]: attemptsUsed + 1,
    },
    attempts,
    boundedMaxStoredAttempts,
  );
  const nextState: RecoveryState = {
    version: 1,
    maxAttempts: boundedMaxAttempts,
    maxStoredAttempts: boundedMaxStoredAttempts,
    totalAttempts: previousState.totalAttempts + 1,
    signatureCounts,
    attempts,
    updatedAt: now.toISOString(),
  };
  return {
    action,
    signature,
    attemptsUsed: attemptsUsed + 1,
    attemptsRemaining: Math.max(0, boundedMaxAttempts - attemptsUsed - 1),
    reason,
    state: nextState,
    planAdvance:
      action === "block"
        ? advanceMissionPlanFromBlocker({ plan, blocker: reason, now })
        : undefined,
  };
}

export const DEFAULT_MAX_STORED_ATTEMPTS = 32;

export function createRecoveryState({
  maxAttempts = 2,
  maxStoredAttempts = DEFAULT_MAX_STORED_ATTEMPTS,
  now = new Date(),
}: {
  maxAttempts?: number;
  maxStoredAttempts?: number;
  now?: Date;
} = {}): RecoveryState {
  return {
    version: 1,
    attempts: [],
    maxAttempts: Math.max(0, Math.floor(maxAttempts)),
    maxStoredAttempts: normalizeMaxStoredAttempts(maxStoredAttempts),
    totalAttempts: 0,
    signatureCounts: {},
    updatedAt: now.toISOString(),
  };
}

/**
 * Normalizes both the persisted v1 recovery state and the pre-v1 shape that
 * only contained `attempts` and `maxAttempts`. The retained attempt log and
 * signature counters are independently bounded so a long mission cannot grow
 * this state without limit.
 */
export function normalizeRecoveryState(
  value: unknown,
  defaults: {
    maxAttempts?: number;
    maxStoredAttempts?: number;
    now?: Date;
  } = {},
): RecoveryState {
  const now = defaults.now ?? new Date();
  if (!isRecord(value)) {
    return createRecoveryState({ ...defaults, now });
  }

  const maxAttempts = Math.max(
    0,
    Math.floor(getFiniteNumber(value.maxAttempts) ?? defaults.maxAttempts ?? 2),
  );
  const maxStoredAttempts = normalizeMaxStoredAttempts(
    getFiniteNumber(value.maxStoredAttempts) ??
      defaults.maxStoredAttempts ??
      DEFAULT_MAX_STORED_ATTEMPTS,
  );
  const allNormalizedAttempts = (Array.isArray(value.attempts) ? value.attempts : [])
    .map(normalizeRecoveryAttempt)
    .filter((attempt): attempt is BoundedRecoveryAttempt => attempt !== null);
  const attempts = allNormalizedAttempts.slice(-maxStoredAttempts);
  const rawSignatureCounts = isRecord(value.signatureCounts)
    ? Object.entries(value.signatureCounts).reduce<Record<string, number>>(
        (output, [signature, count]) => {
          const normalizedCount = getFiniteNumber(count);
          if (signature.trim() && normalizedCount !== undefined && normalizedCount >= 0) {
            output[signature] = Math.floor(normalizedCount);
          }
          return output;
        },
        {},
      )
    : allNormalizedAttempts.reduce<Record<string, number>>((output, attempt) => {
        output[attempt.signature] = (output[attempt.signature] ?? 0) + 1;
        return output;
      }, {});
  const totalAttempts = Math.max(
    allNormalizedAttempts.length,
    Math.floor(
      getFiniteNumber(value.totalAttempts) ?? allNormalizedAttempts.length,
    ),
  );

  return {
    version: 1,
    attempts,
    maxAttempts,
    maxStoredAttempts,
    totalAttempts,
    signatureCounts: boundSignatureCounts(
      rawSignatureCounts,
      attempts,
      maxStoredAttempts,
    ),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : now.toISOString(),
  };
}

export function shouldAttemptRecovery(decision: BoundedRecoveryDecision): boolean {
  return decision.action === "retry" || decision.action === "replan";
}

function chooseBoundedRecoveryAction({
  attemptsUsed,
  maxAttempts,
  retryable,
  requiresReplan,
}: {
  attemptsUsed: number;
  maxAttempts: number;
  retryable: boolean;
  requiresReplan: boolean;
}): BoundedRecoveryAction {
  if (!retryable || attemptsUsed >= maxAttempts) {
    return "block";
  }
  return requiresReplan || attemptsUsed > 0 ? "replan" : "retry";
}

function getFailureSignature(source: string, message: string): string {
  return `${source}:${message.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160)}`;
}

function normalizeRecoveryAttempt(value: unknown): BoundedRecoveryAttempt | null {
  if (!isRecord(value)) {
    return null;
  }
  const signature = typeof value.signature === "string" ? value.signature : "";
  const action = value.action;
  const reason = typeof value.reason === "string" ? value.reason : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (
    !signature.trim() ||
    (action !== "retry" && action !== "replan" && action !== "block") ||
    !reason.trim() ||
    !createdAt.trim()
  ) {
    return null;
  }
  return { signature, action, reason, createdAt };
}

function boundSignatureCounts(
  counts: Record<string, number>,
  attempts: BoundedRecoveryAttempt[],
  maxStoredAttempts: number,
): Record<string, number> {
  const maxSignatures = Math.max(8, maxStoredAttempts * 2);
  const recentSignatures = new Set(
    attempts.map((attempt) => attempt.signature).reverse(),
  );
  const ordered = [
    ...recentSignatures,
    ...Object.keys(counts).reverse().filter((key) => !recentSignatures.has(key)),
  ].slice(0, maxSignatures);
  return ordered.reduce<Record<string, number>>((output, signature) => {
    const count = counts[signature];
    if (Number.isFinite(count) && count >= 0) {
      output[signature] = Math.floor(count);
    }
    return output;
  }, {});
}

function normalizeMaxStoredAttempts(value: number): number {
  return Math.min(256, Math.max(1, Math.floor(value)));
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
