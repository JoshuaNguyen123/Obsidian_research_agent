import type { ModelChatMessage, ModelToolCall } from "./types";

export type ToolTranscriptOrigin = "model" | "runner";

export function ensureToolCallId(
  call: ModelToolCall,
  fallback: string,
): ModelToolCall {
  return call.id ? call : { ...call, id: fallback };
}

export function appendToolTranscript({
  messages,
  toolCall,
  resultContent,
  origin,
  fallbackId,
}: {
  messages: ModelChatMessage[];
  toolCall: ModelToolCall;
  resultContent: string;
  origin: ToolTranscriptOrigin;
  fallbackId: string;
}): ModelToolCall {
  const call = ensureToolCallId(toolCall, fallbackId);

  if (origin === "runner") {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [call],
    });
  }

  messages.push({
    role: "tool",
    toolName: call.name,
    toolCallId: call.id,
    content: resultContent,
  });

  return call;
}
