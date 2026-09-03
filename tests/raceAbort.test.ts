import assert from "node:assert/strict";
import test from "node:test";

import { isAbortError, raceAbort } from "../src/utils/raceAbort";

const never = () => new Promise<never>(() => undefined);

test("raceAbort passes a settled promise through untouched", async () => {
  const controller = new AbortController();
  assert.equal(await raceAbort(Promise.resolve(7), controller.signal), 7);
  await assert.rejects(
    raceAbort(Promise.reject(new Error("boom")), controller.signal),
    /boom/u,
  );
  assert.equal(await raceAbort(Promise.resolve("no signal"), undefined), "no signal");
});

test("raceAbort settles the moment the signal aborts, not when the work does", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = raceAbort(never(), controller.signal);
  setTimeout(() => controller.abort(new Error("Mission was stopped.")), 20);
  await assert.rejects(pending, (error: unknown) => isAbortError(error));
  assert.ok(Date.now() - startedAt < 2_000, "the race waited for the work");
});

test("raceAbort rejects at once for a run that is already stopped", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(raceAbort(never(), controller.signal), (error: unknown) =>
    isAbortError(error),
  );
});
