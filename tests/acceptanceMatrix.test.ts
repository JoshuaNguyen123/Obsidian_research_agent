import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPTANCE_MATRIX_CASES,
  runAcceptanceMatrix,
} from "./fixtures/acceptanceMatrix";

test("acceptance golden matrix passes all known cases", () => {
  const results = runAcceptanceMatrix(ACCEPTANCE_MATRIX_CASES);
  const failures = results.filter((result) => !result.ok);
  assert.deepEqual(
    failures,
    [],
    failures.map((failure) => `${failure.name}: ${failure.detail}`).join("; "),
  );
});
