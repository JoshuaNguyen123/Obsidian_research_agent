import assert from "node:assert/strict";
import test from "node:test";
import {
  embedIndexDocuments,
  SEMANTIC_EMBED_BATCH_SIZE,
} from "../src/embeddings/semanticIndex";
import type { AgentSettings } from "../src/settings";
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
} from "../src/embeddings/types";

const SETTINGS = {
  semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
  semanticEmbeddingDim: 512,
  semanticModelCacheDir: "",
} as AgentSettings;

function createRecordingProvider(options?: {
  failOnBatchIndex?: number;
}): { provider: SemanticEmbeddingProvider; requests: SemanticEmbeddingRequest[] } {
  const requests: SemanticEmbeddingRequest[] = [];
  const provider: SemanticEmbeddingProvider = {
    embed: async (request) => {
      const batchIndex = requests.length;
      requests.push(request);
      if (options?.failOnBatchIndex === batchIndex) {
        return {
          ok: false,
          model: request.model,
          dim: request.dim,
          code: "output_too_large",
          message: "helper response too large",
        };
      }
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map((text, index) => [
          text.length,
          batchIndex,
          index,
        ]),
        queries: [],
      };
    },
  };
  return { provider, requests };
}

test("a whole-vault embed is split into bounded batches, never one giant request", async () => {
  const documentCount = SEMANTIC_EMBED_BATCH_SIZE * 3 + 7;
  const documents = Array.from(
    { length: documentCount },
    (_, index) => `doc-${index}`,
  );
  const { provider, requests } = createRecordingProvider();

  const result = await embedIndexDocuments({
    provider,
    settings: SETTINGS,
    documents,
  });

  assert.ok(result.ok);
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.ok(
      request.documents.length <= SEMANTIC_EMBED_BATCH_SIZE,
      `batch of ${request.documents.length} exceeds ${SEMANTIC_EMBED_BATCH_SIZE}`,
    );
  }
  assert.equal(
    requests.reduce((sum, request) => sum + request.documents.length, 0),
    documentCount,
  );
});

test("vectors come back in input order across batch boundaries", async () => {
  const documents = ["a", "bb", "ccc", "dddd", "eeeee"];
  const { provider } = createRecordingProvider();

  const result = await embedIndexDocuments({
    provider,
    settings: SETTINGS,
    documents,
    batchSize: 2,
  });

  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.vectors.length, documents.length);
  // First component of each fake vector is the document length, which is
  // unique per input here — proves ordering survived re-batching.
  assert.deepEqual(
    result.vectors.map((vector) => vector[0]),
    documents.map((text) => text.length),
  );
});

test("a failing batch propagates its error code and stops further requests", async () => {
  const documents = ["a", "b", "c", "d", "e", "f"];
  const { provider, requests } = createRecordingProvider({ failOnBatchIndex: 1 });

  const result = await embedIndexDocuments({
    provider,
    settings: SETTINGS,
    documents,
    batchSize: 2,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "output_too_large");
  assert.equal(requests.length, 2);
});

test("empty document lists do not touch the provider", async () => {
  const { provider, requests } = createRecordingProvider();
  const result = await embedIndexDocuments({
    provider,
    settings: SETTINGS,
    documents: [],
  });
  assert.ok(result.ok);
  assert.equal(requests.length, 0);
});
