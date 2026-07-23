import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedResearchNoteWriter,
  type AcceptedResearchNotePackageV1,
} from "../src/integrations/linear/AcceptedResearchNoteWriter";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";

const HASH = `sha256:${"a".repeat(64)}`;

test("accepted research is formatted, persisted, hashed, accepted, and backlinked in order", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault, {
    now: () => new Date("2026-07-12T20:00:00.000Z"),
  });
  const written = await writer.writeAcceptedPackage({
    path: "Research/Agent platform.md",
    mode: "create",
    artifactId: "accepted-research-run-42",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });

  const note = vault.files.get(written.path) ?? "";
  assert.equal(written.operation, "create");
  assert.equal(written.afterSha256, await sha256DiagramContent(note));
  assert.equal(written.artifact.noteSha256, written.afterSha256);
  assert.equal(written.artifact.noteReceiptId, written.noteReceiptId);
  for (const heading of [
    "## Problem and impact",
    "## Evidence and source links",
    "## Confidence and limitations",
    "## Proposed work",
    "## Non-goals",
    "## Scope and dependencies",
    "## Acceptance criteria",
    "## Validation requirements",
    "## Risk and execution class",
    "## Machine contract",
  ]) assert.match(note, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  assert.match(note, /https:\/\/example\.test\/evidence/u);

  const linked = await writer.appendLinearBacklink({
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    issueIdentifier: "ENG-42",
    issueUrl: "https://linear.app/acme/issue/ENG-42",
  });
  assert.equal(linked.operation, "append");
  assert.match(vault.files.get(written.path) ?? "", /\[ENG-42\]\(https:\/\/linear\.app\/acme\/issue\/ENG-42\)/u);
  assert.notEqual(linked.afterSha256, written.afterSha256);

  const github = await writer.appendGitHubCompletionLinks({
    artifact: written.artifact,
    expectedNoteSha256: linked.afterSha256,
    pullRequestNumber: 17,
    pullRequestUrl: "https://github.com/acme/agentic-researcher/pull/17",
    mergeCommitUrl:
      "https://github.com/acme/agentic-researcher/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mergeSha: "a".repeat(40),
  });
  assert.equal(github.operation, "append");
  assert.match(
    vault.files.get(written.path) ?? "",
    /\[Pull request #17\]\(https:\/\/github\.com\/acme\/agentic-researcher\/pull\/17\)/u,
  );
  assert.equal(
    (await writer.appendGitHubCompletionLinks({
      artifact: written.artifact,
      expectedNoteSha256: github.afterSha256,
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.com/acme/agentic-researcher/pull/17",
      mergeCommitUrl:
        "https://github.com/acme/agentic-researcher/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mergeSha: "a".repeat(40),
    })).operation,
    "no_op",
  );
});

test("accepted research create retry reuses exact persisted bytes without a second mutation", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const request = {
    path: "Research/Retry-safe package.md",
    mode: "create" as const,
    artifactId: "accepted-research-run-retry",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  };
  const first = await writer.writeAcceptedPackage(request);
  const persisted = vault.files.get(request.path);
  const second = await writer.writeAcceptedPackage(request);

  assert.equal(first.operation, "create");
  assert.equal(second.operation, "no_op");
  assert.equal(second.beforeSha256, first.afterSha256);
  assert.equal(second.afterSha256, first.afterSha256);
  assert.equal(second.noteReceiptId, first.noteReceiptId);
  assert.equal(second.transaction, null);
  assert.equal(vault.files.get(request.path), persisted);
});

test("accepted research create retry rejects changed content at the same path", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const request = {
    path: "Research/Retry collision.md",
    mode: "create" as const,
    artifactId: "accepted-research-run-collision",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  };
  await writer.writeAcceptedPackage(request);
  vault.files.set(request.path, `${vault.files.get(request.path)}\nUser-authored change.\n`);
  const before = vault.files.get(request.path);

  await assert.rejects(
    writer.writeAcceptedPackage(request),
    /cannot overwrite changed content/u,
  );
  assert.equal(vault.files.get(request.path), before);
});

test("accepted research append and backlink reject stale hashes before changing bytes", async () => {
  const vault = new ResearchVault({ "Research/Existing.md": "# Existing\n" });
  const writer = new AcceptedResearchNoteWriter(vault);
  const before = vault.files.get("Research/Existing.md");

  await assert.rejects(
    writer.writeAcceptedPackage({
      path: "Research/Existing.md",
      mode: "append",
      baseHash: HASH,
      artifactId: "accepted-research-run-42",
      acceptedAt: "2026-07-12T20:00:00.000Z",
      package: packageFixture(),
    }),
    /changed before append/u,
  );
  assert.equal(vault.files.get("Research/Existing.md"), before);
});

test("accepted research append retry is marker-bound and does not duplicate the initiating note", async () => {
  const path = "Projects/Checkers idea.md";
  const initial = "# Checkers idea\n\nCreate a playable checkers application.\n";
  const vault = new ResearchVault({ [path]: initial });
  const writer = new AcceptedResearchNoteWriter(vault);
  const request = {
    path,
    mode: "append" as const,
    baseHash: await sha256DiagramContent(initial),
    artifactId: "accepted-research-run-initiating-note",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  };

  const first = await writer.writeAcceptedPackage(request);
  const firstBytes = vault.files.get(path) ?? "";
  const retry = await writer.writeAcceptedPackage(request);

  assert.equal(first.operation, "append");
  assert.equal(retry.operation, "no_op");
  assert.equal(retry.afterSha256, first.afterSha256);
  assert.equal(vault.files.get(path), firstBytes);
  assert.equal(
    firstBytes.match(/agentic-accepted-research:accepted-research-run-initiating-note/gu)?.length,
    1,
  );
  assert.equal(firstBytes.match(/## Problem and impact/gu)?.length, 1);
});

test("GitHub completion backlink rejects stale hashes and non-GitHub destinations", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const written = await writer.writeAcceptedPackage({
    path: "Research/Agent platform.md",
    mode: "create",
    artifactId: "accepted-research-run-43",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });
  const before = vault.files.get(written.path);
  await assert.rejects(writer.appendGitHubCompletionLinks({
    artifact: written.artifact,
    expectedNoteSha256: HASH,
    pullRequestNumber: 17,
    pullRequestUrl: "https://github.com/acme/agentic-researcher/pull/17",
    mergeCommitUrl:
      "https://github.com/acme/agentic-researcher/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mergeSha: "a".repeat(40),
  }), /changed before GitHub/u);
  assert.equal(vault.files.get(written.path), before);
  await assert.rejects(writer.appendGitHubCompletionLinks({
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    pullRequestNumber: 17,
    pullRequestUrl: "https://evil.example/pull/17",
    mergeCommitUrl:
      "https://github.com/acme/agentic-researcher/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mergeSha: "a".repeat(40),
  }), /github\.com/u);
  assert.equal(vault.files.get(written.path), before);
});

test("verified draft-PR backlink is append-once and does not require fabricated merge proof", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const written = await writer.writeAcceptedPackage({
    path: "Research/Draft proof.md",
    mode: "create",
    artifactId: "accepted-research-run-draft",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });
  const first = await writer.appendGitHubCompletionLinks({
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    pullRequestNumber: 18,
    pullRequestUrl: "https://github.com/acme/agentic-researcher/pull/18",
  });
  assert.equal(first.operation, "append");
  assert.equal(first.mergeCommitUrl, null);
  assert.match(vault.files.get(written.path) ?? "", /Draft pull request #18/u);
  const second = await writer.appendGitHubCompletionLinks({
    artifact: written.artifact,
    expectedNoteSha256: first.afterSha256,
    pullRequestNumber: 18,
    pullRequestUrl: "https://github.com/acme/agentic-researcher/pull/18",
  });
  assert.equal(second.operation, "no_op");
  assert.equal(second.afterSha256, first.afterSha256);
});

test("project completion reflection appends substantive proof once", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const written = await writer.writeAcceptedPackage({
    path: "Research/Checkers delivery.md",
    mode: "create",
    artifactId: "accepted-research-checkers",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });
  const reflected = await writer.appendProjectCompletionReflection({
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    publicationId: "publication-checkers-17",
    issueIdentifier: "GAME-17",
    issueUrl: "https://linear.app/acme/issue/GAME-17",
    pullRequestNumber: 17,
    pullRequestUrl: "https://github.com/acme/checkers/pull/17",
    completionProof: "draft_pr",
    proofRevision: "b".repeat(40),
    changedPaths: ["src/checkers.ts", "tests/checkers.test.ts"],
    targetedValidationReceiptId: "receipt-checkers-targeted",
    fullValidationReceiptId: "receipt-checkers-full",
    localCommitReceiptId: "receipt-checkers-commit",
  });
  const note = vault.files.get(written.path) ?? "";
  assert.equal(reflected.operation, "append");
  assert.match(note, /## Agent project reflection/u);
  assert.match(note, /agentic-project-reflection:publication-checkers-17/u);
  assert.match(note, /src\/checkers\.ts/u);
  assert.match(note, /receipt-checkers-full/u);
  assert.match(note, /Human review and merge remain/u);

  const retry = await writer.appendProjectCompletionReflection({
    artifact: written.artifact,
    expectedNoteSha256: reflected.afterSha256,
    publicationId: "publication-checkers-17",
    issueIdentifier: "GAME-17",
    issueUrl: "https://linear.app/acme/issue/GAME-17",
    pullRequestNumber: 17,
    pullRequestUrl: "https://github.com/acme/checkers/pull/17",
    completionProof: "draft_pr",
    proofRevision: "b".repeat(40),
    changedPaths: ["src/checkers.ts", "tests/checkers.test.ts"],
    targetedValidationReceiptId: "receipt-checkers-targeted",
    fullValidationReceiptId: "receipt-checkers-full",
    localCommitReceiptId: "receipt-checkers-commit",
  });
  assert.equal(retry.operation, "no_op");
  assert.equal(vault.files.get(written.path), note);
  await assert.rejects(
    writer.appendProjectCompletionReflection({
      artifact: written.artifact,
      expectedNoteSha256: retry.afterSha256,
      publicationId: "publication-checkers-17",
      issueIdentifier: "GAME-17",
      issueUrl: "https://linear.app/acme/issue/GAME-17",
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.com/acme/checkers/pull/17",
      completionProof: "draft_pr",
      proofRevision: "b".repeat(40),
      changedPaths: ["src/different.ts"],
      targetedValidationReceiptId: "receipt-checkers-targeted",
      fullValidationReceiptId: "receipt-checkers-full",
      localCommitReceiptId: "receipt-checkers-commit",
    }),
    /collides with different or incomplete proof/u,
  );
});

function packageFixture(): AcceptedResearchNotePackageV1 {
  return {
    schemaVersion: 1,
    title: "Agent platform gap closure",
    problemImpact: "The current handoff must remain exact and auditable.",
    evidence: [{
      id: "evidence-web-1",
      kind: "web",
      reference: "https://example.test/evidence",
      contentSha256: HASH,
      label: "Primary evidence",
      summary: "The source supports the accepted implementation scope.",
    }],
    confidenceLimitations: "High confidence; live provider smoke testing remains separate.",
    proposedWork: ["Publish one deduplicated execution contract."],
    nonGoals: ["Automatic merge."],
    scope: ["Obsidian to Linear handoff."],
    dependencies: ["Connected Linear workspace."],
    acceptanceCriteria: [{ id: "AC-1", text: "The note exists before Linear mutation." }],
    validationRequirementKeys: ["tests.unit"],
    riskClass: "medium",
    executionClass: "code",
    objective: "Implement the accepted agent platform work item.",
    repositoryKey: "agentic-researcher",
    vaultBindingKey: "primary-vault",
    originRunId: "run-42",
  };
}

class ResearchVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set(["Research", ".agent-backups"]);
  readonly adapterFiles = new Map<string, string>();
  readonly adapter = {
    exists: async (path: string) => this.adapterFiles.has(path) || this.folders.has(path),
    mkdir: async (path: string) => {
      this.folders.add(path);
    },
    read: async (path: string) => {
      const content = this.adapterFiles.get(path);
      if (content === undefined) throw new Error(`Missing adapter file: ${path}`);
      return content;
    },
    write: async (path: string, content: string) => {
      this.adapterFiles.set(path, content);
    },
    remove: async (path: string) => {
      this.adapterFiles.delete(path);
    },
  };

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  getAbstractFileByPath(path: string) {
    return this.files.has(path) || this.folders.has(path) ? { path } : null;
  }
  getFileByPath(path: string) {
    return this.files.has(path) ? { path } : null;
  }
  getFolderByPath(path: string) {
    return this.folders.has(path) ? { path } : null;
  }
  async create(path: string, content: string) {
    if (this.getAbstractFileByPath(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.files.set(path, content);
    return { path };
  }
  async read(file: { path: string }) {
    const content = this.files.get(file.path);
    if (content === undefined) throw new Error("missing");
    return content;
  }
  async modify(file: { path: string }, content: string) {
    if (!this.files.has(file.path)) throw new Error("missing");
    this.files.set(file.path, content);
  }
  async trash(file: { path: string }) {
    this.files.delete(file.path);
  }
  async delete(file: { path: string }) {
    this.files.delete(file.path);
  }
}
