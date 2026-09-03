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

    const replaceMarker = transcript.match(/OFFLINE_REPLACE_[A-Z0-9_]+/u)?.[0];
    if (replaceMarker) {
      const body = `# Replaced brief\n\n${replaceMarker}\n`;
      if (!toolNames.has("replace_current_file")) {
        return { content: body };
      }
      if (!toolNameObserved(messages, "replace_current_file")) {
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{
            name: "replace_current_file",
            arguments: { text: body },
          }],
          finishReason: "tool_calls",
        };
      }
      return { content: `Verified current-note replace ${replaceMarker}.` };
    }

    const pageClearMarker = transcript.match(/OFFLINE_PAGECLEAR_[A-Z0-9_]+/u)?.[0];
    if (pageClearMarker) {
      const body = `# Page cleared\n\n${pageClearMarker}\n`;
      if (!toolNames.has("replace_current_file")) {
        return { content: body };
      }
      if (!toolNameObserved(messages, "replace_current_file")) {
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{
            name: "replace_current_file",
            arguments: { text: body },
          }],
          finishReason: "tool_calls",
        };
      }
      return { content: `Verified page-clear write ${pageClearMarker}.` };
    }

    const wordCountMarker = transcript.match(/OFFLINE_WORDCOUNT_[A-Z0-9_]+/u)?.[0];
    if (wordCountMarker) {
      const shortBody =
        `Draft one. ${wordCountMarker} Alpha beta gamma delta epsilon.`;
      const correction =
        `Correction pass adds words so the note meets the requested count. ${wordCountMarker} ` +
        "zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.";
      if (toolNames.has("count_words") && !toolNameObserved(messages, "count_words")) {
        if (
          toolNames.has("append_to_current_file") &&
          !toolNameObserved(messages, "append_to_current_file")
        ) {
          metrics.emittedToolCalls += 1;
          return {
            toolCalls: [{
              name: "append_to_current_file",
              arguments: { text: `\n${shortBody}\n` },
            }],
            finishReason: "tool_calls",
          };
        }
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{ name: "count_words", arguments: {} }],
          finishReason: "tool_calls",
        };
      }
      if (
        toolNameObserved(messages, "count_words") &&
        toolNames.has("append_to_current_file") &&
        !transcript.includes("Correction pass")
      ) {
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{
            name: "append_to_current_file",
            arguments: { text: `\n${correction}\n` },
          }],
          finishReason: "tool_calls",
        };
      }
      if (!toolNames.has("append_to_current_file") && !toolNames.has("count_words")) {
        return { content: `${shortBody}\n\n${correction}` };
      }
      return { content: `Verified word-count correction ${wordCountMarker}.` };
    }

    const titleMarker = transcript.match(/OFFLINE_TITLE_[A-Z0-9_]+/u)?.[0];
    if (titleMarker) {
      const title = "Offline Title Brief";
      const body = `# ${title}\n\n${titleMarker}\n`;
      if (
        toolNames.has("rename_current_file") &&
        !toolNameObserved(messages, "rename_current_file")
      ) {
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{
            name: "rename_current_file",
            arguments: { title },
          }],
          finishReason: "tool_calls",
        };
      }
      if (!toolNames.has("append_to_current_file")) {
        return { content: body };
      }
      if (!toolNameObserved(messages, "append_to_current_file")) {
        metrics.emittedToolCalls += 1;
        return {
          toolCalls: [{
            name: "append_to_current_file",
            arguments: { text: `\n${body}\n` },
          }],
          finishReason: "tool_calls",
        };
      }
      return { content: `Verified title rename plus body ${titleMarker}.` };
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

function toolNameObserved(
  messages: unknown[],
  toolName: string,
): boolean {
  return messages.some((message) => {
    if (!isRecord(message) || message.role !== "tool") return false;
    const name = typeof message.name === "string"
      ? message.name
      : typeof message.toolName === "string"
        ? message.toolName
        : "";
    return name === toolName ||
      (typeof message.content === "string" && message.content.includes(toolName));
  });
}
