import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubApiError,
  GitHubRestClient,
} from "../src/integrations/github/GitHubRestClient";
import type { HttpRequest, HttpResponse } from "../src/model/types";

test("GitHubRestClient reads a repository through fixed headers", async () => {
  let request: HttpRequest | undefined;
  const client = new GitHubRestClient({
    token: "secret-token",
    transport: async (input) => {
      request = input;
      return response(200, {
        id: 1,
        full_name: "acme/research-agent",
        html_url: "https://github.com/acme/research-agent",
        default_branch: "main",
        private: true,
        archived: false,
      });
    },
  });

  const repository = await client.getRepository("acme", "research-agent");
  assert.equal(repository.fullName, "acme/research-agent");
  assert.equal(request?.url, "https://api.github.com/repos/acme/research-agent");
  assert.equal(request?.headers?.Authorization, "Bearer secret-token");
  assert.equal(request?.method, "GET");
});

test("GitHubRestClient always creates a draft pull request", async () => {
  let body: Record<string, unknown> | undefined;
  const client = new GitHubRestClient({
    token: "secret-token",
    transport: async (request) => {
      body = JSON.parse(String(request.body));
      return response(201, {
        number: 12,
        html_url: "https://github.com/acme/research-agent/pull/12",
        state: "open",
        draft: true,
        merged: false,
        head: { ref: "codex/eng-12", sha: "abc" },
        base: { ref: "main", sha: "def" },
      });
    },
  });

  const pullRequest = await client.createDraftPullRequest({
    owner: "acme",
    repository: "research-agent",
    title: "Implement ENG-12",
    body: "Validated locally.",
    head: "codex/eng-12",
    base: "main",
  });
  assert.equal(pullRequest.draft, true);
  assert.equal(body?.draft, true);
});

test("GitHubRestClient classifies authentication without exposing token", async () => {
  const client = new GitHubRestClient({
    token: "do-not-leak",
    transport: async () => response(401, { message: "Bad credentials" }),
  });

  await assert.rejects(
    client.getRepository("acme", "research-agent"),
    (error: unknown) => {
      assert.ok(error instanceof GitHubApiError);
      assert.equal(error.code, "github_auth");
      assert.doesNotMatch(error.message, /do-not-leak/);
      return true;
    },
  );
});

function response(status: number, json: unknown): HttpResponse {
  return { status, json, headers: {} };
}

