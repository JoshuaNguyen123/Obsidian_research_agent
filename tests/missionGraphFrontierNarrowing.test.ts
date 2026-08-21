import test from "node:test";
import assert from "node:assert/strict";
import { narrowAdaptiveCodeMutationsToPlannedWritesV1 } from "../src/agent/missionGraphFrontier";
import type { ModelToolDefinition } from "../src/model/types";

const tool = (name: string): ModelToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

const CODE_MENU = [
  "read_template",
  "code_workspace_status",
  "code_workspace_read",
  "code_workspace_list",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_sandbox_status",
  "append_to_current_file",
].map(tool);

test("a ready planned workspace write pins the menu to that mutation", () => {
  // Regression: with code_workspace_append ready, the broad route catalog
  // still offered create_file / write_expected / patch / mkdir. The model
  // wrote the file through create_file, the planned node stayed ready, and
  // every validator behind it was deferred until the segment budget expired.
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-04-code_workspace_create": {
        status: "complete",
        allowedTools: ["code_workspace_create"],
      },
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
      },
      "tool-06-code_validate_fast": {
        status: "queued",
        allowedTools: ["code_validate_fast"],
      },
    },
  });
  assert.deepEqual(
    narrowed.map((item) => item.function.name),
    [
      "read_template",
      "code_workspace_status",
      "code_workspace_read",
      "code_workspace_list",
      "code_workspace_append",
      "code_sandbox_status",
      "append_to_current_file",
    ],
  );
});

test("adaptive workspace mutations return once no ready node pins one", () => {
  const graph = {
    nodes: {
      "tool-05-code_workspace_append": {
        status: "complete",
        allowedTools: ["code_workspace_append"],
      },
      "tool-06-code_validate_fast": {
        status: "ready",
        allowedTools: ["code_validate_fast"],
      },
    },
  };
  assert.deepEqual(
    narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, graph),
    CODE_MENU,
  );
  assert.deepEqual(
    narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, null),
    CODE_MENU,
  );
});

test("two ready planned writes keep both pinned mutations", () => {
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      a: { status: "ready", allowedTools: ["code_workspace_create_file"] },
      b: { status: "running", allowedTools: ["code_workspace_patch"] },
    },
  });
  const names = narrowed.map((item) => item.function.name);
  assert.ok(names.includes("code_workspace_create_file"));
  assert.ok(names.includes("code_workspace_patch"));
  assert.ok(!names.includes("code_workspace_append"));
  assert.ok(!names.includes("code_workspace_write_expected"));
  assert.ok(names.includes("code_workspace_read"));
});
