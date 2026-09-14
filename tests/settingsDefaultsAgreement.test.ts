import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NEW_INSTALL_SEMANTIC_PROFILE,
  SEMANTIC_PROFILE_PRESETS,
} from "../src/agent/semanticProfile";
import {
  normalizeAgentSettings,
  resetAgentSettingsKeepingConnectionsV1,
} from "../src/agent/settingsNormalize";
import {
  isSemanticRerankModeV1,
  SEMANTIC_RERANK_MODES_V1,
} from "../src/embeddings/semanticRerank";

/**
 * Two default tables describe one product: `DEFAULT_SETTINGS` in settings.ts
 * (which imports `obsidian` and so cannot be loaded here) and `BASE_DEFAULTS`
 * in settingsNormalize.ts, which every headless path uses. They drifted a
 * whole semantic profile apart — the normalizer still described the retired
 * "balanced" tuning while the plugin shipped "fast" — and the two meet in
 * "Reset settings to defaults", which spreads the normalizer's answer over
 * DEFAULT_SETTINGS. Resetting therefore downgraded the embedding model,
 * widened the chunking, turned reranking off, and invalidated the vault index
 * so the next search rebuilt it with the slower model.
 */

const PRESET = SEMANTIC_PROFILE_PRESETS[NEW_INSTALL_SEMANTIC_PROFILE];

test("a new install normalizes to the shipped semantic profile", () => {
  const settings = normalizeAgentSettings({}, "new_install") as Record<string, unknown>;
  assert.equal(settings.semanticProfile, NEW_INSTALL_SEMANTIC_PROFILE);
  for (const [key, value] of Object.entries(PRESET)) {
    assert.deepEqual(
      settings[key],
      value,
      `${key} must come from the shipped ${NEW_INSTALL_SEMANTIC_PROFILE} preset`,
    );
  }
});

test("resetting to defaults keeps the shipped profile, index and rerank stage", () => {
  const current = {
    ollamaApiKey: "key",
    model: "glm-5.3-flash:cloud",
    semanticChunkTargetTokens: 800,
    semanticRerankMode: "cross_encoder",
    maxAgentSteps: 99,
  };
  const reset = resetAgentSettingsKeepingConnectionsV1(current) as Record<string, unknown>;
  assert.equal(reset.ollamaApiKey, "key", "connections are kept");
  assert.equal(reset.model, "glm-5.3-flash:cloud");
  assert.notEqual(reset.maxAgentSteps, 99, "preferences return to defaults");
  assert.equal(reset.semanticEmbeddingModel, PRESET.semanticEmbeddingModel);
  assert.equal(reset.semanticChunkTargetTokens, PRESET.semanticChunkTargetTokens);
  assert.equal(reset.semanticRerankMode, PRESET.semanticRerankMode);
});

test("every rerank mode the product defines survives normalization", () => {
  for (const mode of SEMANTIC_RERANK_MODES_V1) {
    const settings = normalizeAgentSettings(
      { semanticRerankMode: mode },
      "existing_install",
    ) as Record<string, unknown>;
    assert.equal(settings.semanticRerankMode, mode, `${mode} was rewritten`);
  }
  // Anything unreadable still fails closed: the stage costs CPU per search.
  assert.equal(
    (normalizeAgentSettings(
      { semanticRerankMode: "sometimes" },
      "existing_install",
    ) as Record<string, unknown>).semanticRerankMode,
    "off",
  );
  assert.ok(isSemanticRerankModeV1("research"));
  assert.ok(!isSemanticRerankModeV1("sometimes"));
});

test("an existing vault's stored semantic tuning is never rewritten by defaults", () => {
  // The preset is the empty-data default, never a migration: a vault that
  // stored balanced keeps balanced, index and all.
  const stored = {
    semanticProfile: "balanced",
    ...SEMANTIC_PROFILE_PRESETS.balanced,
  };
  const settings = normalizeAgentSettings(stored, "existing_install") as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(SEMANTIC_PROFILE_PRESETS.balanced)) {
    assert.deepEqual(settings[key], value, `${key} must survive an upgrade`);
  }
});

test("both default tables read the same preset table", () => {
  // settings.ts cannot be imported as a value here (it imports `obsidian`),
  // so the guard is source-level: neither table may restate the field values.
  const settingsSource = readFileSync("src/settings.ts", "utf8");
  const normalizeSource = readFileSync("src/agent/settingsNormalize.ts", "utf8");
  for (const [file, source] of [
    ["src/settings.ts", settingsSource],
    ["src/agent/settingsNormalize.ts", normalizeSource],
  ] as const) {
    assert.match(
      source,
      /\.\.\.SEMANTIC_PROFILE_PRESETS\[NEW_INSTALL_SEMANTIC_PROFILE\]/u,
      `${file} must spread the shipped preset instead of restating it`,
    );
  }
  assert.ok(
    !/semanticChunkTargetTokens:\s*\d+/u.test(normalizeSource),
    "settingsNormalize must not restate preset field values",
  );
});
