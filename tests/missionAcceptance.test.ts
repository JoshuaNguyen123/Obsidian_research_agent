import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMissionAcceptance,
  formatMissionAcceptanceCorrection,
  type MissionAcceptanceReceiptLike,
} from "../src/agent/missionAcceptance";
import type { MissionIntent } from "../src/tools/types";

const baseIntent: MissionIntent = {
  mode: "chat_only",
  vaultContext: false,
  noteOutput: false,
  explicitPersistence: false,
  explicitMutation: false,
  explicitDelete: false,
  allowAutonomousWrite: false,
  requireWriteCompletion: false,
  autonomyScope: {
    read: { currentNote: false, vault: false, folders: [], files: [], web: false },
    write: { currentNote: false, folders: [], files: [], artifacts: false, researchMemory: false },
    destructive: { replaceCurrentNote: false, deleteCurrentNote: false, deletePaths: false },
  },
};

test("mission acceptance fails when a required write has no receipt", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Write a summary to the current note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["append_to_current_file"],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: { current_note_content: "pending" },
    finalOutput: "Done.",
  });

  assert.equal(result.status, "fail");
  assert.equal(result.nextAction, "Complete the required write or mutation with a receipt.");
  assert.ok(result.missing.includes("tool:append_to_current_file"));
  assert.ok(result.missing.includes("write_receipt"));
});

test("mission acceptance asks for more work when source evidence is missing", () => {
  const result = evaluateMissionAcceptance({
    prompt: "Verify this with web sources and citations.",
    missionIntent: baseIntent,
    requiredTools: [],
    successfulTools: [],
    failedTools: [],
    evidence: [],
    receipts: [],
    operationGoals: {},
    finalOutput: "A citation-free answer.",
  });

  assert.equal(result.status, "needs_more_work");
  assert.equal(result.nextAction, "Gather web source evidence.");
  assert.ok(result.missing.includes("web_evidence"));
});

test("mission acceptance passes when evidence and receipts satisfy the mission", () => {
  const receipt: MissionAcceptanceReceiptLike = {
    toolName: "append_to_current_file",
    path: "Current.md",
    operation: "append",
    bytesWritten: 42,
  };
  const result = evaluateMissionAcceptance({
    prompt: "Search my vault, cite sources, and write the answer to the note.",
    missionIntent: { ...baseIntent, requireWriteCompletion: true },
    requiredTools: ["inspect_vault_context", "web_fetch", "append_to_current_file"],
    successfulTools: ["inspect_vault_context", "web_fetch", "append_to_current_file"],
    failedTools: [],
    evidence: [
      {
        id: "vault:1",
        kind: "vault_note",
        title: "Vault search",
        summary: "Read two notes.",
        confidence: "high",
      },
      {
        id: "web:1",
        kind: "web_source",
        title: "Fetched source",
        summary: "Fetched source page.",
        confidence: "high",
      },
    ],
    receipts: [receipt],
    operationGoals: { current_note_content: "completed" },
    finalOutput: "Wrote the sourced answer.",
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.missing, []);
  assert.equal(result.confidence, 0.92);
});

test("mission acceptance correction names missing tools that are still available", () => {
  const correction = formatMissionAcceptanceCorrection(
    {
      status: "needs_more_work",
      confidence: 0.55,
      missing: ["web_evidence", "web_fetch"],
      reasons: ["missing_web_evidence"],
      nextAction: "web_evidence",
    },
    ["web_search", "web_fetch"],
  );

  assert.match(correction, /Mission acceptance is incomplete/);
  assert.match(correction, /web_fetch/);
});
