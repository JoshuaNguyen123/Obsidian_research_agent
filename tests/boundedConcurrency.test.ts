import assert from "node:assert/strict";
import test from "node:test";
import { mapWithBoundedConcurrency } from "../src/utils/boundedConcurrency";

test("mapWithBoundedConcurrency preserves order while bounding active work", async () => {
  let active = 0;
  let maxActive = 0;
  const values = Array.from({ length: 17 }, (_, index) => index);

  const results = await mapWithBoundedConcurrency(values, 4, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, value % 3));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, values.map((value) => value * 2));
  assert.equal(maxActive, 4);
});

test("mapWithBoundedConcurrency rejects invalid concurrency", async () => {
  await assert.rejects(
    () => mapWithBoundedConcurrency([1], 0, async (value) => value),
    /positive safe integer/,
  );
});
