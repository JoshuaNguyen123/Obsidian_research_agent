import type { AgentSettings } from "../../settings";
import type { SemanticEmbeddingProvider } from "../../embeddings/types";
import type { AgenticReflexInput, ReflexDecision, ReflexLabel } from "./types";

const INTENT_CONFIDENCE_THRESHOLD = 0.72;
const INTENT_WINNING_MARGIN = 0.08;
const PROTOTYPE_VERSION = "v1";

const PROTOTYPES: Record<ReflexLabel, string[]> = {
  chat_answer: [
    "Answer this question in chat.",
    "Explain this concept without changing notes.",
    "Give me a concise answer.",
  ],
  current_note_write: [
    "Write this into the current note.",
    "Append this draft to the active page.",
    "Revise the current note.",
  ],
  vault_search: [
    "Search my vault for exact references.",
    "Find notes that mention this phrase.",
    "List files in my notes about this.",
  ],
  semantic_vault_search: [
    "What do my notes say about this topic?",
    "Find related ideas across my vault.",
    "Search my notes conceptually.",
  ],
  web_research: [
    "Research this online with sources.",
    "Find current information and citations.",
    "Verify this using web sources.",
  ],
  graph_context: [
    "Find related notes and backlinks.",
    "Show connections in the note graph.",
    "Suggest links between relevant notes.",
  ],
  template_work: [
    "Create a note from this template.",
    "Fill this markdown template.",
    "Create reusable templates.",
  ],
  word_count: [
    "Count the words in this note.",
    "Verify the draft length.",
    "Check whether this is under the word limit.",
  ],
  design_artifact: [
    "Create a canvas design package.",
    "Make a wireframe or SVG design.",
    "Generate an architecture diagram.",
  ],
  code_execution: [
    "Run this code block.",
    "Render an HTML preview.",
    "Execute this script and report the output.",
  ],
  browser_learning: [
    "Open this page in the browser and learn from it.",
    "Click through this webpage safely.",
    "Extract readable content from the browser.",
  ],
  memory_update: [
    "Save this to research memory.",
    "Remember this project fact.",
    "Store this reusable procedure.",
  ],
  unknown: [],
};

const prototypeVectorCache = new Map<string, PrototypeVectorSet>();

interface PrototypeVectorSet {
  labels: ReflexLabel[];
  vectors: number[][];
}

interface ScoredIntent {
  label: ReflexLabel;
  score: number;
}

export async function classifyIntent(
  input: AgenticReflexInput,
): Promise<ReflexDecision> {
  if (!input.settings?.agenticReflexEnabled) {
    return fallbackDecision("disabled", "disabled");
  }
  const hardConstraint = deterministicConstraint(input);
  if (hardConstraint) return hardConstraint;
  if (!input.embeddingProvider) {
    return fallbackDecision(
      "embedding_provider_unavailable",
      "embedding_provider_unavailable",
    );
  }

  const scored = await scorePromptAgainstPrototypes({
    prompt: input.prompt,
    settings: input.settings,
    embeddingProvider: input.embeddingProvider,
  });
  const best = scored[0];
  if (!best || best.score < INTENT_CONFIDENCE_THRESHOLD) {
    return fallbackDecision("low_confidence", "low_confidence", best?.score ?? 0);
  }
  const margin = best.score - (scored[1]?.score ?? 0);
  if (margin < INTENT_WINNING_MARGIN) {
    return fallbackDecision("ambiguous_margin", "ambiguous_margin", best.score, margin);
  }

  const suggestedAction = suggestedSafeRead(best.label);
  const allowedAction =
    suggestedAction && input.allowedToolNames.has(suggestedAction)
      ? suggestedAction
      : null;

  return {
    version: 2,
    label: best.label,
    confidence: roundScore(best.score),
    confidenceBand: confidenceBand(best.score),
    winningMargin: roundScore(margin),
    applied: false,
    reason: "embedding_prototype_match",
    reasonCode: "semantic_match",
    suggestedAction,
    allowedAction,
    safetyNotes: suggestedAction
      ? ["Semantic routing may add only a safe read already allowed by host authority."]
      : ["Semantic routing cannot add mutation or external-action authority."],
  };
}

export function fallbackDecision(
  reason: string,
  reasonCode: ReflexDecision["reasonCode"] = "low_confidence",
  confidence = 0,
  winningMargin = 0,
  safetyNotes: string[] = [],
): ReflexDecision {
  return {
    version: 2,
    label: "unknown",
    confidence: roundScore(confidence),
    confidenceBand: confidenceBand(confidence),
    winningMargin: roundScore(winningMargin),
    applied: false,
    reason,
    reasonCode,
    suggestedAction: null,
    allowedAction: null,
    safetyNotes,
  };
}

function deterministicConstraint(input: AgenticReflexInput): ReflexDecision | null {
  const prompt = input.prompt.toLowerCase();
  if (
    /ignore\s+(?:all\s+)?(?:previous|system|developer)\s+instructions|reveal\s+(?:the\s+)?(?:system\s+prompt|hidden\s+instructions)|untrusted[-\s]?content\s+says/u.test(prompt)
  ) {
    return fallbackDecision(
      "untrusted_content_restriction",
      "untrusted_content",
      0,
      0,
      ["Untrusted content cannot widen authority or choose an action."],
    );
  }
  if (
    /(?:do\s+not|don't|never|without)\s+(?:search|read|use|inspect)\s+(?:my\s+|the\s+)?(?:vault|notes)|(?:do\s+not|don't|never|without)\s+(?:browse|search)\s+(?:the\s+)?web/u.test(prompt)
  ) {
    return fallbackDecision(
      "negated_intent_is_authoritative",
      "negated_intent",
      0,
      0,
      ["Explicit negation wins over semantic similarity."],
    );
  }
  if (
    input.missionIntent.explicitMutation ||
    input.missionIntent.explicitDelete ||
    input.missionIntent.allowAutonomousWrite
  ) {
    return fallbackDecision(
      "deterministic_authority_is_authoritative",
      "deterministic_authority",
      0,
      0,
      ["Semantic routing cannot widen or reinterpret mutation authority."],
    );
  }
  return null;
}

function suggestedSafeRead(label: ReflexLabel): string | null {
  switch (label) {
    case "vault_search": return "search_markdown_files";
    case "semantic_vault_search": return "semantic_search_notes";
    case "web_research": return "web_search";
    case "graph_context": return "get_note_graph_context";
    case "word_count": return "count_words";
    default: return null;
  }
}

function confidenceBand(value: number): ReflexDecision["confidenceBand"] {
  return value >= 0.8 ? "high" : value >= INTENT_CONFIDENCE_THRESHOLD ? "medium" : "low";
}

async function scorePromptAgainstPrototypes({
  prompt,
  settings,
  embeddingProvider,
}: {
  prompt: string;
  settings: AgentSettings;
  embeddingProvider: SemanticEmbeddingProvider;
}): Promise<ScoredIntent[]> {
  const model = settings.semanticEmbeddingModel.trim();
  const dim = settings.semanticEmbeddingDim === 256 ? 256 : 512;
  const cacheKey = [
    PROTOTYPE_VERSION,
    model,
    dim,
    settings.semanticModelCacheDir,
  ].join(":");
  let prototypes = prototypeVectorCache.get(cacheKey);
  if (!prototypes) {
    const labels: ReflexLabel[] = [];
    const documents: string[] = [];
    for (const [label, examples] of Object.entries(PROTOTYPES) as Array<
      [ReflexLabel, string[]]
    >) {
      for (const example of examples) {
        labels.push(label);
        documents.push(example);
      }
    }
    const response = await embeddingProvider.embed({
      model,
      dim,
      cacheDir: settings.semanticModelCacheDir || undefined,
      documents,
      queries: [],
    });
    if (!response.ok || !response.documents || response.documents.length !== documents.length) {
      return [];
    }
    prototypes = { labels, vectors: response.documents };
    prototypeVectorCache.set(cacheKey, prototypes);
  }

  const query = await embeddingProvider.embed({
    model,
    dim,
    cacheDir: settings.semanticModelCacheDir || undefined,
    documents: [],
    queries: [prompt],
  });
  if (!query.ok || !query.queries?.[0]) {
    return [];
  }

  const byLabel = new Map<ReflexLabel, number>();
  prototypes.vectors.forEach((vector, index) => {
    const label = prototypes?.labels[index] ?? "unknown";
    const score = normalizeCosine(cosineSimilarity(query.queries![0], vector));
    byLabel.set(label, Math.max(byLabel.get(label) ?? 0, score));
  });

  return [...byLabel.entries()]
    .map(([label, score]) => ({ label, score }))
    .sort((left, right) => right.score - left.score);
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude <= 0 || rightMagnitude <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function normalizeCosine(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
