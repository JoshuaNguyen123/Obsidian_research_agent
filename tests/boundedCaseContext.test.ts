import test from "node:test";
import assert from "node:assert/strict";
import {
  extractEvidencePassages,
  type EvidencePassageBundle,
} from "../src/agent/researchDossier";

function boundedLiteral(content: string, result: EvidencePassageBundle, base = 0): void {
  assert.ok(result.passages.length <= 3);
  assert.ok(result.includedChars <= 2100);
  assert.equal(result.includedChars, result.passages.reduce((sum, p) => sum + p.text.length, 0));
  for (const p of result.passages) {
    assert.ok(p.text.length <= 700);
    assert.equal(p.text, content.slice(p.startChar - base, p.endChar - base));
    assert.deepEqual(Object.keys(p).filter((key) =>
      !["id", "startChar", "endChar", "text", "selection", "matchedTerms"].includes(key)), []);
  }
}

const filler = "Unrelated background detail. ";
const options = { sourceLocator: "Inputs/Generic.md", sourceVersion: "a".repeat(64) };

test("same fields in different entities retain literal local context for a distant queried body", () => {
  const content = "## Entity East\nowner: east\nready: true\n" + filler.repeat(55) +
    "\n## Entity West\nowner: west\n" + filler.repeat(70) +
    "\nready: true\ntailmetric: 31\n" + filler.repeat(12);
  const result = extractEvidencePassages(content, { ...options, query: "tailmetric" });
  boundedLiteral(content, result);
  const body = result.passages.find((p) => p.text.includes("tailmetric: 31"));
  assert.ok(body);
  const owner = content.indexOf("## Entity West");
  assert.ok(result.passages.some((p) => p.startChar === owner && p.text.includes("owner: west")));
  assert.ok(body.startChar > owner);
});

test("repeated heading titles keep distinct actual offset identities", () => {
  const content = "## Component\nowner: north\n" + filler.repeat(48) +
    "\n## Component\nowner: south\n" + filler.repeat(72) +
    "\nresponsequantile: 43\n" + filler.repeat(12);
  const result = extractEvidencePassages(content, { ...options, query: "responsequantile" });
  boundedLiteral(content, result);
  const second = content.lastIndexOf("## Component");
  const context = result.passages.find((p) => p.startChar === second);
  assert.ok(context);
  assert.ok(context?.text.includes("owner: south"));
  assert.ok(result.passages.some((p) => p.text.includes("responsequantile: 43")));
  assert.ok(context.id.includes(`:passage:${second}-`));
});

test("a matched case tail cannot carry the following case header in the same query passage", () => {
  const content = "## Unit Amber\n" + filler.repeat(9) +
    "\nrenewalcount: 18\n\n## Unit Violet\nready: false\n" + filler.repeat(45);
  const result = extractEvidencePassages(content, { ...options, query: "renewalcount" });
  boundedLiteral(content, result);
  const next = content.indexOf("## Unit Violet");
  const body = result.passages.find((p) => p.selection === "query_match" && p.text.includes("renewalcount: 18"));
  assert.ok(body);
  assert.ok(body.endChar <= next);
  assert.ok(body.text.includes("## Unit Amber"));
  assert.ok(!body.text.includes("## Unit Violet"));
});

test("overlong heading-to-body distance uses separate literal ranges within the same budget", () => {
  const content = "## Distant Unit\nowner: copper\n" + filler.repeat(90) +
    "\nloadthreshold: 62\n" + filler.repeat(30);
  const result = extractEvidencePassages(content, { ...options, query: "loadthreshold" });
  boundedLiteral(content, result);
  const body = result.passages.find((p) => p.text.includes("loadthreshold: 62"));
  const context = result.passages.find((p) => p.startChar === 0 && p.text.includes("## Distant Unit"));
  assert.ok(body && context);
  assert.ok(body.startChar > context.endChar);
  assert.ok(!result.passages.some((p) => p.text.includes("## Distant Unit") && p.text.includes("loadthreshold: 62")));
});

test("a complete nearest heading that cannot fit the character cap is not fabricated or stitched", () => {
  const content = "## " + "LongLabel".repeat(100) + "\n" + filler.repeat(30) + "\nserviceratio: 26\n";
  const result = extractEvidencePassages(content, { ...options, query: "serviceratio" });
  boundedLiteral(content, result);
  assert.ok(result.passages.some((p) => p.text.includes("serviceratio: 26")));
  assert.ok(!result.passages.some((p) => p.text.includes(content.slice(0, content.indexOf("\n")))));
});

test("fenced lookalike headings do not become pinned context anchors", () => {
  const content = "## Real Unit\nowner: silver\n" + filler.repeat(45) +
    "\n```text\n## Lookalike Unit\n" + filler.repeat(45) + "\nfencemetric: 27\n```\n";
  const result = extractEvidencePassages(content, { ...options, query: "fencemetric" });
  boundedLiteral(content, result);
  assert.ok(result.passages.some((p) => p.text.includes("fencemetric: 27")));
  assert.ok(result.passages.some((p) => p.startChar === 0 && p.text.includes("## Real Unit")));
  assert.ok(!result.passages.some((p) => p.startChar === content.indexOf("## Lookalike Unit")));
});

test("an unclosed tilde fence does not invent a later heading context", () => {
  const content = "## Actual Unit\n" + filler.repeat(35) +
    "\n~~~text\n## Not A Context\n" + filler.repeat(60) + "\nqueuemetric: 58\n";
  const result = extractEvidencePassages(content, { ...options, query: "queuemetric" });
  boundedLiteral(content, result);
  assert.ok(result.passages.some((p) => p.text.includes("queuemetric: 58")));
  assert.ok(!result.passages.some((p) => p.startChar === content.indexOf("## Not A Context")));
});

test("UTF16 source anchors remain literal across astral characters and CRLF", () => {
  const content = "😀 Résumé\r\n## Unit Émeraude\r\nowner: côte\r\n" + filler.repeat(65) +
    "\r\nretryquantile: 37\r\n" + filler.repeat(25);
  const result = extractEvidencePassages(content, { ...options, query: "retryquantile" });
  boundedLiteral(content, result);
  const body = result.passages.find((p) => p.text.includes("retryquantile: 37"));
  assert.ok(body);
  assert.ok(body.id.endsWith(`:passage:${body.startChar}-${body.endChar}`));
  assert.ok(body.id.includes(`:version:${options.sourceVersion}:`));
});

test("partial source offsets do not infer a heading or fence from an unseen prefix", () => {
  const content = filler.repeat(45) + "\npartialmetric: 41\n" + filler.repeat(30);
  const result = extractEvidencePassages(content, { ...options, query: "partialmetric", baseOffset: 1900 });
  boundedLiteral(content, result, 1900);
  assert.ok(result.passages.some((p) => p.text.includes("partialmetric: 41")));
  assert.ok(result.passages.every((p) => p.startChar >= 1900));
});

test("one allowed passage retains the queried body without inventing space for context", () => {
  const content = "## Single Slot Unit\n" + filler.repeat(85) + "\nsinglemetric: 46\n" + filler.repeat(25);
  const result = extractEvidencePassages(content, { ...options, query: "singlemetric", maxPassages: 1 });
  boundedLiteral(content, result);
  assert.equal(result.passages.length, 1);
  assert.ok(result.passages[0].text.includes("singlemetric: 46"));
  assert.ok(!result.passages[0].text.includes("## Single Slot Unit"));
});

test("smaller explicit content limits remain binding when context consumes a slot", () => {
  const content = "## Small Budget Unit\n" + filler.repeat(65) + "\nbudgetmetric: 51\n" + filler.repeat(25);
  const result = extractEvidencePassages(content, { ...options, query: "budgetmetric", maxPassageChars: 240, maxTotalChars: 600 });
  boundedLiteral(content, result);
  assert.ok(result.includedChars <= 600);
  assert.ok(result.passages.every((p) => p.text.length <= 240));
});

test("plaintext still retains a query-supported value beyond a long prefix", () => {
  const content = filler.repeat(160) + "\nThe measured retentionquantile was 49 in the supplied record.\n" + filler.repeat(90);
  const result = extractEvidencePassages(content, { ...options, query: "retentionquantile" });
  boundedLiteral(content, result);
  assert.ok(result.passages.some((p) => p.text.includes("retentionquantile was 49")));
});

test("unavailable input has no invented case or evidence ranges", () => {
  const result = extractEvidencePassages("", { ...options, query: "unreadable entity metric" });
  assert.deepEqual(result.passages, []);
  assert.equal(result.totalChars, 0);
  assert.equal(result.includedChars, 0);
});

test("a requested case absent from the supplied bytes is not synthesized", () => {
  const content = "## Recorded Unit\nThe primary source documents only this unit.\n";
  const result = extractEvidencePassages(content, { ...options, query: "Unprovided Unit absentmetric" });
  boundedLiteral(content, result);
  assert.ok(!result.passages.some((p) => p.text.includes("Unprovided Unit") || p.text.includes("absentmetric")));
});

test("repeated nearest Evidence headings gain no synthetic ancestor metadata", () => {
  const content = "## Outer East\n### Evidence\n" + filler.repeat(45) +
    "\n## Outer West\n### Evidence\n" + filler.repeat(75) + "\ninnermetric: 64\n";
  const result = extractEvidencePassages(content, { ...options, query: "innermetric" });
  boundedLiteral(content, result);
  assert.ok(result.passages.some((p) => p.text.includes("innermetric: 64")));
  // Exact bytes/ranges can expose context; this test does not assert an
  // inferred parent identity or claim that a model will choose the right one.
});

test("a short multiheading source with no query retains the entire literal source", () => {
  const content = "# Overview\nAll supplied units are documented.\n\n## Unit Gold\ncapacity: 42\n\n## Unit Indigo\ncapacity: 57\n";
  const result = extractEvidencePassages(content, options);
  boundedLiteral(content, result);
  const complete = content.trimEnd();
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].startChar, 0);
  assert.equal(result.passages[0].endChar, complete.length);
  assert.equal(result.passages[0].text, complete);
  assert.ok(result.passages[0].text.includes("capacity: 42"));
  assert.ok(result.passages[0].text.includes("capacity: 57"));
});

test("a stopword-only query on a short multiheading source keeps baseline complete coverage", () => {
  const content = "# Overview\nThe supplied units follow.\n\n## Unit Copper\nload: 38\n\n## Unit Silver\nload: 54\n";
  const result = extractEvidencePassages(content, { ...options, query: "about after research sources with that" });
  boundedLiteral(content, result);
  const complete = content.trimEnd();
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].startChar, 0);
  assert.equal(result.passages[0].endChar, complete.length);
  assert.equal(result.passages[0].text, complete);
  assert.ok(result.passages[0].text.includes("load: 38"));
  assert.ok(result.passages[0].text.includes("load: 54"));
});

test("long multiheading no-query coverage retains the independently specified baseline ranges", () => {
  // A fixed 2800-character document with real headings at 0, 1101 and 2201.
  // These fixed range expectations must hold for both original and candidate.
  const first = "## Beginning\n";
  const middle = "\n## Middle\n";
  const last = "\n## Ending\n";
  const content = first + "x".repeat(1100 - first.length) +
    middle + "y".repeat(1100 - middle.length) +
    last + "z".repeat(600 - last.length);
  assert.equal(content.length, 2800);
  const result = extractEvidencePassages(content, options);
  boundedLiteral(content, result);
  assert.deepEqual(result.passages.map((p) => [p.startChar, p.endChar]),
    [[0, 700], [1050, 1750], [2100, 2800]]);
  assert.equal(result.includedChars, 2100);
  assert.ok(result.passages.every((p) => p.selection === "coverage"));
});
test("an absent useful query on the same short multiheading fixture retains complete baseline coverage", () => {
  const content = "# Overview\nAll supplied units are documented.\n\n## Unit Gold\ncapacity: 42\n\n## Unit Indigo\ncapacity: 57\n";
  const result = extractEvidencePassages(content, { ...options, query: "unmatchednonceword" });
  boundedLiteral(content, result);
  const complete = content.trimEnd();
  assert.equal(result.passages.length, 1);
  assert.equal(result.passages[0].startChar, 0);
  assert.equal(result.passages[0].endChar, complete.length);
  assert.equal(result.passages[0].text, complete);
  assert.equal(result.passages[0].selection, "coverage");
  assert.equal((result.passages[0].matchedTerms ?? []).length, 0);
  assert.ok(result.passages[0].text.includes("capacity: 42"));
  assert.ok(result.passages[0].text.includes("capacity: 57"));
});

test("an absent useful query on the same long multiheading fixture retains exact baseline ranges", () => {
  const first = "## Beginning\n";
  const middle = "\n## Middle\n";
  const last = "\n## Ending\n";
  const content = first + "x".repeat(1100 - first.length) +
    middle + "y".repeat(1100 - middle.length) +
    last + "z".repeat(600 - last.length);
  assert.equal(content.length, 2800);
  const result = extractEvidencePassages(content, { ...options, query: "unmatchednonceword" });
  boundedLiteral(content, result);
  assert.deepEqual(result.passages.map((p) => [p.startChar, p.endChar]),
    [[0, 700], [1050, 1750], [2100, 2800]]);
  assert.equal(result.includedChars, 2100);
  assert.ok(result.passages.every((p) => p.selection === "coverage" && (p.matchedTerms ?? []).length === 0));
});
