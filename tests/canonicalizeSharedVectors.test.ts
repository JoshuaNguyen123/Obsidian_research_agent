import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalJson } from "../packages/headless-runtime/src/canonicalize";

interface CanonicalVector {
  name: string;
  value: unknown;
  canonical?: string;
  error?: string;
}

test("TypeScript and Python consume the same canonical JSON vectors", () => {
  const vectors = JSON.parse(
    readFileSync(
      new URL("../companion/tests/canonical_json_vectors.json", import.meta.url),
      "utf8",
    ),
  ) as CanonicalVector[];
  assert.ok(vectors.length >= 5);
  for (const vector of vectors) {
    if (vector.error) {
      assert.throws(
        () => canonicalJson(vector.value),
        new RegExp(vector.error, "u"),
        vector.name,
      );
    } else {
      assert.equal(canonicalJson(vector.value), vector.canonical, vector.name);
    }
  }
});
