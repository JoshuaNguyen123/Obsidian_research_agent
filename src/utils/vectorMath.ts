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

/** Maps raw cosine [-1, 1] onto [0, 1]; thresholds across the app use this scale. */
export function normalizeCosine(value: number): number {
  return Math.max(0, Math.min(1, (value + 1) / 2));
}
