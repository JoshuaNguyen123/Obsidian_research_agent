export type RepositoryVisibility = "public" | "private";

export type ExplicitRepositoryVisibilityChoiceV1 =
  | {
      status: "chosen";
      visibility: RepositoryVisibility;
    }
  | {
      status: "waiting";
      code: "waiting_for_repository_visibility";
      message: string;
    };

/**
 * Resolve only a visibility choice made in the current user prompt.
 *
 * This intentionally does not choose a safer-looking default. A tool/model
 * argument is checked separately and cannot manufacture publication authority.
 */
export function resolveExplicitRepositoryVisibilityChoiceV1(
  prompt: string,
): ExplicitRepositoryVisibilityChoiceV1 {
  const normalized = typeof prompt === "string"
    ? prompt.trim().toLowerCase()
    : "";
  if (!normalized) return waiting();

  const exact = /^(?:visibility\s*(?:is|=|:)?\s*)?(public|private)[.!]?$/u.exec(
    normalized,
  );
  if (exact) {
    return { status: "chosen", visibility: exact[1] as RepositoryVisibility };
  }

  const withoutNegatedVisibility = stripNegatedVisibilityMentions(normalized);
  const publicChosen = hasRepositoryVisibilityPhrase(
    withoutNegatedVisibility,
    "public",
  );
  const privateChosen = hasRepositoryVisibilityPhrase(
    withoutNegatedVisibility,
    "private",
  );
  if (publicChosen === privateChosen) return waiting();
  return {
    status: "chosen",
    visibility: publicChosen ? "public" : "private",
  };
}

/**
 * Remove visibility words that occur inside a local negation. Negating one
 * visibility is not authority to choose the other: "do not make it public"
 * and "never use a private repository" both remain unresolved until the user
 * makes an affirmative choice.
 */
function stripNegatedVisibilityMentions(value: string): string {
  return value
    .replace(
      /\b(?:do\s+not|don't|never|not|isn't|is\s+not|shouldn't|should\s+not|mustn't|must\s+not|cannot|can't)\s+(?:(?:make|set|choose|select|use|create|publish|keep)\s+|be\s+)?(?:(?:it|this|that|the|a|an|github|repository|repo|destination)\s+){0,5}(?:as\s+)?(?:public|private)\b/gu,
      " ",
    )
    .replace(
      /\b(?:public|private)\s+(?:github\s+)?(?:repository|repo|destination)\s+(?:is|should|must|will)\s+(?:not|never)\b/gu,
      " ",
    );
}

export function repositoryVisibilityFromReadback(
  value: { private: boolean; visibility?: "private" | "public" | "internal" },
): RepositoryVisibility | null {
  if (value.visibility === "internal") return null;
  if (value.visibility === "private") {
    return value.private === true ? "private" : null;
  }
  if (value.visibility === "public") {
    return value.private === false ? "public" : null;
  }
  return value.private === true ? "private" : "public";
}

export function isRepositoryVisibility(value: unknown): value is RepositoryVisibility {
  return value === "public" || value === "private";
}

function hasRepositoryVisibilityPhrase(
  value: string,
  visibility: RepositoryVisibility,
): boolean {
  const escaped = visibility;
  const destinationNoun = "(?:github\\s+)?(?:repository|repo|destination)";
  return (
    new RegExp(
      `\\b(?:visibility\\s*(?:is|=|:)\\s*|make\\s+(?:it|the\\s+${destinationNoun})\\s+|create\\s+(?:it\\s+as\\s+|a\\s+)?|publish\\s+(?:it\\s+as\\s+|to\\s+a\\s+)?|use\\s+(?:a\\s+)?)(?:an?\\s+)?${escaped}\\b`,
      "u",
    ).test(value) ||
    // The visibility word must modify the destination noun (allowing a short
    // adjective run: "private GitHub destination", "private, issue-bound
    // repository"). Mere sentence co-occurrence — "public artifacts ... in
    // its repository" — is not a visibility choice; counting it as one made
    // legitimately private missions read as ambiguous and fail closed.
    new RegExp(
      `\\b${escaped}\\b(?:[,\\s-]+\\w+){0,3}?[,\\s-]+${destinationNoun}\\b`,
      "u",
    ).test(value) ||
    // The destination noun is predicated with the visibility: "repository
    // should be private", "repo stays public", "the destination is private".
    new RegExp(
      `\\b${destinationNoun}\\b(?:\\s+(?:is|are|as|be|being|should\\s+be|must\\s+be|will\\s+be|stays?|remains?|kept|set\\s+to|made))?\\s+(?:an?\\s+)?${escaped}\\b`,
      "u",
    ).test(value)
  );
}

function waiting(): ExplicitRepositoryVisibilityChoiceV1 {
  return {
    status: "waiting",
    code: "waiting_for_repository_visibility",
    message:
      "Should this GitHub repository be public or private? No GitHub mutation was performed.",
  };
}
