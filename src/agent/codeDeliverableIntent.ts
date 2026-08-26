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

/**
 * Executable-notebook deliverable: a Jupyter/IPython notebook the user wants
 * AUTHORED and EXECUTED as an artifact — "create a Jupyter notebook … run its
 * cells … deliver it". This is THE shared notebook predicate: it feeds
 * hasCodeDeliverableIntent positively (so the route, the required code
 * ladder, mission-intent classification, and the streamed-writeback fast path
 * all inherit notebook recognition through the predicate they already share),
 * and hasJupyterReflectionIntentV1 / the lifecycle reflection stage consume it
 * negatively (a notebook that must execute is Code-workspace territory, not a
 * prose reflection appended to a vault notebook). Before it existed, the
 * notebook-execution lane's mission carried no recognized code vocabulary at
 * all and completed vacuously as a single current-note append.
 *
 * Deliberately narrow: the notebook must be explicitly Jupyter-flavored
 * (jupyter / ipython / .ipynb — bare "notebook" prose stays a vault noun),
 * the notebook itself must be the created object (reflection verbs such as
 * append/record and reflection objects such as "write the final reflection to
 * a Jupyter notebook" do not match), and the prompt must carry an execution
 * or computational-content signal.
 */
export function hasExecutableNotebookDeliverableIntent(
  prompt: string,
): boolean {
  if (hasCurrentNoteCodeSampleWriteSurface(prompt)) {
    return false;
  }
  if (hasExplicitCodeExecutionProhibition(prompt)) {
    return false;
  }
  if (!/\b(?:jupyter|ipython)\b|\.ipynb\b/iu.test(prompt)) {
    return false;
  }
  // The notebook (not a reflection/summary written INTO one) is the direct
  // object of a creation/delivery verb.
  const notebookIsCreatedObject =
    /\b(?:build|implement|create|write|make|generate|produce|author|deliver)\s+(?:(?:a|an|the|this|that|one|new|fresh|small|simple|full|complete|working|executable|python)\s+){0,4}(?:jupyter|ipython)\s+notebooks?\b/iu.test(
      prompt,
    ) ||
    /\b(?:build|implement|create|write|make|generate|produce|author|deliver)\b[^.!?;\r\n]{0,40}\.ipynb\b/iu.test(
      prompt,
    );
  if (!notebookIsCreatedObject) {
    return false;
  }
  return (
    // "run its cells", "execute the notebook", "re-run the kernel" …
    /\b(?:run|running|re-?run|execute[ds]?|executing)\b[^.!?;\r\n]{0,80}\b(?:cells?|notebooks?|kernels?)\b/iu.test(
      prompt,
    ) ||
    /\b(?:cells?|kernels?)\b[^.!?;\r\n]{0,80}\b(?:run|running|re-?run|execute[ds]?|executing|outputs?)\b/iu.test(
      prompt,
    ) ||
    // "… that computes the first 12 Fibonacci numbers"
    /\b(?:that|which|to|and)\s+(?:computes?|calculates?|plots?|prints?|solves?|simulates?|trains?|analy[sz]es?)\b/iu.test(
      prompt,
    ) ||
    // "the saved notebook contains … real outputs / executed outputs"
    /\b(?:executed|real|computed|cell)\s+outputs?\b|\bexecution\s+counts?\b/iu.test(
      prompt,
    )
  );
}

export function hasCodeDeliverableIntent(prompt: string): boolean {
  if (hasCurrentNoteCodeSampleWriteSurface(prompt)) {
    return false;
  }
  // An executable notebook is a standalone code deliverable even though it
  // names no language, no code file extension, and no game/app/script noun.
  if (hasExecutableNotebookDeliverableIntent(prompt)) {
    return true;
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
