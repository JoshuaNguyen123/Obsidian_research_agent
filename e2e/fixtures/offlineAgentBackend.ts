import type {
  AgentBackend,
  AgentBackendResult,
} from "../../scripts/agent-bridge.mjs";
import { UNVERIFIED_CLAIM_MARKER_V1 } from "../../src/agent/degradedDelivery";

export interface OfflineAgentBackendMetricsV1 {
  version: 1;
  requestCount: number;
  streamedRequestCount: number;
  toolFrontierObservations: number;
  emittedToolCalls: number;
  /** Union of tool names the installed plugin offered across requests. */
  offeredToolNames: string[];
  offeredToolsByRequest: string[][];
  citationRepair?: { unverifiedDrafts: number; correctedDrafts: number };
  citationCriticReviews?: number;
  citationRepairRequests?: {
    offeredTools: string[];
    lastMessages: { role: unknown; name: unknown; content: string }[];
  }[];
}

export interface OfflineAgentBackendV1 extends AgentBackend {
  snapshot(): OfflineAgentBackendMetricsV1;
  setCatalogNotePath(path: string): void;
}

/**
 * Deterministic local backend reached through the production HTTP client. It
 * never installs a ModelClient or sandbox binding in the plugin process.
 */
export function createOfflineAgentBackendV1(): OfflineAgentBackendV1 {
  let catalogNotePath: string | null = null;
  const orderedAppendsIssued = new Map<string, number>();
  const metrics: OfflineAgentBackendMetricsV1 = {
    version: 1,
    requestCount: 0,
    streamedRequestCount: 0,
    toolFrontierObservations: 0,
    emittedToolCalls: 0,
    offeredToolNames: [],
    offeredToolsByRequest: [],
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
    for (const name of toolNames) {
      if (!metrics.offeredToolNames.includes(name)) {
        metrics.offeredToolNames.push(name);
      }
    }
    metrics.offeredToolsByRequest.push([...toolNames]);
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

    if (transcript.includes("OFFLINE_CITATION_REPAIR")) {
      const instructions = messages.filter(isRecord)
        .filter((message) => message.role === "system")
        .map((message) => typeof message.content === "string" ? message.content : "").join("\n");
      if (instructions.includes("This request already contains explicit evidence intent.")) {
        return { content: JSON.stringify({ mode: "deep_web", sourceFloor: 2, rationale: "The fixture explicitly requests two public sources." }) };
      }
      if (instructions.includes("Judge how much research effort a mission truly deserves.")) {
        return { content: JSON.stringify({ tier: "standard", risk: "low", freshness: "none", rationale: "Two bounded source passages and a short cited answer." }) };
      }
      if (instructions.includes("You are an independent critic reviewing a completed research mission.")) {
        metrics.citationCriticReviews = (metrics.citationCriticReviews ?? 0) + 1;
        return { content: JSON.stringify({ verdict: "pass", missing: [], summary: "The corrected fixture text matches the two fixed source passages." }) };
      }
      metrics.citationRepairRequests ??= [];
      metrics.citationRepairRequests.push({
        offeredTools: [...toolNames],
        lastMessages: messages.filter(isRecord).slice(-2).map((message) => ({
          role: message.role, name: message.name,
          content: typeof message.content === "string" ? message.content.slice(-1_200) : "",
        })),
      });
      metrics.citationRepairRequests = metrics.citationRepairRequests.slice(-12);
      if (!toolNameObserved(messages, "web_search")) {
        metrics.emittedToolCalls += 1;
        const marker = transcript.match(/OFFLINE_CITATION_REPAIR_[a-f0-9]{32}/u)?.[0];
        return { toolCalls: [{ name: "web_search", arguments: { query: `MCP servers ${marker ?? "OFFLINE_CITATION_REPAIR"}` } }], finishReason: "tool_calls" };
      }
      const ids = [...new Set(transcript.match(/source:[a-z0-9]+:passage:\d+-\d+/giu) ?? [])];
      if (ids.length < 2) throw new Error("Citation repair fixture requires both persisted source passages.");
      metrics.citationRepair ??= { unverifiedDrafts: 0, correctedDrafts: 0 };
      if (transcript.includes("OFFLINE_MEMORY_SAVE") && metrics.citationRepair.correctedDrafts > 0 &&
          toolNames.has("append_research_memory") && !toolNameObserved(messages, "append_research_memory")) {
        metrics.emittedToolCalls += 1;
        const marker = transcript.match(/OFFLINE_CITATION_REPAIR_[a-f0-9]{32}/u)?.[0];
        return { toolCalls: [{ name: "append_research_memory", arguments: {
          topic: `Offline MCP memory ${marker}`, text: "MCP servers expose tools and resources through a standard protocol.",
        } }], finishReason: "tool_calls" };
      }
      const reportScope = "\n\n## Limitations\nThis brief is limited to the cited source passages.\n\n## Confidence\nHigh confidence in these passage-supported statements.";
      if (metrics.citationRepair.unverifiedDrafts === 0) {
        metrics.citationRepair.unverifiedDrafts += 1;
        return { content: `MCP servers expose tools and resources through a standard protocol. Clients discover the approved server capabilities. ${UNVERIFIED_CLAIM_MARKER_V1}${reportScope}` };
      }
      metrics.citationRepair.correctedDrafts += 1;
      return { content: `MCP servers expose tools and resources through a standard protocol [${ids[0]}]. Clients discover the approved server capabilities [${ids[1]}]. ${UNVERIFIED_CLAIM_MARKER_V1}${reportScope}` };
    }

    const catalogMarker = transcript.match(/OFFLINE_CATALOG_[A-Z0-9_]+/u)?.[0];
    if (catalogMarker) {
      // Follow the native read-before-mutation graph; a later frontier cannot
      // be observed by returning prose while its prerequisite is still owed.
      for (const name of ["read_current_file", "read_mermaid_block"]) {
        if (toolNames.has(name) && !toolNameObserved(messages, name)) {
          if (name === "read_mermaid_block" && !catalogNotePath) throw new Error("Catalog note fixture is not bound.");
          metrics.emittedToolCalls += 1;
          return { toolCalls: [{ name, arguments: name === "read_mermaid_block"
            ? { path: catalogNotePath, selector: { kind: "heading", heading: "Catalog probe" } } : {} }], finishReason: "tool_calls" };
        }
      }
      if (toolNames.has("upsert_mermaid_block") && !toolNameObserved(messages, "upsert_mermaid_block")) {
        const readback = messages.filter((message) => isRecord(message) && message.role === "tool" &&
          typeof message.content === "string" && (message.name === "read_mermaid_block" ||
            message.toolName === "read_mermaid_block" || message.content.includes("read_mermaid_block"))).at(-1);
        const baseHash = isRecord(readback) ? readback.content.match(/"sha256"\s*:\s*"((?:sha256:)?[a-f0-9]{64})"/u)?.[1] : null;
        if (!catalogNotePath || !baseHash) throw new Error("Flowchart execution requires the actual native note readback hash.");
        metrics.emittedToolCalls += 1;
        return { toolCalls: [{ name: "upsert_mermaid_block", arguments: { path: catalogNotePath, baseHash,
          selector: { kind: "heading", heading: "Catalog probe" }, mermaid: "flowchart TD\n  Research --> Verify\n  Verify --> Reflect" } }], finishReason: "tool_calls" };
      }
      return { content: `Catalog probe complete ${catalogMarker}.` };
    }

    const orderedMarkers = [...new Set(transcript.match(/OFFLINE_ORDERED_[A-Z0-9_]+_[AB][12]/gu) ?? [])];
    if (orderedMarkers.length === 2) {
      const key = orderedMarkers.join("|");
      const issued = orderedAppendsIssued.get(key) ?? 0;
      if (toolNames.has("read_current_file") && !toolNameObserved(messages, "read_current_file")) {
        metrics.emittedToolCalls += 1;
        return { toolCalls: [{ name: "read_current_file", arguments: {} }], finishReason: "tool_calls" };
      }
      if (toolNames.has("append_to_current_file") && issued < orderedMarkers.length) {
        orderedAppendsIssued.set(key, issued + 1);
        metrics.emittedToolCalls += 1;
        return { toolCalls: [{ name: "append_to_current_file", arguments: { text: orderedMarkers[issued] } }], finishReason: "tool_calls" };
      }
      return { content: `Completed exactly two ordered appends: ${orderedMarkers.join(", then ")}.` };
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
    setCatalogNotePath: (path) => { catalogNotePath = path; },
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
