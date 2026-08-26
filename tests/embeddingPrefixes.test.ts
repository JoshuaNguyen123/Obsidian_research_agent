import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_EMBEDDING_PREFIXES,
  embeddingPrefixFingerprintV1,
  resolveEmbeddingPrefixesV1,
} from "../src/embeddings/embeddingPrefixes";

/*
 * Input prefixes are a per-model convention, not a technique.
 *
 * The pair was hardcoded to nomic's inside the Python helper, so pointing the
 * plugin at any other embedding model kept prefixing every document with
 * "search_document: " -- embedding an instruction the model was never trained
 * to strip, and losing recall with nothing visible to explain it.
 */

test("each model family gets the prefixes it was trained with", () => {
  assert.deepEqual(resolveEmbeddingPrefixesV1("nomic-ai/nomic-embed-text-v1.5-Q"), {
    query: "search_query: ",
    document: "search_document: ",
  });
  // Same model, different runtime naming.
  assert.deepEqual(
    resolveEmbeddingPrefixesV1("nomic-embed-text"),
    resolveEmbeddingPrefixesV1("nomic-ai/nomic-embed-text-v1.5-Q"),
  );

  assert.deepEqual(resolveEmbeddingPrefixesV1("intfloat/multilingual-e5-large"), {
    query: "query: ",
    document: "passage: ",
  });

  // bge-m3 and Qwen3 are trained without a prefix; giving them one is the bug.
  assert.deepEqual(resolveEmbeddingPrefixesV1("BAAI/bge-m3"), NO_EMBEDDING_PREFIXES);
  assert.deepEqual(
    resolveEmbeddingPrefixesV1("Qwen/Qwen3-Embedding-0.6B"),
    NO_EMBEDDING_PREFIXES,
  );
});

test("an unknown model gets no prefix rather than a guessed one", () => {
  // A missing prefix costs a model that wanted one some accuracy; an invented
  // prefix corrupts a model that wanted none. The safe default is neither.
  assert.deepEqual(resolveEmbeddingPrefixesV1("some/unreleased-embedder"), NO_EMBEDDING_PREFIXES);
  assert.deepEqual(resolveEmbeddingPrefixesV1(""), NO_EMBEDDING_PREFIXES);
  assert.deepEqual(resolveEmbeddingPrefixesV1("   "), NO_EMBEDDING_PREFIXES);
});

test("the fingerprint changes exactly when the effective prefixes do", () => {
  const nomic = embeddingPrefixFingerprintV1("nomic-embed-text");
  const bge = embeddingPrefixFingerprintV1("BAAI/bge-m3");
  const e5 = embeddingPrefixFingerprintV1("intfloat/e5-large-v2");

  assert.notEqual(nomic, bge);
  assert.notEqual(nomic, e5);
  assert.notEqual(bge, e5);
  // Stable for the same model, so a persisted index is not invalidated on every
  // load.
  assert.equal(nomic, embeddingPrefixFingerprintV1("nomic-embed-text"));

  // The legacy fingerprint an index written before per-model prefixes is
  // treated as carrying. A nomic index stays valid across this change; an index
  // for any other model does not, because its vectors really were built with
  // the wrong prefix.
  assert.equal(nomic, "search_query: |search_document: ");
  assert.notEqual(bge, "search_query: |search_document: ");
});
