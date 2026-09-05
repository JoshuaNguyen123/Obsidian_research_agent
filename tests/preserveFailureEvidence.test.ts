import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preserveFailureEvidence } from "../e2e/fixtures/preserveFailureEvidence";

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
