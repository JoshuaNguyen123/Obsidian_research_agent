import { verifyPreparedActionFingerprint, type ToolDescriptor } from "./actions";
import type {
  NestedToolApprovalRequest,
  ToolRegistry,
} from "../tools/types";
import { PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME } from "../tools/githubPublicationTool";

export const FINALIZE_GITHUB_LINKS_IN_OBSIDIAN_TOOL_NAME =
  "finalize_github_links_in_obsidian";

export interface NestedApprovalBindingV1 {
  runId: string;
  toolName: string;
  descriptor: ToolDescriptor;
}

interface NestedSubactionRuleV1 {
  descriptor?: ToolDescriptor;
  system: ToolDescriptor["capability"]["system"];
  resourceType: string;
  action: ToolDescriptor["capability"]["action"];
}

const OBSIDIAN_GITHUB_BACKLINK_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: FINALIZE_GITHUB_LINKS_IN_OBSIDIAN_TOOL_NAME,
  capability: {
    system: "vault",
    resourceType: "markdown_file",
    action: "append",
  },
  effect: "reversible_mutation",
  risk: "high",
  approval: {
    allowPromptGrant: false,
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
  allowedPrincipals: ["host", "single_agent"],
  receiptKind: "vault_write",
  operationGoals: ["vault_write_receipt"],
};

/**
 * Cross-tool approval is intentionally a closed host contract. An outer
 * workflow cannot turn its approval callback into an arbitrary capability;
 * only these finalizer effects may present their own exact prepared action.
 */
const NESTED_SUBACTION_RULES: Readonly<
  Record<string, Readonly<Record<string, NestedSubactionRuleV1>>>
> = {
  [PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME]: {
    linear_create_comment: {
      system: "linear",
      resourceType: "comment",
      action: "create",
    },
    linear_update_issue: {
      system: "linear",
      resourceType: "issue",
      action: "update",
    },
    [FINALIZE_GITHUB_LINKS_IN_OBSIDIAN_TOOL_NAME]: {
      descriptor: OBSIDIAN_GITHUB_BACKLINK_DESCRIPTOR,
      system: "vault",
      resourceType: "markdown_file",
      action: "append",
    },
  },
};

export async function resolveNestedApprovalBindingV1(input: {
  outerToolName: string;
  request: NestedToolApprovalRequest;
  toolRegistry: Pick<ToolRegistry, "getDescriptor">;
}): Promise<NestedApprovalBindingV1> {
  const action = input.request.preparedAction;
  if (!action) {
    throw new Error("Nested approval requires an exact prepared action.");
  }
  if (input.request.toolName !== action.toolName) {
    throw new Error(
      "Nested approval tool identity does not match its prepared action.",
    );
  }
  if (!(await verifyPreparedActionFingerprint(action))) {
    throw new Error("Nested approval prepared-action fingerprint is invalid.");
  }
  if (
    action.requiredConfirmations !== undefined &&
    action.requiredConfirmations !== (input.request.requiredConfirmations ?? 1)
  ) {
    throw new Error(
      "Nested approval confirmation count does not match its prepared action.",
    );
  }

  const crossTool = input.request.toolName !== input.outerToolName;
  const rule = crossTool
    ? NESTED_SUBACTION_RULES[input.outerToolName]?.[input.request.toolName]
    : undefined;
  if (crossTool && !rule) {
    throw new Error(
      "Nested approval subaction is outside the outer tool's closed capability contract.",
    );
  }
  const descriptor = rule?.descriptor ??
    input.toolRegistry.getDescriptor?.(input.request.toolName) ?? null;
  if (!descriptor) {
    throw new Error("Nested approval tool descriptor is unavailable.");
  }
  if (
    descriptor.version !== 1 ||
    descriptor.name !== action.toolName ||
    descriptor.capability.system !== action.target.system ||
    (rule !== undefined &&
      (descriptor.capability.resourceType !== action.target.resourceType ||
        descriptor.capability.system !== rule.system ||
        descriptor.capability.resourceType !== rule.resourceType ||
        descriptor.capability.action !== rule.action))
  ) {
    throw new Error(
      "Nested approval descriptor does not match the exact prepared capability.",
    );
  }

  return {
    runId: action.runId,
    toolName: action.toolName,
    descriptor,
  };
}
