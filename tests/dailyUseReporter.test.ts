import assert from "node:assert/strict";
import test from "node:test";

import { shouldWriteDailyUseSummary } from "../e2e/reporters/dailyUseReporter";

test("daily-use reporter preserves the prior summary for listing and zero-test selections", () => {
  assert.equal(shouldWriteDailyUseSummary(0), false);
  assert.equal(shouldWriteDailyUseSummary(1), true);
  assert.equal(shouldWriteDailyUseSummary(-1), false);
});
