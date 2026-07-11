import assert from "node:assert/strict";
import test from "node:test";

import {
  QUEUE_DAILY_START_LIMIT,
  createQueueDailyStartBudgetState,
  normalizeQueueDailyStartBudgetState,
  reserveQueueDailyStart,
} from "../src/agent/queue";

const DAY_ONE = "2026-07-11";

test("daily queue budget durably caps 25 distinct ticket contracts", () => {
  let state = createQueueDailyStartBudgetState({
    at: `${DAY_ONE}T00:00:00.000Z`,
  });
  for (let index = 0; index < QUEUE_DAILY_START_LIMIT; index += 1) {
    const result = reserveQueueDailyStart(state, {
      issueId: `issue-${index}`,
      contractFingerprint: fingerprint(index),
      at: `${DAY_ONE}T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.alreadyReserved, false);
    state = result.state;
  }

  assert.equal(state.revision, QUEUE_DAILY_START_LIMIT);
  assert.equal(Object.keys(state.reservations).length, QUEUE_DAILY_START_LIMIT);
  const exhausted = reserveQueueDailyStart(state, {
    issueId: "issue-26",
    contractFingerprint: fingerprint(26),
    at: `${DAY_ONE}T00:00:26.000Z`,
  });
  assert.deepEqual(exhausted, {
    accepted: false,
    reason: "daily_limit_exhausted",
    state,
  });

  const duplicate = reserveQueueDailyStart(state, {
    issueId: "issue-0",
    contractFingerprint: fingerprint(0),
    at: `${DAY_ONE}T00:00:27.000Z`,
  });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.alreadyReserved, true);
  assert.equal(duplicate.state, state);
  assert.deepEqual(
    normalizeQueueDailyStartBudgetState(JSON.parse(JSON.stringify(state))),
    state,
  );
});

test("daily queue budget resets atomically at UTC rollover", () => {
  let state = createQueueDailyStartBudgetState({
    at: `${DAY_ONE}T23:59:00.000Z`,
    limit: 1,
  });
  state = reserveQueueDailyStart(state, {
    issueId: "issue-before-midnight",
    contractFingerprint: fingerprint(1),
    at: `${DAY_ONE}T23:59:59.000Z`,
  }).state;
  const blocked = reserveQueueDailyStart(state, {
    issueId: "issue-still-day-one",
    contractFingerprint: fingerprint(2),
    at: `${DAY_ONE}T23:59:59.999Z`,
  });
  assert.equal(blocked.accepted, false);

  const rolled = reserveQueueDailyStart(state, {
    issueId: "issue-after-midnight",
    contractFingerprint: fingerprint(3),
    at: "2026-07-12T00:00:00.000Z",
  });
  assert.equal(rolled.accepted, true);
  assert.equal(rolled.state.utcDay, "2026-07-12");
  assert.equal(rolled.state.revision, state.revision + 1);
  assert.deepEqual(
    Object.values(rolled.state.reservations).map((reservation) => reservation.issueId),
    ["issue-after-midnight"],
  );
});

function fingerprint(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
