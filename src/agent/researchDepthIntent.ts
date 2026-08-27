/**
 * Research-depth intents: the one answer to "did the user ask for a DEEP
 * research mission?" and the one answer to "does this mission need a LONG
 * budget?".
 *
 * These are two different questions and stay two predicates. What they may not
 * be is four predicates:
 *
 *   - `hasDeepResearchIntent` had two definitions -- the shared one in
 *     `promptIntentClassifiers` and a private copy in `researchPlan` -- and six
 *     of the ten witness prompts in the test split them (re-verified by
 *     execution, 2026-08-26, not by reading). `researchPlan`
 *     was WIDER on the sustained/multi-source family ("long research on X",
 *     "compare sources on Z", "evidence ledger for W", "multi-source review",
 *     "long-running research"); the shared copy was wider on "serious
 *     research". Neither difference was deliberate: the extra terms name the
 *     same idea in both directions, so the union below is the reconciliation
 *     and `researchPlan` now imports it.
 *   - `hasLongResearchIntent` had two BYTE-IDENTICAL definitions, shared and
 *     private in `loopPlanner`. Latent drift, deduped here before it became the
 *     next live one.
 *
 * The two predicates stay separate on purpose. `hasLongResearchIntent` is a
 * BUDGET signal and deliberately carries operational vocabulary that says
 * nothing about research depth -- `checkpoint`, `broad constraints`,
 * `long-running`, bare `investigate`/`strategy`. Feeding those to
 * `hasDeepResearchIntent` would route a resume-from-checkpoint prompt to
 * `deep_web`, which is precisely the failure `researchPlan`'s copy avoided by
 * excluding them. Same-shaped names, different questions -- as with
 * `shouldRequireQuoteSpans` (requirement, prompt-driven) versus
 * `shouldVerifyQuoteSpansV1` (verification, tier-driven).
 *
 * Leaf module by design: `researchPlan`, `loopPlanner` and
 * `promptIntentClassifiers` all consume these, and a leaf can never cycle.
 */

const DEEP_RESEARCH_VOCABULARY =
  "deep\\s+research|long\\s+research|in[-\\s]?depth\\s+(?:research|analysis|investigation)|deep\\s+dive|thorough\\s+research|comprehensive\\s+research|serious\\s+research|multi[-\\s]?source\\s+(?:research|review|comparison)|compare\\s+sources?|evidence\\s+ledger|long[-\\s]?running\\s+research";

const DEEP_RESEARCH_INTENT = new RegExp(`\\b(?:${DEEP_RESEARCH_VOCABULARY})\\b`, "i");

const LONG_RESEARCH_INTENT =
  /\b(deep\s+research|long\s+research|in-depth\s+research|deep\s+dive|investigate|compare\s+sources|multi[-\s]?source|strategy|broad\s+constraints|evidence\s+ledger|checkpoint|long[-\s]?running)\b/i;

/**
 * STRIP-THEN-TEST. "do not do deep research" answered TRUE in BOTH copies
 * before this landed -- a lexical trigger arming the exact mission shape the
 * sentence forbids. Built from closed-class filler tokens rather than a
 * character window, so an affirmative request that merely follows a negated
 * clause ("do not summarize, do a deep dive") survives.
 */
const NEGATED_RESEARCH_DEPTH_CLAUSE = new RegExp(
  "\\b(?:no|not|without|avoid(?:ing)?|skip(?:ping)?|omit(?:ting)?|don'?t|do\\s+not|never)\\s+" +
    "(?:need\\s+(?:to|for)\\s+)?(?:bother\\s+(?:to|with)\\s+)?" +
    "(?:do(?:ing)?\\s+|perform(?:ing)?\\s+|run(?:ning)?\\s+|conduct(?:ing)?\\s+|start(?:ing)?\\s+|us(?:e|ing)\\s+)?" +
    "(?:the\\s+|a\\s+|an\\s+|any\\s+)?" +
    `(?:${DEEP_RESEARCH_VOCABULARY}|compar(?:e|ing)\\s+sources?|investigat(?:e|ing|ion)|strateg(?:y|ic))\\b`,
  "gi",
);

/** Exported for tests and for seats that want to show their work. */
export function stripNegatedResearchDepthClausesV1(value: string): string {
  return value.replace(NEGATED_RESEARCH_DEPTH_CLAUSE, " ");
}

/** Did the user name a deep / sustained / multi-source research mission? */
export function hasDeepResearchIntent(prompt: string): boolean {
  return DEEP_RESEARCH_INTENT.test(stripNegatedResearchDepthClausesV1(prompt));
}

/** Does this mission need a long step budget / the slow path? */
export function hasLongResearchIntent(prompt: string): boolean {
  return LONG_RESEARCH_INTENT.test(stripNegatedResearchDepthClausesV1(prompt));
}
