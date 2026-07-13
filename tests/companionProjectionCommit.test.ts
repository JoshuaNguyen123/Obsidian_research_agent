import assert from "node:assert/strict";
import test from "node:test";
import { persistCompanionProjectionBeforeCursorV1 } from "../src/agent/companionProjectionCommit";

test("companion projection becomes durable before its applied cursor advances", async () => {
  const order: string[] = [];
  const result = await persistCompanionProjectionBeforeCursorV1({
    appliedThroughSequence: 7,
    persistProjection: async () => {
      order.push("projection:start", "projection:durable");
      return { changed: true };
    },
    acknowledgeCursor: async (sequence) => {
      order.push(`cursor:start:${sequence}`, "cursor:durable");
    },
  });

  assert.deepEqual(order, [
    "projection:start",
    "projection:durable",
    "cursor:start:7",
    "cursor:durable",
  ]);
  assert.deepEqual(result, {
    projectionChanged: true,
    cursorAcknowledged: true,
    cursorError: null,
  });
});

test("a projection write failure never advances the companion cursor", async () => {
  let acknowledgementCalls = 0;
  await assert.rejects(
    persistCompanionProjectionBeforeCursorV1({
      appliedThroughSequence: 7,
      persistProjection: async () => {
        throw new Error("simulated runtime snapshot failure");
      },
      acknowledgeCursor: async () => {
        acknowledgementCalls += 1;
      },
    }),
    /simulated runtime snapshot failure/u,
  );
  assert.equal(acknowledgementCalls, 0);
});

test("a cursor failure preserves the already-durable projection for retry", async () => {
  let projectionDurable = false;
  const result = await persistCompanionProjectionBeforeCursorV1({
    appliedThroughSequence: 7,
    persistProjection: async () => {
      projectionDurable = true;
      return { changed: true };
    },
    acknowledgeCursor: async () => {
      assert.equal(projectionDurable, true);
      throw new Error("simulated cursor persistence failure");
    },
  });

  assert.equal(result.projectionChanged, true);
  assert.equal(result.cursorAcknowledged, false);
  assert.match(String(result.cursorError), /simulated cursor persistence failure/u);
});
