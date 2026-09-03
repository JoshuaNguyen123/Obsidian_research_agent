export const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const CJK_GLOBAL_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const URL_RE = /https?:\/\/\S+/gi;

export interface LanguageGuardResult {
  ok: boolean;
  reason?: "cjk_detected";
  cjkCount: number;
  sample: string;
}

export function inspectEnglishOnlyOutput(text: string): LanguageGuardResult {
  const inspectedText = stripUrls(text);
  const matches = inspectedText.match(CJK_GLOBAL_RE) ?? [];

  return {
    ok: matches.length === 0,
    reason: matches.length > 0 ? "cjk_detected" : undefined,
    cjkCount: matches.length,
    sample: inspectedText.slice(0, 500),
  };
}

export function assertEnglishOnlyOutput(text: string): void {
  const result = inspectEnglishOnlyOutput(text);
  if (!result.ok) {
    throw new Error(`English-only guard failed: ${result.reason}`);
  }
}

export function buildEnglishOnlyRepairPrompt(): string {
  return [
    "Rewrite the previous answer in English only.",
    "Remove all Chinese characters.",
    "Translate any Chinese source text into English.",
    "Preserve the meaning, citations, and Markdown structure.",
    "Return only the corrected English Markdown.",
  ].join(" ");
}

function stripUrls(text: string): string {
  return text.replace(URL_RE, "");
}

/**
 * The prompt reads as English: at least one Latin letter and no more
 * non-ASCII characters than Latin letters. One exported predicate; the
 * runner and the run planner used to carry byte-identical private copies.
 */
export function isLikelyEnglishPrompt(prompt: string): boolean {
  const englishLetters = prompt.match(/[A-Za-z]/g)?.length ?? 0;
  const nonAsciiChars = prompt.match(/[^\x00-\x7F]/g)?.length ?? 0;

  return englishLetters > 0 && englishLetters >= nonAsciiChars;
}

const NON_ENGLISH_OUTPUT_REQUEST_RE =
  /\b(?:in|into|to)\s+(?:chinese|mandarin|cantonese|japanese|korean|simplified\s+chinese|traditional\s+chinese)\b|\b(?:chinese|mandarin|cantonese|japanese|korean)\s+(?:translation|version)\b|翻译|译成|日本語で|한국어로/iu;

/**
 * An English prompt that explicitly asks for CJK output ("translate this
 * note into Japanese"). The English-only output guard must stand down for
 * it; otherwise the correct answer is blocked as "non-English output".
 */
export function requestsNonEnglishOutput(prompt: string): boolean {
  return NON_ENGLISH_OUTPUT_REQUEST_RE.test(prompt);
}

/**
 * Whether visible output should be held to the English-only guard: the
 * prompt is English AND does not ask for another language. Every guard seat
 * (final-answer rule, streamed relevance gate, repair pass) reads this one
 * predicate so they cannot disagree.
 */
export function shouldEnforceEnglishOutput(prompt: string): boolean {
  return isLikelyEnglishPrompt(prompt) && !requestsNonEnglishOutput(prompt);
}
