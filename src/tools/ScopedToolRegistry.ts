import type { ModelToolCall } from "../model/types";
import type {
  ActionReconciliationResult,
  AuthorizedActionContext,
  PreparedAction,
  PreparedActionResult,
  ToolDescriptor,
} from "../agent/actions";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "./types";

/**
 * A host-owned least-authority view over another registry. Disallowed tools are
 * absent from model definitions and blocked again at every execution seam.
 */
export class ScopedToolRegistry implements ToolRegistry {
  private readonly allowedNames: ReadonlySet<string>;

  constructor(
    private readonly base: ToolRegistry,
    allow: (toolName: string, descriptor: ToolDescriptor | null) => boolean,
  ) {
    this.allowedNames = new Set(
      base
        .getDefinitions()
        .map((definition) => definition.function.name)
        .filter((name) => allow(name, base.getDescriptor?.(name) ?? null)),
    );
  }

  getDefinitions() {
    return this.base
      .getDefinitions()
      .filter((definition) => this.allowedNames.has(definition.function.name));
  }

  getDescriptor(toolName: string): ToolDescriptor | null {
    return this.allowedNames.has(toolName)
      ? this.base.getDescriptor?.(toolName) ?? null
      : null;
  }

  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.allowedNames.has(call.name)) {
      return Promise.resolve(scopeBlocked(call.name));
    }
    return this.base.execute(call, context);
  }

  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<PreparedActionResult> {
    if (!this.allowedNames.has(call.name)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "tool_outside_role_scope",
          message: `Tool ${call.name} is outside this role's host-owned scope.`,
        },
      });
    }
    if (!this.base.prepare) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "preparation_unavailable",
          message: "The underlying registry does not support preparation.",
        },
      });
    }
    return this.base.prepare(call, context);
  }

  executePrepared(
    action: PreparedAction,
    context: ToolExecutionContext,
    authorization?: AuthorizedActionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.allowedNames.has(action.toolName)) {
      return Promise.resolve(scopeBlocked(action.toolName));
    }
    if (!this.base.executePrepared) {
      return Promise.resolve({
        ...scopeBlocked(action.toolName),
        error: {
          code: "prepared_execution_unavailable",
          message: "The underlying registry does not support prepared execution.",
        },
      });
    }
    return this.base.executePrepared(action, context, authorization);
  }

  reconcile(
    action: PreparedAction,
    context: ToolExecutionContext,
  ): Promise<ActionReconciliationResult> {
    if (!this.allowedNames.has(action.toolName)) {
      return Promise.resolve({
        outcome: "still_uncertain",
        message: `Tool ${action.toolName} is outside this role's host-owned scope.`,
      });
    }
    return this.base.reconcile
      ? this.base.reconcile(action, context)
      : Promise.resolve({
          outcome: "still_uncertain",
          message: "The underlying registry does not support reconciliation.",
        });
  }
}

function scopeBlocked(toolName: string): ToolExecutionResult {
  return {
    ok: false,
    toolName,
    mutationState: "not_applied",
    error: {
      code: "tool_outside_role_scope",
      message: `Tool ${toolName} is outside this role's host-owned scope.`,
    },
  };
}
