import type { AgentSettings } from "../../settings";
import type { SemanticEmbeddingProvider } from "../../embeddings/types";
import type { AgenticReflexInput, ReflexDecision, ReflexLabel } from "./types";

const INTENT_CONFIDENCE_THRESHOLD = 0.72;
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
    return fallbackDecision("disabled");
  }
  if (!input.embeddingProvider) {
    return fallbackDecision("embedding_provider_unavailable");
  }

  const scored = await scorePromptAgainstPrototypes({
    prompt: input.prompt,
    settings: input.settings,
    embeddingProvider: input.embeddingProvider,
  });
  const best = scored[0];
  if (!best || best.score < INTENT_CONFIDENCE_THRESHOLD) {
    return fallbackDecision("low_confidence");
  }

  return {
    label: best.label,
    confidence: roundScore(best.score),
    applied: false,
    reason: "embedding_prototype_match",
    safetyNotes: [],
  };
}

export function fallbackDecision(reason: string): ReflexDecision {
  return {
    label: "unknown",
    confidence: 0,
    applied: false,
    reason,
    safetyNotes: [],
  };
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
