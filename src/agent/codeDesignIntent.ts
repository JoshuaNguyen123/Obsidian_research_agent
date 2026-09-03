/**
 * Pure classifiers for code / design / HTML / revise / code-team-bridge intents.
 * Keep these regex-only so tools and routing can share one source of truth.
 */

const CODE_INTENT =
  /\b(run|execute|code|script|python|javascript|typescript|node|pip|npm|workspace|program|snippet)\b/i;

const DESIGN_ACTION =
  "create|make|draw|generate|build|draft|render|save|write|map|model|architect|package|update|revise|edit|change|modify|improve|tweak|fix|adjust|turn|convert|transform";

// Keep bare `graph` out of the general noun list so questions about the
// Obsidian note graph remain read-only. A graph becomes a design artifact when
// it is explicitly visual/design-qualified or content is converted into one.
const DESIGN_ARTIFACT =
  "canvas|design(?:\\s*package)?|wireframe|diagram|flowchart|layout|svg|mermaid|mockup|map|sketch|systems?\\s+charts?|user\\s*flows?|ui\\s*flows?|architecture|system\\s+design|software\\s+architecture|distributed(?:\\s+\\w+){0,3}\\s+systems?|cloud\\s+architecture|microservices?(?:\\s+architecture)?|event[-\\s]?driven\\s+architecture|c4\\s+(?:model|diagram)|network\\s+topology|data\\s+architecture|service\\s*blueprint|logistics\\s*system|business\\s+process(?:es)?|manufacturing(?:\\s+\\w+){0,2}\\s+process(?:es)?|production\\s+lines?|plant\\s+workflows?|value\\s+streams?|bpmn|sipoc|project\\s*ideation|mind\\s*map|(?:design|visual|concept|relationship|knowledge|idea|dependency|process)\\s+graph|graph\\s+(?:design|diagram|visualization|artifact)";

const DESIGN_INTENT = new RegExp(
  `\\b(?:${DESIGN_ACTION})\\b[\\s\\S]{0,160}\\b(?:${DESIGN_ARTIFACT})\\b|` +
    `\\b(?:${DESIGN_ARTIFACT})\\b[\\s\\S]{0,160}\\b(?:${DESIGN_ACTION})\\b|` +
    "\\b(?:turn|convert|transform)\\b[\\s\\S]{0,160}\\bgraph\\b",
  "i",
);

const EXPLICIT_CANVAS_DESTINATION_INTENT =
  /\b(?:put|place|move|send|turn|convert|transform)\b[\s\S]{0,160}\b(?:on|onto|in|into|as|to)\s+(?:an?\s+)?(?:obsidian\s+)?canvas\b|\b(?:want|need|prefer|would\s+like)\b[\s\S]{0,160}\b(?:on|onto|in|into|as)\s+(?:an?\s+)?(?:obsidian\s+)?canvas\b/i;

// HTML-preview intent had TWO definitions -- this one and a structurally
// different copy in `promptIntentClassifiers` -- and they INVERTED each other
// on the two most ordinary phrasings (audited 2026-08-26): "open the html
// file" was true here and false there, "show me the mockup" was true there and
// false here. Five of the eight witness prompts in the test split them
// (re-verified by execution, 2026-08-26, not by reading).
//
// The shared copy's SHAPE was the correct one and is adopted here: a viewing
// verb must sit near an artifact noun. The old local test was two independent
// unanchored regexes with `preview` in BOTH of them, so a bare "preview it"
// -- naming no artifact at all -- claimed HTML-preview capability, and any
// prompt that said "show" anywhere and "css" anywhere matched across
// unrelated sentences.
//
// The vocabulary is the union of the two: this copy's `display`/`open` verbs
// and one-word `webpage`, plus the shared copy's `mockup`/`prototype` nouns.
const HTML_PREVIEW_VERB = "preview|render|show|display|open";
const HTML_PREVIEW_ARTIFACT = "html|css|webpage|web\\s+page|mockup|prototype";

const HTML_PREVIEW_INTENT = new RegExp(
  `\\b(?:${HTML_PREVIEW_VERB})\\b[\\s\\S]{0,100}\\b(?:${HTML_PREVIEW_ARTIFACT})\\b|` +
    `\\b(?:${HTML_PREVIEW_ARTIFACT})\\b[\\s\\S]{0,100}\\b(?:${HTML_PREVIEW_VERB})\\b`,
  "i",
);

/**
 * STRIP-THEN-TEST. Both copies answered TRUE to "do not preview the html".
 * Closed-class fillers only, so an affirmative ask after a negated clause
 * ("do not edit it, just show the mockup") survives.
 */
const NEGATED_HTML_PREVIEW_CLAUSE = new RegExp(
  "\\b(?:no|not|without|avoid(?:ing)?|skip(?:ping)?|omit(?:ting)?|don'?t|do\\s+not|never)\\s+" +
    "(?:need\\s+(?:to|for)\\s+)?(?:bother\\s+(?:to|with)\\s+)?" +
    `(?:${HTML_PREVIEW_VERB}|previewing|rendering|showing|displaying|opening)\\s+` +
    "(?:the\\s+|a\\s+|an\\s+|any\\s+|it\\s+|me\\s+)*" +
    `(?:${HTML_PREVIEW_ARTIFACT})\\b`,
  "gi",
);

/** Exported for tests and for seats that want to show their work. */
export function stripNegatedHtmlPreviewClausesV1(value: string): string {
  return value.replace(NEGATED_HTML_PREVIEW_CLAUSE, " ");
}

const REVISE_DESIGN_INTENT =
  /\b(update|revise|edit|change|modify|improve|tweak|fix|adjust)\b[\s\S]{0,80}\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mermaid|mockup|map|sketch|block)\b|\b(canvas|design|wireframe|diagram|flowchart|layout|svg|mermaid|mockup|map|sketch|block)\b[\s\S]{0,80}\b(update|revise|edit|change|modify|improve|tweak|fix|adjust)\b/i;

// A grounded research-note mission frequently NAMES design-flavored subject
// matter ("the transformer architecture", "distributed systems") within reach
// of its note-writing verb, which satisfies DESIGN_INTENT even though the
// only requested deliverable is prose. Planting design capability for that
// prose schedules a write the research phase gate refuses, and the mission
// graph blocks terminally on the deferred create_design_* node (live lead
// continuations, 2026-08-24). The regexes and predicate below are the single
// shared authority for telling a design deliverable apart from design-flavored
// research topic prose; planner, loop budget, required-write selection, and
// continuation replans must all consult it so no two of them disagree.
const NARRATIVE_NOTE_DELIVERABLE =
  /\b(?:write|draft|compose|summari[sz]e)\b[\s\S]{0,120}\b(?:notes?|essay|summary|article|paragraphs?|report|write[-\s]?up)\b/i;

// Subject-matter nouns that satisfy DESIGN_INTENT when they sit near a
// write/draft verb, even though the user asked for a note about the topic
// rather than a canvas. "research|investigate" used to be required, so
// "write a note on transformer architecture" still planted design nodes.
const DESIGN_TOPIC_AS_SUBJECT =
  /\b(?:transformer\s+)?architecture\b|\bdistributed(?:\s+\w+){0,3}\s+systems?\b|\bsystem\s+design\b|\bsoftware\s+architecture\b|\bcloud\s+architecture\b|\bworking\s+memory\b/i;

// Vocabulary that names a visual artifact as the requested deliverable. Topic
// nouns that merely say what a mission is ABOUT (architecture, system design,
// distributed systems, business process, ...) are deliberately absent.
const EXPLICIT_DESIGN_ARTIFACT_REQUEST =
  /\b(?:canvas|diagrams?|flowcharts?|wireframes?|mockups?|svg|mermaid|sketch(?:es)?|storyboards?|design\s*packages?|service\s*blueprints?|bpmn|sipoc|c4\s+(?:model|diagram)|(?:mind|concept|process|dependency|visual|research)[-\s]*maps?|(?:user|ui)[-\s]*flows?|draw|design\s+(?:a|an|the)\s+\w+)\b/i;

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

/**
 * THE html-preview predicate. `promptIntentClassifiers` re-exports this one;
 * AgentRunner and runPlan reach it through that re-export, so route, frontier
 * and design tooling cannot disagree about it again.
 */
export function hasHtmlPreviewIntent(prompt: string): boolean {
  return HTML_PREVIEW_INTENT.test(stripNegatedHtmlPreviewClausesV1(prompt));
}

export function hasReviseDesignIntent(prompt: string): boolean {
  return REVISE_DESIGN_INTENT.test(prompt);
}

/**
 * True when a mission's design vocabulary is research subject matter rather
 * than a requested deliverable: the mission asks to research a topic and
 * write a narrative note about it, and never names a concrete visual
 * artifact. Such a mission must not acquire design capability — not on a
 * fresh plan and not on a continuation replan of the persisted original
 * mission.
 */
export function isResearchTopicDesignProse(prompt: string): boolean {
  if (EXPLICIT_DESIGN_ARTIFACT_REQUEST.test(prompt)) {
    return false;
  }
  if (hasExplicitCanvasDestinationIntent(prompt)) {
    return false;
  }
  if (!NARRATIVE_NOTE_DELIVERABLE.test(prompt)) {
    return false;
  }
  // A note about architecture / distributed systems / working memory is
  // subject matter whether or not the user also said "research". A genuine
  // design deliverable names a canvas, diagram, or similar artifact above.
  return hasDesignIntent(prompt) || DESIGN_TOPIC_AS_SUBJECT.test(prompt);
}

/**
 * Single authority for whether a mission's OWN prompt grants design
 * capability: it either names a design deliverable that is not research topic
 * prose, or it revises an existing design artifact. Required-write selection
 * and every continuation-replan merge must consult this same predicate so no
 * two of them disagree about whether create_design_* belongs in a plan.
 */
export function missionGrantsDesignCapability(prompt: string): boolean {
  return (
    (hasDesignIntent(prompt) && !isResearchTopicDesignProse(prompt)) ||
    hasReviseDesignIntent(prompt)
  );
}

// Design-capability tool names a mission may plan only when its own prompt
// grants design capability. Continuation replans filter persisted expected
// tools through this set so a mis-planned prior segment — or design
// vocabulary that exists only in researcher handoff/summary prose — cannot
// re-plant the refused design node.
const DESIGN_CAPABILITY_TOOL_NAMES = new Set([
  "create_design_canvas",
  "create_svg_design",
  "create_design_package",
  "update_design_canvas",
  "update_svg_design",
  "read_design_canvas",
  "read_svg_design",
  "read_mermaid_block",
  "upsert_mermaid_block",
]);

/** The same authority as the filter below, exposed for per-name callers such
 * as the resume-time mission graph prune. */
export function isDesignCapabilityToolName(toolName: string): boolean {
  return DESIGN_CAPABILITY_TOOL_NAMES.has(toolName);
}

/**
 * Filters planned/inherited tool names against the mission's own design
 * authority. Non-design tools always pass; a mission that genuinely requests
 * or revises a visual artifact passes unchanged. Design tools are dropped
 * both for research-topic design prose AND for missions with no design
 * vocabulary at all — inherited design capability the original mission never
 * planned can only be pollution. The mission prompt here must be the ORIGINAL
 * user mission (persisted as ledger mission / runtime originalMission), never
 * researcher handoff or summary prose.
 */
export function filterMissionDesignCapabilityTools(
  toolNames: readonly string[],
  missionPrompt: string,
): string[] {
  if (missionGrantsDesignCapability(missionPrompt)) {
    return [...toolNames];
  }
  return toolNames.filter((name) => !isDesignCapabilityToolName(name));
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
