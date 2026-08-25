import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createDegenerateStreamDetector,
  formatDegenerateStreamMessage,
} from "../src/model/degenerateStreamGuard";

test("an unbounded zero stream is condemned once the window fills", () => {
  // The live 2026-08-25 failure shape: deepseek emitting "000000..." forever.
  const detector = createDegenerateStreamDetector();
  let verdict = null;
  for (let i = 0; i < 40 && !verdict; i += 1) {
    verdict = detector.feed("0".repeat(100));
  }
  assert.ok(verdict, "the zero stream must be condemned");
  assert.equal(verdict.unit, "0");
  assert.match(formatDegenerateStreamMessage(verdict), /degenerate stream/);
});

test("a repeated short phrase cycle is condemned", () => {
  const detector = createDegenerateStreamDetector();
  let verdict = null;
  const phrase = "let me look. ";
  for (let i = 0; i < 400 && !verdict; i += 1) {
    verdict = detector.feed(phrase);
  }
  assert.ok(verdict, "a short phrase cycle must be condemned");
  assert.equal(phrase.repeat(4).includes(verdict.unit), true);
});

test("ordinary long prose never trips the guard", () => {
  const detector = createDegenerateStreamDetector();
  for (let i = 0; i < 200; i += 1) {
    const verdict = detector.feed(
      "Paragraph " + i + " discusses a different aspect of the design, citing sources and varying its wording each time. ",
    );
    assert.equal(verdict, null, "varied prose was condemned at delta " + i);
  }
});

test("a long run embedded in progressing output does not trip", () => {
  // A 2000-char divider or filler is fine as long as real text keeps flowing.
  const detector = createDegenerateStreamDetector();
  assert.equal(detector.feed("= ".repeat(1000)), null);
  assert.equal(detector.feed("Now the analysis continues with substantive content that varies. "), null);
  assert.equal(detector.feed("= ".repeat(1000)), null);
  const after = detector.feed("And another real paragraph follows the second divider here. ");
  assert.equal(after, null);
});

test("the verdict is sticky once reached", () => {
  const detector = createDegenerateStreamDetector();
  let verdict = null;
  for (let i = 0; i < 40 && !verdict; i += 1) verdict = detector.feed("ab".repeat(50));
  assert.ok(verdict);
  assert.deepEqual(detector.feed("fresh varied text"), verdict);
});
