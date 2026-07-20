export type CapabilitySetupTarget =
  | "model"
  | "notes_research"
  | "code"
  | "linear"
  | "github"
  | "browser_web"
  | "background";

export interface PendingCapabilityResume {
  runId: string;
  continuationCommand: string;
  target: CapabilitySetupTarget;
  reason: string;
  requestedAt: string;
}

export interface CapabilitySetupInferenceInput {
  mission?: string;
  summary?: string;
  reason?: string;
  blockerCategory?: string;
  missing?: string[];
  toolName?: string;
}

/**
 * Maps host-owned blocker evidence to the smallest consolidated settings area.
 * This is deliberately deterministic: model prose cannot choose an arbitrary
 * settings destination or cause a mission to resume by itself.
 */
export function inferCapabilitySetupTarget(
  input: CapabilitySetupInferenceInput,
): CapabilitySetupTarget | null {
  const haystack = [
    input.mission,
    input.summary,
    input.reason,
    input.blockerCategory,
    input.toolName,
    ...(input.missing ?? []),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .toLowerCase();

  if (!haystack) return null;
  // Mission-graph / tool-frontier failures are host authority issues, not
  // missing credentials. Settings setup cannot unblock them.
  if (
    /authoritative mission graph|not ready in the (?:exact )?authoritative|off-frontier|plan_dependency|mission_graph_authority/i.test(
      haystack,
    )
  ) {
    return null;
  }
  if (/\blinear\b/.test(haystack)) return "linear";
  if (/\bgithub\b|pull request|\bpr\b|remote repository/.test(haystack)) {
    return "github";
  }
  if (
    /sandbox|worktree|workspace edit|repository bind|code capability|execute code/.test(
      haystack,
    )
  ) {
    return "code";
  }
  if (
    /model|provider|api key|authentication|ollama|openai|chat completions/.test(
      haystack,
    )
  ) {
    return "model";
  }
  if (/companion|schedule|background|overnight|unattended/.test(haystack)) {
    return "background";
  }
  if (/browser|web action|web fetch|web search|playwright/.test(haystack)) {
    return "browser_web";
  }
  if (
    /\b(?:vault|semantic|research memory|writeback)\b|\bnotes?\b/.test(haystack)
  ) {
    return "notes_research";
  }
  return null;
}

export function capabilitySetupLabel(target: CapabilitySetupTarget): string {
  switch (target) {
    case "model":
      return "Model";
    case "notes_research":
      return "Notes & research";
    case "browser_web":
      return "Browser & web";
    case "background":
      return "Background work";
    case "github":
      return "GitHub";
    case "linear":
      return "Linear";
    case "code":
      return "Code";
  }
}
