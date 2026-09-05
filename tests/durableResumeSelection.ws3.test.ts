import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDurableMissionRetryState,
  createDurableMissionLease,
  createDurableMissionManifest,
  DURABLE_MISSION_MAX_MODEL_STEPS,
  DURABLE_MISSION_MAX_SEGMENTS,
  DURABLE_MISSION_MAX_TOOL_CALLS,
  DURABLE_MISSION_MAX_TRANSIENT_FAILURES,
  getDurableMissionRecoverability,
  type DurableMissionManifestV1,
  type DurableMissionRecoveryBlockReason,
} from "../src/agent/durableMission";
import { classifyDurableResumeScanCandidate } from "../src/agent/durableResumeSelection";

const NOW = new Date("2026-07-10T12:00:00.000Z");

const CLASSIFIER_REASONS: readonly (
  | DurableMissionRecoveryBlockReason
  | "status_not_scanned"
  | "recoverable"
)[] = [
  "status_not_scanned",
  "recoverable",
  "deadline_elapsed",
  "segment_budget_exhausted",
  "model_step_budget_exhausted",
  "tool_call_budget_exhausted",
  "terminal_status",
  "blocked_status",
  "approval_required",
  "unsafe_reconciliation",
  "live_lease",
  "retry_exhausted",
  "backoff_pending",
  "status_not_recoverable",
];

test("durable resume classifier decision table covers every handled reason", () => {
  const rows: Array<{
    reason: (typeof CLASSIFIER_REASONS)[number];
    manifest: DurableMissionManifestV1;
    expectedType: "resume" | "skip" | "wait" | "terminalize";
    expectedCode?: string;
  }> = [
    {
      reason: "status_not_scanned",
      manifest: finished("complete"),
      expectedType: "skip",
    },
    {
      reason: "recoverable",
      manifest: unfinished(),
      expectedType: "resume",
    },
    {
      reason: "deadline_elapsed",
      manifest: withDeadlineElapsed(unfinished()),
      expectedType: "terminalize",
      expectedCode: "deadline_reached",
    },
    {
      reason: "segment_budget_exhausted",
      manifest: withUsage(unfinished(), { segments: DURABLE_MISSION_MAX_SEGMENTS }),
      expectedType: "terminalize",
      expectedCode: "segment_budget_exhausted",
    },
    {
      reason: "model_step_budget_exhausted",
      manifest: withUsage(unfinished(), {
        modelSteps: DURABLE_MISSION_MAX_MODEL_STEPS,
      }),
      expectedType: "terminalize",
      expectedCode: "model_step_budget_exhausted",
    },
    {
      reason: "tool_call_budget_exhausted",
      manifest: withUsage(unfinished(), {
        toolCalls: DURABLE_MISSION_MAX_TOOL_CALLS,
      }),
      expectedType: "terminalize",
      expectedCode: "tool_call_budget_exhausted",
    },
    {
      reason: "terminal_status",
      manifest: finished("cancelled"),
      expectedType: "skip",
    },
    {
      reason: "blocked_status",
      manifest: finished("blocked"),
      expectedType: "skip",
    },
    {
      reason: "approval_required",
      manifest: withApproval(unfinished()),
      expectedType: "skip",
    },
    {
      reason: "unsafe_reconciliation",
      manifest: withUnsafeReconciliation(unfinished()),
      expectedType: "skip",
    },
    {
      reason: "live_lease",
      manifest: withLiveLease(unfinished()),
      expectedType: "wait",
    },
    {
      reason: "retry_exhausted",
      manifest: withRetryExhausted(unfinished()),
      expectedType: "terminalize",
      expectedCode: "transient_failure_limit",
    },
    {
      reason: "backoff_pending",
      manifest: withBackoff(unfinished()),
      expectedType: "wait",
    },
    {
      reason: "status_not_recoverable",
      manifest: finished("paused_for_approval"),
      expectedType: "skip",
    },
  ];

  assert.deepEqual(
    rows.map((row) => row.reason).sort(),
    [...CLASSIFIER_REASONS].sort(),
  );

  for (const row of rows) {
    const recoverability = getDurableMissionRecoverability(row.manifest, NOW);
    if (row.reason !== "status_not_scanned" && row.reason !== "recoverable") {
      if (
        row.reason !== "terminal_status" &&
        row.reason !== "blocked_status" &&
        row.reason !== "status_not_recoverable"
      ) {
        assert.equal(
          recoverability.reason,
          row.reason,
          `${row.reason} should be the recoverability reason`,
        );
      }
    }
    const decision = classifyDurableResumeScanCandidate(row.manifest, NOW);
    assert.equal(
      decision.type,
      row.expectedType,
      `${row.reason} should classify as ${row.expectedType}`,
    );
    if (row.expectedCode && decision.type === "terminalize") {
      assert.equal(decision.code, row.expectedCode);
    }
  }
});

test("aggregate-exhausted missions cannot mint fresh budgets on resume", () => {
  for (const usage of [
    { segments: DURABLE_MISSION_MAX_SEGMENTS },
    { modelSteps: DURABLE_MISSION_MAX_MODEL_STEPS },
    { toolCalls: DURABLE_MISSION_MAX_TOOL_CALLS },
  ]) {
    const decision = classifyDurableResumeScanCandidate(
      withUsage(unfinished(), usage),
      NOW,
    );
    assert.equal(decision.type, "terminalize", JSON.stringify(usage));
  }
  const segmentStopped = withUsage(unfinished(), { segments: 1, modelSteps: 10, toolCalls: 20 });
  assert.equal(classifyDurableResumeScanCandidate(segmentStopped, NOW).type, "resume");
});

function unfinished(): DurableMissionManifestV1 {
  const manifest = createDurableMissionManifest({
    missionId: "resume-candidate",
    prompt: "Continue the unfinished research note.",
    createdAt: NOW,
  });
  manifest.status = "interrupted";
  return manifest;
}

function finished(
  status: DurableMissionManifestV1["status"],
): DurableMissionManifestV1 {
  const manifest = createDurableMissionManifest({
    missionId: `finished-${status}`,
    prompt: "Already done.",
    createdAt: NOW,
    status,
  });
  manifest.status = status;
  return manifest;
}

function withUsage(
  manifest: DurableMissionManifestV1,
  usage: Partial<DurableMissionManifestV1["usage"]>,
): DurableMissionManifestV1 {
  manifest.usage = { ...manifest.usage, ...usage };
  return manifest;
}

function withDeadlineElapsed(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  manifest.deadlineAt = "2026-07-10T11:00:00.000Z";
  return manifest;
}

function withApproval(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  manifest.status = "running";
  manifest.pendingApproval = {
    id: "approval-1",
    summary: "Approve the next write",
    requestedAt: NOW.toISOString(),
  };
  return manifest;
}

function withUnsafeReconciliation(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  manifest.reconciliation = {
    status: "required",
    operationIds: ["op-1"],
    message: "WAL reconcile required",
  };
  return manifest;
}

function withLiveLease(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  manifest.status = "running";
  manifest.lease = createDurableMissionLease({
    ownerId: "other-window",
    now: NOW,
    durationMs: 30_000,
  });
  return manifest;
}

function withRetryExhausted(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  let retry = manifest.retry;
  for (let i = 0; i < DURABLE_MISSION_MAX_TRANSIENT_FAILURES; i += 1) {
    retry = advanceDurableMissionRetryState(retry, { now: NOW });
  }
  manifest.retry = retry;
  return manifest;
}

function withBackoff(
  manifest: DurableMissionManifestV1,
): DurableMissionManifestV1 {
  manifest.status = "backing_off";
  manifest.retry = {
    consecutiveFailures: 1,
    nextAttemptAt: "2026-07-10T12:05:00.000Z",
  };
  return manifest;
}
