import type {
  ExtensionToolContributionV1,
  PreparedActionResultV1,
  ToolDescriptorV1,
} from "@agentic-researcher/core-api";
import type { PreparedBackgroundGitHubToolNameV1 } from "@agentic-researcher/core-api";

import type {
  PrepareBackgroundGitHubApprovalInputV1,
  PrepareBackgroundGitHubApprovalResultV1,
} from "./PreparedBackgroundGitHubHostV1";

export const PREPARED_BACKGROUND_GITHUB_TOOL_NAMES_V1 = Object.freeze([
  "github_publish_verified_branch",
  "github_create_draft_pull_request",
  "github_update_owned_branch",
  "github_merge_pull_request",
  "github_enable_auto_merge",
] as const satisfies readonly PreparedBackgroundGitHubToolNameV1[]);

export interface PreparedBackgroundGitHubApprovalPreparerV1 {
  prepareApproval(
    input: PrepareBackgroundGitHubApprovalInputV1,
  ): Promise<PrepareBackgroundGitHubApprovalResultV1>;
}

/**
 * Registers only host-prepared, headless GitHub effects. The model receives a
 * logical profile/publication identity and, for draft PR creation, bounded
 * prose. Repository coordinates, SHAs, paths, checks, credentials, and merge
 * policy are resolved from integrations-owned durable state.
 */
export function createPreparedBackgroundGitHubToolContributionsV1(
  host: PreparedBackgroundGitHubApprovalPreparerV1,
): ExtensionToolContributionV1[] {
  return PREPARED_BACKGROUND_GITHUB_TOOL_NAMES_V1.map((toolName) => ({
    descriptor: {
      version: 1,
      kind: "tool",
      id: `agentic-researcher-integrations:${toolName}`,
      displayName: displayName(toolName),
      description:
        "Registers one exact host-prepared GitHub continuation without a foreground provider fallback.",
    },
    tool: {
      name: toolName,
      description: description(toolName),
      parameters: parameters(toolName),
      descriptor: createPreparedBackgroundGitHubToolDescriptorV1(toolName),
      async execute() {
        return foregroundUnavailable(toolName);
      },
      async prepare(args, context): Promise<PreparedActionResultV1> {
        if (!context.missionId || !context.operationId) {
          return {
            ok: false,
            error: {
              code: "background_github_mission_identity_required",
              message:
                "Prepared background GitHub approval requires core-supplied mission and tool-call identities.",
            },
          };
        }
        const result = await host.prepareApproval({
          toolName,
          args,
          runId: context.missionId,
          toolCallId: context.operationId,
        });
        return result.status === "ready"
          ? { ok: true, action: result.preparedAction }
          : {
              ok: false,
              error: { code: result.code, message: result.message },
            };
      },
      async executePrepared() {
        throw new Error(
          `${toolName} has no foreground executePrepared provider fallback.`,
        );
      },
      async reconcile() {
        return {
          outcome: "still_uncertain" as const,
          message:
            "Prepared GitHub effects reconcile only from the authenticated companion receipt WAL and exact package readback.",
        };
      },
    },
  }));
}

export function createPreparedBackgroundGitHubToolDescriptorV1(
  toolName: PreparedBackgroundGitHubToolNameV1,
): ToolDescriptorV1 {
  if (!PREPARED_BACKGROUND_GITHUB_TOOL_NAMES_V1.includes(toolName)) {
    throw new Error("Prepared background GitHub tool is outside the fixed catalog.");
  }
  const merge =
    toolName === "github_merge_pull_request" ||
    toolName === "github_enable_auto_merge";
  const action =
    toolName === "github_publish_verified_branch"
      ? "publish"
      : toolName === "github_create_draft_pull_request"
        ? "create"
        : toolName === "github_update_owned_branch"
          ? "update"
          : "merge";
  return Object.freeze({
    version: 1,
    name: toolName,
    capability: {
      system: "github",
      resourceType: "trusted_repository_publication",
      action,
    },
    effect: "publish",
    risk: "critical",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: merge ? "double_exact" : "exact",
    },
    execution: {
      preparation: "required",
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
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    receiptKind: "external_action",
    operationGoals: [
      "dispatch one exact host-prepared GitHub effect",
      "verify provider state by independent readback",
      "resume from the package and receipt WAL without replay",
    ],
  } satisfies ToolDescriptorV1);
}

function parameters(toolName: PreparedBackgroundGitHubToolNameV1) {
  const properties = {
    profileKey: {
      type: "string",
      description: "Trusted logical RepositoryProfileV2 key only.",
    },
    publicationId: {
      type: "string",
      description: "Durable logical GitHub publication identity only.",
    },
    ...(toolName === "github_create_draft_pull_request"
      ? {
          title: {
            type: "string",
            description: "Bounded draft pull-request title.",
          },
          body: {
            type: "string",
            description: "Bounded draft pull-request body.",
          },
        }
      : {}),
  };
  return {
    type: "object",
    additionalProperties: false,
    required:
      toolName === "github_create_draft_pull_request"
        ? ["profileKey", "publicationId", "title", "body"]
        : ["profileKey", "publicationId"],
    properties,
  };
}

function displayName(toolName: PreparedBackgroundGitHubToolNameV1): string {
  return ({
    github_publish_verified_branch: "Prepared verified branch push",
    github_create_draft_pull_request: "Prepared draft pull request",
    github_update_owned_branch: "Prepared review-repair fast-forward",
    github_merge_pull_request: "Prepared pull-request merge",
    github_enable_auto_merge: "Prepared pull-request auto-merge",
  } satisfies Record<PreparedBackgroundGitHubToolNameV1, string>)[toolName];
}

function description(toolName: PreparedBackgroundGitHubToolNameV1): string {
  return ({
    github_publish_verified_branch:
      "Prepare approval to push one host-verified local commit to its trusted agent-owned branch. Provide only profileKey and publicationId.",
    github_create_draft_pull_request:
      "Prepare approval to create one draft PR after verified branch readback. Provide only profileKey, publicationId, title, and body.",
    github_update_owned_branch:
      "Prepare approval to fast-forward one trusted review-repair branch from a newly verified local commit. Provide only profileKey and publicationId.",
    github_merge_pull_request:
      "Prepare a fresh double-exact merge approval from host-read PR, check, review, binding, and merge-policy proof. Provide only profileKey and publicationId.",
    github_enable_auto_merge:
      "Prepare a fresh double-exact auto-merge approval from host-read PR, check, review, binding, and merge-policy proof. Provide only profileKey and publicationId.",
  } satisfies Record<PreparedBackgroundGitHubToolNameV1, string>)[toolName];
}

function foregroundUnavailable(toolName: PreparedBackgroundGitHubToolNameV1) {
  return {
    status: "blocked",
    code: "prepared_background_github_headless_only",
    message:
      `${toolName} is headless-only and requires an exact integrations-owned package; no foreground provider fallback exists.`,
    executionHost: "headless_runtime",
    foregroundFallback: false,
  };
}
