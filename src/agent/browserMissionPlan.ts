import { hasExplicitNoWebIntent } from "./evidenceIntent";
import { hasBrowserAutomationIntent } from "./promptIntentClassifiers";
import { matchesFetchedWebSourceLanguageV1 } from "./sourceIntent";

/**
 * A browser ask plans its own page open.
 *
 * `browser_open_page` is an execution-effect tool (action "execute"), and the mission graph holds only the tool nodes the host
 * plans: the web ladder for a web-evidence ask, note nodes for a note-output ask, and whatever `selectExplicitEffectfulGraphTools`
 * finds, which plans an effectful tool only when every token of its descriptor's action is in the prompt. A prompt that says
 * "open the page https://… and tell me the heading" therefore planned `web_search` + `web_fetch` and no open at all. The frontier
 * (ready nodes plus read-effect envelope tools) then offered `browser_observe` / `browser_extract_markdown`, which read a blank page.
 *
 * A prompt that has browser intent AND names an http(s) address owes the open, then the page's text. `browser_extract_markdown`
 * already counts as a fetched web source (`missionEvidence`), so it pays the evidence the address implies and the web ladder is not
 * also owed — unless the ask itself wants research beyond the page.
 *
 * ONE seat decides this: the loop planner's expected tools, the graph's planned tool list, the web ladder and the web-tool
 * requirement (`getMissingRequiredWebToolNames`, the operation goals) all read it, so the budget, the graph and the proof debt
 * cannot disagree. It reads the prompt only, never a tool's effect, so a host that reports the
 * page open as a read plans the same graph.
 */

const PAGE_ADDRESS = /\bhttps?:\/\/[^\s<>"'`)\]]+/iu;

/** Research the page alone cannot pay: the ask wants the web searched, or sources found and cited. */
const RESEARCH_BEYOND_THE_PAGE =
  /\b(?:research(?:ing)?|search\s+(?:the\s+)?(?:web|internet|online)|(?:web|online|internet)\s+search|search\s+for|look\s+up|find\s+(?:more\s+)?(?:sources?|articles?|pages?)|other\s+(?:sources?|sites?|pages?))\b/iu;

export const BROWSER_NAVIGATION_TOOL_NAMES_V1: readonly string[] = [
  "browser_open_page",
  "browser_extract_markdown",
];

/**
 * The open and the read a browser ask with an address owes, or nothing. Prompt-only: whether the tools exist and may run is the
 * caller's (`browserNavigationPlanV1`).
 */
export function plannedBrowserNavigationToolNamesV1(prompt: string): string[] {
  if (hasExplicitNoWebIntent(prompt)) return [];
  if (!hasBrowserAutomationIntent(prompt)) return [];
  if (!PAGE_ADDRESS.test(prompt)) return [];
  return [...BROWSER_NAVIGATION_TOOL_NAMES_V1];
}

/** True when the ask wants more than the page: the web ladder stays beside the open. */
export function asksForResearchBeyondThePageV1(prompt: string): boolean {
  return RESEARCH_BEYOND_THE_PAGE.test(prompt) || matchesFetchedWebSourceLanguageV1(prompt);
}

export interface BrowserNavigationPlanV1 {
  /** The tools the mission owes for its page, in order; empty when the ask does not owe an open. */
  toolNames: string[];
  /** The page's text pays the web evidence the address implies, so the web ladder is not planned. */
  replacesWebLadder: boolean;
}

const NO_BROWSER_NAVIGATION: BrowserNavigationPlanV1 = { toolNames: [], replacesWebLadder: false };

/**
 * The plan for this run. The tools must be on the run's menu and the browser must be allowed to run: with browser tools off the
 * safety policy refuses every call, so an ask that mentions the browser keeps the web ladder it had before.
 */
export function browserNavigationPlanV1(input: {
  prompt: string;
  browserToolsEnabled: boolean;
  offeredToolNames: Iterable<string>;
}): BrowserNavigationPlanV1 {
  if (!input.browserToolsEnabled) return NO_BROWSER_NAVIGATION;
  const offered = new Set(input.offeredToolNames);
  const toolNames = plannedBrowserNavigationToolNamesV1(input.prompt);
  if (toolNames.length === 0 || !toolNames.every((name) => offered.has(name))) return NO_BROWSER_NAVIGATION;
  return { toolNames, replacesWebLadder: !asksForResearchBeyondThePageV1(input.prompt) };
}
