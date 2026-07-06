import type { ModelChatMessage } from "../model/types";
import type { AgentConversationMessage } from "../conversationHistory";
import { toConversationModelMessages } from "../conversationHistory";

export const DEFAULT_CONVERSATION_PROMPT_CHAR_BUDGET = 48_000;
export const DEFAULT_CONVERSATION_SUMMARY_CHAR_BUDGET = 4_000;

export interface ConversationCompactionOptions {
  promptCharBudget?: number;
  summaryCharBudget?: number;
}

export interface ConversationCompactionResult {
  messages: AgentConversationMessage[];
  summary: string | null;
  compactedCount: number;
}

export function compactConversationForPrompt(
  history: AgentConversationMessage[],
  {
    promptCharBudget = DEFAULT_CONVERSATION_PROMPT_CHAR_BUDGET,
    summaryCharBudget = DEFAULT_CONVERSATION_SUMMARY_CHAR_BUDGET,
  }: ConversationCompactionOptions = {},
): ConversationCompactionResult {
  const budget = Math.max(0, Math.trunc(promptCharBudget));
  const normalized = history.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.content.trim().length > 0,
  );

  const allChars = getMessagesCharCount(normalized);
  if (allChars <= budget) {
    return {
      messages: normalized,
      summary: null,
      compactedCount: 0,
    };
  }

  const summaryReserve = Math.min(summaryCharBudget, Math.floor(budget / 3));
  const recentBudget = Math.max(0, budget - summaryReserve);
  const compactedRecent = takeRecentMessagesWithinBudget(
    normalized,
    recentBudget,
  );
  const older = normalized.slice(0, normalized.length - compactedRecent.length);
  const summaryMaxChars = Math.max(
    0,
    Math.min(
      summaryCharBudget,
      budget - getMessagesCharCount(compactedRecent),
    ),
  );
  const summary = summarizeOlderConversation(older, summaryMaxChars);

  return {
    messages: compactedRecent,
    summary,
    compactedCount: older.length,
  };
}

export function toCompactedConversationModelMessages(
  result: ConversationCompactionResult,
): ModelChatMessage[] {
  return toConversationModelMessages(result.messages);
}

function takeRecentMessagesWithinBudget(
  messages: AgentConversationMessage[],
  budget: number,
): AgentConversationMessage[] {
  if (budget <= 0) {
    return [];
  }

  const recent: AgentConversationMessage[] = [];
  let chars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const nextChars = chars + message.content.length;
    if (nextChars > budget && recent.length > 0) {
      break;
    }

    if (nextChars > budget) {
      break;
    }

    recent.unshift(message);
    chars = nextChars;
  }

  return recent;
}

function summarizeOlderConversation(
  messages: AgentConversationMessage[],
  maxChars: number,
): string | null {
  if (messages.length === 0) {
    return null;
  }

  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter(
    (message) => message.role === "assistant",
  );
  const lines = [
    "Earlier conversation summary (deterministic, not persisted):",
    `- Compacted messages: ${messages.length} (${userMessages.length} user, ${assistantMessages.length} assistant).`,
    ...formatRoleSnippets("Earlier user requests", userMessages.slice(0, 3)),
    ...formatRoleSnippets("Latest assistant replies before recent window", assistantMessages.slice(-3)),
  ];

  return truncateSummary(lines.join("\n"), maxChars);
}

function formatRoleSnippets(
  label: string,
  messages: AgentConversationMessage[],
): string[] {
  if (messages.length === 0) {
    return [];
  }

  return [
    `- ${label}:`,
    ...messages.map((message) => `  - ${quoteSnippet(message.content)}`),
  ];
}

function quoteSnippet(content: string): string {
  return JSON.stringify(content.replace(/\s+/g, " ").trim().slice(0, 240));
}

function truncateSummary(summary: string | null, maxChars: number): string | null {
  if (summary === null) {
    return null;
  }

  const cap = Math.max(0, Math.trunc(maxChars));
  if (summary.length <= cap) {
    return summary;
  }

  const suffix = "\n- Summary truncated.";
  if (cap <= suffix.length) {
    return summary.slice(0, cap);
  }

  return `${summary.slice(0, cap - suffix.length)}${suffix}`;
}

function getMessagesCharCount(messages: AgentConversationMessage[]): number {
  return messages.reduce((total, message) => total + message.content.length, 0);
}
