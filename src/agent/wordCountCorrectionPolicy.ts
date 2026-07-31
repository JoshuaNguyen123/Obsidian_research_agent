/**
 * Word-count correction policy: parsing a prompt's word target, deciding when
 * a draft needs correction, and building the bounded correction prompt.
 * Extracted verbatim from AgentRunner.ts (Cluster E of the monolith
 * extraction); bodies are byte-identical.
 */

import { type ModelChatMessage } from "../model/types";
import { analyzeGeneratedOutputPrompt, hasWordCountShortfallFollowUp, resolveWordCountBounds } from "./generatedOutputPolicy";
import { hasGeneratedWritingIntent } from "./promptIntentClassifiers";

export type LeadingTitleResult =
  | { status: "pending" }
  | { status: "no_title"; body: string }
  | { status: "title"; title: string; body: string };

export interface WordCountTarget {
  target: number;
  exact: boolean;
  min: number;
  max: number;
}

export function parseWritebackWordCountTargetFromMessages(
  messages: ModelChatMessage[],
): WordCountTarget | null {
  const activeGeneratedTargetContext = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "system" &&
        /Generated output word target:/i.test(message.content),
    );
  if (activeGeneratedTargetContext) {
    return parseWordCountTarget(activeGeneratedTargetContext.content);
  }

  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (
    !latestUserMessage ||
    (!hasGeneratedWritingIntent(latestUserMessage.content) &&
      !hasWordCountShortfallFollowUp(latestUserMessage.content))
  ) {
    return null;
  }

  return parseWordCountTarget(latestUserMessage.content);
}

export function hasUnclosedFence(content: string): boolean {
  return (content.match(/```/g)?.length ?? 0) % 2 === 1;
}

export function parseGeneratedWordCountTargetFromMessages(
  messages: ModelChatMessage[],
): WordCountTarget | null {
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (
    !latestUserMessage ||
    (!hasGeneratedWritingIntent(latestUserMessage.content) &&
      !hasWordCountShortfallFollowUp(latestUserMessage.content))
  ) {
    return null;
  }

  return parseWordCountTarget(latestUserMessage.content);
}

export function parseWordCountTarget(content: string): WordCountTarget | null {
  const systemTarget =
    /Generated output word target:\s*(\d{1,5})\s*words?/i.exec(content);
  const systemMin = /Word target min:\s*(\d+)/i.exec(content);
  const systemMax = /Word target max:\s*(\d+)/i.exec(content);
  if (systemTarget && systemMin && systemMax) {
    const target = Number(systemTarget[1]);
    return {
      target,
      exact: /Exact word target:\s*yes/i.test(content),
      min: Number(systemMin[1]),
      max: Number(systemMax[1]),
    };
  }

  const policy = analyzeGeneratedOutputPrompt(content).wordTarget;
  if (!policy) {
    // Fall back for shortfall follow-ups that only name a count.
    const countMatch =
      /\b(\d{1,5})\s*(?:-| )?words?\b/i.exec(content) ??
      /\b(\d{1,5})\s*(?:-| )?word\b/i.exec(content);
    if (!countMatch) {
      return null;
    }
    const target = Number(countMatch[1]);
    if (!Number.isFinite(target) || target <= 0) {
      return null;
    }
    const exact = /\b(exactly|precisely)\b/i.test(content);
    const approximate =
      /\b(about|around|approximately|roughly)\s+(\d{1,5})\s*words?\b/i.test(
        content,
      ) ||
      /\b(\d{1,5})\s*words?\s+(?:or\s+so|approximately|roughly)\b/i.test(
        content,
      );
    const bounds = resolveWordCountBounds({
      target,
      exact,
      tolerancePct: exact ? 0 : 10,
      floorAtTarget: !exact && !approximate,
    });
    return { target, exact, ...bounds };
  }

  const bounds = resolveWordCountBounds(policy);
  return {
    target: policy.target,
    exact: policy.exact,
    min: bounds.min,
    max: bounds.max,
  };
}

/**
 * Soft ±5% acceptance band used for word-count correction gating.
 * Near-miss drafts inside this band keep the written note without a rewrite pass.
 */
export function softWordCountCorrectionBand(target: number): {
  min: number;
  max: number;
  band: number;
} {
  const band = Math.max(1, Math.round(target * 0.05));
  return {
    min: Math.max(1, target - band),
    max: target + band,
    band,
  };
}

/**
 * Word-count correction uses a soft ±5% band around the stated target so a
 * near-miss draft (e.g. 3826/4000) keeps the written note instead of firing a
 * correction that historically risked appending a second essay. Exact targets
 * still require an exact count. Floor-at-target remains for resume/shortfall
 * expand bounds via resolveWordCountBounds.
 */
export function shouldRequestWordCountCorrection(
  count: number,
  wordTarget: WordCountTarget,
): boolean {
  if (wordTarget.exact) {
    return count !== wordTarget.target;
  }
  const soft = softWordCountCorrectionBand(wordTarget.target);
  return count < soft.min || count > soft.max;
}

export function buildWordCountCorrectionPrompt(
  target: WordCountTarget,
  currentCount: number,
): string {
  const soft = softWordCountCorrectionBand(target.target);
  const under = currentCount < soft.min;
  const over = currentCount > soft.max;
  const delta = under
    ? Math.max(1, soft.min - currentCount)
    : over
      ? Math.max(1, currentCount - soft.max)
      : 0;

  const lengthGoal = target.exact
    ? `exactly ${target.target} words`
    : `within the soft ±5% band of ${soft.min}–${soft.max} words (target ${target.target})`;

  const editStrategy = under
    ? [
        `The current draft is about ${currentCount} words — roughly ${delta}+ words short of the soft band.`,
        "Prefer expand-in-place: reread the existing draft, keep its structure and wording, and edit thin sections by adding sentences, examples, analysis, or transitions until the count is inside the soft band.",
        "Do not discard the draft and rewrite from scratch. Do not start a second essay after the first.",
      ].join(" ")
    : over
      ? [
          `The current draft is about ${currentCount} words — roughly ${delta}+ words over the soft band.`,
          "Prefer edit-in-place: trim redundancy and tighten phrasing while preserving the same claims, citations, and useful detail.",
          "Do not discard the draft and rewrite from scratch.",
        ].join(" ")
      : [
          "Edit the existing draft in place to satisfy the length goal.",
          "Do not discard the draft and rewrite from scratch.",
        ].join(" ");

  return [
    `Revise the previous draft to be ${lengthGoal}.`,
    editStrategy,
    "Keep the same topic, claims, citations, and useful details.",
    "Return only one complete revised note body that replaces the previous draft.",
  ].join(" ");
}

/** Exported for unit tests of expand-in-place word-count correction copy. */
export function buildWordCountCorrectionPromptForTests(
  target: {
    target: number;
    exact?: boolean;
    min?: number;
    max?: number;
  },
  currentCount: number,
): string {
  return buildWordCountCorrectionPrompt(
    {
      target: target.target,
      exact: target.exact === true,
      min: target.min ?? target.target,
      max: target.max ?? target.target,
    },
    currentCount,
  );
}

export function consumeLeadingH1Title(buffer: string, force = false): LeadingTitleResult {
  const leadingBlank = /^(?:[ \t]*\r?\n)*/.exec(buffer)?.[0] ?? "";
  const candidate = buffer.slice(leadingBlank.length);
  if (!candidate) {
    return force ? { status: "no_title", body: buffer } : { status: "pending" };
  }

  if (
    !/^(?: {0,3})#(?:[ \t]|$)/.test(candidate) ||
    /^(?: {0,3})##/.test(candidate)
  ) {
    return { status: "no_title", body: buffer };
  }

  const newlineMatch = /\r?\n/.exec(candidate);
  if (!newlineMatch && !force) {
    return { status: "pending" };
  }

  const lineEnd = newlineMatch?.index ?? candidate.length;
  const line = candidate.slice(0, lineEnd).trimEnd();
  const match = /^(?: {0,3})#(?:[ \t]+)(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(
    line,
  );
  if (!match) {
    return { status: "no_title", body: buffer };
  }

  const newlineLength = newlineMatch?.[0].length ?? 0;
  const bodyStart = leadingBlank.length + lineEnd + newlineLength;
  const body = buffer.slice(bodyStart).replace(/^(?:[ \t]*\r?\n)+/, "");
  return {
    status: "title",
    title: match[1].trim(),
    body,
  };
}
