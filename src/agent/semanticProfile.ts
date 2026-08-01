import type { AgentSettings } from "../settings";

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
export type SemanticProfilePreset = "balanced" | "thorough" | "custom";

export interface SemanticProfileLimits {
  semanticEmbeddingModel: string;
  semanticEmbeddingDim: 256 | 512;
  semanticChunkMinTokens: number;
  semanticChunkTargetTokens: number;
  semanticChunkMaxTokens: number;
  semanticChunkOverlapTokens: number;
  semanticIndexDebounceMs: number;
  semanticIndexMaxFiles: number;
  semanticIndexPersistVectors: boolean;
}

/**
 * Choosing a preset writes these through to the individual settings, so every
 * consumer keeps reading the field it always did — the preset is a UI
 * affordance, never a second source of truth.
 */
export const SEMANTIC_PROFILE_PRESETS: Readonly<
  Record<Exclude<SemanticProfilePreset, "custom">, Readonly<SemanticProfileLimits>>
> = Object.freeze({
  // Exactly the values this plugin has always shipped. An existing vault must
  // see no behavioural change on upgrade, so these are copied, not re-chosen —
  // a unit test pins them to DEFAULT_SETTINGS.
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
  }),
});

/** Apply a preset's values onto a settings object in place. */
export function applySemanticProfilePreset(
  settings: AgentSettings,
  preset: Exclude<SemanticProfilePreset, "custom">,
): void {
  Object.assign(settings, SEMANTIC_PROFILE_PRESETS[preset]);
}
