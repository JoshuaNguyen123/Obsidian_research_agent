import type { ModelChatMessage } from "./model/types";

export type AgentConversationRole = "user" | "assistant";

export interface AgentConversationMessage {
  role: AgentConversationRole;
  content: string;
}

export const MAX_CONVERSATION_MESSAGES = 20;
export const MAX_CONVERSATION_MESSAGE_CHARS = 12_000;
export const MAX_CONVERSATION_TOTAL_CHARS = 40_000;

export interface ConversationHistoryLimits {
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
}

const DEFAULT_LIMITS: ConversationHistoryLimits = {
  maxMessages: MAX_CONVERSATION_MESSAGES,
  maxMessageChars: MAX_CONVERSATION_MESSAGE_CHARS,
  maxTotalChars: MAX_CONVERSATION_TOTAL_CHARS,
};

const TRUNCATION_NOTICE = "\n\n[conversation message truncated]";

export function normalizeConversationHistory(
  value: unknown,
  limits: ConversationHistoryLimits = DEFAULT_LIMITS,
): AgentConversationMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return trimConversationHistory(
    value
      .map((message) => normalizeConversationMessage(message))
      .filter((message): message is AgentConversationMessage => message !== null),
    limits,
  );
}

export function appendConversationMessage(
  history: AgentConversationMessage[],
  message: AgentConversationMessage,
  limits: ConversationHistoryLimits = DEFAULT_LIMITS,
): AgentConversationMessage[] {
  return trimConversationHistory([...history, message], limits);
}

export function trimConversationHistory(
  history: AgentConversationMessage[],
  limits: ConversationHistoryLimits = DEFAULT_LIMITS,
): AgentConversationMessage[] {
  const maxMessages = Math.max(0, limits.maxMessages);
  const maxMessageChars = Math.max(0, limits.maxMessageChars);
  const maxTotalChars = Math.max(0, limits.maxTotalChars);
  const normalized = history
    .map((message) => normalizeConversationMessage(message, maxMessageChars))
    .filter((message): message is AgentConversationMessage => message !== null)
    .slice(-maxMessages);

  while (getConversationCharCount(normalized) > maxTotalChars) {
    normalized.shift();
  }

  return normalized;
}

export function toConversationModelMessages(
  history: AgentConversationMessage[],
): ModelChatMessage[] {
  return trimConversationHistory(history).map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function getConversationCharCount(
  history: AgentConversationMessage[],
): number {
  return history.reduce((total, message) => total + message.content.length, 0);
}

function normalizeConversationMessage(
  value: unknown,
  maxMessageChars = MAX_CONVERSATION_MESSAGE_CHARS,
): AgentConversationMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  const role = value.role;
  const content = value.content;

  if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
    return null;
  }

  const normalizedContent = truncateMessageContent(content, maxMessageChars);
  if (!normalizedContent.trim()) {
    return null;
  }

  return {
    role,
    content: normalizedContent,
  };
}

function truncateMessageContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  if (maxChars <= TRUNCATION_NOTICE.length) {
    return content.slice(0, maxChars);
  }

  return `${content.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
