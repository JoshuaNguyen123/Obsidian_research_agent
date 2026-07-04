import type { ModelToolCall, ModelToolDefinition } from "../model/types";
import { getErrorMessage } from "./validation";
import {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionError,
  ToolExecutionResult,
  ToolRegistry,
} from "./types";

export class DefaultToolRegistry implements ToolRegistry {
  private readonly toolsByName: Map<string, AgentTool>;

  constructor(tools: AgentTool[]) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  getDefinitions(): ModelToolDefinition[] {
    return [...this.toolsByName.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.toolsByName.get(call.name);

    if (!tool) {
      return {
        ok: false,
        toolName: call.name,
        error: {
          code: "unknown_tool",
          message: `Unknown tool: ${call.name}`,
        },
      };
    }

    try {
      return {
        ok: true,
        toolName: tool.name,
        output: await tool.execute(call.arguments, context),
      };
    } catch (error) {
      return {
        ok: false,
        toolName: tool.name,
        error: {
          code:
            error instanceof ToolExecutionError
              ? error.code
              : "execution_failed",
          message: getErrorMessage(error),
        },
      };
    }
  }
}
