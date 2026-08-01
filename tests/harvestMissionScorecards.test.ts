import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeBaselineRecords,
  selectHarvestableRecords,
} from "../scripts/harvest-mission-scorecards.mjs";

const DIMENSIONS = [
  { id: "acceptance_coverage", score: 1, weight: 0.3 },
  { id: "evidence_grounding", score: 1, weight: 0.25 },
  { id: "receipt_coverage", score: 1, weight: 0.15 },
  { id: "recovery_cleanliness", score: 1, weight: 0.1 },
  { id: "source_independence", score: 1, weight: 0.05 },
  { id: "research_depth", score: 1, weight: 0.05 },
  { id: "model_call_efficiency", score: 1, weight: 0.05 },
  { id: "wall_clock_efficiency", score: 1, weight: 0.05 },
];

function scorecard(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    acceptancePassed: true,
    total: 1,
    dimensions: DIMENSIONS,
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    project: "daily-use-research",
    scenarioId: "DU-02",
    file: "e2e/daily-use-research.spec.ts",
    title: "DU-02 proves grounded research",
    status: "passed",
    missionScorecard: scorecard(),
    ...overrides,
  };
}

function summary(records: unknown[]) {
  return { version: 1, records };
}

test("a passing scored record is harvestable", () => {
  const { harvestable } = selectHarvestableRecords(summary([record()]));
  assert.equal(harvestable.length, 1);
  assert.equal(harvestable[0].project, "daily-use-research");
  assert.match(harvestable[0].key, /daily-use-research\|DU-02\|/u);
});

test("a red or unaccepted run is never harvested", () => {
  // A baseline built from a failed run would silently lower the bar it exists
  // to hold, and would look like a green gate forever after.
  const failed = selectHarvestableRecords(summary([record({ status: "failed" })]));
  assert.equal(failed.harvestable.length, 0);
  assert.match(failed.skipped[0], /run status was failed/u);

  const unaccepted = selectHarvestableRecords(
    summary([record({ missionScorecard: scorecard({ acceptancePassed: false }) })]),
  );
  assert.equal(unaccepted.harvestable.length, 0);
  assert.match(unaccepted.skipped[0], /acceptance did not pass/u);

  const unscored = selectHarvestableRecords(
    summary([record({ missionScorecard: null })]),
  );
  assert.equal(unscored.harvestable.length, 0);
  assert.match(unscored.skipped[0], /no mission scorecard/u);
});

test("guard tests and exempt lanes are ignored without complaint", () => {
  const { harvestable, skipped } = selectHarvestableRecords(
    summary([
      record({ scenarioId: null }),
      record({ project: "provider-canary", scenarioId: "PC-01" }),
    ]),
  );
  assert.equal(harvestable.length, 0);
  // The guard test is silent; the exempt lane is reported.
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /exempt/u);
});

test("harvesting one lane keeps the records of lanes that did not run", () => {
  // This is what makes the loop usable without CI: the scored lanes take hours
  // in total but can be run and harvested independently, across sittings.
  const existing = [
    { key: "other-lane|X-01|e2e/other.spec.ts|Other", project: "other-lane" },
  ];
  const { harvestable } = selectHarvestableRecords(summary([record()]));
  const { records, added, updated } = mergeBaselineRecords(existing, harvestable);

  assert.equal(added.length, 1);
  assert.equal(updated.length, 0);
  assert.equal(records.length, 2, "the untouched lane keeps its record");
  assert.ok(records.some((entry) => entry.project === "other-lane"));
});

test("re-harvesting the same lane replaces rather than duplicates", () => {
  const { harvestable } = selectHarvestableRecords(summary([record()]));
  const first = mergeBaselineRecords([], harvestable);
  const second = mergeBaselineRecords(first.records, harvestable);

  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 1);
  assert.equal(second.records.length, 1);
});

test("merged records are ordered stably so the diff shows only real changes", () => {
  const { harvestable } = selectHarvestableRecords(summary([record()]));
  const existing = [
    { key: "zzz|Z-01|e2e/z.spec.ts|Z", project: "zzz" },
    { key: "aaa|A-01|e2e/a.spec.ts|A", project: "aaa" },
  ];
  const { records } = mergeBaselineRecords(existing, harvestable);
  const keys = records.map((entry) => entry.key);
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
});

test("a non-v1 summary is rejected rather than partially harvested", () => {
  assert.throws(() => selectHarvestableRecords({ version: 2, records: [] }), /v1 daily-use/u);
  assert.throws(() => selectHarvestableRecords(null), /v1 daily-use/u);
});
