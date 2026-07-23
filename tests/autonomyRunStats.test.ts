import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutonomyRunStats,
  finalizeAutonomyRunStats,
  recordApproval,
  recordContinue,
  recordHandoffAccepted,
  recordLeadStep,
  recordResearcherStep,
  recordToolsOffered,
  recordUsableSources,
} from "../src/agent/autonomyRunStats";

test("autonomy run stats aggregate tools approvals continues and team", () => {
  const stats = createAutonomyRunStats();
  recordToolsOffered(stats, 10);
  recordToolsOffered(stats, 20);
  recordApproval(stats, "soft");
  recordApproval(stats, "bound");
  recordContinue(stats);
  recordResearcherStep(stats);
  recordLeadStep(stats);
  recordHandoffAccepted(stats, true);
  recordUsableSources(stats, 2);
  const final = finalizeAutonomyRunStats(stats, { elapsedMs: 1500 });
  assert.equal(final.toolsOffered.max, 20);
  assert.equal(final.toolsOffered.avg, 15);
  assert.equal(final.continueCount, 1);
  assert.equal(final.approvalCountByEffectClass.bound, 1);
  assert.equal(final.softOnly, false);
  assert.equal(final.elapsedMs, 1500);
  assert.equal(final.team?.usableSourceCount, 2);
  assert.equal(final.team?.handoffAccepted, true);
});
