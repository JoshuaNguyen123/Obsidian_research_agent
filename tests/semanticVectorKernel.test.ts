import assert from "node:assert/strict";
import test from "node:test";
import {
  cosineSimilarity,
  cosineSimilarityAt,
  vectorNorm,
} from "../src/utils/vectorMath";
import { decodeFloat32Base64Typed } from "../src/embeddings/semanticIndex";

/*
 * Semantic scan kernel parity.
 *
 * The scan used to slice each row out of the decoded shard and recompute the
 * query norm per row. The flat kernel must produce the same similarity to six
 * decimals, or a ranking change would hide inside a performance change.
 */

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("cosineSimilarityAt matches cosineSimilarity on every row of a flat matrix", () => {
  const random = seededRandom(7);
  const dim = 64;
  const rows = 50;
  const matrix = new Float32Array(dim * rows);
  for (let index = 0; index < matrix.length; index += 1) {
    matrix[index] = random() * 2 - 1;
  }
  const query = Float32Array.from({ length: dim }, () => random() * 2 - 1);
  const queryNorm = vectorNorm(query);

  for (let row = 0; row < rows; row += 1) {
    const expected = cosineSimilarity(
      Array.from(query),
      Array.from(matrix.subarray(row * dim, (row + 1) * dim)),
    );
    const actual = cosineSimilarityAt(matrix, row * dim, dim, query, queryNorm);
    assert.equal(actual.toFixed(6), expected.toFixed(6), `row ${row}`);
  }
});

test("degenerate inputs score zero instead of NaN", () => {
  const zeros = new Float32Array(8);
  const query = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(cosineSimilarityAt(zeros, 0, 8, query, vectorNorm(query)), 0);
  assert.equal(cosineSimilarityAt(query, 0, 8, zeros, vectorNorm(zeros)), 0);
  assert.equal(cosineSimilarityAt(query, 8, 8, query, vectorNorm(query)), 0, "offset past the end");
  assert.equal(vectorNorm([]), 0);
});

test("the typed base64 decode reproduces the encoded float32 values", () => {
  const values = Float32Array.from([0.25, -1.5, 3.75, 1e-3, -0.125, 42]);
  const base64 = Buffer.from(values.buffer).toString("base64");
  const decoded = decodeFloat32Base64Typed(base64);
  assert.equal(decoded.length, values.length);
  for (let index = 0; index < values.length; index += 1) {
    assert.equal(decoded[index], values[index]);
  }
  assert.equal(decodeFloat32Base64Typed("").length, 0);
});
