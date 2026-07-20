import assert from "node:assert/strict";
import test from "node:test";

import { createPhase7GitHubHarness } from "../e2e/fixtures/phase7GitHubHarness";

test("Phase 7 publication requests fail closed without exact fresh-full validation", async () => {
  const harness = await createPhase7GitHubHarness("unit-fresh-full");
  try {
    const incomplete = {
      publicationId: "unit-incomplete",
      baseSha: harness.fixture.baseSha,
      commitSha: harness.fixture.firstCommitSha,
      treeSha: harness.fixture.firstTreeSha,
    };
    assert.throws(
      () => harness.request(incomplete as never),
      /requires exact-commit fresh-full validation proof/iu,
    );

    const validation = await harness.fixture.validateFreshFull(
      harness.fixture.firstCommitSha,
    );
    assert.deepEqual(
      {
        commitSha: validation.commitSha,
        command: validation.command,
        testCount: validation.testCount,
        passCount: validation.passCount,
        cleanReadback: validation.cleanReadback,
      },
      {
        commitSha: harness.fixture.firstCommitSha,
        command: ["npm", "test"],
        testCount: 1,
        passCount: 1,
        cleanReadback: true,
      },
    );

    const request = harness.request({
      ...incomplete,
      publicationId: "unit-validated",
      validation,
    });
    assert.ok(
      request.handoff.validationReceiptFingerprints.includes(
        validation.fingerprint,
      ),
    );
  } finally {
    await harness.fixture.cleanup();
  }
});
