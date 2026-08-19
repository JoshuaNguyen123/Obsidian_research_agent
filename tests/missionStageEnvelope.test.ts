import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEnvelopeAllowsBoundExecute,
  consumeEnvelopeMutation,
  createMissionStageEnvelope,
  ensureMissionStageEnvelope,
  envelopeAllowsTool,
  envelopeMatchesPreparedAction,
  isEnvelopeCreateMutation,
  lifecycleStageForEnvelopeTool,
  MISSION_STAGE_ENVELOPE_BLOCKER_CODES,
  toolsAllowedForEnvelopeStage,
} from "../src/agent/missionStageEnvelope";
import { CODE_VALIDATION_TOOL_ALLOW } from "../src/agent/lifecycleStagePolicy";

test("mission stage envelope create match consume and tool allow", () => {
  const envelope = createMissionStageEnvelope({
    runId: "run-1",
    stage: "linear_hierarchy",
    authorityFingerprint: "sha256:" + "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxMutations: 2,
    maxCreates: 1,
  });
  assert.equal(
    envelopeMatchesPreparedAction(envelope, {
      runId: "run-1",
      authorityFingerprint: envelope.authorityFingerprint,
    }),
    true,
  );
  assert.equal(envelopeAllowsTool(envelope, "linear_get_issue"), true);
  assert.equal(envelopeAllowsTool(envelope, "web_search"), false);
  const next = consumeEnvelopeMutation(envelope, { isCreate: true });
  assert.equal("exhausted" in next, false);
  if ("exhausted" in next) return;
  assert.equal(next.mutationsUsed, 1);
  assert.equal(next.createsUsed, 1);
  const exhausted = consumeEnvelopeMutation(next, { isCreate: true });
  assert.deepEqual(exhausted, { exhausted: true });
});

test("ensureMissionStageEnvelope refreshes on stage or fingerprint change and keeps counters otherwise", () => {
  const first = createMissionStageEnvelope({
    runId: "run-2",
    stage: "code_validation",
    authorityFingerprint: "sha256:" + "b".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxMutations: 4,
    grantId: "grant-a",
  });
  const afterUse = consumeEnvelopeMutation(first);
  assert.equal("exhausted" in afterUse, false);
  if ("exhausted" in afterUse) return;

  const same = ensureMissionStageEnvelope({
    existing: afterUse,
    runId: "run-2",
    stage: "code_validation",
    authorityFingerprint: afterUse.authorityFingerprint,
    expiresAt: afterUse.budget.expiresAt,
    grantId: "grant-a",
  });
  assert.equal(same.mutationsUsed, 1);

  const stageChange = ensureMissionStageEnvelope({
    existing: afterUse,
    runId: "run-2",
    stage: "private_github_publication",
    authorityFingerprint: afterUse.authorityFingerprint,
    expiresAt: afterUse.budget.expiresAt,
  });
  assert.equal(stageChange.stage, "private_github_publication");
  assert.equal(stageChange.mutationsUsed, 0);

  const fingerprintChange = ensureMissionStageEnvelope({
    existing: afterUse,
    runId: "run-2",
    stage: "code_execution",
    authorityFingerprint: "sha256:" + "c".repeat(64),
    expiresAt: afterUse.budget.expiresAt,
  });
  assert.equal(fingerprintChange.mutationsUsed, 0);
  assert.equal(
    fingerprintChange.authorityFingerprint,
    "sha256:" + "c".repeat(64),
  );
});

test("assertEnvelopeAllowsBoundExecute fails closed on mismatch expiry and budget", () => {
  const fingerprint = "sha256:" + "d".repeat(64);
  const envelope = createMissionStageEnvelope({
    runId: "run-3",
    stage: "code_validation",
    authorityFingerprint: fingerprint,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxMutations: 1,
  });

  assert.deepEqual(
    assertEnvelopeAllowsBoundExecute({
      envelope,
      toolName: "code_commit_verified",
      runId: "run-3",
      authorityFingerprint: fingerprint,
    }),
    { ok: true },
  );

  const mismatch = assertEnvelopeAllowsBoundExecute({
    envelope,
    toolName: "code_commit_verified",
    runId: "run-3",
    authorityFingerprint: "sha256:" + "e".repeat(64),
  });
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.equal(
    mismatch.code,
    MISSION_STAGE_ENVELOPE_BLOCKER_CODES.fingerprintMismatch,
  );
  assert.match(mismatch.message, /resumable/i);

  const expired = createMissionStageEnvelope({
    runId: "run-3",
    stage: "code_validation",
    authorityFingerprint: fingerprint,
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const expiredGate = assertEnvelopeAllowsBoundExecute({
    envelope: expired,
    toolName: "code_commit_verified",
    runId: "run-3",
    authorityFingerprint: fingerprint,
  });
  assert.equal(expiredGate.ok, false);
  if (expiredGate.ok) return;
  assert.equal(expiredGate.code, MISSION_STAGE_ENVELOPE_BLOCKER_CODES.expired);

  const spent = {
    ...envelope,
    mutationsUsed: envelope.budget.maxMutations,
  };
  const budgetGate = assertEnvelopeAllowsBoundExecute({
    envelope: spent,
    toolName: "code_commit_verified",
    runId: "run-3",
    authorityFingerprint: fingerprint,
  });
  assert.equal(budgetGate.ok, false);
  if (budgetGate.ok) return;
  assert.equal(
    budgetGate.code,
    MISSION_STAGE_ENVELOPE_BLOCKER_CODES.budgetExhausted,
  );

  const denied = assertEnvelopeAllowsBoundExecute({
    envelope,
    toolName: "web_search",
    runId: "run-3",
    authorityFingerprint: fingerprint,
  });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.code, MISSION_STAGE_ENVELOPE_BLOCKER_CODES.toolDenied);
});

test("code_validation envelope allows repair, validation, commit, and note companions", () => {
  const envelope = createMissionStageEnvelope({
    runId: "run-code-allow",
    stage: "code_validation",
    authorityFingerprint: "sha256:" + "f".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const allowed = toolsAllowedForEnvelopeStage("code_validation");
  for (const tool of [
    "code_validate_fast",
    "code_validate_targeted",
    "code_validate_full",
    "code_repair_record_cycle",
    "code_repair_status",
    "code_commit_verified",
  ] as const) {
    assert.ok(allowed.includes(tool), `envelope allow missing ${tool}`);
    assert.equal(envelopeAllowsTool(envelope, tool), true);
  }
  for (const tool of CODE_VALIDATION_TOOL_ALLOW) {
    assert.ok(allowed.includes(tool), `envelope diverged from CODE_VALIDATION_TOOL_ALLOW at ${tool}`);
  }
});

test("lifecycleStageForEnvelopeTool and isEnvelopeCreateMutation classify Bound stage tools", () => {
  assert.equal(
    lifecycleStageForEnvelopeTool("code_workspace_create_file"),
    "code_execution",
  );
  assert.equal(
    lifecycleStageForEnvelopeTool("publish_research_project_to_linear"),
    "linear_hierarchy",
  );
  assert.equal(lifecycleStageForEnvelopeTool("not_a_tool"), null);
  assert.equal(isEnvelopeCreateMutation("code_workspace_create_file"), true);
  assert.equal(isEnvelopeCreateMutation("code_commit_verified"), false);
  assert.equal(isEnvelopeCreateMutation("github_create_private_repository"), true);
  assert.equal(
    lifecycleStageForEnvelopeTool("github_create_repository"),
    "private_github_publication",
  );
});

test("GitHub catalog envelope maps reads and safe mutations to publication while delete stays cleanup hard", () => {
  const githubEnvelope = createMissionStageEnvelope({
    runId: "run-github-catalog",
    stage: "private_github_publication",
    authorityFingerprint: "sha256:" + "9".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const cleanupEnvelope = createMissionStageEnvelope({
    runId: "run-github-cleanup",
    stage: "reconciliation_cleanup",
    authorityFingerprint: "sha256:" + "8".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(
    lifecycleStageForEnvelopeTool("github_get_issue"),
    "private_github_publication",
  );
  assert.equal(
    lifecycleStageForEnvelopeTool("github_update_issue"),
    "private_github_publication",
  );
  assert.equal(envelopeAllowsTool(githubEnvelope, "github_get_issue"), true);
  assert.equal(envelopeAllowsTool(githubEnvelope, "github_update_issue"), true);

  assert.equal(
    lifecycleStageForEnvelopeTool("github_delete_owned_comment"),
    "reconciliation_cleanup",
  );
  assert.equal(
    lifecycleStageForEnvelopeTool("github_delete_owned_branch"),
    "reconciliation_cleanup",
  );
  assert.equal(
    envelopeAllowsTool(cleanupEnvelope, "github_delete_owned_comment"),
    false,
    "Hard GitHub delete still requires separate exact destructive authority",
  );
});
