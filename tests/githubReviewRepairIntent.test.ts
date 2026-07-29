import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitGitHubReviewRepairIntentV1 } from "../src/agent/githubReviewRepairIntent";

test("routes explicit GitHub pull-request review repair commands", () => {
  assert.equal(
    hasExplicitGitHubReviewRepairIntentV1(
      "Address the review comments on GitHub pull request #42.",
    ),
    true,
  );
  assert.equal(
    hasExplicitGitHubReviewRepairIntentV1(
      "Resolve the changes requested. Push the update to the existing PR.",
    ),
    true,
  );
  assert.equal(
    hasExplicitGitHubReviewRepairIntentV1(
      "Review the PR and implement the requested fixes.",
    ),
    true,
  );
});

test("does not divert the isolated Linear-to-code handoff into PR review repair", () => {
  const phaseBPrompt = [
    "Review and implement Linear issue APP-271. Begin with an independent linear_get_issue read of that exact identity and treat its signed accepted-research contract as the sole product specification.",
    "When the work is complete, write exactly one 35-100 word human reflection to the accepted research's initiating note through its durable lineage. Mention the research, Linear issue, code outcome, tests, draft pull request, and one honest remaining limitation without tool, receipt, run, or internal-path jargon.",
    "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
    "Implement the requested Python library in its bound trusted repository, choose the files and design yourself, inspect protected acceptance material as needed, validate against the issue contract before committing, and create one verified local commit.",
    "Deliver the final verified working directory to a new absolute Desktop folder that a normal IDE can open. Do not overwrite an existing folder.",
    "Do not ask me for a filename, workspace ID, repository key, validation command, marker, or GitHub repository name: obtain those only from the Linear issue and trusted host bindings.",
  ].join(" ");

  assert.equal(hasExplicitGitHubReviewRepairIntentV1(phaseBPrompt), false);
});

test("does not route ordinary review, implementation, or publication wording", () => {
  for (const prompt of [
    "Review and implement Linear issue APP-271.",
    "Implement the library, test it, and publish a GitHub draft pull request.",
    "Review the research note and summarize the feedback.",
    "Open a GitHub pull request for the finished implementation.",
  ]) {
    assert.equal(
      hasExplicitGitHubReviewRepairIntentV1(prompt),
      false,
      prompt,
    );
  }
});
