import assert from "node:assert/strict";
import test from "node:test";
import {
  formatEmbeddingProbeResultV1,
  probeEmbeddingProviderV1,
} from "../src/embeddings/embeddingProbe";
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
  SemanticEmbeddingResponse,
} from "../src/embeddings/types";

/*
 * Proving the embedding runtime works, before a mission depends on it.
 *
 * The failure this guards against is silent: semanticSearchEnabled records an
 * intent, not a working runtime, so settings showed "on" while every search
 * quietly fell back to keyword matching. It is invisible on any machine where
 * FastEmbed happens to be installed -- which is why it never reproduced for
 * whoever was developing the plugin.
 */

function providerReturning(
  response: Partial<SemanticEmbeddingResponse>,
  onRequest?: (request: SemanticEmbeddingRequest) => void,
): SemanticEmbeddingProvider {
  return {
    embed: async (request) => {
      onRequest?.(request);
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        ...response,
      } as SemanticEmbeddingResponse;
    },
  };
}

const vector = (length: number) => [Array.from({ length }, () => 0.1)];

test("a working runtime reports model, dimensions, and latency", async () => {
  let ticks = 0;
  const result = await probeEmbeddingProviderV1({
    provider: providerReturning({
      documents: vector(512),
      queries: vector(512),
    }),
    model: "nomic-embed-text",
    dim: 512,
    now: () => (ticks += 40),
  });

  assert.equal(result.ok, true);
  assert.equal(result.cause, "healthy");
  assert.equal(result.dim, 512);
  assert.equal(result.latencyMs, 40);
  assert.equal(result.setupAction, null);
});

test("the probe exercises both sides of an asymmetric model", async () => {
  const seen: SemanticEmbeddingRequest[] = [];
  await probeEmbeddingProviderV1({
    provider: providerReturning(
      { documents: vector(512), queries: vector(512) },
      (request) => seen.push(request),
    ),
    model: "nomic-embed-text",
    dim: 512,
  });

  // Probing only one side would miss a prefix that breaks just the other.
  assert.equal(seen[0]?.documents.length, 1);
  assert.equal(seen[0]?.queries.length, 1);
  assert.equal(seen[0]?.queryPrefix, "search_query: ");
  assert.equal(seen[0]?.documentPrefix, "search_document: ");
});

test("a missing runtime names the install step rather than just failing", async () => {
  const result = await probeEmbeddingProviderV1({
    provider: {
      embed: async () => ({
        ok: false,
        model: "nomic-embed-text",
        dim: 512,
        code: "missing_fastembed",
        message: "FastEmbed is not installed.",
      }),
    },
    model: "nomic-embed-text",
    dim: 512,
  });

  assert.equal(result.ok, false);
  // Same vocabulary the runner uses on a mid-run fallback, so settings and the
  // run cannot disagree about what is wrong.
  assert.equal(result.cause, "embeddings_not_installed");
  assert.match(formatEmbeddingProbeResultV1(result), /pip install fastembed/u);
});

test("an absent provider is reported, not treated as healthy", async () => {
  const result = await probeEmbeddingProviderV1({
    provider: null,
    model: "nomic-embed-text",
    dim: 512,
  });

  assert.equal(result.ok, false);
  assert.equal(result.cause, "embedding_runtime_unavailable");
  assert.ok(result.setupAction);
});

test("a runtime that answers ok with nothing in it is a failure", async () => {
  const result = await probeEmbeddingProviderV1({
    provider: providerReturning({ documents: [], queries: [] }),
    model: "nomic-embed-text",
    dim: 512,
  });

  // ok:true with no vectors would otherwise surface much later as silently
  // empty search results, with nothing pointing back at the runtime.
  assert.equal(result.ok, false);
  assert.equal(result.cause, "embedding_call_failed");
  assert.match(result.message, /no vectors/u);
});

test("a dimension mismatch is caught before it corrupts the index", async () => {
  const result = await probeEmbeddingProviderV1({
    provider: providerReturning({
      documents: vector(768),
      queries: vector(768),
    }),
    model: "some/other-embedder",
    dim: 512,
  });

  assert.equal(result.ok, false);
  assert.equal(result.dim, 768);
  // Vectors of a different width are not comparable with a persisted index, so
  // this has to fail loudly rather than write mixed-width shards.
  assert.match(result.message, /would not be comparable/u);
});

test("a provider that throws is caught rather than crashing settings", async () => {
  const result = await probeEmbeddingProviderV1({
    provider: {
      embed: async () => {
        throw new Error("spawn ENOENT");
      },
    },
    model: "nomic-embed-text",
    dim: 512,
  });

  assert.equal(result.ok, false);
  assert.equal(result.cause, "embedding_call_failed");
  assert.match(result.message, /spawn ENOENT/u);
});

test("a throughput sample reports documents per second on this machine", async () => {
  // The number a user needs when choosing a model depends on their CPU, so
  // it is measured by the probe rather than copied from a table.
  let clock = 0;
  const provider: SemanticEmbeddingProvider = {
    embed: async (request) => {
      // Basic probe: instant. Sample of 16 documents: two simulated seconds.
      clock += request.documents.length > 1 ? 2000 : 10;
      return {
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: request.documents.map(() => vector(512)[0]),
        queries: request.queries.map(() => vector(512)[0]),
      };
    },
  };
  const result = await probeEmbeddingProviderV1({
    provider,
    model: "nomic-ai/nomic-embed-text-v1.5-Q",
    dim: 512,
    now: () => clock,
    throughputSample: Array.from({ length: 16 }, (_, index) => `sample ${index}`),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.throughput, { documents: 16, ms: 2000, perSecond: 8 });
  assert.match(formatEmbeddingProbeResultV1(result), /about 8 documents\/s/);
});

test("without a sample the probe reports no throughput and its message is unchanged", async () => {
  const result = await probeEmbeddingProviderV1({
    provider: providerReturning({ documents: vector(512), queries: vector(512) }),
    model: "nomic-ai/nomic-embed-text-v1.5-Q",
    dim: 512,
  });
  assert.equal(result.ok, true);
  assert.equal(result.throughput, null);
  assert.match(result.message, /^Embeddings working: .* in \d+ms\.$/);
});
