import type {
  ActionReceipt,
  ActionReconciliationResult,
  PreparedAction,
  PreparedActionPreview,
  ToolDescriptor,
} from "../../agent/actions";
import {
  evaluateAuthorityGrant,
  verifyAuthorityGrantFingerprint,
  type AuthorityGrantV1,
} from "../../agent/authority";
import { DefaultToolRegistry } from "../../tools/ToolRegistry";
import type { ToolExecutionContext } from "../../tools/types";
import {
  LINEAR_TOOL_OPERATION_MAP,
  createLinearTools,
  type CreateLinearToolsOptions,
} from "./LinearTools";

export type LinearAuthoritySubject = AuthorityGrantV1["subject"];

export interface LinearAuthorityConsumptionRequest {
  grantId: string;
  action: PreparedAction;
  descriptor: ToolDescriptor;
  subject: LinearAuthoritySubject;
  now: Date;
}

/**
 * This callback must durably persist the updated grant usage before resolving.
 * `AuthorityGrantStore.authorizeAndConsume` satisfies that contract.
 */
export type LinearAuthorizeAndConsume = (
  request: LinearAuthorityConsumptionRequest,
) => Promise<AuthorityGrantV1>;

export type LinearActiveGrantProvider = () =>
  | readonly AuthorityGrantV1[]
  | Promise<readonly AuthorityGrantV1[]>;

export interface HostLinearActionExecutorOptions
  extends CreateLinearToolsOptions {
  authorizeAndConsume: LinearAuthorizeAndConsume;
  activeGrants?: readonly AuthorityGrantV1[] | LinearActiveGrantProvider;
}

export interface PrepareHostLinearActionRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  runId: string;
  toolCallId: string;
  context: ToolExecutionContext;
}

export interface ExecutePreparedHostLinearActionRequest {
  action: PreparedAction;
  runId: string;
  toolCallId: string;
  context: ToolExecutionContext;
  /** Never inferred from ticket or Linear content. */
  subject: LinearAuthoritySubject;
  activeGrants?: readonly AuthorityGrantV1[];
  preferredGrantId?: string;
}

export interface ExecuteHostLinearActionRequest
  extends PrepareHostLinearActionRequest {
  /** Never inferred from ticket or Linear content. */
  subject: LinearAuthoritySubject;
  activeGrants?: readonly AuthorityGrantV1[];
  preferredGrantId?: string;
}

export interface ReconcileHostLinearActionRequest {
  action: PreparedAction;
  runId: string;
  toolCallId: string;
  grantId: string;
  context: ToolExecutionContext;
}

export interface HostLinearActionError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type HostLinearActionPreparation =
  | {
      ok: true;
      status: "prepared";
      action: PreparedAction;
      preview: PreparedActionPreview;
      descriptor: ToolDescriptor;
    }
  | {
      ok: false;
      status: "rejected";
      error: HostLinearActionError;
    };

interface HostLinearActionFailureBase {
  ok: false;
  status: "rejected" | "not_applied" | "reconcile_required";
  error: HostLinearActionError;
  action?: PreparedAction;
  preview?: PreparedActionPreview;
  descriptor?: ToolDescriptor;
  grantId?: string;
}

export type HostLinearActionExecution =
  | {
      ok: true;
      status: "committed";
      action: PreparedAction;
      preview: PreparedActionPreview;
      descriptor: ToolDescriptor;
      grantId: string;
      output?: unknown;
      receipt: ActionReceipt;
    }
  | HostLinearActionFailureBase;

/**
 * Host-only lifecycle for fixed Linear mutations. The model sees the explicit
 * Linear tool catalog, never this executor, a token, or arbitrary GraphQL.
 */
export class HostLinearActionExecutor {
  private readonly registry: DefaultToolRegistry;

  constructor(private readonly options: HostLinearActionExecutorOptions) {
    this.registry = new DefaultToolRegistry(
      createLinearTools({
        client: options.client,
        gate: options.gate,
        runIdFactory: options.runIdFactory,
      }),
    );
  }

  async prepare(
    request: PrepareHostLinearActionRequest,
  ): Promise<HostLinearActionPreparation> {
    const fixedMutation = this.requireFixedMutation(request.toolName);
    if (!fixedMutation.ok) return fixedMutation;

    const context = bindExecutionIdentity(request);
    if (!context.ok) return context;

    const prepared = await this.registry.prepare(
      { name: request.toolName, arguments: request.arguments },
      context.context,
    );
    if (!prepared.ok) {
      return {
        ok: false,
        status: "rejected",
        error: {
          code: prepared.error.code,
          message: prepared.error.message,
        },
      };
    }
    return {
      ok: true,
      status: "prepared",
      action: prepared.action,
      preview: prepared.action.preview,
      descriptor: fixedMutation.descriptor,
    };
  }

  async execute(
    request: ExecuteHostLinearActionRequest,
  ): Promise<HostLinearActionExecution> {
    const prepared = await this.prepare(request);
    if (!prepared.ok) return prepared;
    return this.executePrepared({
      action: prepared.action,
      runId: request.runId,
      toolCallId: request.toolCallId,
      context: request.context,
      subject: request.subject,
      activeGrants: request.activeGrants,
      preferredGrantId: request.preferredGrantId,
    });
  }

  async executePrepared(
    request: ExecutePreparedHostLinearActionRequest,
  ): Promise<HostLinearActionExecution> {
    const fixedMutation = this.requireFixedMutation(request.action.toolName);
    if (!fixedMutation.ok) {
      return withPreparedFailure(fixedMutation, request.action);
    }
    const context = bindExecutionIdentity(request);
    if (!context.ok) return withPreparedFailure(context, request.action);
    if (
      request.action.runId !== request.runId ||
      request.action.toolCallId !== request.toolCallId
    ) {
      return preparedFailure(
        "rejected",
        "prepared_action_identity_mismatch",
        "Prepared Linear action does not belong to the supplied run and tool call.",
        request.action,
        fixedMutation.descriptor,
      );
    }

    let grants: readonly AuthorityGrantV1[];
    try {
      grants = await this.resolveActiveGrants(request.activeGrants);
    } catch (error) {
      return preparedFailure(
        "rejected",
        "authority_source_failed",
        safeMessage(error),
        request.action,
        fixedMutation.descriptor,
      );
    }

    const now = context.context.now?.() ?? new Date();
    const selection = await selectMatchingGrant({
      grants,
      action: request.action,
      descriptor: fixedMutation.descriptor,
      subject: request.subject,
      preferredGrantId: request.preferredGrantId,
      now,
    });
    if (!selection.ok) {
      return preparedFailure(
        "rejected",
        selection.error.code,
        selection.error.message,
        request.action,
        fixedMutation.descriptor,
        selection.error.details,
      );
    }

    let consumed: AuthorityGrantV1;
    try {
      consumed = await this.options.authorizeAndConsume({
        grantId: selection.grant.id,
        action: request.action,
        descriptor: fixedMutation.descriptor,
        subject: request.subject,
        now,
      });
      await assertConsumedGrant(
        selection.grant,
        consumed,
        request.action,
        fixedMutation.descriptor,
        request.subject,
      );
    } catch (error) {
      return preparedFailure(
        "rejected",
        "authority_consumption_failed",
        safeMessage(error),
        request.action,
        fixedMutation.descriptor,
      );
    }

    const authorization = {
      preparedActionId: request.action.id,
      payloadFingerprint: request.action.payloadFingerprint,
      grantId: consumed.id,
    };
    const result = await this.registry.executePrepared(
      request.action,
      context.context,
      authorization,
    );
    if (!result.ok || !result.receipt) {
      // Once authority is consumed, only an explicit not-applied proof is safe
      // to return as retryable. Missing/unknown provider state must reconcile.
      const uncertain = result.mutationState !== "not_applied";
      return preparedFailure(
        uncertain ? "reconcile_required" : "not_applied",
        result.error?.code ?? "linear_prepared_execution_failed",
        result.error?.message ?? "Prepared Linear execution failed.",
        request.action,
        fixedMutation.descriptor,
        result.error?.details,
        consumed.id,
      );
    }
    return {
      ok: true,
      status: "committed",
      action: request.action,
      preview: request.action.preview,
      descriptor: fixedMutation.descriptor,
      grantId: consumed.id,
      output: result.output,
      receipt: result.receipt,
    };
  }

  /** Readback-only recovery. This never dispatches or retries a mutation. */
  async reconcile(
    request: ReconcileHostLinearActionRequest,
  ): Promise<ActionReconciliationResult> {
    const fixedMutation = this.requireFixedMutation(request.action.toolName);
    if (!fixedMutation.ok) {
      return { outcome: "still_uncertain", message: fixedMutation.error.message };
    }
    const context = bindExecutionIdentity(request);
    if (!context.ok) {
      return { outcome: "still_uncertain", message: context.error.message };
    }
    if (
      request.action.runId !== request.runId ||
      request.action.toolCallId !== request.toolCallId ||
      !request.grantId.trim()
    ) {
      return {
        outcome: "still_uncertain",
        message: "Linear reconciliation identity does not match the prepared action.",
      };
    }
    return this.registry.reconcile(request.action, {
      ...context.context,
      authorizedAction: {
        preparedActionId: request.action.id,
        payloadFingerprint: request.action.payloadFingerprint,
        grantId: request.grantId,
      },
    });
  }

  private requireFixedMutation(
    toolName: string,
  ):
    | { ok: true; descriptor: ToolDescriptor }
    | Extract<HostLinearActionPreparation, { ok: false }> {
    if (
      !Object.prototype.hasOwnProperty.call(
        LINEAR_TOOL_OPERATION_MAP,
        toolName,
      )
    ) {
      return rejected(
        "linear_fixed_tool_required",
        "Only an explicitly registered fixed Linear tool may be used.",
      );
    }
    const descriptor = this.registry.getDescriptor(toolName);
    if (
      !descriptor ||
      descriptor.capability.system !== "linear" ||
      descriptor.effect === "read" ||
      descriptor.execution.preparation !== "required"
    ) {
      return rejected(
        "linear_mutation_required",
        `${toolName} is not a prepared fixed Linear mutation.`,
      );
    }
    return { ok: true, descriptor };
  }

  private async resolveActiveGrants(
    override?: readonly AuthorityGrantV1[],
  ): Promise<readonly AuthorityGrantV1[]> {
    const source = override ?? this.options.activeGrants;
    if (!source) return [];
    const grants = typeof source === "function" ? await source() : source;
    if (!Array.isArray(grants)) {
      throw new TypeError("Active authority grants must be an array.");
    }
    const ids = new Set<string>();
    for (const grant of grants) {
      if (ids.has(grant.id)) {
        throw new TypeError(`Duplicate active authority grant id: ${grant.id}`);
      }
      ids.add(grant.id);
    }
    return grants.map((grant) =>
      JSON.parse(JSON.stringify(grant)) as AuthorityGrantV1);
  }
}

async function selectMatchingGrant(input: {
  grants: readonly AuthorityGrantV1[];
  action: PreparedAction;
  descriptor: ToolDescriptor;
  subject: LinearAuthoritySubject;
  preferredGrantId?: string;
  now: Date;
}): Promise<
  | { ok: true; grant: AuthorityGrantV1 }
  | { ok: false; error: HostLinearActionError }
> {
  const permitted = input.preferredGrantId
    ? input.grants.filter((grant) => grant.id === input.preferredGrantId)
    : input.grants;
  const rejectedReasons: string[] = [];
  const matches: AuthorityGrantV1[] = [];

  for (const grant of permitted) {
    const kindError = grantKindError(grant, input.action, input.descriptor);
    if (kindError) {
      rejectedReasons.push(`${grant.id}: ${kindError}`);
      continue;
    }
    const evaluation = await evaluateAuthorityGrant({
      grant,
      action: input.action,
      descriptor: input.descriptor,
      subject: input.subject,
      now: input.now,
    });
    if (evaluation.allowed) matches.push(grant);
    else rejectedReasons.push(`${grant.id}: ${evaluation.reason}`);
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: "linear_authority_denied",
        message: input.preferredGrantId
          ? "The selected authority grant does not cover this prepared Linear action and subject."
          : "No active authority grant covers this prepared Linear action and subject.",
        ...(rejectedReasons.length > 0
          ? { details: { rejectedReasons } }
          : {}),
      },
    };
  }
  matches.sort(compareGrantPreference);
  return { ok: true, grant: matches[0] };
}

function grantKindError(
  grant: AuthorityGrantV1,
  action: PreparedAction,
  descriptor: ToolDescriptor,
): string | null {
  if (grant.kind === "one_shot") {
    return descriptor.approval.allowPromptGrant
      ? null
      : "Tool does not permit exact prompt grants.";
  }
  if (grant.kind === "prompt_bound") {
    if (!descriptor.approval.allowPromptGrant) {
      return "Tool does not permit prompt-bound grants.";
    }
    return grant.actionFingerprint === action.payloadFingerprint
      ? null
      : "Prompt-bound grant is not bound to this prepared action.";
  }
  if (!descriptor.approval.allowPersistentGrant) {
    return "Tool does not permit persistent grants.";
  }
  if (descriptor.effect === "destructive_mutation") {
    return "Destructive Linear mutations cannot use a persistent grant.";
  }
  return null;
}

function compareGrantPreference(
  left: AuthorityGrantV1,
  right: AuthorityGrantV1,
): number {
  const exact = (grant: AuthorityGrantV1) =>
    grant.actionFingerprint ? 0 : 1;
  const kindRank: Record<AuthorityGrantV1["kind"], number> = {
    one_shot: 0,
    prompt_bound: 1,
    run_bounded: 2,
    scheduled_bounded: 3,
  };
  return (
    exact(left) - exact(right) ||
    kindRank[left.kind] - kindRank[right.kind] ||
    Date.parse(left.expiresAt) - Date.parse(right.expiresAt) ||
    left.id.localeCompare(right.id)
  );
}

async function assertConsumedGrant(
  before: AuthorityGrantV1,
  consumed: AuthorityGrantV1,
  action: PreparedAction,
  descriptor: ToolDescriptor,
  subject: LinearAuthoritySubject,
): Promise<void> {
  if (
    consumed.id !== before.id ||
    consumed.authorityFingerprint !== before.authorityFingerprint ||
    consumed.subject.type !== subject.type ||
    consumed.subject.id !== subject.id
  ) {
    throw new Error("Authority consumption returned a different grant or subject.");
  }
  if (!(await verifyAuthorityGrantFingerprint(consumed))) {
    throw new Error("Consumed authority grant fingerprint is invalid.");
  }
  const minimumExternalMutations = before.usage.externalMutations + 1;
  const minimumCreates =
    before.usage.creates + (descriptor.capability.action === "create" ? 1 : 0);
  const minimumDeletes =
    before.usage.deletes + (descriptor.capability.action === "delete" ? 1 : 0);
  if (
    consumed.usage.actions < before.usage.actions + 1 ||
    consumed.usage.externalMutations < minimumExternalMutations ||
    consumed.usage.creates < minimumCreates ||
    consumed.usage.deletes < minimumDeletes ||
    consumed.usage.outboundBytes <
      before.usage.outboundBytes + action.preview.outboundBytes
  ) {
    throw new Error("Authority callback did not return atomically consumed usage.");
  }
  if (
    consumed.usage.actions > consumed.limits.maxActions ||
    consumed.usage.externalMutations > consumed.limits.maxExternalMutations ||
    consumed.usage.creates > consumed.limits.maxCreates ||
    consumed.usage.deletes > consumed.limits.maxDeletes ||
    consumed.usage.outboundBytes > consumed.limits.maxOutboundBytes ||
    (consumed.state !== "active" && consumed.state !== "exhausted")
  ) {
    throw new Error("Consumed authority grant state exceeds its persisted limits.");
  }
}

function bindExecutionIdentity(input: {
  runId: string;
  toolCallId: string;
  context: ToolExecutionContext;
}):
  | { ok: true; context: ToolExecutionContext }
  | Extract<HostLinearActionPreparation, { ok: false }> {
  const runId = input.runId.trim();
  const toolCallId = input.toolCallId.trim();
  if (!runId || !toolCallId) {
    return rejected(
      "linear_execution_identity_required",
      "Linear execution requires explicit run and tool-call identities.",
    );
  }
  if (
    (input.context.runId !== undefined && input.context.runId !== runId) ||
    (input.context.operationId !== undefined &&
      input.context.operationId !== toolCallId)
  ) {
    return rejected(
      "linear_execution_identity_mismatch",
      "Linear execution context belongs to a different run or tool call.",
    );
  }
  return {
    ok: true,
    context: { ...input.context, runId, operationId: toolCallId },
  };
}

function rejected(
  code: string,
  message: string,
): Extract<HostLinearActionPreparation, { ok: false }> {
  return { ok: false, status: "rejected", error: { code, message } };
}

function withPreparedFailure(
  failure: Extract<HostLinearActionPreparation, { ok: false }>,
  action: PreparedAction,
): HostLinearActionFailureBase {
  return {
    ...failure,
    action,
    preview: action.preview,
  };
}

function preparedFailure(
  status: HostLinearActionFailureBase["status"],
  code: string,
  message: string,
  action: PreparedAction,
  descriptor: ToolDescriptor,
  details?: Record<string, unknown>,
  grantId?: string,
): HostLinearActionFailureBase {
  return {
    ok: false,
    status,
    error: { code, message, ...(details ? { details } : {}) },
    action,
    preview: action.preview,
    descriptor,
    ...(grantId ? { grantId } : {}),
  };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
