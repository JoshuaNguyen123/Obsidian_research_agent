import assert from "node:assert/strict";
import test from "node:test";

import { summaryWriteReceiptsV1 } from "../e2e/reporters/dailyUseReporter";
import { summarizeAttemptAcceptance } from "../scripts/run-proof-matrix.mjs";

// These two seams are where the artifact-identity aggregation previously read
// a field off the wrong object and went silently inert. They get direct tests.

const summaryBase = {
  scenarioId: "S",
  acceptanceStatus: "pass",
  missionScorecard: { total: 0.9, acceptancePassed: true },
  retries: 0,
  artifactProofCount: 1,
  cleanupProofCount: 0,
  artifactIdentity: `sha256:${"a".repeat(64)}`,
};

test("summaryWriteReceiptsV1 sums known counts and stays null when nothing knew", () => {
  assert.equal(
    summaryWriteReceiptsV1([
      { toolCallOutcomes: { writeReceipts: 2 } },
      { toolCallOutcomes: { writeReceipts: 1 } },
    ]),
    3,
  );
  assert.equal(summaryWriteReceiptsV1([{ toolCallOutcomes: { writeReceipts: 0 } }]), 0, "0 is a known count");
  assert.equal(summaryWriteReceiptsV1([{ toolCallOutcomes: { writeReceipts: null } }]), null, "null is unknown");
  assert.equal(summaryWriteReceiptsV1([{ toolCallOutcomes: null }]), null);
  assert.equal(summaryWriteReceiptsV1([]), null);
  assert.equal(
    summaryWriteReceiptsV1([
      { toolCallOutcomes: { writeReceipts: 2 } },
      { toolCallOutcomes: { writeReceipts: null } },
    ]),
    2,
    "one known record is enough to know something",
  );
});

test("summarizeAttemptAcceptance carries writeReceipts off the ROLLUP: 0 is read-only, null is unknown", () => {
  const readOnly: any = summarizeAttemptAcceptance(
    { summaries: [{ ...summaryBase, writeReceipts: 0 }] } as any,
    true,
    null,
  );
  assert.equal(readOnly.writeReceipts, 0);
  assert.equal(readOnly.acceptanceStatus, "pass");

  const wrote: any = summarizeAttemptAcceptance(
    { summaries: [{ ...summaryBase, writeReceipts: 2 }, { ...summaryBase, writeReceipts: 1 }] } as any,
    true,
    null,
  );
  assert.equal(wrote.writeReceipts, 3);

  const unknown: any = summarizeAttemptAcceptance({ summaries: [{ ...summaryBase }] } as any, true, null);
  assert.equal(unknown.writeReceipts, null, "a rollup that never carried the field is unknown, not zero");

  const none: any = summarizeAttemptAcceptance({ summaries: [] } as any, true, null);
  assert.equal(none.writeReceipts, null);
  assert.equal(none.acceptanceStatus, "unknown");
});

test("the acceptance record it produces satisfies the gate's read-only exemption end to end", () => {
  // The shape the cohort gate reads: writeReceipts === 0 with no identity must
  // be the exempt case, and writeReceipts absent must not be.
  const readOnly: any = summarizeAttemptAcceptance(
    { summaries: [{ ...summaryBase, artifactIdentity: null, writeReceipts: 0 }] } as any,
    true,
    null,
  );
  assert.equal(readOnly.writeReceipts, 0);
  assert.equal(readOnly.artifactIdentity, null);
});
