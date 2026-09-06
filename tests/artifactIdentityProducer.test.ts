import assert from "node:assert/strict";
import test from "node:test";

import {
  RECEIPT_IDENTITY_DIGEST,
  artifactIdentityFromReceiptsV1,
  foldToolCallOutcomesV1,
  normalizeMissionToolEventV1,
  projectVerifiedReadbackV1,
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

// ---------------------------------------------------------------------------
// Through the REAL pipeline. The tests above hand the producer receipts with
// their identities intact. On 2026-09-06 the first live qualification attempt
// showed that no receipt ever reaches it that way: normalization projected the
// readback down to {status} and the identities were gone. These tests push a
// product-shaped receipt through normalization first.

/** A receipt as AgentRunner emits it for a note append, poison included. */
const PRODUCT_APPEND_RECEIPT = {
  id: "3:0:append_to_current_file",
  toolName: "append_to_current_file",
  operation: "append",
  commitKind: "committed",
  bytesWritten: 128,
  affectedCount: 1,
  effects: { changed: true },
  path: "Research/Private Client Note.md",
  message: "The patient diagnosis was confirmed on Tuesday.",
  readback: {
    status: "verified",
    checkedAt: "2026-09-06T18:00:00.000Z",
    observedRevision: "fnv1a32:0badf00d",
    observedFingerprint: "fnv1a32:deadbeef",
    priorRevision: "fnv1a32:00000001",
  },
};

test("a product-shaped append receipt keeps its identity THROUGH normalization and the fold", () => {
  const event = normalizeMissionToolEventV1(PRODUCT_APPEND_RECEIPT, "receipt");
  assert.ok(event && event.kind === "receipt");
  assert.deepEqual(
    (event as any).receipt.readback,
    { status: "verified", observedRevision: "fnv1a32:0badf00d", observedFingerprint: "fnv1a32:deadbeef" },
    "the verdict and the two digests cross; nothing else from the readback does",
  );
  const crossed = JSON.stringify(event);
  for (const forbidden of ["Private Client Note", "diagnosis", "checkedAt", "priorRevision", "fnv1a32:00000001"]) {
    assert.ok(!crossed.includes(forbidden), `${forbidden} must not survive normalization`);
  }

  const counts = foldToolCallOutcomesV1(
    [
      { kind: "tool_start", id: "3:0:append_to_current_file", toolName: "append_to_current_file" },
      { kind: "tool_done", id: "3:0:append_to_current_file", toolName: "append_to_current_file", ok: true, errorCode: null },
      event!,
    ],
    { coverage: "complete" },
  );
  assert.equal(counts.writeReceipts, 1, "the append is a written artifact");
  assert.ok(
    typeof counts.artifactIdentity === "string" && /^sha256:[0-9a-f]{64}$/u.test(counts.artifactIdentity),
    `a written artifact must carry an identity after the real pipeline, got ${counts.artifactIdentity}`,
  );
});

test("both digest shapes the product emits are accepted; a malformed one is not", () => {
  assert.ok(RECEIPT_IDENTITY_DIGEST.test("fnv1a32:0badf00d"), "AgentRunner note writebacks");
  assert.ok(RECEIPT_IDENTITY_DIGEST.test(hash("a")), "sha256Fingerprint writebacks");
  assert.ok(artifactIdentityFromReceiptsV1([wrote("fnv1a32:0badf00d")]));
  assert.notEqual(artifactIdentityFromReceiptsV1([wrote("fnv1a32:0badf00d")]), artifactIdentityFromReceiptsV1([wrote("fnv1a32:0badf00e")]));
  assert.equal(artifactIdentityFromReceiptsV1([wrote("fnv1a32:0badf00")]), null, "7 hex digits is not an fnv1a32 digest");
  assert.equal(artifactIdentityFromReceiptsV1([wrote("fnv1a32:0badf00dz")]), null, "trailing garbage is not a digest");
  assert.equal(artifactIdentityFromReceiptsV1([wrote("Research/Private Client Note.md")]), null, "a path is never an identity");
});

test("projectVerifiedReadbackV1 carries nothing for an unverified readback, even with digests", () => {
  assert.equal(projectVerifiedReadbackV1({ status: "not_required", observedRevision: "fnv1a32:0badf00d" }), undefined);
  assert.equal(projectVerifiedReadbackV1(null), undefined);
  assert.equal(projectVerifiedReadbackV1("verified"), undefined);
  assert.deepEqual(projectVerifiedReadbackV1({ status: "verified", observedRevision: "not a digest" }), { status: "verified" });
});
