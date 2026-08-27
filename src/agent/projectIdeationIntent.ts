/**
 * One definition of "this mission affirmatively asks for native project
 * ideation", shared by every seat that needs the answer.
 *
 * It lived in two places: `promptIntentClassifiers.hasProjectIdeationIntent`
 * decided whether `create_project_idea_brief` is OFFERED and whether the graph
 * PLANS it, while `researchPublicationTool.hasAffirmativeProjectIdeationIntentV1`
 * decided whether `publish_research_to_linear` REQUIRES the resulting signed
 * promotion seed. The bodies were byte-for-byte identical, and the publication
 * copy documented itself as "kept local to avoid a routing-module cycle" —
 * which is real: promptIntentClassifiers imports researchPublicationTool.
 *
 * A leaf module (the same shape as codeDeliverableIntent, researchDepthIntent,
 * and linearIntent) breaks the cycle without keeping two copies. That matters
 * here more than usual: the offering seat and the requiring seat are the two
 * halves of one obligation, and this repo has repeatedly shipped the failure
 * where a planner and its own gate answer the same question differently —
 * `offered ⊄ gate-accepted`, and the node dies on `tool_failure_repeated`
 * (see missionRouter.ts and researchProjectHierarchyTool.ts for two prior
 * instances). Drift between these two copies would produce exactly that.
 */
export function hasAffirmativeProjectIdeationIntentV1(prompt: string): boolean {
  const normalized = typeof prompt === "string"
    ? prompt.replace(/\r\n?/gu, "\n")
    : "";
  if (/\bcreate_project_idea_brief\b/iu.test(normalized)) return true;
  return normalized
    .split(/(?:[!?;\n]+|\.(?=\s|$)|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some(
      (clause) =>
        // Strip-then-test. The negation vocabulary previously knew only
        // do not|don't|never|skip|without, so "no project ideation", "avoid
        // project ideation" and "rather than brainstorming project ideas" all
        // slipped through and claimed ideation on a prompt that forbade it.
        // Extended here to the closed-class refusals that actually appear;
        // `no` is anchored to the ideation nouns so it cannot swallow an
        // unrelated "no" earlier in the clause. This is deliberately the
        // NEGATION half only -- the positive triggers are separately
        // over-eager (a bare "compare the leading concepts" matches), but
        // narrowing those changes which tools real missions are OFFERED and
        // needs its own proof run. Firing less on an explicitly negated prompt
        // is strictly more correct and cannot strand a mission that asked.
        !/\b(?:do\s+not|don't|never|skip|without|avoid|refrain\s+from|rather\s+than|instead\s+of|no\s+need\s+(?:for|to))\b[^.\n]{0,100}\b(?:ideat|brainstorm|project\s+(?:idea|concept|direction))\w*/iu.test(
          clause,
        ) &&
        !/\bno\s+(?:project\s+)?(?:ideation|brainstorm\w*|project\s+ideas?)\b/iu.test(
          clause,
        ) &&
        (/\bproject\s+ideation\b/iu.test(clause) ||
          /\b(?:ideat\w*|brainstorm|generate|develop|evaluate|compare|select|choose)\b[^.\n]{0,140}\b(?:project\s+)?(?:ideas?|concepts?|directions?)\b/iu.test(
            clause,
          ) ||
          /\b(?:project\s+)?(?:ideas?|concepts?|directions?)\b[^.\n]{0,140}\b(?:ideat\w*|brainstorm|generate|develop|evaluate|compare|select|choose)\b/iu.test(
            clause,
          )),
    );
}
