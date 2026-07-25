import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubPullRequestRecord } from "../src/integrations/github/GitHubRestClient";
import { projectGitHubPublicationPullRequestV1 } from "../src/integrations/github/GitHubPublicationPullRequestProjectionV1";

const GIT_A = "a".repeat(40);
const GIT_B = "b".repeat(40);
const GIT_C = "c".repeat(40);

test("publication pull-request projection strips REST-only prose, node identity, and nested extras", () => {
  const providerRecord = {
    nodeId: "PR_kwDOExample",
    number: 42,
    htmlUrl: "https://github.com/acme/research-agent/pull/42",
    state: "open",
    title: "Verified agent change",
    body: "Provider-returned prose must not become checkpoint state.",
    draft: true,
    merged: false,
    head: { ref: "codex/repair-42", sha: GIT_B, label: "REST-only head metadata" },
    base: { ref: "main", sha: GIT_A, label: "REST-only base metadata" },
    updatedAt: "2026-07-25T10:00:00.000Z",
    mergeSha: GIT_C,
  } as GitHubPullRequestRecord;
  const projected = projectGitHubPublicationPullRequestV1(providerRecord);

  assert.deepEqual(projected, {
    number: 42,
    htmlUrl: "https://github.com/acme/research-agent/pull/42",
    state: "open",
    draft: true,
    merged: false,
    head: { ref: "codex/repair-42", sha: GIT_B },
    base: { ref: "main", sha: GIT_A },
    updatedAt: "2026-07-25T10:00:00.000Z",
    mergeSha: GIT_C,
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "base",
    "draft",
    "head",
    "htmlUrl",
    "mergeSha",
    "merged",
    "number",
    "state",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(projected.head).sort(), ["ref", "sha"]);
  assert.deepEqual(Object.keys(projected.base).sort(), ["ref", "sha"]);
});
