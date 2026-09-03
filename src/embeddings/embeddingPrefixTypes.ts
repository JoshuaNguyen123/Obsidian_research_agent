/**
 * The prefix pair type lives apart from both the model catalogue and the
 * prefix resolver so the two can import each other's data without a module
 * cycle: the catalogue declares each model's pair, the resolver consults the
 * catalogue.
 */
export interface EmbeddingPrefixPairV1 {
  query: string;
  document: string;
}

export const NO_EMBEDDING_PREFIXES: EmbeddingPrefixPairV1 = Object.freeze({
  query: "",
  document: "",
});
