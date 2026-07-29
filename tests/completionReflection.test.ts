import test from "node:test";
import assert from "node:assert/strict";
import {
  planCompoundCompletionReflection,
  reflectMissionCompletion,
} from "../src/agent/completionReflection";
import { findRawReceiptDumpInReflectionMarkdown } from "../src/agent/initiatingNoteReflection";
import {
  buildPipelineLineageV1,
  buildReflectionContextV1,
} from "../src/agent/pipelineLineage";
import { computeProofDebt } from "../src/agent/proofDebt";
import type { ProjectLineageV1 } from "../src/agent/projectLifecycle";

const fp = (char: string) => `sha256:${char.repeat(64)}`;

function compoundLineage(): ProjectLineageV1 {
  const commitSha = "b".repeat(40);
  return {
    schemaVersion: 1,
    kind: "project_lineage",
    lineageId: "lineage-compound",
    runId: "run-compound",
    vaultBindingKey: "vault",
    updatedAt: "2026-07-22T00:04:00.000Z",
    fingerprint: fp("9"),
    commits: [
      {
        stage: "accepted_research",
        committedAt: "2026-07-22T00:00:00.000Z",
        proofFingerprint: fp("1"),
        proof: {
          stage: "accepted_research",
          artifactFingerprint: fp("2"),
          notePath: "Projects/Initiating.md",
          noteSha256: fp("3"),
          researcherHandoffFingerprint: fp("4"),
        },
      },
      {
        stage: "linear_hierarchy",
        committedAt: "2026-07-22T00:01:00.000Z",
        proofFingerprint: fp("5"),
        proof: {
          stage: "linear_hierarchy",
          planFingerprint: fp("6"),
          workspaceId: "ws",
          teamId: "team",
          initiativeId: "initiative",
          projectId: "project",
          issueIds: ["ISSUE-1"],
          workItemFingerprints: [fp("7")],
          providerReadbackFingerprints: [fp("8")],
        },
      },
      {
        stage: "code_execution",
        committedAt: "2026-07-22T00:02:00.000Z",
        proofFingerprint: fp("a"),
        proof: {
          stage: "code_execution",
          repositoryProfileKey: "profile",
          repositoryProfileFingerprint: fp("b"),
          workspaceId: "code-ws",
          validationReceiptFingerprints: [fp("c")],
          diffFingerprint: fp("e"),
          targetedValidationPassed: true,
          freshFullValidationPassed: true,
          commitSha,
          commitReadbackFingerprint: fp("f"),
        },
      },
      {
        stage: "private_github_publication",
        committedAt: "2026-07-22T00:03:00.000Z",
        proofFingerprint: fp("0"),
        proof: {
          stage: "private_github_publication",
          trustedBindingFingerprint: fp("1"),
          owner: "acme",
          repository: "demo",
          verifiedPrivate: true,
          branch: "codex/demo",
          pullRequestNumber: 3,
          draft: true,
          remoteSha: commitSha,
          repositoryReadbackFingerprint: fp("2"),
          pullRequestReadbackFingerprint: fp("3"),
        },
      },
    ],
  };
}

test("reflectMissionCompletion is done only when acceptance and proof are clear", () => {
  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const done = reflectMissionCompletion({
    prompt: "Deep research on batteries",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 1,
  });
  assert.equal(done.done, true);
  assert.equal(done.remainingActions.length, 0);
  assert.ok(done.confidence >= 0.9);
});

test("reflectMissionCompletion stays open for unpaid debt, WAL, conflicts, or write goals", () => {
  const unpaid = computeProofDebt({
    status: "budget",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
  });
  const unpaidReflection = reflectMissionCompletion({
    prompt: "Deep research",
    acceptance: {
      status: "needs_more_work",
      missing: ["web_evidence", "fetched_sources"],
    },
    proofDebt: unpaid,
    writeReceiptCount: 0,
  });
  assert.equal(unpaidReflection.done, false);
  assert.ok(unpaidReflection.remainingActions.length > 0);

  const walDebt = computeProofDebt({
    status: "blocked",
    acceptance: { status: "pass", missing: [] },
    operationJournal: [
      { state: "reconcile_required", operationId: "op-1", toolName: "append_to_current_file" },
    ],
  });
  const walReflection = reflectMissionCompletion({
    prompt: "Write note",
    acceptance: { status: "pass", missing: [] },
    proofDebt: walDebt,
    writeReceiptCount: 1,
  });
  assert.equal(walReflection.done, false);
  assert.match(walReflection.reason, /wal_reconcile/);

  const conflictDebt = computeProofDebt({
    status: "paused",
    acceptance: { status: "pass", missing: [] },
    openConflicts: [
      { id: "c1", status: "open", summary: "A vs B" },
    ],
  });
  const conflictReflection = reflectMissionCompletion({
    prompt: "Research",
    acceptance: { status: "pass", missing: [] },
    proofDebt: conflictDebt,
    writeReceiptCount: 1,
  });
  assert.equal(conflictReflection.done, false);
  assert.match(conflictReflection.reason, /conflict/);

  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const pendingWrite = reflectMissionCompletion({
    prompt: "Append summary",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 0,
    pendingGoalIds: ["append_current_note"],
  });
  assert.equal(pendingWrite.done, false);
  assert.match(pendingWrite.reason, /pending_write/);
});

test("planCompoundCompletionReflection bundles note write plan from lineage cites", () => {
  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const pipeline = buildPipelineLineageV1({
    lineage: compoundLineage(),
    reflection: { state: "missing" },
  });
  const context = buildReflectionContextV1({
    runId: "run-compound",
    ledger: null,
    pipeline,
    persistence: "missing",
  });
  const planned = planCompoundCompletionReflection({
    prompt: "Finish the compound pipeline and reflect on the initiating note.",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 1,
    reflectionContext: context,
    initiatingNotePath: "Projects/Initiating.md",
    linearIssueUrls: ["https://linear.app/acme/issue/ISSUE-1"],
  });

  assert.equal(planned.completion.done, true);
  assert.equal(planned.initiatingNote.shouldWriteNote, true);
  assert.match(
    planned.initiatingNote.markdown,
    /https:\/\/linear\.app\/acme\/issue\/ISSUE-1/u,
  );
  assert.match(
    planned.initiatingNote.markdown,
    /https:\/\/github\.com\/acme\/demo\/pull\/3/u,
  );
  assert.equal(
    findRawReceiptDumpInReflectionMarkdown(planned.initiatingNote.markdown),
    null,
  );
});

test("planCompoundCompletionReflection never writes a completion note while proof is open", () => {
  const openDebt = computeProofDebt({
    status: "budget",
    acceptance: {
      status: "needs_more_work",
      missing: ["full_validation"],
    },
  });
  const pipeline = buildPipelineLineageV1({ lineage: compoundLineage() });
  const context = buildReflectionContextV1({
    runId: "run-compound",
    ledger: null,
    pipeline,
    persistence: "missing",
  });
  const planned = planCompoundCompletionReflection({
    prompt: "Finish the compound pipeline and reflect on the initiating note.",
    acceptance: {
      status: "needs_more_work",
      missing: ["full_validation"],
    },
    proofDebt: openDebt,
    writeReceiptCount: 1,
    reflectionContext: context,
    initiatingNotePath: "Projects/Initiating.md",
    linearIssueUrls: ["https://linear.app/acme/issue/ISSUE-1"],
  });

  assert.equal(planned.completion.done, false);
  assert.equal(planned.initiatingNote.shouldWriteNote, false);
  assert.equal(planned.initiatingNote.markdown, "");
  assert.equal(planned.initiatingNote.chatSummary, "");
  assert.deepEqual(planned.initiatingNote.destination, {
    kind: "chat_only",
    reason: "completion_incomplete",
  });
});

test("planCompoundCompletionReflection keeps Chat-only when explicitly selected", () => {
  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const pipeline = buildPipelineLineageV1({ lineage: compoundLineage() });
  const context = buildReflectionContextV1({
    runId: "run-compound",
    ledger: null,
    pipeline,
    persistence: "chat_only_not_persisted",
  });
  const planned = planCompoundCompletionReflection({
    prompt: "Chat only summary of the pipeline.",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 0,
    reflectionContext: context,
    initiatingNotePath: "Projects/Initiating.md",
    chatOnlyOverride: true,
  });

  assert.equal(planned.initiatingNote.shouldWriteNote, false);
  assert.equal(planned.initiatingNote.markdown, "");
  assert.match(planned.initiatingNote.chatSummary, /PR #3|pull\/3/u);
});

test("planCompoundCompletionReflection never writes an unsolicited reflection", () => {
  const emptyDebt = computeProofDebt({
    status: "complete",
    acceptance: { status: "pass", missing: [] },
  });
  const pipeline = buildPipelineLineageV1({ lineage: compoundLineage() });
  const context = buildReflectionContextV1({
    runId: "run-phase-a",
    ledger: null,
    pipeline,
    persistence: "not_requested",
  });
  const planned = planCompoundCompletionReflection({
    prompt: "Publish the accepted research to Linear.",
    acceptance: { status: "pass", missing: [] },
    proofDebt: emptyDebt,
    writeReceiptCount: 1,
    reflectionContext: context,
    initiatingNotePath: "Projects/Initiating.md",
    persistence: "not_requested",
  });

  assert.equal(planned.completion.done, true);
  assert.equal(planned.initiatingNote.shouldWriteNote, false);
  assert.equal(planned.initiatingNote.markdown, "");
  assert.deepEqual(planned.initiatingNote.destination, {
    kind: "chat_only",
    reason: "reflection_not_requested",
  });
});
