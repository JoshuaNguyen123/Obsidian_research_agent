/**
 * One source-language family for "wants fetched/public sources or the web".
 *
 * This file is a leaf: regexes only, no classifier imports. Route, proof
 * gate, generated policy, effort, and catalog wrap these with their own
 * no-web / literary / vault-scope gates so a static-generation short-circuit
 * cannot contradict the proof gate by using a narrower `cite sources`
 * matcher than everyone else.
 *
 * Possessive and paraphrase forms the adjacent-token regex historically
 * missed: "cite your sources", "include sources", "back this up with sources".
 */

/**
 * In code missions, "source files" / "source code" name deliverables, not
 * public-web evidence. Strip those artifact phrases before a remaining
 * "source" is read as research intent.
 */
export function withoutCodeSourceArtifactsV1(prompt: string): string {
  return prompt.replace(
    /\bsource(?:\s+code|\s+files?|\s+and\s+tests?\s+files?)\b/giu,
    " ",
  );
}

const FETCHED_WEB_SOURCE_LANGUAGE =
  /\b(?:cited\s+sources?|cite\s+sources?|citations?|source\s+urls?|bibliography|reference\s+list|verified\s+sources?|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?)|cite(?:d)?\s+at\s+least\b[\s\S]{0,60}\bsources?|(?:scholarly|academic|peer[-\s]?reviewed)\s+(?:and\s+(?:academic|scholarly)\s+)?sources?|cite(?:s|d)?\s+(?:your|my|our|the|its)\s+sources?|(?:include|add|provide|list|give|attach)\s+(?:a\s+)?(?:list\s+of\s+)?(?:your\s+|the\s+|my\s+|our\s+)?sources?|list\s+of\s+sources?|back\s+(?:this|it|that|me)\s+up\s+with\s+sources?|(?:with|using)\s+(?:(?:your|my|our|the|its|cited|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)*(?:cited\s+)?sources?|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+sources?)\b/i;

const PUBLIC_WEB_LANGUAGE =
  /https?:\/\/|\b(?:web|online|internet)\b/iu;

/**
 * Bare source/cite language after code-artifact stripping. Seats that already
 * handle literary / no-web / vault-scope themselves call this. The routed
 * `hasFetchedWebSourceIntent` wraps the same pattern with those gates.
 */
export function matchesFetchedWebSourceLanguageV1(prompt: string): boolean {
  return FETCHED_WEB_SOURCE_LANGUAGE.test(withoutCodeSourceArtifactsV1(prompt));
}

/**
 * Source language or an explicit public-network cue. Effort and the loop
 * planner use this so "cite your sources" and "search the web" share one
 * vocabulary.
 */
export function matchesSourcesOrWebLanguageV1(prompt: string): boolean {
  const stripped = withoutCodeSourceArtifactsV1(prompt);
  return (
    FETCHED_WEB_SOURCE_LANGUAGE.test(stripped) || PUBLIC_WEB_LANGUAGE.test(stripped)
  );
}
