/**
 * Single-cause health for one vault retrieval, and the honest sentence to show
 * for it.
 *
 * `semantic_search_notes` already reports the truth in its payload — `mode`
 * flips to `lexical_fallback`, `fallbackUsed` goes true, and `fallbackReason`
 * names the exact runtime failure. Nothing surfaced any of it. Settings kept
 * showing semantic search as "on", the runner's only reaction was one status
 * line that read "sampled, truncated, fallback, or low confidence" — four
 * different problems in one sentence, none of them actionable — and the user
 * believed they had received conceptual search over their notes when they had
 * received keyword matching.
 *
 * Two rules make that honest:
 *
 *  1. **One cause, by precedence.** Embeddings being unavailable is not the
 *     same problem as a result set being truncated, and reporting them
 *     together tells the user to do nothing in particular. A degraded engine
 *     outranks a degraded result set, because fixing the engine is what
 *     changes the answer.
 *  2. **Say what broke and what fixes it.** A cause the user can act on
 *     carries its own setup action; a cause they cannot act on carries none
 *     rather than inventing busywork.
 *
 * Deliberately pure and I/O-free: it reads a tool payload and returns a
 * verdict. Probing the embedding runtime is the caller's job, so the same
 * verdict can be replayed from a durable ledger and score identically.
 */

export type SemanticRetrievalStatusV1 = "ok" | "degraded" | "blocked";

export type SemanticRetrievalCauseV1 =
  | "healthy"
  | "embeddings_not_installed"
  | "embedding_runtime_unavailable"
  | "embedding_call_failed"
  | "no_matches"
  | "results_truncated"
  | "results_sampled";

export interface SemanticRetrievalOutcomeV1 {
  /** `hybrid_semantic` / `indexed_semantic` / `lexical_fallback`, when reported. */
  mode: string | null;
  fallbackUsed: boolean;
  /** The embedding provider's failure code, when it failed. */
  fallbackReason: string | null;
  resultCount: number;
  coverageConfidence: "high" | "medium" | "low" | null;
  coverageTruncated: boolean;
}

export interface SemanticRetrievalHealthV1 {
  status: SemanticRetrievalStatusV1;
  /** Exactly one cause. Never a list, never "a, b, or c". */
  cause: SemanticRetrievalCauseV1;
  /** One user-facing sentence. */
  message: string;
  /** Imperative fix, or null when there is nothing for the user to do. */
  setupAction: string | null;
  /**
   * True when this retrieval must not be the sole basis for an answer: the
   * caller owes a keyword search and a real body read before writing.
   */
  requiresKeywordCorroboration: boolean;
  /** True when semantic scoring did not happen at all. */
  semanticScoringUsed: boolean;
}

/** Modes that mean real embedding similarity actually ran. */
const SEMANTIC_MODES = new Set(["hybrid_semantic", "indexed_semantic"]);

/**
 * Provider codes that mean the embedding runtime is absent or unusable rather
 * than that one call went wrong. These are worth a setup action; a transient
 * failure is not.
 */
const RUNTIME_ABSENT_CODES = new Set([
  "missing_python",
  "spawn_error",
  "node_runtime_unavailable",
]);

export function setupActionForCauseV1(
  cause: SemanticRetrievalCauseV1,
): string | null {
  return SETUP_ACTIONS[cause] ?? null;
}

const SETUP_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  embeddings_not_installed:
    "Install FastEmbed with: python -m pip install fastembed",
  embedding_runtime_unavailable:
    "Set a working Python command in Settings → Semantic retrieval, then retry.",
});

export function readSemanticRetrievalOutcomeV1(
  output: unknown,
): SemanticRetrievalOutcomeV1 | null {
  if (!isRecord(output)) return null;
  const coverage = isRecord(output.coverage) ? output.coverage : null;
  const confidence = coverage ? asString(coverage.confidence) : null;
  return {
    mode: asString(output.mode),
    fallbackUsed: output.fallbackUsed === true,
    fallbackReason: asString(output.fallbackReason),
    // `resultCount` is the tool's own summary field, but a payload that
    // carried results without it was read as zero and classified
    // `no_matches` -- a healthy search then demanded corroboration it did not
    // need. The results array is the ground truth; the summary field is a
    // convenience.
    resultCount: Math.max(
      asCount(output.resultCount),
      Array.isArray(output.results) ? output.results.length : 0,
    ),
    coverageConfidence:
      confidence === "high" || confidence === "medium" || confidence === "low"
        ? confidence
        : null,
    coverageTruncated: coverage?.truncated === true,
  };
}

export function classifySemanticRetrievalHealthV1(
  outcome: SemanticRetrievalOutcomeV1,
): SemanticRetrievalHealthV1 {
  // Precedence, strongest first. A fallback that also truncated is a fallback:
  // installing embeddings changes the answer, narrowing the query does not.
  if (outcome.fallbackUsed || outcome.mode === "lexical_fallback") {
    const cause = classifyFallbackCause(outcome.fallbackReason);
    const setupAction = SETUP_ACTIONS[cause] ?? null;
    return {
      // Only a missing/unusable runtime is worth calling blocked: the user can
      // fix it and the fix changes every future vault search. A one-off failed
      // call is degraded — retrying may well succeed.
      status: setupAction ? "blocked" : "degraded",
      cause,
      message:
        "Semantic embeddings unavailable — using keyword search, so these results match wording rather than meaning.",
      setupAction,
      requiresKeywordCorroboration: true,
      semanticScoringUsed: false,
    };
  }

  if (outcome.resultCount <= 0) {
    return {
      status: "degraded",
      cause: "no_matches",
      message: "Semantic search ran but matched no notes.",
      setupAction: null,
      requiresKeywordCorroboration: true,
      semanticScoringUsed: true,
    };
  }

  if (outcome.coverageTruncated) {
    return {
      status: "degraded",
      cause: "results_truncated",
      message:
        "Semantic search worked, but the result set was truncated — some matching notes were not considered.",
      setupAction: null,
      requiresKeywordCorroboration: false,
      semanticScoringUsed: true,
    };
  }

  if (outcome.coverageConfidence === "low") {
    return {
      status: "degraded",
      cause: "results_sampled",
      message:
        "Semantic search worked, but only a sample of the vault was scored.",
      setupAction: null,
      requiresKeywordCorroboration: false,
      semanticScoringUsed: true,
    };
  }

  return {
    status: "ok",
    cause: "healthy",
    message: "Semantic search scored the vault by meaning.",
    setupAction: null,
    requiresKeywordCorroboration: false,
    semanticScoringUsed: true,
  };
}

/**
 * True when a mission that asked for conceptual vault search did not get it.
 * The e2e gate for semantic honesty asserts on exactly this: a lane that
 * expects `hybrid_semantic` / `indexed_semantic` must fail, not pass quietly,
 * when the receipt says `lexical_fallback`.
 */
export function semanticModeSatisfiedV1(mode: string | null): boolean {
  return mode !== null && SEMANTIC_MODES.has(mode);
}

/**
 * Exported so a proactive probe classifies a provider failure the same way a
 * mid-run fallback does. Two vocabularies for one condition would let settings
 * and the runner disagree about what is wrong.
 */
export function classifyFallbackCause(
  reason: string | null,
): SemanticRetrievalCauseV1 {
  if (reason === "missing_fastembed") return "embeddings_not_installed";
  if (reason && RUNTIME_ABSENT_CODES.has(reason)) {
    return "embedding_runtime_unavailable";
  }
  return "embedding_call_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}
