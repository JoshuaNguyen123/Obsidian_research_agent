import assert from "node:assert/strict";
import test from "node:test";
import {
  extractReceiptArtifactUrl,
  formatMissionReceiptMarkdown,
  inferArtifactSystem,
  missionReceiptNotePath,
} from "../src/agent/missionReceiptNote";

test("mission receipt path and markdown are deterministic", () => {
  assert.equal(
    missionReceiptNotePath("run/abc 123"),
    "Agent Work/Mission Receipts/run_abc_123.md",
  );
  const markdown = formatMissionReceiptMarkdown({
    runId: "run-1",
    completedAt: "2026-07-20T12:00:00.000Z",
    stages: ["Research", "Linear", "Code", "GitHub"],
    notePath: "Research/checkers.md",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    linearIssueIds: ["issue-1"],
    validationShas: ["sha256:bbbb"],
    artifacts: [
      {
        system: "linear",
        label: "ENG-1",
        url: "https://linear.app/acme/issue/ENG-1",
      },
      {
        system: "github",
        label: "Draft PR #2",
        url: "https://github.com/acme/repo/pull/2",
      },
    ],
  });
  assert.match(markdown, /Mission receipt — run-1/);
  assert.match(markdown, /Research → Linear → Code → GitHub/);
  assert.match(markdown, /https:\/\/linear\.app\/acme\/issue\/ENG-1/);
  assert.match(markdown, /https:\/\/github\.com\/acme\/repo\/pull\/2/);
  assert.doesNotMatch(markdown, /thinking/i);
});

test("extracts https artifact URLs from receipt resources", () => {
  assert.equal(
    extractReceiptArtifactUrl({
      url: "https://github.com/acme/repo/pull/3",
    }),
    "https://github.com/acme/repo/pull/3",
  );
  assert.equal(
    extractReceiptArtifactUrl({ htmlUrl: "http://insecure.example" }),
    null,
  );
  assert.equal(inferArtifactSystem("publish_verified_code_to_github", "github"), "github");
  assert.equal(inferArtifactSystem("linear_create_issue", "linear"), "linear");
});
