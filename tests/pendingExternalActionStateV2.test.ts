import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingExternalActionStateV2,
  parsePendingExternalActionStateV2,
} from "../src/integrations/PendingExternalActionStateV2";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

test("provider-neutral pending action round-trips a GitHub uncertain dispatch", () => {
  const pending = createPendingExternalActionStateV2({
    schemaVersion: 2,
    provider: "github",
    operation: "push_owned_branch",
    actionId: "github-push:run-1",
    resourceId: "acme.research-agent:codex.eng-12",
    preparedActionFingerprint: SHA_A,
    targetFingerprint: SHA_B,
    dispatchState: "reconcile_required",
    attempt: 1,
    preparedAt: "2026-07-12T12:00:00.000Z",
    dispatchedAt: "2026-07-12T12:00:01.000Z",
    lastObservedAt: "2026-07-12T12:00:02.000Z",
    providerRequestId: null,
    error: {
      code: "github_push_uncertain",
      message: "Remote ref readback was unavailable after dispatch.",
    },
  });

  assert.deepEqual(parsePendingExternalActionStateV2(pending), pending);
});

test("pending action rejects tampering, credentials, and impossible dispatch state", () => {
  const pending = createPendingExternalActionStateV2({
    schemaVersion: 2,
    provider: "linear",
    operation: "create_issue",
    actionId: "linear:create:1",
    resourceId: "issue.placeholder",
    preparedActionFingerprint: SHA_A,
    targetFingerprint: SHA_B,
    dispatchState: "prepared",
    attempt: 1,
    preparedAt: "2026-07-12T12:00:00.000Z",
    dispatchedAt: null,
    lastObservedAt: null,
    providerRequestId: null,
    error: { code: "pending", message: "Awaiting exact approval." },
  });

  assert.throws(() =>
    parsePendingExternalActionStateV2({ ...pending, targetFingerprint: SHA_A }),
  );
  assert.throws(() =>
    createPendingExternalActionStateV2({
      ...pending,
      pendingFingerprint: undefined,
      error: { code: "pending", message: `Bearer ${"x".repeat(32)}` },
    } as never),
  );
  assert.throws(() =>
    createPendingExternalActionStateV2({
      ...pending,
      pendingFingerprint: undefined,
      dispatchedAt: "2026-07-12T12:00:01.000Z",
    } as never),
  );
});
