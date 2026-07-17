import type { ModelChatMessage } from "../model/types";
import type { MissionLedger, MissionEvidence } from "./missionLedger";
import {
  formatContinuationHandoffForPrompt,
  validateContinuationHandoffV1,
  type ContinuationHandoffV1,
} from "./continuationMemory";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const DEFAULT_ASSUMED_NUM_CTX = 8192;
export const COMPLETION_RESERVE_TOKENS = 1500;
export const KEEP_RECENT_LOOP_STEPS = 6;

export interface RunContextBudget {
  numCtx: number | null;
  maxPromptChars: number;
}

export interface LoopCompactionResult {
  applied: boolean;
  messages: ModelChatMessage[];
  missionStateMessage: string | null;
  compactedToolMessages: number;
  estimatedCharsBefore: number;
  estimatedCharsAfter: number;
  rejectionReason?: "invalid_handoff" | "non_reducing";
}

export function createRunContextBudget(numCtx: number | null): RunContextBudget {
  const usableTokens = Math.max(
    1024,
    (numCtx ?? DEFAULT_ASSUMED_NUM_CTX) - COMPLETION_RESERVE_TOKENS,
  );
  return {
    numCtx,
    maxPromptChars: usableTokens * CHARS_PER_TOKEN_ESTIMATE,
  };
}

export function estimatePromptChars(messages: ModelChatMessage[]): number {
  return messages.reduce((sum, message) => {
    return (
      sum +
      message.role.length +
      message.content.length +
      (message.thinking?.length ?? 0) +
      (message.toolName?.length ?? 0) +
      (message.toolCallId?.length ?? 0) +
      (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0) +
      32
    );
  }, 0);
}

export function shouldCompactLoopMessages(
  messages: ModelChatMessage[],
  budget: RunContextBudget,
): boolean {
  return estimatePromptChars(messages) > budget.maxPromptChars;
}

export function compactLoopMessages({
  messages,
  ledger,
  keepRecentSteps = KEEP_RECENT_LOOP_STEPS,
  maxPromptChars,
  handoff,
}: {
  messages: ModelChatMessage[];
  ledger: MissionLedger;
  keepRecentSteps?: number;
  maxPromptChars?: number;
  handoff?: ContinuationHandoffV1;
}): LoopCompactionResult {
  const estimatedCharsBefore = estimatePromptChars(messages);
  if (handoff && !validateContinuationHandoffV1(handoff).ok) {
    return {
      applied: false,
      messages: [...messages],
      missionStateMessage: null,
      compactedToolMessages: 0,
      estimatedCharsBefore,
      estimatedCharsAfter: estimatedCharsBefore,
      rejectionReason: "invalid_handoff",
    };
  }
  const attempts = [...new Set([keepRecentSteps, 3, 1, 0])]
    .filter((steps) => steps >= 0 && steps <= keepRecentSteps);
  let best: Omit<LoopCompactionResult, "applied" | "estimatedCharsBefore"> | null = null;

  for (const retainedSteps of attempts) {
    const recentStart = findRecentLoopStart(messages, retainedSteps);
    const prefix = keepPrefixMessages(messages, recentStart);
    const recent = messages.slice(recentStart);
    const compactedToolMessages = messages
      .slice(0, recentStart)
      .filter((message) => message.role === "tool").length;
    const missionStateMessage = buildMissionStateMessage(
      ledger,
      compactedToolMessages,
      handoff,
    );
    const compactedMessages = [
      ...prefix,
      { role: "system" as const, content: missionStateMessage },
      ...recent,
    ];
    const estimatedCharsAfter = estimatePromptChars(compactedMessages);
    const candidate = {
      messages: compactedMessages,
      missionStateMessage,
      compactedToolMessages,
      estimatedCharsAfter,
    };
    if (!best || estimatedCharsAfter < best.estimatedCharsAfter) {
      best = candidate;
    }
    if (
      estimatedCharsAfter < estimatedCharsBefore &&
      (maxPromptChars === undefined || estimatedCharsAfter <= maxPromptChars)
    ) {
      return {
        applied: true,
        ...candidate,
        estimatedCharsBefore,
      };
    }
  }

  if (best && best.estimatedCharsAfter < estimatedCharsBefore) {
    return {
      applied: true,
      ...best,
      estimatedCharsBefore,
    };
  }

  return {
    applied: false,
    messages: [...messages],
    missionStateMessage: null,
    compactedToolMessages: 0,
    estimatedCharsBefore,
    estimatedCharsAfter: estimatedCharsBefore,
    rejectionReason: "non_reducing",
  };
}

function keepPrefixMessages(
  messages: ModelChatMessage[],
  recentStart: number,
): ModelChatMessage[] {
  const prefix: ModelChatMessage[] = [];
  const seen = new Set<number>();
  const add = (index: number) => {
    if (index >= 0 && index < recentStart && !seen.has(index)) {
      seen.add(index);
      prefix.push(messages[index]);
    }
  };

  if (messages[0]?.role === "system") add(0);

  for (let index = recentStart - 1; index > 0; index -= 1) {
    const message = messages[index];
    if (
      message.role === "system" &&
      /runtime context|mission intent|structured intent|allowed tools|tool authority/i.test(
        message.content,
      )
    ) {
      add(index);
      break;
    }
  }

  const latestUserBeforeRecent = findLastIndex(
    messages.slice(0, recentStart),
    (message) => message.role === "user",
  );
  add(latestUserBeforeRecent);
  return prefix.sort((left, right) => messages.indexOf(left) - messages.indexOf(right));
}

function findRecentLoopStart(
  messages: ModelChatMessage[],
  keepRecentSteps: number,
): number {
  if (keepRecentSteps <= 0) {
    return messages.length;
  }
  let loopBoundaries = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      loopBoundaries += 1;
      if (loopBoundaries >= keepRecentSteps) {
        return index;
      }
    }
  }
  return Math.max(0, messages.length - Math.max(keepRecentSteps * 2, 8));
}

function buildMissionStateMessage(
  ledger: MissionLedger,
  compactedToolMessages: number,
  handoff?: ContinuationHandoffV1,
): string {
  const evidence = ledger.evidence.slice(-12).map(formatEvidence);
  const milestones = ledger.milestones.slice(-10).map((item) => {
    const toolText = item.toolCalls?.length ? ` tools=${item.toolCalls.join(",")}` : "";
    const evidenceText = item.evidenceIds?.length
      ? ` evidence=${item.evidenceIds.join(",")}`
      : "";
    return truncateContextLine(
      `- step ${item.step} ${item.stage}: ${item.summary}${toolText}${evidenceText}`,
      360,
    );
  });
  const receipts = ledger.receipts.slice(-12);
  const plan = ledger.missionPlan;
  return [
    "Compacted mission state from durable ledger.",
    `Run id: ${ledger.runId}`,
    `Mission: ${ledger.mission}`,
    `Status: ${ledger.status}`,
    `Compacted earlier tool messages: ${compactedToolMessages}`,
    handoff ? formatContinuationHandoffForPrompt(handoff) : null,
    `Route: ${ledger.route}`,
    `Expected tools: ${ledger.loopBudget.expectedTools.join(", ") || "none"}`,
    `Acceptance: ${ledger.acceptance?.status ?? "unchecked"}`,
    `Acceptance missing: ${ledger.acceptance?.missing.join(", ") || "none"}`,
    plan
      ? `Mission plan: ${plan.status}; active=${plan.activeTaskId ?? "none"}; remaining=${plan.progress.remainingTasks}; next=${plan.nextAction?.summary ?? "none"}`
      : "Mission plan: none",
    `Next actions: ${ledger.nextActions.join("; ") || "none"}`,
    `Remaining actions: ${ledger.remainingActions.join("; ") || "none"}`,
    `Blockers: ${ledger.blockers.join("; ") || "none"}`,
    "Evidence:",
    evidence.length ? evidence.join("\n") : "none",
    "Receipts:",
    receipts.length ? receipts.map((id) => `- ${id}`).join("\n") : "none",
    "Recent milestones:",
    milestones.length ? milestones.join("\n") : "none",
  ].filter((line): line is string => line !== null).join("\n");
}

function formatEvidence(item: MissionEvidence): string {
  const locator = item.path ?? item.url ?? item.id;
  const passageIds = [
    item.passageId,
    ...(item.passageIds ?? []),
  ].filter((value, index, values): value is string =>
    Boolean(value) && values.indexOf(value) === index,
  );
  const citations = passageIds.length > 0
    ? `; passage_citations=${passageIds.join(",")}`
    : item.sourceId
      ? `; source_id=${item.sourceId}`
      : "";
  return truncateContextLine(
    `- ${item.id}: ${item.title} (${item.kind}; ${item.confidence}; ${locator}${citations}) ${item.summary}`,
    520,
  );
}

function truncateContextLine(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 13)).trimEnd()}…[truncated]`;
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index;
    }
  }
  return -1;
}
