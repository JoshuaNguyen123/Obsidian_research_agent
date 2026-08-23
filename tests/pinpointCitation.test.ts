import assert from "node:assert/strict";
import test from "node:test";
import {
  findPinpointLocator,
  findQuoteRawOffset,
  quoteAppearsVerbatim,
} from "../src/agent/quoteMatch";
import { inferFetchability, inferSourceSignals } from "../src/agent/sourceSignals";

/*
 * Pinpoint citation.
 *
 * `verify_citation` could tell you a quote was supported and then locate it as
 * "section 2" — an index into our own cached copy, which is useless to a
 * reader holding a different edition. In primary-text disciplines the pinpoint
 * *is* the citation: John 3:16, § 230(c)(1), Institutes II.1.1, or the page a
 * court opinion's PDF puts it on.
 */

test("a raw offset points into the original text, not normalized space", () => {
  const source = "Intro.\n\n3:16   For God so   loved the world.";
  const quote = "for god so loved the world";
  assert.ok(quoteAppearsVerbatim(quote, source));
  const offset = findQuoteRawOffset(quote, source);
  assert.ok(offset > 0, `expected a raw offset, got ${offset}`);
  // Normalization collapsed three spaces, so a normalized offset would land in
  // the wrong place; the raw one must land on the real text.
  assert.ok(source.slice(offset).toLowerCase().startsWith("for god so"));
});

test("a chapter:verse marker is the pinpoint for scripture", () => {
  const source = [
    "# John",
    "",
    "3:15 Whoever believes may have eternal life.",
    "3:16 For God so loved the world.",
  ].join("\n");
  const offset = findQuoteRawOffset("For God so loved the world", source);
  const pinpoint = findPinpointLocator(source, offset);
  assert.equal(pinpoint?.kind, "verse");
  assert.equal(pinpoint?.label, "3:16");
});

test("a statute section beats the enclosing heading", () => {
  const source = [
    "# Communications Decency Act",
    "",
    "§ 230(c)(1) No provider shall be treated as the publisher of information",
    "provided by another content provider.",
  ].join("\n");
  const offset = findQuoteRawOffset("No provider shall be treated as the publisher", source);
  const pinpoint = findPinpointLocator(source, offset);
  assert.equal(pinpoint?.kind, "section");
  assert.equal(pinpoint?.label, "§ 230(c)(1)");
});

test("a PDF page marker is the only pinpoint a court opinion has", () => {
  // "## Page N" is what the companion's PDF extractor emits, and nearly every
  // court opinion is a PDF.
  const source = [
    "## Page 6",
    "",
    "Procedural history omitted.",
    "",
    "## Page 7",
    "",
    "Qualified immunity protects officers unless existing precedent placed the",
    "question beyond debate.",
  ].join("\n");
  const offset = findQuoteRawOffset("placed the question beyond debate", source);
  const pinpoint = findPinpointLocator(source, offset);
  assert.equal(pinpoint?.kind, "page");
  assert.equal(pinpoint?.label, "p. 7");
});

test("a paragraph marker is recognised", () => {
  const source = "¶ 4 The respondent concedes the point.";
  const offset = findQuoteRawOffset("The respondent concedes the point", source);
  assert.equal(findPinpointLocator(source, offset)?.label, "¶ 4");
});

test("prose with no structural markers reports no pinpoint rather than a wrong one", () => {
  const source = "A plain paragraph of prose with nothing to point at.";
  const offset = findQuoteRawOffset("nothing to point at", source);
  assert.equal(findPinpointLocator(source, offset), null);
});

test("a missing quote yields no offset and therefore no pinpoint", () => {
  const source = "3:16 For God so loved the world.";
  assert.equal(findQuoteRawOffset("a sentence that is not there", source), -1);
  assert.equal(findPinpointLocator(source, -1), null);
});

test("primary-text archives are primary sources, not generic web pages", () => {
  for (const url of [
    "https://www.ccel.org/ccel/calvin/institutes.iii.ii.html",
    "https://www.perseus.tufts.edu/hopper/text?doc=Perseus:text:1999.01.0134",
    "https://www.newadvent.org/summa/1002.htm",
    "https://en.wikisource.org/wiki/Nicene_Creed",
  ]) {
    assert.equal(
      inferSourceSignals({ url, title: "" }).sourceType,
      "primary",
      url,
    );
    // Plain, stable HTML — both the easiest thing to parse and what makes a
    // pinpoint resolvable at all.
    assert.ok(inferFetchability(url) >= 0.9, url);
  }
});
