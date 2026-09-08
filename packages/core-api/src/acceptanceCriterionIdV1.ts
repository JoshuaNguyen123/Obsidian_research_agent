/**
 * The one definition of an acceptance-criterion id.
 *
 * Four separate validators each carried their own copy of `/^AC-[1-9][0-9]?$/`
 * (AcceptedResearchArtifactV1, AcceptedResearchNoteWriter, WorkItemSpecV1, and
 * ProjectIdeaBriefV1). Four copies of one rule is the precondition of the drift
 * this codebase keeps paying for, so the pattern, the canonical test, and the
 * tolerant normalizer all live here and every seat consumes them.
 *
 * The rule was also never COMMUNICATED. `create_project_idea_brief` declared
 * the id as a bare string with no pattern, no description and no example, then
 * rejected the call with "id must match AC-1 through AC-99". A real compound
 * run burned a tool call discovering by failure a contract the schema could
 * simply have stated -- the model behaved correctly given what it was told.
 *
 * Hence both halves of the fix: publish the pattern in the schema, and accept
 * the obvious spellings of the same intent. Lenient at the boundary, canonical
 * in storage -- a normalized id is stored as `AC-<n>` and nothing downstream
 * ever sees the variant form.
 *
 * It lives in core-api rather than beside the Linear seats because the fourth
 * seat, ProjectIdeaBriefV1, is a provider-neutral core-api contract: core-api
 * is consumed by the plugin, by every extension package, and by the headless
 * runtime, and it deliberately imports nothing from the plugin source tree.
 * The lowest layer that all four seats can reach is therefore the only place
 * one shared predicate can actually live. `src/integrations/linear/
 * acceptanceCriterionIdV1.ts` re-exports this module so the three Linear seats
 * keep their existing import path.
 */

/** JSON-Schema `pattern` for the canonical form. Published to the model. */
export const ACCEPTANCE_CRITERION_ID_PATTERN_V1 = "^AC-[1-9][0-9]?$";

/** Human-readable contract, published to the model beside the pattern. */
export const ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1 =
  'Stable criterion id in the exact form "AC-<n>", numbered from 1 with no ' +
  'leading zeros: "AC-1", "AC-2", ... "AC-99". Ids must be unique within the ' +
  "list.";

const CANONICAL_ACCEPTANCE_CRITERION_ID = /^AC-[1-9][0-9]?$/u;

/**
 * Accepts the spellings a model reasonably produces for the same intent, and
 * NOTHING else. Every accepted form maps to exactly one canonical id, so this
 * cannot silently merge two distinct criteria -- and callers keep their
 * duplicate check, which now runs over canonical ids and therefore catches
 * "AC-1" and "ac-01" colliding, which four separate regexes could not.
 *
 * Deliberately NOT accepted, because each is ambiguous rather than a variant
 * spelling: "AC-0" and "AC-100" (outside the stated range), a bare "0",
 * anything with interior punctuation beyond one optional hyphen, and any form
 * carrying extra words ("criterion 1", "AC-1: text").
 */
export function normalizeAcceptanceCriterionIdV1(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  // Whitespace only -- never strip characters that could change identity.
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (CANONICAL_ACCEPTANCE_CRITERION_ID.test(trimmed)) {
    return trimmed;
  }
  // `AC1`, `ac-1`, `AC-01`, and a bare `1` are the observed and predictable
  // variants. The optional hyphen and optional leading zeros are the only
  // latitude; the prefix, when present, must be exactly AC.
  const match = /^(?:AC[-\s]?)?0*([1-9][0-9]?)$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const ordinal = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 99) {
    return null;
  }
  return `AC-${ordinal}`;
}

/** True only for the exact canonical form. Storage-side check. */
export function isCanonicalAcceptanceCriterionIdV1(
  value: unknown,
): value is string {
  return (
    typeof value === "string" && CANONICAL_ACCEPTANCE_CRITERION_ID.test(value)
  );
}
