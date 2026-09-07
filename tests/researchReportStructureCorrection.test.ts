import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateReportStructure,
  reportStructureCorrectionAppliesV1,
  reportStructureCorrectionLinesV1,
} from "../src/agent/researchReportStructure";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

test("both correction seats read the shared generator instead of their own wording", () => {
  // Two seats ask the model to fix this: the acceptance next-action copy and
  // the runner's verification correction prompt. Either one drifting from the
  // checker reopens the same loss, so neither may hard-code the old text.
  for (const relative of [
    ["src", "agent", "missionAcceptance.ts"],
    ["src", "AgentRunner.ts"],
  ]) {
    const file = path.join(REPO_ROOT, ...relative);
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /reportStructureCorrectionLinesV1\(/u,
      `${relative.join("/")} must generate the instruction`,
    );
    assert.doesNotMatch(
      source,
      /"Include an explicit (Limitations|Confidence) section\."/u,
      `${relative.join("/")} must not hard-code the under-specified ask`,
    );
    assert.doesNotMatch(
      source,
      /"Include limitations and confidence in the final answer\."/u,
      `${relative.join("/")} must not hard-code the under-specified ask`,
    );
  }
});
