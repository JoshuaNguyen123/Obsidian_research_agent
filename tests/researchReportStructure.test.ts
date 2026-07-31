import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateReportStructure,
  reportStrictnessForTier,
} from "../src/agent/researchReportStructure";

const REAL_LIMITATIONS = [
  "## Limitations",
  "",
  "Both sources cover a single 18-month window, so nothing here speaks to",
  "long-run retention. Neither study randomised assignment, so the reported",
  "gain may reflect selection rather than the onboarding change itself.",
].join("\n");

test("baseline strictness reproduces the original word-level contract exactly", () => {
  // These are the regexes the acceptance gate shipped with. Deep-research
  // behaviour for quick/standard missions must not move.
  const mentionsOnly = "We note limitations. Our confidence is stated elsewhere.";
  const baseline = evaluateReportStructure(mentionsOnly, { strictness: "baseline" });
  assert.equal(baseline.hasLimitationsSection, true);
  assert.equal(baseline.hasConfidenceSection, true);

  assert.equal(
    evaluateReportStructure("Open questions remain. Confidence: unknown.", {
      strictness: "baseline",
    }).hasLimitationsSection,
    true,
  );
  assert.equal(
    evaluateReportStructure("A report with neither epistemic section.", {
      strictness: "baseline",
    }).hasLimitationsSection,
    false,
  );
});

test("baseline is the default when no strictness is supplied", () => {
  const finding = evaluateReportStructure("We note limitations and confidence.");
  assert.equal(finding.strictness, "baseline");
  assert.equal(finding.hasConfidenceSection, true);
});

test("strict mode rejects a report that merely mentions the words", () => {
  // The failure this exists to catch: a checklist satisfied without a reader
  // ever learning what the work could not establish.
  const finding = evaluateReportStructure(
    "We note limitations. Our confidence is stated elsewhere.",
    { strictness: "strict" },
  );
  assert.equal(finding.hasLimitationsSection, false);
  assert.equal(finding.hasConfidenceSection, false);
});

test("strict mode rejects a limitations heading with nothing beneath it", () => {
  const finding = evaluateReportStructure(
    ["# Findings", "Alpha and beta agree.", "", "## Limitations", "", "## Confidence", "High."].join("\n"),
    { strictness: "strict" },
  );
  assert.equal(finding.hasLimitationsSection, false);
});

test("strict mode accepts a real heading with real prose beneath it", () => {
  const finding = evaluateReportStructure(
    ["# Findings", "Alpha and beta agree.", "", REAL_LIMITATIONS, "", "Confidence: medium."].join("\n"),
    { strictness: "strict" },
  );
  assert.equal(finding.hasLimitationsSection, true);
  assert.equal(finding.hasConfidenceSection, true);
  assert.equal(finding.hasGradedConfidence, true);
});

test("strict confidence requires a grade, not the bare word", () => {
  const bare = evaluateReportStructure([REAL_LIMITATIONS, "", "We cannot state a confidence."].join("\n"), {
    strictness: "strict",
  });
  assert.equal(bare.hasConfidenceSection, false);

  for (const statement of [
    "Confidence: high.",
    "Confidence in this finding is low.",
    "This is a medium-confidence conclusion.",
    "Confidence is roughly 70% given the sample.",
  ]) {
    const finding = evaluateReportStructure([REAL_LIMITATIONS, "", statement].join("\n"), {
      strictness: "strict",
    });
    assert.equal(finding.hasConfidenceSection, true, `expected a grade in: ${statement}`);
  }
});

test("a Confidence heading carries its grade in the body, one line down", () => {
  // The inline pattern refuses to cross a newline so it cannot borrow a grade
  // word from an unrelated sentence; the heading form therefore needs its own
  // pass, and this is the shape reports actually use.
  const finding = evaluateReportStructure(
    [REAL_LIMITATIONS, "", "## Confidence", "", "Medium, because the two fetched sources disagree."].join("\n"),
    { strictness: "strict" },
  );
  assert.equal(finding.hasConfidenceSection, true);

  const ungraded = evaluateReportStructure(
    [REAL_LIMITATIONS, "", "## Confidence", "", "This is difficult to characterise."].join("\n"),
    { strictness: "strict" },
  );
  assert.equal(ungraded.hasConfidenceSection, false);
});

test("a concise one-sentence limitation is accepted; padding is not required", () => {
  // The bar catches an *empty* section, not a short one. Rejecting a complete
  // one-sentence limitation would punish the honest short answer and reward
  // padding, which is the opposite of what the check is for.
  const finding = evaluateReportStructure(
    [
      "## Limitations",
      "",
      "The two sources disagree about whether onboarding validation helped.",
      "",
      "## Confidence",
      "",
      "Low.",
    ].join("\n"),
    { strictness: "strict" },
  );
  assert.equal(finding.hasLimitationsSection, true);
  assert.equal(finding.hasConfidenceSection, true);
});

test("a bolded pseudo-heading counts when it carries real prose", () => {
  const finding = evaluateReportStructure(
    [
      "**Limitations**",
      "",
      "The two sources share an author, so their agreement is not independent",
      "corroboration. Neither reports effect sizes, so the magnitude is unknown.",
      "",
      "Confidence: low.",
    ].join("\n"),
    { strictness: "strict" },
  );
  assert.equal(finding.hasLimitationsSection, true);
});

test("an inline limitations paragraph counts when it is substantive", () => {
  const finding = evaluateReportStructure(
    [
      "Limitations: the sample covers only two reporting years and excludes",
      "self-serve accounts, so the retention gain may not generalise to the",
      "segment this decision actually concerns.",
      "",
      "Confidence: medium.",
    ].join(" "),
    { strictness: "strict" },
  );
  assert.equal(finding.hasLimitationsSection, true);
});

test("repeated evaluation is stable despite module-level global regexes", () => {
  // The heading patterns are /g; a leaked lastIndex would make the second call
  // disagree with the first.
  const report = [REAL_LIMITATIONS, "", "Confidence: high."].join("\n");
  const first = evaluateReportStructure(report, { strictness: "strict" });
  const second = evaluateReportStructure(report, { strictness: "strict" });
  const third = evaluateReportStructure(report, { strictness: "strict" });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
});

test("strictness is tier-derived: only deep and extended are held to the bar", () => {
  // The existing proof lanes all run at standard, which is what keeps this
  // change from moving any baselined scorecard.
  assert.equal(reportStrictnessForTier("quick"), "baseline");
  assert.equal(reportStrictnessForTier("standard"), "baseline");
  assert.equal(reportStrictnessForTier(undefined), "baseline");
  assert.equal(reportStrictnessForTier("deep"), "strict");
  assert.equal(reportStrictnessForTier("extended"), "strict");
});

test("empty and whitespace-only reports fail every check without throwing", () => {
  for (const value of ["", "   \n\t "]) {
    for (const strictness of ["baseline", "strict"] as const) {
      const finding = evaluateReportStructure(value, { strictness });
      assert.equal(finding.hasLimitationsSection, false);
      assert.equal(finding.hasConfidenceSection, false);
    }
  }
});
