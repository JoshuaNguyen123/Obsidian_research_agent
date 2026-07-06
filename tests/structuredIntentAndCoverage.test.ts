import test from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalCoverage } from "../src/agent/retrievalCoverage";
import {
  classifyStructuredIntent,
  formatStructuredIntentForPrompt,
} from "../src/agent/intent/structuredIntent";
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

test("structured intent captures evidence needs and write targets", () => {
  const intent = classifyStructuredIntent(
    "Search my vault and web sources, then write the answer to the current note.",
    { ...baseIntent, requireWriteCompletion: true, vaultContext: true },
  );

  assert.equal(intent.primary, "write");
  assert.equal(intent.writeTarget, "current_note");
  assert.ok(intent.evidenceNeeds.includes("vault"));
  assert.ok(intent.evidenceNeeds.includes("web"));
  assert.equal(intent.mutationKind, "append");

  const promptBlock = formatStructuredIntentForPrompt(intent);
  assert.match(promptBlock, /Structured intent facets/);
  assert.match(promptBlock, /vault,web/);
});

test("structured intent marks destructive delete requests as explicit mutations", () => {
  const intent = classifyStructuredIntent("Delete the old research memory entry.", {
    ...baseIntent,
    explicitDelete: true,
  });

  assert.equal(intent.primary, "memory");
  assert.equal(intent.destructive, true);
  assert.equal(intent.mutationKind, "trash");
  assert.ok(intent.evidenceNeeds.includes("memory"));
});

test("retrieval coverage distinguishes exact reads from truncated fallbacks", () => {
  assert.deepEqual(
    buildRetrievalCoverage({
      mode: "exact",
      considered: 2,
      read: 2,
      skipped: 0,
      truncated: false,
      reasons: ["all_files_read"],
    }),
    {
      mode: "exact",
      considered: 2,
      read: 2,
      skipped: 0,
      truncated: false,
      fallbackUsed: false,
      confidence: "high",
      reasons: ["all_files_read"],
    },
  );

  const fallback = buildRetrievalCoverage({
    mode: "fallback",
    considered: 10,
    read: 2,
    skipped: 8,
    truncated: true,
    fallbackUsed: true,
    reasons: ["semantic_index_unavailable"],
  });

  assert.equal(fallback.confidence, "low");
  assert.equal(fallback.fallbackUsed, true);
});
