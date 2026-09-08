import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateReportStructure,
  reportStructureCorrectionAppliesV1,
  reportStructureCorrectionLinesV1,
} from "../src/agent/researchReportStructure";
import {
  evaluateResearchAcceptance,
  type ResearchEvidence,
  type ResearchPlan,
} from "../src/agent/researchPlan";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Prose long enough to clear the substantive-limitations bar, and no longer. */
const LIMITATIONS_BODY = [
  "Only the ten notes returned by semantic retrieval were read; sixteen further",
  "candidates were skipped, so unindexed areas of the vault remain unexamined.",
].join("\n");

/**
 * Every double-quoted span in a generated line. The generator quotes its worked
 * examples and nothing else, so this lifts the examples out of the exact text
 * the model receives — rather than out of a copy kept in the test, which is how
 * an instruction and its checker drift apart in the first place.
 */
function quotedExamples(line: string): string[] {
  return [...line.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

/** A report built by doing exactly and only what the instruction asks. */
function reportWrittenToTheLetter(heading: string, confidence: string): string {
  return ["The marker appears in three vault notes.", "", heading, "", LIMITATIONS_BODY, "", confidence]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * The point of these tests is not that an instruction exists. It is that
 * following the instruction to the letter actually passes the checker that
 * rejected the answer — the two used to disagree, and cohort 15 died of it.
 */
test("an answer written to the letter of the instruction passes the strict checker", () => {
  const lines = reportStructureCorrectionLinesV1([
    "limitations_section",
    "confidence_section",
  ]);
  assert.equal(lines.length, 2);

  // Built by doing exactly and only what the two lines ask for.
  const answer = [
    "The marker appears in three vault notes.",
    "",
    "## Limitations",
    "",
    "Only the ten notes returned by semantic retrieval were read; sixteen further",
    "candidates were skipped, so unindexed areas of the vault remain unexamined.",
    "",
    "Confidence: low",
    "",
  ].join("\n");

  for (const strictness of ["strict", "baseline"] as const) {
    const finding = evaluateReportStructure(answer, { strictness });
    assert.equal(finding.hasLimitationsSection, true, `limitations under ${strictness}`);
    assert.equal(finding.hasConfidenceSection, true, `confidence under ${strictness}`);
  }
});

test("every worked example the instruction offers passes the checker it teaches", () => {
  // An example the checker rejects is worse than no example: the model that
  // copies it verbatim spends its single progressive correction and still
  // fails. So every example is run THROUGH `evaluateReportStructure`, never
  // compared against a second copy of its regexes.
  const [limitationsLine = "", confidenceLine = ""] = reportStructureCorrectionLinesV1([
    "limitations_section",
    "confidence_section",
  ]);
  const headings = quotedExamples(limitationsLine);
  const statements = quotedExamples(confidenceLine);
  assert.ok(headings.length > 0, "the limitations line must show a heading, not just describe one");
  assert.ok(statements.length > 0, "the confidence line must show a graded statement");

  for (const heading of headings) {
    for (const statement of statements) {
      const report = reportWrittenToTheLetter(heading, statement);
      for (const strictness of ["strict", "baseline"] as const) {
        const finding = evaluateReportStructure(report, { strictness });
        assert.equal(
          finding.hasLimitationsSection,
          true,
          `${heading} must satisfy limitations under ${strictness}`,
        );
        assert.equal(
          finding.hasConfidenceSection,
          true,
          `${statement} must satisfy confidence under ${strictness}`,
        );
      }
    }
  }

  // Positive proof that the examples are what carry the checks: strip either
  // one out and the same report fails on that dimension alone.
  const withoutConfidence = reportWrittenToTheLetter(headings[0] ?? "", "");
  assert.equal(
    evaluateReportStructure(withoutConfidence, { strictness: "strict" }).hasConfidenceSection,
    false,
    "the surrounding prose must not be what passes the confidence check",
  );
  const withoutHeading = ["The marker appears in three vault notes.", "", statements[0] ?? ""].join("\n");
  assert.equal(
    evaluateReportStructure(withoutHeading, { strictness: "strict" }).hasLimitationsSection,
    false,
    "the surrounding prose must not be what passes the limitations check",
  );
});

test("the percentage example is written in the one order the checker accepts", () => {
  const [confidenceLine = ""] = reportStructureCorrectionLinesV1(["confidence_section"]);
  const percentageExamples = quotedExamples(confidenceLine).filter((value) =>
    value.includes("%"),
  );
  assert.ok(
    percentageExamples.length > 0,
    "the percentage form is named, so it must also be shown",
  );

  // The instruction used to offer "about 70% confidence". The checker's
  // percentage alternative requires the word BEFORE the digits, so that
  // example was rejected by the very regex it was teaching. Pin the old
  // wording as a negative so no future edit can drift back into it.
  const oldWording = reportWrittenToTheLetter("## Limitations", "about 70% confidence");
  assert.equal(
    evaluateReportStructure(oldWording, { strictness: "strict" }).hasConfidenceSection,
    false,
  );
  for (const example of percentageExamples) {
    const repaired = reportWrittenToTheLetter("## Limitations", example);
    assert.equal(
      evaluateReportStructure(repaired, { strictness: "strict" }).hasConfidenceSection,
      true,
      `the percentage example must pass: ${example}`,
    );
  }
});

test("strict acceptance implies baseline acceptance for every heading the instruction names", () => {
  // Strict is the stronger contract: it adds a real-heading and real-prose
  // requirement on top of the baseline word check, so a report strict accepts
  // can never be one baseline rejects. "## Caveats" broke that implication —
  // the strict heading pattern knew the word, the baseline regex did not — so
  // a repair written exactly as instructed was graded as still-missing.
  const [limitationsLine = ""] = reportStructureCorrectionLinesV1(["limitations_section"]);
  const [confidenceLine = ""] = reportStructureCorrectionLinesV1(["confidence_section"]);
  const headings = quotedExamples(limitationsLine);
  const graded = quotedExamples(confidenceLine)[0] ?? "";
  assert.ok(headings.length > 0);

  for (const heading of headings) {
    const word = heading.replace(/^#+[ \t]*/u, "");
    // The three shapes a report actually uses for the same section: a markdown
    // heading, a bolded pseudo-heading, and an inline paragraph.
    for (const section of [
      [heading, "", LIMITATIONS_BODY].join("\n"),
      [`**${word}**`, "", LIMITATIONS_BODY].join("\n"),
      `${word}: ${LIMITATIONS_BODY.replace(/\n/gu, " ")}`,
    ]) {
      const report = [section, "", graded].join("\n\n");
      const strict = evaluateReportStructure(report, { strictness: "strict" });
      const baseline = evaluateReportStructure(report, { strictness: "baseline" });
      assert.equal(
        strict.hasLimitationsSection,
        true,
        `strict must accept a form the instruction names: ${section}`,
      );
      assert.equal(
        baseline.hasLimitationsSection,
        true,
        `strict-pass must imply baseline-pass: ${section}`,
      );
      assert.equal(strict.hasConfidenceSection, true, `strict confidence: ${graded}`);
      assert.equal(baseline.hasConfidenceSection, true, `baseline confidence: ${graded}`);
    }
  }
});

test("strict and baseline share one limitations vocabulary, not two that drift", () => {
  // The test above can only see the words today's instruction happens to
  // name, so on its own it would have passed over the very defect it exists
  // for. This one pins the whole vocabulary as report text: every word the
  // strict path accepts as a heading, in each of the three shapes a report
  // actually writes it, must be accepted by BOTH strictness levels.
  const [confidenceLine = ""] = reportStructureCorrectionLinesV1(["confidence_section"]);
  const graded = quotedExamples(confidenceLine)[0] ?? "";

  for (const word of ["Limitations", "Open Questions", "Unanswered", "Caveats"]) {
    for (const section of [
      [`## ${word}`, "", LIMITATIONS_BODY].join("\n"),
      [`**${word}**`, "", LIMITATIONS_BODY].join("\n"),
      `${word}: ${LIMITATIONS_BODY.replace(/\n/gu, " ")}`,
    ]) {
      const report = [section, "", graded].join("\n\n");
      for (const strictness of ["strict", "baseline"] as const) {
        assert.equal(
          evaluateReportStructure(report, { strictness }).hasLimitationsSection,
          true,
          `${strictness} must accept this section: ${section}`,
        );
      }
    }
  }
});

test("the shapes that killed the mission still fail, so the instruction is what changed", () => {
  // A heading with nothing beneath it, and the bare word "confidence": both
  // obey the old one-line asks ("Include an explicit Limitations section.",
  // "Include an explicit Confidence section.") and both are rejected.
  const obeyedTheOldAsk = [
    "The marker appears in three vault notes.",
    "",
    "## Limitations",
    "",
    "## Confidence",
    "",
    "This answer reports the confidence of the retrieval.",
    "",
  ].join("\n");
  const strict = evaluateReportStructure(obeyedTheOldAsk, { strictness: "strict" });
  assert.equal(strict.hasLimitationsSection, false, "an empty heading is not a section");
  assert.equal(strict.hasConfidenceSection, false, "the bare word is not a grade");
});

test("the instruction names the heading form, the prose minimum and the grade words", () => {
  const [limitations, confidence] = reportStructureCorrectionLinesV1([
    "limitations_section",
    "confidence_section",
  ]);
  assert.match(limitations ?? "", /Markdown heading/u);
  assert.match(limitations ?? "", /## Limitations/u);
  assert.match(limitations ?? "", /\b40 characters\b/u, "the prose minimum must be stated");
  assert.match(confidence ?? "", /\bhigh\b/u);
  assert.match(confidence ?? "", /\bmedium\b/u);
  assert.match(confidence ?? "", /\blow\b/u);
  assert.match(confidence ?? "", /percentage/u);
});

test("only the missing element is asked for", () => {
  assert.deepEqual(reportStructureCorrectionLinesV1([]), []);
  assert.equal(reportStructureCorrectionAppliesV1([]), false);
  assert.equal(reportStructureCorrectionAppliesV1(["citation_url_coverage"]), false);
  assert.equal(reportStructureCorrectionAppliesV1(["limitations_section"]), true);
  const onlyConfidence = reportStructureCorrectionLinesV1(["confidence_section"]);
  assert.equal(onlyConfidence.length, 1);
  assert.match(onlyConfidence[0] ?? "", /Confidence/u);
  assert.doesNotMatch(onlyConfidence[0] ?? "", /Markdown heading/u);
});

/**
 * Every seat that tells the model how to repair the report.
 *
 * Three, not two: the research plan's next action reaches the model ahead of
 * the acceptance copy and the runner's verification prompt, so a hand-written
 * line there makes the other two seats inert no matter how precise they are.
 * That is why this list is checked against the seats the product really uses
 * rather than kept by hand — see the test below.
 */
const CORRECTION_SEATS = [
  path.join("src", "AgentRunner.ts"),
  path.join("src", "agent", "missionAcceptance.ts"),
  path.join("src", "agent", "researchPlan.ts"),
];

/** The module that defines the generator, which is a definition, not a seat. */
const CORRECTION_GENERATOR = path.join("src", "agent", "researchReportStructure.ts");

/**
 * The hand-written asks this guard exists to keep out: the two one-liners that
 * lost cohort 15, and the next-action summary that silently outranked them.
 * Each is paired with the exact text it must still recognise, because a guard
 * whose patterns match nothing passes for the wrong reason.
 */
const HAND_WRITTEN_ASKS: Array<{ pattern: RegExp; sample: string }> = [
  {
    pattern: /"Include an explicit (?:Limitations|Confidence) section\."/u,
    sample: '      ? "Include an explicit Limitations section."',
  },
  {
    pattern: /"Include limitations and confidence in the final answer\."/u,
    sample: '    return "Include limitations and confidence in the final answer.";',
  },
  {
    pattern: /\b(?:Revise|Rewrite|Redo)\b[^"\n]{0,60}\bwith limitations and confidence\b/iu,
    sample: '    return "Revise the answer with limitations and confidence.";',
  },
];

function typeScriptSourcesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...typeScriptSourcesUnder(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

test("every correction seat reads the shared generator instead of its own wording", () => {
  for (const relative of CORRECTION_SEATS) {
    const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    assert.match(
      source,
      /reportStructureCorrectionLinesV1\(/u,
      `${relative} must generate the instruction`,
    );
  }
});

test("no source file reintroduces a hand-written limitations or confidence correction", () => {
  // Scan the whole tree, not just the three known seats: the defect was a
  // seat nobody had counted, and a guard that only looks where the fix landed
  // cannot find the next one.
  for (const file of typeScriptSourcesUnder(path.join(REPO_ROOT, "src"))) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(REPO_ROOT, file);
    // The generator's own module quotes the superseded asks in a comment, to
    // record what was wrong with them. Its shipped wording is not taken on
    // trust here either — the tests above run every example it emits through
    // `evaluateReportStructure` itself.
    if (relative === CORRECTION_GENERATOR) continue;
    for (const { pattern } of HAND_WRITTEN_ASKS) {
      assert.doesNotMatch(source, pattern, `${relative} must not hard-code the under-specified ask`);
    }
  }
});

test("the ban patterns still recognise the asks they were written against", () => {
  // Paired positive proof: without this, deleting the offending line from the
  // patterns themselves would leave a guard that passes over anything.
  for (const { pattern, sample } of HAND_WRITTEN_ASKS) {
    assert.match(sample, pattern, `the guard must still recognise: ${sample.trim()}`);
  }
});

test("the guarded seat list is the set of seats the product actually generates from", () => {
  const callers = typeScriptSourcesUnder(path.join(REPO_ROOT, "src"))
    .filter((file) => /reportStructureCorrectionLinesV1\(/u.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(REPO_ROOT, file))
    // The generator's own module declares the function; declaring is not a seat.
    .filter((relative) => relative !== CORRECTION_GENERATOR)
    .sort();
  assert.deepEqual(
    callers,
    [...CORRECTION_SEATS].sort(),
    "a seat was added or removed: widen CORRECTION_SEATS so the guard still covers every one",
  );
});

/** A vault-only plan whose only outstanding debt is the report structure. */
function structureOnlyPlan(): ResearchPlan {
  return {
    version: 1,
    mode: "deep_vault",
    sourceRequirements: { minFetchedSources: 0, minDistinctDomains: 0 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Retrieve local vault context.",
        requiredEvidenceType: "vault_note",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["vault:1"],
      },
    ],
    evidenceIds: ["vault:1"],
    status: "complete",
  };
}

function structureOnlyEvidence(): ResearchEvidence[] {
  return [
    {
      id: "vault:1",
      kind: "vault_note",
      title: "Alpha.md",
      path: "Notes/Alpha.md",
      summary: "Local vault note about the marker.",
      confidence: "high",
    },
  ];
}

test("the live next action carries the generated instruction, not a summary of it", () => {
  // The seat proven by source scan above, proven again through the function
  // the run actually calls: the next action is what reaches the model.
  const finding = evaluateResearchAcceptance({
    plan: structureOnlyPlan(),
    evidence: structureOnlyEvidence(),
    finalOutput: "The marker appears in three vault notes.",
  });
  assert.deepEqual(
    [...finding.missing].sort(),
    ["confidence_section", "limitations_section"],
    "the fixture must isolate the structural debt",
  );
  assert.equal(
    finding.nextAction,
    reportStructureCorrectionLinesV1(finding.missing).join(" "),
  );

  // And an answer written to that next action is accepted, which is the whole
  // point: the instruction the run delivers must be one the gate can clear.
  const repaired = evaluateResearchAcceptance({
    plan: structureOnlyPlan(),
    evidence: structureOnlyEvidence(),
    finalOutput: reportWrittenToTheLetter("## Caveats", "Confidence: about 70%"),
  });
  assert.deepEqual(repaired.missing, []);
  assert.equal(repaired.nextAction, undefined);
});
