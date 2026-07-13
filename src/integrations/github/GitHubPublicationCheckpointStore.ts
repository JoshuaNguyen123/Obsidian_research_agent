import type { JsonValue } from "../../agent/actions";
import { parsePendingExternalActionStateV2 } from "../PendingExternalActionStateV2";
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
import type {
  GitHubPublicationCheckpointPortV1,
  GitHubPublicationCheckpointStatusV1,
  GitHubPublicationCheckpointV1,
  GitHubPublicationProofSnapshotV1,
  GitHubPublicationPullRequestV1,
} from "./GitHubPublicationWorkflow";

export const GITHUB_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION = 1 as const;
export const GITHUB_PUBLICATION_CHECKPOINT_LIMIT = 500;

export interface GitHubPublicationCheckpointNamespaceV1 {
  version: typeof GITHUB_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION;
  revision: number;
  checkpoints: Record<string, GitHubPublicationCheckpointV1>;
}

export interface GitHubPublicationCheckpointPersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(
    namespace: GitHubPublicationCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<void | boolean>;
}

export class GitHubPublicationCheckpointStoreV1
  implements GitHubPublicationCheckpointPortV1 {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: GitHubPublicationCheckpointPersistenceV1,
  ) {}

  async get(publicationId: string): Promise<GitHubPublicationCheckpointV1 | null> {
    await this.mutationTail;
    const id = expectIdentifier(publicationId, "GitHub publication id", 180);
    const namespace = parseGitHubPublicationCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return clone(namespace.checkpoints[id] ?? null);
  }

  async list(): Promise<GitHubPublicationCheckpointV1[]> {
    await this.mutationTail;
    const namespace = parseGitHubPublicationCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return Object.values(namespace.checkpoints)
      .sort((left, right) => left.publicationId.localeCompare(right.publicationId))
      .map(clone);
  }

  async persist(checkpoint: GitHubPublicationCheckpointV1): Promise<void> {
    await this.upsert(checkpoint);
  }

  async upsert(
    checkpoint: GitHubPublicationCheckpointV1,
  ): Promise<GitHubPublicationCheckpointV1> {
    const operation = this.mutationTail.then(async () => {
      const normalized = parseGitHubPublicationCheckpointV1(checkpoint);
      const current = parseGitHubPublicationCheckpointNamespaceV1(
        await this.persistence.read(),
      );
      const previous = current.checkpoints[normalized.publicationId];
      if (previous) validateTransition(previous, normalized);
      if (!previous && Object.keys(current.checkpoints).length >= GITHUB_PUBLICATION_CHECKPOINT_LIMIT) {
        throw new Error(
          `GitHub publication checkpoint storage is limited to ${GITHUB_PUBLICATION_CHECKPOINT_LIMIT} entries.`,
        );
      }
      const next: GitHubPublicationCheckpointNamespaceV1 = {
        version: GITHUB_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION,
        revision: current.revision + 1,
        checkpoints: {
          ...current.checkpoints,
          [normalized.publicationId]: normalized,
        },
      };
      const written = await this.persistence.write(clone(next), current.revision);
      if (written === false) {
        throw new Error("GitHub publication checkpoint changed before it could be saved.");
      }
      return normalized;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return clone(await operation);
  }
}

export function parseGitHubPublicationCheckpointNamespaceV1(
  value: unknown,
): GitHubPublicationCheckpointNamespaceV1 {
  if (value === null || value === undefined) {
    return {
      version: GITHUB_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION,
      revision: 0,
      checkpoints: {},
    };
  }
  const record = expectRecord(value, "GitHub publication checkpoint namespace");
  assertKeys(
    record,
    ["version", "revision", "checkpoints"],
    [],
    "GitHub publication checkpoint namespace",
  );
  if (record.version !== GITHUB_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION) {
    throw new Error("Unsupported GitHub publication checkpoint namespace version.");
  }
  const rawCheckpoints = expectRecord(
    record.checkpoints,
    "GitHub publication checkpoints",
  );
  if (Object.keys(rawCheckpoints).length > GITHUB_PUBLICATION_CHECKPOINT_LIMIT) {
    throw new Error("GitHub publication checkpoint storage exceeds its fixed limit.");
  }
  const checkpoints: Record<string, GitHubPublicationCheckpointV1> = {};
  for (const [key, value] of Object.entries(rawCheckpoints)) {
    const id = expectIdentifier(key, "GitHub publication checkpoint key", 180);
    const checkpoint = parseGitHubPublicationCheckpointV1(value);
    if (checkpoint.publicationId !== id) {
      throw new Error("GitHub publication checkpoint key does not match its id.");
    }
    checkpoints[id] = checkpoint;
  }
  return {
    version: GITHUB_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION,
    revision: expectSafeInteger(
      record.revision,
      "GitHub publication checkpoint revision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    checkpoints,
  };
}

export function parseGitHubPublicationCheckpointV1(
  value: unknown,
): GitHubPublicationCheckpointV1 {
  const json = expectJsonRecord(
    value,
    "GitHub publication checkpoint",
    200_000,
  );
  assertNoCredentialKeys(json as JsonValue, "GitHub publication checkpoint");
  assertNoCredentialMaterial(json as JsonValue, "GitHub publication checkpoint");
  const rawRecord = expectRecord(json, "GitHub publication checkpoint");
  // Pre-merge Phase 7 development checkpoints predate the durable merge SHA.
  // They migrate only to an explicit null; a post-merge checkpoint without
  // its provider readback SHA remains invalid and cannot resume finalization.
  const withMergeSha = Object.prototype.hasOwnProperty.call(rawRecord, "mergeSha")
    ? rawRecord
    : { ...rawRecord, mergeSha: null };
  const legacyReceiptIds = Array.isArray(withMergeSha.receiptIds)
    ? withMergeSha.receiptIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const legacyLinearReceipt =
    withMergeSha.status === "waiting_obsidian" || withMergeSha.status === "finalized"
      ? legacyReceiptIds.at(withMergeSha.status === "finalized" ? -2 : -1) ?? null
      : null;
  const record: Record<string, unknown> = {
    ...(withMergeSha as Record<string, unknown>),
    completionProof: Object.prototype.hasOwnProperty.call(withMergeSha, "completionProof")
      ? withMergeSha.completionProof
      : "merged_pr",
    linearLinkReceiptId: Object.prototype.hasOwnProperty.call(withMergeSha, "linearLinkReceiptId")
      ? withMergeSha.linearLinkReceiptId
      : legacyLinearReceipt,
    linearCompletionReceiptId: Object.prototype.hasOwnProperty.call(withMergeSha, "linearCompletionReceiptId")
      ? withMergeSha.linearCompletionReceiptId
      : legacyLinearReceipt,
    obsidianReceiptId: Object.prototype.hasOwnProperty.call(withMergeSha, "obsidianReceiptId")
      ? withMergeSha.obsidianReceiptId
      : withMergeSha.status === "finalized" ? legacyReceiptIds.at(-1) ?? null : null,
  };
  assertKeys(
    record,
    [
      "version",
      "publicationId",
      "status",
      "updatedAt",
      "handoffFingerprint",
      "bindingFingerprint",
      "headSha",
      "branch",
      "remoteSha",
      "mergeSha",
      "pullRequest",
      "proofSnapshot",
      "publishApprovalFingerprint",
      "readyApprovalFingerprint",
      "mergeApprovalFingerprint",
      "completionProof",
      "linearLinkReceiptId",
      "linearCompletionReceiptId",
      "obsidianReceiptId",
      "receiptIds",
      "pendingAction",
      "blocker",
    ],
    ["repairBaseSha", "repairId", "repairPullRequestNumber"],
    "GitHub publication checkpoint",
  );
  if (record.version !== 1) throw new Error("Unsupported GitHub publication checkpoint version.");
  const status = parseStatus(record.status);
  const receiptIds = uniqueIdentifiers(record.receiptIds, "GitHub publication receipt id", 256);
  const normalized: GitHubPublicationCheckpointV1 = {
    version: 1,
    publicationId: expectIdentifier(record.publicationId, "GitHub publication id", 180),
    status,
    updatedAt: expectIsoTimestamp(record.updatedAt, "GitHub publication update time"),
    handoffFingerprint: expectFingerprint(record.handoffFingerprint, "GitHub handoff fingerprint"),
    bindingFingerprint: expectFingerprint(record.bindingFingerprint, "GitHub binding fingerprint"),
    headSha: gitSha(record.headSha, "GitHub publication head SHA"),
    branch: branch(record.branch),
    remoteSha: record.remoteSha === null ? null : gitSha(record.remoteSha, "GitHub remote SHA"),
    mergeSha: record.mergeSha === null ? null : gitSha(record.mergeSha, "GitHub merge SHA"),
    pullRequest: record.pullRequest === null ? null : parsePullRequest(record.pullRequest),
    proofSnapshot:
      record.proofSnapshot === null ? null : parseProofSnapshot(record.proofSnapshot),
    publishApprovalFingerprint: nullableFingerprint(
      record.publishApprovalFingerprint,
      "GitHub publish approval fingerprint",
    ),
    readyApprovalFingerprint: nullableFingerprint(
      record.readyApprovalFingerprint,
      "GitHub ready approval fingerprint",
    ),
    mergeApprovalFingerprint: nullableFingerprint(
      record.mergeApprovalFingerprint,
      "GitHub merge approval fingerprint",
    ),
    completionProof: parseCompletionProof(record.completionProof),
    linearLinkReceiptId: nullableIdentifier(
      record.linearLinkReceiptId,
      "GitHub Linear-link receipt id",
    ),
    linearCompletionReceiptId: nullableIdentifier(
      record.linearCompletionReceiptId,
      "GitHub Linear-completion receipt id",
    ),
    obsidianReceiptId: nullableIdentifier(
      record.obsidianReceiptId,
      "GitHub Obsidian receipt id",
    ),
    receiptIds,
    pendingAction:
      record.pendingAction === null
        ? null
        : parsePendingExternalActionStateV2(record.pendingAction),
    blocker: record.blocker === null ? null : parseBlocker(record.blocker),
    repairBaseSha:
      record.repairBaseSha === undefined || record.repairBaseSha === null
        ? null
        : gitSha(record.repairBaseSha, "GitHub review-repair base SHA"),
    repairId:
      record.repairId === undefined || record.repairId === null
        ? null
        : expectIdentifier(record.repairId, "GitHub review-repair id", 180),
    repairPullRequestNumber:
      record.repairPullRequestNumber === undefined || record.repairPullRequestNumber === null
        ? null
        : expectSafeInteger(
            record.repairPullRequestNumber,
            "GitHub review-repair pull request number",
            1,
            Number.MAX_SAFE_INTEGER,
          ),
  };
  validateConsistency(normalized);
  return normalized;
}

function parsePullRequest(value: unknown): GitHubPublicationPullRequestV1 {
  const record = expectRecord(value, "GitHub publication pull request");
  assertKeys(
    record,
    ["number", "htmlUrl", "state", "draft", "merged", "head", "base", "updatedAt"],
    ["mergeSha"],
    "GitHub publication pull request",
  );
  const head = parseRef(record.head, "GitHub pull request head");
  const base = parseRef(record.base, "GitHub pull request base");
  if (record.state !== "open" && record.state !== "closed") {
    throw new Error("GitHub pull request state is invalid.");
  }
  const htmlUrl = expectText(record.htmlUrl, "GitHub pull request URL", 2_000);
  const parsedUrl = new URL(htmlUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com") {
    throw new Error("GitHub pull request URL must be an HTTPS github.com URL.");
  }
  return {
    number: expectSafeInteger(record.number, "GitHub pull request number", 1, Number.MAX_SAFE_INTEGER),
    htmlUrl,
    state: record.state,
    draft: boolean(record.draft, "GitHub pull request draft state"),
    merged: boolean(record.merged, "GitHub pull request merged state"),
    head,
    base,
    updatedAt: expectIsoTimestamp(record.updatedAt, "GitHub pull request update time"),
    ...(record.mergeSha === undefined
      ? {}
      : { mergeSha: record.mergeSha === null ? null : gitSha(record.mergeSha, "GitHub pull request merge SHA") }),
  };
}

function parseProofSnapshot(value: unknown): GitHubPublicationProofSnapshotV1 {
  const record = expectRecord(value, "GitHub publication proof snapshot");
  assertKeys(
    record,
    [
      "headSha",
      "pullRequestUpdatedAt",
      "requiredChecks",
      "passedChecks",
      "pendingChecks",
      "failedChecks",
      "approvingReviewers",
      "changesRequestedBy",
      "checkedAt",
      "snapshotFingerprint",
    ],
    [],
    "GitHub publication proof snapshot",
  );
  const requiredChecks = uniqueText(record.requiredChecks, "required check", 64, 200);
  const passedChecks = uniqueText(record.passedChecks, "passed check", 64, 200);
  const pendingChecks = uniqueText(record.pendingChecks, "pending check", 64, 200);
  const failedChecks = uniqueText(record.failedChecks, "failed check", 64, 200);
  const allResults = [...passedChecks, ...pendingChecks, ...failedChecks];
  if (
    new Set(allResults).size !== allResults.length ||
    requiredChecks.some((name) => !allResults.includes(name)) ||
    allResults.some((name) => !requiredChecks.includes(name))
  ) {
    throw new Error("GitHub required check results must form one exact partition.");
  }
  const normalized: GitHubPublicationProofSnapshotV1 = {
    headSha: gitSha(record.headSha, "GitHub proof head SHA"),
    pullRequestUpdatedAt: expectIsoTimestamp(
      record.pullRequestUpdatedAt,
      "GitHub proof pull request update time",
    ),
    requiredChecks,
    passedChecks,
    pendingChecks,
    failedChecks,
    approvingReviewers: uniqueText(record.approvingReviewers, "approving reviewer", 100, 100),
    changesRequestedBy: uniqueText(record.changesRequestedBy, "changes-requested reviewer", 100, 100),
    checkedAt: expectIsoTimestamp(record.checkedAt, "GitHub proof check time"),
    snapshotFingerprint: expectFingerprint(
      record.snapshotFingerprint,
      "GitHub proof snapshot fingerprint",
    ),
  };
  return normalized;
}

function validateConsistency(value: GitHubPublicationCheckpointV1): void {
  if (!value.branch.startsWith("codex/")) {
    throw new Error("GitHub publication branch must be agent owned.");
  }
  if (value.remoteSha !== null && value.remoteSha !== value.headSha) {
    throw new Error("GitHub remote SHA must equal the verified handoff head.");
  }
  if (value.pullRequest && value.pullRequest.head.sha !== value.headSha) {
    throw new Error("GitHub pull request head must equal the verified handoff head.");
  }
  if (value.proofSnapshot && value.proofSnapshot.headSha !== value.headSha) {
    throw new Error("GitHub proof snapshot head must equal the verified handoff head.");
  }
  if (value.status === "reconcile_required" && !value.pendingAction) {
    throw new Error("GitHub reconciliation requires a pending external action.");
  }
  if (value.pendingAction && value.pendingAction.provider !== "github") {
    throw new Error("GitHub publication cannot persist another provider's pending action.");
  }
  const repairBaseSha = value.repairBaseSha ?? null;
  const repairId = value.repairId ?? null;
  const repairPullRequestNumber = value.repairPullRequestNumber ?? null;
  const repairFields = [repairBaseSha, repairId, repairPullRequestNumber];
  if (
    repairFields.some((entry) => entry === null) &&
    repairFields.some((entry) => entry !== null)
  ) {
    throw new Error("GitHub review-repair epoch fields must be persisted together.");
  }
  if (repairBaseSha) {
    if (repairBaseSha === value.headSha) {
      throw new Error("GitHub review-repair head must advance beyond its durable base SHA.");
    }
    if (value.pullRequest && value.pullRequest.number !== repairPullRequestNumber) {
      throw new Error("GitHub review-repair pull request does not match its durable epoch.");
    }
  }
  const finalizationStatuses: GitHubPublicationCheckpointStatusV1[] = [
    "waiting_linear",
    "waiting_linear_link",
    "linear_linked",
    "waiting_linear_completion",
    "linear_completed",
    "waiting_obsidian",
    "finalized",
  ];
  const mergedProofRequired =
    value.status === "merged_verified" ||
    (value.completionProof === "merged_pr" && finalizationStatuses.includes(value.status));
  if (mergedProofRequired && !value.mergeSha) {
    throw new Error("GitHub merge SHA is required for merged-pr finalization checkpoints.");
  }
  if (value.mergeSha && !value.pullRequest?.merged) {
    throw new Error("A GitHub merge SHA requires merged pull-request readback.");
  }
  for (const receiptId of [
    value.linearLinkReceiptId,
    value.linearCompletionReceiptId,
    value.obsidianReceiptId,
  ]) {
    if (receiptId && !value.receiptIds.includes(receiptId)) {
      throw new Error("GitHub finalization stage receipt must exist in append-only receipt lineage.");
    }
  }
  if (value.linearCompletionReceiptId && !value.linearLinkReceiptId) {
    throw new Error("Linear completion cannot precede durable Linear linkage.");
  }
  if (value.obsidianReceiptId && !value.linearCompletionReceiptId) {
    throw new Error("Obsidian finalization cannot precede durable Linear completion.");
  }
  if (value.status === "finalized" && !value.obsidianReceiptId) {
    throw new Error("Finalized GitHub publication requires all durable finalization receipts.");
  }
}

function validateTransition(
  previous: GitHubPublicationCheckpointV1,
  next: GitHubPublicationCheckpointV1,
): void {
  const repairEpochAdvance =
    previous.status === "repair_required" && next.status === "push_prepared";
  const verifiedRepairEpochAdvance =
    previous.status === "repair_required" &&
    next.status === "draft_pr_verified";
  if (repairEpochAdvance) validateReviewRepairEpochAdvance(previous, next);
  if (verifiedRepairEpochAdvance) {
    validateVerifiedReviewRepairEpochAdvance(previous, next);
  }
  for (const key of ["handoffFingerprint", "bindingFingerprint", "headSha", "branch", "completionProof"] as const) {
    const repairMutable =
      (repairEpochAdvance || verifiedRepairEpochAdvance) &&
      (key === "handoffFingerprint" || key === "headSha");
    if (previous[key] !== next[key] && !repairMutable) {
      throw new Error(`GitHub publication ${key} is immutable.`);
    }
  }
  for (const key of ["repairBaseSha", "repairId", "repairPullRequestNumber"] as const) {
    if (
      (previous[key] ?? null) !== (next[key] ?? null) &&
      !repairEpochAdvance &&
      !verifiedRepairEpochAdvance
    ) {
      throw new Error(`GitHub publication ${key} is immutable outside a review-repair epoch advance.`);
    }
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new Error("GitHub publication checkpoint time cannot move backwards.");
  }
  if (previous.mergeSha && previous.mergeSha !== next.mergeSha) {
    throw new Error("GitHub merge SHA is immutable after verified readback.");
  }
  for (const key of [
    "linearLinkReceiptId",
    "linearCompletionReceiptId",
    "obsidianReceiptId",
  ] as const) {
    if (previous[key] && previous[key] !== next[key]) {
      throw new Error(`GitHub publication ${key} is immutable after verification.`);
    }
  }
  if (next.receiptIds.length < previous.receiptIds.length ||
      previous.receiptIds.some((id, index) => next.receiptIds[index] !== id)) {
    throw new Error("GitHub publication receipt lineage is append-only.");
  }
  if (previous.status === "finalized" && next.status !== "finalized") {
    throw new Error("Finalized GitHub publication checkpoints are terminal.");
  }
  if (previous.status === "reconcile_required" && ![
    "reconcile_required",
    "pushed_verified",
    "draft_pr_verified",
    "review_or_merge_ready",
    "merged_verified",
    "blocked",
  ].includes(next.status)) {
    throw new Error("GitHub reconciliation must be resolved by exact provider readback.");
  }
}

function validateVerifiedReviewRepairEpochAdvance(
  previous: GitHubPublicationCheckpointV1,
  next: GitHubPublicationCheckpointV1,
): void {
  const previousPullRequest = previous.pullRequest;
  const nextPullRequest = next.pullRequest;
  if (
    previous.remoteSha !== previous.headSha ||
    !previousPullRequest ||
    previousPullRequest.state !== "open" ||
    previousPullRequest.merged ||
    previousPullRequest.head.sha !== previous.headSha ||
    previousPullRequest.head.ref !== previous.branch ||
    next.headSha === previous.headSha ||
    next.handoffFingerprint === previous.handoffFingerprint ||
    next.repairBaseSha !== previous.headSha ||
    !next.repairId ||
    next.repairPullRequestNumber !== previousPullRequest.number ||
    next.remoteSha !== next.headSha ||
    !nextPullRequest ||
    nextPullRequest.number !== previousPullRequest.number ||
    nextPullRequest.state !== "open" ||
    nextPullRequest.merged ||
    nextPullRequest.head.ref !== next.branch ||
    nextPullRequest.head.sha !== next.headSha ||
    nextPullRequest.base.ref !== previousPullRequest.base.ref ||
    next.proofSnapshot !== null ||
    next.mergeSha !== null ||
    !next.publishApprovalFingerprint ||
    next.readyApprovalFingerprint !== null ||
    next.mergeApprovalFingerprint !== null ||
    next.pendingAction !== null ||
    next.blocker !== null ||
    previous.linearLinkReceiptId !== next.linearLinkReceiptId ||
    previous.linearCompletionReceiptId !== next.linearCompletionReceiptId ||
    previous.obsidianReceiptId !== next.obsidianReceiptId ||
    next.receiptIds.length <= previous.receiptIds.length ||
    previous.receiptIds.some((id, index) => next.receiptIds[index] !== id)
  ) {
    throw new Error(
      "Verified background review-repair readback must advance one exact owned PR and descendant head.",
    );
  }
}

function validateReviewRepairEpochAdvance(
  previous: GitHubPublicationCheckpointV1,
  next: GitHubPublicationCheckpointV1,
): void {
  const previousPullRequest = previous.pullRequest;
  if (
    previous.remoteSha !== previous.headSha ||
    !previousPullRequest ||
    previousPullRequest.state !== "open" ||
    previousPullRequest.merged ||
    previousPullRequest.head.sha !== previous.headSha ||
    previousPullRequest.head.ref !== previous.branch ||
    next.headSha === previous.headSha ||
    next.handoffFingerprint === previous.handoffFingerprint ||
    next.repairBaseSha !== previous.headSha ||
    !next.repairId ||
    next.repairId === (previous.repairId ?? null) ||
    next.repairPullRequestNumber !== previousPullRequest.number ||
    next.remoteSha !== null ||
    next.pullRequest !== null ||
    next.proofSnapshot !== null ||
    next.mergeSha !== null ||
    next.readyApprovalFingerprint !== null ||
    next.mergeApprovalFingerprint !== null ||
    !next.publishApprovalFingerprint ||
    !next.pendingAction ||
    next.pendingAction.provider !== "github" ||
    next.pendingAction.operation !== "git_push" ||
    next.pendingAction.preparedActionFingerprint !== next.publishApprovalFingerprint ||
    previous.linearLinkReceiptId !== next.linearLinkReceiptId ||
    previous.linearCompletionReceiptId !== next.linearCompletionReceiptId ||
    previous.obsidianReceiptId !== next.obsidianReceiptId ||
    previous.receiptIds.length !== next.receiptIds.length ||
    previous.receiptIds.some((id, index) => next.receiptIds[index] !== id)
  ) {
    throw new Error(
      "GitHub review-repair epoch advance must bind one exact open PR and descendant head before dispatch.",
    );
  }
}

function parseStatus(value: unknown): GitHubPublicationCheckpointStatusV1 {
  const allowed: GitHubPublicationCheckpointStatusV1[] = [
    "local_verified",
    "push_prepared",
    "pushed_verified",
    "draft_pr_verified",
    "checks_pending",
    "repair_required",
    "review_or_merge_ready",
    "merge_prepared",
    "merged_verified",
    "waiting_linear_link",
    "linear_linked",
    "waiting_linear_completion",
    "linear_completed",
    "waiting_linear",
    "waiting_obsidian",
    "finalized",
    "blocked",
    "reconcile_required",
  ];
  if (typeof value !== "string" || !allowed.includes(value as GitHubPublicationCheckpointStatusV1)) {
    throw new Error("GitHub publication checkpoint status is invalid.");
  }
  return value as GitHubPublicationCheckpointStatusV1;
}

function parseRef(value: unknown, label: string): { ref: string; sha: string } {
  const record = expectRecord(value, label);
  assertKeys(record, ["ref", "sha"], [], label);
  return { ref: branch(record.ref), sha: gitSha(record.sha, `${label} SHA`) };
}

function parseBlocker(value: unknown): { code: string; message: string } {
  const record = expectRecord(value, "GitHub publication blocker");
  assertKeys(record, ["code", "message"], [], "GitHub publication blocker");
  return {
    code: expectIdentifier(record.code, "GitHub publication blocker code", 120),
    message: expectText(record.message, "GitHub publication blocker message", 1_000),
  };
}

function nullableFingerprint(value: unknown, label: string): string | null {
  return value === null ? null : expectFingerprint(value, label);
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : expectIdentifier(value, label, 180);
}

function parseCompletionProof(
  value: unknown,
): GitHubPublicationCheckpointV1["completionProof"] {
  if (value !== "draft_pr" && value !== "merged_pr") {
    throw new Error("GitHub publication completion proof is invalid.");
  }
  return value;
}

function uniqueIdentifiers(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} list is invalid.`);
  const values = value.map((entry) => expectIdentifier(entry, label, 180));
  if (new Set(values).size !== values.length) throw new Error(`${label} list contains duplicates.`);
  return values;
}

function uniqueText(value: unknown, label: string, maximum: number, length: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} list is invalid.`);
  const values = value.map((entry) => expectText(entry, label, length));
  if (new Set(values).size !== values.length) throw new Error(`${label} list contains duplicates.`);
  return values;
}

function branch(value: unknown): string {
  const text = expectText(value, "Git branch", 255);
  if (text.startsWith("-") || text.includes("..") || text.includes("@{") || /[\s~^:?*[\\\]]/u.test(text)) {
    throw new Error("Git branch is invalid.");
  }
  return text;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${label} must be a complete Git object id.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
