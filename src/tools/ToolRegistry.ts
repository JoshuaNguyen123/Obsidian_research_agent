import type { ModelToolCall, ModelToolDefinition } from "../model/types";
import {
  validateActionReceipt,
  verifyPreparedActionFingerprint,
  type ActionReconciliationResult,
  type AuthorizedActionContext,
  type PreparedAction,
  type PreparedActionResult,
  type ToolDescriptor,
} from "../agent/actions";
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
    this.toolsByName = new Map();
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) {
        throw new TypeError(`Duplicate tool registration: ${tool.name}`);
      }
      if (tool.descriptor && tool.descriptor.name !== tool.name) {
        throw new TypeError(
          `Tool descriptor name ${tool.descriptor.name} does not match ${tool.name}.`,
        );
      }
      this.toolsByName.set(tool.name, tool);
    }
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

  getDescriptor(toolName: string): ToolDescriptor | null {
    return this.toolsByName.get(toolName)?.descriptor ?? null;
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

    if (tool.descriptor?.execution.preparation === "required") {
      return failed(
        tool.name,
        "prepared_action_required",
        "This tool must be prepared and authorized before execution.",
        "not_applied",
      );
    }

    try {
      return {
        ok: true,
        toolName: tool.name,
        output: await tool.execute(call.arguments, context),
      };
    } catch (error) {
      return failureFromError(tool.name, error, "execution_failed");
    }
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<PreparedActionResult> {
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return actionFailure("unknown_tool", `Unknown tool: ${call.name}`);
    }
    if (!tool.descriptor) {
      return actionFailure(
        "descriptor_required",
        `Tool ${call.name} has no action descriptor.`,
      );
    }
    if (!tool.prepare) {
      return actionFailure(
        "preparation_unavailable",
        `Tool ${call.name} does not implement action preparation.`,
      );
    }

    try {
      const result = await tool.prepare(call.arguments, context);
      if (!result.ok) {
        return result;
      }
      const invalid = await validatePreparedAction(
        result.action,
        tool.descriptor,
        context,
      );
      return invalid ?? result;
    } catch (error) {
      return actionFailure(
        error instanceof ToolExecutionError ? error.code : "preparation_failed",
        getErrorMessage(error),
      );
    }
  }

  async executePrepared(
    action: PreparedAction,
    context: ToolExecutionContext,
    authorization?: AuthorizedActionContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.toolsByName.get(action.toolName);
    if (!tool) {
      return failed(
        action.toolName,
        "unknown_tool",
        `Unknown tool: ${action.toolName}`,
        "not_applied",
      );
    }
    const descriptor = tool.descriptor;
    if (!descriptor) {
      return failed(
        tool.name,
        "descriptor_required",
        `Tool ${tool.name} has no action descriptor.`,
        "not_applied",
      );
    }
    if (!tool.executePrepared) {
      return failed(
        tool.name,
        "prepared_execution_unavailable",
        `Tool ${tool.name} does not implement prepared execution.`,
        "not_applied",
      );
    }

    const invalid = await validatePreparedAction(action, descriptor, context);
    if (invalid) {
      return failed(
        tool.name,
        invalid.error.code,
        invalid.error.message,
        "not_applied",
      );
    }
    const authorized = authorization ?? context.authorizedAction;
    if (!authorized) {
      return failed(
        tool.name,
        "authorization_required",
        "Prepared action execution requires an exact authority grant binding.",
        "not_applied",
      );
    }
    if (
      authorized.preparedActionId !== action.id ||
      authorized.payloadFingerprint !== action.payloadFingerprint ||
      !authorized.grantId.trim()
    ) {
      return failed(
        tool.name,
        "authorization_mismatch",
        "Authority grant does not match the prepared action.",
        "not_applied",
      );
    }

    try {
      const execution = await tool.executePrepared(action, {
        ...context,
        authorizedAction: authorized,
      });
      if (!execution?.receipt) {
        return failed(
          tool.name,
          "receipt_validation_failed",
          "Prepared execution did not return an action receipt.",
          "may_have_applied",
          { receiptCode: "receipt_missing" },
        );
      }
      const receipt = validateActionReceipt(
        execution.receipt,
        action,
        descriptor,
        authorized,
      );
      if (!receipt.ok) {
        return failed(
          tool.name,
          "receipt_validation_failed",
          receipt.message,
          "may_have_applied",
          { receiptCode: receipt.code },
        );
      }
      return {
        ok: true,
        toolName: tool.name,
        output: execution.output,
        receipt: execution.receipt,
        mutationState: "applied",
      };
    } catch (error) {
      return failureFromError(
        tool.name,
        error,
        "prepared_execution_failed",
        "unknown",
      );
    }
  }

  async reconcile(
    action: PreparedAction,
    context: ToolExecutionContext,
  ): Promise<ActionReconciliationResult> {
    const tool = this.toolsByName.get(action.toolName);
    if (!tool?.descriptor || !tool.reconcile) {
      return {
        outcome: "still_uncertain",
        message: `Reconciliation is unavailable for ${action.toolName}.`,
      };
    }
    const invalid = await validatePreparedAction(action, tool.descriptor, context, {
      permitExpired: true,
    });
    if (invalid) {
      return {
        outcome: "still_uncertain",
        message: invalid.error.message,
      };
    }
    try {
      const result = await tool.reconcile(action, context);
      if (result.outcome === "committed") {
        if (!result.receipt) {
          return {
            outcome: "still_uncertain",
            message: "Reconciliation reported a commit without an action receipt.",
          };
        }
        const receipt = validateActionReceipt(
          result.receipt,
          action,
          tool.descriptor,
          {
            preparedActionId: action.id,
            payloadFingerprint: action.payloadFingerprint,
            grantId: result.receipt.grantId,
          },
        );
        if (!receipt.ok) {
          return {
            outcome: "still_uncertain",
            message: `Reconciliation receipt is invalid: ${receipt.message}`,
          };
        }
      }
      return result;
    } catch (error) {
      return {
        outcome: "still_uncertain",
        message: getErrorMessage(error),
      };
    }
  }
}

async function validatePreparedAction(
  action: PreparedAction,
  descriptor: ToolDescriptor,
  context: ToolExecutionContext,
  options: { permitExpired?: boolean } = {},
): Promise<Extract<PreparedActionResult, { ok: false }> | null> {
  if (
    action.version !== 1 ||
    !action.id.trim() ||
    !action.runId.trim() ||
    !action.toolCallId.trim()
  ) {
    return actionFailure("invalid_prepared_action", "Prepared action identity is invalid.");
  }
  if (
    descriptor.version !== 1 ||
    action.toolName !== descriptor.name ||
    action.target.system !== descriptor.capability.system ||
    action.target.resourceType !== descriptor.capability.resourceType
  ) {
    return actionFailure(
      "descriptor_mismatch",
      "Prepared action does not match the registered tool descriptor.",
    );
  }
  if (context.runId && action.runId !== context.runId) {
    return actionFailure(
      "run_mismatch",
      "Prepared action belongs to a different run.",
    );
  }
  if (
    !Number.isSafeInteger(action.preview.outboundBytes) ||
    action.preview.outboundBytes < 0
  ) {
    return actionFailure(
      "invalid_prepared_action",
      "Prepared action outbound byte count is invalid.",
    );
  }
  try {
    if (!(await verifyPreparedActionFingerprint(action))) {
      return actionFailure(
        "fingerprint_mismatch",
        "Prepared action payload fingerprint is invalid.",
      );
    }
  } catch {
    return actionFailure(
      "fingerprint_mismatch",
      "Prepared action payload cannot be canonically fingerprinted.",
    );
  }
  if (!options.permitExpired) {
    const expiresAt = Date.parse(action.expiresAt);
    const now = (context.now?.() ?? new Date()).getTime();
    if (!Number.isFinite(expiresAt) || now >= expiresAt) {
      return actionFailure("prepared_action_expired", "Prepared action has expired.");
    }
  }
  return null;
}

function actionFailure(
  code: string,
  message: string,
): Extract<PreparedActionResult, { ok: false }> {
  return { ok: false, error: { code, message } };
}

function failed(
  toolName: string,
  code: string,
  message: string,
  mutationState: NonNullable<ToolExecutionResult["mutationState"]>,
  details?: Record<string, unknown>,
): ToolExecutionResult {
  return {
    ok: false,
    toolName,
    mutationState,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

function failureFromError(
  toolName: string,
  error: unknown,
  fallbackCode: string,
  fallbackMutationState?: ToolExecutionResult["mutationState"],
): ToolExecutionResult {
  if (error instanceof ToolExecutionError) {
    return {
      ok: false,
      toolName,
      mutationState: error.mutationState ?? fallbackMutationState,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    ok: false,
    toolName,
    mutationState: fallbackMutationState,
    error: {
      code: fallbackCode,
      message: getErrorMessage(error),
    },
  };
}
