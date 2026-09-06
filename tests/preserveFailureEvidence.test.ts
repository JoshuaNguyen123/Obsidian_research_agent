import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  preserveFailureEvidence,
  preserveMissionAttemptRecordV1,
} from "../e2e/fixtures/preserveFailureEvidence";
import { unknownToolCallOutcomeCountsV1, foldToolCallOutcomesV1 } from "../e2e/fixtures/toolCallOutcomes";

test("failure evidence exists before renderer access and retains the failed result", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "failure-evidence-"));
  try {
    const file = path.join(dir, "attempt.json");
    await preserveFailureEvidence({
      file,
      metadata: { scenarioId: "BYOK-01", outcome: "failed", model: "fixture" },
      read: async () => {
        assert.equal(JSON.parse(await readFile(file, "utf8")).readStatus, "started");
        return { acceptance: { status: "needs_more_work" }, rejectedDraft: "Unverified draft", toolCalls: null };
      },
    });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.outcome, "failed");
    assert.equal(saved.readStatus, "captured");
    assert.equal(saved.evidence.toolCalls, null);
    assert.equal(saved.evidence.rejectedDraft, "Unverified draft");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a dead or unresponsive renderer leaves unknown evidence without hanging teardown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "failure-evidence-"));
  try {
    for (const [name, read] of [
      ["throw", async () => { throw new Error("dead renderer"); }],
      ["timeout", () => new Promise<never>(() => {})],
    ] as const) {
      const file = path.join(dir, `${name}.json`);
      await preserveFailureEvidence({ file, metadata: { outcome: "failed" }, read, timeoutMs: 20 });
      const saved = JSON.parse(await readFile(file, "utf8"));
      assert.equal(saved.outcome, "failed");
      assert.equal(saved.readStatus, "unavailable");
      assert.equal(saved.evidence, null);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("evidence that read back as undefined is unavailable, not captured", async () => {
  // `readStatus: "captured"` beside a dropped `evidence` key is a record that
  // claims proof it does not hold. JSON.stringify removes undefined, so the
  // vacuous case is invisible in the artifact unless the status says so.
  const dir = await mkdtemp(path.join(os.tmpdir(), "failure-evidence-"));
  try {
    const file = path.join(dir, "undefined.json");
    await preserveFailureEvidence({
      file,
      metadata: { outcome: "failed" },
      read: async () => undefined,
    });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.readStatus, "unavailable");
    assert.equal(saved.evidence, null, "evidence must be an explicit null, never a missing key");

    // POSITIVE PROOF the status is not simply hardcoded: real evidence, even
    // falsy real evidence, still reads as captured.
    const real = path.join(dir, "real.json");
    await preserveFailureEvidence({
      file: real,
      metadata: { outcome: "failed" },
      read: async () => ({ acceptance: "needs_more_work" }),
    });
    assert.equal(JSON.parse(await readFile(real, "utf8")).readStatus, "captured");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("every attempt leaves a record before teardown, passed or failed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "attempt-record-"));
  try {
    for (const outcome of ["passed", "failed"] as const) {
      const file = path.join(dir, `${outcome}.json`);
      let existedBeforeRead = false;
      await preserveMissionAttemptRecordV1({
        file,
        scenarioId: "BYOK-01",
        outcome,
        model: "glm-5.3-flash:cloud",
        progress: { modelCalls: 7, continuations: 2 },
        toolCallOutcomes: foldToolCallOutcomesV1([
          { kind: "tool_start", id: "1:0:web_search", toolName: "web_search" },
          { kind: "tool_done", id: "1:0:web_search", toolName: "web_search", ok: true, errorCode: null },
        ]),
        read: async () => {
          // The attempt must be on disk BEFORE anything touches a renderer
          // that may already be dead.
          const early = JSON.parse(await readFile(file, "utf8"));
          existedBeforeRead = early.readStatus === "started" && early.outcome === outcome;
          return { finalNote: "ok" };
        },
      });
      const saved = JSON.parse(await readFile(file, "utf8"));
      assert.ok(existedBeforeRead, `the ${outcome} attempt must be persisted before the read`);
      assert.equal(saved.version, 1);
      assert.equal(saved.scenarioId, "BYOK-01");
      assert.equal(saved.outcome, outcome);
      assert.equal(saved.model, "glm-5.3-flash:cloud");
      assert.equal(saved.readStatus, "captured");
      assert.equal(saved.progress.modelCalls, 7);
      assert.equal(saved.toolCallOutcomes.coverage, "complete");
      assert.equal(saved.toolCallOutcomes.attempted, 1);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an attempt whose evidence retrieval fails keeps its progress and stays unknown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "attempt-record-"));
  try {
    const file = path.join(dir, "dead-renderer.json");
    await preserveMissionAttemptRecordV1({
      file,
      scenarioId: "BYOK-01",
      outcome: "failed",
      model: "glm-5.3-flash:cloud",
      progress: { modelCalls: 4, continuations: 1 },
      toolCallOutcomes: null,
      read: () => { throw new Error("dead renderer"); },
    });
    const saved = JSON.parse(await readFile(file, "utf8"));
    // Failure progress survives the failed retrieval — that is the whole point.
    assert.equal(saved.outcome, "failed");
    assert.equal(saved.progress.modelCalls, 4);
    assert.equal(saved.readStatus, "unavailable");
    assert.equal(saved.evidence, null);
    // An absent fold is UNKNOWN, never an empty success. An attempt record
    // holding no tool evidence must not read as a complete observation of zero
    // calls.
    assert.equal(saved.toolCallOutcomes.coverage, "unobserved");
    assert.equal(saved.toolCallOutcomes.attempted, null);
    assert.equal(saved.toolCallOutcomes.failed, null);
    assert.notEqual(saved.toolCallOutcomes.coverage, "complete");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an attempt record never claims complete coverage it was not given", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "attempt-record-"));
  try {
    for (const [name, counts, expected] of [
      ["lossy", unknownToolCallOutcomeCountsV1("lossy"), "lossy"],
      ["unobserved", unknownToolCallOutcomeCountsV1("unobserved"), "unobserved"],
      ["absent", null, "unobserved"],
    ] as const) {
      const file = path.join(dir, `${name}.json`);
      await preserveMissionAttemptRecordV1({
        file,
        scenarioId: "BYOK-01",
        outcome: "passed",
        model: "fixture",
        toolCallOutcomes: counts,
      });
      const saved = JSON.parse(await readFile(file, "utf8"));
      assert.equal(saved.toolCallOutcomes.coverage, expected);
      assert.equal(saved.toolCallOutcomes.attempted, null);
      assert.equal(
        saved.evidenceComplete,
        false,
        "a passed attempt with unknown tool evidence is NOT complete evidence",
      );
    }
    // POSITIVE PROOF: a genuinely complete fold does set the flag, so the flag
    // is not merely hardcoded false.
    const file = path.join(dir, "complete.json");
    await preserveMissionAttemptRecordV1({
      file,
      scenarioId: "BYOK-01",
      outcome: "passed",
      model: "fixture",
      toolCallOutcomes: foldToolCallOutcomesV1([
        { kind: "tool_start", id: "1:0:read_file", toolName: "read_file" },
        { kind: "tool_done", id: "1:0:read_file", toolName: "read_file", ok: true, errorCode: null },
      ]),
    });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.evidenceComplete, true);
    assert.equal(saved.toolCallOutcomes.attempted, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
