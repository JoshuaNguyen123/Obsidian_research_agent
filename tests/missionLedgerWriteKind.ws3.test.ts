import assert from "node:assert/strict";
import test from "node:test";
import {
  createMissionLedger,
  formatMissionLedgerBlock,
  parseMissionLedgerFromMarkdown,
  resolveCurrentNoteWriteKindV1,
  resolveLedgerCurrentNoteWriteKind,
} from "../src/agent/missionLedger";

test("old ledger records without currentNoteWriteKind still parse", () => {
  const markdown = [
    "## Mission Ledger",
    "```json",
    JSON.stringify({
      schemaVersion: 1,
      runId: "legacy-run",
      mission: "Replace the current note.",
      route: "streaming_writeback:replace",
      createdAt: "2026-09-02T12:00:00.000Z",
      updatedAt: "2026-09-02T12:00:00.000Z",
      status: "running",
      loopBudget: {
        hardCap: 4,
        toolStepBudget: 2,
        finalizationReserve: 1,
        expectedTools: ["replace_current_file"],
      },
    }),
    "```",
    "",
  ].join("\n");

  const ledger = parseMissionLedgerFromMarkdown(markdown);
  assert.ok(ledger);
  assert.equal(ledger.currentNoteWriteKind, undefined);
  assert.equal(resolveLedgerCurrentNoteWriteKind(ledger), "replace");
});

test("explicit currentNoteWriteKind round-trips through markdown", () => {
  const created = createMissionLedger({
    runId: "kind-run",
    mission: "Replace the current note.",
    route: "direct_current_note_writeback:replace",
    loopBudget: {
      hardCap: 4,
      toolStepBudget: 2,
      finalizationReserve: 1,
      expectedTools: ["replace_current_file"],
    },
    currentNoteWriteKind: "replace",
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(created.currentNoteWriteKind, "replace");

  const parsed = parseMissionLedgerFromMarkdown(formatMissionLedgerBlock(created));
  assert.ok(parsed);
  assert.equal(parsed.currentNoteWriteKind, "replace");
});

test("createMissionLedger omits the write-kind field unless explicitly passed", () => {
  const created = createMissionLedger({
    runId: "plain-run",
    mission: "Append a line.",
    route: "streaming_writeback:append",
    loopBudget: {
      hardCap: 4,
      toolStepBudget: 2,
      finalizationReserve: 1,
      expectedTools: ["append_to_current_file"],
    },
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(created.currentNoteWriteKind, undefined);
});

test("write kind recovers from expected tools and route suffix", () => {
  assert.equal(
    resolveCurrentNoteWriteKindV1({
      expectedTools: ["web_search", "replace_current_file"],
    }),
    "replace",
  );
  assert.equal(
    resolveCurrentNoteWriteKindV1({
      expectedTools: ["edit_current_section"],
    }),
    "edit",
  );
  assert.equal(
    resolveCurrentNoteWriteKindV1({
      route: "streaming_writeback:replace",
    }),
    "replace",
  );
  assert.equal(
    resolveCurrentNoteWriteKindV1({
      route: "direct_current_note_writeback:edit",
    }),
    "edit",
  );
  assert.equal(resolveCurrentNoteWriteKindV1({}), "append");
});
