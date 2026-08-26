/**
 * Nullable-count helpers shared by every script that reports tool-call
 * metrics. ONE authority, by the same rule that split runPlan's 39 private
 * copies of the shared classifiers: a private copy in a consumer is a second
 * seat that will drift, and the drift mode here is exactly the bug family this
 * wave removes — unknown collapsing into an explicit zero.
 *
 * tests/toolCallCollector.test.ts guards against re-inlining.
 */

/** A non-negative safe integer, else null — unknown is never coerced to 0. */
export function nullableCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Sum nullable counts: null only when EVERY input is null; otherwise the sum
 * of the known values (an explicit lower bound, never a fabricated total).
 */
export function sumNullable(values) {
  let total = null;
  for (const value of values) {
    const parsed = nullableCount(value);
    if (parsed !== null) total = (total ?? 0) + parsed;
  }
  return total;
}
