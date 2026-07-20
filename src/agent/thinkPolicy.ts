import type { AgentSettings } from "../settings";
import type { ModelCallPhase, ModelThink } from "../model/types";

export type ThinkCallRoute =
  | "instant_local"
  | "direct_writeback"
  | "grounded_workflow"
  | "tool_required"
  | "prefetched_vault_answer"
  | "prefetched_vault_writeback"
  | "single_model_answer"
  | "single_model_writeback";

export type ThinkProfile =
  | "gpt_oss_levels"
  | "deepseek_v4_modes"
  | "bool_or_levels"
  | "unknown";

export type ThinkCallRole =
  | "lead"
  | "researcher"
  | "router"
  | "planner"
  | "writeback";

const BOOL_OR_LEVELS_PREFIXES = [
  "qwen3",
  "qwen3.5",
  "qwen3.6",
  "gemma4",
  "glm-5",
  "minimax-m",
  "nemotron",
  "kimi-k2",
  "deepseek-r1",
  "deepseek-v3",
  "mistral-medium",
  "laguna",
  "lfm2",
  "north-mini",
  "gemini-3",
] as const;

const THINK_NOTCHES = [
  "off",
  "false",
  "low",
  "medium",
  "high",
  "max",
] as const;

type ThinkNotch = (typeof THINK_NOTCHES)[number];

export function resolveThinkProfile(model: string): ThinkProfile {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.startsWith("gpt-oss")) {
    return "gpt_oss_levels";
  }
  if (normalized.startsWith("deepseek-v4")) {
    return "deepseek_v4_modes";
  }
  if (matchesBoolOrLevelsPrefix(normalized)) {
    return "bool_or_levels";
  }
  return "unknown";
}

export function matchesBoolOrLevelsPrefix(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return BOOL_OR_LEVELS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function coerceThinkForModel(
  model: string,
  desired: ModelThink | undefined | "off",
): ModelThink | undefined {
  const profile = resolveThinkProfile(model);

  switch (profile) {
    case "gpt_oss_levels":
      return coerceGptOssLevels(desired);
    case "deepseek_v4_modes":
      return coerceDeepseekV4Modes(desired);
    case "bool_or_levels":
      return coerceBoolOrLevels(desired);
    case "unknown":
      return coerceUnknownThink(desired);
  }
}

export function resolveThinkingMode(
  settings: AgentSettings | undefined,
): ModelThink | undefined {
  const model = settings?.model?.trim().toLowerCase() ?? "";
  const desired = resolveSettingsThinkDesired(settings, model);
  return coerceThinkForModel(model, desired);
}

export interface ResolveThinkForCallInput {
  role: ThinkCallRole;
  phase?: ModelCallPhase;
  route?: ThinkCallRoute;
  settings?: AgentSettings;
  model?: string;
  expectedTimeClass?: "quick" | "normal" | "long";
}

export function resolveThinkForCall(
  input: ResolveThinkForCallInput,
): ModelThink | undefined {
  const model = (input.model ?? input.settings?.model ?? "").trim().toLowerCase();
  const effectiveRole = resolveEffectiveThinkRole(input);
  const route = input.route;
  const expectedTimeClass = input.expectedTimeClass ?? "normal";
  const settings = input.settings;

  let desired: ModelThink | undefined | "off";

  if (
    effectiveRole === "router" ||
    effectiveRole === "planner" ||
    effectiveRole === "writeback"
  ) {
    desired = "off";
  } else if (effectiveRole === "researcher") {
    desired = "low";
  } else if (effectiveRole === "lead") {
    if (route === "instant_local" || route === "direct_writeback") {
      desired = "off";
    } else if (route === "grounded_workflow" || route === "tool_required") {
      desired = resolveSettingsThinkDesired(settings, model);
    } else if (expectedTimeClass === "long") {
      desired = bumpThinkForLongResearch(
        resolveSettingsThinkDesired(settings, model),
        settings,
        model,
      );
    } else {
      desired = resolveSettingsThinkDesired(settings, model);
    }
  } else {
    desired = resolveSettingsThinkDesired(settings, model);
  }

  return coerceThinkForModel(model, desired);
}

function resolveEffectiveThinkRole(input: ResolveThinkForCallInput): ThinkCallRole {
  switch (input.phase) {
    case "router":
      return "router";
    case "graph_planner":
      return "planner";
    case "streaming":
    case "finalizer":
      return "writeback";
    default:
      return input.role;
  }
}

function resolveSettingsThinkDesired(
  settings: AgentSettings | undefined,
  model: string,
): ModelThink | undefined | "off" {
  const mode = settings?.thinkingMode ?? "auto";

  if (mode === "off") {
    return "off";
  }

  if (mode !== "auto") {
    return mode;
  }

  return resolveAutoThinkDefault(model);
}

function resolveAutoThinkDefault(model: string): ModelThink | undefined {
  if (!model) {
    return undefined;
  }

  if (model.startsWith("gpt-oss")) {
    return "medium";
  }

  if (model.startsWith("deepseek-v4")) {
    return "high";
  }

  if (matchesBoolOrLevelsPrefix(model)) {
    return true;
  }

  return undefined;
}

function coerceGptOssLevels(
  desired: ModelThink | undefined | "off",
): ModelThink | undefined {
  if (desired === undefined) {
    return undefined;
  }
  if (desired === "off" || desired === false) {
    return "low";
  }
  if (desired === true) {
    return "medium";
  }
  if (desired === "max") {
    return "high";
  }
  if (desired === "low" || desired === "medium" || desired === "high") {
    return desired;
  }
  return "medium";
}

function coerceDeepseekV4Modes(
  desired: ModelThink | undefined | "off",
): ModelThink | undefined {
  if (desired === "off" || desired === false) {
    return false;
  }
  if (desired === "max") {
    return "max";
  }
  if (desired === "high") {
    return "high";
  }
  if (
    desired === true ||
    desired === "low" ||
    desired === "medium" ||
    desired === undefined
  ) {
    return true;
  }
  return true;
}

function coerceBoolOrLevels(
  desired: ModelThink | undefined | "off",
): ModelThink | undefined {
  if (desired === "off" || desired === false) {
    return false;
  }
  return desired;
}

function coerceUnknownThink(
  desired: ModelThink | undefined | "off",
): ModelThink | undefined {
  if (desired === undefined) {
    return undefined;
  }
  if (desired === "off" || desired === false) {
    return undefined;
  }
  return desired;
}

function bumpThinkForLongResearch(
  desired: ModelThink | undefined | "off",
  settings: AgentSettings | undefined,
  model: string,
): ModelThink | undefined | "off" {
  let bumped = bumpThinkNotch(desired);
  const settingsMode = settings?.thinkingMode ?? "auto";
  const ceiling = explicitThinkingCeiling(settings);

  if (ceiling !== undefined) {
    bumped = minThinkNotch(bumped, ceiling);
  }

  if (thinkNotchIndex(bumped) >= thinkNotchIndex("max")) {
    const allowMax =
      settingsMode === "max" ||
      (settingsMode === "auto" && model.startsWith("deepseek-v4"));
    if (!allowMax) {
      bumped = "high";
    }
  }

  return bumped;
}

function explicitThinkingCeiling(
  settings: AgentSettings | undefined,
): ModelThink | undefined {
  const mode = settings?.thinkingMode ?? "auto";
  if (mode === "auto" || mode === "off") {
    return undefined;
  }
  return mode;
}

function bumpThinkNotch(
  desired: ModelThink | undefined | "off",
): ModelThink | undefined | "off" {
  const index = thinkNotchIndex(desired);
  const next = THINK_NOTCHES[Math.min(index + 1, THINK_NOTCHES.length - 1)];
  return notchToDesired(next);
}

function minThinkNotch(
  desired: ModelThink | undefined | "off",
  ceiling: ModelThink,
): ModelThink | undefined | "off" {
  if (thinkNotchIndex(desired) <= thinkNotchIndex(ceiling)) {
    return desired;
  }
  return ceiling;
}

function thinkNotchIndex(value: ModelThink | undefined | "off"): number {
  const notch = desiredToNotch(value);
  const index = THINK_NOTCHES.indexOf(notch);
  return index >= 0 ? index : 0;
}

function desiredToNotch(value: ModelThink | undefined | "off"): ThinkNotch {
  if (value === "off" || value === undefined) {
    return "off";
  }
  if (value === false) {
    return "false";
  }
  if (value === true) {
    return "medium";
  }
  return value;
}

function notchToDesired(notch: ThinkNotch): ModelThink | undefined | "off" {
  switch (notch) {
    case "off":
      return "off";
    case "false":
      return false;
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "max";
  }
}
