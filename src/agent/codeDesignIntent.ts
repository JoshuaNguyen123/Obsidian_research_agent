/**
 * Pure classifiers for code / design / HTML / revise / code-team-bridge intents.
 * Keep these regex-only so tools and routing can share one source of truth.
 */

const CODE_INTENT =
  /\b(run|execute|code|script|python|javascript|typescript|node|pip|npm|workspace|program|snippet)\b/i;

const DESIGN_ACTION =
  "create|make|draw|generate|build|draft|render|save|write|map|package|update|revise|edit|change|modify|improve|tweak|fix|adjust|turn|convert|transform";

// Keep bare `graph` out of the general noun list so questions about the
// Obsidian note graph remain read-only. A graph becomes a design artifact when
// it is explicitly visual/design-qualified or content is converted into one.
const DESIGN_ARTIFACT =
  "canvas|design(?:\\s*package)?|wireframe|diagram|flowchart|layout|svg|mermaid|mockup|map|sketch|user\\s*flows?|ui\\s*flows?|architecture|system\\s+design|software\\s+architecture|service\\s*blueprint|logistics\\s*system|project\\s*ideation|mind\\s*map|(?:design|visual|concept|relationship|knowledge|idea|dependency|process)\\s+graph|graph\\s+(?:design|diagram|visualization|artifact)";

const DESIGN_INTENT = new RegExp(
  `\\b(?:${DESIGN_ACTION})\\b[\\s\\S]{0,160}\\b(?:${DESIGN_ARTIFACT})\\b|` +
    `\\b(?:${DESIGN_ARTIFACT})\\b[\\s\\S]{0,160}\\b(?:${DESIGN_ACTION})\\b|` +
    "\\b(?:turn|convert|transform)\\b[\\s\\S]{0,160}\\bgraph\\b",
  "i",
);

const EXPLICIT_CANVAS_DESTINATION_INTENT =
  /\b(?:put|place|move|send|turn|convert|transform)\b[\s\S]{0,160}\b(?:on|onto|in|into|as|to)\s+(?:an?\s+)?(?:obsidian\s+)?canvas\b|\b(?:want|need|prefer|would\s+like)\b[\s\S]{0,160}\b(?:on|onto|in|into|as)\s+(?:an?\s+)?(?:obsidian\s+)?canvas\b/i;

const HTML_PREVIEW_INTENT =
  /\b(html|css|webpage|web\s*page|preview)\b/i;

const REVISE_DESIGN_INTENT =
  /\b(update|revise|edit|change|modify|improve|tweak|fix|adjust)\b[\s\S]{0,80}\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch)\b|\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mockup|map|sketch)\b[\s\S]{0,80}\b(update|revise|edit|change|modify|improve|tweak|fix|adjust)\b/i;

const CODE_TEAM_MAGIC =
  /\b(code\s+team|coding\s+team|orchestrate\s+code|git\s+worktree)\b/i;

const CODE_TEAM_BRIDGE =
  /\b(repo(?:sitory)?|worktree|codebase|project|pull\s+request|pr\b|fix\s+(?:the\s+)?(?:bug|issue|code)|implement|repair|refactor|patch|edit|change|add|create|remove|rename|move|copy|test|validate|build|commit)\b/i;

const REPO_PATH_HINT =
  /(?:repository|repo)\s*:\s*(?:"[^"]+"|`[^`]+`|[^\r\n]+)/i;

export function hasCodeIntent(prompt: string): boolean {
  return CODE_INTENT.test(prompt);
}

export function hasDesignIntent(prompt: string): boolean {
  return (
    DESIGN_INTENT.test(prompt) ||
    EXPLICIT_CANVAS_DESTINATION_INTENT.test(prompt)
  );
}

export function hasExplicitCanvasDestinationIntent(prompt: string): boolean {
  return EXPLICIT_CANVAS_DESTINATION_INTENT.test(prompt);
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
 * Explicit repository path plus a coding intent. The host uses this only as a
 * capability gate: the core-owned agent loop must still prepare the exact
 * repository binding and obtain approval before the code extension creates a
 * worktree. No magic phrase grants authority.
 */
export function hasCodeTeamBridgeIntent(prompt: string): boolean {
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
  "Code work requires a trusted repository binding.",
  "Provide `repository: <path>` for a foreground mission, or select an existing repository profile.",
  "The exact worktree action will still require approval before any repository bytes change.",
].join(" ");
