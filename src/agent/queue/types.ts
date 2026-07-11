import type { WorkItemSpecV1 } from "../../integrations/linear/WorkItemSpecV1";

export const LINEAR_QUEUE_SCHEMA_VERSION = 1 as const;

export type LinearQueueCandidateStatus =
  | "pending"
  | "eligible"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export type CandidateIneligibilityReason =
  | "queue_disabled"
  | "invalid_work_item"
  | "work_item_not_ready"
  | "execution_class_not_allowed"
  | "risk_not_allowed"
  | "generation_exceeded"
  | "missing_repository"
  | "missing_trusted_binding"
  | "repository_not_allowed"
  | "unknown_repository"
  | "missing_acceptance_criteria"
  | "missing_validation_requirements"
  | "missing_evidence";

export interface CandidateEligibilityV1 {
  eligible: boolean;
  reasons: CandidateIneligibilityReason[];
  repositoryKey: string | null;
  policyFingerprint: string;
  evaluatedAt: string;
}

export interface LinearQueueLeaseV1 {
  ownerId: string;
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface LinearQueueCursorV1 {
  /** Linear's canonical issue update timestamp. */
  updatedAt: string;
  /** Tie-breaker for issues sharing the same update timestamp. */
  issueId: string;
}

export interface LinearQueueCandidateV1 {
  issueId: string;
  identifier: string;
  remoteUpdatedAt: string;
  workItem: WorkItemSpecV1;
  status: LinearQueueCandidateStatus;
  eligibility: CandidateEligibilityV1 | null;
  lease: LinearQueueLeaseV1 | null;
  attemptCount: number;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinearQueueStateV1 {
  schemaVersion: typeof LINEAR_QUEUE_SCHEMA_VERSION;
  revision: number;
  workspaceId: string;
  cursor: LinearQueueCursorV1 | null;
  candidates: Record<string, LinearQueueCandidateV1>;
  createdAt: string;
  updatedAt: string;
}

export interface LinearQueueEventBaseV1 {
  expectedRevision: number;
  at: string;
}

export type LinearQueueEventV1 =
  | (LinearQueueEventBaseV1 & {
      type: "candidate_upserted";
      issueId: string;
      identifier: string;
      remoteUpdatedAt: string;
      workItem: WorkItemSpecV1;
    })
  | (LinearQueueEventBaseV1 & {
      type: "candidate_evaluated";
      issueId: string;
      eligibility: CandidateEligibilityV1;
    })
  | (LinearQueueEventBaseV1 & {
      type: "lease_acquired";
      issueId: string;
      lease: LinearQueueLeaseV1;
    })
  | (LinearQueueEventBaseV1 & {
      type: "lease_renewed";
      issueId: string;
      ownerId: string;
      token: string;
      expiresAt: string;
    })
  | (LinearQueueEventBaseV1 & {
      type: "lease_released";
      issueId: string;
      ownerId: string;
      token: string;
    })
  | (LinearQueueEventBaseV1 & {
      type: "candidate_started";
      issueId: string;
      ownerId: string;
      token: string;
    })
  | (LinearQueueEventBaseV1 & {
      type: "candidate_completed";
      issueId: string;
      ownerId: string;
      token: string;
    })
  | (LinearQueueEventBaseV1 & {
      type: "candidate_blocked";
      issueId: string;
      ownerId: string;
      token: string;
      error: string;
    })
  | (LinearQueueEventBaseV1 & {
      type: "candidate_failed";
      issueId: string;
      ownerId: string;
      token: string;
      error: string;
      retryable: boolean;
    })
  | (LinearQueueEventBaseV1 & {
      type: "cursor_advanced";
      cursor: LinearQueueCursorV1;
    });
