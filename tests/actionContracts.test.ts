import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  computePreparedActionFingerprint,
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type PreparedActionInput,
} from "../src/agent/actions";

test("canonical JSON sorts recursively and SHA-256 is stable", async () => {
  const first = { z: [3, { b: 2, a: 1 }], a: true };
  const second = { a: true, z: [3, { a: 1, b: 2 }] };

  assert.equal(
    canonicalJson(first),
    '{"a":true,"z":[3,{"a":1,"b":2}]}',
  );
  assert.equal(await sha256Fingerprint(first), await sha256Fingerprint(second));
  assert.equal(
    await sha256Fingerprint({ b: 2, a: 1 }),
    "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
});

test("canonical JSON rejects values that JSON would silently change", () => {
  assert.throws(() => canonicalJson({ missing: undefined }), /Unsupported value/);
  assert.throws(() => canonicalJson({ value: Number.NaN }), /Non-finite/);
  assert.throws(() => canonicalJson([, 1]), /Sparse array/);
  assert.equal(canonicalJson(-0), "0");
});

test("prepared action fingerprint covers payload, target, and preview", async () => {
  const input = preparedActionInput();
  const action = await withPreparedActionFingerprint(input);

  assert.equal(
    action.payloadFingerprint,
    await computePreparedActionFingerprint(action),
  );
  const changed = {
    ...action,
    normalizedArgs: { ...action.normalizedArgs, title: "Different ticket" },
  };
  assert.notEqual(
    action.payloadFingerprint,
    await computePreparedActionFingerprint(changed),
  );
});

function preparedActionInput(): PreparedActionInput {
  return {
    version: 1,
    id: "action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "linear_create_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: "new:call-1",
      teamId: "team-1",
    },
    relatedResources: [],
    normalizedArgs: { title: "Research follow-up" },
    preview: {
      summary: "Create one Linear issue",
      destination: "Linear team team-1",
      outboundPayload: { title: "Research follow-up" },
      warnings: [],
      outboundBytes: 26,
    },
    idempotencyKey: "run-1:call-1",
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  };
}
