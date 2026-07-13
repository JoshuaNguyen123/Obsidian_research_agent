import type { VerifiedCodePublicationHandoffV1 } from "../../packages/core-api/src";
import type { RepositoryProfileV2 } from "../../extensions/code/repositories/RepositoryProfileV2";
import type { ActionReceipt, ToolDescriptor } from "../agent/actions";
import {
  GitHubPublicationWorkflowV1,
  type GitHubPublicationApprovalPortV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationHandoffV1,
  type TrustedGitHubPublicationBindingV1,
} from "../integrations/github/GitHubPublicationWorkflow";
import type { TrustedGitHubRepositoryBindingV1 } from "../integrations/github/TrustedGitHubRepositoryBindingV1";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME =
  "publish_verified_code_to_github";

export interface CreateGitHubPublicationToolOptionsV1 {
  resolveHandoff(profileKey: string): Promise<VerifiedCodePublicationHandoffV1 | null>;
  resolveBinding(input: {
    profileKey: string;
    handoff: VerifiedCodePublicationHandoffV1;
  }): Promise<GitHubPublicationBindingResolutionV1 | null>;
  getCheckpoint(publicationId: string): Promise<GitHubPublicationCheckpointV1 | null>;
  createWorkflow(input: {
    approvalIdentity: { runId: string; toolCallId: string; toolName: string };
    approvals: GitHubPublicationApprovalPortV1;
    context: ToolExecutionContext;
    handoff: VerifiedCodePublicationHandoffV1;
    binding: GitHubPublicationBindingResolutionV1;
  }): GitHubPublicationWorkflowV1;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  isAvailable?: () => boolean;
  now?: () => Date;
}

export interface GitHubPublicationBindingResolutionV1 {
  workflowBinding: TrustedGitHubPublicationBindingV1;
  publicationBinding: TrustedGitHubRepositoryBindingV1;
  profile: RepositoryProfileV2;
  completionProof?: "draft_pr" | "merged_pr";
}

export function createGitHubPublicationTool(
  options: CreateGitHubPublicationToolOptionsV1,
): AgentTool {
  const tool: AgentTool = {
    name: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    description:
      "Publish the latest host-verified local commit for a trusted repository profile to its agent-owned GitHub branch and draft pull request, or refresh proof and request a separate double-exact merge. The model supplies only a logical profile key and PR prose; local paths, SHAs, credentials, repository destinations, checks, and merge policy are host-resolved.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["publish_draft", "merge"],
          description: "Create/update the draft PR, or refresh proof and request merge.",
        },
        profileKey: {
          type: "string",
          description: "Trusted logical RepositoryProfileV2 key.",
        },
        title: {
          type: "string",
          description: "Draft pull request title for publish_draft.",
        },
        body: {
          type: "string",
          description: "Draft pull request body for publish_draft.",
        },
      },
      required: ["action", "profileKey"],
      additionalProperties: false,
    },
    descriptor: GITHUB_PUBLICATION_DESCRIPTOR,
    async execute(args, context) {
      return executeGitHubPublication(options, args, context);
    },
  };
  tool.executeResult = async (args, context) => {
    const checkpoint = await executeGitHubPublication(options, args, context);
    if (checkpoint.status === "reconcile_required") {
      throw new ToolExecutionError(
        "github_publication_reconcile_required",
        checkpoint.blocker?.message ??
          "GitHub publication requires remote readback reconciliation.",
        { mutationState: "may_have_applied" },
      );
    }
    const receipt = createWorkflowReceipt(checkpoint, context);
    await options.persistExternalReceipt(receipt);
    return {
      ok: true,
      toolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
      output: checkpoint,
      receipt,
      mutationState: "applied" as const,
    };
  };
  return tool;
}

export function hasExplicitGitHubPublicationIntent(prompt: string): boolean {
  const value = typeof prompt === "string" ? prompt : "";
  return (
    /\b(?:push|publish|send|open|create|update)\b[\s\S]{0,100}\b(?:github|pull request|draft pr|branch)\b/iu.test(value) ||
    /\b(?:github|pull request|draft pr)\b[\s\S]{0,100}\b(?:push|publish|create|update|merge)\b/iu.test(value) ||
    /\bmerge\b[\s\S]{0,80}\b(?:github|pull request|pr)\b/iu.test(value)
  );
}

async function executeGitHubPublication(
  options: CreateGitHubPublicationToolOptionsV1,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<GitHubPublicationCheckpointV1> {
  if (options.isAvailable?.() === false) {
    throw notApplied(
      "github_publication_unavailable",
      "GitHub publication requires the integrations extension, code extension, secure GitHub credential, and trusted repository binding.",
    );
  }
  if (!hasExplicitGitHubPublicationIntent(context.originalPrompt)) {
    throw notApplied(
      "github_publication_explicit_user_mission_required",
      "GitHub publication or merge requires an explicit current user mission.",
    );
  }
  assertExactKeys(args, ["action", "profileKey"], ["title", "body"]);
  const action = args.action;
  if (action !== "publish_draft" && action !== "merge") {
    throw notApplied("github_publication_action_invalid", "GitHub publication action is invalid.");
  }
  const profileKey = logicalKey(args.profileKey);
  const handoff = await options.resolveHandoff(profileKey);
  if (!handoff || handoff.repositoryProfileKey !== profileKey) {
    throw notApplied(
      "github_verified_handoff_missing",
      "No latest publication-eligible verified local commit exists for this repository profile.",
    );
  }
  const binding = await options.resolveBinding({ profileKey, handoff });
  if (!binding || binding.workflowBinding.profileKey !== profileKey) {
    throw notApplied(
      "github_trusted_binding_missing",
      "The repository profile has no verified GitHub destination bound to the pinned account.",
    );
  }
  const runId = identity(context.runId, "run id");
  const toolCallId = identity(context.operationId, "tool call id");
  if (!context.requestNestedApproval) {
    throw notApplied(
      "github_approval_unavailable",
      "The host approval surface is unavailable for GitHub publication.",
    );
  }
  const approvals: GitHubPublicationApprovalPortV1 = {
    request: async (request) => {
      const approvalIds: string[] = [];
      for (
        let confirmationIndex = 1;
        confirmationIndex <= request.requiredConfirmations;
        confirmationIndex += 1
      ) {
        const decision = await context.requestNestedApproval!({
          toolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
          action: request.summary,
          reason:
            request.kind === "merge"
              ? "Approve the exact PR head, base, fresh check/review snapshot, and squash merge. Any drift invalidates this approval."
              : "Approve the exact trusted repository, agent branch, verified commit, and outbound GitHub payload.",
          policyTags: [
            "github_publication",
            request.kind,
            request.requiredConfirmations === 2 ? "double_exact" : "exact",
          ],
          preparedAction: request.preparedAction,
          timeoutMs: 120_000,
          confirmationIndex,
          requiredConfirmations: request.requiredConfirmations,
        });
        if (!decision.approved) {
          return {
            approved: false,
            approvalFingerprint: request.approvalFingerprint,
            reason: decision.reason,
          };
        }
        if (decision.approvalFingerprint !== request.approvalFingerprint) {
          return {
            approved: false,
            approvalFingerprint: request.approvalFingerprint,
            reason: "approval_fingerprint_drift",
          };
        }
        approvalIds.push(decision.approvalId);
      }
      return {
        approved: true,
        approvalId: approvalIds.join(":"),
        approvalFingerprint: request.approvalFingerprint,
        confirmations: request.requiredConfirmations,
      };
    },
  };
  const workflow = options.createWorkflow({
    approvalIdentity: {
      runId,
      toolCallId,
      toolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    },
    approvals,
    context,
    handoff,
    binding,
  });
  const publicationId = `github-${profileKey}-${handoff.fingerprint.slice(7, 31)}`;
  if (action === "publish_draft") {
    const title = boundedText(args.title, "pull request title", 1, 256);
    const body = boundedText(args.body, "pull request body", 1, 65_536, true);
    const existing = await options.getCheckpoint(publicationId);
    if (existing?.status === "finalized") return existing;
    if (existing?.status === "reconcile_required") {
      return workflow.reconcile(
        existing,
        binding.workflowBinding,
        context.abortSignal,
        { handoff: adaptHandoff(handoff), title, body },
      );
    }
    if (existing && [
      ...(existing.completionProof === "draft_pr" ? ["draft_pr_verified"] : []),
      "waiting_linear",
      "waiting_linear_link",
      "linear_linked",
      "waiting_linear_completion",
      "linear_completed",
      "waiting_obsidian",
    ].includes(existing.status)) {
      return workflow.resumeFinalization(
        existing,
        binding.workflowBinding,
        context.abortSignal,
      );
    }
    if (existing?.status === "pushed_verified") {
      return workflow.resumeDraftPublication(existing, {
        title,
        body,
        binding: binding.workflowBinding,
        signal: context.abortSignal,
      });
    }
    if (existing) return existing;
    return workflow.publishDraft({
      explicitUserMission: true,
      publicationId,
      title,
      body,
      handoff: adaptHandoff(handoff),
      binding: binding.workflowBinding,
      completionProof: binding.completionProof ?? "merged_pr",
      signal: context.abortSignal,
    });
  }
  const checkpoint = await options.getCheckpoint(publicationId);
  if (!checkpoint) {
    throw notApplied(
      "github_publication_checkpoint_missing",
      "Publish and verify the draft pull request before requesting merge.",
    );
  }
  if (checkpoint.status === "finalized") return checkpoint;
  if (
    checkpoint.status === "merged_verified" ||
    checkpoint.status === "waiting_linear_link" ||
    checkpoint.status === "linear_linked" ||
    checkpoint.status === "waiting_linear_completion" ||
    checkpoint.status === "linear_completed" ||
    checkpoint.status === "waiting_linear" ||
    checkpoint.status === "waiting_obsidian"
  ) {
    return workflow.resumeFinalization(
      checkpoint,
      binding.workflowBinding,
      context.abortSignal,
    );
  }
  return workflow.merge(checkpoint, binding.workflowBinding, context.abortSignal);
}

function adaptHandoff(
  handoff: VerifiedCodePublicationHandoffV1,
): GitHubPublicationHandoffV1 {
  return {
    profileKey: handoff.repositoryProfileKey,
    workspaceId: handoff.workspaceId,
    agentBranch: handoff.branch,
    baseSha: handoff.baseSha,
    commitSha: handoff.commitSha,
    treeSha: handoff.treeSha,
    diffFingerprint: handoff.diffFingerprint,
    validationReceiptFingerprints: [
      handoff.targetedValidationFingerprint,
      handoff.fullValidationFingerprint,
    ],
    handoffFingerprint: handoff.fingerprint,
  };
}

function createWorkflowReceipt(
  checkpoint: GitHubPublicationCheckpointV1,
  context: ToolExecutionContext,
): ActionReceipt {
  const merged = checkpoint.mergeSha !== null;
  const pullRequest = checkpoint.pullRequest;
  const committedAt = optionsTimestamp(context.now);
  const payloadFingerprint = merged
    ? checkpoint.mergeApprovalFingerprint
    : checkpoint.publishApprovalFingerprint;
  if (!payloadFingerprint) {
    throw notApplied(
      "github_publication_proof_missing",
      "GitHub publication completed without its exact approval fingerprint.",
    );
  }
  return {
    version: 1,
    id: `github-publication-${checkpoint.publicationId}-${merged ? "merge" : "draft"}`,
    runId: identity(context.runId, "run id"),
    actionId: `github-publication-action-${checkpoint.publicationId}-${merged ? "merge" : "draft"}`,
    toolName: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    operation: merged ? "merge" : "publish",
    resource: {
      system: "github",
      resourceType: pullRequest ? "pull_request" : "repository_branch",
      id: pullRequest ? String(pullRequest.number) : checkpoint.branch,
      ...(pullRequest?.htmlUrl ? { url: pullRequest.htmlUrl } : {}),
      revision: checkpoint.headSha,
    },
    message: merged
      ? `Verified GitHub merge for pull request #${pullRequest?.number ?? "unknown"}.`
      : `Verified GitHub draft publication for ${checkpoint.branch}.`,
    payloadFingerprint,
    grantId: merged ? "github-double-exact-approval" : "github-exact-approval",
    idempotencyKey: `github-publication:${checkpoint.publicationId}:${merged ? "merge" : "draft"}`,
    startedAt: checkpoint.updatedAt,
    committedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: committedAt,
      observedRevision: checkpoint.headSha,
      observedFingerprint:
        checkpoint.proofSnapshot?.snapshotFingerprint ?? checkpoint.handoffFingerprint,
    },
  };
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length || optional.some((key) => key in value && value[key] === undefined)) {
    throw notApplied(
      "github_publication_arguments_invalid",
      "GitHub publication arguments do not match the closed tool contract.",
    );
  }
}

function logicalKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw notApplied(
      "github_publication_profile_invalid",
      "GitHub publication requires a trusted logical repository profile key.",
    );
  }
  return value;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw notApplied("github_publication_context_invalid", `GitHub publication ${label} is unavailable.`);
  }
  return value.trim();
}

function boundedText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  allowNewlines = false,
): string {
  if (typeof value !== "string") {
    throw notApplied("github_publication_arguments_invalid", `${label} is required.`);
  }
  const text = value.replace(/\r\n?/gu, "\n").trim();
  const controls = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (text.length < minimum || text.length > maximum || controls.test(text)) {
    throw notApplied(
      "github_publication_arguments_invalid",
      `${label} must contain ${minimum}-${maximum} safe characters.`,
    );
  }
  return text;
}

function optionsTimestamp(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

const GITHUB_PUBLICATION_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
  capability: { system: "github", resourceType: "pull_request", action: "publish" },
  effect: "publish",
  risk: "critical",
  approval: {
    allowPromptGrant: false,
    allowPersistentGrant: false,
    fallback: "double_exact",
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
  allowedPrincipals: ["single_agent", "lead", "code_worker"],
  receiptKind: "external_action",
  operationGoals: ["external_action_receipt"],
};
