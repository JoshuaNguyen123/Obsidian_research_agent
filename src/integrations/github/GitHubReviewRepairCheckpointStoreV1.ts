import type { JsonValue } from "../../agent/actions";
import {
  assertKeys,
  assertNoCredentialKeys,
  assertNoCredentialMaterial,
  expectFingerprint,
  expectIdentifier,
  expectIsoTimestamp,
  expectJsonRecord,
  expectRecord,
  expectSafeInteger,
  expectText,
} from "../linear/linearDurabilityValidation";
import { parseVerifiedCodePublicationHandoffV1 } from "../../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import {
  GITHUB_REVIEW_REPAIR_CHECKPOINT_VERSION,
  type GitHubReviewRepairBlockerCodeV1,
  type GitHubReviewRepairBlockerV1,
  type GitHubReviewRepairCheckpointPortV1,
  type GitHubReviewRepairCheckpointStatusV1,
  type GitHubReviewRepairCheckpointV1,
  type GitHubReviewRepairFailureV1,
} from "./GitHubReviewRepairCoordinatorV1";

export const GITHUB_REVIEW_REPAIR_CHECKPOINT_NAMESPACE_VERSION = 1 as const;
export const GITHUB_REVIEW_REPAIR_CHECKPOINT_LIMIT = 500;

const CHECKPOINT_KEYS = [
  "version",
  "id",
  "sequence",
  "status",
  "requestFingerprint",
  "publicationId",
  "pullRequestNumber",
  "bindingFingerprint",
  "repositoryProfileKey",
  "workspaceId",
  "branch",
  "baseBranch",
  "originalHandoffFingerprint",
  "originalHeadSha",
  "originalRunId",
  "originalRequestId",
  "repairRequestId",
  "pullRequestUpdatedAt",
  "reviewEvidenceFingerprint",
  "reviewItemIds",
  "newHandoff",
  "publicationReceiptIds",
  "remoteHeadSha",
  "failureHistory",
  "blocker",
  "createdAt",
  "updatedAt",
] as const;

const STATUSES = new Set<GitHubReviewRepairCheckpointStatusV1>([
  "initialized",
  "remote_read_prepared",
  "review_evidence_verified",
  "workspace_resolution_prepared",
  "local_repair_prepared",
  "local_repair_failed",
  "local_verified",
  "publication_prepared",
  "publishing",
  "remote_verification_prepared",
  "complete",
  "blocked",
  "reconcile_required",
]);

const BLOCKER_CODES = new Set<GitHubReviewRepairBlockerCodeV1>([
  "github_review_authority_rejected",
  "github_review_evidence_changed",
  "github_review_no_actionable_feedback",
  "github_review_pull_request_closed",
  "github_review_remote_identity_invalid",
  "github_review_stale_base",
  "github_review_stale_head",
  "github_review_workspace_handoff_invalid",
  "github_review_repair_blocked",
  "github_review_unchanged_failure",
  "github_review_repair_handoff_invalid",
  "github_review_remote_verification_failed",
]);

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export interface GitHubReviewRepairCheckpointNamespaceV1 {
  version: typeof GITHUB_REVIEW_REPAIR_CHECKPOINT_NAMESPACE_VERSION;
  revision: number;
  checkpoints: Record<string, GitHubReviewRepairCheckpointV1>;
}

export interface GitHubReviewRepairCheckpointPersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(
    namespace: GitHubReviewRepairCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<void | boolean>;
}

/** Durable, serialized compare-and-swap storage for review-repair checkpoints. */
export class GitHubReviewRepairCheckpointStoreV1
  implements GitHubReviewRepairCheckpointPortV1 {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: GitHubReviewRepairCheckpointPersistenceV1) {}

  async load(idInput: string): Promise<GitHubReviewRepairCheckpointV1 | null> {
    await this.mutationTail;
    const id = expectIdentifier(idInput, "GitHub review-repair checkpoint id", 180);
    const namespace = parseGitHubReviewRepairCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return clone(namespace.checkpoints[id] ?? null);
  }

  async list(): Promise<GitHubReviewRepairCheckpointV1[]> {
    await this.mutationTail;
    const namespace = parseGitHubReviewRepairCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return Object.values(namespace.checkpoints)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clone);
  }

  async save(
    checkpointInput: GitHubReviewRepairCheckpointV1,
    expectedSequence: number | null,
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const checkpoint = parseGitHubReviewRepairCheckpointV1(checkpointInput);
      const namespace = parseGitHubReviewRepairCheckpointNamespaceV1(
        await this.persistence.read(),
      );
      const previous = namespace.checkpoints[checkpoint.id];
      if (expectedSequence === null) {
        if (previous) throw new Error("GitHub review-repair checkpoint already exists.");
        if (checkpoint.sequence !== 0) {
          throw new Error("New GitHub review-repair checkpoint must start at sequence zero.");
        }
      } else {
        if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
          throw new Error("Expected GitHub review-repair sequence is invalid.");
        }
        if (!previous || previous.sequence !== expectedSequence) {
          throw new Error("GitHub review-repair checkpoint changed before it could be saved.");
        }
        if (checkpoint.sequence !== expectedSequence + 1) {
          throw new Error("GitHub review-repair checkpoint sequence did not advance exactly once.");
        }
        validateTransition(previous, checkpoint);
      }
      if (
        !previous &&
        Object.keys(namespace.checkpoints).length >= GITHUB_REVIEW_REPAIR_CHECKPOINT_LIMIT
      ) {
        throw new Error(
          `GitHub review-repair checkpoint storage is limited to ${GITHUB_REVIEW_REPAIR_CHECKPOINT_LIMIT} entries.`,
        );
      }
      const next: GitHubReviewRepairCheckpointNamespaceV1 = {
        version: GITHUB_REVIEW_REPAIR_CHECKPOINT_NAMESPACE_VERSION,
        revision: namespace.revision + 1,
        checkpoints: {
          ...namespace.checkpoints,
          [checkpoint.id]: checkpoint,
        },
      };
      const written = await this.persistence.write(clone(next), namespace.revision);
      if (written === false) {
        throw new Error("GitHub review-repair checkpoint namespace changed before save.");
      }
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

export function parseGitHubReviewRepairCheckpointNamespaceV1(
  value: unknown,
): GitHubReviewRepairCheckpointNamespaceV1 {
  if (value === null || value === undefined) {
    return {
      version: GITHUB_REVIEW_REPAIR_CHECKPOINT_NAMESPACE_VERSION,
      revision: 0,
      checkpoints: {},
    };
  }
  const record = expectRecord(value, "GitHub review-repair checkpoint namespace");
  assertKeys(
    record,
    ["version", "revision", "checkpoints"],
    [],
    "GitHub review-repair checkpoint namespace",
  );
  if (record.version !== GITHUB_REVIEW_REPAIR_CHECKPOINT_NAMESPACE_VERSION) {
    throw new Error("Unsupported GitHub review-repair checkpoint namespace version.");
  }
  const rawCheckpoints = expectRecord(
    record.checkpoints,
    "GitHub review-repair checkpoints",
  );
  if (Object.keys(rawCheckpoints).length > GITHUB_REVIEW_REPAIR_CHECKPOINT_LIMIT) {
    throw new Error("GitHub review-repair checkpoint storage exceeds its fixed limit.");
  }
  const checkpoints: Record<string, GitHubReviewRepairCheckpointV1> = {};
  for (const [key, rawCheckpoint] of Object.entries(rawCheckpoints)) {
    const id = expectIdentifier(key, "GitHub review-repair checkpoint key", 180);
    const checkpoint = parseGitHubReviewRepairCheckpointV1(rawCheckpoint);
    if (checkpoint.id !== id) {
      throw new Error("GitHub review-repair checkpoint key does not match its id.");
    }
    checkpoints[id] = checkpoint;
  }
  return {
    version: GITHUB_REVIEW_REPAIR_CHECKPOINT_NAMESPACE_VERSION,
    revision: expectSafeInteger(
      record.revision,
      "GitHub review-repair checkpoint namespace revision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    checkpoints,
  };
}

export function parseGitHubReviewRepairCheckpointV1(
  value: unknown,
): GitHubReviewRepairCheckpointV1 {
  const json = expectJsonRecord(value, "GitHub review-repair checkpoint", 250_000);
  assertNoCredentialKeys(json as JsonValue, "GitHub review-repair checkpoint");
  assertNoCredentialMaterial(json as JsonValue, "GitHub review-repair checkpoint");
  const record = expectRecord(json, "GitHub review-repair checkpoint");
  assertKeys(record, CHECKPOINT_KEYS, [], "GitHub review-repair checkpoint");
  if (record.version !== GITHUB_REVIEW_REPAIR_CHECKPOINT_VERSION) {
    throw new Error("Unsupported GitHub review-repair checkpoint version.");
  }
  const status = checkpointStatus(record.status);
  const checkpoint: GitHubReviewRepairCheckpointV1 = {
    version: GITHUB_REVIEW_REPAIR_CHECKPOINT_VERSION,
    id: expectIdentifier(record.id, "GitHub review-repair checkpoint id", 180),
    sequence: expectSafeInteger(
      record.sequence,
      "GitHub review-repair checkpoint sequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    status,
    requestFingerprint: expectFingerprint(record.requestFingerprint, "GitHub review-repair request fingerprint"),
    publicationId: expectIdentifier(record.publicationId, "GitHub publication id", 180),
    pullRequestNumber: expectSafeInteger(
      record.pullRequestNumber,
      "GitHub review-repair pull-request number",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    bindingFingerprint: expectFingerprint(record.bindingFingerprint, "GitHub binding fingerprint"),
    repositoryProfileKey: expectIdentifier(record.repositoryProfileKey, "repository profile key", 180),
    workspaceId: expectIdentifier(record.workspaceId, "workspace id", 256),
    branch: gitBranch(record.branch, "agent branch"),
    baseBranch: gitBranch(record.baseBranch, "base branch"),
    originalHandoffFingerprint: expectFingerprint(record.originalHandoffFingerprint, "original handoff fingerprint"),
    originalHeadSha: gitSha(record.originalHeadSha, "original head SHA"),
    originalRunId: expectText(record.originalRunId, "original run id", 256),
    originalRequestId: expectIdentifier(record.originalRequestId, "original request id", 256),
    repairRequestId: expectIdentifier(record.repairRequestId, "repair request id", 256),
    pullRequestUpdatedAt: nullableTimestamp(record.pullRequestUpdatedAt, "pull-request update time"),
    reviewEvidenceFingerprint: nullableFingerprint(record.reviewEvidenceFingerprint, "review evidence fingerprint"),
    reviewItemIds: identifiers(record.reviewItemIds, "review item id", 100),
    newHandoff:
      record.newHandoff === null
        ? null
        : parseVerifiedCodePublicationHandoffV1(record.newHandoff),
    publicationReceiptIds: identifiers(record.publicationReceiptIds, "publication receipt id", 32),
    remoteHeadSha: record.remoteHeadSha === null
      ? null
      : gitSha(record.remoteHeadSha, "remote head SHA"),
    failureHistory: failureHistory(record.failureHistory),
    blocker: record.blocker === null ? null : parseBlocker(record.blocker),
    createdAt: expectIsoTimestamp(record.createdAt, "GitHub review-repair creation time"),
    updatedAt: expectIsoTimestamp(record.updatedAt, "GitHub review-repair update time"),
  };
  validateConsistency(checkpoint);
  return checkpoint;
}

function validateConsistency(checkpoint: GitHubReviewRepairCheckpointV1): void {
  if (Date.parse(checkpoint.updatedAt) < Date.parse(checkpoint.createdAt)) {
    throw new Error("GitHub review-repair checkpoint update predates creation.");
  }
  const afterReviewEvidence = new Set<GitHubReviewRepairCheckpointStatusV1>([
    "review_evidence_verified",
    "workspace_resolution_prepared",
    "local_repair_prepared",
    "local_repair_failed",
    "local_verified",
    "publication_prepared",
    "publishing",
    "remote_verification_prepared",
    "complete",
    "reconcile_required",
  ]);
  if (afterReviewEvidence.has(checkpoint.status)) {
    if (!checkpoint.reviewEvidenceFingerprint || checkpoint.reviewItemIds.length === 0) {
      throw new Error("Review-repair checkpoint stage requires bounded review evidence.");
    }
  }
  const afterLocal = new Set<GitHubReviewRepairCheckpointStatusV1>([
    "local_verified",
    "publication_prepared",
    "publishing",
    "remote_verification_prepared",
    "complete",
    "reconcile_required",
  ]);
  if (afterLocal.has(checkpoint.status) && !checkpoint.newHandoff) {
    throw new Error("Review-repair checkpoint stage requires a verified local handoff.");
  }
  if (
    checkpoint.newHandoff &&
    (
      checkpoint.newHandoff.workspaceId !== checkpoint.workspaceId ||
      checkpoint.newHandoff.repositoryProfileKey !== checkpoint.repositoryProfileKey ||
      checkpoint.newHandoff.branch !== checkpoint.branch ||
      checkpoint.newHandoff.baseBranch !== checkpoint.baseBranch ||
      checkpoint.newHandoff.requestId !== checkpoint.repairRequestId
    )
  ) {
    throw new Error("Review-repair handoff does not match its durable workspace identity.");
  }
  if (checkpoint.status === "remote_verification_prepared" || checkpoint.status === "complete") {
    if (
      !checkpoint.newHandoff ||
      checkpoint.remoteHeadSha !== checkpoint.newHandoff.commitSha ||
      checkpoint.publicationReceiptIds.length === 0
    ) {
      throw new Error("Remote-verification checkpoint lacks exact SHA and publication receipts.");
    }
  }
  if (checkpoint.status === "blocked" && !checkpoint.blocker) {
    throw new Error("Blocked review-repair checkpoint requires a blocker.");
  }
  if (checkpoint.status !== "blocked" && checkpoint.blocker) {
    throw new Error("Only blocked review-repair checkpoints may persist a blocker.");
  }
}

function validateTransition(
  previous: GitHubReviewRepairCheckpointV1,
  next: GitHubReviewRepairCheckpointV1,
): void {
  for (const key of [
    "id",
    "requestFingerprint",
    "publicationId",
    "pullRequestNumber",
    "bindingFingerprint",
    "repositoryProfileKey",
    "workspaceId",
    "branch",
    "baseBranch",
    "originalHandoffFingerprint",
    "originalHeadSha",
    "originalRunId",
    "originalRequestId",
    "repairRequestId",
    "createdAt",
  ] as const) {
    if (previous[key] !== next[key]) {
      throw new Error(`GitHub review-repair checkpoint immutable field ${key} changed.`);
    }
  }
  if (previous.status === "complete" || previous.status === "blocked") {
    if (next.status !== previous.status) {
      throw new Error("Terminal GitHub review-repair checkpoint cannot transition.");
    }
  }
  const allowed = ALLOWED_TRANSITIONS[previous.status];
  if (next.status !== previous.status && !allowed.has(next.status)) {
    throw new Error(`Invalid GitHub review-repair transition ${previous.status} -> ${next.status}.`);
  }
  if (previous.reviewEvidenceFingerprint && next.reviewEvidenceFingerprint !== previous.reviewEvidenceFingerprint) {
    throw new Error("Verified GitHub review evidence cannot be rewritten in place.");
  }
  if (previous.newHandoff && next.newHandoff?.fingerprint !== previous.newHandoff.fingerprint) {
    throw new Error("Verified GitHub review-repair handoff cannot be rewritten in place.");
  }
  if (next.failureHistory.length < previous.failureHistory.length) {
    throw new Error("GitHub review-repair failure history cannot shrink.");
  }
  if (next.publicationReceiptIds.length < previous.publicationReceiptIds.length) {
    throw new Error("GitHub review-repair publication receipts cannot shrink.");
  }
}

const ALLOWED_TRANSITIONS: Record<
  GitHubReviewRepairCheckpointStatusV1,
  ReadonlySet<GitHubReviewRepairCheckpointStatusV1>
> = {
  initialized: new Set(["remote_read_prepared", "blocked"]),
  remote_read_prepared: new Set(["review_evidence_verified", "blocked"]),
  review_evidence_verified: new Set(["workspace_resolution_prepared", "blocked"]),
  workspace_resolution_prepared: new Set(["local_repair_prepared", "blocked"]),
  local_repair_prepared: new Set(["local_repair_failed", "local_verified", "blocked"]),
  local_repair_failed: new Set(["local_repair_prepared", "local_verified", "blocked"]),
  local_verified: new Set(["publication_prepared", "blocked"]),
  publication_prepared: new Set(["publishing", "blocked"]),
  publishing: new Set(["remote_verification_prepared", "reconcile_required", "blocked"]),
  remote_verification_prepared: new Set(["complete", "blocked"]),
  complete: new Set(),
  blocked: new Set(),
  reconcile_required: new Set(["remote_verification_prepared", "blocked"]),
};

function failureHistory(value: unknown): GitHubReviewRepairFailureV1[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("GitHub review-repair failure history exceeds its fixed bound.");
  }
  return value.map((entry, index) => {
    const record = expectRecord(entry, `GitHub review-repair failure ${index + 1}`);
    assertKeys(record, ["fingerprint", "recordedAt"], [], `GitHub review-repair failure ${index + 1}`);
    return {
      fingerprint: expectFingerprint(record.fingerprint, `GitHub review-repair failure ${index + 1} fingerprint`),
      recordedAt: expectIsoTimestamp(record.recordedAt, `GitHub review-repair failure ${index + 1} time`),
    };
  });
}

function parseBlocker(value: unknown): GitHubReviewRepairBlockerV1 {
  const record = expectRecord(value, "GitHub review-repair blocker");
  assertKeys(record, ["code", "message", "evidenceFingerprint", "blockedAt"], [], "GitHub review-repair blocker");
  if (typeof record.code !== "string" || !BLOCKER_CODES.has(record.code as GitHubReviewRepairBlockerCodeV1)) {
    throw new Error("GitHub review-repair blocker code is invalid.");
  }
  return {
    code: record.code as GitHubReviewRepairBlockerCodeV1,
    message: expectText(record.message, "GitHub review-repair blocker message", 2_000),
    evidenceFingerprint: nullableFingerprint(record.evidenceFingerprint, "GitHub review-repair blocker evidence"),
    blockedAt: expectIsoTimestamp(record.blockedAt, "GitHub review-repair blocked time"),
  };
}

function checkpointStatus(value: unknown): GitHubReviewRepairCheckpointStatusV1 {
  if (typeof value !== "string" || !STATUSES.has(value as GitHubReviewRepairCheckpointStatusV1)) {
    throw new Error("GitHub review-repair checkpoint status is invalid.");
  }
  return value as GitHubReviewRepairCheckpointStatusV1;
}

function identifiers(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}s exceed their fixed bound.`);
  const result = value.map((entry) => expectIdentifier(entry, label, 256));
  if (new Set(result).size !== result.length) throw new Error(`${label}s must be unique.`);
  return result;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : expectIsoTimestamp(value, label);
}

function nullableFingerprint(value: unknown, label: string): string | null {
  return value === null ? null : expectFingerprint(value, label);
}

function gitSha(value: unknown, label: string): string {
  const sha = expectText(value, label, 64);
  if (!GIT_SHA.test(sha)) throw new Error(`${label} is invalid.`);
  return sha;
}

function gitBranch(value: unknown, label: string): string {
  const branch = expectText(value, label, 255);
  if (
    branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
    branch.endsWith(".") || branch.includes("..") || branch.includes("@{") ||
    /[~^:?*[\\\s\]]/u.test(branch)
  ) throw new Error(`${label} is invalid.`);
  return branch;
}

function clone<T>(value: T): T {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value)) as T;
}
