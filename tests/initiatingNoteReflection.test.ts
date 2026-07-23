import assert from "node:assert/strict";
import test from "node:test";

import {
  appendInitiatingNoteReflectionMarkdown,
  buildInitiatingNoteReflectionV1,
  findRawReceiptDumpInReflectionMarkdown,
  shouldSuppressInitiatingNoteReflection,
} from "../src/agent/initiatingNoteReflection";
import {
  buildPipelineLineageV1,
  buildReflectionContextV1,
} from "../src/agent/pipelineLineage";
import type { ProjectLineageV1 } from "../src/agent/projectLifecycle";
import type { MissionLedger } from "../src/agent/missionLedger";

const fp = (char: string) => `sha256:${char.repeat(64)}`;

function verifiedLineage(): ProjectLineageV1 {
  const commitSha = "a".repeat(40);
  return {
    schemaVersion: 1,
    kind: "project_lineage",
    lineageId: "lineage-1",
    runId: "run-1",
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
          notePath: "Research/Source.md",
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
          workspaceId: "linear-workspace",
          teamId: "team",
          initiativeId: "initiative",
          projectId: "project",
          issueIds: ["issue-abc"],
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
          repositoryProfileKey: "profile-safe",
          repositoryProfileFingerprint: fp("b"),
          workspaceId: "workspace-safe",
          validationReceiptFingerprints: [fp("c"), fp("d")],
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
          owner: "owner",
          repository: "repo",
          verifiedPrivate: true,
          branch: "codex/work",
          pullRequestNumber: 12,
          draft: true,
          remoteSha: commitSha,
          repositoryReadbackFingerprint: fp("2"),
          pullRequestReadbackFingerprint: fp("3"),
        },
      },
    ],
  };
}

function ledgerWithReceipts(): MissionLedger {
  return {
    schemaVersion: 2,
    revision: 1,
    runId: "run-1",
    mission: "compound",
    route: "grounded_workflow",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:04:00.000Z",
    status: "complete",
    loopBudget: {
      hardCap: 40,
      toolStepBudget: 20,
      finalizationReserve: 4,
      expectedTools: [],
    },
    tasks: [],
    milestones: [
      {
        id: "m1",
        missionId: "run-1",
        step: 1,
        stage: "write_save",
        summary: "Created https://linear.app/acme/issue/ABC-1",
        createdAt: "2026-07-22T00:01:00.000Z",
      },
    ],
    evidence: [],
    receipts: ["receipt:linear-1", "receipt:validate-targeted", fp("c")],
    blockers: [],
    dependencyStatus: [],
    approvals: [],
    nextActions: [],
    remainingActions: [],
    iterationCount: 1,
    progressScore: 1,
    stalledCount: 0,
    resumeCount: 0,
    lastSafeStep: 4,
    continuationCommand: "continue",
  };
}

test("note path cites Linear, commit, PR, and validation without receipt dumps", () => {
  const pipeline = buildPipelineLineageV1({
    lineage: verifiedLineage(),
    reflection: {
      state: "verified",
      path: "Research/Source.md",
      contentHash: fp("4"),
    },
  });
  const context = buildReflectionContextV1({
    runId: "run-1",
    ledger: ledgerWithReceipts(),
    pipeline,
    persistence: "verified",
  });
  assert.ok(context.receiptIds.length > 0);

  const plan = buildInitiatingNoteReflectionV1({
    runId: "run-1",
    context,
    pipeline,
    initiatingNotePath: "Research/Source.md",
    linearIssueUrls: ["https://linear.app/acme/issue/ABC-1"],
  });

  assert.equal(plan.shouldWriteNote, true);
  assert.equal(plan.destination.kind, "initiating_note");
  assert.match(plan.markdown, /Linear issue: https:\/\/linear\.app\/acme\/issue\/ABC-1/u);
  assert.match(plan.markdown, /Validation: targeted and full checks passed/u);
  assert.match(plan.markdown, new RegExp(`Commit: \`${"a".repeat(40)}\``, "u"));
  assert.match(
    plan.markdown,
    /Draft PR: \[#12\]\(https:\/\/github\.com\/owner\/repo\/pull\/12\)/u,
  );
  assert.match(plan.markdown, /Repository: https:\/\/github\.com\/owner\/repo/u);
  assert.equal(findRawReceiptDumpInReflectionMarkdown(plan.markdown), null);
  assert.ok(!plan.markdown.includes("receipt:linear-1"));
  assert.ok(!plan.markdown.includes(fp("c")));
  assert.ok(!plan.markdown.includes("receiptFingerprints"));
  assert.deepEqual(plan.cites.linearIssueIds, ["issue-abc"]);
  assert.equal(plan.cites.commitSha, "a".repeat(40));
  assert.equal(plan.cites.pullRequestNumber, 12);
});

test("explicit Chat-only skips note write but still returns chat summary cites", () => {
  const pipeline = buildPipelineLineageV1({ lineage: verifiedLineage() });
  const plan = buildInitiatingNoteReflectionV1({
    runId: "run-chat",
    pipeline,
    initiatingNotePath: "Research/Source.md",
    prompt: "Answer in chat only — do not write to the note.",
    linearIssueUrls: ["https://linear.app/acme/issue/ABC-9"],
  });

  assert.equal(shouldSuppressInitiatingNoteReflection({
    prompt: "Answer in chat only — do not write to the note.",
    initiatingNotePath: "Research/Source.md",
  }), true);
  assert.equal(plan.shouldWriteNote, false);
  assert.equal(plan.destination.kind, "chat_only");
  assert.equal(plan.markdown, "");
  assert.match(plan.chatSummary, /linear\.app\/acme\/issue\/ABC-9/u);
  assert.match(plan.chatSummary, /Validation: targeted and full/u);
  assert.match(plan.chatSummary, /github\.com\/owner\/repo/u);
});

test("forceChatOnly and persistence chat_only_not_persisted suppress note write", () => {
  const pipeline = buildPipelineLineageV1({ lineage: verifiedLineage() });
  const forced = buildInitiatingNoteReflectionV1({
    runId: "run-force",
    pipeline,
    initiatingNotePath: "Research/Source.md",
    forceChatOnly: true,
  });
  assert.equal(forced.shouldWriteNote, false);
  assert.equal(
    forced.destination.kind === "chat_only" && forced.destination.reason,
    "force_chat_only",
  );

  const persisted = buildInitiatingNoteReflectionV1({
    runId: "run-persist",
    pipeline,
    initiatingNotePath: "Research/Source.md",
    persistence: "chat_only_not_persisted",
  });
  assert.equal(persisted.shouldWriteNote, false);
  assert.equal(
    persisted.destination.kind === "chat_only" && persisted.destination.reason,
    "persistence_chat_only_not_persisted",
  );
});

test("append helper is marker-idempotent", () => {
  const pipeline = buildPipelineLineageV1({ lineage: verifiedLineage() });
  const plan = buildInitiatingNoteReflectionV1({
    runId: "run-1",
    pipeline,
    initiatingNotePath: "Research/Source.md",
  });
  const once = appendInitiatingNoteReflectionMarkdown("# Source\n\nBody.", plan);
  const twice = appendInitiatingNoteReflectionMarkdown(once, plan);
  assert.equal(once, twice);
  assert.equal(
    once.split("<!-- agentic-initiating-reflection:run-1 -->").length - 1,
    1,
  );
});
