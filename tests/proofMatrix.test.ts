import assert from "node:assert/strict";
import test from "node:test";

import {
  laneHasScorecardBaselineFrom,
  porcelainWithoutAllowedHarvest,
} from "../scripts/run-proof-matrix.mjs";

test("scorecard baseline detection reads records[].project, not array indices", () => {
  const baseline = {
    version: 1,
    records: [
      { project: "daily-use-research", key: "daily-use-research|DU-02|spec|title" },
      { project: "compound-flow-real-live" },
    ],
  };
  assert.equal(laneHasScorecardBaselineFrom(baseline, "daily-use-research"), true);
  assert.equal(
    laneHasScorecardBaselineFrom(baseline, "compound-flow-real-live"),
    true,
  );
  assert.equal(laneHasScorecardBaselineFrom(baseline, "real-ai-soak"), false);
  assert.equal(laneHasScorecardBaselineFrom({ records: [] }, "daily-use-research"), false);
});

test("exact-HEAD cleanliness allows only the harvested scorecard baseline", () => {
  assert.equal(
    porcelainWithoutAllowedHarvest(
      " M e2e/baselines/mission-scorecards.v1.json\n",
    ),
    "",
  );
  assert.match(
    porcelainWithoutAllowedHarvest(
      " M e2e/baselines/mission-scorecards.v1.json\n M src/AgentRunner.ts\n",
    ),
    /src\/AgentRunner\.ts/u,
  );
});
