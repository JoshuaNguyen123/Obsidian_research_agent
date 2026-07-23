import assert from "node:assert/strict";
import test from "node:test";
import {
  effectClassForTool,
  effectClassForTools,
  filterToolNamesByMaxEffectClass,
  mayAutoContinue,
  mayAutoExecute,
} from "../src/agent/autonomyEffectClass";
import type { ProofDebt } from "../src/agent/proofDebt";
import { GITHUB_CATALOG_READ_TOOL_NAMES } from "../src/tools/githubCatalogTools";

function softDebt(): ProofDebt {
  return {
    missing: ["mission_plan:web_fetch"],
    openConflicts: [],
    nextAction: {
      kind: "tool",
      toolName: "web_fetch",
      reason: "fetch",
      summary: "fetch",
    },
    blocked: false,
    resumeBlocked: false,
    empty: false,
  };
}

test("effectClassForTool maps soft force and hard force", () => {
  assert.equal(effectClassForTool("web_search"), "soft");
  assert.equal(effectClassForTool("append_to_current_file"), "soft");
  assert.equal(effectClassForTool("github_merge_pull_request"), "hard");
  assert.equal(effectClassForTool("linear_trash_issue"), "hard");
});

test("GitHub catalog reads are Soft, reversible mutations Bound, and dangerous operations Hard", () => {
  for (const name of GITHUB_CATALOG_READ_TOOL_NAMES) {
    assert.equal(effectClassForTool(name), "soft", name);
  }

  for (const name of [
    "github_create_issue",
    "github_update_issue",
    "github_close_issue",
    "github_reopen_issue",
    "github_create_issue_comment",
    "github_update_pull_request",
  ]) {
    assert.equal(effectClassForTool(name), "bound", name);
  }

  for (const name of [
    "github_delete_owned_comment",
    "github_delete_owned_branch",
    "github_merge_pull_request",
    "github_rerun_failed_workflow_jobs",
  ]) {
    assert.equal(effectClassForTool(name), "hard", name);
  }
});

test("effectClassForTools returns max severity", () => {
  assert.equal(
    effectClassForTools(["web_search", "publish_research_to_linear"]),
    effectClassForTool("publish_research_to_linear"),
  );
});

test("mayAutoExecute soft under automatic; hard never; bound needs grant", () => {
  assert.equal(
    mayAutoExecute({
      effectClass: "soft",
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
    }),
    true,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "hard",
      autonomyProfile: "automatic",
      hasMatchingGrant: true,
    }),
    false,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "bound",
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
    }),
    false,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "bound",
      autonomyProfile: "automatic",
      hasMatchingGrant: true,
    }),
    true,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "bound",
      autonomyProfile: "conservative",
      hasMatchingGrant: true,
    }),
    false,
  );
  assert.equal(
    mayAutoExecute({
      effectClass: "bound",
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
      setLooseBoundWithoutGrant: true,
    }),
    true,
  );
});

test("mayAutoContinue and filterToolNamesByMaxEffectClass", () => {
  assert.equal(
    mayAutoContinue({
      pendingToolNames: ["web_fetch"],
      autonomyProfile: "automatic",
      hasMatchingGrant: false,
      proofDebt: softDebt(),
    }),
    true,
  );
  assert.equal(
    mayAutoContinue({
      pendingToolNames: ["github_merge_pull_request"],
      autonomyProfile: "automatic",
      hasMatchingGrant: true,
      proofDebt: softDebt(),
    }),
    false,
  );
  const filtered = filterToolNamesByMaxEffectClass(
    ["web_search", "linear_trash_issue", "append_to_current_file"],
    "soft",
  );
  assert.deepEqual(filtered.sort(), ["append_to_current_file", "web_search"]);
});
