import {
  NO_EMBEDDING_PREFIXES,
  type EmbeddingPrefixPairV1,
} from "./embeddingPrefixTypes";

/**
 * What the plugin knows about each embedding model it can be pointed at.
 *
 * Switching models used to be a free-text field that silently produced wrong
 * vectors: the Python helper applied nomic's Matryoshka recipe (layer-norm,
 * truncate, L2) to every model, the dimension setting only allowed 256 or 512,
 * and the prefix table knew four families. A 384-dimension model therefore
 * threw on `dim: 512`, and any non-Matryoshka model that happened to be wider
 * was truncated into noise with nothing visible to explain the recall loss.
 *
 * This table is the one place that knowledge lives. It answers three
 * questions every caller used to guess at: what dimension the model really
 * produces, whether truncating it is legitimate, and which input prefixes it
 * was trained with. Everything else (throughput, recall) is measured by
 * `scripts/benchmark-embedders.mjs`, never asserted here.
 *
 * Sizes are the FastEmbed 0.8.0 catalogue's on-disk figures, rounded, for the
 * settings dropdown. `tier` is a rough parameter-count bucket so the UI can
 * say "fast" or "accurate" without pretending to know the user's CPU.
 */
export type EmbeddingModelTierV1 = "fast" | "balanced" | "accurate";

export interface EmbeddingModelSpecV1 {
  /** Canonical id as the FastEmbed runtime names it. */
  id: string;
  /** Other ids that name the same weights (an Ollama tag, a HF short name). */
  aliases: readonly string[];
  /** Width of the vectors the model emits before any truncation. */
  nativeDim: number;
  /**
   * True only for models trained with Matryoshka Representation Learning, whose
   * leading dimensions are meaningful on their own. Truncating any other model
   * is not a smaller embedding; it is a broken one.
   */
  matryoshka: boolean;
  /** Input length the runtime truncates at. */
  maxTokens: number;
  /** Approximate download size, in megabytes. */
  sizeMb: number;
  tier: EmbeddingModelTierV1;
  prefixes: EmbeddingPrefixPairV1;
  /** One line for the settings row. */
  summary: string;
}

const NOMIC_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "search_query: ",
  document: "search_document: ",
});

const E5_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "query: ",
  document: "passage: ",
});

/**
 * snowflake-arctic-embed (v1) and mxbai-embed-large-v1 were trained with this
 * instruction on the query side only; documents are embedded bare.
 */
const RETRIEVAL_INSTRUCTION_QUERY_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "Represent this sentence for searching relevant passages: ",
  document: "",
});

function spec(
  entry: Omit<EmbeddingModelSpecV1, "aliases" | "prefixes"> & {
    aliases?: readonly string[];
    prefixes?: EmbeddingPrefixPairV1;
  },
): EmbeddingModelSpecV1 {
  return Object.freeze({
    aliases: Object.freeze([]),
    prefixes: NO_EMBEDDING_PREFIXES,
    ...entry,
  });
}

export const EMBEDDING_MODEL_CATALOG_V1: readonly EmbeddingModelSpecV1[] = Object.freeze([
  spec({
    id: "nomic-ai/nomic-embed-text-v1.5-Q",
    aliases: ["nomic-embed-text-v1.5-q"],
    nativeDim: 768,
    matryoshka: true,
    maxTokens: 8192,
    sizeMb: 137,
    tier: "balanced",
    prefixes: NOMIC_PREFIXES,
    summary: "Shipped default. Quantized nomic v1.5; long inputs; truncates to 256–768 dimensions.",
  }),
  spec({
    id: "nomic-ai/nomic-embed-text-v1.5",
    aliases: ["nomic-embed-text-v1.5", "nomic-embed-text"],
    nativeDim: 768,
    matryoshka: true,
    maxTokens: 8192,
    sizeMb: 520,
    tier: "balanced",
    prefixes: NOMIC_PREFIXES,
    summary: "Unquantized nomic v1.5; same vectors as the quantized build at roughly twice the cost.",
  }),
  spec({
    id: "BAAI/bge-small-en-v1.5",
    aliases: ["bge-small-en-v1.5", "bge-small-en"],
    nativeDim: 384,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 70,
    tier: "fast",
    summary: "Small English model; several times faster than nomic on a CPU at some recall cost.",
  }),
  spec({
    id: "BAAI/bge-base-en-v1.5",
    aliases: ["bge-base-en-v1.5", "bge-base-en"],
    nativeDim: 768,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 210,
    tier: "balanced",
    summary: "Base English model; comparable cost to nomic with a 512-token input limit.",
  }),
  spec({
    id: "BAAI/bge-large-en-v1.5",
    aliases: ["bge-large-en-v1.5"],
    nativeDim: 1024,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 1200,
    tier: "accurate",
    summary: "Large English model; slow to index on a CPU.",
  }),
  spec({
    id: "snowflake/snowflake-arctic-embed-xs",
    aliases: ["snowflake-arctic-embed-xs"],
    nativeDim: 384,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 90,
    tier: "fast",
    prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES,
    summary: "Smallest arctic model; fastest option in the catalogue.",
  }),
  spec({
    id: "snowflake/snowflake-arctic-embed-s",
    aliases: ["snowflake-arctic-embed-s"],
    nativeDim: 384,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 130,
    tier: "fast",
    prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES,
    summary: "Small arctic model tuned for retrieval; fast on a CPU.",
  }),
  spec({
    id: "snowflake/snowflake-arctic-embed-m",
    aliases: ["snowflake-arctic-embed-m"],
    nativeDim: 768,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 430,
    tier: "balanced",
    prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES,
    summary: "Medium arctic model tuned for retrieval.",
  }),
  spec({
    id: "snowflake/snowflake-arctic-embed-m-long",
    aliases: ["snowflake-arctic-embed-m-long"],
    nativeDim: 768,
    matryoshka: false,
    maxTokens: 2048,
    sizeMb: 540,
    tier: "balanced",
    prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES,
    summary: "Medium arctic model with a 2048-token input limit.",
  }),
  spec({
    id: "snowflake/snowflake-arctic-embed-l",
    aliases: ["snowflake-arctic-embed-l"],
    nativeDim: 1024,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 1020,
    tier: "accurate",
    prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES,
    summary: "Large arctic model; slow to index on a CPU.",
  }),
  spec({
    id: "mixedbread-ai/mxbai-embed-large-v1",
    aliases: ["mxbai-embed-large-v1", "mxbai-embed-large"],
    nativeDim: 1024,
    matryoshka: true,
    maxTokens: 512,
    sizeMb: 640,
    tier: "accurate",
    prefixes: RETRIEVAL_INSTRUCTION_QUERY_PREFIXES,
    summary: "Strong English model with Matryoshka truncation; slow to index on a CPU.",
  }),
  spec({
    id: "jinaai/jina-embeddings-v2-small-en",
    aliases: ["jina-embeddings-v2-small-en"],
    nativeDim: 512,
    matryoshka: false,
    maxTokens: 8192,
    sizeMb: 120,
    tier: "fast",
    summary: "Small English model with an 8192-token input limit.",
  }),
  spec({
    id: "jinaai/jina-embeddings-v2-base-en",
    aliases: ["jina-embeddings-v2-base-en"],
    nativeDim: 768,
    matryoshka: false,
    maxTokens: 8192,
    sizeMb: 520,
    tier: "balanced",
    summary: "Base English model with an 8192-token input limit.",
  }),
  spec({
    id: "sentence-transformers/all-MiniLM-L6-v2",
    aliases: ["all-minilm-l6-v2", "all-minilm"],
    nativeDim: 384,
    matryoshka: false,
    maxTokens: 256,
    sizeMb: 90,
    tier: "fast",
    summary: "Very small general model; 256-token input limit; weakest recall in the catalogue.",
  }),
  spec({
    id: "thenlper/gte-base",
    aliases: ["gte-base"],
    nativeDim: 768,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 440,
    tier: "balanced",
    summary: "Base English model.",
  }),
  spec({
    id: "thenlper/gte-large",
    aliases: ["gte-large"],
    nativeDim: 1024,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 1200,
    tier: "accurate",
    summary: "Large English model; slow to index on a CPU.",
  }),
  spec({
    id: "intfloat/multilingual-e5-large",
    aliases: ["multilingual-e5-large"],
    nativeDim: 1024,
    matryoshka: false,
    maxTokens: 512,
    sizeMb: 2240,
    tier: "accurate",
    prefixes: E5_PREFIXES,
    summary: "Multilingual (~100 languages); very slow to index on a CPU.",
  }),
  spec({
    id: "jinaai/jina-embeddings-v3",
    aliases: ["jina-embeddings-v3"],
    nativeDim: 1024,
    matryoshka: true,
    maxTokens: 1024,
    sizeMb: 2290,
    tier: "accurate",
    summary: "Multilingual model with Matryoshka truncation; very slow to index on a CPU.",
  }),
]);

/** The dimension setting is clamped into this range before any request. */
export const MIN_EMBEDDING_DIM_V1 = 32;
export const MAX_EMBEDDING_DIM_V1 = 4096;
export const DEFAULT_EMBEDDING_DIM_V1 = 512;

export function normalizeEmbeddingDimSettingV1(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_EMBEDDING_DIM_V1;
  }
  const rounded = Math.round(numeric);
  if (rounded < MIN_EMBEDDING_DIM_V1 || rounded > MAX_EMBEDDING_DIM_V1) {
    return DEFAULT_EMBEDDING_DIM_V1;
  }
  return rounded;
}

/**
 * Look a model up by its canonical id or any alias. Matching is
 * case-insensitive and exact, never substring: `bge-small-en` must not match
 * `bge-small-en-v1.5`, whose vectors differ.
 */
export function findEmbeddingModelSpecV1(model: string): EmbeddingModelSpecV1 | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  for (const entry of EMBEDDING_MODEL_CATALOG_V1) {
    if (entry.id.toLowerCase() === normalized) {
      return entry;
    }
    if (entry.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return entry;
    }
  }
  return null;
}

export type EffectiveEmbeddingDimReasonV1 =
  | "matryoshka_truncation"
  | "native_dimension"
  | "unknown_model";

export interface EffectiveEmbeddingDimV1 {
  /** The width every vector must have, and the width the index is built at. */
  dim: number;
  /** Whether the helper may apply the layer-norm / truncate / L2 recipe. */
  matryoshka: boolean;
  nativeDim: number | null;
  reason: EffectiveEmbeddingDimReasonV1;
}

/**
 * Turn the user's dimension setting into what the runtime must actually do.
 *
 * - A Matryoshka model honours the setting, capped at its native width.
 * - Any other known model ignores the setting and uses its native width, because
 *   truncating it would corrupt every similarity score.
 * - An unknown model gets the setting as given and no truncation; the provider
 *   rejects the response if the width does not match, so a wrong guess fails at
 *   the settings probe rather than inside a mission.
 */
export function resolveEffectiveEmbeddingDimV1(
  model: string,
  requestedDim: unknown,
): EffectiveEmbeddingDimV1 {
  const requested = normalizeEmbeddingDimSettingV1(requestedDim);
  const found = findEmbeddingModelSpecV1(model);
  if (!found) {
    return {
      dim: requested,
      matryoshka: false,
      nativeDim: null,
      reason: "unknown_model",
    };
  }
  if (found.matryoshka) {
    return {
      dim: Math.min(requested, found.nativeDim),
      matryoshka: true,
      nativeDim: found.nativeDim,
      reason: "matryoshka_truncation",
    };
  }
  return {
    dim: found.nativeDim,
    matryoshka: false,
    nativeDim: found.nativeDim,
    reason: "native_dimension",
  };
}

/** Catalogue entries a settings dropdown should offer, shipped default first. */
export function listEmbeddingModelChoicesV1(): readonly EmbeddingModelSpecV1[] {
  return EMBEDDING_MODEL_CATALOG_V1;
}
