const MAX_REFLECTION_CHARS_V1 = 50_000;
const MIN_REFLECTION_WORDS_V1 = 12;
const MIN_REFLECTION_LETTER_WORDS_V1 = 8;

export class ReflectionContentErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReflectionContentErrorV1";
  }
}

/**
 * Require real human-facing reflection prose outside markers, links, and code.
 * This intentionally rejects completion artifacts made only from headings,
 * HTML markers, URLs, identifiers, or fenced examples.
 */
export function assertMeaningfulReflectionContentV1(
  value: unknown,
  label = "Reflection",
): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_REFLECTION_CHARS_V1 ||
    value.includes("\0")
  ) {
    throw new ReflectionContentErrorV1(
      `${label} must be bounded UTF-8-safe text.`,
    );
  }
  const prose = stripNonProse(value);
  const words = prose.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  const letterWords = words.filter((word) => /\p{L}/u.test(word));
  if (
    words.length < MIN_REFLECTION_WORDS_V1 ||
    letterWords.length < MIN_REFLECTION_LETTER_WORDS_V1
  ) {
    throw new ReflectionContentErrorV1(
      `${label} must include meaningful explanatory prose, not only markers, links, headings, or code.`,
    );
  }
  return value;
}

export function hasMeaningfulReflectionContentV1(value: unknown): boolean {
  try {
    assertMeaningfulReflectionContentV1(value);
    return true;
  } catch {
    return false;
  }
}

function stripNonProse(value: string): string {
  return value
    .replace(/<!--[^]*?-->/gu, " ")
    .replace(/(`{3,}|~{3,})[^\n]*\n[^]*?\1/gu, " ")
    .replace(/!?(?:\[[^\]]*\])?\(https?:\/\/[^)]+\)/giu, " ")
    .replace(/https?:\/\/[^\s<>)\]]+/giu, " ")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gmu, " ")
    .replace(/[`*_>#|\[\]()-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
