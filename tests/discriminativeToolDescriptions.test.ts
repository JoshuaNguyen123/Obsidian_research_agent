import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCRIMINATIVE_TOOL_DESCRIPTIONS,
  withDiscriminativeDescription,
} from "../src/tools/discriminativeToolDescriptions";

test("covers confused pairs with Purpose / Do not use when", () => {
  for (const name of [
    "append_to_current_file",
    "code_workspace_create_file",
    "code_workspace_export_directory",
    "code_workspace_write_expected",
    "code_commit_verified",
    "publish_verified_code_to_github",
    "read_file",
    "web_search",
  ] as const) {
    const text = DISCRIMINATIVE_TOOL_DESCRIPTIONS[name];
    assert.match(String(text), /Purpose:/);
    assert.match(String(text), /Do not use when:/);
  }
});

test("code delivery descriptions identify the real filesystem and standalone export route", () => {
  for (const name of [
    "code_workspace_create_file",
    "code_workspace_write_expected",
    "code_workspace_export_directory",
  ] as const) {
    const text = DISCRIMINATIVE_TOOL_DESCRIPTIONS[name];
    assert.match(text, /real (?:directory|local filesystem)/iu);
    assert.match(text, /standalone-project|vault_sibling_projects/iu);
    assert.match(
      text,
      /code_workspace_export_directory|absolute verified export path/iu,
    );
  }
});

test("prefixes base descriptions once", () => {
  const once = withDiscriminativeDescription(
    "append_to_current_file",
    "Append markdown text.",
  );
  assert.ok(once.startsWith("Purpose:"));
  assert.match(once, /Append markdown text\./);
  assert.equal(
    withDiscriminativeDescription("append_to_current_file", once),
    once,
  );
});
