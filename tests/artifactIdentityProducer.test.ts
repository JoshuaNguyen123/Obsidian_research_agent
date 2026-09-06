import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactIdentityFromReceiptsV1,
  foldToolCallOutcomesV1,
  writeReceiptCountV1,
} from "../e2e/fixtures/toolCallOutcomes";

const SHA = /^sha256:[0-9a-f]{64}$/u;
const hash = (n: string) => `sha256:${n.repeat(64).slice(0, 64)}`;

/** A receipt that really wrote something, carrying the product's own readback. */
function wrote(revision: string, extra: Record<string, unknown> = {}) {
  return {
    toolName: "append_to_current_file",
    operation: "append",
    commitKind: "committed",
    bytesWritten: 128,
    affectedCount: 1,
    effects: { changed: true },
    readback: { status: "verified", observedRevision: revision },
    ...extra,
  };
}

test("a mission that wrote artifacts gets a content-derived identity", () => {
  const id = artifactIdentityFromReceiptsV1([wrote(hash("a"))]);
  assert.ok(id && SHA.test(id), `expected a sha256 identity, got ${id}`);
});

test("the SAME artifact read twice yields the SAME identity - the stale-snapshot case", () => {
  const first = artifactIdentityFromReceiptsV1([wrote(hash("a"))]);
  const second = artifactIdentityFromReceiptsV1([wrote(hash("a"))]);
  assert.equal(first, second);
});

test("DIFFERENT artifacts yield DIFFERENT identities - the control", () => {
  const first = artifactIdentityFromReceiptsV1([wrote(hash("a"))]);
  const second = artifactIdentityFromReceiptsV1([wrote(hash("b"))]);
  assert.notEqual(first, second);
  assert.ok(first && second);
});

test("identity is order-independent across receipts", () => {
  const forward = artifactIdentityFromReceiptsV1([wrote(hash("a")), wrote(hash("b"))]);
  const reverse = artifactIdentityFromReceiptsV1([wrote(hash("b")), wrote(hash("a"))]);
  assert.equal(forward, reverse);
});

test("no identity-bearing receipt yields null, never a placeholder", () => {
  assert.equal(artifactIdentityFromReceiptsV1([]), null);
  assert.equal(artifactIdentityFromReceiptsV1(null), null);
  assert.equal(
    artifactIdentityFromReceiptsV1([{ toolName: "x", commitKind: "committed", effects: { changed: true } }]),
    null,
  );
});

test("a verdict-only validation receipt is not an artifact", () => {
  const validation = {
    toolName: "code_validate_fast",
    operation: "validate",
    commitKind: "committed",
    exitCode: 0,
    affectedCount: 0,
    readback: { status: "verified", observedRevision: hash("c") },
  };
  assert.equal(artifactIdentityFromReceiptsV1([validation]), null);
});

test("an intentional no-op contributes nothing", () => {
  assert.equal(
    artifactIdentityFromReceiptsV1([wrote(hash("a"), { commitKind: "no_op" })]),
    null,
  );
});

test("a malformed revision is refused rather than hashed", () => {
  assert.equal(artifactIdentityFromReceiptsV1([wrote("not-a-hash")]), null);
  assert.equal(artifactIdentityFromReceiptsV1([wrote("sha256:zzzz")]), null);
});

test("the fold carries the identity onto its counts", () => {
  const counts = foldToolCallOutcomesV1([
    { kind: "tool_start", id: "1", toolName: "append_to_current_file" },
    { kind: "tool_done", id: "1", toolName: "append_to_current_file", ok: true },
    { kind: "receipt", id: "1", receipt: wrote(hash("a")) },
  ] as any);
  assert.equal(counts.coverage, "complete");
  assert.ok(counts.artifactIdentity && SHA.test(counts.artifactIdentity));
});

test("a lossy fold reports no identity - a holed capture cannot prove distinctness", () => {
  const counts = foldToolCallOutcomesV1([] as any, { coverage: "lossy" });
  assert.equal(counts.artifactIdentity, null);
});

test("writeReceipts counts only worked receipts that mutated something", () => {
  const search = { toolName: "semantic_search_notes", operation: "search", commitKind: "committed", effects: { changed: false }, affectedCount: 0 };
  assert.equal(writeReceiptCountV1([wrote(hash("a"))]), 1);
  assert.equal(writeReceiptCountV1([wrote(hash("a")), wrote(hash("b"))]), 2);
  assert.equal(writeReceiptCountV1([search]), 0, "a read is not a write");
  assert.equal(writeReceiptCountV1([wrote(hash("a"), { commitKind: "no_op" })]), 0, "a no-op wrote nothing");
  assert.equal(writeReceiptCountV1([]), 0);
});

test("a read-only fold reports writeReceipts 0 with a null identity: honest, not missing", () => {
  const counts = foldToolCallOutcomesV1([
    { kind: "tool_start", id: "1", toolName: "semantic_search_notes" },
    { kind: "tool_done", id: "1", toolName: "semantic_search_notes", ok: true },
    { kind: "receipt", id: "1", receipt: { toolName: "semantic_search_notes", operation: "search", commitKind: "committed", effects: { changed: false } } },
  ] as any);
  assert.equal(counts.writeReceipts, 0);
  assert.equal(counts.artifactIdentity, null);
});

test("a lossy fold reports writeReceipts null: unknown is not zero", () => {
  assert.equal(foldToolCallOutcomesV1([] as any, { coverage: "lossy" }).writeReceipts, null);
});
