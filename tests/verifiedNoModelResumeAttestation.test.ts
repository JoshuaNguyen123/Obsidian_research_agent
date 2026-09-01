import assert from "node:assert/strict";
import test from "node:test";

import { isVerifiedNoModelResumeAttestationV1 } from "../e2e/fixtures/realAiHarness";

function validSnapshot(): any {
  return {
    diagnosticAttestations: [
      {
        id: "resume-already-verified-complete",
        kind: "verification",
      },
    ],
    lastComplete: { stopReason: "write_completed" },
    lastMissionLedger: { acceptance: { status: "pass" } },
    lastReceipts: [{ operation: "append" }],
    lastMissionGraph: {
      nodes: {
        read: { status: "complete" },
        optional: { status: "cancelled" },
      },
    },
    modelCallEvidence: [],
    providerUsage: { modelCallCount: 0 },
  };
}

test("verified no-model resume requires explicit opt-in and every terminal proof", () => {
  const snapshot = validSnapshot();
  assert.equal(isVerifiedNoModelResumeAttestationV1(snapshot, true), true);
  assert.equal(isVerifiedNoModelResumeAttestationV1(snapshot, false), false);

  const invalidSnapshots = [
    { ...snapshot, diagnosticAttestations: [] },
    {
      ...snapshot,
      diagnosticAttestations: [
        { id: "resume-already-verified-complete", kind: "status" },
      ],
    },
    { ...snapshot, lastComplete: { stopReason: "final" } },
    {
      ...snapshot,
      lastMissionLedger: { acceptance: { status: "needs_more_work" } },
    },
    { ...snapshot, lastReceipts: [] },
    { ...snapshot, lastMissionGraph: { nodes: {} } },
    {
      ...snapshot,
      lastMissionGraph: { nodes: { pending: { status: "pending" } } },
    },
    { ...snapshot, modelCallEvidence: [{ outcome: "success" }] },
    { ...snapshot, providerUsage: { modelCallCount: 1 } },
  ];

  for (const invalid of invalidSnapshots) {
    assert.equal(isVerifiedNoModelResumeAttestationV1(invalid, true), false);
  }
});
