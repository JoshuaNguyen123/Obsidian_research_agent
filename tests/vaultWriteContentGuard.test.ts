import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeCurrentNoteWritePayload,
  isVaultWriteProcessNarration,
  looksLikeProcessNarrationLead,
  stripLeadingVaultWriteToolArtifact,
} from "../src/agent/vaultWriteContentGuard";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";

const META_APPEND_ONLY = [
  "I need to replace the current note content entirely with the revised essay, but I only have `append_to_current_file` available — I don't have access to `replace_current_file` in this session. I'll append the revised essay now, but please note the previous draft will still be above it. You may want to manually delete the earlier version afterward.",
  "",
  "Let me write the revised 2000-2200 word version and append it:",
].join("\n");

test("process narration from append-only rewrite is detected", () => {
  assert.equal(isVaultWriteProcessNarration(META_APPEND_ONLY), true);
  assert.equal(looksLikeProcessNarrationLead(META_APPEND_ONLY), true);
});

test("real essay body is not process narration", () => {
  const essay = [
    "# Catcher in the Rye",
    "",
    "Holden Caulfield wanders New York in a fog of alienation.",
    "The novel's voice is intimate, defensive, and searching.",
  ].join("\n");
  assert.equal(isVaultWriteProcessNarration(essay), false);
  assert.equal(looksLikeProcessNarrationLead(essay), false);
});

test("leading write-tool artifact is removed only before a real markdown title", () => {
  const leaked = [
    "replace_current_file",
    "",
    "# Essential Literary Works",
    "",
    "The corrected essay begins here.",
  ].join("\n");
  assert.equal(
    stripLeadingVaultWriteToolArtifact(leaked),
    "# Essential Literary Works\n\nThe corrected essay begins here.",
  );
  assert.equal(isVaultWriteProcessNarration(leaked), true);

  const legitimate = [
    "# Tool Registry Notes",
    "",
    "The `replace_current_file` tool requires explicit replacement intent.",
  ].join("\n");
  assert.equal(stripLeadingVaultWriteToolArtifact(legitimate), legitimate);
  assert.equal(isVaultWriteProcessNarration(legitimate), false);
});

test("assertSafe rejects process narration on append", () => {
  assert.throws(
    () =>
      assertSafeCurrentNoteWritePayload({
        kind: "append",
        text: META_APPEND_ONLY,
        currentContent: "x".repeat(2000),
      }),
    /process narration/i,
  );
});

test("assertSafe rejects catastrophic short replace", () => {
  assert.throws(
    () =>
      assertSafeCurrentNoteWritePayload({
        kind: "replace",
        text: "# Stub\n\nToo short.",
        currentContent: "y".repeat(3000),
      }),
    /far shorter|discard most/i,
  );
});

test("revised essay language authorizes replace", () => {
  assert.equal(
    hasAuthorizedCurrentNoteReplaceIntent(
      "Can you write me a revised 2000-2200 word version of this essay?",
    ),
    true,
  );
});
