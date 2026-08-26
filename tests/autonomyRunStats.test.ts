import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutonomyRunStats,
  finalizeAutonomyRunStats,
  recordApproval,
  recordContinue,
  recordHandoffAccepted,
  recordLeadStep,
  recordProseSteeringInjection,
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

test("prose steering injections start at zero and count per record", () => {
  const stats = createAutonomyRunStats();
  assert.equal(stats.prose_steering_injections, 0);
  recordProseSteeringInjection(stats);
  recordProseSteeringInjection(stats);
  const final = finalizeAutonomyRunStats(stats);
  // Census contract field name (prose_steering_injections) — do not rename.
  assert.equal(final.prose_steering_injections, 2);
});

test("prose steering recorder tolerates stats restored without the field", () => {
  const restored = {
    ...createAutonomyRunStats(),
    prose_steering_injections: undefined,
  };
  recordProseSteeringInjection(restored);
  assert.equal(restored.prose_steering_injections, 1);
});
