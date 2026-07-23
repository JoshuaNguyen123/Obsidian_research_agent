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
