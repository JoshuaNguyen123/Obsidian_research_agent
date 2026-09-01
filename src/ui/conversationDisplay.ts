import { extractRequestedRunId } from "../agent/missionResume";
import type { AgentConversationMessage } from "../conversationHistory";

export interface ConversationDisplayMessageV1 extends AgentConversationMessage {
  continuationRunId: string | null;
  continuationAttempt: number | null;
}

/**
 * Project one persisted or live conversation message into its visible Chat
 * form. The map belongs to one render pass/view and is updated deliberately so
 * a history replay and an incremental append produce the same attempt label.
 */
export function projectConversationMessageForDisplayV1(
  message: AgentConversationMessage,
  continuationAttemptCounts: Map<string, number>,
): ConversationDisplayMessageV1 {
  const continuationRunId =
    message.role === "user" ? extractRequestedRunId(message.content) : null;
  if (!continuationRunId) {
    return {
      ...message,
      continuationRunId: null,
      continuationAttempt: null,
    };
  }

  // Attempt 1 is the original mission. The first explicit Continue is 2.
  const continuationAttempt =
    (continuationAttemptCounts.get(continuationRunId) ?? 1) + 1;
  continuationAttemptCounts.set(continuationRunId, continuationAttempt);
  return {
    role: "user",
    content: `Resuming mission — attempt ${continuationAttempt}`,
    continuationRunId,
    continuationAttempt,
  };
}
