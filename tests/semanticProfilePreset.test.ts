import assert from "node:assert/strict";
import test from "node:test";
import {
  NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL,
  NEW_INSTALL_SEMANTIC_PROFILE,
  SEMANTIC_PROFILE_PRESETS,
  applySemanticProfilePreset,
} from "../src/agent/semanticProfile";
import type { AgentSettings } from "../src/settings";

// settings.ts imports `obsidian`, so unit tests cannot load DEFAULT_SETTINGS
// as a value. New installs spread SEMANTIC_PROFILE_PRESETS[NEW_INSTALL_SEMANTIC_PROFILE]
// (Fast). Existing vaults that stored balanced keep those keys on load.

test("applying a preset writes through to the individual values", () => {
  const settings = { ...SEMANTIC_PROFILE_PRESETS.balanced } as AgentSettings;
  applySemanticProfilePreset(settings, "thorough");
  assert.equal(settings.semanticChunkTargetTokens, 800);
  assert.equal(settings.semanticIndexMaxFiles, 40000);

  // Switching back restores every value: hidden is hidden, never lost.
  applySemanticProfilePreset(settings, "balanced");
  for (const [key, value] of Object.entries(SEMANTIC_PROFILE_PRESETS.balanced)) {
    assert.deepEqual(settings[key as keyof AgentSettings], value);
  }
});

test("thorough widens chunks and the index ceiling without changing the model", () => {
  // A preset that swapped the embedding model would invalidate an existing
  // index — that is a migration, not a tuning choice.
  assert.equal(
    SEMANTIC_PROFILE_PRESETS.thorough.semanticEmbeddingModel,
    SEMANTIC_PROFILE_PRESETS.balanced.semanticEmbeddingModel,
  );
  assert.equal(
    SEMANTIC_PROFILE_PRESETS.thorough.semanticEmbeddingDim,
    SEMANTIC_PROFILE_PRESETS.balanced.semanticEmbeddingDim,
  );
  assert.ok(
    SEMANTIC_PROFILE_PRESETS.thorough.semanticChunkTargetTokens >
      SEMANTIC_PROFILE_PRESETS.balanced.semanticChunkTargetTokens,
  );
  assert.ok(
    SEMANTIC_PROFILE_PRESETS.thorough.semanticIndexMaxFiles >
      SEMANTIC_PROFILE_PRESETS.balanced.semanticIndexMaxFiles,
  );
});

test("chunk bounds stay internally coherent in every preset", () => {
  for (const [name, preset] of Object.entries(SEMANTIC_PROFILE_PRESETS)) {
    assert.ok(
      preset.semanticChunkMinTokens < preset.semanticChunkTargetTokens,
      `${name}: min must be below target`,
    );
    assert.ok(
      preset.semanticChunkTargetTokens < preset.semanticChunkMaxTokens,
      `${name}: target must be below max`,
    );
    assert.ok(
      preset.semanticChunkOverlapTokens < preset.semanticChunkMinTokens,
      `${name}: overlap must be below the minimum chunk`,
    );
  }
});

test("new installs default to the Fast embedding preset", () => {
  assert.equal(NEW_INSTALL_SEMANTIC_PROFILE, "fast");
  assert.equal(
    NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL,
    "jinaai/jina-embeddings-v2-small-en",
  );
  assert.equal(
    SEMANTIC_PROFILE_PRESETS[NEW_INSTALL_SEMANTIC_PROFILE].semanticEmbeddingModel,
    NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL,
  );
  assert.equal(
    SEMANTIC_PROFILE_PRESETS.fast.semanticChunkTargetTokens,
    256,
  );
});

test("fast trades the model and chunk size for indexing speed, on the benchmark's numbers", () => {
  // docs/eval/embedder-benchmark.md (2026-09-03): jina-v2-small at a 256-token
  // target indexed 31 chunks/s vs nomic's 10.7 with 1.00 MRR on both query
  // sets. New installs start here; an existing vault that stored balanced
  // keeps that profile and is not migrated.
  const fast = SEMANTIC_PROFILE_PRESETS.fast;
  assert.equal(fast.semanticEmbeddingModel, "jinaai/jina-embeddings-v2-small-en");
  assert.equal(fast.semanticEmbeddingDim, 512);
  assert.ok(
    fast.semanticChunkTargetTokens < SEMANTIC_PROFILE_PRESETS.balanced.semanticChunkTargetTokens,
  );
  assert.equal(fast.semanticIndexMaxFiles, SEMANTIC_PROFILE_PRESETS.balanced.semanticIndexMaxFiles);
});

test("every preset states the rerank stage, and the shipped default spends it on research only", () => {
  // "Fast and extremely accurate" is two stages, not one bigger model: index
  // with the small embedder (measured 31 chunks/s) and pay ~1s per search to
  // have a cross-encoder re-read the shortlist. Presets must state the stage
  // explicitly so switching between them actually changes it.
  const accurate = SEMANTIC_PROFILE_PRESETS.accurate;
  assert.equal(accurate.semanticEmbeddingModel, SEMANTIC_PROFILE_PRESETS.fast.semanticEmbeddingModel);
  assert.equal(
    accurate.semanticChunkTargetTokens,
    SEMANTIC_PROFILE_PRESETS.fast.semanticChunkTargetTokens,
  );
  assert.equal(accurate.semanticRerankMode, "cross_encoder", "accurate pays on every search");
  assert.ok(accurate.semanticRerankTopK >= 1);
  // The shipped default: the accuracy is spent where a shortlist is read for
  // evidence, and nowhere else. Accurate remains the always-on option, and the
  // legacy presets stay exactly as vaults on them stored them.
  assert.equal(
    SEMANTIC_PROFILE_PRESETS[NEW_INSTALL_SEMANTIC_PROFILE].semanticRerankMode,
    "research",
  );
  for (const name of ["balanced", "thorough"] as const) {
    assert.equal(SEMANTIC_PROFILE_PRESETS[name].semanticRerankMode, "off", name);
  }
  // A preset never leaves the mode unstated, or switching would inherit half
  // of the previous one.
  for (const preset of Object.values(SEMANTIC_PROFILE_PRESETS)) {
    assert.ok(
      ["off", "research", "cross_encoder"].includes(preset.semanticRerankMode),
      preset.semanticRerankMode,
    );
  }
});
