import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  detectExternalStreamEdit,
  formatExternalStreamEditMessage,
  stripWritebackDialoguePreamble,
} from "../src/agent/streamedWritebackGuard";

test("identical live content is not an external edit", () => {
  const content = "# Note\n\nstreamed body\n";
  assert.equal(
    detectExternalStreamEdit({ expected: content, observed: content }),
    null,
  );
});

test("a CRLF note read back from an LF editor buffer is not an external edit", () => {
  // The vault stores CRLF on Windows while the editor buffer holds LF; that
  // round-trip must never abort a healthy stream.
  assert.equal(
    detectExternalStreamEdit({
      expected: "# Note\r\n\r\nstreamed body\r\n",
      observed: "# Note\n\nstreamed body\n",
    }),
    null,
  );
});

test("a single typed character between flushes is an external edit", () => {
  const expected = "# Note\n\nstreamed body\n";
  const observed = "# Note\n\nx streamed body\n";
  const conflict = detectExternalStreamEdit({ expected, observed });
  assert.ok(conflict, "the gate must trip on any unexplained divergence");
  assert.equal(conflict.reason, "external_note_edit");
  assert.equal(conflict.expectedChars, expected.length);
  assert.equal(conflict.observedChars, observed.length);
});

test("a deletion by the reader is an external edit too", () => {
  const conflict = detectExternalStreamEdit({
    expected: "# Note\n\nstreamed body\n",
    observed: "# Note\n",
  });
  assert.ok(conflict);
  assert.equal(conflict.reason, "external_note_edit");
});

test("the stop message names the path, keeps the edit, and never offers an overwriting retry", () => {
  const message = formatExternalStreamEditMessage("Research/CRDT.md", 512);
  assert.match(message, /Research\/CRDT\.md/u);
  assert.match(message, /512 streamed characters/u);
  assert.match(message, /nothing was overwritten/u);
  // Content-free by design: the reader's bytes must never round-trip through
  // an error string.
  assert.doesNotMatch(message, /streamed body/u);
});

test("the stop message stays well-formed without a path", () => {
  const message = formatExternalStreamEditMessage(null, 0);
  assert.match(message, /the note changed outside this run/u);
});

test("correction dialogue above the opening heading is stripped from a staged candidate", () => {
  const note = "# Fundamental Theorem of Calculus\n\nBody with [P1] citations.\n";
  const candidate =
    "I've corrected the quoted passage as requested \u2014 here is the corrected note:\n\n" +
    note;
  const result = stripWritebackDialoguePreamble(candidate);
  assert.equal(result.content, note);
  assert.ok(result.strippedPreamble);
  assert.match(result.strippedPreamble, /corrected the quoted passage/);
});

test("a lead-in line ending with a colon is stripped even without a first-person opener", () => {
  const note = "## Findings\n\ncontent\n";
  const result = stripWritebackDialoguePreamble(
    "The corrected note follows below:\n\n" + note,
  );
  assert.equal(result.content, note);
});

test("a candidate opening with YAML frontmatter is never touched", () => {
  const candidate = "---\ntitle: x\n---\n\nHere is a phrase:\n\n# Heading\n";
  const result = stripWritebackDialoguePreamble(candidate);
  assert.equal(result.content, candidate);
  assert.equal(result.strippedPreamble, null);
});

test("legitimate prose before a later heading is kept verbatim", () => {
  // No dialogue opener and no lead-in colon: this could be the note's own
  // introduction, so ambiguity must resolve to keeping the bytes.
  const candidate =
    "Quantum error correction protects logical qubits.\n\n# Approaches\n";
  const result = stripWritebackDialoguePreamble(candidate);
  assert.equal(result.content, candidate);
  assert.equal(result.strippedPreamble, null);
});

test("a prefix containing markdown structure is treated as content, not dialogue", () => {
  const candidate = "Here is the summary:\n- first point\n\n# Details\n";
  const result = stripWritebackDialoguePreamble(candidate);
  assert.equal(result.content, candidate);
  assert.equal(result.strippedPreamble, null);
});

test("a CRLF candidate keeps its original bytes after the strip", () => {
  const note = "# Title\r\n\r\nCRLF body\r\n";
  const result = stripWritebackDialoguePreamble(
    "Sure, here is the revised note:\r\n\r\n" + note,
  );
  assert.equal(result.content, note);
});

test("an over-long prefix is kept even when it opens conversationally", () => {
  const longPrefix = "I've updated the note. " + "x".repeat(420);
  const candidate = longPrefix + "\n\n# Heading\n";
  const result = stripWritebackDialoguePreamble(candidate);
  assert.equal(result.content, candidate);
  assert.equal(result.strippedPreamble, null);
});
