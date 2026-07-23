import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOffFrontierToolRejectionMessage,
  buildToolRejectEvalV1,
  describeOffFrontierToolNearMiss,
  mapToolRejectCategory,
} from "../src/agent/toolRejectEval";

test("maps invented commit/git_add to code_commit_verified when listed", () => {
  assert.match(
    String(describeOffFrontierToolNearMiss("git_commit", ["code_commit_verified"])),
    /code_commit_verified/,
  );
  assert.match(
    String(describeOffFrontierToolNearMiss("git_add", ["code_commit_verified"])),
    /code_commit_verified/,
  );
});

test("maps create_repo and publish aliases when listed", () => {
  assert.match(
    String(
      describeOffFrontierToolNearMiss("create_repo", [
        "github_create_private_repository",
      ]),
    ),
    /github_create_private_repository/,
  );
  assert.match(
    String(
      describeOffFrontierToolNearMiss("draft_pr", [
        "publish_verified_code_to_github",
      ]),
    ),
    /publish_verified_code_to_github/,
  );
});

test("rejection message includes category and Preferred next", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "git_commit",
    readyFrontierToolNames: ["code_validate_fast", "code_commit_verified"],
    preferredNextTool: "code_commit_verified",
  });
  assert.match(message, /category=/);
  assert.match(message, /Preferred next: code_commit_verified/);
  assert.match(message, /Near-miss:.*code_commit_verified/);
  assert.match(message, /do not repeat/);
});

test("classifies off-frontier as unknown_tool", () => {
  assert.equal(
    mapToolRejectCategory({
      toolName: "git_commit",
      message: "Tool is not available for this prompt",
    }),
    "unknown_tool",
  );
});

test("builds eval records", () => {
  const record = buildToolRejectEvalV1({
    userIntentExcerpt: "implement hello and commit",
    selectedTool: "git_commit",
    expectedPrerequisite: "code_commit_verified",
    errorCategory: "unknown_tool",
    readyFrontier: ["code_commit_verified"],
  });
  assert.equal(record.result, "rejected");
  assert.equal(record.selectedTool, "git_commit");
  assert.equal(record.expectedPrerequisite, "code_commit_verified");
});
