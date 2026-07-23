import assert from "node:assert/strict";
import test from "node:test";
import { createAutonomyRunStats, recordApproval } from "../src/agent/autonomyRunStats";
import {
  formatAutonomyStatsLine,
  formatTeamStatsLine,
} from "../src/ui/autonomyStatsCopy";

test("formatAutonomyStatsLine and formatTeamStatsLine", () => {
  const stats = createAutonomyRunStats();
  recordApproval(stats, "soft");
  assert.match(formatAutonomyStatsLine(stats), /Soft path/i);
  assert.match(formatAutonomyStatsLine(stats), /0 continues/i);
  assert.match(formatTeamStatsLine(stats) ?? "", /Team sources: 0/);
  assert.equal(formatAutonomyStatsLine(null), "—");
});
