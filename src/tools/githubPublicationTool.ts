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
import type { TrustedGitHubRepositoryBindingV2 } from "../integrations/github/TrustedGitHubRepositoryBindingV2";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME =
  "publish_verified_code_to_github";

export interface CreateGitHubPublicationToolOptionsV1 {
  resolveHandoff(profileKey: string): Promise<VerifiedCodePublicationHandoffV1 | null>;
  resolveBinding(input: {
    profileKey: string;
    handoff: VerifiedCodePublicationHandoffV1;
    context: ToolExecutionContext;
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
  privateRepositoryBinding: TrustedGitHubRepositoryBindingV2;
  profile: RepositoryProfileV2;
  completionProof?: "draft_pr" | "merged_pr";
}

export function createGitHubPublicationTool(
  options: CreateGitHubPublicationToolOptionsV1,
): AgentTool {
  const tool: AgentTool = {
    name: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    description:
      "Purpose: Push verified branch and create draft PR (or Bound merge when mission asks). Use when: after code_commit_verified + private repo. Do not use when: before commit; do not invent git_push. Required: action publish_draft|merge + bindings. Next: note reflection. Side effects: bound/hard for merge. Publish the latest host-verified local commit for a trusted repository profile to its agent-owned GitHub branch and draft pull request, or refresh proof and request a separate double-exact merge. The model supplies only a logical profile key and optional PR prose; when title or body is omitted for publish_draft, the host emits a bounded verified-publication summary. Local paths, SHAs, credentials, repository destinations, checks, and merge policy are host-resolved.",
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
          description: "Optional draft pull request title for publish_draft. When omitted, the host derives a bounded title from the trusted verified handoff.",
        },
        body: {
          type: "string",
          description: "Optional draft pull request body for publish_draft. When omitted, the host emits a bounded summary of the verified handoff. A supplied value must be nonblank safe prose.",
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
    // Soft draft_pr proof must not treat push_prepared / branch-only
    // checkpoints as success. Returning those as ok previously caused the
    // model to loop, then ExternalActionReceiptLedger collisions on retry.
    const requiresDraftPr =
      (checkpoint.completionProof ?? "draft_pr") === "draft_pr";
    const draftPrUrl =
      typeof checkpoint.pullRequest?.htmlUrl === "string"
        ? checkpoint.pullRequest.htmlUrl.trim()
        : "";
    if (requiresDraftPr && !/^https:\/\/github\.com\//iu.test(draftPrUrl)) {
      throw new ToolExecutionError(
        "github_publication_draft_pr_missing",
        checkpoint.blocker?.message ??
          "publish_verified_code_to_github did not produce a draft pull request URL. Retry after fixing Git push credentials (create-capable REST token is not enough when Contents write is missing on the new repo).",
        { mutationState: "may_have_applied" },
      );
    }
    if (!isGitHubPublicationActionComplete(args.action, checkpoint)) {
      throw new ToolExecutionError(
        "github_publication_finalization_pending",
        checkpoint.blocker?.message ??
          `GitHub publication reached ${checkpoint.status}, but the requested ${String(args.action)} proof is not durably complete. Retry the same publication to resume from its checkpoint.`,
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
  return value
    .split(/(?:[!?;\r\n]+|\.(?=\s|$)|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some(hasAffirmativeGitHubPublicationClause);
}

function hasAffirmativeGitHubPublicationClause(clause: string): boolean {
  const target =
    /\b(?:github|pull request|draft pr|branch)\b/giu;
  const targetIndexes = [...clause.matchAll(target)].map(
    (match) => match.index ?? -1,
  );
  if (targetIndexes.length === 0) return false;

  const actions =
    /\b(?:push|publish|send|open|create|update|merge)\b/giu;
  for (const match of clause.matchAll(actions)) {
    const actionIndex = match.index ?? -1;
    if (
      actionIndex < 0 ||
      !targetIndexes.some((targetIndex) =>
        Math.abs(targetIndex - actionIndex) <= 100
      )
    ) {
      continue;
    }
    if (!isActionNegatedAt(clause, actionIndex)) {
      return true;
    }
  }
  return false;
}

function isActionNegatedAt(clause: string, actionIndex: number): boolean {
  const prefix = clause.slice(Math.max(0, actionIndex - 120), actionIndex);
  const boundaryIndex = Math.max(
    prefix.lastIndexOf(","),
    prefix.lastIndexOf(":"),
  );
  const localPrefix = prefix.slice(boundaryIndex + 1);
  return (
    /\b(?:do\s+not|don't|never|skip|exclude)\b[\s\S]{0,100}$/iu.test(
      localPrefix,
    ) ||
    /\bwithout\b[\s\S]{0,60}$/iu.test(localPrefix) ||
    /\bno\s+need\s+to\b[\s\S]{0,60}$/iu.test(localPrefix)
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
  const binding = await options.resolveBinding({ profileKey, handoff, context });
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
    const { title, body } = resolveDraftPublicationDocument(args, handoff);
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
    const hasVerifiedDraftPr = Boolean(
      typeof existing?.pullRequest?.htmlUrl === "string" &&
        /^https:\/\/github\.com\//iu.test(existing.pullRequest.htmlUrl),
    );
    const retryAfterVerifiedPush =
      existing &&
      !hasVerifiedDraftPr &&
      (
        (existing.status === "blocked" &&
          existing.blocker?.code === "github_draft_pr_not_applied") ||
        ((existing.status === "push_prepared" ||
          existing.status === "pushed_verified") &&
          existing.blocker === null &&
          existing.pendingAction === null &&
          existing.remoteSha === existing.headSha &&
          existing.receiptIds.length > 0)
      );
    if (retryAfterVerifiedPush && existing) {
      return workflow.retryDraftPublicationAfterNotApplied(existing, {
        title,
        body,
        binding: binding.workflowBinding,
        handoff: adaptHandoff(handoff),
        signal: context.abortSignal,
      });
    }
    if (existing?.status === "pushed_verified") {
      return workflow.resumeDraftPublication(existing, {
        title,
        body,
        binding: binding.workflowBinding,
        handoff: adaptHandoff(handoff),
        signal: context.abortSignal,
      });
    }
    // A prior auth-failed push has no verified remote or receipt, so it may
    // restart the full publication flow. In contrast, any durable push proof
    // is routed above through a fresh PR-only approval and retains its receipt
    // lineage.
    const incompleteInitialPush =
      existing &&
      !hasVerifiedDraftPr &&
      existing.status === "push_prepared" &&
      existing.remoteSha === null &&
      existing.receiptIds.length === 0 &&
      existing.pendingAction === null;
    if (incompleteInitialPush) {
      return workflow.publishDraft({
        explicitUserMission: true,
        publicationId,
        title,
        body,
        handoff: adaptHandoff(handoff),
        binding: binding.workflowBinding,
        completionProof: binding.completionProof ?? "draft_pr",
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
      // Soft-auto / set-loose draft publication must stop at draft PR proof.
      // Defaulting to merged_pr left Soft runs waiting for merge and often
      // returned checkpoints without a pullRequest URL for delivery proofs.
      completionProof: binding.completionProof ?? "draft_pr",
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

function isGitHubPublicationActionComplete(
  action: unknown,
  checkpoint: GitHubPublicationCheckpointV1,
): boolean {
  if (checkpoint.blocker !== null || checkpoint.pendingAction !== null) {
    return false;
  }
  if (action === "publish_draft") {
    return (
      checkpoint.status === "finalized" ||
      (
        checkpoint.status === "draft_pr_verified" &&
        checkpoint.completionProof === "draft_pr"
      ) ||
      (
        checkpoint.status === "review_or_merge_ready" &&
        checkpoint.completionProof === "merged_pr"
      )
    );
  }
  return (
    action === "merge" &&
    checkpoint.status === "finalized" &&
    checkpoint.completionProof === "merged_pr" &&
    typeof checkpoint.mergeSha === "string" &&
    /^[a-f0-9]{40}$/iu.test(checkpoint.mergeSha) &&
    checkpoint.pullRequest?.merged === true
  );
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
  const verifiedRevision = merged ? checkpoint.mergeSha : checkpoint.headSha;
  if (!verifiedRevision) {
    throw notApplied(
      "github_publication_revision_missing",
      "GitHub publication completed without an independently verified revision.",
    );
  }
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
      revision: verifiedRevision,
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
      observedRevision: verifiedRevision,
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

/**
 * A draft PR is an externally visible proof artifact, not an invitation for
 * the model to invent repository authority.  It is nevertheless useful when
 * a model focuses on the durable publication action and omits prose entirely.
 * In that narrow case derive a factual, bounded document from the already
 * verified handoff.  Explicit prose remains subject to the same strict
 * validation: an empty string is not silently replaced.
 */
function resolveDraftPublicationDocument(
  args: Record<string, unknown>,
  handoff: VerifiedCodePublicationHandoffV1,
): { title: string; body: string } {
  const title =
    args.title === undefined
      ? `Verified change for ${handoff.repositoryProfileKey}`
      : boundedText(args.title, "pull request title", 1, 256);
  const body =
    args.body === undefined
      ? [
        "## Verified publication",
        "",
        "This draft was generated by the host from an already verified local commit.",
        "",
        `- Repository profile: \`${handoff.repositoryProfileKey}\``,
        `- Workspace: \`${handoff.workspaceId}\``,
        `- Branch: \`${handoff.branch}\``,
        `- Commit: \`${handoff.commitSha}\``,
        "- Validation: targeted and full checks were verified before publication.",
      ].join("\n")
      : boundedText(args.body, "pull request body", 1, 65_536, true);
  return { title, body };
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
