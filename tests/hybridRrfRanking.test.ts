import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL,
  NEW_INSTALL_SEMANTIC_PROFILE,
  SEMANTIC_PROFILE_PRESETS,
} from "../src/agent/semanticProfile";
import {
  compareHybridScoredV1,
  legacyCosineSnippetBlendV1,
  scoreHybridCandidatesV1,
  snippetOverlapLexicalScoreV1,
} from "../src/embeddings/hybridRank";
import {
  buildRetrievalFixture,
  scoreRetrieval,
} from "../src/tools/retrievalFixture";

/*
 * Metric B.
 *
 * New-install default must be Fast (jina-v2-small, 256-token chunks). Indexed
 * hybrid ranking must beat the old 0.85*cosine + 0.15*snippet-overlap blend on
 * the paraphrase fixture. On old main the default profile is balanced / nomic
 * and fusion is that linear blend over a 360-char snippet, so this file fails
 * there on both pins.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function queryTerms(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])
        .map((term) => term.replace(/^['-]+|['-]+$/g, ""))
        .filter((term) => term.length > 2),
    ),
  ];
}

/**
 * A bi-encoder-shaped cosine: question-shaped near-misses outrank the answer
 * note. That is the failure the old linear blend followed, and the one RRF +
 * full-text BM25 is measured against.
 */
function biasedCosine(path: string): number {
  if (path.includes("open-question")) return 0.88;
  if (path.includes("-adjacent")) return 0.72;
  if (path.includes("-keywords")) return 0.5;
  if (path.includes("-appendix")) return 0.4;
  if (path.startsWith("Research/")) return 0.62;
  return 0.12;
}

function rankLegacy(query: string, notes: Array<{ path: string; content: string }>): string[] {
  const terms = new Set(queryTerms(query));
  return notes
    .map((note) => ({
      path: note.path,
      score: legacyCosineSnippetBlendV1(
        biasedCosine(note.path),
        snippetOverlapLexicalScoreV1(terms, note.content.slice(0, 360)),
      ),
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map((item) => item.path);
}

function rankHybrid(query: string, notes: Array<{ path: string; content: string }>): string[] {
  const terms = queryTerms(query);
  const heading = (content: string): string | null => {
    const match = content.match(/^#\s+(.+)$/m);
    return match?.[1] ?? null;
  };
  const scored = scoreHybridCandidatesV1(
    notes.map((note) => ({
      cosine: biasedCosine(note.path),
      lexicalText: [heading(note.content) ?? "", note.content].join("\n"),
    })),
    terms,
  );
  return notes
    .map((note, index) => ({ path: note.path, scored: scored[index]! }))
    .sort((left, right) => compareHybridScoredV1(left.scored, right.scored) || left.path.localeCompare(right.path))
    .map((item) => item.path);
}

test("Metric B: new-install default embedding model is Fast", () => {
  assert.equal(NEW_INSTALL_SEMANTIC_PROFILE, "fast");
  assert.equal(
    NEW_INSTALL_SEMANTIC_EMBEDDING_MODEL,
    "jinaai/jina-embeddings-v2-small-en",
  );
  assert.equal(
    SEMANTIC_PROFILE_PRESETS.fast.semanticEmbeddingModel,
    "jinaai/jina-embeddings-v2-small-en",
  );
  assert.equal(SEMANTIC_PROFILE_PRESETS.fast.semanticChunkTargetTokens, 256);

  const settingsSource = readFileSync(join(REPO_ROOT, "src/settings.ts"), "utf8");
  assert.match(
    settingsSource,
    /semanticProfile:\s*NEW_INSTALL_SEMANTIC_PROFILE/,
    "DEFAULT_SETTINGS.semanticProfile must be the new-install Fast preset",
  );
  assert.match(
    settingsSource,
    /SEMANTIC_PROFILE_PRESETS\[NEW_INSTALL_SEMANTIC_PROFILE\]/,
    "DEFAULT_SETTINGS must spread the Fast preset field values",
  );
});

test("Metric B: RRF + full-chunk BM25 beats 0.85*cosine+0.15*snippet on paraphrases", () => {
  const { notes, semanticQueries } = buildRetrievalFixture();
  const legacy = scoreRetrieval(
    semanticQueries.map((query) => ({ query, paths: rankLegacy(query.text, notes) })),
  );
  const hybrid = scoreRetrieval(
    semanticQueries.map((query) => ({ query, paths: rankHybrid(query.text, notes) })),
  );

  assert.equal(legacy.queriesScored, semanticQueries.length);
  assert.equal(hybrid.queriesScored, semanticQueries.length);
  assert.ok(
    hybrid.meanReciprocalRank > legacy.meanReciprocalRank,
    `paraphrase MRR must rise: legacy ${legacy.meanReciprocalRank.toFixed(3)} vs hybrid ${hybrid.meanReciprocalRank.toFixed(3)}`,
  );
  // Measured on this fixture with the question-biased cosine: legacy MRR
  // ≈ 0.090, hybrid ≈ 0.127. Pin the inequality, not the exact floats —
  // the ranking change is the gate.
});
