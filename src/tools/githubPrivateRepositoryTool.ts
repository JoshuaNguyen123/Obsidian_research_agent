import type { RepositoryProfileV2 } from "../../extensions/code/repositories/RepositoryProfileV2";
import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type PreparedAction,
  type ToolDescriptor,
} from "../agent/actions";
import type {
  CreatePrivateGitHubRepositoryInput,
  GitHubRepositoryRecord,
} from "../integrations/github/GitHubRestClient";
import {
  createTrustedGitHubRepositoryBindingV2,
  parseTrustedGitHubRepositoryBindingV2,
  type TrustedGitHubRepositoryBindingV2,
} from "../integrations/github/TrustedGitHubRepositoryBindingV2";
import type { JsonSchemaObject } from "../model/types";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME =
  "github_create_private_repository";

export interface GitHubPrivateRepositoryDestinationV1
  extends CreatePrivateGitHubRepositoryInput {
  profile: RepositoryProfileV2;
  accountId: number;
  accountLogin: string;
  trustedAt: string;
}

export type GitHubPrivateRepositoryCheckpointStatusV1 =
  | "prepared"
  | "reconcile_required"
  | "verified"
  | "not_applied"
  | "blocked";

export interface GitHubPrivateRepositoryCheckpointV1 {
  version: 1;
  creationId: string;
  status: GitHubPrivateRepositoryCheckpointStatusV1;
  profileKey: string;
  ownerKind: "user" | "organization";
  owner: string;
  repository: string;
  preparedAction: PreparedAction;
  approvalId: string | null;
  approvalFingerprint: string | null;
  binding: TrustedGitHubRepositoryBindingV2 | null;
  receipt: ActionReceipt | null;
  blocker: { code: string; message: string } | null;
  updatedAt: string;
}

export interface CreateGitHubPrivateRepositoryToolOptionsV1 {
  resolveDestination(
    profileKey: string,
    signal?: AbortSignal,
  ): Promise<GitHubPrivateRepositoryDestinationV1 | null>;
  readRepository(
    destination: GitHubPrivateRepositoryDestinationV1,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord | null>;
  createPrivateRepository(
    destination: GitHubPrivateRepositoryDestinationV1,
    description: string | undefined,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord>;
  getCheckpoint(
    creationId: string,
  ): Promise<GitHubPrivateRepositoryCheckpointV1 | null>;
  persistCheckpoint(checkpoint: GitHubPrivateRepositoryCheckpointV1): Promise<void>;
  persistBinding(binding: TrustedGitHubRepositoryBindingV2): Promise<void>;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  isAvailable?: () => boolean;
  now?: () => Date;
}

export function createGitHubPrivateRepositoryTool(
  options: CreateGitHubPrivateRepositoryToolOptionsV1,
): AgentTool {
  const tool: AgentTool = {
    name: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    description:
      "Create exactly the host-bound GitHub repository as private after one fingerprint-bound approval. The host checkpoints before dispatch, performs an independent private-visibility readback, persists a V2 trusted binding, and reconciles ambiguous outcomes without blindly creating again.",
    parameters: PRIVATE_REPOSITORY_PARAMETERS,
    descriptor: PRIVATE_REPOSITORY_DESCRIPTOR,
    async execute(args, context) {
      return executePrivateRepositoryCreation(options, args, context);
    },
  };
  tool.executeResult = async (args, context) => {
    const output = await executePrivateRepositoryCreation(options, args, context);
    await options.persistExternalReceipt(output.receipt);
    return {
      ok: true,
      toolName: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
      output,
      receipt: output.receipt,
      mutationState: "applied" as const,
    };
  };
  return tool;
}

export function hasExplicitPrivateGitHubRepositoryCreationIntent(
  prompt: string,
): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  if (
    /\b(?:do not|don't|never|without|skip|exclude|no)\b[^.\n]{0,100}\b(?:create|github|repository|repo)\b/iu.test(
      value,
    )
  ) {
    return false;
  }
  return (
    /\b(?:create|make|provision)\b[\s\S]{0,100}\bprivate\b[\s\S]{0,80}\b(?:github\s+)?(?:repository|repo)\b/iu.test(
      value,
    ) ||
    /\b(?:create|make|provision)\b[\s\S]{0,100}\bgithub\b[\s\S]{0,80}\b(?:repository|repo)\b[\s\S]{0,80}\bprivate\b/iu.test(
      value,
    )
  );
}

export function parseGitHubPrivateRepositoryCheckpointMapV1(
  value: unknown,
): Record<string, GitHubPrivateRepositoryCheckpointV1> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: Record<string, GitHubPrivateRepositoryCheckpointV1> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    try {
      const checkpoint = parseCheckpoint(raw);
      if (checkpoint.creationId === key) parsed[key] = checkpoint;
    } catch {
      // Corrupt durable mutation state is quarantined by omission; it is never
      // treated as approval, proof, or permission to redispatch.
    }
  }
  return parsed;
}

async function executePrivateRepositoryCreation(
  options: CreateGitHubPrivateRepositoryToolOptionsV1,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<{
  status: "verified";
  binding: TrustedGitHubRepositoryBindingV2;
  receipt: ActionReceipt;
  checkpoint: GitHubPrivateRepositoryCheckpointV1;
}> {
  if (options.isAvailable?.() === false) {
    throw notApplied(
      "github_private_repository_unavailable",
      "Private repository creation requires a verified GitHub credential and the Integrations and Code capabilities.",
    );
  }
  if (!hasExplicitPrivateGitHubRepositoryCreationIntent(context.originalPrompt)) {
    throw notApplied(
      "github_private_repository_explicit_intent_required",
      "Creating a GitHub repository requires an explicit request to create the private repository.",
    );
  }
  if (!context.requestNestedApproval) {
    throw notApplied(
      "github_private_repository_approval_unavailable",
      "The exact GitHub repository-creation approval surface is unavailable.",
    );
  }
  const profileKey = logicalKey(args.profileKey, "repository profile key");
  const description = optionalText(args.description, "repository description", 1_024);
  const runId = identity(context.runId, "run id");
  const toolCallId = identity(context.operationId, "tool call id");
  const destination = await options.resolveDestination(
    profileKey,
    context.abortSignal,
  );
  if (!destination || destination.profile.key !== profileKey) {
    throw notApplied(
      "github_private_repository_destination_missing",
      "The repository profile has no exact host-trusted GitHub destination.",
    );
  }
  const creationId = `github-private-${profileKey}`;
  const existingCheckpoint = await options.getCheckpoint(creationId);
  if (
    existingCheckpoint &&
    existingCheckpoint.profileKey === profileKey &&
    existingCheckpoint.owner.toLowerCase() === destination.owner.toLowerCase() &&
    existingCheckpoint.repository.toLowerCase() ===
      destination.repository.toLowerCase() &&
    ["prepared", "reconcile_required"].includes(existingCheckpoint.status)
  ) {
    const reconciled = await reconcileReadback(
      options,
      existingCheckpoint,
      destination,
      context,
    );
    if (reconciled) return reconciled;
  }

  const action = await buildPreparedAction({
    creationId,
    runId,
    toolCallId,
    destination,
    description,
    now: now(options, context),
  });

  const before = await options.readRepository(destination, context.abortSignal);
  if (before) {
    return acceptVerifiedReadback({
      options,
      checkpoint: baseCheckpoint(action, destination, "prepared"),
      destination,
      readback: before,
      context,
      commitKind: "reconciled",
      grantId: "github-private-repository-deduplicated-readback",
    });
  }

  let checkpoint = baseCheckpoint(action, destination, "prepared");
  await options.persistCheckpoint(checkpoint);
  const approval = await context.requestNestedApproval({
    toolName: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    action: action.preview.summary,
    reason:
      "Approve only creation of this exact host-bound repository with private visibility. Push, pull request, merge, and cleanup require separate approval boundaries.",
    policyTags: [
      "github_private_repository_create",
      "exact",
      "separate_publication_authority",
    ],
    preparedAction: action,
    timeoutMs: 120_000,
    confirmationIndex: 1,
    requiredConfirmations: 1,
  });
  if (!approval.approved) {
    checkpoint = {
      ...checkpoint,
      status: "not_applied",
      blocker: {
        code: "github_private_repository_approval_denied",
        message: "Private repository creation was not approved.",
      },
      updatedAt: now(options, context).toISOString(),
    };
    await options.persistCheckpoint(checkpoint);
    throw notApplied(
      "github_private_repository_approval_denied",
      "Private repository creation was not approved.",
    );
  }
  if (approval.approvalFingerprint !== action.payloadFingerprint) {
    throw notApplied(
      "github_private_repository_approval_stale",
      "The GitHub repository-creation approval does not match the exact prepared payload.",
    );
  }

  // Persist dispatch uncertainty before the provider mutation. A crash after
  // this write always resumes through read-only provider reconciliation.
  checkpoint = {
    ...checkpoint,
    status: "reconcile_required",
    approvalId: approval.approvalId,
    approvalFingerprint: approval.approvalFingerprint,
    blocker: {
      code: "github_private_repository_readback_required",
      message:
        "Repository creation may have been dispatched; exact provider readback is required before any retry.",
    },
    updatedAt: now(options, context).toISOString(),
  };
  await options.persistCheckpoint(checkpoint);

  try {
    await options.createPrivateRepository(
      destination,
      description,
      context.abortSignal,
    );
  } catch {
    // Creation conflicts and transport ambiguity are intentionally handled by
    // the same independent readback below. Provider error bodies are not
    // persisted or returned to the model.
  }
  const readback = await options.readRepository(destination, context.abortSignal);
  if (!readback) {
    const blockerMessage =
      "Independent GitHub readback proves the private repository does not exist; a new explicit approval is required to try again.";
    checkpoint = {
      ...checkpoint,
      status: "not_applied",
      blocker: {
        code: "github_private_repository_not_applied",
        message: blockerMessage,
      },
      updatedAt: now(options, context).toISOString(),
    };
    await options.persistCheckpoint(checkpoint);
    throw notApplied(
      "github_private_repository_not_applied",
      blockerMessage,
    );
  }
  return acceptVerifiedReadback({
    options,
    checkpoint,
    destination,
    readback,
    context,
    commitKind: "committed",
    grantId: approval.approvalId,
  });
}

async function reconcileReadback(
  options: CreateGitHubPrivateRepositoryToolOptionsV1,
  checkpoint: GitHubPrivateRepositoryCheckpointV1,
  destination: GitHubPrivateRepositoryDestinationV1,
  context: ToolExecutionContext,
) {
  const readback = await options.readRepository(destination, context.abortSignal);
  if (!readback) {
    const notApplied: GitHubPrivateRepositoryCheckpointV1 = {
      ...checkpoint,
      status: "not_applied",
      blocker: {
        code: "github_private_repository_not_applied",
        message:
          "Read-only reconciliation proved the repository was not created; no mutation was replayed.",
      },
      updatedAt: now(options, context).toISOString(),
    };
    await options.persistCheckpoint(notApplied);
    return null;
  }
  return acceptVerifiedReadback({
    options,
    checkpoint,
    destination,
    readback,
    context,
    commitKind: "reconciled",
    grantId:
      checkpoint.approvalId ?? "github-private-repository-reconciled-readback",
  });
}

async function acceptVerifiedReadback(input: {
  options: CreateGitHubPrivateRepositoryToolOptionsV1;
  checkpoint: GitHubPrivateRepositoryCheckpointV1;
  destination: GitHubPrivateRepositoryDestinationV1;
  readback: GitHubRepositoryRecord;
  context: ToolExecutionContext;
  commitKind: "committed" | "reconciled";
  grantId: string;
}) {
  let binding: TrustedGitHubRepositoryBindingV2;
  const observedAt = now(input.options, input.context).toISOString();
  try {
    binding = createTrustedGitHubRepositoryBindingV2({
      key: `github-${input.destination.profile.key}`,
      profile: input.destination.profile,
      owner: input.destination.owner,
      repository: input.destination.repository,
      repositoryReadback: input.readback,
      observedAt,
      verifiedAccountId: input.destination.accountId,
      verifiedAccountLogin: input.destination.accountLogin,
      trustedAt: input.destination.trustedAt,
    });
  } catch {
    const blockerMessage =
      "GitHub readback is not the exact active private repository. Public repositories are never converted automatically.";
    const blocked: GitHubPrivateRepositoryCheckpointV1 = {
      ...input.checkpoint,
      status: "blocked",
      blocker: {
        code: "github_private_repository_visibility_or_identity_mismatch",
        message: blockerMessage,
      },
      updatedAt: observedAt,
    };
    await input.options.persistCheckpoint(blocked);
    throw notApplied(
      "github_private_repository_visibility_or_identity_mismatch",
      blockerMessage,
    );
  }
  const receipt: ActionReceipt = {
    version: 1,
    id: `github-private-repository-${binding.repositoryReadbackFingerprint.slice(7, 39)}`,
    runId: input.checkpoint.preparedAction.runId,
    actionId: input.checkpoint.preparedAction.id,
    toolName: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    operation: "create",
    resource: {
      system: "github",
      resourceType: "private_repository",
      id: String(binding.repositoryId),
      identifier: `${binding.owner}/${binding.repository}`,
      url: input.readback.htmlUrl,
      accountId: String(binding.verifiedAccountId),
      repositoryId: String(binding.repositoryId),
      repositoryProfileId: binding.repositoryProfileKey,
      revision: binding.repositoryReadbackFingerprint,
    },
    relatedResources: [{
      system: "git",
      resourceType: "repository_profile",
      id: binding.repositoryProfileKey,
      path: binding.canonicalRepositoryRoot,
      revision: binding.repositoryProfileFingerprint,
    }],
    message:
      input.commitKind === "committed"
        ? `Created and independently verified private GitHub repository ${binding.owner}/${binding.repository}.`
        : `Reconciled and independently verified private GitHub repository ${binding.owner}/${binding.repository} without replay.`,
    payloadFingerprint: input.checkpoint.preparedAction.payloadFingerprint,
    grantId: input.grantId,
    idempotencyKey: input.checkpoint.preparedAction.idempotencyKey,
    startedAt: input.checkpoint.preparedAction.preparedAt,
    committedAt: observedAt,
    commitKind: input.commitKind,
    readback: {
      status: "verified",
      checkedAt: observedAt,
      observedRevision: String(binding.repositoryId),
      observedFingerprint: binding.repositoryReadbackFingerprint,
    },
    effects: { affectedCount: input.commitKind === "committed" ? 1 : 0 },
  };
  const checkpoint: GitHubPrivateRepositoryCheckpointV1 = {
    ...input.checkpoint,
    status: "verified",
    binding,
    receipt,
    blocker: null,
    updatedAt: observedAt,
  };
  await input.options.persistBinding(binding);
  await input.options.persistCheckpoint(checkpoint);
  return { status: "verified" as const, binding, receipt, checkpoint };
}

async function buildPreparedAction(input: {
  creationId: string;
  runId: string;
  toolCallId: string;
  destination: GitHubPrivateRepositoryDestinationV1;
  description: string | undefined;
  now: Date;
}): Promise<PreparedAction> {
  const repositoryIdentity = `${input.destination.owner}/${input.destination.repository}`;
  const preparedAt = input.now.toISOString();
  const normalizedArgs = {
    profileKey: input.destination.profile.key,
    ownerKind: input.destination.ownerKind,
    owner: input.destination.owner,
    repository: input.destination.repository,
    visibility: "private",
    private: true,
    ...(input.description ? { description: input.description } : {}),
  };
  return withPreparedActionFingerprint({
    version: 1,
    id: input.creationId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    target: {
      system: "github",
      resourceType: "private_repository",
      id: repositoryIdentity,
      identifier: repositoryIdentity,
      accountId: String(input.destination.accountId),
      repositoryProfileId: input.destination.profile.key,
      revision: "absent",
    },
    relatedResources: [{
      system: "git",
      resourceType: "repository_profile",
      id: input.destination.profile.key,
      path: input.destination.profile.repositoryRoot,
      revision: await sha256Fingerprint(input.destination.profile),
    }],
    normalizedArgs,
    preview: {
      summary: `Create private GitHub repository ${repositoryIdentity}.`,
      destination: `GitHub ${repositoryIdentity} (private)`,
      before: { state: "absent" },
      after: { visibility: "private", archived: false },
      outboundPayload: normalizedArgs,
      warnings: [
        "This approval does not authorize a push, pull request, merge, visibility change, or cleanup.",
      ],
      outboundBytes: new TextEncoder().encode(JSON.stringify(normalizedArgs)).length,
    },
    expectedTargetRevision: "absent",
    idempotencyKey: `github-private-repository:${repositoryIdentity.toLowerCase()}`,
    reconciliationKey: `github-private-repository:${repositoryIdentity.toLowerCase()}`,
    requiredConfirmations: 1,
    preparedAt,
    expiresAt: new Date(input.now.getTime() + 120_000).toISOString(),
  });
}

function baseCheckpoint(
  action: PreparedAction,
  destination: GitHubPrivateRepositoryDestinationV1,
  status: GitHubPrivateRepositoryCheckpointStatusV1,
): GitHubPrivateRepositoryCheckpointV1 {
  return {
    version: 1,
    creationId: action.id,
    status,
    profileKey: destination.profile.key,
    ownerKind: destination.ownerKind,
    owner: destination.owner,
    repository: destination.repository,
    preparedAction: action,
    approvalId: null,
    approvalFingerprint: null,
    binding: null,
    receipt: null,
    blocker: null,
    updatedAt: action.preparedAt,
  };
}

function parseCheckpoint(value: unknown): GitHubPrivateRepositoryCheckpointV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("GitHub private repository checkpoint must be an object.");
  }
  const record = value as Record<string, unknown>;
  const status = String(record.status);
  if (
    record.version !== 1 ||
    !["prepared", "reconcile_required", "verified", "not_applied", "blocked"].includes(status)
  ) {
    throw new TypeError("Unsupported GitHub private repository checkpoint.");
  }
  const action = record.preparedAction as PreparedAction;
  const binding = record.binding === null
    ? null
    : parseTrustedGitHubRepositoryBindingV2(record.binding);
  if (
    !action ||
    action.toolName !== CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME ||
    action.id !== record.creationId
  ) {
    throw new TypeError("GitHub private repository checkpoint action is invalid.");
  }
  const blocker = record.blocker === null
    ? null
    : record.blocker as { code: string; message: string };
  return {
    version: 1,
    creationId: identity(record.creationId, "creation id"),
    status: status as GitHubPrivateRepositoryCheckpointStatusV1,
    profileKey: logicalKey(record.profileKey, "profile key"),
    ownerKind: record.ownerKind === "user" ? "user" : "organization",
    owner: identity(record.owner, "owner"),
    repository: identity(record.repository, "repository"),
    preparedAction: action,
    approvalId: record.approvalId === null
      ? null
      : identity(record.approvalId, "approval id"),
    approvalFingerprint: record.approvalFingerprint === null
      ? null
      : fingerprint(record.approvalFingerprint, "approval fingerprint"),
    binding,
    receipt: record.receipt === null ? null : record.receipt as ActionReceipt,
    blocker,
    updatedAt: canonicalTimestamp(record.updatedAt, "checkpoint updatedAt"),
  };
}

function now(
  options: CreateGitHubPrivateRepositoryToolOptionsV1,
  context: ToolExecutionContext,
): Date {
  return (options.now ?? context.now ?? (() => new Date()))();
}

function identity(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 500 || /[\0\r\n]/u.test(text)) {
    throw notApplied("github_private_repository_invalid_argument", `${label} is invalid.`);
  }
  return text;
}

function logicalKey(value: unknown, label: string): string {
  const key = identity(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(key)) {
    throw notApplied("github_private_repository_invalid_argument", `${label} is invalid.`);
  }
  return key;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = identity(value, label);
  if (text.length > maximum) {
    throw notApplied(
      "github_private_repository_invalid_argument",
      `${label} is too long.`,
    );
  }
  return text;
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

const PRIVATE_REPOSITORY_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  capability: {
    system: "github",
    resourceType: "private_repository",
    action: "create",
  },
  effect: "publish",
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
  operationGoals: ["github_private_repository_create"],
};

const PRIVATE_REPOSITORY_PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    profileKey: { type: "string" },
    description: { type: "string" },
  },
  required: ["profileKey"],
};
