import assert from "node:assert/strict";
import test from "node:test";

import {
  selectAtomicDailyUseObservation,
  shouldWriteDailyUseSummary,
} from "../e2e/reporters/dailyUseReporter";

test("daily-use reporter preserves the prior summary for listing and zero-test selections", () => {
  assert.equal(shouldWriteDailyUseSummary(0), false);
  assert.equal(shouldWriteDailyUseSummary(1), true);
  assert.equal(shouldWriteDailyUseSummary(-1), false);
});

test("daily-use reporter never unions complementary retry proof", () => {
  const first = {
    status: "failed",
    retry: 0,
    acceptanceStatus: "needs_more_work" as const,
    missingAcceptanceCriteria: ["proof:b"],
    observed: {
      artifacts: ["artifact:a"],
      proofs: ["proof:a"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
  };
  const second = {
    status: "failed",
    retry: 1,
    acceptanceStatus: "needs_more_work" as const,
    missingAcceptanceCriteria: ["proof:a"],
    observed: {
      artifacts: [],
      proofs: ["proof:b"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
  };

  const selected = selectAtomicDailyUseObservation([first, second]);
  assert.equal(selected, first);
  assert.deepEqual(selected?.observed?.proofs, ["proof:a"]);
});

test("daily-use reporter prefers one complete passed attempt", () => {
  const partial = {
    status: "failed",
    retry: 0,
    acceptanceStatus: "needs_more_work" as const,
    missingAcceptanceCriteria: ["cleanup:verified"],
    observed: {
      artifacts: ["artifact:a"],
      proofs: ["proof:a"],
      approvals: [],
      bindings: [],
      cleanup: [],
    },
  };
  const complete = {
    ...partial,
    status: "passed",
    retry: 1,
    acceptanceStatus: "pass" as const,
    missingAcceptanceCriteria: [],
  };
  assert.equal(
    selectAtomicDailyUseObservation([partial, complete]),
    complete,
  );
});
