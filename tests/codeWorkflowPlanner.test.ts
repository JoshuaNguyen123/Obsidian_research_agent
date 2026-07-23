import assert from "node:assert/strict";
import test from "node:test";
import { CODE_EXECUTION_TOOL_ALLOW } from "../src/agent/lifecycleStagePolicy";
import {
  filterCodeWorkflowToolsToAllowlist,
  selectCodeWorkspaceEditToolName,
} from "../src/agent/codeWorkflowPlanner";

test("does not select copy/move/trash for compound allowlist", () => {
  const allow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "copy the file path and then implement hello",
      allow,
    ),
    "code_workspace_create_file",
  );
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "rename the file path in the repository",
      allow,
    ),
    "code_workspace_create_file",
  );
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "delete the file path from the workspace",
      allow,
    ),
    "code_workspace_create_file",
  );
});

test("filters relocation tools not on allowlist", () => {
  const allow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  assert.deepEqual(
    filterCodeWorkflowToolsToAllowlist(
      [
        "code_workspace_create",
        "code_workspace_copy",
        "code_workspace_create_file",
        "code_validate_fast",
      ],
      allow,
    ),
    [
      "code_workspace_create",
      "code_workspace_create_file",
      "code_validate_fast",
    ],
  );
});

test("allows copy when allowlisted", () => {
  const withCopy = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  withCopy.add("code_workspace_copy");
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "copy the file path into backups",
      withCopy,
    ),
    "code_workspace_copy",
  );
});
