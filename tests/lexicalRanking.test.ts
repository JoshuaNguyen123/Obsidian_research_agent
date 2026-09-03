import assert from "node:assert/strict";
import test from "node:test";
import {
  bm25ContentScoreV1,
  buildLexicalCorpusStatsV1,
  buildLexicalDocumentTermStatsV1,
  informativeOccurrenceCountV1,
  inverseDocumentFrequencyV1,
  KEYWORD_LINE_MATCH_WEIGHT,
  queryCoverageBonusV1,
} from "../src/tools/lexicalRanking";

/*
 * Corpus-aware lexical ranking primitives.
 *
 * These are the pieces behind search_markdown_files' scorer: informative
 * occurrence counting (adjacent repeats collapse, keyword lists discount),
 * BM25 IDF over the scanned corpus, and saturating length-normalized term
 * frequency.
 */

test("adjacent repeats of the needle count once", () => {
  assert.equal(
    informativeOccurrenceCountV1("chlorophyll chlorophyll, chlorophyll", "chlorophyll", ["chlorophyll"]),
    KEYWORD_LINE_MATCH_WEIGHT,
    "one keyword-list line: the run collapses to one match and is discounted",
  );
  assert.equal(
    informativeOccurrenceCountV1(
      "this note explains chlorophyll in biology.\nlater it measures chlorophyll again in the leaf.",
      "chlorophyll",
      ["chlorophyll"],
    ),
    2,
    "two mentions inside prose count in full",
  );
});

test("a line that is mostly query vocabulary is a keyword list, prose is not", () => {
  const prose = "the appendix records that quantitative easing was measured again in the follow-up study.";
  assert.equal(
    informativeOccurrenceCountV1(prose, "quantitative easing", ["quantitative", "easing", "follow-up", "study"]),
    1,
  );
  const list = "# assorted economics keywords\n\nquantitative easing quantitative easing quantitative easing\nstates no fact.";
  assert.equal(
    informativeOccurrenceCountV1(list, "quantitative easing", ["quantitative", "easing"]),
    KEYWORD_LINE_MATCH_WEIGHT,
  );
  // Two-word lines never qualify as lists: too little to judge.
  assert.equal(informativeOccurrenceCountV1("chlorophyll notes", "chlorophyll", ["chlorophyll"]), 1);
});

test("rare terms outweigh common ones and frequency saturates with length normalization", () => {
  const terms = ["chlorophyll", "study"];
  const documents = [
    buildLexicalDocumentTermStatsV1("a study of chlorophyll in leaves. the study continues.", terms),
    ...Array.from({ length: 20 }, (_, index) =>
      buildLexicalDocumentTermStatsV1(`study number ${index} about soil and water.`, terms),
    ),
  ];
  const corpus = buildLexicalCorpusStatsV1(documents);
  assert.equal(corpus.documentCount, 21);
  assert.ok(
    inverseDocumentFrequencyV1(corpus, "chlorophyll") > inverseDocumentFrequencyV1(corpus, "study"),
    "a term in one document is rarer than a term in every document",
  );
  assert.ok(inverseDocumentFrequencyV1(corpus, "unseen") > 0);

  const answer = bm25ContentScoreV1(documents[0]!, corpus);
  const filler = bm25ContentScoreV1(documents[1]!, corpus);
  assert.ok(answer > filler);
  assert.ok(answer <= 50 && filler <= 50);

  // Saturation: ten mentions are worth far less than ten times one mention.
  const once = buildLexicalDocumentTermStatsV1("chlorophyll appears here once in prose.", ["chlorophyll"]);
  const often = buildLexicalDocumentTermStatsV1(
    Array.from({ length: 10 }, (_, index) => `sentence ${index} mentions chlorophyll in passing here.`).join("\n"),
    ["chlorophyll"],
  );
  const small = buildLexicalCorpusStatsV1([once, often]);
  const onceScore = bm25ContentScoreV1(once, small);
  const oftenScore = bm25ContentScoreV1(often, small);
  assert.ok(oftenScore > onceScore);
  assert.ok(oftenScore < onceScore * 3, `ten mentions scored ${oftenScore} vs one at ${onceScore}`);
  assert.equal(bm25ContentScoreV1(buildLexicalDocumentTermStatsV1("nothing relevant", ["chlorophyll"]), small), 0);
});

test("covering every term of a multi-term query earns a bonus a one-term note cannot", () => {
  const terms = ["chlorophyll", "follow-up", "study"];
  const buried = buildLexicalDocumentTermStatsV1(
    "the appendix records that chlorophyll was measured again in the follow-up study.",
    terms,
  );
  const partial = buildLexicalDocumentTermStatsV1("this note explains chlorophyll in biology.", terms);
  assert.equal(queryCoverageBonusV1(buried, terms.length), 30);
  assert.equal(queryCoverageBonusV1(partial, terms.length), 0);
  assert.equal(queryCoverageBonusV1(buried, 1), 0, "single-term queries have nothing to cover");
});
