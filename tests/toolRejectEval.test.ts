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
        "github_create_repository",
      ]),
    ),
    /github_create_repository/,
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

// A proof-verification hold tells the model "return the corrected content as
// your final answer, do not call the write tool"; the frontier rejection must
// never answer with "call that exact name" for the same tool, or the two
// subsystems command opposite next moves in the same transcript.
test("held preferred write tool gets the held-truth line, not a call directive", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "read_source_section",
    readyFrontierToolNames: ["append_to_current_file"],
    preferredNextTool: "append_to_current_file",
    heldWriteToolNames: ["append_to_current_file"],
  });
  assert.match(
    message,
    /append_to_current_file is currently held by proof verification — return the corrected note content as your final answer instead of calling it\./,
  );
  assert.doesNotMatch(message, /Call that exact name/);
  assert.doesNotMatch(message, /Preferred next:/);
  // The frontier listing is factual and stays.
  assert.match(
    message,
    /Ready frontier tool\(s\) now: append_to_current_file\./,
  );
});

test("without held tools the message is byte-identical to the unheld format", () => {
  const baseline = buildOffFrontierToolRejectionMessage({
    toolName: "web_fetch",
    readyFrontierToolNames: ["semantic_search_notes", "append_to_current_file"],
  });
  assert.equal(
    baseline,
    "Tool is not available for this prompt: web_fetch " +
      "category=unknown_tool " +
      "Ready frontier tool(s) now: semantic_search_notes, append_to_current_file. " +
      "Preferred next: semantic_search_notes, append_to_current_file. Call that exact name. " +
      "Correct only that issue; do not repeat this exact call.",
  );
  // An explicitly empty held set must not change a single byte either.
  assert.equal(
    buildOffFrontierToolRejectionMessage({
      toolName: "web_fetch",
      readyFrontierToolNames: [
        "semantic_search_notes",
        "append_to_current_file",
      ],
      heldWriteToolNames: [],
    }),
    baseline,
  );
});

test("held tool is excluded from the fallback preferred join", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "web_fetch",
    readyFrontierToolNames: [
      "append_to_current_file",
      "web_search",
      "read_source_section",
    ],
    heldWriteToolNames: ["append_to_current_file"],
  });
  assert.match(
    message,
    /Preferred next: web_search, read_source_section\. Call that exact name\./,
  );
  assert.doesNotMatch(message, /Preferred next: append_to_current_file/);
});

test("a frontier of only held tools keeps the listing but drops the directive", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "web_fetch",
    readyFrontierToolNames: ["append_to_current_file"],
    heldWriteToolNames: ["append_to_current_file"],
  });
  assert.match(
    message,
    /Ready frontier tool\(s\) now: append_to_current_file\./,
  );
  assert.doesNotMatch(message, /Call that exact name/);
  assert.match(
    message,
    /append_to_current_file is currently held by proof verification/,
  );
});
