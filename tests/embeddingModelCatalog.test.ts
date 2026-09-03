import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_EMBEDDING_DIM_V1,
  EMBEDDING_MODEL_CATALOG_V1,
  findEmbeddingModelSpecV1,
  normalizeEmbeddingDimSettingV1,
  resolveEffectiveEmbeddingDimV1,
} from "../src/embeddings/embeddingModelCatalogV1";
import { resolveEmbeddingPrefixesV1 } from "../src/embeddings/embeddingPrefixes";

/*
 * Switching the embedding model used to be a free-text field whose value the
 * runtime could not interpret: the helper truncated every model with nomic's
 * Matryoshka recipe, and the dimension setting only knew 256 and 512. The
 * catalogue is where "what does this model actually produce" now lives, and
 * these tests pin the three answers every caller depends on.
 */

test("the shipped default is catalogued as a Matryoshka model", () => {
  const spec = findEmbeddingModelSpecV1("nomic-ai/nomic-embed-text-v1.5-Q");
  assert.ok(spec);
  assert.equal(spec.nativeDim, 768);
  assert.equal(spec.matryoshka, true);
  // An Ollama-style tag names the same weights.
  assert.equal(findEmbeddingModelSpecV1("nomic-embed-text")?.id, "nomic-ai/nomic-embed-text-v1.5");
});

test("lookup is exact and case-insensitive, never a substring match", () => {
  assert.equal(findEmbeddingModelSpecV1("baai/BGE-small-en-v1.5")?.id, "BAAI/bge-small-en-v1.5");
  // "bge-small-en" (v1) and "bge-small-en-v1.5" are different weights; the
  // alias table names each explicitly instead of letting one match the other.
  assert.equal(findEmbeddingModelSpecV1("bge-small-en")?.id, "BAAI/bge-small-en-v1.5");
  assert.equal(findEmbeddingModelSpecV1("some/unreleased-embedder"), null);
  assert.equal(findEmbeddingModelSpecV1(""), null);
});

test("a Matryoshka model honours the setting up to its native width", () => {
  assert.deepEqual(resolveEffectiveEmbeddingDimV1("nomic-ai/nomic-embed-text-v1.5-Q", 256), {
    dim: 256,
    matryoshka: true,
    nativeDim: 768,
    reason: "matryoshka_truncation",
  });
  // Asking for more than the model has is capped, not an error.
  assert.equal(resolveEffectiveEmbeddingDimV1("nomic-ai/nomic-embed-text-v1.5-Q", 1024).dim, 768);
});

test("a non-Matryoshka model ignores the setting and uses its native width", () => {
  // This is the case that used to throw ("embedding dimension 384 is smaller
  // than requested dim 512") or, when the setting happened to be smaller than
  // the native width, silently truncated a model that cannot be truncated.
  assert.deepEqual(resolveEffectiveEmbeddingDimV1("BAAI/bge-small-en-v1.5", 512), {
    dim: 384,
    matryoshka: false,
    nativeDim: 384,
    reason: "native_dimension",
  });
  assert.equal(resolveEffectiveEmbeddingDimV1("BAAI/bge-base-en-v1.5", 256).dim, 768);
});

test("an unknown model takes the setting as given and is never truncated", () => {
  assert.deepEqual(resolveEffectiveEmbeddingDimV1("some/unreleased-embedder", 1024), {
    dim: 1024,
    matryoshka: false,
    nativeDim: null,
    reason: "unknown_model",
  });
});

test("the dimension setting is clamped to a sane integer", () => {
  assert.equal(normalizeEmbeddingDimSettingV1(512), 512);
  assert.equal(normalizeEmbeddingDimSettingV1("768"), 768);
  assert.equal(normalizeEmbeddingDimSettingV1(383.6), 384);
  for (const bad of [0, -1, 7, 99999, Number.NaN, "abc", null, undefined, {}]) {
    assert.equal(normalizeEmbeddingDimSettingV1(bad), DEFAULT_EMBEDDING_DIM_V1, String(bad));
  }
});

test("every catalogue entry is internally coherent and its prefixes resolve", () => {
  const seen = new Set<string>();
  for (const spec of EMBEDDING_MODEL_CATALOG_V1) {
    assert.ok(!seen.has(spec.id.toLowerCase()), `duplicate id ${spec.id}`);
    seen.add(spec.id.toLowerCase());
    assert.ok(Number.isInteger(spec.nativeDim) && spec.nativeDim >= 64, spec.id);
    assert.ok(spec.maxTokens >= 128, spec.id);
    assert.ok(spec.sizeMb > 0, spec.id);
    // The prefix resolver consults the catalogue first, so the two can never
    // disagree about a catalogued model.
    assert.deepEqual(resolveEmbeddingPrefixesV1(spec.id), spec.prefixes, spec.id);
    for (const alias of spec.aliases) {
      assert.equal(findEmbeddingModelSpecV1(alias)?.id, spec.id, alias);
    }
  }
});

test("query-side retrieval instructions are applied to the models trained with them", () => {
  const instruction = "Represent this sentence for searching relevant passages: ";
  assert.deepEqual(resolveEmbeddingPrefixesV1("snowflake/snowflake-arctic-embed-s"), {
    query: instruction,
    document: "",
  });
  assert.deepEqual(resolveEmbeddingPrefixesV1("mixedbread-ai/mxbai-embed-large-v1"), {
    query: instruction,
    document: "",
  });
  // Family fallback for a runtime that names the weights differently.
  assert.equal(resolveEmbeddingPrefixesV1("snowflake-arctic-embed-m-v2.0").query, instruction);
  // bge stays bare: its v1.5 card calls the instruction optional and the
  // existing index fingerprint for bge users must not change.
  assert.deepEqual(resolveEmbeddingPrefixesV1("BAAI/bge-small-en-v1.5"), { query: "", document: "" });
});
