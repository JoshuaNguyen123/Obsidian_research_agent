/**
 * Structural checks for the epistemic sections a research report owes its
 * reader: what the work could not establish, and how much to trust what it did.
 *
 * The acceptance gate used to test these with bare word regexes — a report
 * satisfied `confidence_section` by containing the word "confidence" anywhere,
 * including inside a sentence disclaiming it. That is not a check; it is a
 * spell-check. But tightening it globally would retroactively fail reports the
 * existing proof lanes accept, so strictness is a parameter:
 *
 *  - `baseline` reproduces the original regexes byte-for-byte. Deep-research
 *    behaviour is unchanged for any caller that does not ask for more.
 *  - `strict` requires a real heading with real content beneath it, and a
 *    confidence statement carrying a graded value rather than the bare word.
 *
 * Pure and Obsidian-free, in the style of `researchEffortPolicy.ts`, so the
 * rules are testable without a vault and score identically live and replayed.
 */

export type ReportStructureStrictness = "baseline" | "strict";

export interface ReportStructureFinding {
  hasLimitationsSection: boolean;
  hasConfidenceSection: boolean;
  /** True when a confidence claim carries a level or percentage, not just the word. */
  hasGradedConfidence: boolean;
  /** True when a limitations heading is followed by real prose. */
  hasSubstantiveLimitations: boolean;
  strictness: ReportStructureStrictness;
}

/** The original acceptance regexes. Kept verbatim as the baseline contract. */
const BASELINE_LIMITATIONS =
  /\blimitations?\b|\bopen questions?\b|\bunanswered\b/i;
const BASELINE_CONFIDENCE = /\bconfidence\b/i;

/** A markdown heading naming the limitations section, capturing its position. */
const LIMITATIONS_HEADING =
  /^[ \t]{0,3}#{1,6}[ \t]+.*\b(limitations?|open questions?|unanswered|caveats?)\b.*$/gim;
/** A bolded or underlined pseudo-heading, which readers treat the same way. */
const LIMITATIONS_LABEL =
  /^[ \t]{0,3}(?:\*\*|__)?\s*(limitations?|open questions?|caveats?)\s*(?:\*\*|__)?\s*:?[ \t]*$/gim;

/**
 * A confidence claim with an actual grade attached: a named level, a
 * percentage, or an explicit low/medium/high qualifier near the word.
 */
const GRADED_CONFIDENCE =
  /\bconfidence\b[^.\n]{0,60}?\b(high|medium|moderate|low|very low|very high)\b|\b(high|medium|moderate|low|very low|very high)[- ]confidence\b|\bconfidence\b[^.\n]{0,40}?\b\d{1,3}\s?%/i;

/** A grade word or percentage standing alone, for use inside a section body. */
const BARE_GRADE =
  /\b(very high|very low|high|medium|moderate|low)\b|\b\d{1,3}\s?%/i;

/** A markdown or bolded heading naming the confidence section. */
const CONFIDENCE_HEADING =
  /^[ \t]{0,3}(?:#{1,6}[ \t]+|(?:\*\*|__))\s*confidence\b.*$/gim;

/**
 * Minimum prose beneath a limitations heading before it counts as real.
 *
 * Deliberately low. The failure being caught is an *empty* section — a heading
 * emitted to satisfy a checklist — not a concise one. "The two sources
 * disagree about whether onboarding helped" is a complete, useful limitation,
 * and a bar high enough to reject it would punish the honest short answer and
 * reward padding.
 */
const MIN_LIMITATIONS_BODY_CHARS = 40;

export function evaluateReportStructure(
  output: string,
  options: { strictness?: ReportStructureStrictness } = {},
): ReportStructureFinding {
  const strictness = options.strictness ?? "baseline";
  const text = (output ?? "").trim();

  const baselineLimitations = BASELINE_LIMITATIONS.test(text);
  const baselineConfidence = BASELINE_CONFIDENCE.test(text);
  const gradedConfidence = hasGradedConfidenceStatement(text);
  const substantiveLimitations = hasSubstantiveLimitationsSection(text);

  if (strictness === "baseline") {
    return {
      hasLimitationsSection: baselineLimitations,
      hasConfidenceSection: baselineConfidence,
      hasGradedConfidence: gradedConfidence,
      hasSubstantiveLimitations: substantiveLimitations,
      strictness,
    };
  }

  return {
    hasLimitationsSection: substantiveLimitations,
    // A graded statement is the point; the bare word never suffices in strict
    // mode, because "we cannot state a confidence" would otherwise pass.
    hasConfidenceSection: gradedConfidence,
    hasGradedConfidence: gradedConfidence,
    hasSubstantiveLimitations: substantiveLimitations,
    strictness,
  };
}

/**
 * True when the report states a confidence level rather than the bare word.
 *
 * Two shapes count: an inline claim ("confidence: medium", "a low-confidence
 * finding", "confidence is about 70%"), and a `## Confidence` heading whose
 * body carries the grade. The heading form needs its own pass because the
 * inline pattern deliberately refuses to cross a newline — without that limit
 * it would match a grade word belonging to an unrelated later sentence.
 */
function hasGradedConfidenceStatement(text: string): boolean {
  if (GRADED_CONFIDENCE.test(text)) return true;

  CONFIDENCE_HEADING.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONFIDENCE_HEADING.exec(text)) !== null) {
    const body = sectionBody(text, match.index + match[0].length);
    // Bound the window so a grade far below the heading, in unrelated prose,
    // does not count as this section's verdict.
    if (BARE_GRADE.test(body.slice(0, 200))) return true;
  }
  return false;
}

/**
 * True when the report carries a limitations heading followed by enough prose
 * to be worth reading. A heading with nothing under it is the failure mode this
 * exists to catch: the model satisfying a checklist rather than the reader.
 */
function hasSubstantiveLimitationsSection(text: string): boolean {
  for (const pattern of [LIMITATIONS_HEADING, LIMITATIONS_LABEL]) {
    // Fresh lastIndex per call: these are module-level /g regexes.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const bodyStart = match.index + match[0].length;
      const body = sectionBody(text, bodyStart);
      if (body.length >= MIN_LIMITATIONS_BODY_CHARS) return true;
    }
  }

  // An inline paragraph is acceptable when it actually discusses the limit,
  // e.g. "Limitations: the sample covers only two years, so ...".
  const inline = /\b(limitations?|caveats?|open questions?)\b\s*[:—-]\s*([^\n]+)/i.exec(text);
  return (inline?.[2]?.trim().length ?? 0) >= MIN_LIMITATIONS_BODY_CHARS;
}

/** Text from `start` up to the next markdown heading, with markup stripped. */
function sectionBody(text: string, start: number): string {
  const rest = text.slice(start);
  const nextHeading = /^[ \t]{0,3}#{1,6}[ \t]+/m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return body
    .replace(/^[ \t]*[-*+]\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strictness for a research plan's effort tier.
 *
 * Deep and extended missions are the ones that claim thoroughness, so they are
 * the ones held to a real structural bar. Quick and standard missions keep the
 * original contract exactly, which is what keeps the existing proof lanes —
 * all of which run at `standard` — byte-for-byte unaffected.
 */
export function reportStrictnessForTier(
  tier: string | undefined,
): ReportStructureStrictness {
  return tier === "deep" || tier === "extended" ? "strict" : "baseline";
}
