/**
 * Behavioral tool-call probe for Test connection. The /api/show metadata
 * preflight proves a model ADVERTISES the tools capability; this probe proves
 * it actually EMITS a tool call when handed a trivial single-tool frontier.
 * A model that passes metadata but fails here (kimi-k2.7-code did exactly
 * this) will stall real missions, so the result surfaces as a warning before
 * any mission is attempted. The probe is advisory: it never fails the
 * connection test.
 */
import type { ModelChatRequest, ModelChatResponse } from "./types";
import { extractToolCallsFromAssistantText } from "../agent/toolCallRecovery";

export type ToolCallProbeOutcome =
  | "native_tool_call"
  | "recovered_text_call"
  | "no_call";

export interface ToolCallProbeResultV1 {
  outcome: ToolCallProbeOutcome;
  detail: string;
}

const PROBE_TOOL_NAME = "probe_echo";
const PROBE_TIMEOUT_MS = 20_000;

export async function probeToolCallBehavior(
  chat: (request: ModelChatRequest) => Promise<ModelChatResponse>,
  options?: { timeoutMs?: number },
): Promise<ToolCallProbeResultV1> {
  const abort = new AbortController();
  const timeoutMs = options?.timeoutMs ?? PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const request = chat({
      messages: [
        {
          role: "system",
          content:
            "You are a tool-use compliance probe. You must respond with a tool call, never prose.",
        },
        {
          role: "user",
          content: `Call the ${PROBE_TOOL_NAME} tool exactly once with {"value":"ready"}.`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: PROBE_TOOL_NAME,
            description: "Echoes the provided value back to the host.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        },
      ],
      toolChoice: "required",
      think: false,
      abortSignal: abort.signal,
      evidencePhase: "router",
    }).then(
      (response) => ({ kind: "response" as const, response }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const settled = await Promise.race([
      request,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => {
          abort.abort(
            new Error(`Tool-call behavioral probe timed out after ${timeoutMs}ms.`),
          );
          resolve({ kind: "timeout" });
        }, timeoutMs);
      }),
    ]);
    if (settled.kind === "timeout") {
      return {
        outcome: "no_call",
        detail: `Probe request timed out after ${timeoutMs}ms.`,
      };
    }
    if (settled.kind === "error") {
      throw settled.error;
    }
    const response = settled.response;
    if (response.toolCalls.some((call) => call.name === PROBE_TOOL_NAME)) {
      return {
        outcome: "native_tool_call",
        detail: "Model emitted a native structured tool call.",
      };
    }
    const recovered = extractToolCallsFromAssistantText(
      response.message.content ?? "",
      new Set([PROBE_TOOL_NAME]),
    );
    if (recovered.length > 0) {
      return {
        outcome: "recovered_text_call",
        detail:
          "Model wrote its tool call as text; missions will rely on text recovery.",
      };
    }
    return {
      outcome: "no_call",
      detail:
        "Model returned prose without any tool call; agent missions with this model are likely to stall.",
    };
  } catch (error) {
    return {
      outcome: "no_call",
      detail: `Probe request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
