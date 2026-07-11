import test from "node:test";
import assert from "node:assert/strict";
import {
  createDurableMissionLease,
  createDurableMissionManifest,
} from "../src/agent/durableMission";
import {
  classifyDurableResumeScanCandidate,
  planDurableResumeScan,
} from "../src/agent/durableResumeSelection";

const NOW = new Date("2026-07-10T12:00:00.000Z");

test("resume scan terminalizes expired newest and selects older recoverable", () => {
  const expired = createDurableMissionManifest({
    missionId: "newest-expired",
    prompt: "expired",
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    durationHours: 8,
  });
  expired.status = "running";
  const older = createDurableMissionManifest({
    missionId: "older-recoverable",
    prompt: "recover me",
    createdAt: new Date("2026-07-10T11:00:00.000Z"),
  });
  older.status = "interrupted";

  const plan = planDurableResumeScan([expired, older], NOW);
  assert.equal(plan.terminalize.length, 1);
  assert.equal(plan.terminalize[0].decision.status, "expired");
  assert.equal(plan.resume?.missionId, older.missionId);
});

test("newer live lease does not starve older safely recoverable root", () => {
  const waiting = createDurableMissionManifest({
    missionId: "newest-live-lease",
    prompt: "leased elsewhere",
    createdAt: NOW,
  });
  waiting.status = "running";
  waiting.lease = createDurableMissionLease({
    ownerId: "other-window",
    now: NOW,
    durationMs: 30_000,
  });
  const older = createDurableMissionManifest({
    missionId: "older-interrupted",
    prompt: "recover me",
    createdAt: new Date(NOW.getTime() - 1_000),
  });
  older.status = "interrupted";

  const plan = planDurableResumeScan([waiting, older], NOW);
  assert.equal(plan.resume?.missionId, older.missionId);
  assert.equal(plan.wait?.reason, "live_lease");
});

test("live lease polling is capped by five seconds and lease expiry", () => {
  const waiting = createDurableMissionManifest({
    missionId: "lease-repoll",
    prompt: "wait safely",
    createdAt: NOW,
  });
  waiting.status = "running";
  waiting.lease = createDurableMissionLease({
    ownerId: "other-window",
    now: NOW,
    durationMs: 3_000,
  });

  const decision = classifyDurableResumeScanCandidate(waiting, NOW);
  assert.equal(decision.type, "wait");
  assert.equal(
    decision.type === "wait" ? decision.retryAt : "",
    "2026-07-10T12:00:03.000Z",
  );
});
