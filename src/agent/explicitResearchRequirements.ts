/**
 * What the request itself says it wants: a source count and a distinct-domain
 * count, read out of the prompt.
 *
 * `researchPlan.ts` states the precedence rule for sources — "an explicit count
 * in the prompt, the model's topic judgment, the configured default. A user who
 * names a number means it." Two subsystems downstream never got to apply that
 * rule, because the numbers were parsed inside the research planner and nothing
 * else could reach them without importing it:
 *
 * - The **domain floor** was derived from the effort tier alone
 *   (`minDistinctDomainsForEffort`), so "at least 3 sources from at least 2
 *   domains" was planned as three domains at deep tier. On 2026-09-14 the
 *   real-web lane fetched three sources across two domains — exactly what was
 *   asked — sat at `distinct_domains:2/3`, spent its last six steps hunting a
 *   third domain, and delivered nothing.
 * - The **loop budget** (`loopPlanner.ts`) gave every grounded mission a flat
 *   five tool steps regardless of how many sources it owed, and the only way
 *   past it was the phrase "deep research", which jumps straight to the hard
 *   cap. A three-source cited summary needs a search, three fetches, three
 *   reads and three verifications before it can write a word.
 *
 * Both now read the requirement from here, so the number the user typed and the
 * number the product plans against cannot drift apart.
 */

const NUMBER_WORDS_V1: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

/** Upper bound on any explicit count; beyond this the request is not literal. */
const MAX_EXPLICIT_COUNT_V1 = 8;

/**
 * Sources a grounded mission owes when the request names no number. This is the
 * research planner's own default, shared so the loop budget sizes itself
 * against the same contract the planner will enforce.
 */
export const DEFAULT_MIN_FETCHED_SOURCES_V1 = 3;

function toCount(token: string | undefined): number | null {
  if (!token) return null;
  const parsed = NUMBER_WORDS_V1[token] ?? Number(token);
  return Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= MAX_EXPLICIT_COUNT_V1
    ? parsed
    : null;
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

export function parseExplicitResearchSourceCount(prompt: string): number | null {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return null;
  if (
    /\bboth\s+(?:returned\s+|fetched\s+|owned\s+)*(?:sources?|passages?)\b/u.test(
      normalized,
    )
  ) {
    return 2;
  }
  const match =
    /\b(?:exactly\s+|at\s+least\s+|use(?:\s+and\s+fetch)?\s+|fetch\s+|from\s+)?(one|two|three|four|five|six|seven|eight|\d{1,2})\s+(?:distinct\s+|independent\s+|returned\s+|fetched\s+|owned\s+|focused\s+|web\s+)*(?:sources?(?:\s+domains?)?|passages?)\b/u.exec(
      normalized,
    );
  return toCount(match?.[1]);
}

/**
 * A distinct-domain count the request names in its own right.
 *
 * Deliberately narrower than the source parser: it matches only a count that
 * modifies "domains", "sites", "publishers" or "outlets". "3 sources" says
 * nothing about domains — three sources can share one — so a bare source count
 * must NOT be read as a domain count, and "at least 3 sources from at least 2
 * domains" has to yield 2 here while yielding 3 from the source parser.
 *
 * `sources domains` ("3 distinct source domains") is the one phrasing where a
 * single number means both; the source parser already claims it, and this
 * parser claims it too so the pair agrees.
 */
export function parseExplicitResearchDomainCount(prompt: string): number | null {
  const normalized = normalizePrompt(prompt);
  if (!normalized) return null;
  const match =
    /\b(?:exactly\s+|at\s+least\s+|across\s+|from\s+|spanning\s+|use\s+)?(one|two|three|four|five|six|seven|eight|\d{1,2})\s+(?:distinct\s+|independent\s+|separate\s+|different\s+|unique\s+|source\s+|web\s+)*(?:domains?|sites?|websites?|publishers?|outlets?)\b/u.exec(
      normalized,
    );
  return toCount(match?.[1]);
}

/**
 * Tool steps a grounded research mission needs before it can write.
 *
 * Per source the ladder spends a fetch, a section read and a verification, on
 * top of one discovery search and the final write. The `+ sources` term is
 * retry margin at the loop level: a fetch that returns a consent interstitial
 * or a 404 costs a step and the mission has to choose another URL, which is
 * what exhausted both missions in the 2026-09-14 lane.
 *
 * This is a CAP, not a target — the loop stops as soon as the mission's
 * acceptance is satisfied (`stopWhenSatisfied`), so a mission that finishes in
 * four steps still finishes in four.
 */
export function groundedToolStepBudgetForSourcesV1(sources: number): number {
  const owed = Math.max(1, Math.min(MAX_EXPLICIT_COUNT_V1, Math.trunc(sources)));
  return 2 + 4 * owed;
}
