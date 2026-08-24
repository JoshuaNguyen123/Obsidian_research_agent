import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  detectExternalStreamEdit,
  formatExternalStreamEditMessage,
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
