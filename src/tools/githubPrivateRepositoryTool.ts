import type { RepositoryProfileV2 } from "../../extensions/code/repositories/RepositoryProfileV2";
import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type PreparedAction,
  type ToolDescriptor,
} from "../agent/actions";
import type {
  CreateGitHubRepositoryInput,
  GitHubRepositoryRecord,
} from "../integrations/github/GitHubRestClient";
import {
  isRepositoryVisibility,
  resolveExplicitRepositoryVisibilityChoiceV1,
  type RepositoryVisibility,
} from "../integrations/github/RepositoryVisibility";
import {
  createTrustedGitHubRepositoryBindingV2,
  parseTrustedGitHubRepositoryBindingV2,
  type TrustedGitHubRepositoryBindingV2,
} from "../integrations/github/TrustedGitHubRepositoryBindingV2";
import type { JsonSchemaObject } from "../model/types";
import { hasExplicitGitHubPublicationIntent } from "./githubPublicationTool";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const CREATE_GITHUB_REPOSITORY_TOOL_NAME = "github_create_repository";
export const LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME =
  "github_create_private_repository";
/** @deprecated Use CREATE_GITHUB_REPOSITORY_TOOL_NAME. */
export const CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME =
  CREATE_GITHUB_REPOSITORY_TOOL_NAME;

export interface GitHubRepositoryDestinationV2
  extends Omit<CreateGitHubRepositoryInput, "visibility"> {
  profile: RepositoryProfileV2;
  accountId: number;
  accountLogin: string;
  trustedAt: string;
}

/** Legacy type alias; visibility is now selected explicitly per operation. */
export type GitHubPrivateRepositoryDestinationV1 = GitHubRepositoryDestinationV2;

export type GitHubPrivateRepositoryCheckpointStatusV1 =
  | "waiting_for_repository_visibility"
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
  visibility: RepositoryVisibility | null;
  preparedAction: PreparedAction | null;
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
  ): Promise<GitHubRepositoryDestinationV2 | null>;
  readRepository(
    destination: GitHubRepositoryDestinationV2,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryRecord | null>;
  createRepository?: (
    destination: GitHubRepositoryDestinationV2,
    visibility: RepositoryVisibility,
    description: string | undefined,
    signal?: AbortSignal,
  ) => Promise<GitHubRepositoryRecord>;
  /** Legacy private-only provider adapter. */
  createPrivateRepository?: (
    destination: GitHubRepositoryDestinationV2,
    description: string | undefined,
    signal?: AbortSignal,
  ) => Promise<GitHubRepositoryRecord>;
  getCheckpoint(
    creationId: string,
  ): Promise<GitHubPrivateRepositoryCheckpointV1 | null>;
  persistCheckpoint(checkpoint: GitHubPrivateRepositoryCheckpointV1): Promise<void>;
  persistBinding(binding: TrustedGitHubRepositoryBindingV2): Promise<void>;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  isAvailable?: () => boolean;
  now?: () => Date;
}

export type CreateGitHubRepositoryToolOptionsV2 =
  CreateGitHubPrivateRepositoryToolOptionsV1;

export function createGitHubRepositoryTool(
  options: CreateGitHubRepositoryToolOptionsV2,
): AgentTool {
  const tool: AgentTool = {
    name: CREATE_GITHUB_REPOSITORY_TOOL_NAME,
    description:
      "Create exactly the host-bound GitHub repository only after the user explicitly chooses public or private visibility and approves the fingerprint-bound action. If visibility is unanswered, pause without a GitHub mutation. Public creation warns that the repository and committed history will be internet-visible. The host checkpoints before dispatch, independently reads visibility back, and reconciles ambiguity without blindly creating again.",
    parameters: REPOSITORY_PARAMETERS,
    descriptor: REPOSITORY_DESCRIPTOR,
    async execute(args, context) {
      return executeRepositoryCreation(options, args, context);
    },
  };
  tool.executeResult = async (args, context) => {
    const output = await executeRepositoryCreation(options, args, context);
    await options.persistExternalReceipt(output.receipt);
    return {
      ok: true,
      toolName: CREATE_GITHUB_REPOSITORY_TOOL_NAME,
      output,
      receipt: output.receipt,
      mutationState: "applied" as const,
    };
  };
  return tool;
}

/** Legacy factory name retained for callers and persisted V1 state. */
export function createGitHubPrivateRepositoryTool(
  options: CreateGitHubPrivateRepositoryToolOptionsV1,
): AgentTool {
  return createGitHubRepositoryTool(options);
}

/**
 * V1 routing/checkpoint compatibility. The alias executes the same explicit
 * visibility gate and therefore never restores a private default.
 */
export function createLegacyPrivateGitHubRepositoryToolAlias(
  tool: AgentTool,
): AgentTool {
  if (tool.name !== CREATE_GITHUB_REPOSITORY_TOOL_NAME) {
    throw new TypeError("Legacy GitHub repository alias requires the V2 tool.");
  }
  return {
    ...tool,
    name: LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    description:
      "Legacy routing alias for github_create_repository. It still requires the user's explicit public/private choice and never defaults to private.",
    ...(tool.descriptor
      ? {
          descriptor: {
            ...tool.descriptor,
            name: LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
          },
        }
      : {}),
    ...(tool.executeResult
      ? {
          executeResult: async (
            args: Record<string, unknown>,
            context: ToolExecutionContext,
          ) => ({
            ...(await tool.executeResult!(args, context)),
            toolName: LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
          }),
        }
      : {}),
  };
}

export function hasGitHubRepositoryCreationIntent(prompt: string): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  if (hasPrivateGitHubRepositoryCreationNegation(value)) return false;
  if (
    /\b(?:github_create_repository|github_create_private_repository)\b/iu.test(
      value,
    )
  ) {
    return true;
  }
  return (
    /\b(?:create|make|provision)\b[\s\S]{0,120}\b(?:github\s+)?(?:repository|repo)\b/iu.test(
      value,
    ) ||
    /\b(?:create|make|provision)\b[\s\S]{0,120}\bgithub\b/iu.test(value)
  );
}

export function hasGitHubRepositoryBootstrapIntent(prompt: string): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  return (
    hasGitHubRepositoryCreationIntent(value) ||
    (!hasPrivateGitHubRepositoryCreationNegation(value) &&
      hasExplicitGitHubPublicationIntent(value))
  );
}

export function hasExplicitPrivateGitHubRepositoryCreationIntent(
  prompt: string,
): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  const normalized = value.toLowerCase();
  // Ignore continue-meta "do not stop/ask … before GitHub"; still honor
  // "do not create a GitHub repository" / without/skip/exclude.
  const createTarget =
    /\b(?:create|github|repository|repo)\b/iu;
  let createNegated =
    /\b(?:without|skip|exclude)\b[^.\n]{0,100}\b(?:create|github|repository|repo)\b/iu.test(
      value,
    ) || /\bno\b\s+(?:github|repository|repo)\b/iu.test(value);
  if (!createNegated) {
    for (const match of normalized.matchAll(
      /\b(?:do not|don't|never)\b([^.\n]{0,120})/gu,
    )) {
      const rest = match[1] ?? "";
      if (/^\s*(?:stop|ask|wait|continue|idle|halt|pause)\b/u.test(rest)) {
        continue;
      }
      if (createTarget.test(rest)) {
        createNegated = true;
        break;
      }
    }
  }
  if (createNegated) {
    return false;
  }
  // Snake_case tool tokens are one word for \bcreate\b; accept the named tool.
  if (/\bgithub_create_private_repository\b/iu.test(value)) {
    return true;
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

/**
 * A private publication to an exact host/issue-bound destination necessarily
 * needs repository existence proof before push. This is narrower than generic
 * GitHub publication: it does not infer create authority for an arbitrary or
 * model-invented destination. The tool still performs a read-only existence
 * check first and requires its separate fingerprint-bound approval before it
 * creates an absent repository.
 */
export function hasPrivateGitHubRepositoryBootstrapIntent(
  prompt: string,
): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  if (hasExplicitPrivateGitHubRepositoryCreationIntent(value)) return true;
  if (
    hasPrivateGitHubRepositoryCreationNegation(value) ||
    !hasExplicitGitHubPublicationIntent(value)
  ) {
    return false;
  }
  return (
    /\b(?:issue|host|profile|repository)[-\s]?bound\b[\s\S]{0,100}\bprivate\s+github\s+(?:destination|repository|repo)\b/iu.test(
      value,
    ) ||
    /\bprivate\s+github\s+(?:destination|repository|repo)\b[\s\S]{0,100}\b(?:issue|host|profile|repository)[-\s]?bound\b/iu.test(
      value,
    )
  );
}

function hasPrivateGitHubRepositoryCreationNegation(value: string): boolean {
  const normalized = value.toLowerCase();
  const createTarget = /\b(?:create|github|repository|repo)\b/iu;
  if (
    /\b(?:without|skip|exclude)\b[^.\n]{0,100}\b(?:create|github|repository|repo)\b/iu.test(
      value,
    ) ||
    /\bno\b\s+(?:github|repository|repo)\b/iu.test(value)
  ) {
    return true;
  }
  for (const match of normalized.matchAll(
    /\b(?:do not|don't|never)\b([^.\n]{0,120})/gu,
  )) {
    const rest = match[1] ?? "";
    if (/^\s*(?:stop|ask|wait|continue|idle|halt|pause)\b/u.test(rest)) {
      continue;
    }
    if (createTarget.test(rest)) return true;
  }
  return false;
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

export const parseGitHubRepositoryCheckpointMapV2 =
  parseGitHubPrivateRepositoryCheckpointMapV1;

async function executeRepositoryCreation(
  options: CreateGitHubRepositoryToolOptionsV2,
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
      "github_repository_unavailable",
      "Repository creation requires a verified GitHub credential and the Integrations and Code capabilities.",
    );
  }
  if (!hasGitHubRepositoryBootstrapIntent(context.originalPrompt)) {
    throw notApplied(
      "github_repository_explicit_intent_required",
      "Creating a GitHub repository requires an explicit current creation or publication request.",
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
      "github_repository_destination_missing",
      "The repository profile has no exact host-trusted GitHub destination.",
    );
  }
  const creationId = `github-repository-${profileKey}`;
  const legacyCreationId = `github-private-${profileKey}`;
  const visibilityChoice = resolveExplicitRepositoryVisibilityChoiceV1(
    context.originalPrompt,
  );
  const requestedVisibility = isRepositoryVisibility(args.visibility)
    ? args.visibility
    : null;
  if (
    visibilityChoice.status !== "chosen" ||
    requestedVisibility === null ||
    requestedVisibility !== visibilityChoice.visibility
  ) {
    const checkpoint = waitingCheckpoint({
      creationId,
      destination,
      now: now(options, context),
      message:
        visibilityChoice.status === "chosen" && requestedVisibility !== null
          ? `The requested ${requestedVisibility} visibility does not match the user's explicit ${visibilityChoice.visibility} choice. Ask again before any GitHub mutation.`
          : visibilityChoice.status === "chosen"
            ? `The user chose ${visibilityChoice.visibility}, but the repository action omitted that exact visibility. Retry with the explicit choice.`
            : visibilityChoice.message,
    });
    await options.persistCheckpoint(checkpoint);
    throw notApplied(
      "waiting_for_repository_visibility",
      checkpoint.blocker!.message,
    );
  }
  const visibility = visibilityChoice.visibility;
  if (!context.requestNestedApproval) {
    throw notApplied(
      "github_repository_approval_unavailable",
      "The exact GitHub repository-creation approval surface is unavailable.",
    );
  }
  const existingCheckpoint =
    (await options.getCheckpoint(creationId)) ??
    (visibility === "private"
      ? await options.getCheckpoint(legacyCreationId)
      : null);
  if (
    existingCheckpoint &&
    existingCheckpoint.profileKey === profileKey &&
    existingCheckpoint.owner.toLowerCase() === destination.owner.toLowerCase() &&
    existingCheckpoint.repository.toLowerCase() ===
      destination.repository.toLowerCase() &&
    existingCheckpoint.visibility === visibility &&
    ["prepared", "reconcile_required"].includes(existingCheckpoint.status)
  ) {
    const reconciled = await reconcileReadback(
      options,
      existingCheckpoint,
      destination,
      visibility,
      context,
    );
    if (reconciled) return reconciled;
  }

  const action = await buildPreparedAction({
    creationId,
    runId,
    toolCallId,
    destination,
    visibility,
    description,
    now: now(options, context),
  });

  const before = await options.readRepository(destination, context.abortSignal);
  if (before) {
    return acceptVerifiedReadback({
      options,
      checkpoint: baseCheckpoint(action, destination, visibility, "prepared"),
      destination,
      visibility,
      readback: before,
      context,
      commitKind: "reconciled",
      grantId: `github-${visibility}-repository-deduplicated-readback`,
    });
  }

  let checkpoint = baseCheckpoint(action, destination, visibility, "prepared");
  await options.persistCheckpoint(checkpoint);
  const approval = await context.requestNestedApproval({
    toolName: CREATE_GITHUB_REPOSITORY_TOOL_NAME,
    action: action.preview.summary,
    reason:
      visibility === "public"
        ? "Approve creation of this exact public repository. Its contents and committed history will be visible on the internet. Push, pull request, merge, and cleanup require separate approval boundaries."
        : "Approve only creation of this exact host-bound repository with private visibility. Push, pull request, merge, and cleanup require separate approval boundaries.",
    policyTags: [
      "github_repository_create",
      `visibility_${visibility}`,
      ...(visibility === "public" ? ["internet_visible"] : []),
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
        code: "github_repository_approval_denied",
        message: `${capitalize(visibility)} repository creation was not approved.`,
      },
      updatedAt: now(options, context).toISOString(),
    };
    await options.persistCheckpoint(checkpoint);
    throw notApplied(
      "github_repository_approval_denied",
      `${capitalize(visibility)} repository creation was not approved.`,
    );
  }
  if (approval.approvalFingerprint !== action.payloadFingerprint) {
    throw notApplied(
      "github_repository_approval_stale",
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
      code: "github_repository_readback_required",
      message:
        "Repository creation may have been dispatched; exact provider readback is required before any retry.",
    },
    updatedAt: now(options, context).toISOString(),
  };
  await options.persistCheckpoint(checkpoint);

  let createFailureCode: string | null = null;
  try {
    if (options.createRepository) {
      await options.createRepository(
        destination,
        visibility,
        description,
        context.abortSignal,
      );
    } else if (visibility === "private" && options.createPrivateRepository) {
      await options.createPrivateRepository(
        destination,
        description,
        context.abortSignal,
      );
    } else {
      throw notApplied(
        "github_public_repository_provider_unavailable",
        "The host does not provide a public-repository creation adapter.",
      );
    }
  } catch (error) {
    // Creation conflicts and transport ambiguity are intentionally handled by
    // the same independent readback below. Provider error bodies are not
    // persisted or returned to the model; only a stable error code is kept.
    createFailureCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code).slice(0, 80)
        : "github_create_failed";
  }
  const readback = await options.readRepository(destination, context.abortSignal);
  if (!readback) {
    const blockerMessage = createFailureCode
      ? `Independent GitHub readback proves the ${visibility} repository does not exist after create (${createFailureCode}) for ${destination.owner}/${destination.repository}; a new explicit approval is required to try again.`
      : `Independent GitHub readback proves the ${visibility} repository does not exist for ${destination.owner}/${destination.repository}; a new explicit approval is required to try again.`;
    checkpoint = {
      ...checkpoint,
      status: "not_applied",
      blocker: {
        code: "github_repository_not_applied",
        message: blockerMessage,
      },
      updatedAt: now(options, context).toISOString(),
    };
    await options.persistCheckpoint(checkpoint);
    throw notApplied(
      "github_repository_not_applied",
      blockerMessage,
    );
  }
  return acceptVerifiedReadback({
    options,
    checkpoint,
    destination,
    visibility,
    readback,
    context,
    commitKind: "committed",
    grantId: approval.approvalId,
  });
}

async function reconcileReadback(
  options: CreateGitHubRepositoryToolOptionsV2,
  checkpoint: GitHubPrivateRepositoryCheckpointV1,
  destination: GitHubRepositoryDestinationV2,
  visibility: RepositoryVisibility,
  context: ToolExecutionContext,
) {
  const readback = await options.readRepository(destination, context.abortSignal);
  if (!readback) {
    const notApplied: GitHubPrivateRepositoryCheckpointV1 = {
      ...checkpoint,
      status: "not_applied",
      blocker: {
        code: "github_repository_not_applied",
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
    visibility,
    readback,
    context,
    commitKind: "reconciled",
    grantId:
      checkpoint.approvalId ??
      `github-${visibility}-repository-reconciled-readback`,
  });
}

async function acceptVerifiedReadback(input: {
  options: CreateGitHubRepositoryToolOptionsV2;
  checkpoint: GitHubPrivateRepositoryCheckpointV1;
  destination: GitHubRepositoryDestinationV2;
  visibility: RepositoryVisibility;
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
      expectedVisibility: input.visibility,
      observedAt,
      verifiedAccountId: input.destination.accountId,
      verifiedAccountLogin: input.destination.accountLogin,
      trustedAt: input.destination.trustedAt,
    });
  } catch {
    const blockerMessage =
      `GitHub readback is not the exact active ${input.visibility} repository. Existing repositories are never converted automatically.`;
    const blocked: GitHubPrivateRepositoryCheckpointV1 = {
      ...input.checkpoint,
      status: "blocked",
      blocker: {
        code: "github_repository_visibility_or_identity_mismatch",
        message: blockerMessage,
      },
      updatedAt: observedAt,
    };
    await input.options.persistCheckpoint(blocked);
    throw notApplied(
      "github_repository_visibility_or_identity_mismatch",
      blockerMessage,
    );
  }
  const action = input.checkpoint.preparedAction;
  if (!action) {
    throw notApplied(
      "github_repository_prepared_action_missing",
      "Verified repository readback has no exact prepared creation action.",
    );
  }
  const receipt: ActionReceipt = {
    version: 1,
    id: `github-${binding.visibility}-repository-${binding.repositoryReadbackFingerprint.slice(7, 39)}`,
    runId: action.runId,
    actionId: action.id,
    toolName: CREATE_GITHUB_REPOSITORY_TOOL_NAME,
    operation: "create",
    resource: {
      system: "github",
      resourceType:
        binding.visibility === "private"
          ? "private_repository"
          : "public_repository",
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
        ? `Created and independently verified ${binding.visibility} GitHub repository ${binding.owner}/${binding.repository}.`
        : `Reconciled and independently verified ${binding.visibility} GitHub repository ${binding.owner}/${binding.repository} without replay.`,
    payloadFingerprint: action.payloadFingerprint,
    grantId: input.grantId,
    idempotencyKey: action.idempotencyKey,
    startedAt: action.preparedAt,
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
  destination: GitHubRepositoryDestinationV2;
  visibility: RepositoryVisibility;
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
    visibility: input.visibility,
    private: input.visibility === "private",
    ...(input.description ? { description: input.description } : {}),
  };
  return withPreparedActionFingerprint({
    version: 1,
    id: input.creationId,
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: CREATE_GITHUB_REPOSITORY_TOOL_NAME,
    target: {
      system: "github",
      resourceType:
        input.visibility === "private"
          ? "private_repository"
          : "public_repository",
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
      summary: `Create ${input.visibility} GitHub repository ${repositoryIdentity}.`,
      destination: `GitHub ${repositoryIdentity} (${input.visibility})`,
      before: { state: "absent" },
      after: { visibility: input.visibility, archived: false },
      outboundPayload: normalizedArgs,
      warnings: [
        ...(input.visibility === "public"
          ? [
              "Public repository contents and committed history will be visible on the internet.",
            ]
          : []),
        "This approval does not authorize a push, pull request, merge, visibility change, or cleanup.",
      ],
      outboundBytes: new TextEncoder().encode(JSON.stringify(normalizedArgs)).length,
    },
    expectedTargetRevision: "absent",
    idempotencyKey: `github-${input.visibility}-repository:${repositoryIdentity.toLowerCase()}`,
    reconciliationKey: `github-${input.visibility}-repository:${repositoryIdentity.toLowerCase()}`,
    requiredConfirmations: 1,
    preparedAt,
    expiresAt: new Date(input.now.getTime() + 120_000).toISOString(),
  });
}

function waitingCheckpoint(input: {
  creationId: string;
  destination: GitHubRepositoryDestinationV2;
  now: Date;
  message: string;
}): GitHubPrivateRepositoryCheckpointV1 {
  return {
    version: 1,
    creationId: input.creationId,
    status: "waiting_for_repository_visibility",
    profileKey: input.destination.profile.key,
    ownerKind: input.destination.ownerKind,
    owner: input.destination.owner,
    repository: input.destination.repository,
    visibility: null,
    preparedAction: null,
    approvalId: null,
    approvalFingerprint: null,
    binding: null,
    receipt: null,
    blocker: {
      code: "waiting_for_repository_visibility",
      message: input.message,
    },
    updatedAt: input.now.toISOString(),
  };
}

function baseCheckpoint(
  action: PreparedAction,
  destination: GitHubRepositoryDestinationV2,
  visibility: RepositoryVisibility,
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
    visibility,
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
    throw new TypeError("GitHub repository checkpoint must be an object.");
  }
  const record = value as Record<string, unknown>;
  const status = String(record.status);
  if (
    record.version !== 1 ||
    ![
      "waiting_for_repository_visibility",
      "prepared",
      "reconcile_required",
      "verified",
      "not_applied",
      "blocked",
    ].includes(status)
  ) {
    throw new TypeError("Unsupported GitHub repository checkpoint.");
  }
  const action = record.preparedAction === null
    ? null
    : record.preparedAction as PreparedAction;
  const visibility = isRepositoryVisibility(record.visibility)
    ? record.visibility
    : action?.toolName === LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME
      ? "private"
      : null;
  const binding = record.binding === null
    ? null
    : parseTrustedGitHubRepositoryBindingV2(record.binding);
  if (status === "waiting_for_repository_visibility") {
    if (action !== null || visibility !== null) {
      throw new TypeError("Waiting GitHub repository checkpoint is invalid.");
    }
  } else if (
    !action ||
    ![
      CREATE_GITHUB_REPOSITORY_TOOL_NAME,
      LEGACY_CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
    ].includes(action.toolName) ||
    action.id !== record.creationId ||
    visibility === null ||
    action.normalizedArgs.visibility !== visibility
  ) {
    throw new TypeError("GitHub repository checkpoint action is invalid.");
  }
  if (binding && binding.visibility !== visibility) {
    throw new TypeError("GitHub repository checkpoint binding visibility drifted.");
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
    visibility,
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
  options: CreateGitHubRepositoryToolOptionsV2,
  context: ToolExecutionContext,
): Date {
  return (options.now ?? context.now ?? (() => new Date()))();
}

function identity(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 500 || /[\0\r\n]/u.test(text)) {
    throw notApplied("github_repository_invalid_argument", `${label} is invalid.`);
  }
  return text;
}

function logicalKey(value: unknown, label: string): string {
  const key = identity(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(key)) {
    throw notApplied("github_repository_invalid_argument", `${label} is invalid.`);
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
      "github_repository_invalid_argument",
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

function capitalize(value: RepositoryVisibility): string {
  return value === "public" ? "Public" : "Private";
}

const REPOSITORY_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: CREATE_GITHUB_REPOSITORY_TOOL_NAME,
  capability: {
    system: "github",
    resourceType: "repository",
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
  operationGoals: [
    "github_repository_create",
    "github_private_repository_create",
  ],
};

const REPOSITORY_PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    profileKey: { type: "string" },
    visibility: {
      type: "string",
      enum: ["public", "private"],
      description:
        "The user's explicit public/private choice. Omit when unanswered so the host can pause without mutation.",
    },
    description: { type: "string" },
  },
  required: ["profileKey"],
};
