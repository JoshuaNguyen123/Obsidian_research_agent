import type { SemanticEmbeddingProvider } from "./types";
import {
  classifyFallbackCause,
  setupActionForCauseV1,
  type SemanticRetrievalCauseV1,
} from "../agent/semanticRetrievalHealth";
import {
  resolveEmbeddingPrefixesV1,
  type EmbeddingPrefixPairV1,
} from "./embeddingPrefixes";
import { resolveEffectiveEmbeddingDimV1 } from "./embeddingModelCatalogV1";

/**
 * A proactive check that the embedding runtime actually works.
 *
 * Until now the only way to discover that embeddings were unavailable was to
 * run a mission and read the degraded-retrieval notice afterwards. Settings
 * showed semantic search as "on" regardless, because the setting records an
 * intent, not a working runtime -- and on a machine where FastEmbed happens to
 * be installed, the broken path is invisible. That is exactly why this class of
 * failure never reproduces for whoever is developing the plugin.
 *
 * Classification deliberately reuses `classifyFallbackCause`, the same function
 * the runner uses on a mid-run fallback. Two vocabularies for one condition
 * would let settings and the runner disagree about what is wrong.
 */
export interface EmbeddingProbeResultV1 {
  ok: boolean;
  model: string;
  /** Dimensions actually returned, which is not always the dimension asked for. */
  dim: number | null;
  requestedDim: number;
  latencyMs: number;
  cause: SemanticRetrievalCauseV1;
  message: string;
  /** Concrete next step when there is one; never invented busywork. */
  setupAction: string | null;
  /** Which prefix convention this model resolves to, so a mismatch is visible. */
  prefixes: EmbeddingPrefixPairV1;
  /**
   * Measured indexing speed when the caller supplied a sample: how many
   * documents the runtime embedded per second. This is the number a user
   * needs when choosing a model, and it depends on their CPU, so it is
   * measured here rather than copied from a table.
   */
  throughput: { documents: number; ms: number; perSecond: number } | null;
  /**
   * Execution providers the runtime actually loaded the model with. A user who
   * configured an accelerator needs to see whether it took; an empty list just
   * means the runtime did not say.
   */
  providersUsed: string[];
}

/**
 * Sixteen documents of roughly two hundred tokens: long enough that the
 * measurement reflects note-sized chunks rather than helper overhead, short
 * enough that a slow model finishes in a few seconds.
 */
export function buildEmbeddingThroughputSampleV1(): string[] {
  const sentence =
    "The semantic index splits each note into overlapping windows, embeds them with a local model, and stores the vectors beside the note metadata so a search can rank by meaning as well as by words. ";
  return Array.from({ length: 16 }, (_, index) => `${sentence.repeat(6)}Sample ${index + 1}.`);
}

export async function probeEmbeddingProviderV1({
  provider,
  model,
  dim,
  cacheDir,
  now = () => Date.now(),
  throughputSample,
}: {
  provider: SemanticEmbeddingProvider | null;
  model: string;
  /** The user's setting; the catalogue decides what the runtime is asked for. */
  dim: number;
  cacheDir?: string;
  now?: () => number;
  /** Documents to time after the basic probe passes; omitted = no throughput figure. */
  throughputSample?: string[];
}): Promise<EmbeddingProbeResultV1> {
  const prefixes = resolveEmbeddingPrefixesV1(model);
  const effective = resolveEffectiveEmbeddingDimV1(model, dim);
  const requestedDim = effective.dim;
  const base = {
    model,
    requestedDim,
    prefixes,
    throughput: null,
    providersUsed: [],
  };

  if (!provider) {
    return {
      ...base,
      ok: false,
      dim: null,
      latencyMs: 0,
      cause: "embedding_runtime_unavailable",
      message: "No embedding provider is configured.",
      setupAction: setupActionForCauseV1("embedding_runtime_unavailable"),
    };
  }

  const startedAt = now();
  let response;
  try {
    response = await provider.embed({
      model,
      dim: requestedDim,
      matryoshka: effective.matryoshka,
      cacheDir,
      // One of each: an asymmetric model prefixes them differently, so probing
      // only one side would miss a prefix that breaks just the other.
      documents: ["a short probe document"],
      queries: ["a short probe query"],
      queryPrefix: prefixes.query,
      documentPrefix: prefixes.document,
    });
  } catch (error) {
    return {
      ...base,
      ok: false,
      dim: null,
      latencyMs: Math.max(0, now() - startedAt),
      cause: "embedding_call_failed",
      message:
        error instanceof Error
          ? `Embedding call threw: ${error.message}`
          : "Embedding call threw.",
      setupAction: null,
    };
  }
  const latencyMs = Math.max(0, now() - startedAt);

  if (!response.ok) {
    const cause = classifyFallbackCause(response.code ?? null);
    return {
      ...base,
      ok: false,
      dim: null,
      latencyMs,
      cause,
      message: response.message?.trim() || "The embedding runtime failed.",
      setupAction: setupActionForCauseV1(cause),
    };
  }

  const queryVector = response.queries?.[0];
  const documentVector = response.documents?.[0];
  if (!queryVector?.length || !documentVector?.length) {
    // A provider that answers ok:true with nothing in it is broken in a way
    // that would otherwise surface much later as silently empty search results.
    return {
      ...base,
      ok: false,
      dim: null,
      latencyMs,
      cause: "embedding_call_failed",
      message: "The embedding runtime returned no vectors.",
      setupAction: null,
    };
  }

  if (queryVector.length !== requestedDim || documentVector.length !== requestedDim) {
    return {
      ...base,
      ok: false,
      dim: queryVector.length,
      latencyMs,
      cause: "embedding_call_failed",
      message: `The runtime returned ${queryVector.length}-dimension vectors but ${requestedDim} was requested. The persisted index would not be comparable with these.`,
      setupAction: null,
    };
  }

  let throughput: EmbeddingProbeResultV1["throughput"] = null;
  if (throughputSample && throughputSample.length > 0) {
    const sampleStartedAt = now();
    try {
      const sampled = await provider.embed({
        model,
        dim: requestedDim,
        matryoshka: effective.matryoshka,
        cacheDir,
        documents: throughputSample,
        queries: [],
        queryPrefix: prefixes.query,
        documentPrefix: prefixes.document,
      });
      const ms = Math.max(1, now() - sampleStartedAt);
      if (sampled.ok && sampled.documents?.length === throughputSample.length) {
        throughput = {
          documents: throughputSample.length,
          ms,
          perSecond: Number(((throughputSample.length * 1000) / ms).toFixed(1)),
        };
      }
    } catch {
      // The basic probe already passed; a failed timing sample is not a
      // broken runtime, just a missing number.
      throughput = null;
    }
  }

  return {
    ...base,
    ok: true,
    providersUsed: response.providersUsed ?? [],
    dim: queryVector.length,
    latencyMs,
    cause: "healthy",
    message: throughput
      ? `Embeddings working: ${model} at ${requestedDim} dimensions, ${latencyMs}ms for one document, about ${throughput.perSecond} documents/s on this machine.`
      : `Embeddings working: ${model} at ${requestedDim} dimensions in ${latencyMs}ms.`,
    setupAction: null,
    throughput,
  };
}

/** One line for a settings row. States the runtime, never the intent. */
export function formatEmbeddingProbeResultV1(
  result: EmbeddingProbeResultV1,
): string {
  if (result.ok) return result.message;
  return result.setupAction
    ? `${result.message} ${result.setupAction}`
    : result.message;
}
