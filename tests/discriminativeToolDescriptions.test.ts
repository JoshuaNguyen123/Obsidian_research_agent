import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCRIMINATIVE_TOOL_DESCRIPTIONS,
  applyDiscriminativeToolDefinition,
  descriptionHasRequiredFields,
  withDiscriminativeDescription,
} from "../src/tools/discriminativeToolDescriptions";

const EXISTING_NAMES = [
  "append_to_current_file",
  "read_current_file",
  "read_file",
  "web_search",
  "code_workspace_create_file",
  "code_workspace_export_directory",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_commit_verified",
  "linear_create_issue",
  "linear_get_issue",
  "report_progress_to_linear",
  "publish_research_to_linear",
  "github_create_repository",
  "github_create_private_repository",
  "publish_verified_code_to_github",
] as const;

const ADDED_NAMES = [
  "replace_current_file",
  "edit_current_section",
  "code_workspace_create",
  "code_workspace_append",
  "code_sandbox_status",
  "code_workspace_init_repository",
  "web_fetch",
  "read_source_section",
  "resolve_citation",
  "verify_citation",
  "export_bibtex",
  "semantic_search_notes",
  "inspect_semantic_index",
  "rebuild_semantic_index",
  "list_markdown_files",
  "get_note_graph_context",
  "find_related_notes",
  "suggest_note_links",
  "extract_document",
] as const;

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

test("added discriminative descriptions use the full contract and stay compact", () => {
  for (const name of ADDED_NAMES) {
    const text = DISCRIMINATIVE_TOOL_DESCRIPTIONS[name];
    assert.ok(text, `missing description for ${name}`);
    assert.ok(
      descriptionHasRequiredFields(text),
      `${name} is missing a required field`,
    );
    assert.ok(
      text.length <= 450,
      `${name} is ${text.length} chars; cap is ~450`,
    );
  }
});

test("existing discriminative descriptions remain present", () => {
  for (const name of EXISTING_NAMES) {
    const text = DISCRIMINATIVE_TOOL_DESCRIPTIONS[name];
    assert.ok(text, `missing existing description for ${name}`);
    assert.match(text, /Purpose:/);
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

test("applyDiscriminativeToolDefinition prefixes once and skips unknown tools", () => {
  const prefixed = applyDiscriminativeToolDefinition({
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "Fetch one web page by URL.",
    },
  });
  assert.match(prefixed.function.description ?? "", /^Purpose: Fetch one public/);
  assert.match(prefixed.function.description ?? "", /Fetch one web page by URL\./);
  assert.equal(
    applyDiscriminativeToolDefinition(prefixed),
    prefixed,
  );

  const unknown = {
    type: "function" as const,
    function: { name: "count_words", description: "Count words." },
  };
  assert.equal(applyDiscriminativeToolDefinition(unknown), unknown);
});
