export interface LinearIntentDetection {
  explicit: boolean;
  reason:
    | "linear_url"
    | "linear_issue_identifier"
    | "linear_resource_phrase"
    | "linear_action_phrase"
    | "none";
  issueIdentifier?: string;
  url?: string;
}

const LINEAR_URL_PATTERN =
  /https:\/\/linear\.app\/[a-z0-9][a-z0-9/_-]*(?:\?[a-z0-9%&=._-]*)?/i;
const ISSUE_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*)\b/;
const LINEAR_RESOURCE_PATTERN =
  /\blinear\s+(?:issue|issues|ticket|tickets|project|projects|initiative|initiatives|cycle|cycles|comment|comments|document|documents|milestone|milestones|customer|customers|queue|workspace)\b/i;
const LINEAR_ACTION_PATTERN =
  /\b(?:create|write|publish|open|read|get|find|search|list|update|edit|archive|unarchive|trash|delete|comment|link|unlink|execute|claim|complete|move)\b[\s\S]{0,100}\b(?:in|on|from|to)\s+linear\b/i;
const ISSUE_ACTION_PATTERN =
  /\b(?:open|read|get|find|search|update|edit|comment|execute|claim|complete|archive|unarchive|trash|delete)\b/i;

/**
 * Detects explicit Linear product intent without treating ordinary uses of the
 * word "linear" (for example linear algebra or a local template filename) as
 * authority to expose external-system tools.
 */
export function detectLinearIntent(prompt: string): LinearIntentDetection {
  const normalized = prompt.replace(/\r\n?/g, "\n");
  const url = normalized.match(LINEAR_URL_PATTERN)?.[0];
  if (url) {
    return { explicit: true, reason: "linear_url", url };
  }

  const withoutLocalPaths = normalized.replace(
    /(?:[a-z0-9 .@()[\]_-]+\/)+[a-z0-9 .@()[\]_-]*linear[a-z0-9 .@()[\]_-]*\.md\b/gi,
    " ",
  );
  const withoutNonProductPhrases = withoutLocalPaths.replace(
    /\blinear\s+algebra\b/gi,
    " ",
  );

  const issueIdentifier = withoutNonProductPhrases.match(
    ISSUE_IDENTIFIER_PATTERN,
  )?.[1];
  if (issueIdentifier && ISSUE_ACTION_PATTERN.test(withoutNonProductPhrases)) {
    return {
      explicit: true,
      reason: "linear_issue_identifier",
      issueIdentifier,
    };
  }

  if (LINEAR_RESOURCE_PATTERN.test(withoutNonProductPhrases)) {
    return { explicit: true, reason: "linear_resource_phrase" };
  }

  if (LINEAR_ACTION_PATTERN.test(withoutNonProductPhrases)) {
    return { explicit: true, reason: "linear_action_phrase" };
  }

  return { explicit: false, reason: "none" };
}

/** Permanent deletion is never inferred from ordinary delete/trash wording. */
export function hasExplicitPermanentLinearDeleteIntent(prompt: string): boolean {
  const permanentDelete =
    /\b(?:permanently\s+(?:delete|remove)|(?:delete|remove)\s+permanently|hard[-\s]?delete|irreversibly\s+(?:delete|remove))\b/i.test(
      prompt,
    );
  return permanentDelete && detectLinearIntent(prompt).explicit;
}
