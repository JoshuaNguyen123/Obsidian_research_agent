import assert from "node:assert/strict";
import test from "node:test";

import { validateNativeDogfoodEvidence } from "../scripts/native-dogfood-evidence.mjs";

function fixture() {
  return {
    version: 1,
    stage: "read_only_chat",
    status: "blocked",
    observedAt: "2026-08-27T20:00:00.000Z",
    exactHead: "34852cb208780970286d84a3deeadb76f3f2843a",
    bundleProof: "installed main.js contains canonicalization trace marker",
    windowTitle: "New tab - test_vault_obsidian_ai - Obsidian 1.13.7",
    prompt: "Read-only vault recall mission was not submitted because Run Mission was disabled.",
    visibleOutcome: "Connect a model to start; Run Mission disabled.",
    runId: null,
    runDetailsStatus: null,
    scorecard: null,
    receipts: [],
    artifacts: [],
    cleanupResults: ["No disposable resource was created."],
    approvalBoundary: { status: "not_reached" },
  };
}

test("blocked visible-UI evidence can retain a pre-run environment gate", () => {
  assert.equal(validateNativeDogfoodEvidence(fixture()).status, "blocked");
});

test("passed dogfood evidence requires a durable run id", () => {
  assert.throws(
    () => validateNativeDogfoodEvidence({ ...fixture(), status: "passed" }),
    /requires a run id/u,
  );
});

test("dogfood evidence rejects credential-shaped fields and values", () => {
  assert.throws(
    () => validateNativeDogfoodEvidence({ ...fixture(), apiKey: "hidden" }),
    /Secret-bearing field/u,
  );
  assert.throws(
    () => validateNativeDogfoodEvidence({
      ...fixture(),
      visibleOutcome: "Bearer abcdefghijklmnopqrstuvwxyz",
    }),
    /Secret-like value/u,
  );
});
