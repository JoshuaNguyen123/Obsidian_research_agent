/**
 * Retrieve before reading, on the prefetched-vault-answer fast path.
 *
 * That route answers "what do my notes say about X" without a tool loop: the
 * host reads vault context itself and hands it to the model in one turn. What
 * it read was `inspect_vault_context` — up to twelve markdown files, the first
 * 1200 characters of each, chosen by folder scope. Nothing in that selection
 * has anything to do with the question. The answer to a question about
 * retrieval scoring got the opening paragraphs of twelve files that happened
 * to sit in the scanned folders, and the note that actually answered it was
 * either not among them or was represented by its own front matter.
 *
 * The vault index this route ignored is built for exactly this: it ranks
 * chunks against the question, and under the shipped default a cross-encoder
 * re-reads the shortlist. So the route asks it first, and falls back to the
 * folder scan when there is no index, the index cannot answer, or the vault
 * has nothing relevant. The fallback matters — a vault with indexing disabled
 * must keep answering exactly as it does today.
 *
 * Fewer bytes, and the right ones: eight ranked spans at 800 characters is
 * 6.4k against the scan's 14.4k, and every one of them was selected because it
 * matched the question.
 */

/** Ranked spans to hand the model. Deliberately fewer than the scan's twelve. */
export const PREFETCH_RETRIEVAL_LIMIT_V1 = 8;
/**
 * Per-hit characters. The tool clamps this to the run's cap; asking for the
 * larger number means a hit that needs the room gets it, and the clamp decides
 * rather than this module guessing at the profile.
 */
export const PREFETCH_RETRIEVAL_SNIPPET_CHARS_V1 = 800;

export interface SemanticPrefetchResultV1 {
  path?: unknown;
  snippet?: unknown;
}

/**
 * Arguments for the semantic pass. `mode: "deep"` is stated rather than left
 * to inference: this is a question being answered from the vault, which is the
 * case the deep shortlist and the rerank stage exist for.
 */
export function buildSemanticVaultPrefetchArgsV1(
  prompt: string,
): Record<string, unknown> {
  return {
    query: prompt.trim(),
    limit: PREFETCH_RETRIEVAL_LIMIT_V1,
    maxSnippetChars: PREFETCH_RETRIEVAL_SNIPPET_CHARS_V1,
    mode: "deep",
  };
}

/**
 * Did the semantic pass return something worth answering from?
 *
 * Deliberately strict about substance rather than shape: a payload of empty
 * snippets is a successful call and a useless context, and handing it to the
 * model in place of the folder scan would be a regression disguised as a
 * feature. Anything unrecognised is treated as unusable, so a payload change
 * degrades to the old path instead of to an empty answer.
 */
export function semanticVaultPrefetchIsUsableV1(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const results = (output as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return false;
  return results.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const { path, snippet } = entry as SemanticPrefetchResultV1;
    return (
      typeof path === "string" &&
      path.trim().length > 0 &&
      typeof snippet === "string" &&
      snippet.trim().length > 0
    );
  });
}
