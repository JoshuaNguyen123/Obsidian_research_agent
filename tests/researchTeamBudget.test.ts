import assert from "node:assert/strict";
import test from "node:test";

import { resolveResearchTeamBudget } from "../src/orchestrator/researchTeamBudget";

test("research team shares the configured mission step and tool caps", () => {
  const budget = resolveResearchTeamBudget({
    configuredMaxAgentSteps: 28,
    requestedWorkerMaxSteps: 8,
    requestedWorkerMaxToolCalls: 10,
  });

  assert.deepEqual(budget, {
    rootModelSteps: 28,
    rootToolCalls: 56,
    researcherModelSteps: 8,
    researcherToolCalls: 10,
    leadModelSteps: 20,
    leadToolCalls: 46,
  });
  assert.equal(
    budget.researcherModelSteps + budget.leadModelSteps,
    budget.rootModelSteps,
  );
  assert.equal(
    budget.researcherToolCalls + budget.leadToolCalls,
    budget.rootToolCalls,
  );
});

test("worker maxima cannot consume the Lead finalization reserve", () => {
  const budget = resolveResearchTeamBudget({
    configuredMaxAgentSteps: 28,
    requestedWorkerMaxSteps: 100,
    requestedWorkerMaxToolCalls: 200,
  });

  assert.equal(budget.researcherModelSteps, 24);
  assert.equal(budget.leadModelSteps, 4);
  assert.equal(budget.researcherToolCalls, 40);
  assert.equal(budget.leadToolCalls, 16);
});

test("default 100-step team allocation preserves the established 40/60 split", () => {
  assert.deepEqual(resolveResearchTeamBudget({}), {
    rootModelSteps: 100,
    rootToolCalls: 200,
    researcherModelSteps: 40,
    researcherToolCalls: 40,
    leadModelSteps: 60,
    leadToolCalls: 160,
  });
});
