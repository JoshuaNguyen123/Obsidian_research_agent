import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunReceipt } from "../src/AgentRunner";
import { sameReceiptIdentity } from "../src/agent/receiptIdentity";

const legacy: AgentRunReceipt = {
  toolName: "append_to_current_file",
  operation: "append",
  path: "Notes/Result.md",
  message: "append Notes/Result.md",
  readback: {
    status: "verified",
    checkedAt: "2026-09-04T22:00:00.000Z",
    observedFingerprint: `sha256:${"a".repeat(64)}`,
  },
};

test("durable identities distinguish effects even when their readback is identical", () => {
  assert.equal(sameReceiptIdentity({ ...legacy, id: "op-1" }, { ...legacy, id: "op-2" }), false);
  assert.equal(sameReceiptIdentity({ ...legacy, id: "op-1" }, { ...legacy, id: "op-1", message: "restored" }), true);
});

test("legacy receipts can acquire a durable identity from the same verified readback", () => {
  assert.equal(sameReceiptIdentity(legacy, { ...legacy, id: "op-1" }), true);
  assert.equal(sameReceiptIdentity(legacy, { ...legacy, readback: {
    ...legacy.readback!, checkedAt: "2026-09-04T22:01:00.000Z",
  } }), false);
  assert.equal(sameReceiptIdentity({ ...legacy, runId: "run-1" }, { ...legacy, runId: "run-2" }), false);
});

test("unknown legacy effect identity is not inferred from an equal display label", () => {
  assert.equal(sameReceiptIdentity({ ...legacy, readback: undefined }, { ...legacy, readback: undefined }), false);
  assert.equal(sameReceiptIdentity(legacy, { ...legacy, readback: { status: "not_required", checkedAt: legacy.readback!.checkedAt } }), false);
});
