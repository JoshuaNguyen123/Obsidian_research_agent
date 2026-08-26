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

  // Measured, not aspirational. The headline number is recall@1 = 0: on every
  // one of the ten queries, a keyword-stuffed note that states no fact outranks
  // the note that answers the question. The answer lands at rank 2 almost
  // every time, which is what MRR = 0.5 says.
  //
  // Pinned as a ratchet. An improvement raises these floors in the same commit
  // and cites the numbers; a drop is a regression to explain, not a threshold
  // to relax.
  assert.equal(score.queriesScored, queries.length);
  assert.equal(
    score.recallAt1,
    0,
    `recall@1 moved off the recorded baseline of 0 — if this improved, raise the floor: ${JSON.stringify(score)}`,
  );
  assert.ok(
    score.recallAt3 >= 1,
    `recall@3 regressed below the recorded baseline of 1.0: ${JSON.stringify(score)}`,
  );
  assert.ok(
    score.meanReciprocalRank >= 0.5,
    `MRR regressed below the recorded baseline of 0.5: ${JSON.stringify(score)}`,
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

test("a keyword distractor currently outranks every answering note", async () => {
  // Not a soft observation: measured on all ten queries. The distractor repeats
  // the query term five times and states nothing, so raw term frequency puts it
  // first every time. This is precisely what IDF (A1's BM25) and the A5 rerank
  // exist to fix.
  //
  // Asserted in its failing form deliberately. When A1 or A5 lands, this test
  // is what proves it worked, and it must be inverted in that commit rather
  // than deleted.
  let distractorFirst = 0;
  for (const query of queries) {
    const paths = await rank(query);
    if (paths[0]?.startsWith("Distractors/")) distractorFirst += 1;
  }

  assert.equal(
    distractorFirst,
    queries.length,
    `baseline says the distractor wins every query; it now wins ${distractorFirst}/${queries.length}. If ranking improved, invert this assertion and cite the new score.`,
  );
});
