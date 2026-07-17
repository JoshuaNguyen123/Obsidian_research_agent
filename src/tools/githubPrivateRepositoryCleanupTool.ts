import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type PreparedAction,
  type ToolDescriptor,
} from "../agent/actions";
import type { GitHubRepositoryRecord } from "../integrations/github/GitHubRestClient";
import {
  fingerprintGitHubRepositoryReadbackV2,
  parseTrustedGitHubRepositoryBindingV2,
  type TrustedGitHubRepositoryBindingV2,
} from "../integrations/github/TrustedGitHubRepositoryBindingV2";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME =
  "github_delete_private_repository";

export type GitHubPrivateRepositoryCleanupStatusV1 =
  | "prepared"
  | "reconcile_required"
  | "verified"
  | "not_applied"
  | "blocked";

export interface GitHubPrivateRepositoryCleanupCheckpointV1 {
  version: 1;
  cleanupId: string;
  profileKey: string;
  status: GitHubPrivateRepositoryCleanupStatusV1;
  bindingFingerprint: string;
  preparedAction: PreparedAction;
  approvalId: string | null;
  receipt: ActionReceipt | null;
  blocker: { code: string; message: string } | null;
  updatedAt: string;
}

export interface CreateGitHubPrivateRepositoryCleanupToolOptionsV1 {
  resolveBinding(
    profileKey: string,
  ): Promise<TrustedGitHubRepositoryBindingV2 | null>;
  readRepository(
    binding: TrustedGitHubRepositoryBindingV2,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord | null>;
  deleteRepository(
    binding: TrustedGitHubRepositoryBindingV2,
    signal?: AbortSignal,
  ): Promise<void>;
  getCheckpoint(
    cleanupId: string,
  ): Promise<GitHubPrivateRepositoryCleanupCheckpointV1 | null>;
  persistCheckpoint(
    checkpoint: GitHubPrivateRepositoryCleanupCheckpointV1,
  ): Promise<void>;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  isAvailable?: () => boolean;
  now?: () => Date;
}

export function parseGitHubPrivateRepositoryCleanupCheckpointMapV1(
  value: unknown,
): Record<string, GitHubPrivateRepositoryCleanupCheckpointV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, GitHubPrivateRepositoryCleanupCheckpointV1> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    try {
      const checkpoint = parseCheckpoint(raw);
      if (checkpoint.cleanupId === key) parsed[key] = checkpoint;
    } catch {
      // Invalid destructive-operation state is quarantined. It can never be
      // interpreted as approval or permission to redispatch deletion.
    }
  }
  return parsed;
}

export function createGitHubPrivateRepositoryCleanupTool(
  options: CreateGitHubPrivateRepositoryCleanupToolOptionsV1,
): AgentTool {
  const execute = async (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => executeCleanup(options, args, context);
  return {
    name: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    description:
      "Permanently delete only the exact host-bound private GitHub repository after a separate fingerprint-bound approval. The host checkpoints before deletion and requires independent absence readback; it cannot delete public, unbound, or model-selected repositories.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { profileKey: { type: "string" } },
      required: ["profileKey"],
    },
    descriptor: PRIVATE_REPOSITORY_CLEANUP_DESCRIPTOR,
    execute,
    async executeResult(args, context) {
      const output = await execute(args, context);
      await options.persistExternalReceipt(output.receipt);
      return {
        ok: true,
        toolName: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
        output,
        receipt: output.receipt,
        mutationState: "applied" as const,
      };
    },
  };
}

export function hasExplicitPrivateGitHubRepositoryCleanupIntent(
  prompt: string,
): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  if (
    /\b(?:do not|don't|without|skip|exclude|keep|retain)\b[^.\n]{0,100}\b(?:delete|remove|clean\s*up)\b/iu.test(
      value,
    )
  ) {
    return false;
  }
  return (
    /\b(?:delete|remove|clean\s*up)\b[^.\n]{0,140}\b(?:private\s+)?github\s+repositor(?:y|ies)\b/iu.test(
      value,
    ) ||
    /\b(?:private\s+)?github\s+repositor(?:y|ies)\b[^.\n]{0,140}\b(?:delete|remove|clean\s*up)\b/iu.test(
      value,
    )
  );
}

async function executeCleanup(
  options: CreateGitHubPrivateRepositoryCleanupToolOptionsV1,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<{
  status: "verified";
  receipt: ActionReceipt;
  checkpoint: GitHubPrivateRepositoryCleanupCheckpointV1;
}> {
  if (options.isAvailable?.() === false) {
    throw notApplied(
      "github_private_repository_cleanup_unavailable",
      "Private repository cleanup requires a verified GitHub credential and private repository binding.",
    );
  }
  if (!hasExplicitPrivateGitHubRepositoryCleanupIntent(context.originalPrompt)) {
    throw notApplied(
      "github_private_repository_cleanup_explicit_intent_required",
      "Permanent private repository cleanup requires an explicit current user request.",
    );
  }
  if (!context.requestNestedApproval) {
    throw notApplied(
      "github_private_repository_cleanup_approval_unavailable",
      "The separate exact cleanup approval surface is unavailable.",
    );
  }
  const profileKey = logicalKey(args.profileKey, "repository profile key");
  const resolvedBinding = await options.resolveBinding(profileKey);
  if (!resolvedBinding) {
    throw notApplied(
      "github_private_repository_cleanup_binding_missing",
      "No verified private GitHub repository binding exists for the exact repository profile.",
    );
  }
  const binding = parseTrustedGitHubRepositoryBindingV2(resolvedBinding);
  if (binding.repositoryProfileKey !== profileKey) {
    throw notApplied(
      "github_private_repository_cleanup_binding_mismatch",
      "The cleanup target does not match the exact trusted repository profile.",
    );
  }
  const cleanupId = `github-private-cleanup-${profileKey}`;
  const existing = await options.getCheckpoint(cleanupId);
  const before = await options.readRepository(binding, context.abortSignal);
  if (!before) {
    return persistVerifiedAbsence({
      options,
      binding,
      context,
      checkpoint:
        existing ??
        (await initialCheckpoint(binding, context, cleanupId, now(options, context))),
      commitKind: "reconciled",
      approvalId:
        existing?.approvalId ?? "github-private-repository-absence-readback",
    });
  }
  assertExactPrivateReadback(binding, before);
  // A present exact readback proves that a previously uncertain deletion was
  // not applied. A new explicit run may therefore prepare a fresh approval;
  // the old approval is never reused and deletion is never blindly replayed.
  let checkpoint = await initialCheckpoint(
    binding,
    context,
    cleanupId,
    now(options, context),
  );
  await options.persistCheckpoint(checkpoint);
  const approval = await context.requestNestedApproval({
    toolName: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    action: checkpoint.preparedAction.preview.summary,
    reason:
      "Approve permanent deletion of only this exact read-back-verified private repository. This does not authorize any other GitHub or local cleanup.",
    policyTags: [
      "github_private_repository_cleanup",
      "destructive",
      "exact",
      "checkpoint_before_mutation",
    ],
    preparedAction: checkpoint.preparedAction,
    timeoutMs: 120_000,
    confirmationIndex: 1,
    requiredConfirmations: 1,
  });
  if (
    !approval.approved ||
    approval.approvalFingerprint !==
      checkpoint.preparedAction.payloadFingerprint
  ) {
    const deniedMessage = "Private repository cleanup was denied or stale.";
    checkpoint = {
      ...checkpoint,
      status: "not_applied",
      blocker: {
        code: "github_private_repository_cleanup_approval_denied",
        message: deniedMessage,
      },
      updatedAt: now(options, context).toISOString(),
    };
    await options.persistCheckpoint(checkpoint);
    throw notApplied(
      "github_private_repository_cleanup_approval_denied",
      deniedMessage,
    );
  }
  checkpoint = {
    ...checkpoint,
    status: "reconcile_required",
    approvalId: approval.approvalId,
    blocker: {
      code: "github_private_repository_cleanup_readback_required",
      message:
        "Repository deletion may have been dispatched; independent absence readback is required.",
    },
    updatedAt: now(options, context).toISOString(),
  };
  await options.persistCheckpoint(checkpoint);
  try {
    await options.deleteRepository(binding, context.abortSignal);
  } catch {
    // Transport uncertainty is resolved only by the fixed repository readback.
  }
  const after = await options.readRepository(binding, context.abortSignal);
  if (after) {
    assertExactPrivateReadback(binding, after);
    throw notApplied(
      "github_private_repository_cleanup_reconcile_required",
      "The exact private repository is still present after cleanup dispatch; no retry was attempted.",
    );
  }
  return persistVerifiedAbsence({
    options,
    binding,
    context,
    checkpoint,
    commitKind: "committed",
    approvalId: approval.approvalId,
  });
}

async function initialCheckpoint(
  binding: TrustedGitHubRepositoryBindingV2,
  context: ToolExecutionContext,
  cleanupId: string,
  observedAt: Date,
): Promise<GitHubPrivateRepositoryCleanupCheckpointV1> {
  const runId = identity(context.runId, "run id");
  const toolCallId = identity(context.operationId, "tool call id");
  const repositoryIdentity = `${binding.owner}/${binding.repository}`;
  const preparedAt = observedAt.toISOString();
  const preparedAction = await withPreparedActionFingerprint({
    version: 1,
    id: cleanupId,
    runId,
    toolCallId,
    toolName: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    target: {
      system: "github",
      resourceType: "private_repository",
      id: String(binding.repositoryId),
      identifier: repositoryIdentity,
      accountId: String(binding.verifiedAccountId),
      repositoryId: String(binding.repositoryId),
      repositoryProfileId: binding.repositoryProfileKey,
      revision: binding.repositoryReadbackFingerprint,
    },
    relatedResources: [],
    normalizedArgs: {
      profileKey: binding.repositoryProfileKey,
      bindingFingerprint: binding.fingerprint,
      repositoryReadbackFingerprint: binding.repositoryReadbackFingerprint,
    },
    preview: {
      summary: `Permanently delete private GitHub repository ${repositoryIdentity}.`,
      destination: `GitHub ${repositoryIdentity}`,
      before: { visibility: "private", repositoryId: binding.repositoryId },
      after: { state: "absent" },
      warnings: [
        "This operation permanently deletes the exact repository and is separate from branch or pull-request cleanup.",
      ],
      outboundBytes: 0,
    },
    expectedTargetRevision: binding.repositoryReadbackFingerprint,
    idempotencyKey: `github-private-repository-cleanup:${binding.repositoryId}`,
    reconciliationKey: `github-private-repository-cleanup:${binding.repositoryId}`,
    requiredConfirmations: 1,
    preparedAt,
    expiresAt: new Date(observedAt.getTime() + 120_000).toISOString(),
  });
  return {
    version: 1,
    cleanupId,
    profileKey: binding.repositoryProfileKey,
    status: "prepared",
    bindingFingerprint: binding.fingerprint,
    preparedAction,
    approvalId: null,
    receipt: null,
    blocker: null,
    updatedAt: preparedAt,
  };
}

async function persistVerifiedAbsence(input: {
  options: CreateGitHubPrivateRepositoryCleanupToolOptionsV1;
  binding: TrustedGitHubRepositoryBindingV2;
  context: ToolExecutionContext;
  checkpoint: GitHubPrivateRepositoryCleanupCheckpointV1;
  commitKind: "committed" | "reconciled";
  approvalId: string;
}) {
  const observedAt = now(input.options, input.context).toISOString();
  const receipt: ActionReceipt = {
    version: 1,
    id: `github-private-cleanup-${input.binding.repositoryId}`,
    runId: input.checkpoint.preparedAction.runId,
    actionId: input.checkpoint.preparedAction.id,
    toolName: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    operation: "delete",
    resource: {
      system: "github",
      resourceType: "private_repository",
      id: String(input.binding.repositoryId),
      identifier: `${input.binding.owner}/${input.binding.repository}`,
      accountId: String(input.binding.verifiedAccountId),
      repositoryId: String(input.binding.repositoryId),
      repositoryProfileId: input.binding.repositoryProfileKey,
      revision: "absent",
    },
    message:
      input.commitKind === "committed"
        ? `Deleted and independently verified absence of private GitHub repository ${input.binding.owner}/${input.binding.repository}.`
        : `Independently verified that private GitHub repository ${input.binding.owner}/${input.binding.repository} is already absent without replaying deletion.`,
    payloadFingerprint: input.checkpoint.preparedAction.payloadFingerprint,
    grantId: input.approvalId,
    idempotencyKey: input.checkpoint.preparedAction.idempotencyKey,
    startedAt: input.checkpoint.preparedAction.preparedAt,
    committedAt: observedAt,
    commitKind: input.commitKind,
    readback: {
      status: "verified",
      checkedAt: observedAt,
      observedRevision: "absent",
      observedFingerprint: await sha256Fingerprint({
        repositoryId: input.binding.repositoryId,
        state: "absent",
      }),
    },
    effects: { affectedCount: input.commitKind === "committed" ? 1 : 0 },
  };
  const checkpoint: GitHubPrivateRepositoryCleanupCheckpointV1 = {
    ...input.checkpoint,
    status: "verified",
    receipt,
    blocker: null,
    updatedAt: observedAt,
  };
  await input.options.persistCheckpoint(checkpoint);
  return { status: "verified" as const, receipt, checkpoint };
}

function assertExactPrivateReadback(
  binding: TrustedGitHubRepositoryBindingV2,
  readback: GitHubRepositoryRecord,
): void {
  if (
    readback.private !== true ||
    readback.archived === true ||
    readback.id !== binding.repositoryId ||
    readback.fullName.toLowerCase() !==
      `${binding.owner}/${binding.repository}`.toLowerCase() ||
    readback.defaultBranch !== binding.defaultBranch ||
    fingerprintGitHubRepositoryReadbackV2(readback) !==
      binding.repositoryReadbackFingerprint
  ) {
    throw notApplied(
      "github_private_repository_cleanup_binding_drift",
      "Repository cleanup readback does not match the exact active private binding.",
    );
  }
}

function parseCheckpoint(
  value: unknown,
): GitHubPrivateRepositoryCleanupCheckpointV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitHub private repository cleanup checkpoint must be an object.");
  }
  const record = value as Record<string, unknown>;
  const status = String(record.status);
  if (
    record.version !== 1 ||
    !["prepared", "reconcile_required", "verified", "not_applied", "blocked"].includes(
      status,
    )
  ) {
    throw new TypeError("Unsupported GitHub private repository cleanup checkpoint.");
  }
  const cleanupId = logicalKey(record.cleanupId, "cleanup id");
  const action = record.preparedAction as PreparedAction;
  if (
    !action ||
    action.toolName !== DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME ||
    action.id !== cleanupId
  ) {
    throw new TypeError("GitHub private repository cleanup checkpoint action is invalid.");
  }
  const blocker =
    record.blocker === null
      ? null
      : (record.blocker as { code: string; message: string });
  if (
    blocker !== null &&
    (typeof blocker.code !== "string" || typeof blocker.message !== "string")
  ) {
    throw new TypeError("GitHub private repository cleanup blocker is invalid.");
  }
  return {
    version: 1,
    cleanupId,
    profileKey: logicalKey(record.profileKey, "profile key"),
    status: status as GitHubPrivateRepositoryCleanupStatusV1,
    bindingFingerprint: fingerprint(
      record.bindingFingerprint,
      "binding fingerprint",
    ),
    preparedAction: action,
    approvalId:
      record.approvalId === null
        ? null
        : identity(record.approvalId, "approval id"),
    receipt: record.receipt === null ? null : (record.receipt as ActionReceipt),
    blocker,
    updatedAt: canonicalTimestamp(record.updatedAt, "checkpoint updatedAt"),
  };
}

function now(
  options: CreateGitHubPrivateRepositoryCleanupToolOptionsV1,
  context: ToolExecutionContext,
): Date {
  return (options.now ?? context.now ?? (() => new Date()))();
}

function identity(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 500 || /[\0\r\n]/u.test(text)) {
    throw notApplied(
      "github_private_repository_cleanup_invalid_argument",
      `${label} is invalid.`,
    );
  }
  return text;
}

function logicalKey(value: unknown, label: string): string {
  const key = identity(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(key)) {
    throw notApplied(
      "github_private_repository_cleanup_invalid_argument",
      `${label} is invalid.`,
    );
  }
  return key;
}

function fingerprint(value: unknown, label: string): string {
  const text = identity(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(text)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return text;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const text = identity(value, label);
  if (
    !Number.isFinite(Date.parse(text)) ||
    new Date(Date.parse(text)).toISOString() !== text
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return text;
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

const PRIVATE_REPOSITORY_CLEANUP_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  capability: {
    system: "github",
    resourceType: "private_repository",
    action: "delete",
  },
  effect: "destructive_mutation",
  risk: "critical",
  approval: {
    allowPromptGrant: false,
    allowPersistentGrant: false,
    fallback: "exact",
  },
  execution: {
    preparation: "none",
    desktopOnly: true,
    cacheable: false,
    parallelSafe: false,
  },
  durability: {
    journal: true,
    receipt: true,
    readback: "required",
    reconciliation: "required",
  },
  allowedPrincipals: ["single_agent", "lead"],
  receiptKind: "external_action",
  operationGoals: ["github_private_repository_cleanup"],
};
