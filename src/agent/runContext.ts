import type { ModelChatMessage } from "../model/types";
import type { MissionLedger, MissionEvidence } from "./missionLedger";
import {
  formatContinuationHandoffCompactForPrompt,
  validateContinuationHandoffV1,
  type ContinuationHandoffV1,
} from "./continuationMemory";

export const CHARS_PER_TOKEN_ESTIMATE = 4;
/** Assumed context when Settings → Context window is blank (plugin budget only). */
export const DEFAULT_ASSUMED_NUM_CTX = 49_152;
export const COMPLETION_RESERVE_TOKENS = 1500;
export const KEEP_RECENT_LOOP_STEPS = 6;
/** Compact when estimated prompt chars exceed this fraction of maxPromptChars. */
export const COMPACTION_THRESHOLD_RATIO = 0.85;

const TOOL_SHRINK_CHAR_BUDGET = 1_200;
const PREFIX_SYSTEM_MARKERS =
  /runtime context|mission intent|structured intent|allowed tools|tool authority|mission plan|research plan/i;
const PROOF_CRITICAL_SYSTEM_MARKERS =
  /passage-grounded writeback contract|verified durable mission evidence available for writeback/i;
const TOOL_CHAINING_KEYS = [
  "toolName",
  "status",
  "summary",
  "path",
  "operation",
  "receiptPath",
  "backupPath",
  "id",
  "url",
  "evidenceRefs",
  "receiptRefs",
  "coverage",
  "ok",
  "error",
  "baseHash",
  "sha256",
  "contentHash",
  "passageIds",
  "passageId",
  "sourceId",
  "truncated",
] as const;

export interface RunContextBudget {
  numCtx: number | null;
  maxPromptChars: number;
  /** Whether maxPromptChars came from settings.numCtx, the model-reported context window, or the 48k assumption. */
  budgetSource: "setting" | "model_reported" | "assumed_48k";
}

/** Proof-critical excerpts retained across compaction for repair loops. */
export interface CompactionProofExcerpts {
  validationDiagnostic?: {
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
    redactedLines?: number;
  };
  receiptFingerprints?: readonly string[];
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

export function createRunContextBudget(
  numCtx: number | null,
  budgetSource?: RunContextBudget["budgetSource"],
): RunContextBudget {
  const resolvedNumCtx = numCtx ?? DEFAULT_ASSUMED_NUM_CTX;
  const usableTokens = Math.max(
    1024,
    resolvedNumCtx - COMPLETION_RESERVE_TOKENS,
  );
  return {
    numCtx,
    maxPromptChars: usableTokens * CHARS_PER_TOKEN_ESTIMATE,
    budgetSource:
      budgetSource ?? (numCtx === null ? "assumed_48k" : "setting"),
  };
}

/**
 * Where the run's context budget came from: an explicit Settings value wins,
 * then the model-reported context window, then the 48k assumption. A non-null
 * resolved numCtx without either source (the set-loose floor) reports as
 * "setting" to match the pre-existing display behavior.
 */
export function resolveRunContextBudgetSource(input: {
  settingsNumCtx: number | null | undefined;
  modelReportedContextLength: number | null;
  resolvedNumCtx: number | null;
}): RunContextBudget["budgetSource"] {
  if (
    typeof input.settingsNumCtx === "number" &&
    Number.isFinite(input.settingsNumCtx) &&
    input.settingsNumCtx > 0
  ) {
    return "setting";
  }
  if (input.resolvedNumCtx === null) {
    return "assumed_48k";
  }
  return input.modelReportedContextLength !== null
    ? "model_reported"
    : "setting";
}

/** Recent tool-loop turns retained before falling back to 3 → 1 → 0. */
export function resolveKeepRecentLoopSteps(maxPromptChars?: number): number {
  if (typeof maxPromptChars !== "number" || !Number.isFinite(maxPromptChars)) {
    return KEEP_RECENT_LOOP_STEPS;
  }
  if (maxPromptChars >= 300_000) {
    return 16;
  }
  if (maxPromptChars >= 100_000) {
    return 10;
  }
  return KEEP_RECENT_LOOP_STEPS;
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
  return (
    estimatePromptChars(messages) >
    budget.maxPromptChars * COMPACTION_THRESHOLD_RATIO
  );
}

export function compactLoopMessages({
  messages,
  ledger,
  keepRecentSteps,
  maxPromptChars,
  handoff,
  proofExcerpts,
}: {
  messages: ModelChatMessage[];
  ledger: MissionLedger;
  keepRecentSteps?: number;
  maxPromptChars?: number;
  handoff?: ContinuationHandoffV1;
  proofExcerpts?: CompactionProofExcerpts;
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

  const resolvedKeepRecent =
    keepRecentSteps ?? resolveKeepRecentLoopSteps(maxPromptChars);
  const attempts = [...new Set([resolvedKeepRecent, 3, 1, 0])].filter(
    (steps) => steps >= 0 && steps <= resolvedKeepRecent,
  );
  type CompactionCandidate = {
    messages: ModelChatMessage[];
    missionStateMessage: string | null;
    compactedToolMessages: number;
    estimatedCharsAfter: number;
  };
  const candidates: CompactionCandidate[] = [];

  const fitsBudget = (estimatedCharsAfter: number): boolean =>
    estimatedCharsAfter < estimatedCharsBefore &&
    (maxPromptChars === undefined || estimatedCharsAfter <= maxPromptChars);

  // Payload-first: shrink oversized tool bodies while keeping the full turn
  // structure before dropping older loop steps. Do not append mission state
  // here — that projection is for turn-drop candidates only.
  {
    let shrunkToolMessages = 0;
    const payloadShrunk = messages.map((message) => {
      if (message.role !== "tool") {
        return message;
      }
      const shrunk = shrinkToolMessageForCompaction(message, true);
      if (shrunk.content !== message.content) {
        shrunkToolMessages += 1;
      }
      return shrunk;
    });
    if (shrunkToolMessages > 0) {
      const estimatedCharsAfter = estimatePromptChars(payloadShrunk);
      const candidate: CompactionCandidate = {
        messages: payloadShrunk,
        missionStateMessage: null,
        compactedToolMessages: shrunkToolMessages,
        estimatedCharsAfter,
      };
      candidates.push(candidate);
      if (fitsBudget(estimatedCharsAfter)) {
        return {
          applied: true,
          ...candidate,
          estimatedCharsBefore,
        };
      }
    }
  }

  for (const retainedSteps of attempts) {
    const recentStart = findRecentLoopStart(messages, retainedSteps);
    const maxAuthorityBlocks = retainedSteps >= 3 ? 6 : retainedSteps >= 1 ? 3 : 1;
    const prefix = keepPrefixMessages(messages, recentStart, maxAuthorityBlocks);
    const recent = messages.slice(recentStart);
    const compactedToolMessages = messages
      .slice(0, recentStart)
      .filter((message) => message.role === "tool").length;
    const missionStateMessage = buildMissionStateMessage(
      ledger,
      compactedToolMessages,
      handoff,
      proofExcerpts,
    );
    const compactedMessages = [
      ...prefix,
      { role: "system" as const, content: missionStateMessage },
      ...recent,
    ];
    const estimatedCharsAfter = estimatePromptChars(compactedMessages);
    const candidate: CompactionCandidate = {
      messages: compactedMessages,
      missionStateMessage,
      compactedToolMessages,
      estimatedCharsAfter,
    };
    candidates.push(candidate);
    if (fitsBudget(estimatedCharsAfter)) {
      return {
        applied: true,
        ...candidate,
        estimatedCharsBefore,
      };
    }
  }

  let best: CompactionCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.estimatedCharsAfter < best.estimatedCharsAfter) {
      best = candidate;
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
  maxAuthorityBlocks = 6,
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

  const authorityIndexes: number[] = [];
  let latestProofCriticalSystemIndex = -1;
  for (let index = 1; index < recentStart; index += 1) {
    const message = messages[index];
    if (
      message.role === "system" &&
      PROOF_CRITICAL_SYSTEM_MARKERS.test(message.content)
    ) {
      latestProofCriticalSystemIndex = index;
    }
    if (
      message.role === "system" &&
      PREFIX_SYSTEM_MARKERS.test(message.content)
    ) {
      authorityIndexes.push(index);
    }
  }
  for (const index of authorityIndexes.slice(-Math.max(1, maxAuthorityBlocks))) {
    add(index);
  }
  add(latestProofCriticalSystemIndex);

  const latestUserBeforeRecent = findLastIndex(
    messages.slice(0, recentStart),
    (message) => message.role === "user",
  );
  add(latestUserBeforeRecent);
  return prefix.sort(
    (left, right) => messages.indexOf(left) - messages.indexOf(right),
  );
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
  proofExcerpts?: CompactionProofExcerpts,
): string {
  const evidence = ledger.evidence.slice(-12).map(formatEvidence);
  const milestones = ledger.milestones.slice(-10).map((item) => {
    const toolText = item.toolCalls?.length
      ? ` tools=${item.toolCalls.join(",")}`
      : "";
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
  const proofSection = formatProofExcerptsForCompaction(proofExcerpts, receipts);
  return [
    "Compacted mission state from durable ledger.",
    `Run id: ${ledger.runId}`,
    `Mission: ${ledger.mission}`,
    `Status: ${ledger.status}`,
    `Compacted earlier tool messages: ${compactedToolMessages}`,
    handoff ? formatContinuationHandoffCompactForPrompt(handoff) : null,
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
    proofSection,
    "Recent milestones:",
    milestones.length ? milestones.join("\n") : "none",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatProofExcerptsForCompaction(
  proofExcerpts: CompactionProofExcerpts | undefined,
  ledgerReceiptIds: readonly string[] = [],
): string | null {
  if (!proofExcerpts) return null;
  const lines: string[] = [
    "Proof-critical excerpts retained across compaction:",
  ];
  const receiptFingerprints = [
    ...(proofExcerpts.receiptFingerprints ?? []),
  ].filter(
    (value, index, values) =>
      Boolean(value?.trim()) && values.indexOf(value) === index,
  );
  if (receiptFingerprints.length > 0) {
    lines.push(
      `Receipt fingerprints: ${receiptFingerprints.slice(-12).join(", ")}`,
    );
  } else if (ledgerReceiptIds.length > 0) {
    lines.push(
      `Receipt fingerprints: ${ledgerReceiptIds.slice(-12).join(", ")}`,
    );
  }
  const diagnostic = proofExcerpts.validationDiagnostic;
  const stdout = diagnostic?.stdout?.trim() ?? "";
  const stderr = diagnostic?.stderr?.trim() ?? "";
  if (stdout || stderr) {
    lines.push("Latest red validation diagnostic:");
    if (stdout) {
      lines.push(
        truncateContextLine(`stdout=${JSON.stringify(stdout)}`, 2_400),
      );
    }
    if (stderr) {
      lines.push(
        truncateContextLine(`stderr=${JSON.stringify(stderr)}`, 2_400),
      );
    }
    if (diagnostic?.truncated === true) {
      lines.push("diagnostic_truncated=true");
    }
    if (
      typeof diagnostic?.redactedLines === "number" &&
      diagnostic.redactedLines > 0
    ) {
      lines.push(`diagnostic_redacted_lines=${diagnostic.redactedLines}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

function shrinkToolMessageForCompaction(
  message: ModelChatMessage,
  enabled: boolean,
): ModelChatMessage {
  if (!enabled || message.role !== "tool") {
    return message;
  }
  if (message.content.length <= TOOL_SHRINK_CHAR_BUDGET) {
    return message;
  }

  try {
    const parsed: unknown = JSON.parse(message.content);
    if (isRecord(parsed)) {
      const slim: Record<string, unknown> = { truncated: true };
      for (const key of TOOL_CHAINING_KEYS) {
        if (key in parsed) {
          slim[key] = parsed[key];
        }
      }
      if (isRecord(parsed.output)) {
        const outputSlim: Record<string, unknown> = {};
        for (const key of TOOL_CHAINING_KEYS) {
          if (key in parsed.output) {
            outputSlim[key] = parsed.output[key];
          }
        }
        if (Object.keys(outputSlim).length > 0) {
          slim.output = outputSlim;
        }
      }
      const contentEvidence = compactContentEvidenceForCompaction(parsed);
      if (contentEvidence) {
        slim.contentEvidence = contentEvidence;
      }
      const serialized = JSON.stringify(slim);
      if (
        serialized.length < message.content.length &&
        serialized.length > 2
      ) {
        return {
          ...message,
          content:
            serialized.length <= TOOL_SHRINK_CHAR_BUDGET
              ? serialized
              : truncateContextLine(serialized, TOOL_SHRINK_CHAR_BUDGET),
        };
      }
    }
  } catch {
    // Fall through to plain truncation.
  }

  return {
    ...message,
    content: truncateContextLine(message.content, TOOL_SHRINK_CHAR_BUDGET),
  };
}

function compactContentEvidenceForCompaction(
  value: unknown,
): { passages: Record<string, unknown>[] } | null {
  const passages: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6 || passages.length >= 2) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 8)) {
        visit(item, depth + 1);
        if (passages.length >= 2) return;
      }
      return;
    }
    if (!isRecord(candidate)) return;

    if (
      isRecord(candidate.contentEvidence) &&
      Array.isArray(candidate.contentEvidence.passages)
    ) {
      for (const passage of candidate.contentEvidence.passages) {
        if (!isRecord(passage)) continue;
        const id = typeof passage.id === "string" ? passage.id : "";
        if (!id || seenIds.has(id)) continue;
        const compact: Record<string, unknown> = { id };
        for (const key of ["start", "end", "sourceId", "sourceLocator"] as const) {
          if (passage[key] !== undefined) compact[key] = passage[key];
        }
        if (typeof passage.text === "string") {
          compact.text = truncateContextLine(passage.text, 300);
        }
        passages.push(compact);
        seenIds.add(id);
        if (passages.length >= 2) return;
      }
    }

    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "contentEvidence") continue;
      visit(nested, depth + 1);
      if (passages.length >= 2) return;
    }
  };

  visit(value, 0);
  return passages.length > 0 ? { passages } : null;
}

function formatEvidence(item: MissionEvidence): string {
  const locator = item.path ?? item.url ?? item.id;
  const passageIds = [item.passageId, ...(item.passageIds ?? [])].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
  const citations =
    passageIds.length > 0
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

function findLastIndex<T>(
  values: T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) {
      return index;
    }
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
