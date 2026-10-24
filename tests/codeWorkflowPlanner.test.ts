import assert from "node:assert/strict";
import test from "node:test";
import { CODE_EXECUTION_TOOL_ALLOW } from "../src/agent/lifecycleStagePolicy";
import {
  filterCodeWorkflowToolsToAllowlist,
  isCodeWorkspaceRelocationTool,
  selectCodeWorkspaceEditToolName,
} from "../src/agent/codeWorkflowPlanner";

test("does not seed copy/move/trash even when they are allowlisted", () => {
  // Relocation is allowlisted for mid-mission use, but it must never be the
  // planned first edit: move/copy/trash all need a file that does not exist
  // yet when the seed ladder is built.
  const allow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  assert.ok(allow.has("code_workspace_copy"));
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
  const allow = new Set<string>(
    [...CODE_EXECUTION_TOOL_ALLOW].filter(
      (name) => !isCodeWorkspaceRelocationTool(name),
    ),
  );
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

test("allows copy when allowlisted and the caller opts in to a relocation seed", () => {
  const withCopy = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  withCopy.add("code_workspace_copy");
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "copy the file path into backups",
      withCopy,
      { allowRelocationSeed: true },
    ),
    "code_workspace_copy",
  );
});

test("Desktop delivery folder prose does not select workspace mkdir", () => {
  const allow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "Implement the Python library in its trusted repository. Deliver the final verified working directory to a new absolute Desktop folder that an IDE can open.",
      allow,
    ),
    "code_workspace_create_file",
  );
});

test("selects mkdir only for an actual directory inside the code workspace", () => {
  const allow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  assert.equal(
    selectCodeWorkspaceEditToolName(
      "Create an empty fixtures directory inside the project workspace.",
      allow,
    ),
    "code_workspace_mkdir",
  );
});

test("an edit that names two files is planned as one patch; one file, or new files, keep the single writes", () => {
  const allow = new Set<string>(CODE_EXECUTION_TOOL_ALLOW);
  assert.ok(allow.has("code_workspace_apply_patch"));
  assert.equal(
    selectCodeWorkspaceEditToolName("Rename parse() in src/parse.ts and update its caller in src/main.ts.", allow),
    "code_workspace_apply_patch",
  );
  assert.equal(
    selectCodeWorkspaceEditToolName("Fix the off-by-one in pager.py and add a case to tests/test_pager.py.", allow),
    "code_workspace_apply_patch",
  );
  assert.equal(
    selectCodeWorkspaceEditToolName("Fix the off-by-one in src/pager.py.", allow),
    "code_workspace_patch",
  );
  assert.equal(
    selectCodeWorkspaceEditToolName("Fix src/pager.py; the same file, src/pager.py, holds the test.", allow),
    "code_workspace_patch",
  );
  assert.equal(
    selectCodeWorkspaceEditToolName("Create main.py and utils.py for a new command-line tool.", allow),
    "code_workspace_create_file",
  );
  const withoutPatch = new Set([...allow].filter((name) => name !== "code_workspace_apply_patch"));
  assert.equal(
    selectCodeWorkspaceEditToolName("Rename parse() in src/parse.ts and update its caller in src/main.ts.", withoutPatch),
    "code_workspace_patch",
  );
});
