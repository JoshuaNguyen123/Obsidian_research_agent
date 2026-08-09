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
  return (
    new RegExp(
      `\\b(?:visibility\\s*(?:is|=|:)\\s*|make\\s+(?:it|the\\s+(?:github\\s+)?(?:repository|repo|destination))\\s+|create\\s+(?:it\\s+as\\s+|a\\s+)?|publish\\s+(?:it\\s+as\\s+|to\\s+a\\s+)?|use\\s+(?:a\\s+)?)(?:an?\\s+)?${escaped}\\b`,
      "u",
    ).test(value) ||
    new RegExp(
      `\\b${escaped}\\b[^.\\n]{0,60}\\b(?:github\\s+)?(?:repository|repo|destination)\\b`,
      "u",
    ).test(value) ||
    new RegExp(
      `\\b(?:github\\s+)?(?:repository|repo|destination)\\b[^.\\n]{0,60}\\b${escaped}\\b`,
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
