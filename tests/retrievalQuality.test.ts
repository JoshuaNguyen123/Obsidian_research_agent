import assert from "node:assert/strict";
import test from "node:test";
import { searchMarkdownFilesTool } from "../src/tools/vaultTools";
import {
  buildRetrievalFixture,
  fixtureContext,
  scoreRetrieval,
  type RetrievalFixtureQuery,
} from "../src/tools/retrievalFixture";

/*
 * Retrieval quality baseline.
 *
 * This exists because no measurement in the repo could detect a retrieval
 * change. The chunking evaluation under `.cache/semantic-eval/` scores R@3 =
 * 1.000 for every configuration on ten notes, its live-vault half finds zero
 * usable notes, and it is gitignored so it gates nothing.
 *
 * These numbers are a *baseline to improve on*, not a target that has been met.
 * They run against the real search tool over a corpus built to discriminate, so
 * a ranking change moves them. Deliberately no embedder: this scores the
 * lexical path, which runs everywhere and in CI, and is the half the plan's A1
 * and A4 items change.
 */

const { notes, queries } = buildRetrievalFixture();
const context = fixtureContext(notes);

async function rank(query: RetrievalFixtureQuery): Promise<string[]> {
  const result = (await searchMarkdownFilesTool.execute(
    { query: query.text, limit: 10 },
    context,
  )) as { results: Array<{ path: string }> };
  return result.results.map((item) => item.path);
}

async function scoreAll() {
  const ranked = [];
  for (const query of queries) {
    ranked.push({ query, paths: await rank(query) });
  }
  return scoreRetrieval(ranked);
}

test("the fixture is large and varied enough to discriminate", () => {
  // Past MAX_LISTED_FILES, so a silent cap cannot hide inside a green score.
  assert.ok(notes.length > 300, `expected >300 notes, got ${notes.length}`);
  assert.ok(queries.length >= 10, `expected >=10 queries, got ${queries.length}`);

  // Every query must be answerable, or the score measures the fixture's bugs.
  const paths = new Set(notes.map((note) => note.path));
  for (const query of queries) {
    for (const relevant of query.relevantPaths) {
      assert.ok(paths.has(relevant), `query "${query.text}" cites missing ${relevant}`);
    }
  }
});

test("records the measured lexical retrieval baseline", async () => {
  const score = await scoreAll();

  // Measured, not aspirational. History of this ratchet:
  //   2026-08-26  recall@1 = 0.00, recall@3 = 1.00, MRR = 0.50 -- additive term
  //               frequency; a keyword-stuffed note outranked every answer.
  //   2026-09-03  recall@1 = 1.00, recall@3 = 1.00, MRR = 1.00 -- corpus-aware
  //               ranking (src/tools/lexicalRanking.ts): informative occurrence
  //               counting, BM25 IDF over the scanned corpus, saturating
  //               length-normalized term frequency (b = 0.5), query coverage.
  //
  // Pinned as a ratchet. An improvement raises these floors in the same commit
  // and cites the numbers; a drop is a regression to explain, not a threshold
  // to relax.
  assert.equal(score.queriesScored, queries.length);
  assert.ok(
    score.recallAt1 >= 1,
    `recall@1 regressed below the recorded floor of 1.0: ${JSON.stringify(score)}`,
  );
  assert.ok(
    score.recallAt3 >= 1,
    `recall@3 regressed below the recorded floor of 1.0: ${JSON.stringify(score)}`,
  );
  assert.ok(
    score.meanReciprocalRank >= 1,
    `MRR regressed below the recorded floor of 1.0: ${JSON.stringify(score)}`,
  );
});

test("a match past the snippet boundary is still findable by full-content search", async () => {
  // search_markdown_files reads whole file contents, so it can see this. The
  // indexed hybrid path cannot: lexicalScoreForRow scores row.snippet, capped
  // at MAX_INDEX_SNIPPET_CHARS = 360, while chunks run 300-700 tokens. This
  // asserts the property the indexed path must reach once A4 lands, and names
  // the gap between the two paths until it does.
  const buried = queries.find((query) =>
    query.probes.includes("past the 360-character snippet boundary"),
  );
  assert.ok(buried);

  const paths = await rank(buried);
  assert.ok(
    paths.includes(buried.relevantPaths[0]),
    `full-content search should find the buried match, got ${JSON.stringify(paths.slice(0, 5))}`,
  );
});

test("a keyword distractor never outranks an answering note", async () => {
  // Measured on all ten queries. Until 2026-09-03 the distractor -- the query
  // term repeated five times with no fact stated -- won every query under raw
  // term frequency. Informative occurrence counting collapses that repeat run
  // to one discounted match, and the answering note wins 10/10. This is the
  // inverted form of the failing assertion that pinned the defect; it stays
  // exact so a regression to "the distractor wins one query" is loud.
  let distractorFirst = 0;
  for (const query of queries) {
    const paths = await rank(query);
    if (paths[0]?.startsWith("Distractors/")) distractorFirst += 1;
  }

  assert.equal(
    distractorFirst,
    0,
    `a keyword distractor outranked an answering note on ${distractorFirst}/${queries.length} queries.`,
  );
});
