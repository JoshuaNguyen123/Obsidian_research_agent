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

export function hasCodeDeliverableIntent(prompt: string): boolean {
  if (hasCurrentNoteCodeSampleWriteSurface(prompt)) {
    return false;
  }
  if (/\.(?:py|ts|tsx|js|jsx|rs|go|java|cs)\b/i.test(prompt)) {
    return true;
  }
  return prompt
    .split(/(?:[!?;\r\n]+|\.(?=\s|$))/u)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
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
        /\b(?:build|implement|create|write|make|code)\s+(?:a\s+|the\s+|some\s+|your\s+|my\s+)?(?:note|notes|memo|summar(?:y|ies)|essay|report|brief|document|documentation)\b/i.test(
          clause,
        )
      ) {
        return false;
      }
      return (
        /\b(build|implement|create|write|make)\b[\s\S]{0,100}\b(game|app|script|module|library|package|checkers|chess|solver)\b/i.test(
          clause,
        ) ||
        /\b(build|implement|create|write|code|make)\b[\s\S]{0,120}\b(python|javascript|typescript|rust|golang|java)\b/i.test(
          clause,
        )
      );
    });
}
