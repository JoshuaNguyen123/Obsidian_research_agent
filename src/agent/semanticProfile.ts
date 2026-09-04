import type { AgentSettings } from "../settings";
import {
  DEFAULT_SEMANTIC_RERANK_MODEL,
  DEFAULT_SEMANTIC_RERANK_TOP_K,
  type SemanticRerankModeV1,
} from "../embeddings/semanticRerank";

/**
 * Semantic tuning, expressed as one choice instead of eight.
 *
 * Chunk sizes, embedding dimension, index budgets, and interpreter paths are
 * implementation detail for a feature most people either want or don't. Semantic
 * search ships enabled, so every one of those rows was on screen for every user,
 * making the settings tab read like a control panel.
 *
 * Mirrors {@link ./safetyCeiling} deliberately: one preset idiom in the settings
 * tab is learnable, two are not.
 *
 * Deliberately free of any Obsidian import so it stays unit-testable.
 */
export type SemanticProfilePreset =
  | "fast"
  | "balanced"
  | "accurate"
  | "thorough"
  | "custom";

/**
 * New installs ship Fast. Existing vaults that stored `semanticProfile:
 * "balanced"` (or the balanced field values) keep them — the preset is only
 * the empty-data default, never a migration.
 */
export const NEW_INSTALL_SEMANTIC_PROFILE = "fast" satisfies Exclude<
  SemanticProfilePreset,
  "custom"
>;

export const NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL =
  "jinaai/jina-embeddings-v2-small-en";

export interface SemanticProfileLimits {
  semanticEmbeddingModel: string;
  semanticEmbeddingDim: number;
  semanticChunkMinTokens: number;
  semanticChunkTargetTokens: number;
  semanticChunkMaxTokens: number;
  semanticChunkOverlapTokens: number;
  semanticIndexDebounceMs: number;
  semanticIndexMaxFiles: number;
  semanticIndexPersistVectors: boolean;
  /**
   * Every preset states the rerank stage explicitly, including the ones that
   * leave it off: switching presets must land on a known configuration rather
   * than inheriting half of the previous one.
   */
  semanticRerankMode: SemanticRerankModeV1;
  semanticRerankModel: string;
  semanticRerankTopK: number;
}

/**
 * Choosing a preset writes these through to the individual settings, so every
 * consumer keeps reading the field it always did — the preset is a UI
 * affordance, never a second source of truth.
 */
export const SEMANTIC_PROFILE_PRESETS: Readonly<
  Record<Exclude<SemanticProfilePreset, "custom">, Readonly<SemanticProfileLimits>>
> = Object.freeze({
  // Preserved for existing vaults that stored this profile. New installs
  // start on `fast` instead — see NEW_INSTALL_SEMANTIC_PROFILE.
  balanced: Object.freeze({
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 300,
    semanticChunkTargetTokens: 500,
    semanticChunkMaxTokens: 700,
    semanticChunkOverlapTokens: 80,
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 10000,
    semanticIndexPersistVectors: true,
    semanticRerankMode: "off",
    semanticRerankModel: DEFAULT_SEMANTIC_RERANK_MODEL,
    semanticRerankTopK: DEFAULT_SEMANTIC_RERANK_TOP_K,
  }),
  // Measured on 2026-09-03 (scripts/benchmark-embedders.ts, i7-1165G7, CPU
  // only): jina-embeddings-v2-small-en indexed 31 chunks/s against nomic's
  // 10.7 and scored 1.00/1.00/1.00 on both the exact-term and paraphrase
  // query sets at a 256-token chunk target, with the lowest query latency and
  // an 8192-token input limit. New installs start here. Choosing it on an
  // existing balanced vault rebuilds the index once (different model and
  // chunking); stored balanced settings are never rewritten on upgrade.
  fast: Object.freeze({
    semanticEmbeddingModel: NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL,
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 150,
    semanticChunkTargetTokens: 256,
    semanticChunkMaxTokens: 360,
    semanticChunkOverlapTokens: 40,
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 10000,
    semanticIndexPersistVectors: true,
    // Deep searches -- the ones a research mission runs when it is deciding
    // what to cite -- pay about a second for the cross-encoder; every other
    // search stays first-stage only. Choosing this preset on an existing
    // vault does not rebuild anything: reranking reads the index it already
    // has. The first deep search after choosing it downloads a 130 MB model.
    semanticRerankMode: "research",
    semanticRerankModel: DEFAULT_SEMANTIC_RERANK_MODEL,
    semanticRerankTopK: DEFAULT_SEMANTIC_RERANK_TOP_K,
  }),
  // Fast to index and accurate to read: the same small embedding model builds
  // the index at ~31 chunks/s, and every search then pays about a second to
  // have a local cross-encoder re-read its top 20 chunks against the actual
  // question. The two stages fix different errors -- the bi-encoder decides
  // which twenty chunks are in the neighbourhood, the cross-encoder decides
  // which of those actually answers -- so this is the preset for someone who
  // wants speed where the vault-sized work is and accuracy where it counts.
  // First search after choosing it downloads a 130 MB reranker.
  accurate: Object.freeze({
    semanticEmbeddingModel: "jinaai/jina-embeddings-v2-small-en",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 150,
    semanticChunkTargetTokens: 256,
    semanticChunkMaxTokens: 360,
    semanticChunkOverlapTokens: 40,
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 10000,
    semanticIndexPersistVectors: true,
    semanticRerankMode: "cross_encoder",
    semanticRerankModel: DEFAULT_SEMANTIC_RERANK_MODEL,
    semanticRerankTopK: DEFAULT_SEMANTIC_RERANK_TOP_K,
  }),
  // Larger chunks carry more surrounding context per embedding, and a bigger
  // file ceiling covers large vaults. The embedding model is unchanged: this
  // preset buys recall, not a different retrieval stack.
  thorough: Object.freeze({
    semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
    semanticEmbeddingDim: 512,
    semanticChunkMinTokens: 400,
    semanticChunkTargetTokens: 800,
    semanticChunkMaxTokens: 1100,
    semanticChunkOverlapTokens: 140,
    semanticIndexDebounceMs: 3000,
    semanticIndexMaxFiles: 40000,
    semanticIndexPersistVectors: true,
    semanticRerankMode: "off",
    semanticRerankModel: DEFAULT_SEMANTIC_RERANK_MODEL,
    semanticRerankTopK: DEFAULT_SEMANTIC_RERANK_TOP_K,
  }),
});

/** Apply a preset's values onto a settings object in place. */
export function applySemanticProfilePreset(
  settings: AgentSettings,
  preset: Exclude<SemanticProfilePreset, "custom">,
): void {
  Object.assign(settings, SEMANTIC_PROFILE_PRESETS[preset]);
}
