import path from "node:path";
import { RESEARCH_WORKER_ALLOWED_TOOLS } from "./researchWorker";
import type { SpecialistMode } from "./types";

export interface SpecialistWorkspaceLeaseV2 {
  schemaVersion: 2;
  leaseId: string;
  missionGraphId: string;
  rootPath: string;
  expiresAt: string;
}

export interface SpecialistAuthorityV2 {
  participantId: "specialist";
  mode: SpecialistMode;
  mayMutateVault: false;
  mayMutateExternalSystems: false;
  mayPublishCode: false;
  allowedToolNames: ReadonlySet<string>;
  workspaceLease?: SpecialistWorkspaceLeaseV2;
}

export type SpecialistToolEffectV2 = "read" | "workspace_write" | "external_write";

export interface SpecialistToolAuthorityDecisionV2 {
  allowed: boolean;
  reason:
    | "allowed"
    | "tool_not_allowed"
    | "external_mutation_lead_only"
    | "workspace_lease_required"
    | "workspace_lease_expired"
    | "workspace_path_required"
    | "workspace_path_escape";
  resolvedWorkspacePath?: string;
}

const CODE_BUILDER_TOOLS = new Set([
  "code_list_files",
  "code_read_file",
  "code_write_file",
  "code_write_notebook",
  "code_replace_text",
]);
const CODE_REVIEWER_TOOLS = new Set(["code_list_files", "code_read_file"]);
const LINEAR_PLANNER_READ = /^(?:linear_(?:get|list|search)_|read_current_file$|read_file$|list_markdown_files$|count_words$)/u;

/**
 * Build the complete authority envelope for the one Specialist mode. Neither a
 * mode switch nor a workspace lease can grant vault/external mutation.
 */
export function createSpecialistAuthorityV2(input: {
  mode: SpecialistMode;
  workspaceLease?: SpecialistWorkspaceLeaseV2;
}): SpecialistAuthorityV2 {
  const allowedToolNames =
    input.mode === "researcher"
      ? new Set(RESEARCH_WORKER_ALLOWED_TOOLS)
      : input.mode === "code_builder"
        ? new Set(CODE_BUILDER_TOOLS)
        : input.mode === "code_reviewer"
          ? new Set(CODE_REVIEWER_TOOLS)
          : new Set<string>();
  return {
    participantId: "specialist",
    mode: input.mode,
    mayMutateVault: false,
    mayMutateExternalSystems: false,
    mayPublishCode: false,
    allowedToolNames,
    ...(input.workspaceLease ? { workspaceLease: cloneLease(input.workspaceLease) } : {}),
  };
}

export function decideSpecialistToolAuthorityV2(input: {
  authority: SpecialistAuthorityV2;
  toolName: string;
  effect: SpecialistToolEffectV2;
  workspacePath?: string;
  now?: Date;
}): SpecialistToolAuthorityDecisionV2 {
  if (input.effect === "external_write") {
    return { allowed: false, reason: "external_mutation_lead_only" };
  }
  const toolName = input.toolName.trim();
  const modeAllowsTool =
    input.authority.mode === "linear_planner"
      ? input.effect === "read" && LINEAR_PLANNER_READ.test(toolName)
      : input.authority.allowedToolNames.has(toolName);
  if (!modeAllowsTool) {
    return { allowed: false, reason: "tool_not_allowed" };
  }
  if (input.authority.mode !== "code_builder" && input.effect === "workspace_write") {
    return { allowed: false, reason: "tool_not_allowed" };
  }
  if (
    input.authority.mode !== "code_builder" &&
    input.authority.mode !== "code_reviewer"
  ) {
    return { allowed: true, reason: "allowed" };
  }
  const lease = input.authority.workspaceLease;
  if (!lease) return { allowed: false, reason: "workspace_lease_required" };
  if (Date.parse(lease.expiresAt) <= (input.now ?? new Date()).getTime()) {
    return { allowed: false, reason: "workspace_lease_expired" };
  }
  if (!input.workspacePath?.trim()) {
    return { allowed: false, reason: "workspace_path_required" };
  }
  const resolvedWorkspacePath = resolveLeasedWorkspacePath(
    lease.rootPath,
    input.workspacePath,
  );
  if (!resolvedWorkspacePath) {
    return { allowed: false, reason: "workspace_path_escape" };
  }
  return { allowed: true, reason: "allowed", resolvedWorkspacePath };
}

/** Lexical boundary preflight; the code executor still performs realpath checks. */
export function resolveLeasedWorkspacePath(
  rootPath: string,
  requestedPath: string,
): string | null {
  const root = path.resolve(rootPath.trim());
  const requested = requestedPath.trim();
  if (!root || !requested || path.isAbsolute(requested)) return null;
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  return null;
}

function cloneLease(lease: SpecialistWorkspaceLeaseV2): SpecialistWorkspaceLeaseV2 {
  const expiresAtMs = Date.parse(lease.expiresAt);
  if (
    lease.schemaVersion !== 2 ||
    !lease.leaseId.trim() ||
    !lease.missionGraphId.trim() ||
    !lease.rootPath.trim() ||
    !Number.isFinite(expiresAtMs)
  ) {
    throw new Error("Specialist workspace lease is invalid.");
  }
  return { ...lease, expiresAt: new Date(expiresAtMs).toISOString() };
}
