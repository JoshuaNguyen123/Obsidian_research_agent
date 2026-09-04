import assert from "node:assert/strict";
import test from "node:test";
import { extractEvidencePassages } from "../src/agent/researchDossier";

/*
 * What the model reads from a fetched page is three ~700-character windows, so
 * the choice of window is the ceiling on research quality: a fact in paragraph
 * twelve that never lands in a passage cannot be cited, quoted or verified.
 *
 * Windows used to be ranked by term coverage plus a raw occurrence count, which
 * is exactly the scoring a keyword list wins. On the page below each tag block
 * repeats the four query terms four times each (score 400 + 16) while the
 * paragraph that states the figure has them once each (400 + 4), so with eight
 * such blocks competing for three slots the answer was never shown at all.
 * Ranking is now coverage first and BM25 within the page second: repeats
 * collapse, keyword-dense lines are discounted to a quarter, and length is
 * normalised. Measured on this page, the tag block scores 12.9 and the
 * answering window 40.9.
 */

const QUERY = "quantitative easing balance sheet";
const ANSWER =
  "Under quantitative easing the central bank expanded its balance sheet to " +
  "4.5 trillion dollars by October 2014, which is the figure the review asked for.";

function filler(index: number): string {
  return (
    `Section ${index}. This paragraph discusses monetary history in general terms ` +
    `without stating the figure anyone is looking for, and runs on for a while so ` +
    `that the document has realistic length and the windows have to compete.`
  );
}

function keywordBlock(index: number): string {
  return (
    `Tags ${index}: quantitative easing, quantitative easing, balance sheet, ` +
    `balance sheet, quantitative easing, balance sheet, quantitative easing, balance sheet`
  );
}

/** Eight keyword blocks, one real answer, filler between them. */
function buildPage(): string {
  const parts: string[] = [];
  for (let index = 1; index <= 8; index += 1) {
    parts.push(keywordBlock(index));
    parts.push(filler(index));
  }
  parts.push(`Section 12. ${ANSWER}`);
  for (let index = 13; index <= 18; index += 1) parts.push(filler(index));
  return parts.join("\n\n");
}

test("the paragraph that states the fact survives eight keyword blocks competing for the same slots", () => {
  const page = buildPage();
  const bundle = extractEvidencePassages(page, {
    query: QUERY,
    sourceLocator: "https://example.test/qe",
  });

  assert.ok(bundle.passages.length > 0, "the page must yield passages");
  const selected = bundle.passages.map((passage) => passage.text).join("\n---\n");
  assert.match(
    selected,
    /4\.5 trillion dollars by October 2014/u,
    `the answering paragraph must be one of the passages; got:\n${selected.slice(0, 400)}`,
  );
  // Not every slot may go to a tag dump: that is the failure this ranking exists
  // to prevent.
  const keywordOnly = bundle.passages.filter(
    (passage) => /^Tags \d+:/u.test(passage.text.trim()) && !passage.text.includes("4.5 trillion"),
  );
  assert.ok(
    keywordOnly.length < bundle.passages.length,
    "the keyword blocks must not take every passage slot",
  );
});

test("passages stay bounded, offset-addressable and in document order", () => {
  const page = buildPage();
  const bundle = extractEvidencePassages(page, {
    query: QUERY,
    sourceLocator: "https://example.test/qe",
  });

  assert.ok(bundle.passages.length <= 3, "the default budget is three windows");
  let previousStart = -1;
  for (const passage of bundle.passages) {
    assert.ok(passage.text.length <= 700, `${passage.text.length} chars`);
    assert.ok(passage.startChar >= 0 && passage.endChar > passage.startChar);
    // Offsets have to address the real bytes: a citation pointing at the wrong
    // span is worse than no citation.
    assert.equal(
      page.slice(passage.startChar, passage.endChar).trim().slice(0, 40),
      passage.text.trim().slice(0, 40),
    );
    // Emission is in document order, whatever the ranking decided.
    assert.ok(passage.startChar > previousStart, "passages must ascend by offset");
    previousStart = passage.startChar;
  }
  assert.equal(bundle.totalChars, page.length);
  assert.ok(bundle.includedChars <= 2100);
});

test("a page with no query terms still returns spread coverage windows", () => {
  const page = Array.from({ length: 12 }, (_, index) => filler(index + 1)).join("\n\n");
  const bundle = extractEvidencePassages(page, { query: "kryptonite supply chain" });
  assert.ok(bundle.passages.length > 1, "coverage windows must still be offered");
  assert.ok(
    bundle.passages.every((passage) => passage.selection === "coverage"),
    bundle.passages.map((passage) => passage.selection).join(","),
  );
});
