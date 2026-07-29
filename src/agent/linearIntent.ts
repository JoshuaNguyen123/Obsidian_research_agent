export interface LinearIntentDetection {
  explicit: boolean;
  reason:
    | "linear_url"
    | "linear_issue_identifier"
    | "linear_resource_phrase"
    | "linear_action_phrase"
    | "linear_tool_token"
    | "none";
  issueIdentifier?: string;
  url?: string;
}

const LINEAR_URL_PATTERN =
  /https:\/\/linear\.app\/[a-z0-9][a-z0-9/_-]*(?:\?[a-z0-9%&=._-]*)?/i;
const ISSUE_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*)\b/;
const ISSUE_UUID_PATTERN =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const LINEAR_RESOURCE_PATTERN =
  /\blinear\s+(?:(?:implementation|engineering|product|research)\s+)?(?:issue|issues|ticket|tickets|project|projects|initiative|initiatives|cycle|cycles|comment|comments|document|documents|milestone|milestones|customer|customers|queue|workspace)\b/i;
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

  // Missions that name Bound tools (`linear_create_issue`) are explicit even
  // when they omit prose like "Linear issue" / "create in Linear".
  if (/\blinear_[a-z][a-z0-9_]*\b/iu.test(withoutNonProductPhrases)) {
    return { explicit: true, reason: "linear_tool_token" };
  }

  return { explicit: false, reason: "none" };
}

/**
 * Extract the one provider identity the user explicitly authorized for an
 * existing-issue read. This is intentionally narrower than generic Linear
 * intent: a UUID or human identifier must be attached to "Linear issue", and
 * the surrounding clause must request a read/review/open/implementation handoff.
 */
export function extractExplicitLinearIssueReadIdentity(
  prompt: string,
): string | null {
  const normalized = prompt.replace(/\r\n?/g, "\n");
  if (!detectLinearIntent(normalized).explicit) return null;

  const resourcePattern =
    /\blinear\s+issue(?:\s+(?:id|identity))?\s*(?:[:#]\s*)?([A-Z][A-Z0-9]{1,15}-[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/giu;
  for (const match of normalized.matchAll(resourcePattern)) {
    const identity = match[1];
    if (!identity || match.index === undefined) continue;
    const prefix = normalized.slice(Math.max(0, match.index - 140), match.index);
    if (
      /\b(?:do\s+not|don't|never|without)\b[\s\S]{0,100}$/iu.test(prefix)
    ) {
      continue;
    }
    if (
      /\b(?:review|read|get|open|inspect|implement|execute|work\s+(?:from|on))\b[\s\S]{0,120}$/iu.test(
        prefix,
      ) ||
      /\blinear_get_issue\b/iu.test(normalized)
    ) {
      return ISSUE_UUID_PATTERN.test(identity)
        ? identity.toLowerCase()
        : identity.toUpperCase();
    }
  }
  return null;
}

/** Permanent deletion is never inferred from ordinary delete/trash wording. */
export function hasExplicitPermanentLinearDeleteIntent(prompt: string): boolean {
  const permanentDelete =
    /\b(?:permanently\s+(?:delete|remove)|(?:delete|remove)\s+permanently|hard[-\s]?delete|irreversibly\s+(?:delete|remove))\b/i.test(
      prompt,
    );
  return permanentDelete && detectLinearIntent(prompt).explicit;
}
