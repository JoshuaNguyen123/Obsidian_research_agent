import { hasDesignIntent } from "./codeDesignIntent";

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
  const requiresGrounding =
    requiresTextQuotes ||
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
  const match =
    /\b(?:exactly|precisely|about|around|approximately)?\s*(\d{1,5})\s*words?\b/i.exec(
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
  };
}
