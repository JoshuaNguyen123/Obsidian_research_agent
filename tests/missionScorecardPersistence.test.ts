import assert from "node:assert/strict";
import test from "node:test";
import {
  createMissionRuntimeSnapshot,
  formatMissionRuntimeSnapshotBlock,
  parseMissionRuntimeSnapshotFromMarkdown,
} from "../src/agent/runStore";
import {
  normalizeMissionScorecard,
  scoreMissionV1,
} from "../src/agent/missionScorecard";

const CARD = scoreMissionV1({
  acceptanceCriteriaTotal: 4,
  acceptanceCriteriaMissing: 1,
  acceptancePassed: false,
  claimsRequiringEvidence: 3,
  claimsWithEvidence: 2,
  mutationsPerformed: 1,
  mutationsWithReceipts: 1,
  recoveryAttempts: 1,
  modelCalls: 12,
  modelCallBudget: 50,
  wallClockMs: 90_000,
  wallClockBudgetMs: 840_000,
});

test("a scorecard round-trips through the persisted snapshot markdown", () => {
  // The card is not recomputable from a snapshot (provider usage and wall
  // clock are not persisted), so history only exists if the card itself
  // survives the markdown round-trip byte-meaningfully.
  const snapshot = createMissionRuntimeSnapshot({
    runId: "run:score",
    originalMission: "Deep research something.",
    missionScorecard: CARD,
    createdAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  assert.ok(snapshot.missionScorecard);

  const parsed = parseMissionRuntimeSnapshotFromMarkdown(
    formatMissionRuntimeSnapshotBlock(snapshot),
  );
  assert.ok(parsed?.missionScorecard);
  assert.deepEqual(parsed.missionScorecard, snapshot.missionScorecard);
  assert.equal(parsed.missionScorecard.acceptancePassed, false);
  assert.equal(parsed.missionScorecard.dimensions.length, CARD.dimensions.length);
});

test("a snapshot without a scorecard parses exactly as before", () => {
  const snapshot = createMissionRuntimeSnapshot({
    runId: "run:legacy",
    originalMission: "Older run.",
    createdAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  assert.equal(snapshot.missionScorecard, undefined);
  const parsed = parseMissionRuntimeSnapshotFromMarkdown(
    formatMissionRuntimeSnapshotBlock(snapshot),
  );
  assert.ok(parsed);
  assert.equal(parsed.missionScorecard, undefined);
});

test("a malformed persisted scorecard degrades to absent, never to invented numbers", () => {
  // Snapshots live in markdown anyone may edit; fail closed.
  for (const bad of [
    null,
    "not a card",
    { version: 2, acceptancePassed: true, dimensions: [], total: 1 },
    { version: 1, acceptancePassed: true, dimensions: [], total: 1 },
    {
      version: 1,
      acceptancePassed: true,
      total: 1,
      dimensions: [{ id: "made_up_dimension", score: 1, weight: 1, detail: "" }],
    },
    {
      version: 1,
      acceptancePassed: true,
      total: 2,
      dimensions: CARD.dimensions,
    },
    {
      version: 1,
      acceptancePassed: true,
      total: 1,
      // Duplicate dimension id.
      dimensions: [CARD.dimensions[0], CARD.dimensions[0]],
    },
  ]) {
    assert.equal(normalizeMissionScorecard(bad), null, JSON.stringify(bad));
  }

  const snapshot = createMissionRuntimeSnapshot({
    runId: "run:bad",
    originalMission: "Tampered.",
    missionScorecard: { version: 1 } as never,
    createdAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  assert.equal(snapshot.missionScorecard, undefined);
});

test("a valid card normalizes to itself", () => {
  assert.deepEqual(normalizeMissionScorecard(CARD), CARD);
});
