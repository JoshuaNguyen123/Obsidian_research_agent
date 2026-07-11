import {
  getDurableMissionRecoverability,
  type DurableMissionManifestV1,
  type DurableMissionStatus,
} from "./durableMission";

const LIVE_LEASE_REPOLL_MS = 5_000;

export type DurableResumeScanDecision =
  | { type: "resume" }
  | { type: "skip"; reason: string }
  | { type: "wait"; reason: string; retryAt: string }
  | {
      type: "terminalize";
      status: DurableMissionStatus;
      code: string;
      message: string;
    };

export interface DurableResumeScanPlan {
  resume?: DurableMissionManifestV1;
  terminalize: Array<{
    manifest: DurableMissionManifestV1;
    decision: Extract<DurableResumeScanDecision, { type: "terminalize" }>;
  }>;
  wait?: { retryAt: string; reason: string };
}

/**
 * Scans newest-first without allowing a waiting lease/backoff to starve an
 * older safely recoverable mission. Expired/exhausted records encountered
 * before the selected mission are returned for terminal persistence.
 */
export function planDurableResumeScan(
  manifests: DurableMissionManifestV1[],
  now: Date = new Date(),
): DurableResumeScanPlan {
  const plan: DurableResumeScanPlan = { terminalize: [] };
  for (const manifest of manifests) {
    const decision = classifyDurableResumeScanCandidate(manifest, now);
    if (decision.type === "terminalize") {
      plan.terminalize.push({ manifest, decision });
      continue;
    }
    if (decision.type === "resume") {
      plan.resume = manifest;
      break;
    }
    if (decision.type === "wait") {
      const candidateMs = Date.parse(decision.retryAt);
      const currentMs = Date.parse(plan.wait?.retryAt ?? "");
      if (!plan.wait || !Number.isFinite(currentMs) || candidateMs < currentMs) {
        plan.wait = { retryAt: decision.retryAt, reason: decision.reason };
      }
    }
  }
  return plan;
}

/** Pure classification used by startup/manual resume scanning. */
export function classifyDurableResumeScanCandidate(
  manifest: DurableMissionManifestV1,
  now: Date = new Date(),
): DurableResumeScanDecision {
  if (!isUnfinishedResumeStatus(manifest.status)) {
    return { type: "skip", reason: "status_not_scanned" };
  }
  const recoverability = getDurableMissionRecoverability(manifest, now);
  if (recoverability.recoverable) {
    return { type: "resume" };
  }
  switch (recoverability.reason) {
    case "deadline_elapsed":
      return {
        type: "terminalize",
        status: "expired",
        code: "deadline_reached",
        message: "The durable mission reached its absolute deadline.",
      };
    case "segment_budget_exhausted":
    case "model_step_budget_exhausted":
    case "tool_call_budget_exhausted":
      return {
        type: "terminalize",
        status: "blocked",
        code: recoverability.reason,
        message: `The durable mission cannot resume because ${recoverability.reason.replace(/_/g, " ")}.`,
      };
    case "retry_exhausted":
      return {
        type: "terminalize",
        status: "blocked",
        code: "transient_failure_limit",
        message: "The durable mission exhausted its transient retry budget.",
      };
    case "live_lease": {
      const leaseExpiry = Date.parse(manifest.lease?.expiresAt ?? "");
      const repollAt = now.getTime() + LIVE_LEASE_REPOLL_MS;
      return {
        type: "wait",
        reason: "live_lease",
        retryAt: new Date(
          Number.isFinite(leaseExpiry) ? Math.min(repollAt, leaseExpiry) : repollAt,
        ).toISOString(),
      };
    }
    case "backoff_pending":
      return recoverability.availableAt
        ? {
            type: "wait",
            reason: "backoff_pending",
            retryAt: recoverability.availableAt,
          }
        : { type: "skip", reason: "backoff_without_retry_time" };
    default:
      return {
        type: "skip",
        reason: recoverability.reason ?? "unknown_blocker",
      };
  }
}

function isUnfinishedResumeStatus(status: DurableMissionStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "backing_off" ||
    status === "interrupted"
  );
}
