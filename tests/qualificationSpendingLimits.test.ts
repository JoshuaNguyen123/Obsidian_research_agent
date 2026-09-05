import assert from "node:assert/strict";
import test from "node:test";
import { constrainQualificationSpendingLimits } from "../e2e/fixtures/qualificationSpendingLimits";

test("qualification preserves installed spending and continuation caps", () => {
  assert.deepEqual(constrainQualificationSpendingLimits(
    { maxAgentSteps: 100, overnightMaxSegments: 2, maxCompletionSegments: 24 },
    { maxAgentSteps: 160, overnightMaxSegments: 12, maxCompletionSegments: 4, model: "glm-5.3-flash:cloud" },
  ), { maxAgentSteps: 100, overnightMaxSegments: 2, maxCompletionSegments: 4, model: "glm-5.3-flash:cloud" });
  assert.equal(constrainQualificationSpendingLimits({ maxAgentSteps: 100 }, { maxAgentSteps: NaN }).maxAgentSteps, 100);
  assert.equal(constrainQualificationSpendingLimits({ maxAgentSteps: 100 }, {}).maxAgentSteps, 100);
});
