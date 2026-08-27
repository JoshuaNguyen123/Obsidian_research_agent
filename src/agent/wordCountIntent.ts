/**
 * Word-count intent: the one answer to "did the user ask for a deterministic
 * count or length check of text?".
 *
 * This idea had SEVEN implementations. Four were named copies of the same
 * predicate, and six of the ten witness prompts below split them (re-verified
 * by execution, 2026-08-26, not by reading):
 *
 *   - `promptIntentClassifiers.hasWordCountIntent` -- the route/frontier seat.
 *     Alone in matching "how many words is this note?", the most natural
 *     phrasing of the request, and alone in matching "length check".
 *   - `loopPlanner`'s private copy -- decides whether the MissionGraph plants a
 *     `count_words` node. Alone with `evidenceIntent` in matching the gerund
 *     "counting the words"; missed "how many words" entirely.
 *   - `claimLedger`'s inline `verifiesGeneratedLength` -- suppresses passage-id
 *     claim debt for deterministic output checks.
 *   - `evidenceIntent`'s inline copy -- suppresses public-web proof debt for
 *     the same reason.
 *
 * Three more were anonymous, which is why no name-based census had ever found
 * them: an inline regex in `missionPlan` that adds the `word_count` PROOF
 * OBLIGATION, `missionAcceptance.requiresWordCountEvidence` that CHECKS it,
 * and the reflex path's `requiresWordCount` that decides COMPLETION. None of
 * those three matched the literal `count_words` tool token, so a mission could
 * be offered the tool and planted a node for it while owing no proof it ever
 * called it. Obligation and capability are now the same function, which is the
 * only arrangement that cannot deadlock.
 *
 * The disagreement was the classic shape: on "how many words is this note?"
 * the route offered `count_words` while the loop planner planted no node to
 * call it with, and neither suppression seat waived the evidence debt the
 * mission could never pay. Every seat now reads THIS predicate; what each does
 * with the answer stays its own policy.
 *
 * The affirmative surface is the union of all seven, because each copy's misses
 * were demonstrable bugs rather than deliberate narrowing, and the negation
 * strip below is what makes the union safe to take. Widening the three
 * obligation seats is safe in the direction that matters: the same predicate
 * now offers the tool, so an obligation can never outrun the capability.
 *
 * Leaf module by design: `evidenceIntent` is imported BY
 * `promptIntentClassifiers`, so the shared definition cannot live there
 * without a cycle.
 */

/**
 * STRIP-THEN-TEST. A lexical trigger cannot see negation, and this repo's
 * most-repeated regression is a classifier that fires on the phrasing that
 * forbids the very thing it detects. All four copies answered TRUE to "do not
 * count words", and two of them to "without counting words" -- arming a
 * count_words obligation out of an instruction not to count.
 *
 * Deliberately built from closed-class filler tokens rather than an
 * "anything within N characters" window: a window would swallow the affirmative
 * request in "do not summarize, count the words", which must stay TRUE.
 */
const NEGATED_WORD_COUNT_CLAUSE =
  /\b(?:no|not|without|avoid(?:ing)?|skip(?:ping)?|omit(?:ting)?|don'?t|do\s+not|never)\s+(?:me\s+)?(?:need\s+(?:to|for)\s+)?(?:bother\s+(?:to|with)\s+)?(?:tell\s+me\s+)?(?:includ(?:e|ing)\s+|report(?:ing)?\s+|give\s+(?:me\s+)?|provide\s+|add(?:ing)?\s+|mention(?:ing)?\s+|perform(?:ing)?\s+|do(?:ing)?\s+|run(?:ning)?\s+|us(?:e|ing)\s+)?(?:the\s+|a\s+|an\s+|any\s+)?(?:count_words\b|word\s*counts?\b|count(?:ing)?\s+(?:the\s+)?words?\b|how\s+many\s+words?\b|length\s+checks?\b|verif(?:y|ying)\s+(?:the\s+)?(?:generated\s+)?(?:note\s+)?(?:word\s+)?length\b)/gi;

const WORD_COUNT_INTENT =
  /\b(?:count_words|word\s*counts?|count(?:ing)?\s+(?:the\s+)?words?|how\s+many\s+words?|length\s+checks?|verif(?:y|ying)\s+(?:the\s+)?(?:generated\s+)?(?:note\s+)?(?:word\s+)?length)\b/iu;

/** Exported for tests and for seats that want to show their work. */
export function stripNegatedWordCountClausesV1(value: string): string {
  return value.replace(NEGATED_WORD_COUNT_CLAUSE, " ");
}

export function hasWordCountIntent(prompt: string): boolean {
  return WORD_COUNT_INTENT.test(stripNegatedWordCountClausesV1(prompt));
}
