import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureGitHubPublicationDefaultBranchV1,
  type GitHubPublicationDefaultBranchClientV1,
} from "../src/integrations/github/GitHubPublicationDefaultBranchV1";
import type {
  GitHubReferenceRecord,
  GitHubRepositoryRecord,
} from "../src/integrations/github/GitHubRestClient";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const BASE_BRANCH = "main";
const HEAD_BRANCH = "codex/flow-real";

test("GitHub publication default branch is unchanged when the exact base is already default", async () => {
  const client = new FakeDefaultBranchClient(BASE_BRANCH);
  const proof = await ensureGitHubPublicationDefaultBranchV1(
    client,
    input(),
  );

  assert.equal(proof.status, "already_verified");
  assert.equal(proof.repository.defaultBranch, BASE_BRANCH);
  assert.equal(client.updateCalls, 0);
});

test("GitHub publication repairs only the verified empty-repository agent-default transition", async () => {
  const client = new FakeDefaultBranchClient(HEAD_BRANCH);
  const proof = await ensureGitHubPublicationDefaultBranchV1(
    client,
    input(),
  );

  assert.equal(proof.status, "updated_verified");
  assert.equal(proof.previousDefaultBranch, HEAD_BRANCH);
  assert.equal(proof.repository.defaultBranch, BASE_BRANCH);
  assert.equal(client.updateCalls, 1);
  assert.equal(client.repositoryReads, 2);
  assert.equal(client.referenceReads, 4);
});

test("GitHub publication verifies the explicitly public default-branch transition", async () => {
  const client = new FakeDefaultBranchClient(HEAD_BRANCH, {
    visibility: "public",
  });
  const proof = await ensureGitHubPublicationDefaultBranchV1(
    client,
    { ...input(), expectedVisibility: "public" },
  );

  assert.equal(proof.status, "updated_verified");
  assert.equal(proof.repository.visibility, "public");
  assert.equal(client.updateCalls, 1);
});

test("GitHub publication rejects an unrelated default branch without mutating", async () => {
  const client = new FakeDefaultBranchClient("release");
  await assert.rejects(
    ensureGitHubPublicationDefaultBranchV1(client, input()),
    /outside the exact empty-repository publication transition/iu,
  );
  assert.equal(client.updateCalls, 0);
});

test("GitHub publication rejects base-ref drift before changing the default branch", async () => {
  const client = new FakeDefaultBranchClient(HEAD_BRANCH, {
    baseSha: "c".repeat(40),
  });
  await assert.rejects(
    ensureGitHubPublicationDefaultBranchV1(client, input()),
    /base branch no longer matches/iu,
  );
  assert.equal(client.updateCalls, 0);
});

function input() {
  return {
    owner: "acme",
    repository: "research-agent",
    baseBranch: BASE_BRANCH,
    baseSha: BASE,
    headBranch: HEAD_BRANCH,
    headSha: HEAD,
  };
}

class FakeDefaultBranchClient
  implements GitHubPublicationDefaultBranchClientV1 {
  updateCalls = 0;
  repositoryReads = 0;
  referenceReads = 0;
  private defaultBranch: string;
  private readonly baseSha: string;
  private readonly headSha: string;
  private readonly visibility: "public" | "private";

  constructor(
    defaultBranch: string,
    options: {
      baseSha?: string;
      headSha?: string;
      visibility?: "public" | "private";
    } = {},
  ) {
    this.defaultBranch = defaultBranch;
    this.baseSha = options.baseSha ?? BASE;
    this.headSha = options.headSha ?? HEAD;
    this.visibility = options.visibility ?? "private";
  }

  async getRepository(): Promise<GitHubRepositoryRecord> {
    this.repositoryReads += 1;
    return this.repositoryRecord();
  }

  private repositoryRecord(): GitHubRepositoryRecord {
    return {
      id: 42,
      fullName: "acme/research-agent",
      htmlUrl: "https://github.com/acme/research-agent",
      defaultBranch: this.defaultBranch,
      private: this.visibility === "private",
      archived: false,
      visibility: this.visibility,
    };
  }

  async getReference(
    _owner: string,
    _repository: string,
    branch: string,
  ): Promise<GitHubReferenceRecord> {
    this.referenceReads += 1;
    return {
      ref: `refs/heads/${branch}`,
      sha: branch === BASE_BRANCH ? this.baseSha : this.headSha,
      objectType: "commit",
    };
  }

  async updateRepositoryDefaultBranch(
    _owner: string,
    _repository: string,
    branch: string,
  ): Promise<GitHubRepositoryRecord> {
    this.updateCalls += 1;
    this.defaultBranch = branch;
    return this.repositoryRecord();
  }
}
