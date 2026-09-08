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
 *  - `baseline` reproduces the original regexes, widened only by the shared
 *    limitations vocabulary below, which accepts more and rejects nothing the
 *    original accepted. Deep-research behaviour is unchanged for any caller
 *    that does not ask for more.
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

/**
 * The words a report may head its limitations section with.
 *
 * One list, shared by every limitations pattern below, because the lists
 * drifting apart is a defect the strictness switch cannot survive. `caveats`
 * was a heading the strict path accepted while the baseline word regex did not
 * know the word at all, so a report headed `## Caveats` passed strict and
 * failed baseline — and a repair written exactly as the correction instruction
 * asks was graded as still-missing.
 *
 * Strict is meant to be the STRONGER contract: it adds a real-heading and
 * real-prose requirement on top of the baseline word check, so every report
 * strict accepts must be one baseline accepts. That implication only holds
 * structurally if both are built from the same vocabulary, so they are. The
 * direction of the fix is deliberate — widening the shared vocabulary only
 * ever accepts more reports, so no report the shipped baseline accepted can
 * now fail, whereas narrowing the strict patterns would reject `## Caveats`
 * sections that today read perfectly well.
 */
const LIMITATIONS_WORDS = "limitations?|open questions?|unanswered|caveats?";

/**
 * The original acceptance regexes. The confidence pattern is verbatim; the
 * limitations pattern is the original alternation plus `caveats?`, for the
 * reason recorded above.
 */
const BASELINE_LIMITATIONS = new RegExp(`\\b(?:${LIMITATIONS_WORDS})\\b`, "i");
const BASELINE_CONFIDENCE = /\bconfidence\b/i;

/** A markdown heading naming the limitations section, capturing its position. */
const LIMITATIONS_HEADING = new RegExp(
  `^[ \\t]{0,3}#{1,6}[ \\t]+.*\\b(?:${LIMITATIONS_WORDS})\\b.*$`,
  "gim",
);
/** A bolded or underlined pseudo-heading, which readers treat the same way. */
const LIMITATIONS_LABEL = new RegExp(
  `^[ \\t]{0,3}(?:\\*\\*|__)?\\s*(?:${LIMITATIONS_WORDS})\\s*(?:\\*\\*|__)?\\s*:?[ \\t]*$`,
  "gim",
);
/** An inline "Limitations: ..." paragraph, capturing the prose that follows. */
const LIMITATIONS_INLINE = new RegExp(
  `\\b(?:${LIMITATIONS_WORDS})\\b\\s*[:—-]\\s*([^\\n]+)`,
  "i",
);

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
  const inline = LIMITATIONS_INLINE.exec(text);
  return (inline?.[1]?.trim().length ?? 0) >= MIN_LIMITATIONS_BODY_CHARS;
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

/**
 * What the model must be told so that following the instruction actually
 * satisfies `evaluateReportStructure`.
 *
 * Reliability cohort 15 (2026-09-07) lost its third occurrence here. The
 * strict checker wants a heading naming limitations with real prose beneath
 * it, and a GRADED confidence level; the seats that ask for a revision said
 * only "Include an explicit Limitations section." and "Include an explicit
 * Confidence section.". A model can obey both to the letter — a bare
 * "Limitations" bullet, the word "confidence" in a sentence — and still fail.
 * The mission then spent its single progressive correction, changed nothing
 * the progress fingerprint could see, and stopped on the no-progress circuit
 * without delivering.
 *
 * So the instruction is generated from this module, beside the patterns that
 * judge it, and states the heading form, the prose minimum and the grade
 * words explicitly. The wording is deliberately the STRICT contract in every
 * tier: an answer that satisfies it also satisfies the baseline checks, so
 * the caller never has to thread an effort tier through to get this right.
 *
 * There are three seats, not two, and the one that wins is the research
 * plan's next action — it reaches the model ahead of the acceptance copy and
 * the runner's verification prompt. Every one of them must call this, or the
 * seat that hand-writes its own summary silently decides what the model
 * hears; `tests/researchReportStructureCorrection.test.ts` guards the set.
 */
export function reportStructureCorrectionLinesV1(
  missing: readonly string[],
): string[] {
  const lines: string[] = [];
  if (missing.includes("limitations_section")) {
    lines.push(
      `Add a Markdown heading that names the limitations — ${quoteExamples(CORRECTION_LIMITATIONS_HEADINGS)} all count — followed by at least ${MIN_LIMITATIONS_BODY_CHARS} characters of prose saying what the evidence could not cover, which areas were sampled, and what remains unanswered. A heading with nothing beneath it, or the bare word limitations mentioned inside another paragraph, does not satisfy this.`,
    );
  }
  if (missing.includes("confidence_section")) {
    lines.push(
      `State the confidence as a graded level, not as a bare mention: write ${quoteExamples(CORRECTION_CONFIDENCE_STATEMENTS)}. In the percentage form the word has to come before the digits, exactly as shown; a figure written ahead of the word is not recognised. Mentioning confidence with no level and no percentage does not satisfy this.`,
    );
  }
  return lines;
}

/**
 * The heading forms and graded statements the instruction offers by name.
 *
 * These are worked examples, so they are held to the checker they teach: the
 * tests feed every one of them through `evaluateReportStructure` rather than
 * against a copy of the regexes. An example the checker rejects is worse than
 * no example at all — the model that copies it verbatim spends its single
 * correction and still fails, which is exactly the loop cohort 15 died in.
 *
 * Two details are load-bearing. `## Caveats` is offered only because the
 * shared `LIMITATIONS_WORDS` vocabulary makes strict acceptance imply baseline
 * acceptance; and the percentage example puts the word before the digits
 * because that is the only order `GRADED_CONFIDENCE` recognises — "about 70%
 * confidence", the wording this instruction used to teach, does not match it.
 */
const CORRECTION_LIMITATIONS_HEADINGS = [
  "## Limitations",
  "## Open Questions",
  "## Caveats",
] as const;
const CORRECTION_CONFIDENCE_STATEMENTS = [
  "Confidence: high",
  "Confidence: medium",
  "Confidence: low",
  "Confidence: about 70%",
] as const;

/**
 * `"a", "b" or "c"` — the examples quoted verbatim, and the only double quotes
 * the generated instruction contains, so a test can lift every example out of
 * the text the model actually receives and run it through the checker.
 */
function quoteExamples(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/** True when either structural element is missing, so the lines have work. */
export function reportStructureCorrectionAppliesV1(
  missing: readonly string[],
): boolean {
  return (
    missing.includes("limitations_section") ||
    missing.includes("confidence_section")
  );
}
