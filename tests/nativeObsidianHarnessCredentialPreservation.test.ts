import assert from "node:assert/strict";
import test from "node:test";

import { preserveConfiguredLinearCredentialState } from "../e2e/fixtures/nativeObsidianHarness";

test("native harness preserves rotated opaque Linear state and restores unrelated bytes", () => {
  const baseline = JSON.stringify({
    unrelated: "baseline",
    linearCredentialReference: null,
    linearOAuthRuntimeState: { version: 1, marker: "old" },
  });
  const current = JSON.stringify({
    unrelated: "test mutation",
    linearCredentialReference: null,
    linearOAuthRuntimeState: { version: 1, marker: "rotated" },
  });
  const restored = preserveConfiguredLinearCredentialState(
    baseline,
    current,
    true,
  );
  assert.ok(restored);
  const parsed = JSON.parse(restored);
  assert.equal(parsed.unrelated, "baseline");
  assert.deepEqual(parsed.linearOAuthRuntimeState, {
    version: 1,
    marker: "rotated",
  });
  assert.equal(parsed.linearCredentialReference, null);
});

test("native harness does not capture a test-owned credential or alter an exact baseline", () => {
  const baseline = JSON.stringify({ unrelated: "baseline" });
  const current = JSON.stringify({
    unrelated: "test mutation",
    linearOAuthRuntimeState: { version: 1, marker: "test-owned" },
  });
  assert.equal(
    preserveConfiguredLinearCredentialState(baseline, current, true),
    baseline,
  );
  assert.equal(
    preserveConfiguredLinearCredentialState(baseline, current, false),
    baseline,
  );
});
