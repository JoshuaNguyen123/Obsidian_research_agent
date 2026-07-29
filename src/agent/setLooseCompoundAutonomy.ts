/**
 * Set-loose compound autonomy: Bound Linear/code/GitHub without Chat grants,
 * stage time budgets, 100k context floor, and raised vault semantic caps.
 */

import {
  effectClassForTool,
  type AutonomyProfile,
} from "./autonomyEffectClass";
import {
  boundMayAutoUnderBundledGrant,
  type BundledStageGrantV1,
} from "./bundledApprovalPreview";
import {
  CODE_EXECUTION_TOOL_ALLOW,
  PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES,
  toolsAllowedForLifecycleStage,
} from "./lifecycleStagePolicy";
import {
  estimateProjectLifecycleForSetLooseV1,
  PROJECT_LIFECYCLE_STAGES,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";
import { parseAcceptedResearchArtifactV1 } from "../integrations/linear/AcceptedResearchArtifactV1";
import { parseExternalWorkItemBindingV1 } from "../integrations/linear/ExternalWorkItemBindingV1";
import { parseWorkItemLineageV1 } from "../integrations/linear/WorkItemLineageV1";
import { parseRenderedCompatibleWorkItemSpec } from "../integrations/linear/WorkItemParser";

export type { BundledStageGrantV1 };
export { boundMayAutoUnderBundledGrant };

/** Delivery stages gated for set-loose compound completion (not cleanup). */
export const SET_LOOSE_DELIVERY_STAGES = [
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "private_github_publication",
] as const satisfies readonly ProjectLifecycleStageV1[];

const RECONCILIATION_CLEANUP_TOOLS = new Set<string>(
  toolsAllowedForLifecycleStage("reconciliation_cleanup"),
);

/** Successful tools that pay `accepted_research`. */
const STAGE_PAID_ACCEPTED_RESEARCH = new Set<string>([
  "publish_research_to_linear",
]);

/** Successful tools that pay `linear_hierarchy`. */
const STAGE_PAID_LINEAR_HIERARCHY = new Set<string>([
  "linear_create_issue",
  "linear_get_issue",
  "publish_research_project_to_linear",
]);

/** Successful tools that pay `code_execution`. */
const STAGE_PAID_CODE_EXECUTION = new Set<string>([
  "code_commit_verified",
]);

/** Successful tools that pay `private_github_publication` stage budget. */
const STAGE_PAID_PRIVATE_GITHUB = new Set<string>([
  // Create advances budget toward publish, but Soft-union delivery proofs still
  // require a draft PR URL (see applySetLooseDeliveryProofFromSuccessfulTool).
  "github_create_private_repository",
  "github_publish_verified_branch",
  "publish_verified_code_to_github",
]);

/** Bound tools that may auto-run under set-loose automatic (not Hard). */
export const SET_LOOSE_BOUND_TOOL_NAMES = new Set<string>([
  ...PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES,
  "linear_create_issue",
  "linear_update_issue",
  "linear_get_issue",
  ...CODE_EXECUTION_TOOL_ALLOW,
  "github_get_pull_request",
  "replace_current_file",
]);

/**
 * Soft tools always allowed alongside the current lifecycle stage allowlist
 * so frontier offering stays agentic (reads/search/append) without opening Hard.
 */
export const SET_LOOSE_STAGE_SOFT_COMPANIONS = [
  "web_search",
  "web_fetch",
  "read_current_file",
  "read_file",
  "read_markdown_files",
  "search_markdown_files",
  "list_markdown_files",
  "list_templates",
  "read_template",
  "semantic_search_notes",
  "find_related_notes",
  "get_note_graph_context",
  "append_to_current_file",
  "replace_current_file",
  "count_words",
] as const;

/** Full compound set-loose context floor (tokens). */
export const COMPOUND_SET_LOOSE_NUM_CTX = 100_000;

export function isSetLooseEnabled(input: {
  autonomyProfile: AutonomyProfile;
  compoundLifecycleDetected: boolean;
  /** When autonomy is custom but Chat working mode is still automatic, allow set-loose. */
  workingMode?: string | null;
}): boolean {
  const automaticAutonomy =
    input.autonomyProfile === "automatic" ||
    (input.autonomyProfile === "custom" &&
      (input.workingMode ?? "").trim().toLowerCase() === "automatic");
  return (
    automaticAutonomy && input.compoundLifecycleDetected === true
  );
}

/** Bound may auto without Chat grant when set-loose; Hard never. */
export function boundMayAutoWithoutGrant(input: {
  toolName: string;
  autonomyProfile: AutonomyProfile;
  compoundLifecycleDetected: boolean;
  workingMode?: string | null;
}): boolean {
  if (!isSetLooseEnabled(input)) return false;
  const toolName = input.toolName.trim();
  if (!toolName) return false;
  // Hard (trash/delete/merge/cleanup) never auto under set-loose.
  if (effectClassForTool(toolName) === "hard") return false;
  // Named delivery tools plus any other Bound-class tool (sandbox nested
  // identities, repair helpers) so Chat Approve cannot strand the pipeline.
  if (SET_LOOSE_BOUND_TOOL_NAMES.has(toolName)) return true;
  return effectClassForTool(toolName) === "bound";
}

/**
 * Bound may skip Chat Approve under an early bundled stage grant OR set-loose.
 * Hard never auto-executes through either path.
 *
 * INTEGRATOR: Prefer this at the runner approval gate when a
 * BundledStageGrantV1 may be present on the run.
 */
export function boundMayAutoWithoutChatGrant(input: {
  toolName: string;
  autonomyProfile: AutonomyProfile;
  compoundLifecycleDetected: boolean;
  workingMode?: string | null;
  bundledGrant?: BundledStageGrantV1 | null;
  now?: Date;
}): boolean {
  if (effectClassForTool(input.toolName) === "hard") return false;
  if (
    boundMayAutoUnderBundledGrant({
      toolName: input.toolName,
      grant: input.bundledGrant,
      now: input.now,
    })
  ) {
    return true;
  }
  return boundMayAutoWithoutGrant(input);
}

/**
 * True when every pending Bound tool is set-loose-eligible (Soft pending tools
 * are ignored here; Soft already auto under automatic).
 */
export function pendingToolsAllowSetLooseWithoutGrant(input: {
  pendingToolNames: readonly string[];
  autonomyProfile: AutonomyProfile;
  compoundLifecycleDetected: boolean;
  workingMode?: string | null;
}): boolean {
  if (!isSetLooseEnabled(input)) return false;
  const pending = input.pendingToolNames.map((n) => n.trim()).filter(Boolean);
  const boundPending = pending.filter(
    (toolName) => effectClassForTool(toolName) === "bound",
  );
  if (boundPending.length === 0) return false;
  return boundPending.every((toolName) =>
    boundMayAutoWithoutGrant({
      toolName,
      autonomyProfile: input.autonomyProfile,
      compoundLifecycleDetected: input.compoundLifecycleDetected,
      workingMode: input.workingMode,
    }),
  );
}

/**
 * Resolve num_ctx for a run. Explicit Settings win; a blank Settings value
 * falls back to the model-reported context window from the connection test.
 * When set-loose compound is on, floor at 100k — capped at the model-reported
 * window when known. Never lower an explicit Settings value that is already
 * higher.
 */
export function resolveNumCtxForCompoundRun(input: {
  settingsNumCtx: number | null | undefined;
  autonomyProfile: AutonomyProfile;
  compoundLifecycleDetected: boolean;
  workingMode?: string | null;
  modelReportedContextLength?: number | null;
}): number | null {
  const settings =
    typeof input.settingsNumCtx === "number" &&
    Number.isFinite(input.settingsNumCtx) &&
    input.settingsNumCtx > 0
      ? Math.trunc(input.settingsNumCtx)
      : null;
  const modelReported =
    typeof input.modelReportedContextLength === "number" &&
    Number.isSafeInteger(input.modelReportedContextLength) &&
    input.modelReportedContextLength > 0
      ? input.modelReportedContextLength
      : null;
  const base = settings ?? modelReported;
  if (!isSetLooseEnabled(input)) return base;
  const floor =
    modelReported === null
      ? COMPOUND_SET_LOOSE_NUM_CTX
      : Math.min(COMPOUND_SET_LOOSE_NUM_CTX, modelReported);
  if (base === null) return floor;
  return Math.max(base, floor);
}

export interface CompoundStageBudgetV1 {
  stage: ProjectLifecycleStageV1;
  activeMinutesMin: number;
  activeMinutesMax: number;
  /** Wall-clock ms budget for this stage (from max * 60_000 at run start). */
  budgetMs: number;
  startedAtMs: number | null;
  remainingMs: number;
}

export interface CompoundRunBudgetPlanV1 {
  stages: CompoundStageBudgetV1[];
  runBudgetMs: number;
  currentStage: ProjectLifecycleStageV1 | null;
}

export function buildCompoundRunBudgetPlanV1(input: {
  stages: readonly ProjectLifecycleStageV1[];
  nowMs?: number;
}): CompoundRunBudgetPlanV1 {
  const nowMs = input.nowMs ?? Date.now();
  const estimate = estimateProjectLifecycleForSetLooseV1(input.stages);
  const stages: CompoundStageBudgetV1[] = estimate.stages.map((stageEst, index) => {
    const budgetMs = Math.max(60_000, stageEst.activeMinutesMax * 60_000);
    const isCurrent = index === 0;
    return {
      stage: stageEst.stage,
      activeMinutesMin: stageEst.activeMinutesMin,
      activeMinutesMax: stageEst.activeMinutesMax,
      budgetMs,
      startedAtMs: isCurrent ? nowMs : null,
      remainingMs: budgetMs,
    };
  });
  return {
    stages,
    runBudgetMs: stages.reduce((sum, s) => sum + s.budgetMs, 0),
    currentStage: stages[0]?.stage ?? null,
  };
}

export function formatStageBudgetPromptBlock(
  plan: CompoundRunBudgetPlanV1,
): string {
  if (plan.stages.length === 0) {
    return "STAGE BUDGET: none";
  }
  const lines = [
    "STAGE BUDGETS (set-loose compound):",
    `CURRENT STAGE: ${plan.currentStage ?? "none"}`,
  ];
  for (const stage of plan.stages) {
    const remainingMin = Math.max(0, Math.ceil(stage.remainingMs / 60_000));
    const active =
      stage.stage === plan.currentStage ? " (current)" : "";
    lines.push(
      `- ${stage.stage}${active}: ~${remainingMin} min remaining (cap ${stage.activeMinutesMax} min)`,
    );
  }
  return lines.join("\n");
}

export function advanceCompoundStageBudget(input: {
  plan: CompoundRunBudgetPlanV1;
  committedStage: ProjectLifecycleStageV1;
  nowMs?: number;
}): CompoundRunBudgetPlanV1 {
  const nowMs = input.nowMs ?? Date.now();
  const index = input.plan.stages.findIndex(
    (s) => s.stage === input.committedStage,
  );
  if (index < 0) {
    return input.plan;
  }
  const stages = input.plan.stages.map((stage, i) => {
    if (i < index) {
      return { ...stage, remainingMs: 0, startedAtMs: stage.startedAtMs };
    }
    if (i === index) {
      const started = stage.startedAtMs ?? nowMs;
      const elapsed = Math.max(0, nowMs - started);
      return {
        ...stage,
        startedAtMs: started,
        remainingMs: Math.max(0, stage.budgetMs - elapsed),
      };
    }
    if (i === index + 1) {
      return {
        ...stage,
        startedAtMs: nowMs,
        remainingMs: stage.budgetMs,
      };
    }
    return stage;
  });
  const next = stages[index + 1]?.stage ?? null;
  return {
    stages,
    runBudgetMs: input.plan.runBudgetMs,
    currentStage: next,
  };
}

export interface SemanticSearchCapsV1 {
  defaultLimit: number;
  maxLimit: number;
  defaultSnippetChars: number;
  maxSnippetChars: number;
  deepCandidateFloor: number;
  preferDeepMode: boolean;
}

export const DEFAULT_SEMANTIC_SEARCH_CAPS: SemanticSearchCapsV1 = {
  defaultLimit: 8,
  maxLimit: 20,
  defaultSnippetChars: 360,
  maxSnippetChars: 800,
  deepCandidateFloor: 64,
  preferDeepMode: false,
};

export const COMPOUND_SET_LOOSE_SEMANTIC_SEARCH_CAPS: SemanticSearchCapsV1 = {
  defaultLimit: 12,
  maxLimit: 40,
  defaultSnippetChars: 480,
  maxSnippetChars: 1_200,
  deepCandidateFloor: 96,
  preferDeepMode: true,
};

export function resolveSemanticSearchCapsForCompoundRun(input: {
  autonomyProfile: AutonomyProfile;
  compoundLifecycleDetected: boolean;
  semanticSearchEnabled?: boolean;
  workingMode?: string | null;
}): SemanticSearchCapsV1 {
  if (input.semanticSearchEnabled === false) {
    return DEFAULT_SEMANTIC_SEARCH_CAPS;
  }
  if (!isSetLooseEnabled(input)) return DEFAULT_SEMANTIC_SEARCH_CAPS;
  return COMPOUND_SET_LOOSE_SEMANTIC_SEARCH_CAPS;
}

export function toolsOfferedForSetLooseStage(
  stage: ProjectLifecycleStageV1,
  stageAllowlist: readonly string[] = toolsAllowedForLifecycleStage(stage),
): string[] {
  return [
    ...new Set([...stageAllowlist, ...SET_LOOSE_STAGE_SOFT_COMPANIONS]),
  ];
}

/**
 * Soft companions unioned with allowlists for the current stage and every later
 * stage still in the plan. Cleanup tools stay out unless reconciliation_cleanup
 * is itself in the detected plan stages.
 */
/** Code ladder tools that require a passed fast repair cycle before Soft-union. */
export const SET_LOOSE_CODE_COMMIT_REQUIRES_PASSED_FAST = [
  "code_commit_verified",
] as const;

/**
 * Soft-union must not offer commit before a passed fast repair cycle exists.
 * Otherwise the model races to code_commit_verified, fails twice with
 * passing_fast_validation_missing, and the MissionGraph commit node terminals.
 */
export function filterSetLooseCodeLadderUntilPassedFast(input: {
  offeredToolNames: readonly string[];
  passedFastRepairCycle: boolean;
}): string[] {
  if (input.passedFastRepairCycle) {
    return [...input.offeredToolNames];
  }
  const blocked = new Set<string>(SET_LOOSE_CODE_COMMIT_REQUIRES_PASSED_FAST);
  return input.offeredToolNames.filter((name) => !blocked.has(name));
}

const GITHUB_PUBLICATION_TOOLS = new Set<string>([
  "github_create_private_repository",
  "publish_verified_code_to_github",
  "github_publish_verified_branch",
  "github_get_pull_request",
]);

/** True when mission text explicitly asks to merge a PR (Bound path, not Soft-auto). */
export function missionRequestsGithubMerge(prompt: string): boolean {
  const text = String(prompt ?? "");
  return (
    /\bmerge(?:d)?\s+(?:the\s+)?(?:pull\s+request|pr)\b/i.test(text) ||
    /\bcompletionProof\s*[:=]\s*["']?merged_pr\b/i.test(text) ||
    /\bmerged_pr\b/i.test(text) ||
    /\bmerge\s+(?:it|this)\s+(?:to|into)\s+(?:main|master)\b/i.test(text)
  );
}

/**
 * Soft-union for unpaid code_execution: code allowlist + Soft companions only.
 * Withholds GitHub create/publish until code delivery is paid.
 */
export function toolsOfferedForSetLooseCodeStage(input: {
  stages: readonly ProjectLifecycleStageV1[];
  currentStage: ProjectLifecycleStageV1 | null;
  passedFastRepairCycle: boolean;
  codeDeliveryPaid: boolean;
}): string[] {
  if (input.codeDeliveryPaid) {
    return toolsOfferedForSetLoosePipeline({
      stages: input.stages,
      currentStage: input.currentStage,
      passedFastRepairCycle: input.passedFastRepairCycle,
    });
  }

  const offered = new Set<string>([
    ...SET_LOOSE_STAGE_SOFT_COMPANIONS,
    ...CODE_EXECUTION_TOOL_ALLOW,
  ]);
  // Keep Linear Soft reads/creates available while code is unpaid so the
  // code-spec binding can be refreshed if create-output parse lags.
  if (input.stages.includes("linear_hierarchy")) {
    offered.add("linear_get_connection_context");
    offered.add("linear_create_issue");
    offered.add("linear_get_issue");
    offered.add("linear_search_issues");
    offered.add("read_template");
    offered.add("list_templates");
  }
  // Keep Linear readback companions out of mutation gate; Soft companions already include note reads.
  return filterSetLooseCodeLadderUntilPassedFast({
    offeredToolNames: [...offered],
    passedFastRepairCycle: input.passedFastRepairCycle,
  });
}

/**
 * Soft-union for GitHub stage after code is paid. Merge action tooling is
 * Bound-reachable when mission asks; Soft-auto still stops at draft PR
 * (merge itself remains double-exact / Hard elsewhere).
 */
export function toolsOfferedForSetLooseGithubStage(input: {
  stages: readonly ProjectLifecycleStageV1[];
  currentStage: ProjectLifecycleStageV1 | null;
  passedFastRepairCycle: boolean;
  codeDeliveryPaid: boolean;
  githubDeliveryPaid: boolean;
  mergeRequested: boolean;
}): string[] {
  if (!input.codeDeliveryPaid) {
    return toolsOfferedForSetLooseCodeStage({
      stages: input.stages,
      currentStage: input.currentStage,
      passedFastRepairCycle: input.passedFastRepairCycle,
      codeDeliveryPaid: false,
    });
  }

  const offered = toolsOfferedForSetLoosePipeline({
    stages: input.stages,
    currentStage: input.currentStage ?? "private_github_publication",
    passedFastRepairCycle: input.passedFastRepairCycle,
  });

  // Soft-auto catalog always includes publish_draft path tools; merge is not a
  // separate Soft tool name — publish_verified_code_to_github action=merge is Bound.
  if (!input.mergeRequested && input.githubDeliveryPaid) {
    return offered.filter((name) => name !== "publish_verified_code_to_github");
  }
  return offered;
}

export function toolsOfferedForSetLoosePipeline(input: {
  stages: readonly ProjectLifecycleStageV1[];
  currentStage: ProjectLifecycleStageV1 | null;
  /** When false, withhold code_commit_verified from Soft-union. */
  passedFastRepairCycle?: boolean;
  /** When false, withhold GitHub publication tools (code unpaid). */
  codeDeliveryPaid?: boolean;
}): string[] {
  const planStages = new Set(input.stages);
  const currentIdx =
    input.currentStage == null
      ? 0
      : PROJECT_LIFECYCLE_STAGES.indexOf(input.currentStage);
  const startIdx = currentIdx < 0 ? 0 : currentIdx;
  const includeCleanup = planStages.has("reconciliation_cleanup");
  const codeDeliveryPaid = input.codeDeliveryPaid !== false;
  const codeUnpaid =
    planStages.has("code_execution") && input.codeDeliveryPaid === false;

  if (codeUnpaid && input.currentStage === "code_execution") {
    return toolsOfferedForSetLooseCodeStage({
      stages: input.stages,
      currentStage: input.currentStage,
      passedFastRepairCycle: input.passedFastRepairCycle === true,
      codeDeliveryPaid: false,
    });
  }

  const offered = new Set<string>([...SET_LOOSE_STAGE_SOFT_COMPANIONS]);
  for (let i = startIdx; i < PROJECT_LIFECYCLE_STAGES.length; i += 1) {
    const stage = PROJECT_LIFECYCLE_STAGES[i]!;
    if (!planStages.has(stage)) continue;
    if (stage === "reconciliation_cleanup" && !includeCleanup) continue;
    if (
      !codeDeliveryPaid &&
      (stage === "private_github_publication" || stage === "reconciliation_cleanup")
    ) {
      continue;
    }
    for (const tool of toolsAllowedForLifecycleStage(stage)) {
      offered.add(tool);
    }
  }

  if (!includeCleanup) {
    for (const tool of RECONCILIATION_CLEANUP_TOOLS) {
      offered.delete(tool);
    }
  }

  if (!codeDeliveryPaid) {
    for (const tool of GITHUB_PUBLICATION_TOOLS) {
      offered.delete(tool);
    }
  }

  return filterSetLooseCodeLadderUntilPassedFast({
    offeredToolNames: [...offered],
    passedFastRepairCycle: input.passedFastRepairCycle === true,
  });
}

/**
 * Map a successful tool execution to the lifecycle stage it pays.
 * Fails closed when ok is false or the tool is unknown.
 */
export function lifecycleStagePaidBySuccessfulTool(input: {
  toolName: string;
  ok: boolean;
}): ProjectLifecycleStageV1 | null {
  if (!input.ok) return null;
  const toolName = input.toolName.trim();
  if (!toolName) return null;
  if (STAGE_PAID_ACCEPTED_RESEARCH.has(toolName)) return "accepted_research";
  if (STAGE_PAID_LINEAR_HIERARCHY.has(toolName)) return "linear_hierarchy";
  if (STAGE_PAID_CODE_EXECUTION.has(toolName)) return "code_execution";
  if (STAGE_PAID_PRIVATE_GITHUB.has(toolName)) {
    return "private_github_publication";
  }
  return null;
}

function toPaidStageSet(
  paidStages: ReadonlySet<ProjectLifecycleStageV1> | readonly ProjectLifecycleStageV1[],
): ReadonlySet<ProjectLifecycleStageV1> {
  return paidStages instanceof Set ? paidStages : new Set(paidStages);
}

/** Delivery stages still in the plan that have not been paid yet. */
export function unpaidSetLooseDeliveryStages(input: {
  stages: readonly ProjectLifecycleStageV1[];
  paidStages: ReadonlySet<ProjectLifecycleStageV1> | readonly ProjectLifecycleStageV1[];
}): ProjectLifecycleStageV1[] {
  const paid = toPaidStageSet(input.paidStages);
  const planStages = new Set(input.stages);
  return SET_LOOSE_DELIVERY_STAGES.filter(
    (stage) => planStages.has(stage) && !paid.has(stage),
  );
}

export type SetLooseDeliveryProofsV1 = {
  acceptedResearchPublication?: boolean;
  linearIssueUrlOrId?: boolean;
  codeWorkspaceReadback?: boolean;
  githubPrivateRepoOrPrUrl?: boolean;
  noteReflectionWithMarkers?: boolean;
};

export type SetLooseDeliveryReceiptLikeV1 = {
  version?: number | null;
  id?: string | null;
  runId?: string | null;
  toolName?: string | null;
  operation?: string | null;
  path?: string | null;
  message?: string | null;
  output?: unknown;
  actionId?: string | null;
  payloadFingerprint?: string | null;
  grantId?: string | null;
  idempotencyKey?: string | null;
  providerRequestId?: string | null;
  startedAt?: string | null;
  committedAt?: string | null;
  commitKind?: string | null;
  readback?: {
    status?: string | null;
    checkedAt?: string | null;
    observedRevision?: string | null;
    observedFingerprint?: string | null;
  } | null;
  resource?: {
    system?: string | null;
    resourceType?: string | null;
    id?: string | null;
    identifier?: string | null;
    url?: string | null;
    workspaceId?: string | null;
    teamId?: string | null;
    projectId?: string | null;
    revision?: string | null;
  } | null;
};

function receiptTextBlob(receipt: SetLooseDeliveryReceiptLikeV1): string {
  const outputBlob =
    typeof receipt.output === "string"
      ? receipt.output
      : JSON.stringify(receipt.output ?? "");
  return [outputBlob, receipt.message ?? "", receipt.path ?? ""].join("\n");
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSha256(value: string | null): value is string {
  return Boolean(value && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function isIsoTimestamp(value: string | null): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function linearOperationPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "unknown"
  );
}

function hasProductionCreateOperationKey(
  idempotencyKey: string | null | undefined,
  runId: string | null | undefined,
): boolean {
  const normalizedRunId = typeof runId === "string" ? runId.trim() : "";
  if (!normalizedRunId || typeof idempotencyKey !== "string") return false;
  const parts = idempotencyKey.split(":");
  if (
    parts.length !== 6 ||
    parts[0] !== "linear" ||
    parts[1] !== "issue" ||
    parts[2] !== "create" ||
    parts[3] !== linearOperationPart(normalizedRunId) ||
    parts[5] !== "0"
  ) {
    return false;
  }
  const callToken = parts[4];
  return (
    Boolean(callToken) &&
    callToken === linearOperationPart(callToken) &&
    idempotencyKey ===
      `linear:issue:create:${linearOperationPart(normalizedRunId)}:${callToken}:0`
  );
}

function fieldsMatch(
  outer: Record<string, unknown>,
  nested: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => outer[key] === nested[key]);
}

function nestedProviderReceiptMatchesOuter(
  receipt: SetLooseDeliveryReceiptLikeV1,
  nested: Record<string, unknown> | null,
): boolean {
  if (!nested) return false;
  const outer = receipt as Record<string, unknown>;
  const outerResource = isRecordLike(receipt.resource) ? receipt.resource : null;
  const nestedResource = isRecordLike(nested.resource) ? nested.resource : null;
  const outerReadback = isRecordLike(receipt.readback) ? receipt.readback : null;
  const nestedReadback = isRecordLike(nested.readback) ? nested.readback : null;
  return Boolean(
    fieldsMatch(outer, nested, [
      "version",
      "id",
      "runId",
      "actionId",
      "toolName",
      "operation",
      "message",
      "payloadFingerprint",
      "grantId",
      "idempotencyKey",
      "providerRequestId",
      "startedAt",
      "committedAt",
      "commitKind",
    ]) &&
      outerResource &&
      nestedResource &&
      fieldsMatch(outerResource, nestedResource, [
        "system",
        "resourceType",
        "id",
        "identifier",
        "url",
        "workspaceId",
        "teamId",
        "projectId",
        "revision",
      ]) &&
      outerReadback &&
      nestedReadback &&
      fieldsMatch(outerReadback, nestedReadback, [
        "status",
        "checkedAt",
        "observedRevision",
        "observedFingerprint",
      ]),
  );
}

/**
 * Canonical research publication receipts intentionally retain the provider
 * action name (`linear_create_issue` / `linear_read_issue`). Restore the outer
 * composite proof only from its committed, verified, fingerprint-linked
 * publication result; a generic Linear create/read must never pay this stage.
 */
export function isCompletedAcceptedResearchPublicationReceipt(
  receipt: SetLooseDeliveryReceiptLikeV1,
): boolean {
  const output = isRecordLike(receipt.output) ? receipt.output : null;
  const issue = isRecordLike(output?.issue)
    ? (output.issue as Record<string, unknown>)
    : null;
  const note = isRecordLike(output?.note)
    ? (output.note as Record<string, unknown>)
    : null;
  const backlink = isRecordLike(output?.backlink)
    ? (output.backlink as Record<string, unknown>)
    : null;
  const nestedReceipt = isRecordLike(output?.receipt)
    ? (output.receipt as Record<string, unknown>)
    : null;
  const issueId = stringField(issue, "id");
  const issueIdentifier = stringField(issue, "identifier");
  const issueUrl = stringField(issue, "url");
  const issueUpdatedAt = stringField(issue, "updatedAt");
  const issueSnapshotHash = stringField(issue, "snapshotHash");
  const issueDescription = stringField(issue, "description");
  const issueTeam = isRecordLike(issue?.team)
    ? (issue.team as Record<string, unknown>)
    : null;
  const issueProject = isRecordLike(issue?.project)
    ? (issue.project as Record<string, unknown>)
    : null;
  const issueTeamId = stringField(issueTeam, "id");
  const issueProjectId = stringField(issueProject, "id");
  const receiptId = typeof receipt.id === "string" ? receipt.id.trim() : "";
  const receiptRunId =
    typeof receipt.runId === "string" ? receipt.runId.trim() : "";
  const receiptActionId =
    typeof receipt.actionId === "string" ? receipt.actionId.trim() : "";
  const receiptGrantId =
    typeof receipt.grantId === "string" ? receipt.grantId.trim() : "";
  const receiptMessage =
    typeof receipt.message === "string" ? receipt.message.trim() : "";
  const receiptPayloadFingerprint =
    typeof receipt.payloadFingerprint === "string"
      ? receipt.payloadFingerprint.trim()
      : null;
  const approvalFingerprint = stringField(output, "approvalFingerprint");
  const createdPublication =
    output?.publication === "created" &&
    receipt.toolName === "linear_create_issue" &&
    receipt.operation === "create" &&
    receipt.commitKind === "committed";
  const deduplicatedPublication =
    output?.publication === "deduplicated" &&
    receipt.toolName === "linear_read_issue" &&
    receipt.operation === "read" &&
    receipt.commitKind === "committed";

  if (
    output?.ok !== true ||
    output?.status !== "complete" ||
    (!createdPublication && !deduplicatedPublication) ||
    receipt.version !== 1 ||
    !receiptId ||
    !receiptRunId ||
    !receiptActionId ||
    !receiptGrantId ||
    !receiptMessage ||
    !isSha256(receiptPayloadFingerprint) ||
    !isIsoTimestamp(
      typeof receipt.startedAt === "string" ? receipt.startedAt : null,
    ) ||
    !isIsoTimestamp(
      typeof receipt.committedAt === "string" ? receipt.committedAt : null,
    ) ||
    Date.parse(receipt.committedAt!) < Date.parse(receipt.startedAt!) ||
    receipt.resource?.system !== "linear" ||
    receipt.resource?.resourceType !== "issue" ||
    receipt.readback?.status !== "verified" ||
    !isIsoTimestamp(
      typeof receipt.readback.checkedAt === "string"
        ? receipt.readback.checkedAt
        : null,
    ) ||
    !isSha256(
      typeof receipt.readback.observedFingerprint === "string"
        ? receipt.readback.observedFingerprint
        : null,
    ) ||
    !isSha256(approvalFingerprint) ||
    !issueId ||
    !issueIdentifier ||
    !issueUrl ||
    !issueTeamId ||
    !isIsoTimestamp(issueUpdatedAt) ||
    !isSha256(issueSnapshotHash) ||
    !issueDescription ||
    issue?.resourceType !== "issue" ||
    issue?.trashed !== false ||
    receipt.resource.id !== issueId ||
    receipt.resource.identifier !== issueIdentifier ||
    receipt.resource.url !== issueUrl ||
    receipt.resource.teamId !== issueTeamId ||
    (issueProjectId
      ? receipt.resource.projectId !== issueProjectId
      : Boolean(receipt.resource.projectId)) ||
    (receipt.resource.revision !== undefined &&
      receipt.resource.revision !== null &&
      receipt.resource.revision !== issueUpdatedAt) ||
    (!createdPublication &&
      receipt.readback.observedFingerprint !== issueSnapshotHash)
  ) {
    return false;
  }

  let artifact;
  let noteArtifact;
  let binding;
  let lineage;
  let workItem;
  try {
    artifact = parseAcceptedResearchArtifactV1(output.artifact);
    noteArtifact = parseAcceptedResearchArtifactV1(note?.artifact);
    binding = parseExternalWorkItemBindingV1(output.binding);
    lineage = parseWorkItemLineageV1(output.lineage);
    workItem = parseRenderedCompatibleWorkItemSpec(issueDescription).spec;
  } catch {
    return false;
  }

  const notePath = stringField(note, "path");
  const noteOperation = stringField(note, "operation");
  const noteBeforeSha256 = stringField(note, "beforeSha256");
  const noteAfterSha256 = stringField(note, "afterSha256");
  const backlinkPath = stringField(backlink, "path");
  const backlinkOperation = stringField(backlink, "operation");
  const backlinkBeforeSha256 = stringField(backlink, "beforeSha256");
  const backlinkAfterSha256 = stringField(backlink, "afterSha256");
  const lastLineageEvent = lineage.events[lineage.events.length - 1];
  const workItemArtifactFingerprint =
    workItem.schemaVersion === 2
      ? workItem.acceptedResearchArtifactFingerprint
      : null;
  const workItemVaultBindingKey =
    workItem.schemaVersion === 2 ? workItem.vaultBindingKey ?? null : null;
  const issueRevisionPreservesBinding =
    createdPublication
      ? binding.issueUpdatedAt === issueUpdatedAt
      : Number.isFinite(Date.parse(binding.issueUpdatedAt)) &&
        Date.parse(issueUpdatedAt!) >= Date.parse(binding.issueUpdatedAt);
  const originalPublicationNoteBinding =
    noteAfterSha256 === artifact.noteSha256 &&
    backlinkBeforeSha256 === noteAfterSha256;
  const completedCheckpointReplayNoteBinding =
    noteOperation === "no_op" &&
    noteBeforeSha256 === noteAfterSha256 &&
    noteAfterSha256 === backlinkAfterSha256 &&
    backlinkBeforeSha256 === artifact.noteSha256;

  if (
    notePath !== artifact.notePath ||
    stringField(note, "noteReceiptId") !== artifact.noteReceiptId ||
    noteArtifact.artifactFingerprint !== artifact.artifactFingerprint ||
    !isSha256(noteAfterSha256) ||
    !["create", "append", "no_op"].includes(noteOperation ?? "") ||
    (noteOperation === "no_op" && noteBeforeSha256 !== noteAfterSha256) ||
    backlinkPath !== artifact.notePath ||
    stringField(backlink, "issueUrl") !== issueUrl ||
    !isSha256(backlinkBeforeSha256) ||
    !isSha256(backlinkAfterSha256) ||
    (!originalPublicationNoteBinding &&
      !completedCheckpointReplayNoteBinding) ||
    !["append", "no_op"].includes(backlinkOperation ?? "") ||
    (backlinkOperation === "no_op" &&
      backlinkAfterSha256 !== backlinkBeforeSha256) ||
    binding.provider !== "linear" ||
    binding.originRunId !== artifact.originRunId ||
    binding.teamId !== issueTeamId ||
    binding.issueId !== issueId ||
    binding.issueIdentifier !== issueIdentifier ||
    binding.issueUrl !== issueUrl ||
    !issueRevisionPreservesBinding ||
    binding.acceptedResearchArtifactFingerprint !==
      artifact.artifactFingerprint ||
    workItem.schemaVersion !== 2 ||
    workItem.fingerprint !== binding.workItemFingerprint ||
    workItem.originRunId !== artifact.originRunId ||
    workItemArtifactFingerprint !== artifact.artifactFingerprint ||
    (workItem.executionClass === "vault"
      ? workItemVaultBindingKey !== artifact.vaultBindingKey
      : workItemVaultBindingKey !== null) ||
    lineage.originRunId !== artifact.originRunId ||
    lineage.executionClass !== workItem.executionClass ||
    lineage.workItemFingerprint !== workItem.fingerprint ||
    lineage.researchArtifactFingerprint !== artifact.artifactFingerprint ||
    lineage.externalWorkItemBindingFingerprint !==
      binding.bindingFingerprint ||
    (lineage.repositoryKey ?? null) !== (workItem.repositoryKey ?? null) ||
    (lineage.vaultBindingKey ?? null) !==
      (workItem.vaultBindingKey ?? null) ||
    lastLineageEvent?.state !== "linear_verified" ||
    lastLineageEvent.evidenceFingerprint !== binding.bindingFingerprint
  ) {
    return false;
  }

  if (createdPublication) {
    return Boolean(
      hasProductionCreateOperationKey(receipt.idempotencyKey, receiptRunId) &&
        nestedProviderReceiptMatchesOuter(receipt, nestedReceipt) &&
        receipt.readback?.observedRevision ===
          receipt.readback?.observedFingerprint &&
        Date.parse(binding.verifiedAt) >= Date.parse(receipt.committedAt!) &&
        lastLineageEvent.receiptId === receiptId,
    );
  }

  return Boolean(
    receipt.idempotencyKey ===
      `research-publication:${workItem.fingerprint}` &&
      receipt.grantId === "linear-deduplicated-readback" &&
      output.receipt === null &&
      receiptPayloadFingerprint === approvalFingerprint &&
      receipt.resource.revision === issueUpdatedAt &&
      receipt.readback?.observedRevision === issueUpdatedAt,
  );
}

/** Exact cross-system markers required before final set-loose note reflection pays. */
export function hasCompleteSetLooseNoteReflectionProof(text: string): boolean {
  return (
    /\b(?:FLOW_REAL|COMPOUND|BYOK_AUTONOMOUS)_[A-Za-z0-9_]+\b/u.test(text) &&
    /https:\/\/linear\.app\/[^\s)\]"'<>]+/iu.test(text) &&
    /https:\/\/github\.com\/[^\s)\]"'<>]+\/pull\/\d+/iu.test(text)
  );
}

/**
 * Apply one successful tool result onto set-loose delivery proofs. Shared by
 * the live tool loop and Continue resume seeding so proofs never reset empty.
 */
export function applySetLooseDeliveryProofFromSuccessfulTool(input: {
  toolName: string;
  output?: unknown;
  argumentsText?: string;
  proofs: SetLooseDeliveryProofsV1;
}): SetLooseDeliveryProofsV1 {
  const toolName = input.toolName.trim();
  const outputBlob =
    typeof input.output === "string"
      ? input.output
      : JSON.stringify(input.output ?? "");
  const combinedText = `${outputBlob}\n${input.argumentsText ?? ""}`;
  const outputRecord = isRecordLike(input.output) ? input.output : null;
  const next: SetLooseDeliveryProofsV1 = { ...input.proofs };

  if (toolName === "publish_research_to_linear") {
    next.acceptedResearchPublication = true;
  }
  if (
    toolName === "linear_create_issue" ||
    toolName === "linear_get_issue" ||
    toolName === "publish_research_project_to_linear" ||
    /https:\/\/linear\.app\//iu.test(combinedText) ||
    Boolean(
      stringField(outputRecord, "issueUrl") ||
        stringField(outputRecord, "issueId") ||
        (stringField(outputRecord, "id") && toolName.startsWith("linear_")),
    )
  ) {
    next.linearIssueUrlOrId = true;
  }
  if (toolName === "code_commit_verified") {
    // Code delivery requires a verified commit, not a mere workspace read.
    next.codeWorkspaceReadback = true;
  }
  // Draft PR URL evidence only — create-only repo and publish-without-PR must not pay.
  const pullRequestUrl =
    stringField(outputRecord, "pullRequestUrl") ||
    stringField(outputRecord, "htmlUrl") ||
    (isRecordLike(outputRecord?.pullRequest)
      ? stringField(
          outputRecord.pullRequest as Record<string, unknown>,
          "htmlUrl",
        ) ||
        stringField(
          outputRecord.pullRequest as Record<string, unknown>,
          "url",
        )
      : null);
  const hasDraftPrUrl =
    /https:\/\/github\.com\/[^\s)\]"'<>]+\/pull\/\d+/iu.test(combinedText) ||
    Boolean(
      pullRequestUrl &&
        /https:\/\/github\.com\/[^\s)\]"'<>]+\/pull\/\d+/iu.test(pullRequestUrl),
    );
  if (hasDraftPrUrl) {
    next.githubPrivateRepoOrPrUrl = true;
  }
  const hasFinalizedProjectReflection =
    toolName === "publish_verified_code_to_github" &&
    outputRecord?.status === "finalized" &&
    Boolean(stringField(outputRecord, "obsidianReceiptId")) &&
    hasDraftPrUrl;
  if (hasFinalizedProjectReflection) {
    // The exact publication finalizer already appended and verified the
    // accepted-research note reflection. Do not synthesize a second legacy
    // "Flow real reflection" section merely to pay this delivery proof.
    next.noteReflectionWithMarkers = true;
  }
  if (
    (toolName === "append_to_current_file" ||
      toolName === "replace_current_file") &&
    hasCompleteSetLooseNoteReflectionProof(combinedText)
  ) {
    next.noteReflectionWithMarkers = true;
  }
  return next;
}

/**
 * Rebuild set-loose paid stages + delivery proofs from durable receipts so a
 * Continue segment does not forget Linear/code/GitHub/note proof already earned.
 */
export function seedSetLooseDeliveryStateFromReceipts(
  receipts: readonly SetLooseDeliveryReceiptLikeV1[],
): {
  paidStages: ProjectLifecycleStageV1[];
  proofs: SetLooseDeliveryProofsV1;
} {
  const paidStages = new Set<ProjectLifecycleStageV1>();
  let proofs: SetLooseDeliveryProofsV1 = {};
  for (const receipt of receipts) {
    const toolName =
      typeof receipt.toolName === "string" ? receipt.toolName.trim() : "";
    if (!toolName) continue;
    if (isCompletedAcceptedResearchPublicationReceipt(receipt)) {
      paidStages.add("accepted_research");
      paidStages.add("linear_hierarchy");
      proofs.acceptedResearchPublication = true;
      proofs.linearIssueUrlOrId = true;
    }
    const paid = lifecycleStagePaidBySuccessfulTool({
      toolName,
      ok: true,
    });
    if (paid) paidStages.add(paid);
    const resourceUrl =
      typeof receipt.resource?.url === "string" ? receipt.resource.url : "";
    const resourceId =
      typeof receipt.resource?.id === "string" ? receipt.resource.id : "";
    const resourceSystem =
      typeof receipt.resource?.system === "string"
        ? receipt.resource.system
        : "";
    proofs = applySetLooseDeliveryProofFromSuccessfulTool({
      toolName,
      output: receipt.output,
      argumentsText: [
        receiptTextBlob(receipt),
        resourceUrl,
        resourceId,
        resourceSystem === "linear" ? `linear:${resourceId}` : "",
      ].join("\n"),
      proofs,
    });
    if (
      resourceSystem === "linear" &&
      (resourceId || /https:\/\/linear\.app\//iu.test(resourceUrl))
    ) {
      proofs.linearIssueUrlOrId = true;
    }
  }
  return {
    paidStages: [...paidStages],
    proofs,
  };
}

/**
 * Compound delivery gate: Linear + code + GitHub (+ note reflection) when those
 * stages are in the plan. Never requires reconciliation_cleanup.
 */
export function setLooseDeliveryComplete(input: {
  stages: readonly ProjectLifecycleStageV1[];
  proofs: SetLooseDeliveryProofsV1;
}): { complete: boolean; unpaid: string[]; reason: string } {
  const planStages = new Set(input.stages);
  const unpaid: string[] = [];

  if (
    planStages.has("accepted_research") &&
    input.proofs.acceptedResearchPublication !== true
  ) {
    unpaid.push("accepted_research");
  }
  if (
    planStages.has("linear_hierarchy") &&
    input.proofs.linearIssueUrlOrId !== true
  ) {
    unpaid.push("linear_hierarchy");
  }
  if (
    planStages.has("code_execution") &&
    input.proofs.codeWorkspaceReadback !== true
  ) {
    unpaid.push("code_execution");
  }
  if (
    planStages.has("private_github_publication") &&
    input.proofs.githubPrivateRepoOrPrUrl !== true
  ) {
    unpaid.push("private_github_publication");
  }

  // This proof requires a draft-PR URL. Charging it to a bounded
  // Research -> Linear phase makes that phase structurally impossible to
  // complete because GitHub is intentionally absent.
  const requiresNoteReflection =
    planStages.has("private_github_publication");
  if (
    requiresNoteReflection &&
    input.proofs.noteReflectionWithMarkers !== true
  ) {
    unpaid.push("note_reflection");
  }

  if (unpaid.length === 0) {
    return {
      complete: true,
      unpaid: [],
      reason: "all_delivery_proofs_present",
    };
  }
  return {
    complete: false,
    unpaid,
    reason: `missing_delivery_proofs:${unpaid.join(",")}`,
  };
}

/**
 * Map unpaid delivery proof codes to Bound/Soft tools so auto-continue can
 * gate set-loose Bound without inventing Chat grants.
 */
export function pendingToolsForUnpaidSetLooseDelivery(
  unpaid: readonly string[],
): string[] {
  const tools: string[] = [];
  for (const item of unpaid) {
    switch (item) {
      case "accepted_research":
        tools.push(
          ...toolsAllowedForLifecycleStage("accepted_research"),
          "read_template",
          "list_templates",
          "linear_get_connection_context",
        );
        break;
      case "linear_hierarchy":
        tools.push(
          "linear_get_connection_context",
          "linear_create_issue",
          "linear_get_issue",
          "linear_search_issues",
        );
        break;
      case "code_execution":
        // Full Soft-union code ladder (sandbox → workspace → validate → commit).
        // Narrow validate/commit-only lists left code_sandbox_status blocked by
        // MissionGraph before any workspace existed.
        tools.push(...CODE_EXECUTION_TOOL_ALLOW);
        break;
      case "private_github_publication":
        tools.push(
          "github_create_private_repository",
          "publish_verified_code_to_github",
        );
        break;
      case "note_reflection":
        tools.push("append_to_current_file");
        break;
      default:
        break;
    }
  }
  return [...new Set(tools)];
}

/**
 * Authoritative Soft-union tool names for one set-loose model turn (and the
 * mid-response frontier refresh). Unions stage Soft-union + unpaid delivery
 * tools + Soft companions, then re-applies GitHub/commit ladders so unpaid
 * pending bleed cannot open publish before code is paid or commit before a
 * passed fast repair cycle.
 */
export function toolsOfferedForSetLooseTurn(input: {
  stages: readonly ProjectLifecycleStageV1[];
  currentStage: ProjectLifecycleStageV1 | null;
  passedFastRepairCycle: boolean;
  codeDeliveryPaid: boolean;
  unpaidDeliveryKeys?: readonly string[];
}): string[] {
  const unpaidKeys = input.unpaidDeliveryKeys ?? [];
  const earliestUnpaid = [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
    "note_reflection",
  ].find((key) => unpaidKeys.includes(key));
  const unpaidTools = earliestUnpaid
    ? pendingToolsForUnpaidSetLooseDelivery([earliestUnpaid])
    : [];
  const base =
    earliestUnpaid === "code_execution"
      ? toolsOfferedForSetLooseCodeStage({
          stages: input.stages,
          currentStage: "code_execution",
          passedFastRepairCycle: input.passedFastRepairCycle,
          codeDeliveryPaid: false,
        })
      : earliestUnpaid === undefined
        ? toolsOfferedForSetLoosePipeline({
            stages: input.stages,
            currentStage: input.currentStage,
            passedFastRepairCycle: input.passedFastRepairCycle,
            codeDeliveryPaid: input.codeDeliveryPaid,
          })
        : [];
  const offered = new Set<string>([
    ...base,
    ...unpaidTools,
    ...(SET_LOOSE_STAGE_SOFT_COMPANIONS as readonly string[]),
  ]);
  if (earliestUnpaid !== "code_execution") {
    for (const tool of CODE_EXECUTION_TOOL_ALLOW) {
      offered.delete(tool);
    }
  }
  if (earliestUnpaid !== "private_github_publication") {
    for (const tool of GITHUB_PUBLICATION_TOOLS) {
      offered.delete(tool);
    }
  }
  if (
    earliestUnpaid !== "accepted_research" &&
    earliestUnpaid !== "linear_hierarchy"
  ) {
    for (const tool of toolsAllowedForLifecycleStage("linear_hierarchy")) {
      offered.delete(tool);
    }
  }
  return filterSetLooseCodeLadderUntilPassedFast({
    offeredToolNames: [...offered],
    passedFastRepairCycle: input.passedFastRepairCycle,
  });
}

const SET_LOOSE_SOFT_CURRENT_NOTE_WRITES = new Set<string>([
  "append_to_current_file",
  "replace_current_file",
]);

/**
 * True when MissionGraph still has a non-terminal `read_template` Soft gate
 * (typically `tool-01-read_template` before Linear create).
 */
export function missionGraphHasIncompleteReadTemplateNode(
  graph:
    | {
        nodes: Readonly<
          Record<
            string,
            {
              status?: string | null;
              allowedTools?: readonly string[] | null;
            }
          >
        >;
      }
    | null
    | undefined,
): boolean {
  if (!graph?.nodes) return false;
  return Object.values(graph.nodes).some((node) => {
    const tools = node.allowedTools ?? [];
    if (!tools.includes("read_template")) return false;
    const status = String(node.status ?? "");
    return (
      status !== "complete" &&
      status !== "cancelled" &&
      status !== "skipped"
    );
  });
}

/**
 * Soft current-note writes may bypass legacy mission-plan active-task gating
 * only after every external delivery proof is paid and note reflection is the
 * sole remaining obligation. This prevents an early append from bypassing a
 * still-unpaid research, Linear, code, or GitHub frontier.
 */
export function setLooseSoftWriteBypassesPlanDependency(input: {
  toolName: string;
  setLooseEnabled: boolean;
  unpaidDeliveryKeys: readonly string[];
  successfulToolNames?: readonly string[];
  incompleteReadTemplateNode?: boolean;
}): boolean {
  if (!input.setLooseEnabled) return false;
  const toolName = input.toolName.trim();
  if (!toolName || !SET_LOOSE_SOFT_CURRENT_NOTE_WRITES.has(toolName)) {
    return false;
  }
  if (
    !(SET_LOOSE_STAGE_SOFT_COMPANIONS as readonly string[]).includes(toolName)
  ) {
    return false;
  }
  return (
    input.unpaidDeliveryKeys.length === 1 &&
    input.unpaidDeliveryKeys[0] === "note_reflection"
  );
}

/** After this many model turns with GitHub Soft-union tools offered but unused. */
export const SET_LOOSE_GITHUB_STALL_STEP_THRESHOLD = 2;

/** Model tools that do not advance unpaid GitHub delivery. */
export const SET_LOOSE_WORKSPACE_STALL_TOOL_NAMES = new Set<string>([
  "code_workspace_create",
  "code_workspace_read",
  "code_workspace_status",
  "code_workspace_list",
  "code_workspace_stat",
  "code_workspace_search",
]);

export type SetLooseHostProgressDecisionV1 =
  | { kind: "none"; reason: string }
  | {
      kind: "soft_acknowledge_workspace_exists";
      workspaceId: string;
    }
  | { kind: "host_github_create"; profileKey: string }
  | { kind: "host_github_publish_draft"; profileKey: string }
  | {
      kind: "healable_github_publish_blocked";
      profileKey: string;
      message: string;
    }
  | { kind: "host_note_reflection" };

/** True when publish failed in a way Soft-union must stop retrying. */
export function isSetLooseGithubPublishHealableBlock(message: string): boolean {
  const text = message.toLowerCase();
  return (
    /receipt id collided/u.test(text) ||
    /draft pull request url/u.test(text) ||
    /github_publication_draft_pr_missing/u.test(text) ||
    /contents:write/u.test(text) ||
    /git push authentication failed/u.test(text) ||
    /authentication failed/u.test(text) ||
    /lacks contents push/u.test(text) ||
    /create-capable rest token is not enough/u.test(text)
  );
}

/**
 * True when create failed only because the durable workspace binding already
 * exists — not a delivery failure; Continue must not treat it as required_tool_failure.
 */
export function shouldSoftAcknowledgeWorkspaceExists(input: {
  toolName: string;
  errorCode?: string | null;
  durableWorkspaceId: string | null | undefined;
}): boolean {
  return (
    input.toolName.trim() === "code_workspace_create" &&
    input.errorCode === "workspace_exists" &&
    Boolean(input.durableWorkspaceId?.trim())
  );
}

/** True when durable receipts already prove private-repo create succeeded. */
export function hasSetLooseGithubCreateReceipt(
  receipts: readonly SetLooseDeliveryReceiptLikeV1[],
): boolean {
  for (const receipt of receipts) {
    const toolName =
      typeof receipt.toolName === "string" ? receipt.toolName.trim() : "";
    if (toolName === "github_create_private_repository") {
      return true;
    }
    const blob = receiptTextBlob(receipt);
    const resourceUrl =
      typeof receipt.resource?.url === "string" ? receipt.resource.url : "";
    const combined = `${blob}\n${resourceUrl}`;
    if (
      /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/iu.test(
        combined,
      ) &&
      !/\/pull\/\d+/iu.test(combined) &&
      (toolName.startsWith("github_") ||
        toolName === "publish_verified_code_to_github" ||
        receipt.resource?.system === "github")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Host-owned set-loose progress when the model stalls on workspace create/read
 * (or leaves GitHub Soft-union tools unused) while delivery proofs remain unpaid.
 */
export function decideSetLooseHostProgressV1(input: {
  unpaidDeliveryKeys: readonly string[];
  profileKey: string | null;
  durableWorkspaceId: string | null;
  githubCreatePaid: boolean;
  githubToolsOffered: boolean;
  stepsSinceGithubOfferedUnused: number;
  sawWorkspaceExistsError: boolean;
  recentModelToolNames?: readonly string[];
  stallStepThreshold?: number;
  /** When set, stop host/model publish loops and surface a healable next action. */
  githubPublishBlockReason?: string | null;
}): SetLooseHostProgressDecisionV1 {
  const unpaid = input.unpaidDeliveryKeys.map((item) => item.trim()).filter(Boolean);
  if (unpaid.length === 0) {
    return { kind: "none", reason: "delivery_complete" };
  }
  if (unpaid.every((item) => item === "note_reflection")) {
    return { kind: "host_note_reflection" };
  }

  const githubUnpaid = unpaid.includes("private_github_publication");
  const codeUnpaid = unpaid.includes("code_execution");
  const profileKey = input.profileKey?.trim() || "";
  const blockReason = input.githubPublishBlockReason?.trim() || "";
  // Soft-union may offer GitHub when code stage is paid in-session even if
  // Continue lag cleared codeWorkspaceReadback. Prefer Soft-union's offer as
  // the host-progress authority so we do not strand on unused GitHub tools.
  const codePaidForHostProgress = !codeUnpaid || input.githubToolsOffered;
  if (githubUnpaid && codePaidForHostProgress && profileKey && blockReason) {
    return {
      kind: "healable_github_publish_blocked",
      profileKey,
      message: blockReason.slice(0, 1_200),
    };
  }
  const threshold =
    typeof input.stallStepThreshold === "number" &&
    Number.isFinite(input.stallStepThreshold)
      ? Math.max(1, Math.floor(input.stallStepThreshold))
      : SET_LOOSE_GITHUB_STALL_STEP_THRESHOLD;
  const recent = (input.recentModelToolNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const recentOnlyWorkspaceStall =
    recent.length > 0 &&
    recent.every((name) => SET_LOOSE_WORKSPACE_STALL_TOOL_NAMES.has(name));
  const stalled =
    input.sawWorkspaceExistsError ||
    (input.githubToolsOffered &&
      input.stepsSinceGithubOfferedUnused >= threshold) ||
    recentOnlyWorkspaceStall;

  // Never host-drive GitHub before Soft-union itself offers those tools
  // (or verified code delivery proof is paid).
  if (githubUnpaid && codePaidForHostProgress && profileKey && stalled) {
    if (!input.githubCreatePaid) {
      return { kind: "host_github_create", profileKey };
    }
    return { kind: "host_github_publish_draft", profileKey };
  }

  if (
    input.sawWorkspaceExistsError &&
    input.durableWorkspaceId?.trim()
  ) {
    return {
      kind: "soft_acknowledge_workspace_exists",
      workspaceId: input.durableWorkspaceId.trim(),
    };
  }

  return { kind: "none", reason: "no_stall_or_missing_profile" };
}

/**
 * Continue-segment system card so the model does not recreate an already-bound
 * workspace and prefers unpaid GitHub Soft-union tools.
 */
export function formatSetLooseResumeBindingCard(input: {
  proofs: SetLooseDeliveryProofsV1;
  unpaidDeliveryKeys: readonly string[];
  durableWorkspaceId: string | null;
  passedFastRepairCycle: boolean;
  profileKey: string | null;
}): string {
  const unpaid = input.unpaidDeliveryKeys.filter(Boolean);
  const lines = [
    "SET-LOOSE CONTINUE BINDING (host-restored; do not redo paid work):",
    input.proofs.linearIssueUrlOrId
      ? "- Linear delivery proof is already paid."
      : null,
    input.proofs.codeWorkspaceReadback
      ? "- Verified code commit proof is already paid."
      : null,
    input.passedFastRepairCycle
      ? "- A passed fast repair cycle is already recorded."
      : null,
    input.durableWorkspaceId
      ? `- Durable workspace binding already exists: ${input.durableWorkspaceId}. Do NOT call code_workspace_create again (workspace_exists). Use code_workspace_read / validate / commit only if code is still unpaid.`
      : null,
    input.profileKey
      ? `- Trusted repository profile key: ${input.profileKey}.`
      : null,
    unpaid.length > 0
      ? `- Unpaid delivery proofs: ${unpaid.join(", ")}.`
      : "- All delivery proofs are paid.",
    unpaid.includes("private_github_publication")
      ? "- Prefer github_create_private_repository then publish_verified_code_to_github action=publish_draft next."
      : null,
    unpaid.includes("note_reflection") &&
    !unpaid.includes("private_github_publication")
      ? "- Prefer append_to_current_file for note reflection next."
      : null,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}
