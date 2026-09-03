/**
 * Shared embedding vector math. Previously triplicated in semanticIndex,
 * semanticSearchTools, and the reflex intentRouter; one copy keeps the
 * normalized-score scale identical across every consumer.
 */

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude <= 0 || rightMagnitude <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

/** Euclidean norm of a vector (0 for an empty or all-zero vector). */
export function vectorNorm(vector: ArrayLike<number>): number {
  let total = 0;
  for (let index = 0; index < vector.length; index += 1) {
    total += vector[index]! * vector[index]!;
  }
  return Math.sqrt(total);
}

/**
 * Cosine similarity between a query and one row of a flat, row-major matrix,
 * without slicing the row out and without recomputing the query's norm for
 * every row. Same value as `cosineSimilarity(query, row)` (pinned to six
 * decimals by tests); this is the form the semantic scan uses over a decoded
 * shard, where the old per-row `slice` allocated a fresh array per row and
 * the old kernel spent a third of its work recomputing the query norm.
 */
export function cosineSimilarityAt(
  matrix: ArrayLike<number>,
  offset: number,
  dim: number,
  query: ArrayLike<number>,
  queryNorm: number,
): number {
  const length = Math.min(dim, query.length, Math.max(0, matrix.length - offset));
  if (length === 0 || queryNorm <= 0) {
    return 0;
  }
  let dot = 0;
  let rowMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const value = matrix[offset + index]!;
    dot += value * query[index]!;
    rowMagnitude += value * value;
  }
  if (rowMagnitude <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(rowMagnitude) * queryNorm);
}

/** Maps raw cosine [-1, 1] onto [0, 1]; thresholds across the app use this scale. */
export function normalizeCosine(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}
