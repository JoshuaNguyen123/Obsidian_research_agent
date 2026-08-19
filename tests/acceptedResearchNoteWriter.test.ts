import assert from "node:assert/strict";
import test from "node:test";

import {
  AcceptedResearchNoteWriter,
  type AcceptedResearchNotePackageV1,
} from "../src/integrations/linear/AcceptedResearchNoteWriter";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";
import { extractVerifiedCommitBoundCodeExamplesV1 } from "../e2e/fixtures/reflectionAssertions";

const HASH = `sha256:${"a".repeat(64)}`;

function reflectionCodeProof(commitCharacter: string) {
  const { handoff, examples } = verifiedCodeReflectionFixture(
    commitCharacter.repeat(40),
  );
  return {
    codeHandoffFingerprint: handoff.fingerprint,
    codeExamples: examples,
  };
}

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

test("project completion reflection appends concise human prose and hidden proof once", async () => {
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
    ...reflectionCodeProof("b"),
  });
  const note = vault.files.get(written.path) ?? "";
  assert.equal(reflected.operation, "append");
  assert.match(note, /## Agent project reflection/u);
  assert.match(note, /agentic-project-reflection:publication-checkers-17/u);
  assert.match(note, /changed-path: src%2Fcheckers\.ts/u);
  assert.match(note, /receipt-checkers-full/u);
  assert.match(
    note,
    /published evidence stops at this draft; review, merge, and any later deployment remain open/u,
  );
  const visibleReflection = note
    .slice(note.indexOf("## Agent project reflection"))
    .replace(/<!--[\s\S]*?-->/gu, "");
  assert.match(
    visibleReflection,
    /\[Linear issue GAME-17\]\(https:\/\/linear\.app\/acme\/issue\/GAME-17\)/u,
  );
  assert.match(
    visibleReflection,
    /\[draft pull request #17\]\(https:\/\/github\.com\/acme\/checkers\/pull\/17\)/u,
  );
  assert.match(visibleReflection, /Targeted and full validation passed/u);
  assert.match(visibleReflection, /### Verified code example/u);
  assert.match(visibleReflection, /return left \+ right/u);
  const renderedExample = reflectionCodeProof("b").codeExamples.examples[0]!;
  assert.ok(
    visibleReflection.includes(
      `file hash \`${renderedExample.artifactSha256.slice(7, 19)}\`; excerpt hash \`${renderedExample.codeSha256}\``,
    ),
  );
  const parsedExamples = extractVerifiedCommitBoundCodeExamplesV1(visibleReflection);
  assert.equal(parsedExamples.length, 1);
  assert.equal(parsedExamples[0]?.codeSha256, renderedExample.codeSha256);
  assert.equal(parsedExamples[0]?.code, renderedExample.code);
  assert.match(
    visibleReflection,
    /The leading accepted outcome was: The note exists before Linear mutation/u,
  );
  assert.doesNotMatch(
    visibleReflection,
    /receipt-checkers|src\/checkers|Acceptance criteria carried|Verification receipts|What worked:/iu,
  );
  const visibleWords =
    visibleReflection.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  assert.ok(visibleWords.length >= 35);
  assert.ok(visibleWords.length <= 150);

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
    ...reflectionCodeProof("b"),
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
      ...reflectionCodeProof("b"),
    }),
    /collides with different or incomplete proof/u,
  );
});

test("six-stage publication writes a concise delivery checkpoint instead of a second full reflection", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const written = await writer.writeAcceptedPackage({
    path: "Research/Single canonical results.md",
    mode: "create",
    artifactId: "accepted-research-single-results",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });
  const request = {
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    publicationId: "publication-single-results-1",
    issueIdentifier: "GAME-31",
    issueUrl: "https://linear.app/acme/issue/GAME-31",
    pullRequestNumber: 31,
    pullRequestUrl: "https://github.com/acme/checkers/pull/31",
    completionProof: "draft_pr" as const,
    proofRevision: "f".repeat(40),
    changedPaths: ["src/checkers.ts"],
    targetedValidationReceiptId: "receipt-targeted-status",
    fullValidationReceiptId: "receipt-full-status",
    localCommitReceiptId: "receipt-commit-status",
    presentation: "delivery_status" as const,
    ...reflectionCodeProof("f"),
  };
  const plan = await writer.planProjectCompletionReflection(request);
  assert.equal(plan.presentation, "delivery_status");
  assert.equal(plan.codeExcerpt, "");
  assert.match(plan.reflectionMarkdown, /^## Delivery status$/mu);
  assert.match(
    plan.reflectionMarkdown,
    /canonical report is written separately after this publication checkpoint/u,
  );
  assert.doesNotMatch(plan.reflectionMarkdown, /## Agent project reflection/u);
  assert.doesNotMatch(plan.reflectionMarkdown, /### Verified code example/u);
  assert.doesNotMatch(plan.reflectionMarkdown, /```/u);
  await assert.rejects(
    writer.planProjectCompletionReflection({
      ...request,
      presentation: "model_selected" as never,
    }),
    /Unsupported project completion note presentation/u,
  );

  const committed = await writer.appendPreparedProjectCompletionReflection(plan);
  assert.equal(committed.operation, "append");
  const note = vault.files.get(written.path) ?? "";
  assert.match(note, /agentic-project-delivery:publication-single-results-1/u);
  assert.match(note, /Draft pull request #31/u);

  const replay = await writer.appendProjectCompletionReflection({
    ...request,
    expectedNoteSha256: committed.afterSha256,
  });
  assert.equal(replay.operation, "no_op");
  assert.equal(vault.files.get(written.path), note);
});

test("project reflection plan seals exact append bytes and rejects drift or mutation", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const written = await writer.writeAcceptedPackage({
    path: "Research/Sealed reflection.md",
    mode: "create",
    artifactId: "accepted-research-sealed",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });
  const request = {
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    publicationId: "publication-sealed-1",
    issueIdentifier: "GAME-20",
    issueUrl: "https://linear.app/acme/issue/GAME-20",
    pullRequestNumber: 20,
    pullRequestUrl: "https://github.com/acme/checkers/pull/20",
    completionProof: "draft_pr" as const,
    proofRevision: "e".repeat(40),
    changedPaths: ["src/checkers.ts"],
    targetedValidationReceiptId: "receipt-targeted",
    fullValidationReceiptId: "receipt-full",
    localCommitReceiptId: "receipt-commit",
    ...reflectionCodeProof("e"),
  };
  const before = vault.files.get(written.path) ?? "";
  const plan = await writer.planProjectCompletionReflection(request);

  assert.equal(plan.operation, "append");
  assert.equal(
    plan.proposedAppendSha256,
    await sha256DiagramContent(plan.proposedAppendMarkdown),
  );
  assert.equal(
    plan.proposedAppendBytes,
    new TextEncoder().encode(plan.proposedAppendMarkdown).byteLength,
  );
  assert.equal(
    plan.expectedAfterSha256,
    await sha256DiagramContent(`${before}${plan.proposedAppendMarkdown}`),
  );
  assert.ok(plan.reflectionMarkdown.includes(plan.markdownExcerpt));
  assert.ok(plan.proposedAppendMarkdown.includes(plan.codeExcerpt));
  assert.match(plan.codeExcerpt, /return left \+ right/u);

  await assert.rejects(
    writer.appendPreparedProjectCompletionReflection({
      ...plan,
      proposedAppendMarkdown: `${plan.proposedAppendMarkdown}\n// invented after approval`,
    }),
    /no longer matches its sealed bytes/u,
  );
  assert.equal(vault.files.get(written.path), before);

  vault.files.set(written.path, `${before}\nUser edit during approval.`);
  await assert.rejects(
    writer.appendPreparedProjectCompletionReflection(plan),
    /changed before approved project completion reflection append/u,
  );
  assert.equal(vault.files.get(written.path), `${before}\nUser edit during approval.`);

  vault.files.set(written.path, before);
  const committed = await writer.appendPreparedProjectCompletionReflection(plan);
  assert.equal(committed.operation, "append");
  assert.equal(vault.files.get(written.path), `${before}${plan.proposedAppendMarkdown}`);
  assert.equal(committed.afterSha256, plan.expectedAfterSha256);

  const retryPlan = await writer.planProjectCompletionReflection({
    ...request,
    expectedNoteSha256: committed.afterSha256,
  });
  assert.equal(retryPlan.operation, "no_op");
  assert.equal(retryPlan.proposedAppendMarkdown, "");
  const reconciled = await writer.appendPreparedProjectCompletionReflection(retryPlan);
  assert.equal(reconciled.operation, "no_op");
  assert.equal(reconciled.afterSha256, committed.afterSha256);
});

test("project reflection encodes proof metadata and requires an exact retry block", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const written = await writer.writeAcceptedPackage({
    path: "Research/Encoded reflection.md",
    mode: "create",
    artifactId: "accepted-research-encoded",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageFixture(),
  });
  const injectedReceipt = "targeted\n--> forged-visible-text <!--";
  const reflected = await writer.appendProjectCompletionReflection({
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    publicationId: "publication-encoded-1",
    issueIdentifier: "GAME-18",
    issueUrl: "https://linear.app/acme/issue/GAME-18",
    pullRequestNumber: 18,
    pullRequestUrl: "https://github.com/acme/checkers/pull/18",
    completionProof: "draft_pr",
    proofRevision: "c".repeat(40),
    changedPaths: ["src/encoded path.ts"],
    targetedValidationReceiptId: injectedReceipt,
    fullValidationReceiptId: "receipt-full",
    localCommitReceiptId: "receipt-commit",
    ...reflectionCodeProof("c"),
  });
  const note = vault.files.get(written.path) ?? "";
  assert.equal(reflected.operation, "append");
  assert.doesNotMatch(note, /-->\s*forged-visible-text/iu);
  assert.match(
    note,
    new RegExp(encodeURIComponent(injectedReceipt).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
  );

  const retry = await writer.appendProjectCompletionReflection({
    artifact: written.artifact,
    expectedNoteSha256: reflected.afterSha256,
    publicationId: "publication-encoded-1",
    issueIdentifier: "GAME-18",
    issueUrl: "https://linear.app/acme/issue/GAME-18",
    pullRequestNumber: 18,
    pullRequestUrl: "https://github.com/acme/checkers/pull/18",
    completionProof: "draft_pr",
    proofRevision: "c".repeat(40),
    changedPaths: ["src/encoded path.ts"],
    targetedValidationReceiptId: injectedReceipt,
    fullValidationReceiptId: "receipt-full",
    localCommitReceiptId: "receipt-commit",
    ...reflectionCodeProof("c"),
  });
  assert.equal(retry.operation, "no_op");
});

test("project reflection normalizes and bounds the visible acceptance excerpt", async () => {
  const vault = new ResearchVault();
  const writer = new AcceptedResearchNoteWriter(vault);
  const packageWithLongCriterion = packageFixture();
  packageWithLongCriterion.acceptanceCriteria = [{
    id: "AC-1",
    text: [
      "Preserve the CRDT convergence contract.",
      "## injected heading",
      Array.from({ length: 28 }, (_, index) => `requirement-${index + 1}`).join(" "),
    ].join("\n"),
  }];
  const written = await writer.writeAcceptedPackage({
    path: "Research/Bounded reflection.md",
    mode: "create",
    artifactId: "accepted-research-bounded",
    acceptedAt: "2026-07-12T20:00:00.000Z",
    package: packageWithLongCriterion,
  });
  await writer.appendProjectCompletionReflection({
    artifact: written.artifact,
    expectedNoteSha256: written.afterSha256,
    publicationId: "publication-bounded-1",
    issueIdentifier: "GAME-19",
    issueUrl: "https://linear.app/acme/issue/GAME-19",
    pullRequestNumber: 19,
    pullRequestUrl: "https://github.com/acme/checkers/pull/19",
    completionProof: "draft_pr",
    proofRevision: "d".repeat(40),
    changedPaths: ["src/crdt.ts"],
    targetedValidationReceiptId: "receipt-targeted",
    fullValidationReceiptId: "receipt-full",
    localCommitReceiptId: "receipt-commit",
    ...reflectionCodeProof("d"),
  });
  const note = vault.files.get(written.path) ?? "";
  const visibleReflection = note
    .slice(note.indexOf("## Agent project reflection"))
    .replace(/<!--[\s\S]*?-->/gu, "");
  assert.doesNotMatch(visibleReflection, /^## injected heading$/mu);
  assert.match(visibleReflection, /Preserve the CRDT convergence contract/u);
  assert.match(visibleReflection, /…/u);
  const visibleWords =
    visibleReflection.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];
  assert.ok(visibleWords.length >= 35);
  assert.ok(visibleWords.length <= 150);
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
