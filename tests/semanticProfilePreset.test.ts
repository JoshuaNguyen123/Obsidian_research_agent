import assert from "node:assert/strict";
import test from "node:test";
import {
  SEMANTIC_PROFILE_PRESETS,
  applySemanticProfilePreset,
} from "../src/agent/semanticProfile";
import type { AgentSettings } from "../src/settings";

// There is deliberately no "preset equals DEFAULT_SETTINGS" test here. Two
// reasons: settings.ts imports `obsidian` at runtime so no unit test can load
// DEFAULT_SETTINGS as a value, and more importantly the check would be
// redundant — DEFAULT_SETTINGS spreads SEMANTIC_PROFILE_PRESETS.balanced
// directly, exactly as it does for the safety ceiling, so the two cannot drift
// apart. The value being asserted is a single source, not a copy.

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
