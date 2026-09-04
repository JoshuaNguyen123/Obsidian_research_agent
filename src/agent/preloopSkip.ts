/**
 * Host-owned pre-loop skip: avoid authority classify + graph-planner model
 * calls when the prompt is already obvious to the host.
 *
 * Decision source for AgentRunner (one-line wire) and for
 * `modelPhaseRouting.resolveStructuredPreloopDecision`. Existing routing
 * callers pick this up by consulting that helper before the structured
 * router / planner round-trips.
 */

import { classifyMissionSpeechAct } from "./missionSpeechAct";
import {
  hasCurrentPageWritebackIntent,
  hasDeleteIntent,
  hasEditIntent,
  hasGeneratedWritingIntent,
  hasStaticGenerationIntent,
  hasWebSearchIntent,
  isPromptOnCurrentPageIntent,
} from "./promptIntentClassifiers";
import { hasReplaceIntent } from "./replaceIntent";
import { matchesSourcesOrWebLanguageV1 } from "./sourceIntent";

/** Metric A fixture. Host-obvious target-only write; no sources or edit. */
export const TARGET_ONLY_ESSAY_FIXTURE_PROMPT =
  "Write a 300-word essay into this note";

export type PreloopSkipReason =
  | "target_only_write"
  | "direct_chat"
  | "prompt_on_page"
  | "none";

export interface PreloopSkipInput {
  prompt: string;
  /** Active-note markdown. Required to extract a prompt-on-page instruction. */
  noteMarkdown?: string | null;
}

export interface PreloopSkipDecision {
  skipClassifyAndPlan: boolean;
  reason: PreloopSkipReason;
  /** Prompt the host should classify. Extracted note prompt wins for prompt-on-page. */
  routingPrompt: string;
  /** Wrapper "run the prompt on this page" never goes to the structured router. */
  skipWrapperRouter: boolean;
  /** Host classifies the extracted (or original) prompt at most once. */
  classifyCount: 0 | 1;
  /** Reflex / semantic embed at most once after the extracted prompt is known. */
  embedCount: 0 | 1;
  extractedPrompt: string | null;
  skipCurrentNotePrefetch: boolean;
  /** Structured router + graph planner model calls this decision would spend. */
  preloopModelCalls: 0 | 2;
}

export function isHostObviousTargetOnlyWrite(prompt: string): boolean {
  const value = prompt.trim();
  if (!value) {
    return false;
  }
  if (
    matchesSourcesOrWebLanguageV1(value) ||
    hasWebSearchIntent(value) ||
    hasEditIntent(value) ||
    hasReplaceIntent(value) ||
    hasDeleteIntent(value)
  ) {
    return false;
  }

  const generated =
    hasGeneratedWritingIntent(value) ||
    hasStaticGenerationIntent(value) ||
    hasCurrentPageWritebackIntent(value);
  const appendOnly =
    /\bappend\b/iu.test(value) &&
    !/\b(?:edit|revise|rewrite|replace|delete|sources?|web|search)\b/iu.test(
      value,
    );

  return generated || appendOnly;
}

export function isHostObviousDirectChat(prompt: string): boolean {
  return classifyMissionSpeechAct(prompt).executionTier === "direct_chat";
}

/**
 * Wider than AgentRunner's private target-only omit: generate-into-empty
 * and append-only writes must not prefetch `read_current_file`.
 */
export function shouldSkipCurrentNotePrefetch(prompt: string): boolean {
  const value = prompt.trim();
  if (!value) {
    return false;
  }
  if (isHostObviousTargetOnlyWrite(value)) {
    return true;
  }
  const generateIntoEmpty =
    /\b(?:empty|blank|new)\s+(?:note|page|file|document)\b/iu.test(value) &&
    (hasGeneratedWritingIntent(value) ||
      hasStaticGenerationIntent(value) ||
      hasCurrentPageWritebackIntent(value));
  if (generateIntoEmpty && !matchesSourcesOrWebLanguageV1(value)) {
    return true;
  }
  return (
    /\bappend\b/iu.test(value) &&
    !hasEditIntent(value) &&
    !hasReplaceIntent(value) &&
    !matchesSourcesOrWebLanguageV1(value)
  );
}

export function extractPromptOnPageInstruction(
  markdown: string | null | undefined,
): string | null {
  if (!markdown || !markdown.trim()) {
    return null;
  }
  const withoutFrontmatter = markdown.replace(
    /^---\r?\n[\s\S]*?\r?\n---\r?\n/u,
    "",
  );
  const lines = withoutFrontmatter.split(/\r?\n/u);
  const collected: string[] = [];

  for (const line of lines) {
    if (
      isGeneratedOutputBoundaryHeading(line) &&
      collected.some((item) => item.trim())
    ) {
      break;
    }
    collected.push(line);
  }

  const extracted = collected.join("\n").trim();
  return extracted || withoutFrontmatter.trim() || null;
}

export function resolvePreloopSkip(
  input: PreloopSkipInput,
): PreloopSkipDecision {
  const prompt = input.prompt.trim();
  const extracted = isPromptOnCurrentPageIntent(prompt)
    ? extractPromptOnPageInstruction(input.noteMarkdown)
    : null;
  const routingPrompt = extracted ?? prompt;

  if (isPromptOnCurrentPageIntent(prompt)) {
    return {
      skipClassifyAndPlan: true,
      reason: "prompt_on_page",
      routingPrompt,
      skipWrapperRouter: true,
      classifyCount: 1,
      embedCount: 1,
      extractedPrompt: extracted,
      skipCurrentNotePrefetch: shouldSkipCurrentNotePrefetch(routingPrompt),
      preloopModelCalls: 0,
    };
  }

  if (isHostObviousDirectChat(prompt)) {
    return {
      skipClassifyAndPlan: true,
      reason: "direct_chat",
      routingPrompt,
      skipWrapperRouter: true,
      classifyCount: 1,
      embedCount: 0,
      extractedPrompt: null,
      skipCurrentNotePrefetch: true,
      preloopModelCalls: 0,
    };
  }

  if (isHostObviousTargetOnlyWrite(prompt)) {
    return {
      skipClassifyAndPlan: true,
      reason: "target_only_write",
      routingPrompt,
      skipWrapperRouter: true,
      classifyCount: 1,
      embedCount: 0,
      extractedPrompt: null,
      skipCurrentNotePrefetch: true,
      preloopModelCalls: 0,
    };
  }

  return {
    skipClassifyAndPlan: false,
    reason: "none",
    routingPrompt,
    skipWrapperRouter: false,
    classifyCount: 1,
    embedCount: 1,
    extractedPrompt: null,
    skipCurrentNotePrefetch: shouldSkipCurrentNotePrefetch(prompt),
    preloopModelCalls: 2,
  };
}

/** Metric A: structured classify + graph planner, or neither. */
export function measurePreloopModelCalls(input: PreloopSkipInput): 0 | 2 {
  return resolvePreloopSkip(input).preloopModelCalls;
}

function isGeneratedOutputBoundaryHeading(line: string): boolean {
  const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  if (!match) {
    return false;
  }
  return /\b(?:output|draft|essay|answer|response|result|generated)\b/iu.test(
    match[1],
  );
}
