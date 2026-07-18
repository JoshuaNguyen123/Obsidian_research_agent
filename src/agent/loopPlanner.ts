import { MAX_AGENT_STEPS } from "../tools/constants";
import { FINALIZATION_RESERVE_STEPS } from "./AgentBudget";
import type { RunBudgetProfile, RunBudgetRoute } from "./runBudget";
import { getRunBudgetProfile, resolveConfiguredMaxAgentSteps } from "./runBudget";
import type { GeneratedOutputPolicy } from "./generatedOutputPolicy";

export interface LoopBudgetPlan {
  hardCap: number;
  toolStepBudget: number;
  finalizationReserve: number;
  expectedTools: string[];
  stopWhenSatisfied: boolean;
  routeProfile?: RunBudgetProfile;
}

export function planLoopBudget(input: {
  prompt: string;
  route: RunBudgetRoute;
  generated: GeneratedOutputPolicy;
  configuredMaxSteps?: number | null;
  requestedSteps?: number | null;
}): LoopBudgetPlan {
  const hardCap = resolveConfiguredMaxAgentSteps(input.configuredMaxSteps);
  const routeProfile = getRunBudgetProfile(input.route);
  const expectedTools = getExpectedTools(input.prompt, input.generated);
  const finalizationReserve = getFinalizationReserve(hardCap);
  const requestedToolBudget =
    typeof input.requestedSteps === "number" && Number.isFinite(input.requestedSteps)
      ? Math.max(0, Math.trunc(input.requestedSteps) - finalizationReserve)
      : getRequestedToolBudget({
          route: input.route,
          prompt: input.prompt,
          generated: input.generated,
          expectedTools,
          hardCap,
          finalizationReserve,
        });
  const toolStepBudget = Math.max(
    0,
    Math.min(requestedToolBudget, Math.max(0, hardCap - finalizationReserve)),
  );

  return {
    hardCap: Math.min(MAX_AGENT_STEPS, hardCap),
    toolStepBudget,
    finalizationReserve,
    expectedTools,
    routeProfile,
    stopWhenSatisfied:
      input.generated.kind !== "general" || input.generated.requiresGrounding,
  };
}

function getExpectedTools(
  prompt: string,
  generated: GeneratedOutputPolicy,
): string[] {
  if (generated.kind === "diagram") {
    if (
      /\b(design\s*package|service\s*blueprint|logistics\s*system|project\s*ideation|ui\s*flow|canvas\s+plus\s+(brief|markdown)|brief\s+plus\s+canvas)\b/i.test(
        prompt,
      )
    ) {
      return ["create_design_package"];
    }

    return /\b(svg|wireframe|mockup|screen|layout|ui\s+design|static\s+diagram|sketch)\b/i.test(
      prompt,
    )
      ? ["create_svg_design"]
      : ["create_design_canvas"];
  }

  // A compound research-to-code mission still requires its explicit public
  // web evidence before repository execution. Generic later wording such as
  // "run targeted validation" must not replace that evidence frontier with
  // the legacy single-block code tool.
  if (hasExplicitWebGroundingIntent(prompt)) {
    return ["web_search", "web_fetch"];
  }

  if (hasRunCodeIntent(prompt)) {
    return ["run_code_block"];
  }

  // Explicit metadata verification is a first-class planned read. Leaving it
  // only in the capability envelope makes a deterministic MissionGraph expose
  // an empty frontier, so the model cannot call the very tool acceptance later
  // requires.
  if (hasWordCountIntent(prompt)) {
    return ["count_words"];
  }

  if (
    hasExplicitMarkdownReadTarget(prompt) &&
    !hasExplicitWebGroundingIntent(prompt)
  ) {
    return Array.from(
      { length: getExplicitMarkdownReadTargetCount(prompt) },
      () => "read_file",
    );
  }

  // "Evidence" is not synonymous with "the public web". A mission that
  // explicitly scopes deep research to the user's vault must plan local
  // retrieval proof, otherwise the authoritative graph reserves a web-fetch
  // node that can never be satisfied by a vault-only run.
  if (hasVaultOnlyGroundingIntent(prompt)) {
    if (hasExplicitMarkdownReadTarget(prompt)) {
      return Array.from(
        { length: getExplicitMarkdownReadTargetCount(prompt) },
        () => "read_file",
      );
    }
    return hasLongResearchIntent(prompt)
      ? ["semantic_search_notes", "read_markdown_files"]
      : ["inspect_semantic_index", "semantic_search_notes"];
  }

  if (generated.requiresGrounding || /\b(sources?)\b/i.test(prompt)) {
    return ["web_search", "web_fetch"];
  }

  return [];
}

function hasRunCodeIntent(prompt: string): boolean {
  return /\b(run|execute|eval|evaluate|test|compile|debug)\b[\s\S]{0,120}\b(code|script|program|snippet|python|javascript|typescript|c\+\+|cpp|c\s+code)\b|\b(code|script|program|snippet|python|javascript|typescript|c\+\+|cpp|c\s+code)\b[\s\S]{0,120}\b(run|execute|eval|evaluate|test|compile|debug)\b/i.test(
    prompt,
  );
}

function getRequestedToolBudget({
  route,
  prompt,
  generated,
  expectedTools,
  hardCap,
  finalizationReserve,
}: {
  route: RunBudgetRoute;
  prompt: string;
  generated: GeneratedOutputPolicy;
  expectedTools: string[];
  hardCap: number;
  finalizationReserve: number;
}): number {
  if (
    route === "instant_local" ||
    route === "direct_writeback" ||
    route === "prefetched_vault_answer" ||
    route === "prefetched_vault_writeback"
  ) {
    return 0;
  }

  if (generated.kind === "diagram") {
    return 3;
  }

  if (generated.requiresTextQuotes) {
    return 7;
  }

  if (hasLongResearchIntent(prompt)) {
    return Math.max(1, hardCap - finalizationReserve);
  }

  if (generated.requiresGrounding || expectedTools.length > 0) {
    return 5;
  }

  if (generated.wordTarget && generated.wordTarget.target >= 1000) {
    return 2;
  }

  return route === "grounded_workflow" ? 4 : 2;
}

function hasLongResearchIntent(prompt: string): boolean {
  return /\b(deep\s+research|long\s+research|in-depth\s+research|deep\s+dive|investigate|compare\s+sources|multi[-\s]?source|strategy|broad\s+constraints|evidence\s+ledger|checkpoint|long[-\s]?running)\b/i.test(
    prompt,
  );
}

function hasVaultOnlyGroundingIntent(prompt: string): boolean {
  const vaultSignal =
    /\b(?:my\s+)?vault\b|\b(?:my|local)\s+notes?\b|\bacross\s+(?:my\s+)?notes?\b|\bsemantic(?:ally|\s+search)?\b/i.test(
      prompt,
    );
  return vaultSignal && !hasExplicitWebGroundingIntent(prompt);
}

function hasWordCountIntent(prompt: string): boolean {
  return /\bcount_words\b|\bword\s+count\b|\bcount(?:ing)?\s+(?:the\s+)?words?\b/iu.test(
    prompt,
  );
}

function hasExplicitMarkdownReadTarget(prompt: string): boolean {
  return getExplicitMarkdownReadTargets(prompt).length > 0;
}

function getExplicitMarkdownReadTargetCount(prompt: string): number {
  // The host graph needs one immutable read node per explicitly named note.
  // Count the bounded markdown targets rather than deduplicating tool names;
  // the model still supplies each vault-relative path at execution time.
  return Math.max(
    1,
    Math.min(8, getExplicitMarkdownReadTargets(prompt).length),
  );
}

function getExplicitMarkdownReadTargets(prompt: string): string[] {
  const readVerbs = new Set([
    "read",
    "inspect",
    "review",
    "open",
    "check",
    "compare",
    "summarize",
    "summarise",
    "synthesize",
    "synthesise",
    "extract",
    "use",
    "using",
    "from",
    "source",
    "sourced",
    "sources",
  ]);
  const mutationVerbs = new Set([
    "create",
    "append",
    "replace",
    "write",
    "move",
    "rename",
    "delete",
    "trash",
  ]);
  const targets: string[] = [];
  const compactTargets = prompt.matchAll(
    /[A-Za-z0-9.@()[\]_-]+(?:\/[A-Za-z0-9.@()[\]_-]+)+\.md\b/gu,
  );
  const quotedTargets = prompt.matchAll(
    /["'`]([A-Za-z0-9 .@()[\]_-]+(?:\/[A-Za-z0-9 .@()[\]_-]+)+\.md)["'`]/gu,
  );
  for (const match of [...compactTargets, ...quotedTargets].sort(
    (left, right) => (left.index ?? 0) - (right.index ?? 0),
  )) {
    const index = match.index ?? 0;
    const prefix = prompt.slice(Math.max(0, index - 240), index);
    const verbs = Array.from(
      prefix.matchAll(
        /\b(read|inspect|review|open|check|compare|summari[sz]e|synthesi[sz]e|extract|use|using|from|source(?:d|s)?|create|append|replace|write|move|rename|delete|trash)\b/giu,
      ),
      (verb) => verb[0].toLowerCase(),
    );
    const nearestIntentVerb = verbs.at(-1) ?? "";
    if (
      readVerbs.has(nearestIntentVerb) &&
      !mutationVerbs.has(nearestIntentVerb)
    ) {
      targets.push(match[1] ?? match[0]);
    }
  }
  return [...new Set(targets)];
}

function hasExplicitWebGroundingIntent(prompt: string): boolean {
  return /\bweb\b|\bonline\b|\bexternal\s+sources?\b|\bsource\s+urls?\b|\bcitations?\b|\blatest\b|\bcurrent\s+(?:events?|news|information|data)\b|https?:\/\//iu.test(
    prompt,
  );
}

function getFinalizationReserve(hardCap: number): number {
  if (hardCap <= FINALIZATION_RESERVE_STEPS) {
    return Math.max(0, hardCap - 2);
  }

  return FINALIZATION_RESERVE_STEPS;
}
