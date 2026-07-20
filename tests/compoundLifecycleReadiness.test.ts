import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityReadinessV2 } from "../src/agent/capabilityReadiness";
import {
  evaluateCompoundLifecycleReadinessV1,
  formatCompoundLifecycleStageStrip,
  isCodeStartableForCompound,
  isLinearStartableForCompound,
} from "../src/agent/compoundLifecycleReadiness";

function row(
  id: CapabilityReadinessV2["id"],
  status: CapabilityReadinessV2["status"],
  setupTarget: CapabilityReadinessV2["setupTarget"] = id === "notes"
    ? "notes_research"
    : (id as CapabilityReadinessV2["setupTarget"]),
): CapabilityReadinessV2 {
  return {
    version: 2,
    id,
    name: id,
    status,
    reason: `${id} is ${status}`,
    evidenceAt: null,
    nextAction: `Fix ${id}`,
    setupTarget,
  };
}

function readyBundle(): CapabilityReadinessV2[] {
  return [
    row("model", "Ready", "model"),
    row("notes", "Ready"),
    row("code", "Ready", "code"),
    row("linear", "Ready", "linear"),
    row("github", "Ready", "github"),
    row("browser", "Available", "browser_web"),
    row("background", "Ready", "background"),
  ];
}

test("non-compound prompts skip readiness blockers", () => {
  const result = evaluateCompoundLifecycleReadinessV1({
    prompt: "Summarize this note",
    readiness: [row("linear", "Setup needed", "linear")],
  });
  assert.equal(result.compound, false);
  assert.equal(result.ok, true);
  assert.equal(result.blockers.length, 0);
});

test("end-to-end checkers prompt is compound and ready when capabilities are ready", () => {
  const result = evaluateCompoundLifecycleReadinessV1({
    prompt:
      "I want to create the game of checkers in Python end to end following the full workflow",
    readiness: readyBundle(),
  });
  assert.equal(result.compound, true);
  assert.equal(result.ok, true);
  assert.ok(result.stages.includes("accepted_research"));
  assert.ok(result.stages.includes("linear_hierarchy"));
  assert.ok(result.stages.includes("code_execution"));
  assert.ok(result.stages.includes("private_github_publication"));
});

test("compound readiness blocks missing Linear and Code", () => {
  const readiness = readyBundle().map((item) => {
    if (item.id === "linear") return row("linear", "Setup needed", "linear");
    if (item.id === "code") return row("code", "Available", "code");
    return item;
  });
  const result = evaluateCompoundLifecycleReadinessV1({
    prompt: "Build the project end to end with Linear and GitHub",
    readiness,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.capabilityId === "linear"));
  assert.ok(result.blockers.some((b) => b.capabilityId === "code"));
  assert.equal(isCodeStartableForCompound("Available"), false);
  assert.equal(isLinearStartableForCompound("Setup needed"), false);
});

test("stage strip marks the active stage", () => {
  assert.equal(
    formatCompoundLifecycleStageStrip(
      ["accepted_research", "linear_hierarchy", "code_execution"],
      "linear_hierarchy",
    ),
    "Research → [Linear] → Code",
  );
});
