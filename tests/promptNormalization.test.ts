import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedDamerauLevenshtein,
  canonicalizeKeywordTypos,
  fuzzyCorrectionReason,
  matchKeyword,
  normalizePromptV1,
} from "../src/agent/promptNormalization";

test("normalizePromptV1 applies NFKC, lowercases, and records stable token offsets", () => {
  const normalized = normalizePromptV1("  ＷＲＩＴＥ on my Deskto!");
  assert.equal(normalized.canonicalText, "  WRITE on my Deskto!");
  assert.equal(normalized.text, "  write on my deskto!");
  assert.deepEqual(
    normalized.tokens.map(({ value, raw, start, end }) => ({
      value,
      raw,
      start,
      end,
    })),
    [
      { value: "write", raw: "WRITE", start: 2, end: 7 },
      { value: "on", raw: "on", start: 8, end: 10 },
      { value: "my", raw: "my", start: 11, end: 13 },
      { value: "deskto", raw: "Deskto", start: 14, end: 20 },
    ],
  );
});

test("bounded Damerau-Levenshtein handles substitution, transposition, and the bound", () => {
  assert.equal(boundedDamerauLevenshtein("desktop", "desktop", 2), 0);
  assert.equal(boundedDamerauLevenshtein("deskto", "desktop", 2), 1);
  assert.equal(boundedDamerauLevenshtein("crate", "create", 2), 1);
  assert.equal(boundedDamerauLevenshtein("craete", "create", 2), 1);
  assert.equal(boundedDamerauLevenshtein("dekstop", "desktop", 2), 1);
  assert.equal(boundedDamerauLevenshtein("dog", "desktop", 2), null);
  assert.equal(boundedDamerauLevenshtein("write", "white", 1), 1);
});

test("length guards keep short tokens exact-only and block short-vs-long pairings", () => {
  // ≤4 chars: never fuzzy.
  assert.equal(matchKeyword("desk", "desktop"), null);
  assert.equal(matchKeyword("mak", "make"), null);
  // The SHORTER word's budget wins: "write"(5) caps "writing"(7) at distance 1.
  assert.equal(matchKeyword("writing", "write"), null);
  // 5-7 chars: distance 1 allowed.
  assert.deepEqual(matchKeyword("deskto", "desktop"), {
    keyword: "desktop",
    token: "deskto",
    distance: 1,
  });
  assert.deepEqual(matchKeyword("crate", "create"), {
    keyword: "create",
    token: "crate",
    distance: 1,
  });
  // ≥8 chars: distance 2 allowed.
  assert.deepEqual(matchKeyword("javascrip", "javascript"), {
    keyword: "javascript",
    token: "javascrip",
    distance: 1,
  });
});

test("real-word inflections near keywords are denylisted, never corrected", () => {
  for (const token of [
    "white",
    "wrote",
    "writes",
    "written",
    "creates",
    "created",
    "document",
    "download",
    "built",
  ]) {
    assert.equal(
      matchKeyword(token, token === "document" ? "documents" : "write"),
      null,
      token,
    );
  }
  const hypothetical = canonicalizeKeywordTypos(
    "What would happen if you wrote a game in Python?",
  );
  assert.deepEqual(hypothetical.corrections, []);
  const document = canonicalizeKeywordTypos("Save the document for me.");
  assert.deepEqual(document.corrections, []);
});

test("canonicalization replaces whole-word typos and reports auditable corrections", () => {
  const result = canonicalizeKeywordTypos(
    "crate a number guessing game in Python on my deskto",
  );
  assert.equal(
    result.text,
    "create a number guessing game in Python on my desktop",
  );
  assert.deepEqual(
    result.corrections.map(fuzzyCorrectionReason).sort(),
    ["fuzzy_keyword:create~crate", "fuzzy_keyword:desktop~deskto"],
  );
  const untouched = canonicalizeKeywordTypos(
    "write a number guessing game in Python on my desktop",
  );
  assert.deepEqual(untouched.corrections, []);
  assert.equal(
    untouched.text,
    "write a number guessing game in Python on my desktop",
  );
});
