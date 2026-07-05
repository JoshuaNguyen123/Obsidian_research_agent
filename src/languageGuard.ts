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
