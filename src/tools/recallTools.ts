import { ToolExecutionError, type AgentTool } from "./types";
import { getOptionalInteger, getOptionalString, getRequiredString } from "./validation";

export const RECALL_TOOL_RESULT_TOOL_NAME = "recall_tool_result";

/**
 * Reopens a tool result that compaction set aside.
 *
 * Compaction shrinks an oversized tool payload down to a handful of chaining
 * keys, and before this the original was simply gone -- so the only way back to
 * evidence the agent had already fetched was to run the tool again, which grew
 * the prompt and triggered more compaction. The slim payload now carries a
 * recallKey and a sentence saying what to do with it; this is the other half.
 */
export const recallToolResultTool: AgentTool = {
  name: RECALL_TOOL_RESULT_TOOL_NAME,
  description:
    "Read the full output of an earlier tool call that was shortened to save space. Use the recallKey from a truncated tool result. Read-only.",
  parameters: {
    type: "object",
    required: ["key"],
    properties: {
      key: {
        type: "string",
        description:
          'The recallKey from a truncated tool result, for example "tr_run-1_3".',
      },
      query: {
        type: "string",
        description:
          "Optional text to search for. Returns only matching lines with their line numbers, which is far cheaper than reading the whole output back.",
      },
      maxChars: {
        type: "integer",
        description: "Optional maximum characters to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const key = getRequiredString(args, "key").trim();
    if (!key) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "recall_tool_result requires a non-empty key.",
      );
    }

    const store = context.toolResultStore;
    if (!store) {
      // Honest rather than empty: no store means nothing was ever set aside in
      // this run, which is a different situation from a key that has expired.
      return {
        operation: "recall_tool_result",
        status: "unavailable",
        key,
        content: null,
        message:
          "No tool output has been set aside in this run, so there is nothing to recall.",
      };
    }

    const recalled = store.recall(key, {
      query: getOptionalString(args, "query") ?? undefined,
      maxChars: getOptionalInteger(args, "maxChars") ?? undefined,
    });

    return {
      operation: "recall_tool_result",
      status: recalled.status,
      key: recalled.key,
      toolName: recalled.toolName,
      step: recalled.step,
      content: recalled.content,
      totalChars: recalled.totalChars,
      truncated: recalled.truncated,
      matchLines: recalled.matchLines,
      message: recalled.message,
    };
  },
};

export function createRecallTools(): AgentTool[] {
  return [recallToolResultTool];
}
