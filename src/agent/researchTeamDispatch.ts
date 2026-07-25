import type { AgentSettings } from "../settings";
import type { SemanticEmbeddingProvider } from "../embeddings/types";
import type { MissionIntent } from "../tools/types";
import { classifyIntent } from "./reflex/intentRouter";
import { createDefaultAutonomyScope } from "./missionScope";
import { isLiteraryPrimaryTextWriteMission } from "./evidenceIntent";

/**
 * The deterministic keyword floor for Lead + Researcher orchestration, moved
 * verbatim from shouldUseResearchTeam so behavior can never regress. Bare
 * "research" / "research this topic" must stay false — ordinary note
 * writebacks must not open a research_team runtime.
 */
export const RESEARCH_TEAM_KEYWORD_FLOOR =
  /\b(deep\s+research|investigate|sources?|citations?|verify|fact[-\s]?check|evidence|compare\s+(?:sources?|evidence)|current\s+(?:events?|sources?)|latest\s+(?:sources?|research)|web\s+research|vault\s+research)\b/i;

export interface ResearchTeamDispatchInputV1 {
  prompt: string;
  orchestratorEnabled: boolean;
  forceChatOnly: boolean;
  /**
   * Optional widener dependencies. When absent (or reflex is disabled, or no
   * embedding provider exists) the embedding layer is inert and routing is
   * exactly the deterministic layers — fail-closed by construction.
   */
  settings?: AgentSettings;
  embeddingProvider?: SemanticEmbeddingProvider;
}

export interface ResearchTeamDispatchDecisionV1 {
  useTeam: boolean;
  /** Machine-readable decision provenance, first entry is decisive. */
  signals: string[];
  reason: string;
}

/**
 * Layered research-team routing, replacing the bare regex trigger:
 *
 * 1. Hard negatives — orchestrator disabled, chat-only, or a literary
 *    primary-text write mission. Deterministic vetoes; nothing below can
 *    override them.
 * 2. Deterministic keyword floor — the original regex, verbatim. Anything it
 *    accepted before is still accepted.
 * 3. Structural signals — deterministic, model-free evidence that the mission
 *    is multi-source research even without the floor's keywords: multiple
 *    URLs, explicitly-deep phrasing, or comparative/temporal shape.
 * 4. Embedding widener — classifyIntent's `web_research` label at high
 *    confidence may WIDEN into the team; a `chat_answer` label can never veto
 *    layers 2–3, and the layer is inert whenever reflex is off or no
 *    embedding provider is configured (fallbackDecision yields `unknown`).
 */
export async function resolveResearchTeamDispatchV1(
  input: ResearchTeamDispatchInputV1,
): Promise<ResearchTeamDispatchDecisionV1> {
  if (!input.orchestratorEnabled) {
    return decision(false, ["orchestrator_disabled"], "Orchestrator is disabled.");
  }
  if (input.forceChatOnly) {
    return decision(false, ["chat_only"], "Chat-only missions never open a team runtime.");
  }
  if (isLiteraryPrimaryTextWriteMission(input.prompt)) {
    return decision(
      false,
      ["literary_primary_text"],
      "Literary primary-text essays are single-agent write missions.",
    );
  }

  if (RESEARCH_TEAM_KEYWORD_FLOOR.test(input.prompt)) {
    return decision(
      true,
      ["keyword_floor"],
      "Deterministic research-team keywords matched.",
    );
  }

  const structural = structuralSignals(input.prompt);
  if (structural.length > 0) {
    return decision(
      true,
      structural,
      "Deterministic structural research signals matched.",
    );
  }

  const widened = await embeddingWidener(input);
  if (widened) {
    return decision(
      true,
      ["embedding_web_research", widened],
      "Semantic routing classified this as web research at high confidence.",
    );
  }

  return decision(false, ["no_signal"], "No research-team signal; single-agent.");
}

/**
 * Deterministic, model-free structure that marks multi-source research even
 * when the keyword floor missed: several distinct URLs to reconcile,
 * explicitly-deep phrasing, or a comparative/temporal question shape.
 */
function structuralSignals(prompt: string): string[] {
  const signals: string[] = [];
  const urls = new Set(
    (prompt.match(/https?:\/\/[^\s)>\]"']+/giu) ?? []).map((url) =>
      url.replace(/[.,;:!?]+$/u, "").toLowerCase(),
    ),
  );
  if (urls.size >= 2) signals.push("multiple_urls");
  if (
    /\b(?:in[- ]depth|exhaustive|systematic\s+review|all\s+available\s+sources|overnight\s+research)\b/iu.test(
      prompt,
    )
  ) {
    signals.push("explicitly_deep");
  }
  if (
    /\b(?:as\s+of\s+(?:today|20\d\d)|which\s+is\s+(?:better|faster|safer|cheaper)|(?:compare|comparison\s+of)\s+\S+\s+(?:vs\.?|versus)\s+\S+|state\s+of\s+the\s+art)\b/iu.test(
      prompt,
    )
  ) {
    signals.push("comparative_or_temporal");
  }
  return signals;
}

/**
 * Widener only. Returns a confidence tag when classifyIntent labels the
 * prompt `web_research` in the high confidence band; every fallback (reflex
 * disabled, no provider, low confidence, ambiguous margin, deterministic
 * constraint) yields null and leaves the deterministic outcome standing.
 */
/** The widener may never stall dispatch: routing must stay near-instant even
 * when the embedding backend is cold (python spawn, model load). Anything
 * slower than this budget falls back to the deterministic outcome. */
const EMBEDDING_WIDENER_TIMEOUT_MS = 1_500;

async function embeddingWidener(
  input: ResearchTeamDispatchInputV1,
): Promise<string | null> {
  if (!input.settings || !input.embeddingProvider) return null;
  try {
    const routed = await withDispatchTimeout(
      classifyIntent({
        prompt: input.prompt,
        missionIntent: neutralMissionIntent(),
        allowedToolNames: new Set<string>(),
        recentActions: [],
        evidence: [],
        receipts: [],
        settings: input.settings,
        embeddingProvider: input.embeddingProvider,
      }),
    );
    if (routed !== null && routed.label === "web_research" && routed.confidenceBand === "high") {
      return `confidence_${routed.confidence}`;
    }
    return null;
  } catch {
    // The widener must never take routing down; deterministic layers stand.
    return null;
  }
}

async function withDispatchTimeout<TResult>(
  promise: Promise<TResult>,
): Promise<TResult | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EMBEDDING_WIDENER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Dispatch-time classification runs before any mission-intent derivation, so
 * the widener sees a neutral no-authority intent: chat-mode, no mutation, no
 * autonomous write. classifyIntent's deterministic-authority constraint can
 * therefore never fire from synthetic state.
 */
function neutralMissionIntent(): MissionIntent {
  return {
    mode: "chat_only",
    vaultContext: false,
    noteOutput: false,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: createDefaultAutonomyScope(),
  };
}

function decision(
  useTeam: boolean,
  signals: string[],
  reason: string,
): ResearchTeamDispatchDecisionV1 {
  return { useTeam, signals, reason };
}
