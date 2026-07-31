import assert from "node:assert/strict";
import test from "node:test";
import { getPendingRequiredWriteToolNames } from "../src/AgentRunner";

/**
 * A read tool listed as a required *write* gate can never be satisfied.
 *
 * `read_design_canvas` was pushed into requiredWriteTools for revise-design
 * prompts and has no TOOL_GOALS entry, so the gate fell through to
 * "pending until this exact tool runs". The run therefore never reached a
 * terminal ledger — which made it the permanent target of the
 * newest-unfinished-run resume lookup, hijacking later unrelated turns.
 */

function goals(completedTools: string[] = []) {
  return {
    goals: {},
    completedTools,
  } as unknown as Parameters<typeof getPendingRequiredWriteToolNames>[0];
}

test("read tools never form a pending write gate", () => {
  for (const readTool of [
    "read_design_canvas",
    "read_svg_design",
    "read_mermaid_block",
  ]) {
    assert.deepEqual(
      getPendingRequiredWriteToolNames(goals(), [readTool]),
      [],
      `${readTool} is a read; it cannot pay a write obligation`,
    );
  }
});

test("the paired write tool still gates until it runs", () => {
  assert.deepEqual(
    getPendingRequiredWriteToolNames(goals(), [
      "read_design_canvas",
      "update_design_canvas",
    ]),
    ["update_design_canvas"],
    "the write half must still be required",
  );
  assert.deepEqual(
    getPendingRequiredWriteToolNames(goals(["update_design_canvas"]), [
      "read_design_canvas",
      "update_design_canvas",
    ]),
    [],
    "once the write runs the gate is paid and the run can reach a terminal ledger",
  );
});
