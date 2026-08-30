import type {
  AgentBackend,
  AgentBackendResult,
} from "../../scripts/agent-bridge.mjs";

export interface OfflineAgentBackendMetricsV1 {
  version: 1;
  requestCount: number;
  streamedRequestCount: number;
  toolFrontierObservations: number;
  emittedToolCalls: number;
}

export interface OfflineAgentBackendV1 extends AgentBackend {
  snapshot(): OfflineAgentBackendMetricsV1;
}

/**
 * Deterministic local backend reached through the production HTTP client. It
 * never installs a ModelClient or sandbox binding in the plugin process.
 */
export function createOfflineAgentBackendV1(): OfflineAgentBackendV1 {
  const metrics: OfflineAgentBackendMetricsV1 = {
    version: 1,
    requestCount: 0,
    streamedRequestCount: 0,
    toolFrontierObservations: 0,
    emittedToolCalls: 0,
  };

  const complete = async (
    request: Record<string, unknown>,
  ): Promise<AgentBackendResult> => {
    metrics.requestCount += 1;
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const tools = Array.isArray(request.tools) ? request.tools : [];
    if (tools.length > 0) metrics.toolFrontierObservations += 1;
    const toolNames = new Set(
      tools.flatMap((entry) => {
        if (!isRecord(entry) || !isRecord(entry.function)) return [];
        return typeof entry.function.name === "string" ? [entry.function.name] : [];
      }),
    );
    const transcript = messages
      .flatMap((message) => isRecord(message) && typeof message.content === "string"
        ? [message.content]
        : [])
      .join("\n");
    const toolResultObserved = messages.some(
      (message) => isRecord(message) && message.role === "tool",
    );
    if (toolNames.has("probe_echo")) {
      metrics.emittedToolCalls += 1;
      return {
        toolCalls: [{ name: "probe_echo", arguments: { value: "ready" } }],
        finishReason: "tool_calls",
      };
    }

    if (request.response_format !== undefined) {
      return { content: "{}" };
    }

    const appendMarker = transcript.match(/OFFLINE_APPEND_[A-Z0-9_]+/u)?.[0];
    if (appendMarker) {
      if (!toolNames.has("append_to_current_file")) {
        // Target-only current-note writes intentionally bypass the planner/tool
        // loop. The production host owns the append and receipt after this
        // generated content passes its relevance/safety buffer.
        return { content: appendMarker };
      }
      if (!toolResultObserved) {
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{
            name: "append_to_current_file",
            arguments: { text: `\n${appendMarker}\n` },
          }],
          finishReason: "tool_calls",
        };
      }
      return { content: `Verified current-note append ${appendMarker}.` };
    }

    const chatMarker = transcript.match(/OFFLINE_CHAT_[A-Z0-9_]+/u)?.[0];
    if (chatMarker) return { content: chatMarker };
    return { content: "offline bridge ready" };
  };

  return {
    complete,
    async *stream(request) {
      metrics.streamedRequestCount += 1;
      const result = await complete(request);
      yield result;
    },
    snapshot: () => structuredClone(metrics),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
