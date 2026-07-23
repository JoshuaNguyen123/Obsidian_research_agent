import { hasDesignIntent } from "./codeDesignIntent";
import {
  isCurrentNoteEditOrganizeIntent,
  isNamedSectionEditIntent,
  isWholeNoteEditIntent,
} from "./editOrganizeIntent";
import { detectExplicitReplaceIntent } from "./noteOutputPolicy";
import { hasPrimaryTextCitationIntent } from "./evidenceIntent";

export type GeneratedOutputKind =
  | "essay"
  | "how_to"
  | "explanation"
  | "diagram"
  | "general";

export type GeneratedOutputTarget =
  | "current_note_append"
  | "current_note_replace"
  | "design_canvas"
  | "chat_only";

export interface GeneratedWordTarget {
  target: number;
  exact: boolean;
  tolerancePct: number;
  /**
   * When true (bare "N word essay" without about/approximately), the draft
   * must reach at least `target` words. Overage still uses tolerancePct.
   */
  floorAtTarget: boolean;
}

export function resolveWordCountBounds(wordTarget: GeneratedWordTarget): {
  min: number;
  max: number;
} {
  if (wordTarget.exact || wordTarget.tolerancePct <= 0) {
    return { min: wordTarget.target, max: wordTarget.target };
  }
  const band = Math.max(
    1,
    Math.round(wordTarget.target * (wordTarget.tolerancePct / 100)),
  );
  if (wordTarget.floorAtTarget) {
    return {
      min: wordTarget.target,
      max: wordTarget.target + band,
    };
  }
  return {
    min: Math.max(1, wordTarget.target - band),
    max: wordTarget.target + band,
  };
}

/**
 * User follow-ups that ask to lengthen an under-target draft. These must
 * replace/expand the existing note, not append a second essay.
 */
export function hasWordCountShortfallFollowUp(prompt: string): boolean {
  return (
    /\b(?:still\s+(?:isn'?t|is\s+not|aren'?t)|isn'?t|is\s+not|not\s+(?:yet\s+)?|under|below|short\s+of|needs?\s+to\s+be|make\s+it|expand(?:\s+it)?\s+to|lengthen|too\s+short)\b[\s\S]{0,48}\b(\d{1,5})\s*words?\b/i.test(
      prompt,
    ) ||
    /\b(\d{1,5})\s*words?\b[\s\S]{0,48}\b(?:still\s+(?:isn'?t|is\s+not)|too\s+short|not\s+enough|under\s+(?:the\s+)?target)\b/i.test(
      prompt,
    ) ||
    /\b(?:essay|draft|note|piece|article)\b[\s\S]{0,48}\b(?:still\s+)?(?:isn'?t|is\s+not|too\s+short)\b[\s\S]{0,48}\b\d{1,5}\s*words?\b/i.test(
      prompt,
    ) ||
    /\bpartial draft under\b[\s\S]{0,48}\b\d{1,5}\s*words?\b/i.test(prompt)
  );
}

/**
 * After a mid-stream provider failure, Continue must expand the kept draft
 * instead of appending a second essay from the original write prompt.
 */
export function buildWordTargetExpansionResumePrompt(
  missionPrompt: string,
  wordTarget: number,
): string {
  const mission = missionPrompt.trim();
  const softBand = Math.max(1, Math.round(wordTarget * 0.05));
  const softMin = Math.max(1, wordTarget - softBand);
  const softMax = wordTarget + softBand;
  return [
    mission,
    "",
    `The current note already has a partial draft under ${wordTarget} words.`,
    `Expand that draft in place by editing and adding detail into the existing corpus until it reaches the soft ±5% band (${softMin}–${softMax} words; target ${wordTarget}).`,
    "Prefer deepening thin sections over rewriting from scratch. Replace the note with one full expanded essay; do not append a second essay.",
  ].join("\n");
}

export function shouldResumeWordTargetAsExpansion(input: {
  missionPrompt: string;
  noteWordCount: number;
  /** Ignore tiny stubs / empty notes. */
  minPartialWords?: number;
}): boolean {
  const policy = analyzeGeneratedOutputPrompt(input.missionPrompt);
  if (!policy.wordTarget) {
    return false;
  }
  const bounds = resolveWordCountBounds(policy.wordTarget);
  const minPartial = input.minPartialWords ?? 40;
  return (
    input.noteWordCount >= minPartial && input.noteWordCount < bounds.min
  );
}

export interface GeneratedOutputPolicy {
  kind: GeneratedOutputKind;
  target: GeneratedOutputTarget;
  requiresGrounding: boolean;
  requiresTextQuotes: boolean;
  wordTarget: GeneratedWordTarget | null;
}

export function analyzeGeneratedOutputPrompt(
  prompt: string,
): GeneratedOutputPolicy {
  const kind = getGeneratedOutputKind(prompt);
  const wordTarget = parseGeneratedWordTarget(prompt);
  const requiresTextQuotes = hasTextQuoteIntent(prompt);
  const primaryTextOnly =
    hasPrimaryTextCitationIntent(prompt) &&
    !/\b(?:web|online|internet|https?:\/\/|source\s+urls?|fact[-\s]?check|verify\s+(?:sources?|facts?|claims?)|real\s+events?|deep\s+research)\b/iu.test(
      prompt,
    );
  // Literary "quotes/citations from the text" still wants quote-rich prose,
  // but it is not public-web grounding debt.
  const requiresGrounding = primaryTextOnly
    ? false
    : requiresTextQuotes ||
      /\b(citations?|cited|cite|sources?|source\s+urls?|quotation|quotations|quotes?|text[-\s]?level|evidence|verify|fact[-\s]?check|real\s+events?)\b/i.test(
        prompt,
      );

  return {
    kind,
    target: getGeneratedOutputTarget(prompt, kind),
    requiresGrounding,
    requiresTextQuotes,
    wordTarget,
  };
}

export function isGeneratedWritingPrompt(prompt: string): boolean {
  const policy = analyzeGeneratedOutputPrompt(prompt);
  return (
    policy.kind === "essay" ||
    policy.kind === "how_to" ||
    policy.kind === "explanation" ||
    policy.kind === "general"
  ) && policy.target !== "chat_only";
}

function getGeneratedOutputKind(prompt: string): GeneratedOutputKind {
  if (hasDiagramIntent(prompt)) {
    return "diagram";
  }

  if (
    /\b(essay|article|paragraph|report|brief|write[-\s]?up)\b/i.test(prompt)
  ) {
    return "essay";
  }

  if (
    /\b(explain|explanation|teach|walk\s+me\s+through|diagonalization|grounded\s+examples?|examples?)\b/i.test(
      prompt,
    )
  ) {
    return "explanation";
  }

  if (
    /\b(how\s+to|tell\s+me\s+about\s+how|steps?|guide|tutorial|cook|recipe)\b/i.test(
      prompt,
    )
  ) {
    return "how_to";
  }

  if (
    /\b(generate|write|draft|compose|create)\b[\s\S]{0,100}\b(content|summary|analysis|answer|markdown|note)\b/i.test(
      prompt,
    ) ||
    /\b\d{1,5}\s*words?\b/i.test(prompt)
  ) {
    return "general";
  }

  return "general";
}

function getGeneratedOutputTarget(
  prompt: string,
  kind: GeneratedOutputKind,
): GeneratedOutputTarget {
  if (kind === "diagram") {
    return "design_canvas";
  }

  if (/\b(chat\s+only|only\s+in\s+chat|do\s+not\s+(?:write|append|save)\s+(?:to|in|into)\s+(?:the\s+)?(?:note|page|document|file))\b/i.test(prompt)) {
    return "chat_only";
  }

  // "The essay still isn't 5000 words" must expand in place, not append.
  if (hasWordCountShortfallFollowUp(prompt)) {
    return "current_note_replace";
  }

  // "revised 2000 word version" / revise-the-draft language must replace.
  if (
    /\b(revised|revise|revising|rewrite|rewriting)\b[\s\S]{0,80}\b(essay|draft|article|version|note|page)\b/i.test(
      prompt,
    ) ||
    /\b(essay|draft|article|version|note|page)\b[\s\S]{0,80}\b(revised|revise|revising|rewrite|rewriting)\b/i.test(
      prompt,
    )
  ) {
    return "current_note_replace";
  }

  if (shouldPreferWholeNoteReplace(prompt)) {
    return "current_note_replace";
  }

  if (
    /\b(replace|overwrite|rewrite|start\s+(?:fresh|cleanly)|reset|delete|remove|empty|edit\s+over)\b[\s\S]{0,180}\b(write|generate|draft|compose|create)\b|\b(write|generate|draft|compose|create)\b[\s\S]{0,180}\b(replace|overwrite|rewrite|start\s+(?:fresh|cleanly)|reset|delete|remove|empty|edit\s+over)\b|\bclear\s+(?:(?:the|this|active|current|whole|entire)\s+)?(?:note|page|document|file|contents?|body|text|writing)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i.test(
      prompt,
    )
  ) {
    return "current_note_replace";
  }

  if (
    /\b(generate|write|draft|compose|create|append|tell\s+me|walk\s+me\s+through|explain)\b/i.test(
      prompt,
    ) ||
    /\b\d{1,5}\s*words?\b/i.test(prompt) ||
    /\bstream(?:ing)?\s+writeback\b/i.test(prompt) ||
    /\bcited\s+findings\b/i.test(prompt)
  ) {
    return "current_note_append";
  }

  return "chat_only";
}

function shouldPreferWholeNoteReplace(prompt: string): boolean {
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }

  return (
    detectExplicitReplaceIntent(prompt) ||
    isWholeNoteEditIntent(prompt) ||
    isCurrentNoteEditOrganizeIntent(prompt)
  );
}

function hasDiagramIntent(prompt: string): boolean {
  return hasDesignIntent(prompt) ||
    /\b(draw|diagram|flowchart|canvas|blocks?|nodes?|map|wireframe|user\s*flows?|ui\s*flows?|architecture|system\s+design|software\s+architecture|service\s*blueprint|logistics\s*system|project\s*ideation|mind\s*map|design\s*package)\b/i.test(
      prompt,
    );
}

function hasTextQuoteIntent(prompt: string): boolean {
  return /\b(text[-\s]?level|quotations?|quotes?|quoted|direct\s+text|passages?)\b/i.test(
    prompt,
  );
}

function parseGeneratedWordTarget(prompt: string): GeneratedWordTarget | null {
  const exact = /\b(exactly|precisely)\b/i.test(prompt);
  // Only treat about/around as length hedges when they modify the count.
  // "essay about rain" must not disable the stated-length floor.
  const approximate =
    /\b(about|around|approximately|roughly)\s+(\d{1,5})\s*words?\b/i.test(
      prompt,
    ) ||
    /\b(\d{1,5})\s*words?\s+(?:or\s+so|approximately|roughly)\b/i.test(prompt) ||
    /~\s*\d{1,5}\s*words?\b/i.test(prompt);
  const match =
    /\b(?:exactly|precisely|about|around|approximately|roughly)?\s*(\d{1,5})\s*words?\b/i.exec(
      prompt,
    ) || /\b(\d{1,5})[-\s]?word\b/i.exec(prompt);
  if (!match) {
    return null;
  }

  const target = Number.parseInt(match[1], 10);
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }

  return {
    target,
    exact,
    tolerancePct: exact ? 0 : 10,
    // Bare "5000 word essay" means meet the stated length; "about 5000" keeps ±10%.
    floorAtTarget: !exact && !approximate,
  };
}
