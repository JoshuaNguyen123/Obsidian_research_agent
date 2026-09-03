/**
 * Instruction prefixes an embedding model expects on its inputs.
 *
 * These are per-model conventions, not a general technique. nomic-embed wants
 * `search_query:` / `search_document:`; the e5 family wants `query:` /
 * `passage:`; snowflake-arctic and mxbai want a retrieval instruction on the
 * query side only; bge-m3 and most others want nothing at all. Applying the
 * wrong pair does not fail loudly -- it quietly degrades recall, because the
 * model is embedding an instruction it was never trained to strip.
 *
 * The pair used to be hardcoded to nomic's inside the Python helper, so pointing
 * the plugin at any other model would have kept prefixing every document with
 * `search_document: ` and silently lost quality with nothing to see.
 *
 * Resolution order: an exact catalogue match (`embeddingModelCatalogV1.ts`)
 * wins, because the catalogue records what each model card says. Then family
 * rules by substring, so a model named differently by another runtime
 * (`nomic-embed-text` under an Ollama-compatible endpoint) still resolves. An
 * unknown model gets no prefix. That is the safe default: a missing prefix
 * costs a model that wanted one some accuracy, while an invented prefix
 * corrupts a model that wanted none.
 */
import { findEmbeddingModelSpecV1 } from "./embeddingModelCatalogV1";
import {
  NO_EMBEDDING_PREFIXES,
  type EmbeddingPrefixPairV1,
} from "./embeddingPrefixTypes";

export { NO_EMBEDDING_PREFIXES, type EmbeddingPrefixPairV1 };

const NOMIC_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "search_query: ",
  document: "search_document: ",
});

const E5_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "query: ",
  document: "passage: ",
});

const RETRIEVAL_INSTRUCTION_QUERY_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "Represent this sentence for searching relevant passages: ",
  document: "",
});

/**
 * Family fallbacks, matched against the lowercased model id as substrings.
 * Order matters: the first match wins.
 */
const PREFIX_RULES: ReadonlyArray<{
  match: string;
  prefixes: EmbeddingPrefixPairV1;
}> = Object.freeze([
  { match: "nomic-embed", prefixes: NOMIC_PREFIXES },
  { match: "e5-", prefixes: E5_PREFIXES },
  { match: "multilingual-e5", prefixes: E5_PREFIXES },
  { match: "arctic-embed", prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES },
  { match: "mxbai-embed", prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES },
  // bge-m3 and bge-*-v1.5 are trained without an input prefix. Named
  // explicitly rather than left to the default so the intent is legible.
  { match: "bge-m3", prefixes: NO_EMBEDDING_PREFIXES },
  { match: "bge-", prefixes: NO_EMBEDDING_PREFIXES },
  { match: "qwen3-embedding", prefixes: NO_EMBEDDING_PREFIXES },
]);

export function resolveEmbeddingPrefixesV1(model: string): EmbeddingPrefixPairV1 {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return NO_EMBEDDING_PREFIXES;
  const catalogued = findEmbeddingModelSpecV1(normalized);
  if (catalogued) return catalogued.prefixes;
  for (const rule of PREFIX_RULES) {
    if (normalized.includes(rule.match)) return rule.prefixes;
  }
  return NO_EMBEDDING_PREFIXES;
}

/**
 * Stable identity for a prefix pair, for the index compatibility check.
 *
 * Embeddings built under one prefix pair are not comparable with embeddings
 * built under another, so a change here must invalidate a persisted index
 * exactly the way a model change does. Without this the prefixes could change
 * under a stored index and every similarity score would quietly be measured
 * against differently-embedded text.
 */
export function embeddingPrefixFingerprintV1(model: string): string {
  const { query, document } = resolveEmbeddingPrefixesV1(model);
  return `${query}|${document}`;
}
