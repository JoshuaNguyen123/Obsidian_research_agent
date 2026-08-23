import {
  FINALIZATION_RESERVE_STEPS,
  MAX_AGENT_STEPS,
} from "../tools/constants";

export type RunBudgetRoute =
  | "instant_local"
  | "direct_writeback"
  | "prefetched_vault_answer"
  | "prefetched_vault_writeback"
  | "single_model_answer"
  | "single_model_writeback"
  | "tool_required"
  | "grounded_workflow";

export type RunBudgetSlowPathReason =
  | "none"
  | "needs_current_note"
  | "needs_web_sources"
  | "needs_vault_context"
  | "needs_graph_context"
  | "needs_word_count"
  | "needs_edit_or_replace"
  | "needs_model_planning";

export interface RunBudgetProfile {
  route: RunBudgetRoute;
  defaultToolSteps: number;
  expectedTimeClass: "quick" | "normal" | "long";
  allowsAutoFollowups: boolean;
}

export interface EstimateLoopBudgetInput {
  route: RunBudgetRoute;
  configuredMaxSteps?: number | null;
  expectedTimeClass?: "quick" | "normal" | "long";
  slowPathReason?: RunBudgetSlowPathReason;
  requestedSteps?: number;
  artifactLike?: boolean;
}

export interface RouteBudgetProfile {
  route: RunBudgetRoute;
  maxSteps: number;
  toolSteps: number;
  finalizationReserve: number;
  reason: string;
  expectedTools: string[];
}

export interface RouteBudgetInput {
  mission: string;
  route: RunBudgetRoute;
  requiresWeb: boolean;
  requiresVaultContext: boolean;
  requiresWrite: boolean;
  requiresVerification: boolean;
  explicitDeepResearch: boolean;
  configuredMaxSteps?: number | null;
  expectedTools?: string[];
}

export function buildRouteBudgetProfile({
  mission,
  route,
  requiresWeb,
  requiresVaultContext,
  requiresWrite,
  requiresVerification,
  explicitDeepResearch,
  configuredMaxSteps,
  expectedTools = [],
}: RouteBudgetInput): RouteBudgetProfile {
  const cap = resolveConfiguredMaxAgentSteps(configuredMaxSteps);
  const finalizationReserve = FINALIZATION_RESERVE_STEPS;
  const inferredTools = dedupeStrings([
    ...expectedTools,
    ...(requiresWeb ? ["web_search", "web_fetch"] : []),
    ...(requiresVaultContext ? ["semantic_search_notes", "read_file"] : []),
    ...(requiresWrite ? ["write_tool"] : []),
    ...(requiresVerification ? ["verification"] : []),
  ]);
  if (route === "instant_local") {
    return makeProfile(route, 0, 0, 0, "instant_local_no_model_loop", inferredTools);
  }
  if (
    route === "direct_writeback" ||
    route === "prefetched_vault_answer" ||
    route === "prefetched_vault_writeback"
  ) {
    return makeProfile(route, 1, 0, 1, "single_synthesis_after_prefetch", inferredTools);
  }
  if (
    explicitDeepResearch ||
    /\b(?:deep\s+research|long\s+research|in[-\s]?depth\s+research|comprehensive\s+research|multi[-\s]?source\s+(?:research|review|comparison))\b/i.test(
      mission,
    )
  ) {
    return makeProfile(
      route,
      cap,
      Math.max(0, cap - finalizationReserve),
      finalizationReserve,
      "explicit_deep_or_long_research",
      inferredTools,
    );
  }
  const toolSteps = Math.max(
    route === "single_model_answer" || route === "single_model_writeback" ? 0 : 2,
    inferredTools.filter((tool) => tool !== "verification").length,
    requiresVerification ? 1 : 0,
  );
  const maxSteps = Math.min(cap, Math.max(1, toolSteps + finalizationReserve));
  return makeProfile(
    route,
    maxSteps,
    Math.min(toolSteps, Math.max(0, maxSteps - finalizationReserve)),
    finalizationReserve,
    "route_specific_budget",
    inferredTools,
  );
}

export function getRunBudgetProfile(route: RunBudgetRoute): RunBudgetProfile {
  switch (route) {
    case "instant_local":
      return {
        route,
        defaultToolSteps: 0,
        expectedTimeClass: "quick",
        allowsAutoFollowups: false,
      };
    case "direct_writeback":
    case "prefetched_vault_answer":
    case "prefetched_vault_writeback":
      return {
        route,
        defaultToolSteps: 0,
        expectedTimeClass: "quick",
        allowsAutoFollowups: false,
      };
    case "single_model_answer":
    case "single_model_writeback":
      return {
        route,
        defaultToolSteps: 1,
        expectedTimeClass: "quick",
        allowsAutoFollowups: false,
      };
    case "tool_required":
      return {
        route,
        defaultToolSteps: 2,
        expectedTimeClass: "normal",
        allowsAutoFollowups: true,
      };
    case "grounded_workflow":
    default:
      return {
        route,
        defaultToolSteps: MAX_AGENT_STEPS - FINALIZATION_RESERVE_STEPS,
        expectedTimeClass: "long",
        allowsAutoFollowups: true,
      };
  }
}

export function estimateLoopBudget({
  route,
  configuredMaxSteps,
  expectedTimeClass = "normal",
  slowPathReason = "none",
  requestedSteps,
  artifactLike = false,
}: EstimateLoopBudgetInput): number {
  const cap = resolveConfiguredMaxAgentSteps(configuredMaxSteps);
  const estimated = estimateUncappedLoopBudget({
    route,
    expectedTimeClass,
    slowPathReason,
    requestedSteps,
    artifactLike,
  });

  return estimated <= 0 ? 0 : Math.min(estimated, cap);
}

/**
 * Whether the user narrowed the step budget for this mission, and to what.
 *
 * `maxAgentSteps` is the system-wide hard cap on a run, not a per-mission
 * budget. Both safety-ceiling presets pin it to `MAX_AGENT_STEPS`
 * (`safetyCeiling.ts:38,52`), `settingsNormalize` defaults it to the same
 * number, and `resolveConfiguredMaxAgentSteps` materializes that value when
 * the setting is missing entirely. At the cap, "the user never touched it" and
 * "the user chose the maximum" are therefore not merely indistinguishable --
 * they mean the same thing, because the maximum *is* no narrowing.
 *
 * This is the one place that reads that intent, so everything downstream
 * receives a real `number | null` and never reconstructs it. Feeding the raw
 * number through instead is what made `compose` (6/4) and `grounded_research`
 * (16/12) stop constraining anything: every profile resolved to the cap, and a
 * short composed note was budgeted 100 model calls.
 *
 * A value below the cap is a deliberate narrowing and is returned as-is, so it
 * still binds in either direction exactly as the ceiling math intends.
 *
 * Known limitation, recorded rather than hidden: a user who deliberately types
 * the cap into the settings box is read as "not narrowed". Separating those
 * would need the settings schema to represent "unset" distinctly from "the
 * cap", and today `AgentSettings.maxAgentSteps` is a required number defaulted
 * to the cap -- so that intent was never recorded and cannot be recovered here.
 */
export function resolveConfiguredAgentStepSettingV1(
  rawMaxSteps?: number | null,
): number | null {
  if (
    typeof rawMaxSteps !== "number" ||
    !Number.isFinite(rawMaxSteps) ||
    rawMaxSteps <= 0
  ) {
    return null;
  }
  const configured = Math.max(1, Math.trunc(rawMaxSteps));
  return configured >= MAX_AGENT_STEPS ? null : configured;
}

export function resolveConfiguredMaxAgentSteps(
  rawMaxSteps?: number | null,
): number {
  const configured = resolveConfiguredAgentStepSettingV1(rawMaxSteps);
  return configured === null
    ? MAX_AGENT_STEPS
    : Math.min(MAX_AGENT_STEPS, configured);
}

function estimateUncappedLoopBudget({
  route,
  expectedTimeClass,
  slowPathReason,
  requestedSteps,
  artifactLike,
}: {
  route: RunBudgetRoute;
  expectedTimeClass: "quick" | "normal" | "long";
  slowPathReason: RunBudgetSlowPathReason;
  requestedSteps?: number;
  artifactLike: boolean;
}): number {
  if (requestedSteps !== undefined) {
    return Math.max(0, Math.trunc(requestedSteps));
  }

  if (route === "instant_local") {
    return 0;
  }

  if (
    route === "direct_writeback" ||
    route === "prefetched_vault_answer" ||
    route === "prefetched_vault_writeback"
  ) {
    return 1;
  }

  if (route === "grounded_workflow" || artifactLike) {
    return MAX_AGENT_STEPS;
  }

  if (slowPathReason === "needs_edit_or_replace") {
    return 3;
  }

  if (slowPathReason === "needs_word_count") {
    return 2;
  }

  if (expectedTimeClass === "long") {
    return MAX_AGENT_STEPS;
  }

  if (expectedTimeClass === "normal") {
    return 3;
  }

  return 2;
}

function makeProfile(
  route: RunBudgetRoute,
  maxSteps: number,
  toolSteps: number,
  finalizationReserve: number,
  reason: string,
  expectedTools: string[],
): RouteBudgetProfile {
  return {
    route,
    maxSteps,
    toolSteps,
    finalizationReserve,
    reason,
    expectedTools: dedupeStrings(expectedTools),
  };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
