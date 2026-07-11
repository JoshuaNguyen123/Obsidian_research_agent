/**
 * Pure classifiers for code / design / HTML / revise / code-team-bridge intents.
 * Keep these regex-only so tools and routing can share one source of truth.
 */

const CODE_INTENT =
  /\b(run|execute|code|script|python|javascript|typescript|node|pip|npm|workspace|program|snippet)\b/i;

const DESIGN_INTENT =
  /\b(create|make|draw|generate|build|draft|render|save|write|update|revise|edit|change)\b[\s\S]{0,120}\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flow|architecture)\b|\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch|user\s*flow|architecture)\b[\s\S]{0,120}\b(create|make|draw|generate|build|draft|render|save|write|update|revise|edit|change)\b/i;

const HTML_PREVIEW_INTENT =
  /\b(html|css|webpage|web\s*page|preview)\b/i;

const REVISE_DESIGN_INTENT =
  /\b(update|revise|edit|change|modify|improve|tweak|fix|adjust)\b[\s\S]{0,80}\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch)\b|\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch)\b[\s\S]{0,80}\b(update|revise|edit|change|modify|improve|tweak|fix|adjust)\b/i;

const CODE_TEAM_MAGIC =
  /\b(code\s+team|coding\s+team|orchestrate\s+code|git\s+worktree)\b/i;

const CODE_TEAM_BRIDGE =
  /\b(repo(?:sitory)?|worktree|pull\s+request|pr\b|fix\s+(?:the\s+)?(?:bug|issue|code)|implement|patch)\b/i;

const REPO_PATH_HINT =
  /(?:repository|repo)\s*:\s*(?:"[^"]+"|`[^`]+`|[^\r\n]+)/i;

export function hasCodeIntent(prompt: string): boolean {
  return CODE_INTENT.test(prompt);
}

export function hasDesignIntent(prompt: string): boolean {
  return DESIGN_INTENT.test(prompt);
}

export function hasHtmlPreviewIntent(prompt: string): boolean {
  return HTML_PREVIEW_INTENT.test(prompt) &&
    /\b(preview|render|show|display|open)\b/i.test(prompt);
}

export function hasReviseDesignIntent(prompt: string): boolean {
  return REVISE_DESIGN_INTENT.test(prompt);
}

export function hasExplicitCodeTeamMagicPhrase(prompt: string): boolean {
  return CODE_TEAM_MAGIC.test(prompt);
}

/**
 * Repo path + fix/implement intent without the explicit code-team magic phrase.
 * Callers must clarify and never auto-create a worktree.
 */
export function hasCodeTeamBridgeIntent(prompt: string): boolean {
  if (hasExplicitCodeTeamMagicPhrase(prompt)) {
    return false;
  }
  return REPO_PATH_HINT.test(prompt) && CODE_TEAM_BRIDGE.test(prompt);
}

export function extractRepositoryPathHint(prompt: string): string | null {
  const match = /(?:repository|repo)\s*:\s*(?:"([^"]+)"|`([^`]+)`|([^\r\n]+))/i.exec(
    prompt,
  );
  const path = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  return path || null;
}

export const CODE_TEAM_CLARIFY_TEMPLATE = [
  "I found a repository path and a coding/fix intent, but code-team worktrees require explicit approval.",
  "To run the isolated code team, resend with a magic phrase such as `code team` or `git worktree`, plus `repository: <path>`.",
  "I will not create a worktree or edit the repo until you confirm.",
].join(" ");
