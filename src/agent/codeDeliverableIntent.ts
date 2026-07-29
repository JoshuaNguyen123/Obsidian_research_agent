/**
 * Shared code-deliverable intent gate. AgentRunner (required-ladder
 * derivation) and runPlan (route derivation) must agree on what counts as a
 * standalone code deliverable, so this is the single source of truth for both
 * — previously each kept a drifting private copy.
 */

/** Note-local sample write/stream — not a repository/code-workspace deliverable. */
export function hasCurrentNoteCodeSampleWriteSurface(prompt: string): boolean {
  return (
    /\b(?:on|to|into|in)\s+(?:this|the|current|active)\s+(?:page|note|file)\b/i.test(
      prompt,
    ) || /\bstream(?:\s+it)?\s+to\s+(?:the\s+)?note\b/i.test(prompt)
  );
}

/**
 * Explicit negative code-creation authority. A structured/router proposal may
 * clarify an ambiguous request, but it cannot override a user prohibition on
 * authoring code in the current phase merely because the prompt describes a
 * later code outcome.
 *
 * Validation, execution, and commit constraints are deliberately not treated
 * as a prohibition on authoring the artifact. For example, "implement the
 * package without committing it" still grants bounded file-creation authority.
 */
export function hasExplicitCodeExecutionProhibition(prompt: string): boolean {
  return prompt
    .split(/(?:[!?;\r\n]+|\.(?=\s|$))/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      const directCreationProhibition =
        /\b(?:do\s+not|don't|never)\s+(?:(?:yet|now|currently)\s+)?(?:(?:start|begin|attempt|proceed)\s+(?:to\s+)?)?(?:implement|write|create|modify|edit|patch|refactor)\s+(?:(?:any|the|this|that|a|an)\s+)?(?:code|implementation|program|script|module|library|package|repository|repo|workspace|worktree)\b/iu.exec(
          clause,
        );
      if (directCreationProhibition) {
        const suffix = clause.slice(
          directCreationProhibition.index +
            directCreationProhibition[0].length,
        );
        // "Never implement code without tests" is a quality condition, not a
        // blanket refusal to author the requested code.
        if (/^\s+(?:without|unless)\b/iu.test(suffix)) {
          return false;
        }
        return true;
      }
      return (
        /\bwithout\s+(?:implementing|writing|creating|modifying|editing|patching|refactoring)\s+(?:(?:any|the|this|that|a|an)\s+)?(?:code|implementation|program|script|module|library|package|repository|repo|workspace|worktree)\b/iu.test(
          clause,
        ) ||
        /\b(?:code\s+implementation|implementation|coding|code\s+work)\b[\s\S]{0,60}\b(?:out\s+of\s+scope|forbidden|prohibited|disallowed)\b/iu.test(
          clause,
        )
      );
    });
}

export function hasCodeDeliverableIntent(prompt: string): boolean {
  if (hasCurrentNoteCodeSampleWriteSurface(prompt)) {
    return false;
  }
  // A later clause can describe the future executable artifact, repository
  // binding, or validation profile without authorizing Code work in this turn.
  // The explicit current-phase prohibition is therefore a whole-prompt ceiling,
  // not merely a clause-local exception to individual positive matches.
  if (hasExplicitCodeExecutionProhibition(prompt)) {
    return false;
  }
  const clauses = prompt
    .split(/(?:[!?;\r\n]+|\.(?=\s|$))/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  if (
    clauses.some(
      (clause) =>
        !hasExplicitCodeExecutionProhibition(clause) &&
        /\.(?:py|ts|tsx|js|jsx|rs|go|java|cs)\b/i.test(clause),
    )
  ) {
    return true;
  }
  return clauses.some((clause) => {
    if (hasExplicitCodeExecutionProhibition(clause)) {
      return false;
    }
    // A vault research path such as Projects/Checkers/Research.md is not a
    // request to implement checkers merely because "write" and "Checkers"
    // occur in the same sentence.
    if (/\.md\b/iu.test(clause)) {
      return false;
    }
    // "explain how to create X" asks for prose, not a deliverable.
    if (
      /\b(?:explain|describe|show|tell)\b[\s\S]{0,40}\bhow\s+to\b/i.test(
        clause,
      ) ||
      /\bhow\s+to\s+(?:build|implement|create|write|make|code)\b/i.test(
        clause,
      )
    ) {
      return false;
    }
    // "write notes about the game design" writes prose whose TOPIC is a
    // deliverable noun; the direct object is a vault document, not code.
    if (
      /\b(?:build|implement|create|write|make|code|generate|save)\s+(?:a\s+|the\s+|some\s+|your\s+|my\s+)?(?:note|notes|memo|summar(?:y|ies)|essay|report|brief|document|documentation)\b/i.test(
        clause,
      )
    ) {
      return false;
    }
    // "save"/"generate" are ordinary ways to ask for the same deliverable —
    // "save a tic tac toe game in Python to my Documents folder" routed to no
    // code tools at all before they were listed here.
    return (
      /\b(?:build|implement|create|write|make|generate|save)\s+(?:(?:the|this|that|a|an|some|new|working|production|actual)\s+){0,3}(?:code|program|implementation)\b/i.test(
        clause,
      ) ||
      /\b(build|implement|create|write|make|generate|save)\b[\s\S]{0,100}\b(game|app|script|module|library|package|checkers|chess|solver)\b/i.test(
        clause,
      ) ||
      /\b(build|implement|create|write|code|make|generate|save)\b[\s\S]{0,120}\b(python|javascript|typescript|rust|golang|java)\b/i.test(
        clause,
      )
    );
  });
}
