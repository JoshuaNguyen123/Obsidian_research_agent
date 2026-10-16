import type { PreparedAction, ToolDescriptor } from "./actions";
import { descriptorForPreparedActionV1 } from "./preparedActionDescriptorV1";

/**
 * Which prepared code actions an unattended Linear queue run may take under
 * its persisted grant (moved from main.ts unchanged, so it can be tested).
 * The run asks nothing: a prepared action outside this list is refused, never
 * put to a person. Only the run's own workspace and trusted profile, one
 * confirmation, no warning, no protected-control change and nothing
 * destructive qualify, and then only the listed tool and action.
 *
 * The descriptor is judged by the prepared action's kind (CODE-7 4b), so a
 * tool whose call can delete a file is destructive here when it does.
 * `code_workspace_apply_patch` is not listed: an unattended run's patch is
 * refused whatever its kind, until the owner decides otherwise.
 */
export function isQueuedCodePreparedActionAllowedV1(input: {
  action: PreparedAction;
  descriptor: ToolDescriptor;
  runId: string;
  workspaceId: string;
  profileKey: string;
}): boolean {
  const { action } = input;
  const descriptor = descriptorForPreparedActionV1(input.descriptor, action);
  if (
    action.runId !== input.runId ||
    action.target.workspaceId !== input.workspaceId ||
    action.target.repositoryProfileId !== input.profileKey ||
    action.requiredConfirmations !== 1 ||
    action.preview.warnings.length > 0 ||
    action.normalizedArgs.requiresProfileRedetection === true ||
    descriptor.effect === "destructive_mutation" ||
    descriptor.capability.system !== action.target.system ||
    descriptor.capability.resourceType !== action.target.resourceType
  ) {
    return false;
  }
  const expected = QUEUED_CODE_PREPARED_ACTIONS_V1.get(action.toolName);
  return Boolean(
    expected &&
      descriptor.name === action.toolName &&
      expected.system === descriptor.capability.system &&
      expected.resourceType === descriptor.capability.resourceType &&
      expected.actions.has(descriptor.capability.action),
  );
}

const QUEUED_CODE_PREPARED_ACTIONS_V1: ReadonlyMap<string, {
  system: "workspace" | "git";
  resourceType: string;
  actions: ReadonlySet<string>;
}> = new Map([
  ["code_workspace_create", { system: "workspace", resourceType: "code_workspace", actions: new Set(["create"]) }],
  ["code_workspace_mkdir", { system: "workspace", resourceType: "code_workspace", actions: new Set(["create"]) }],
  ["code_workspace_create_file", { system: "workspace", resourceType: "code_workspace", actions: new Set(["create"]) }],
  ["code_workspace_append", { system: "workspace", resourceType: "code_workspace", actions: new Set(["append"]) }],
  ["code_workspace_write_expected", { system: "workspace", resourceType: "code_workspace", actions: new Set(["update"]) }],
  ["write_workspace_file", { system: "workspace", resourceType: "code_workspace", actions: new Set(["update", "create"]) }],
  ["code_workspace_patch", { system: "workspace", resourceType: "code_workspace", actions: new Set(["update"]) }],
  ["replace_workspace_text", { system: "workspace", resourceType: "code_workspace", actions: new Set(["update"]) }],
  ["code_workspace_move", { system: "workspace", resourceType: "code_workspace", actions: new Set(["move"]) }],
  ["code_workspace_copy", { system: "workspace", resourceType: "code_workspace", actions: new Set(["create"]) }],
  ["code_validate_fast", { system: "workspace", resourceType: "validation_run", actions: new Set(["validate"]) }],
  ["code_validate_targeted", { system: "workspace", resourceType: "validation_run", actions: new Set(["validate"]) }],
  ["code_validate_full", { system: "workspace", resourceType: "validation_run", actions: new Set(["validate"]) }],
  ["code_repair_record_cycle", { system: "workspace", resourceType: "code_repair_checkpoint", actions: new Set(["update"]) }],
  ["code_commit_verified", { system: "git", resourceType: "verified_local_commit", actions: new Set(["commit"]) }],
]);
