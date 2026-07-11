import type {
  ModelRouterMode,
  RoutedMissionIntent,
} from "./missionRouter";
import {
  ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD,
  resolveRoutedMissionIntent,
  type ResolvedRouterIntent,
} from "./missionRouter";
import type { ResearchPhaseDescriptor } from "./researchPhaseController";
import type { MissionIntent } from "../tools/types";
import { MAX_CODE_RUNS_PER_MISSION } from "../tools/constants";
import type {
  PreparedAction,
  ToolDescriptor,
  ToolPrincipal,
} from "./actions";
import type { AuthorityGrantV1 } from "./authority";

export type PolicyAction = "allow" | "require_approval" | "block";

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  tags: string[];
  grantId?: string;
  payloadFingerprint?: string;
  requiredConfirmations?: 1 | 2;
}

export interface ToolPolicyContext {
  toolName: string;
  args: Record<string, unknown>;
  intent: RoutedMissionIntent;
  approvalGranted: boolean;
  isDesktop: boolean;
  writeAutonomy: boolean;
  codeRunCount?: number;
  /** Override MAX_CODE_RUNS_PER_MISSION when settings provide maxCodeRunsPerMission. */
  maxCodeRunsPerMission?: number;
  /** When set, research-bearing gather/analyze phases block vault mutations. */
  researchPhase?: ResearchPhaseDescriptor | null;
  /** Presence opts into the descriptor-aware fail-closed policy path. */
  descriptor?: ToolDescriptor | null;
  preparedAction?: PreparedAction | null;
  principal?: ToolPrincipal;
  /** True only after the integration boundary validates the target selector. */
  scopeAllowed?: boolean;
  /** A grant already verified against this action by the authority evaluator. */
  matchingGrant?: AuthorityGrantV1 | null;
  now?: Date;
}

export interface ActionPolicyContext {
  toolName: string;
  descriptor: ToolDescriptor | null | undefined;
  preparedAction?: PreparedAction | null;
  principal?: ToolPrincipal;
  scopeAllowed?: boolean;
  matchingGrant?: AuthorityGrantV1 | null;
  isDesktop: boolean;
  writeAutonomy?: boolean;
  researchPhase?: ResearchPhaseDescriptor | null;
  now?: Date;
}

const MUTATING_TOOL_PATTERN =
  /^(append|replace|edit|delete|move|rename|retitle|highlight|restore|create|fill|link_|install_|export_workspace)/;
const CODE_TOOLS = new Set([
  "run_code_block",
  "write_workspace_file",
  "export_workspace_artifact",
  "install_code_dependency",
]);
/** Setup mutations allowed before gather/analyze unlocks content writeback. */
const RESEARCH_SETUP_MUTATION_TOOLS = new Set([
  "rename_current_file",
  "retitle_current_file",
]);

export function evaluateToolPolicy(ctx: ToolPolicyContext): PolicyDecision {
  if (Object.prototype.hasOwnProperty.call(ctx, "descriptor")) {
    return evaluateActionPolicy({
      toolName: ctx.toolName,
      descriptor: ctx.descriptor,
      preparedAction: ctx.preparedAction,
      principal: ctx.principal,
      scopeAllowed: ctx.scopeAllowed,
      matchingGrant: ctx.matchingGrant,
      isDesktop: ctx.isDesktop,
      writeAutonomy: ctx.writeAutonomy,
      researchPhase: ctx.researchPhase,
      now: ctx.now,
    });
  }

  if (CODE_TOOLS.has(ctx.toolName) && !ctx.isDesktop) {
    return block("Code tools are desktop-only.", ["desktop_required"]);
  }

  if (ctx.toolName === "install_code_dependency") {
    return ctx.approvalGranted
      ? allow("Package install approved by user.", ["dependency_install"])
      : requireApproval("Package installation requires explicit approval.", [
          "dependency_install",
        ]);
  }

  if (ctx.toolName === "run_code_block") {
    const maxRuns =
      typeof ctx.maxCodeRunsPerMission === "number" &&
      Number.isFinite(ctx.maxCodeRunsPerMission) &&
      ctx.maxCodeRunsPerMission > 0
        ? Math.floor(ctx.maxCodeRunsPerMission)
        : MAX_CODE_RUNS_PER_MISSION;
    if ((ctx.codeRunCount ?? 0) >= maxRuns) {
      return block(
        `Code run limit of ${maxRuns} executions per mission reached.`,
        ["code_run_budget"],
      );
    }
    const timeoutMs =
      typeof ctx.args.timeoutMs === "number" && Number.isFinite(ctx.args.timeoutMs)
        ? ctx.args.timeoutMs
        : 0;
    if (timeoutMs > 30_000) {
      return ctx.approvalGranted
        ? allow("Long code run approved by user.", ["long_code_timeout"])
        : requireApproval("Code execution over 30 seconds requires approval.", [
            "long_code_timeout",
          ]);
    }
  }

  if (isMutatingTool(ctx.toolName)) {
    if (
      ctx.researchPhase?.researchBearing &&
      !ctx.researchPhase.writeToolsAllowed &&
      ctx.toolName !== "append_research_memory" &&
      !RESEARCH_SETUP_MUTATION_TOOLS.has(ctx.toolName)
    ) {
      return block(
        `Write tools are blocked during research ${ctx.researchPhase.phase} phase.`,
        ["research_phase_gate", ctx.researchPhase.phase],
      );
    }

    if (
      ctx.intent.writeScope === "none" &&
      !ctx.writeAutonomy &&
      ctx.toolName !== "append_research_memory"
    ) {
      return block("Mutation tool is not allowed for this routed intent.", [
        "mutation_scope",
      ]);
    }
  }

  return allow("Tool allowed by policy.", ["default_allow"]);
}

/**
 * Descriptor-aware policy for prepared actions. Unlike the legacy path, every
 * missing security input is a block and there is no default allow fallback.
 */
export function evaluateActionPolicy(ctx: ActionPolicyContext): PolicyDecision {
  const descriptor = ctx.descriptor;
  if (!descriptor) {
    return block("Tool action descriptor is required.", [
      "descriptor_required",
      "fail_closed",
    ]);
  }
  if (descriptor.version !== 1 || descriptor.name !== ctx.toolName) {
    return block("Tool action descriptor does not match the requested tool.", [
      "descriptor_mismatch",
      "fail_closed",
    ]);
  }
  if (!ctx.principal || !descriptor.allowedPrincipals.includes(ctx.principal)) {
    return block("Principal is not authorized to invoke this tool.", [
      "principal_scope",
      "fail_closed",
    ]);
  }
  if (descriptor.execution.desktopOnly && !ctx.isDesktop) {
    return block("This action is desktop-only.", ["desktop_required"]);
  }
  if (ctx.scopeAllowed !== true) {
    return block("Action target is outside the resolved mission scope.", [
      "resource_scope",
      "fail_closed",
    ]);
  }
  if (
    descriptor.effect !== "read" &&
    ctx.researchPhase?.researchBearing &&
    !ctx.researchPhase.writeToolsAllowed
  ) {
    return block(
      `Mutations are blocked during research ${ctx.researchPhase.phase} phase.`,
      ["research_phase_gate", ctx.researchPhase.phase],
    );
  }

  const action = ctx.preparedAction;
  if (descriptor.execution.preparation === "required" && !action) {
    return block("This action must be prepared before authorization.", [
      "prepared_action_required",
      "fail_closed",
    ]);
  }
  if (action) {
    if (
      action.version !== 1 ||
      action.toolName !== descriptor.name ||
      action.target.system !== descriptor.capability.system ||
      action.target.resourceType !== descriptor.capability.resourceType
    ) {
      return block("Prepared action does not match the tool descriptor.", [
        "prepared_action_mismatch",
        "fail_closed",
      ]);
    }
    const expiresAt = Date.parse(action.expiresAt);
    if (
      !Number.isFinite(expiresAt) ||
      (ctx.now ?? new Date()).getTime() >= expiresAt
    ) {
      return block("Prepared action has expired.", [
        "prepared_action_expired",
        "fail_closed",
      ]);
    }
  }

  if (descriptor.effect === "read") {
    return allow("Read action is within the resolved scope.", [
      "descriptor_allow",
      "read_only",
    ]);
  }

  const grant = ctx.matchingGrant;
  if (grant) {
    if (
      grant.state !== "active" ||
      !Number.isFinite(Date.parse(grant.expiresAt)) ||
      (ctx.now ?? new Date()).getTime() >= Date.parse(grant.expiresAt)
    ) {
      return block("Supplied authority grant is not active.", [
        "invalid_authority_grant",
        "fail_closed",
      ]);
    }
    if (
      (grant.kind === "run_bounded" || grant.kind === "scheduled_bounded") &&
      !descriptor.approval.allowPersistentGrant
    ) {
      return block("This tool does not permit bounded persistent grants.", [
        "persistent_grant_disallowed",
        "fail_closed",
      ]);
    }
    if (
      (grant.kind === "one_shot" || grant.kind === "prompt_bound") &&
      !descriptor.approval.allowPromptGrant
    ) {
      return block("This tool does not permit prompt-bound grants.", [
        "prompt_grant_disallowed",
        "fail_closed",
      ]);
    }
    if (
      !action ||
      (grant.actionFingerprint !== undefined &&
        grant.actionFingerprint !== action.payloadFingerprint)
    ) {
      return block("Authority grant does not match the prepared payload.", [
        "authority_fingerprint_mismatch",
        "fail_closed",
      ]);
    }
    return {
      action: "allow",
      reason: "Prepared action is covered by a verified authority grant.",
      tags: ["authority_grant", grant.kind],
      grantId: grant.id,
      payloadFingerprint: action.payloadFingerprint,
    };
  }

  if (
    action &&
    ctx.writeAutonomy &&
    descriptor.effect === "reversible_mutation" &&
    (descriptor.capability.action === "replace" ||
      descriptor.capability.action === "append" ||
      descriptor.capability.action === "update" ||
      descriptor.capability.action === "create") &&
    descriptor.approval.fallback === "exact"
  ) {
    return allow(
      "Scoped reversible mutation proceeds under write autonomy with a fingerprint-bound prepared action.",
      ["write_autonomy", "prepared_fingerprint"],
    );
  }

  if (
    action &&
    descriptor.approval.allowPromptGrant &&
    (descriptor.approval.fallback === "exact" ||
      descriptor.approval.fallback === "double_exact")
  ) {
    const requiredConfirmations =
      descriptor.approval.fallback === "double_exact" ? 2 : 1;
    return {
      action: "require_approval",
      reason:
        requiredConfirmations === 2
          ? "This exact prepared payload requires two confirmations."
          : "This exact prepared payload requires confirmation.",
      tags: ["exact_payload_approval", `confirmations_${requiredConfirmations}`],
      payloadFingerprint: action.payloadFingerprint,
      requiredConfirmations,
    };
  }

  return block("No authority grant permits this action.", [
    "authority_required",
    "fail_closed",
  ]);
}

export interface RoutedIntentFallbackInput {
  missionIntent?: MissionIntent;
  writeAutonomy: boolean;
  writeToolExposed: boolean;
}

/**
 * Behavior-identical bridge for runs where the structured model router is
 * disabled or unavailable: projects the regex-derived MissionIntent (plus the
 * run's actual write-tool exposure decision) into a RoutedMissionIntent so the
 * execution-time policy engine can always run. Write scope mirrors the
 * exposure decision the regex gates already made, so the mutation-scope block
 * only fires for tool calls that slipped past tool exposure.
 */
export function deriveRoutedIntentFallback({
  missionIntent,
  writeAutonomy,
  writeToolExposed,
}: RoutedIntentFallbackInput): RoutedMissionIntent {
  return {
    mode: toFallbackMode(missionIntent),
    writeScope: toFallbackWriteScope({
      missionIntent,
      writeAutonomy,
      writeToolExposed,
    }),
    needsWebEvidence: missionIntent?.autonomyScope.read.web === true,
    needsVaultContext: missionIntent?.vaultContext === true,
    needsCodeExecution: false,
    wordTarget: null,
    confidence: 1,
    rationale: "regex-derived fallback intent",
  };
}

/**
 * Final pre-tool routed intent: regex fallback plus optional authority mode
 * with safer writeScope intersection. PolicyEngine remains the last gate.
 */
export function resolvePolicyRoutedIntent({
  mode,
  modelIntent,
  missionIntent,
  writeAutonomy,
  writeToolExposed,
  confidenceThreshold = ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD,
}: {
  mode: ModelRouterMode;
  modelIntent?: RoutedMissionIntent | null;
  missionIntent?: MissionIntent;
  writeAutonomy: boolean;
  writeToolExposed: boolean;
  confidenceThreshold?: number;
}): ResolvedRouterIntent {
  const regexIntent = deriveRoutedIntentFallback({
    missionIntent,
    writeAutonomy,
    writeToolExposed,
  });
  return resolveRoutedMissionIntent({
    mode,
    modelIntent,
    regexIntent,
    confidenceThreshold,
  });
}

function toFallbackMode(
  missionIntent: MissionIntent | undefined,
): RoutedMissionIntent["mode"] {
  switch (missionIntent?.mode) {
    case "vault_context_answer":
      return "vault_read";
    case "note_output":
    case "explicit_file_mutation":
    case "explicit_delete":
      return "vault_write";
    default:
      return "chat_answer";
  }
}

function toFallbackWriteScope({
  missionIntent,
  writeAutonomy,
  writeToolExposed,
}: RoutedIntentFallbackInput): RoutedMissionIntent["writeScope"] {
  if (missionIntent?.explicitDelete || missionIntent?.autonomyScope.destructive.replaceCurrentNote) {
    return "current_note_replace";
  }
  if (missionIntent?.noteOutput) {
    return "current_note_append";
  }
  if (
    missionIntent?.explicitMutation ||
    missionIntent?.requireWriteCompletion ||
    writeAutonomy ||
    writeToolExposed
  ) {
    return "vault_files";
  }
  return "none";
}

export function isMutatingToolName(toolName: string): boolean {
  return isMutatingTool(toolName);
}

// Code tools are intentionally excluded here: they operate on the sandboxed
// run workspace (outside the vault) and are governed by the desktop, approval,
// and run-budget rules above instead of vault write scope.
function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOL_PATTERN.test(toolName);
}

function allow(reason: string, tags: string[]): PolicyDecision {
  return { action: "allow", reason, tags };
}

function requireApproval(reason: string, tags: string[]): PolicyDecision {
  return { action: "require_approval", reason, tags };
}

function block(reason: string, tags: string[]): PolicyDecision {
  return { action: "block", reason, tags };
}
