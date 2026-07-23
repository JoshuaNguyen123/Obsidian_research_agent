/**
 * Bundled approval preview for compound missions.
 *
 * Shows planned Linear / code / GitHub Bound actions ONCE near run start,
 * then lets closely related Bound steps proceed under a stage grant.
 * Hard / destructive / scope-changing tools are never covered by the bundle
 * and still require separate exact confirmation.
 *
 * ## Public API for AgentRunner wire-up (coordinator)
 *
 * 1. Near mission start (after stages known, before Bound mutations):
 *    `const preview = await buildBundledApprovalPreview({ runId, stages, ... })`
 *    If `preview.items.length === 0`, skip UI.
 *
 * 2. Present once via ApprovalBroker:
 *    `approvalBroker.request(bundledPreviewToApprovalRequest(preview), { onRequest })`
 *    UI should render `formatBundledApprovalPreview(preview)` (or `preview.items`).
 *
 * 3. On user approve:
 *    `const grant = issueBundledStageGrant({ preview, userApproved: true })`
 *    Persist grant on the run (runStore / ledger). Optionally also
 *    `createBundledCompoundAuthorityGrant` when concrete selectors exist.
 *
 * 4. At each Bound approval gate (before Chat Approve / set-loose auto):
 *    `const gate = evaluateBundledApprovalGate({ grant, toolName })`
 *    - `allow_under_bundle` → skip Chat Approve; call `consumeBundledStageGrant`
 *    - `require_exact` (Hard) → keep double/exact confirmation path
 *    - `no_grant` → fall through to existing set-loose / Chat Approve
 *
 * Soft tools are outside this module (already auto under automatic).
 */

import { sha256Fingerprint } from "./actions";
import {
  effectClassForTool,
  type AutonomyEffectClass,
} from "./autonomyEffectClass";
import {
  BUNDLED_COMPOUND_BOUND_PREVIEW_TOOL_NAME,
  type ApprovalRequest,
} from "./approvalBroker";
import type { ProjectLifecycleStageV1 } from "./projectLifecycle";
import {
  CODE_EXECUTION_TOOL_ALLOW,
  PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES,
  toolsAllowedForLifecycleStage,
} from "./lifecycleStagePolicy";

/** Delivery stages that participate in the early Bound bundle (not cleanup). */
const BUNDLE_DELIVERY_STAGES: readonly ProjectLifecycleStageV1[] = [
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "private_github_publication",
];

export const BUNDLED_APPROVAL_PREVIEW_VERSION = 1 as const;
export const BUNDLED_STAGE_GRANT_VERSION = 1 as const;

/** Default TTL for an early compound Bound bundle grant (2 hours). */
export const BUNDLED_STAGE_GRANT_TTL_MS = 2 * 60 * 60_000;

/** Default Bound mutation budget across the whole compound ladder. */
export const BUNDLED_STAGE_GRANT_MAX_BOUND_ACTIONS = 48;

export type BundledActionFamilyId =
  | "linear_publish"
  | "linear_issues"
  | "code_workspace"
  | "code_validate"
  | "code_commit"
  | "github_publish"
  | "vault_replace";

export interface BundledApprovalItemV1 {
  toolName: string;
  stage: ProjectLifecycleStageV1;
  effectClass: "bound";
  familyId: BundledActionFamilyId;
  /** Stable family fingerprint (stage + family), not a prepared-action hash. */
  familyFingerprint: string;
  system: "linear" | "github" | "workspace" | "git" | "vault";
  summary: string;
}

export interface BundledApprovalPreviewV1 {
  version: typeof BUNDLED_APPROVAL_PREVIEW_VERSION;
  runId: string;
  /** SHA-256 over sorted family fingerprints + stages. */
  bundleFingerprint: string;
  items: BundledApprovalItemV1[];
  /** Unique family fingerprints covered if the user approves. */
  familyFingerprints: string[];
  stages: ProjectLifecycleStageV1[];
  /** Hard tools discovered in the plan that stay outside the bundle. */
  hardExcluded: Array<{ toolName: string; reason: string }>;
  createdAt: string;
  expiresAt: string;
}

export interface BundledStageGrantV1 {
  version: typeof BUNDLED_STAGE_GRANT_VERSION;
  id: string;
  runId: string;
  bundleFingerprint: string;
  coveredFamilyFingerprints: string[];
  stages: ProjectLifecycleStageV1[];
  state: "active" | "revoked" | "expired" | "exhausted";
  issuedAt: string;
  expiresAt: string;
  maxBoundActions: number;
  boundActionsUsed: number;
  /** Optional link when a concrete AuthorityGrantV1 was also minted. */
  authorityGrantId?: string;
}

export type BundledApprovalGateDecision =
  | {
      decision: "allow_under_bundle";
      familyFingerprint: string;
      familyId: BundledActionFamilyId;
    }
  | {
      decision: "require_exact";
      reason: string;
      effectClass: AutonomyEffectClass;
    }
  | {
      decision: "no_grant";
      reason: string;
      effectClass: AutonomyEffectClass;
    };

const FAMILY_SUMMARIES: Record<BundledActionFamilyId, string> = {
  linear_publish: "Publish accepted research into Linear",
  linear_issues: "Create or update Linear issues for the project hierarchy",
  code_workspace: "Create and edit the trusted code workspace",
  code_validate: "Run sandbox validation and repair cycles",
  code_commit: "Create a verified local commit after validation",
  github_publish: "Create a private GitHub repository and draft PR",
  vault_replace: "Replace the initiating note when explicitly required",
};

const CODE_WORKSPACE_TOOLS = new Set<string>(
  CODE_EXECUTION_TOOL_ALLOW.filter(
    (name) =>
      name.startsWith("code_workspace_") || name === "code_sandbox_status",
  ),
);

const CODE_VALIDATE_TOOLS = new Set<string>(
  CODE_EXECUTION_TOOL_ALLOW.filter(
    (name) =>
      name.startsWith("code_validate_") || name.startsWith("code_repair_"),
  ),
);

/**
 * Map a Bound delivery tool to its approval family. Returns null for Soft,
 * Hard, cleanup, or unknown tools that must not join the early bundle.
 */
export function bundledActionFamilyForTool(
  toolName: string,
): {
  familyId: BundledActionFamilyId;
  stage: ProjectLifecycleStageV1;
  system: BundledApprovalItemV1["system"];
} | null {
  const name = toolName.trim();
  if (!name) return null;
  const effect = effectClassForTool(name);
  if (effect !== "bound") return null;

  if (
    name === "publish_research_to_linear" ||
    name === "publish_research_project_to_linear"
  ) {
    return {
      familyId: "linear_publish",
      stage:
        name === "publish_research_project_to_linear"
          ? "linear_hierarchy"
          : "accepted_research",
      system: "linear",
    };
  }
  if (
    name === "linear_create_issue" ||
    name === "linear_update_issue" ||
    name === "linear_get_issue"
  ) {
    return {
      familyId: "linear_issues",
      stage: "linear_hierarchy",
      system: "linear",
    };
  }
  if (CODE_WORKSPACE_TOOLS.has(name)) {
    return {
      familyId: "code_workspace",
      stage: "code_execution",
      system: "workspace",
    };
  }
  if (CODE_VALIDATE_TOOLS.has(name)) {
    return {
      familyId: "code_validate",
      stage: "code_execution",
      system: "workspace",
    };
  }
  if (name === "code_commit_verified") {
    return {
      familyId: "code_commit",
      stage: "code_execution",
      system: "git",
    };
  }
  if (
    name === "github_create_private_repository" ||
    name === "github_publish_verified_branch" ||
    name === "publish_verified_code_to_github" ||
    name === "github_get_pull_request"
  ) {
    return {
      familyId: "github_publish",
      stage: "private_github_publication",
      system: "github",
    };
  }
  if (name === "replace_current_file") {
    return {
      familyId: "vault_replace",
      stage: "accepted_research",
      system: "vault",
    };
  }
  return null;
}

export function computeBundledFamilyFingerprint(input: {
  stage: ProjectLifecycleStageV1;
  familyId: BundledActionFamilyId;
}): string {
  return `bound-family:v1:${input.stage}:${input.familyId}`;
}

/** Partition tool names into Soft / Bound-bundleable / Hard (never bundled). */
export function partitionToolsForBundledApproval(
  toolNames: readonly string[],
): {
  soft: string[];
  bound: string[];
  hard: string[];
  unboundBound: string[];
} {
  const soft: string[] = [];
  const bound: string[] = [];
  const hard: string[] = [];
  const unboundBound: string[] = [];
  for (const raw of toolNames) {
    const name = raw.trim();
    if (!name) continue;
    const effect = effectClassForTool(name);
    if (effect === "soft") {
      soft.push(name);
      continue;
    }
    if (effect === "hard") {
      hard.push(name);
      continue;
    }
    if (bundledActionFamilyForTool(name)) {
      bound.push(name);
    } else {
      unboundBound.push(name);
    }
  }
  return { soft, bound, hard, unboundBound };
}

function defaultBoundToolsForStages(
  stages: readonly ProjectLifecycleStageV1[],
): string[] {
  const tools = new Set<string>();
  for (const stage of stages) {
    if (!(BUNDLE_DELIVERY_STAGES as readonly string[]).includes(stage)) {
      // Cleanup / unknown stages are Hard-gated or out of scope.
      continue;
    }
    for (const toolName of toolsAllowedForLifecycleStage(stage)) {
      if (effectClassForTool(toolName) !== "bound") continue;
      if (bundledActionFamilyForTool(toolName)) {
        tools.add(toolName);
      }
    }
    // Ensure stage-paying Bound mutations are previewed even when the stage
    // allowlist is read-heavy.
    for (const toolName of PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES) {
      const family = bundledActionFamilyForTool(toolName);
      if (family && family.stage === stage) {
        tools.add(toolName);
      }
    }
  }
  return [...tools].sort((a, b) => a.localeCompare(b));
}

/**
 * Build the one-shot early preview of planned Bound external actions.
 * Hard tools appearing in `extraToolNames` are listed under `hardExcluded`
 * and never receive family fingerprints.
 */
export async function buildBundledApprovalPreview(input: {
  runId: string;
  stages: readonly ProjectLifecycleStageV1[];
  /** Optional explicit tool plan; defaults to stage Bound delivery tools. */
  toolNames?: readonly string[];
  now?: Date;
  ttlMs?: number;
}): Promise<BundledApprovalPreviewV1> {
  const runId = input.runId.trim();
  if (!runId) {
    throw new TypeError("Bundled approval preview requires runId.");
  }
  const stages = [...new Set(input.stages)].filter((stage) =>
    Boolean(stage),
  ) as ProjectLifecycleStageV1[];
  const now = input.now ?? new Date();
  const ttlMs = Math.max(60_000, input.ttlMs ?? BUNDLED_STAGE_GRANT_TTL_MS);
  const toolNames =
    input.toolNames && input.toolNames.length > 0
      ? input.toolNames.map((name) => name.trim()).filter(Boolean)
      : defaultBoundToolsForStages(stages);

  const partitioned = partitionToolsForBundledApproval(toolNames);
  const itemsByFamily = new Map<string, BundledApprovalItemV1>();
  for (const toolName of partitioned.bound) {
    const mapped = bundledActionFamilyForTool(toolName);
    if (!mapped) continue;
    // Only include families for stages in this mission plan.
    if (
      stages.length > 0 &&
      !stages.includes(mapped.stage) &&
      !(
        mapped.stage === "accepted_research" &&
        stages.includes("linear_hierarchy")
      )
    ) {
      continue;
    }
    const familyFingerprint = computeBundledFamilyFingerprint({
      stage: mapped.stage,
      familyId: mapped.familyId,
    });
    const existing = itemsByFamily.get(familyFingerprint);
    if (existing) {
      // Keep a representative tool name; prefer the first stable sort order.
      if (toolName.localeCompare(existing.toolName) < 0) {
        existing.toolName = toolName;
      }
      continue;
    }
    itemsByFamily.set(familyFingerprint, {
      toolName,
      stage: mapped.stage,
      effectClass: "bound",
      familyId: mapped.familyId,
      familyFingerprint,
      system: mapped.system,
      summary: FAMILY_SUMMARIES[mapped.familyId],
    });
  }

  const items = [...itemsByFamily.values()].sort((left, right) => {
    const stageCmp = left.stage.localeCompare(right.stage);
    if (stageCmp !== 0) return stageCmp;
    return left.familyId.localeCompare(right.familyId);
  });
  const familyFingerprints = items.map((item) => item.familyFingerprint);
  const bundleFingerprint = await sha256Fingerprint({
    version: BUNDLED_APPROVAL_PREVIEW_VERSION,
    kind: "bundled_approval_preview",
    runId,
    stages: [...stages].sort(),
    familyFingerprints: [...familyFingerprints].sort(),
  });

  return {
    version: BUNDLED_APPROVAL_PREVIEW_VERSION,
    runId,
    bundleFingerprint,
    items,
    familyFingerprints,
    stages,
    hardExcluded: partitioned.hard.map((toolName) => ({
      toolName,
      reason: "hard_effect_requires_separate_exact_confirmation",
    })),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function formatBundledApprovalPreview(
  preview: BundledApprovalPreviewV1,
): string {
  const lines = [
    "Planned external Bound actions (approve once for this run):",
    ...preview.items.map(
      (item) => `- [${item.stage}] ${item.summary} (${item.toolName})`,
    ),
    "Hard/destructive actions (merge, trash, delete, cleanup) still require separate exact confirmation and are not covered by this bundle.",
  ];
  if (preview.hardExcluded.length > 0) {
    lines.push(
      "Hard tools already present in this plan:",
      ...preview.hardExcluded.map((item) => `- ${item.toolName}`),
    );
  }
  return lines.join("\n");
}

/**
 * Shape a broker request for the one early preview. Coordinator presents this
 * through the existing ApprovalBroker + Chat Approve surface.
 */
export function bundledPreviewToApprovalRequest(
  preview: BundledApprovalPreviewV1,
): Omit<ApprovalRequest, "id" | "expiresAtMs"> {
  return {
    runId: preview.runId,
    toolName: BUNDLED_COMPOUND_BOUND_PREVIEW_TOOL_NAME,
    action: "approve_bundled_bound_stage_grant",
    reason: formatBundledApprovalPreview(preview),
    policyTags: [
      "bundled_approval_preview",
      "bound_stage_grant",
      `bundle:${preview.bundleFingerprint}`,
    ],
    payloadFingerprint: preview.bundleFingerprint,
    bundleFingerprint: preview.bundleFingerprint,
    confirmationIndex: 1,
    requiredConfirmations: 1,
  };
}

export function issueBundledStageGrant(input: {
  preview: BundledApprovalPreviewV1;
  /** Must be the literal true from the host's explicit approval path. */
  userApproved: true;
  id?: string;
  now?: Date;
  maxBoundActions?: number;
  authorityGrantId?: string;
}): BundledStageGrantV1 {
  if (input.userApproved !== true) {
    throw new TypeError("Bundled stage grant requires explicit user approval.");
  }
  const preview = input.preview;
  if (preview.items.length === 0) {
    throw new TypeError("Cannot issue a bundled stage grant for an empty preview.");
  }
  const now = input.now ?? new Date();
  if (Date.parse(preview.expiresAt) <= now.getTime()) {
    throw new TypeError("Bundled approval preview has expired.");
  }
  const id =
    input.id?.trim() ||
    `bundled-grant:${preview.runId}:${preview.bundleFingerprint.slice(7, 23)}`;
  return {
    version: BUNDLED_STAGE_GRANT_VERSION,
    id,
    runId: preview.runId,
    bundleFingerprint: preview.bundleFingerprint,
    coveredFamilyFingerprints: [...preview.familyFingerprints],
    stages: [...preview.stages],
    state: "active",
    issuedAt: now.toISOString(),
    expiresAt: preview.expiresAt,
    maxBoundActions: Math.max(
      1,
      input.maxBoundActions ?? BUNDLED_STAGE_GRANT_MAX_BOUND_ACTIONS,
    ),
    boundActionsUsed: 0,
    ...(input.authorityGrantId?.trim()
      ? { authorityGrantId: input.authorityGrantId.trim() }
      : {}),
  };
}

export function bundledGrantIsActive(
  grant: BundledStageGrantV1,
  now: Date = new Date(),
): boolean {
  return (
    grant.state === "active" &&
    Number.isFinite(Date.parse(grant.expiresAt)) &&
    now.getTime() < Date.parse(grant.expiresAt) &&
    grant.boundActionsUsed < grant.maxBoundActions
  );
}

/**
 * Decide whether a tool may proceed under the early Bound bundle grant.
 * Hard tools always return `require_exact` even if somehow listed.
 */
export function evaluateBundledApprovalGate(input: {
  grant: BundledStageGrantV1 | null | undefined;
  toolName: string;
  now?: Date;
}): BundledApprovalGateDecision {
  const toolName = input.toolName.trim();
  const effectClass = effectClassForTool(toolName);
  if (!toolName) {
    return {
      decision: "require_exact",
      reason: "empty_tool_name",
      effectClass: "bound",
    };
  }
  if (effectClass === "soft") {
    return {
      decision: "no_grant",
      reason: "soft_tools_do_not_use_bundled_bound_grants",
      effectClass,
    };
  }
  if (effectClass === "hard") {
    return {
      decision: "require_exact",
      reason: "hard_effect_excluded_from_bundled_bound_grant",
      effectClass,
    };
  }

  const grant = input.grant;
  if (!grant || !bundledGrantIsActive(grant, input.now ?? new Date())) {
    return {
      decision: "no_grant",
      reason: grant ? "bundled_stage_grant_inactive" : "bundled_stage_grant_missing",
      effectClass,
    };
  }
  if (grant.runId.trim() === "") {
    return {
      decision: "no_grant",
      reason: "bundled_stage_grant_missing_run",
      effectClass,
    };
  }

  const family = bundledActionFamilyForTool(toolName);
  if (!family) {
    return {
      decision: "require_exact",
      reason: "bound_tool_outside_bundled_families",
      effectClass,
    };
  }
  const familyFingerprint = computeBundledFamilyFingerprint({
    stage: family.stage,
    familyId: family.familyId,
  });
  if (!grant.coveredFamilyFingerprints.includes(familyFingerprint)) {
    return {
      decision: "require_exact",
      reason: "bound_family_not_in_approved_bundle",
      effectClass,
    };
  }
  return {
    decision: "allow_under_bundle",
    familyFingerprint,
    familyId: family.familyId,
  };
}

export function consumeBundledStageGrant(input: {
  grant: BundledStageGrantV1;
  toolName: string;
  now?: Date;
}):
  | { ok: true; grant: BundledStageGrantV1 }
  | { ok: false; reason: string; grant: BundledStageGrantV1 } {
  const gate = evaluateBundledApprovalGate({
    grant: input.grant,
    toolName: input.toolName,
    now: input.now,
  });
  if (gate.decision !== "allow_under_bundle") {
    return {
      ok: false,
      reason: gate.reason,
      grant: input.grant,
    };
  }
  const used = input.grant.boundActionsUsed + 1;
  const next: BundledStageGrantV1 = {
    ...input.grant,
    boundActionsUsed: used,
    state:
      used >= input.grant.maxBoundActions ? "exhausted" : input.grant.state,
  };
  return { ok: true, grant: next };
}

export function revokeBundledStageGrant(
  grant: BundledStageGrantV1,
  revokedAt: Date = new Date(),
): BundledStageGrantV1 {
  return {
    ...grant,
    state: "revoked",
    expiresAt:
      Date.parse(grant.expiresAt) <= revokedAt.getTime()
        ? grant.expiresAt
        : revokedAt.toISOString(),
  };
}

/**
 * True when an active bundle grant covers this Bound tool so Chat Approve can
 * be skipped. Hard never returns true.
 */
export function boundMayAutoUnderBundledGrant(input: {
  toolName: string;
  grant: BundledStageGrantV1 | null | undefined;
  now?: Date;
}): boolean {
  return (
    evaluateBundledApprovalGate({
      grant: input.grant,
      toolName: input.toolName,
      now: input.now,
    }).decision === "allow_under_bundle"
  );
}

/** True when the mission should collect the early Bound preview before mutations. */
export function shouldOfferBundledApprovalPreview(input: {
  compoundLifecycleDetected: boolean;
  stages: readonly ProjectLifecycleStageV1[];
  existingGrant?: BundledStageGrantV1 | null;
  now?: Date;
}): boolean {
  if (!input.compoundLifecycleDetected) return false;
  if (
    input.existingGrant &&
    bundledGrantIsActive(input.existingGrant, input.now ?? new Date())
  ) {
    return false;
  }
  return input.stages.some((stage) =>
    (BUNDLE_DELIVERY_STAGES as readonly string[]).includes(stage),
  );
}
