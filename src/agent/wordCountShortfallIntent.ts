/**
 * User follow-ups that ask to lengthen an under-target draft. These must
 * replace/expand the existing note, not append a second essay.
 *
 * Leaf module: replace authority and generated-output policy both consume
 * this predicate. Do not import those modules from here.
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
