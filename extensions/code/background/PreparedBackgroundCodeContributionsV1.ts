import type {
  ExtensionToolContributionV1,
  ToolDescriptorV1,
} from "@agentic-researcher/core-api";
import type {
  PrepareBackgroundValidationCommitApprovalInputV1,
  PrepareBackgroundValidationCommitApprovalResultV1,
} from "./PreparedBackgroundCodeHostV1";

export const PREPARED_BACKGROUND_CODE_TOOL_NAME_V1 =
  "code_validate_commit_prepared" as const;

/**
 * Capability-only foreground registration for the installed headless Code
 * executor. The normal tool-call path can never execute, prepare, or replay a
 * commit: the foreground Code host must first persist the exact local package
 * and the companion dispatches that closed identity separately.
 */
export interface PreparedBackgroundCodeApprovalPreparerV1 {
  prepareBackgroundValidationCommitApproval(
    input: PrepareBackgroundValidationCommitApprovalInputV1,
  ): Promise<PrepareBackgroundValidationCommitApprovalResultV1>;
}

export function createPreparedBackgroundCodeToolContributionV1(
  host?: PreparedBackgroundCodeApprovalPreparerV1,
): ExtensionToolContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "tool",
      id: `agentic-researcher-code:${PREPARED_BACKGROUND_CODE_TOOL_NAME_V1}`,
      displayName: "Prepared background Code validation and commit",
      description:
        "Registers one host-prepared headless validation/readback/commit capability without a foreground execution fallback.",
    },
    tool: {
      name: PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
      description:
        "Prepare approval for one exact durable Code repair checkpoint. The host reconstructs every path, command, profile, sandbox action, and fingerprint from trusted local state; the model may provide only repairCheckpointId.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["repairCheckpointId"],
        properties: {
          repairCheckpointId: {
            type: "string",
            description: "Durable Code repair checkpoint identity only.",
          },
        },
      },
      descriptor: PREPARED_BACKGROUND_CODE_TOOL_DESCRIPTOR_V1,
      async execute() {
        return foregroundUnavailable();
      },
      async prepare(args, context) {
        if (!host) return preparationUnavailable();
        const plainArgs = Boolean(
          args &&
          typeof args === "object" &&
          !Array.isArray(args) &&
          (Object.getPrototypeOf(args) === Object.prototype ||
            Object.getPrototypeOf(args) === null),
        );
        if (
          !plainArgs ||
          Object.keys(args).length !== 1 ||
          typeof args.repairCheckpointId !== "string" ||
          !args.repairCheckpointId.trim()
        ) {
          return {
            ok: false,
            error: {
              code: "background_code_checkpoint_identity_invalid",
              message:
                "code_validate_commit_prepared accepts exactly one non-empty repairCheckpointId and no other model arguments.",
            },
          };
        }
        if (!context.missionId || !context.operationId) {
          return {
            ok: false,
            error: {
              code: "background_code_mission_identity_required",
              message:
                "Background Code approval requires the scoped mission and tool-call identities supplied by core.",
            },
          };
        }
        const result = await host.prepareBackgroundValidationCommitApproval({
          repairCheckpointId: args.repairCheckpointId,
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
          "code_validate_commit_prepared has no foreground executePrepared fallback.",
        );
      },
      async reconcile() {
        return {
          outcome: "still_uncertain",
          message:
            "Prepared background Code work reconciles only through the authenticated companion receipt journal and exact local package readback.",
        };
      },
    },
  };
}

function preparationUnavailable() {
  return {
    ok: false as const,
    error: {
      code: "prepared_background_code_host_package_required",
      message:
        "This capability can be prepared only by the built-in Code host after durable checkpoint readback.",
    },
  };
}

export const PREPARED_BACKGROUND_CODE_TOOL_DESCRIPTOR_V1: ToolDescriptorV1 =
  Object.freeze({
    version: 1,
    name: PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
    capability: {
      system: "git",
      resourceType: "prepared_validation_commit",
      action: "commit",
    },
    effect: "execution",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
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
    receiptKind: "code_change",
    operationGoals: [
      "validate one immutable staged diff in a fresh verified sandbox",
      "read back exact artifacts and create one verified local commit",
      "resume through durable companion receipts without replay",
    ],
  } satisfies ToolDescriptorV1);

function foregroundUnavailable() {
  return {
    status: "blocked",
    code: "prepared_background_code_headless_only",
    message:
      "Prepared background Code execution is headless-only and requires an exact host-persisted package; no foreground or native execution fallback exists.",
    executionHost: "headless_runtime",
    foregroundFallback: false,
  };
}
