import assert from "node:assert/strict";
import test from "node:test";

import { getProjectMemoryLocation } from "../src/agent/projectMemory";
import {
  createToolOutcomeMemory,
  mergeToolOutcomeMemoryV1,
  outcomePenaltyForAction,
  recordToolOutcome,
} from "../src/agent/outcomeMemory";

/**
 * Read instant for this file's fixtures (2026-08-01..03). Outcome history is
 * recency-weighted, so a penalty depends on when it is read; pinning the
 * instant keeps these assertions about merging rather than about today's date.
 */
const JUST_AFTER = new Date("2026-08-04T00:00:00.000Z");

test("the tool outcome ledger is vault-wide while the rest of memory stays project-scoped", () => {
  const research = getProjectMemoryLocation("Projects/CRDT/Design.md");
  const coding = getProjectMemoryLocation("Desktop notes/Scratch.md");

  // Conversation and research memory are legitimately per-project: they belong
  // to the work being done in that folder.
  assert.notEqual(research.conversationPath, coding.conversationPath);
  assert.notEqual(research.researchIndexPath, coding.researchIndexPath);
  assert.equal(research.memoryFolder, "Projects/CRDT/Agent Memory");
  assert.equal(coding.memoryFolder, "Desktop notes/Agent Memory");

  // "which tools keep failing, and how" is not. It is a property of the vault,
  // the machine, and the configured providers, so both missions read and write
  // the same ledger.
  assert.equal(research.vaultToolOutcomePath, coding.vaultToolOutcomePath);
  assert.equal(
    research.vaultToolOutcomePath,
    "Agent Memory/tool-outcome-memory.json",
  );
  assert.equal(research.vaultMemoryFolder, "Agent Memory");

  // The folder-scoped path is still resolved, because existing vaults carry
  // one per project folder and that history has to be readable to be merged.
  assert.notEqual(research.toolOutcomePath, research.vaultToolOutcomePath);
  assert.notEqual(coding.toolOutcomePath, coding.vaultToolOutcomePath);
});

test("a note at the vault root resolves both tiers to the same file", () => {
  const root = getProjectMemoryLocation("Inbox.md");
  assert.equal(root.toolOutcomePath, root.vaultToolOutcomePath);
});

test("merging folder ledgers into the vault ledger keeps every observation", () => {
  const fromResearch = recordToolOutcome(
    recordToolOutcome(createToolOutcomeMemory(), {
      toolName: "web_fetch",
      ok: false,
      errorCode: "timeout",
      targetKind: "web_resource",
      observedAt: "2026-08-01T10:00:00.000Z",
    }),
    {
      toolName: "web_fetch",
      ok: false,
      errorCode: "timeout",
      targetKind: "web_resource",
      observedAt: "2026-08-02T10:00:00.000Z",
    },
  );
  const fromCoding = recordToolOutcome(createToolOutcomeMemory(), {
    toolName: "web_fetch",
    ok: false,
    errorCode: "timeout",
    targetKind: "web_resource",
    observedAt: "2026-08-03T10:00:00.000Z",
  });

  const merged = mergeToolOutcomeMemoryV1(fromResearch, fromCoding);
  assert.equal(merged.records.length, 1);
  const record = merged.records[0]!;
  assert.equal(record.failures, 3, "counters sum rather than overwrite");
  assert.equal(record.successes, 0);
  // Timestamps bracket the whole window, not insertion order.
  assert.equal(record.firstSeen, "2026-08-01T10:00:00.000Z");
  assert.equal(record.lastSeen, "2026-08-03T10:00:00.000Z");
  assert.equal(record.fingerprint, fromCoding.records[0]!.fingerprint);

  // The point of promoting the ledger: a mission in one folder is now warned
  // by what a mission in another folder learned.
  assert.ok(
    outcomePenaltyForAction(merged, "web_fetch", "web_resource", JUST_AFTER) >
      outcomePenaltyForAction(
        fromCoding,
        "web_fetch",
        "web_resource",
        JUST_AFTER,
      ),
  );
});

test("merging is order-independent and keeps distinct identities apart", () => {
  const left = recordToolOutcome(createToolOutcomeMemory(), {
    toolName: "web_fetch",
    ok: true,
    targetKind: "web_resource",
    observedAt: "2026-08-01T10:00:00.000Z",
  });
  const right = recordToolOutcome(createToolOutcomeMemory(), {
    toolName: "web_fetch",
    ok: false,
    errorCode: "timeout",
    targetKind: "web_resource",
    observedAt: "2026-08-02T10:00:00.000Z",
  });
  const forward = mergeToolOutcomeMemoryV1(left, right);
  const backward = mergeToolOutcomeMemoryV1(right, left);
  assert.equal(forward.records.length, 2, "success and failure stay distinct");
  assert.deepEqual(
    forward.records.map((record) => record.id).sort(),
    backward.records.map((record) => record.id).sort(),
  );
  assert.deepEqual(
    forward.records
      .map((record) => `${record.id}:${record.successes}/${record.failures}`)
      .sort(),
    backward.records
      .map((record) => `${record.id}:${record.successes}/${record.failures}`)
      .sort(),
  );
});
