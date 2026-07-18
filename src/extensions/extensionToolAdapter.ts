import {
  ExtensionUnavailableErrorV1,
  type ExtensionMissionSnapshotV1,
  type ExtensionRegistrationTokenV1,
  type ExtensionToolContributionV1,
  type RegisteredContributionV1,
  type ScopedExtensionContextV1,
} from "../../packages/core-api/src";
import type {
  ActionReconciliationResult,
  PreparedAction,
  PreparedActionResult,
  ToolDescriptor,
} from "../agent/actions";
import type { JsonSchemaObject } from "../model/types";
import {
  ToolExecutionError,
  type AgentTool,
  type AgentToolActionExecution,
  type ToolExecutionContext,
} from "../tools/types";

export interface ExtensionToolAdapterOptions {
  isTokenActive(token: ExtensionRegistrationTokenV1): boolean;
}

/** Converts an API-safe extension tool into the existing host tool contract. */
export function adaptExtensionToolContribution(
  registered: RegisteredContributionV1<ExtensionToolContributionV1>,
  options: ExtensionToolAdapterOptions,
): AgentTool {
  const { contribution, token } = registered;
  const source = contribution.tool;
  return {
    name: source.name,
    description: source.description,
    parameters: source.parameters as JsonSchemaObject,
    descriptor: source.descriptor as ToolDescriptor,
    async execute(args, context) {
      return invokeExtensionHandler(token, context, options, (scoped) =>
        source.execute(args, scoped),
      );
    },
    ...(source.prepare
      ? {
          async prepare(args, context): Promise<PreparedActionResult> {
            return invokeExtensionHandler(token, context, options, async (scoped) =>
              source.prepare!(args, scoped) as Promise<PreparedActionResult>,
            );
          },
        }
      : {}),
    ...(source.executePrepared
      ? {
          async executePrepared(
            action: PreparedAction,
            context: ToolExecutionContext,
          ): Promise<AgentToolActionExecution> {
            return invokeExtensionHandler(token, context, options, async (scoped) =>
              source.executePrepared!(action, scoped) as Promise<AgentToolActionExecution>,
            );
          },
        }
      : {}),
    ...(source.reconcile
      ? {
          async reconcile(
            action: PreparedAction,
            context: ToolExecutionContext,
          ): Promise<ActionReconciliationResult> {
            return invokeExtensionHandler(token, context, options, async (scoped) =>
              source.reconcile!(action, scoped) as Promise<ActionReconciliationResult>,
            );
          },
        }
      : {}),
  };
}

export function adaptExtensionToolsFromSnapshot(
  snapshot: ExtensionMissionSnapshotV1,
  options: ExtensionToolAdapterOptions,
): ReadonlyArray<AgentTool> {
  return Object.freeze(
    snapshot.tools.map((registered) =>
      adaptExtensionToolContribution(registered, options),
    ),
  );
}

async function invokeExtensionHandler<TResult>(
  token: ExtensionRegistrationTokenV1,
  context: ToolExecutionContext,
  options: ExtensionToolAdapterOptions,
  handler: (context: ScopedExtensionContextV1) => Promise<TResult>,
): Promise<TResult> {
  assertAvailable(token, options);
  const combined = combineAbortSignals(token.signal, context.abortSignal);
  const scoped = createScopedContext(token, context, combined.signal);
  try {
    const result = await handler(scoped);
    assertAvailable(token, options);
    return result;
  } catch (error) {
    if (error instanceof ExtensionUnavailableErrorV1) {
      throw unavailableToolError(token.extensionId);
    }
    throw error;
  } finally {
    combined.dispose();
  }
}

function createScopedContext(
  token: ExtensionRegistrationTokenV1,
  context: ToolExecutionContext,
  abortSignal: AbortSignal,
): ScopedExtensionContextV1 {
  const authorizedAction = context.authorizedAction
    ? Object.freeze({ ...context.authorizedAction })
    : undefined;
  return Object.freeze({
    version: 1,
    extensionId: token.extensionId,
    ...(context.runId ? { missionId: context.runId } : {}),
    ...(context.rootMissionId ? { rootMissionId: context.rootMissionId } : {}),
    ...(context.operationId ? { operationId: context.operationId } : {}),
    ...(context.originalPrompt ? { originalPrompt: context.originalPrompt } : {}),
    ...(context.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
    abortSignal,
    ...(authorizedAction ? { authorizedAction } : {}),
    now: () => new Date((context.now?.() ?? new Date()).getTime()),
    reportProgress: (message: string) => context.reportProgress?.(String(message)),
  });
}

function assertAvailable(
  token: ExtensionRegistrationTokenV1,
  options: ExtensionToolAdapterOptions,
): void {
  if (token.signal.aborted || !options.isTokenActive(token)) {
    throw unavailableToolError(token.extensionId);
  }
}

function unavailableToolError(extensionId: string): ToolExecutionError {
  return new ToolExecutionError(
    "extension_unavailable",
    `Extension is unavailable: ${extensionId}`,
    { mutationState: "not_applied" },
  );
}

function combineAbortSignals(
  extensionSignal: AbortSignal,
  missionSignal?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  if (!missionSignal || extensionSignal === missionSignal) {
    return { signal: extensionSignal, dispose() {} };
  }

  const controller = new AbortController();
  const abortFromExtension = () => controller.abort(extensionSignal.reason);
  const abortFromMission = () => controller.abort(missionSignal.reason);
  if (extensionSignal.aborted) {
    abortFromExtension();
  } else if (missionSignal.aborted) {
    abortFromMission();
  } else {
    extensionSignal.addEventListener("abort", abortFromExtension, { once: true });
    missionSignal.addEventListener("abort", abortFromMission, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      extensionSignal.removeEventListener("abort", abortFromExtension);
      missionSignal.removeEventListener("abort", abortFromMission);
    },
  };
}
