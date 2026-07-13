import { portableSha256Text } from "./portableSha256";
import {
  parseHostApprovalReceiptV1,
  type HostApprovalReceiptV1,
} from "./hostApprovalReceiptV1";

export const PREPARED_BACKGROUND_GITHUB_ACTION_VERSION = 1 as const;

export const GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 =
  "github_verified_branch_push_v1" as const;
export const GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 =
  "github_draft_pull_request_v1" as const;
export const GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 =
  "github_review_repair_fast_forward_v1" as const;
export const GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 =
  "github_pull_request_merge_v1" as const;
export const GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1 =
  "github_pull_request_auto_merge_v1" as const;

export type PreparedBackgroundGitHubOperationV1 =
  | typeof GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1
  | typeof GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1
  | typeof GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
  | typeof GITHUB_PULL_REQUEST_MERGE_OPERATION_V1
  | typeof GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1;

export type PreparedBackgroundGitHubToolNameV1 =
  | "github_publish_verified_branch"
  | "github_create_draft_pull_request"
  | "github_update_owned_branch"
  | "github_merge_pull_request"
  | "github_enable_auto_merge";

export interface PreparedBackgroundGitHubBindingV1 {
  id: string;
  destinationFingerprint: string;
  repositoryBindingKey: string;
  repositoryBindingFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  owner: string;
  repository: string;
  repositoryId: number;
  verifiedAccountId: number;
  verifiedAccountLogin: string;
  credentialReferenceId: string;
}

/**
 * Proof that the host consumed one exact action grant. Each confirmation is a
 * closed, signed host receipt so a caller cannot turn arbitrary hashes into
 * authority or reuse one approval gesture as two confirmations.
 */
export interface ConsumedBackgroundGitHubGrantV1 {
  id: string;
  authorityFingerprint: string;
  actionFingerprint: string;
  consumedAt: string;
  expiresAt: string;
  requiredConfirmations: 1 | 2;
  confirmationReceipts: HostApprovalReceiptV1[];
}

export interface GitHubVerifiedBranchPushPayloadV1 {
  publicationId: string;
  checkpointFingerprint: string;
  checkpointStatus: "local_verified" | "push_prepared";
  handoffFingerprint: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  expectedRemoteSha: string | null;
  pushMode: "create" | "fast_forward";
}

export interface GitHubDraftPullRequestPayloadV1 {
  publicationId: string;
  checkpointFingerprint: string;
  checkpointStatus: "pushed_verified";
  handoffFingerprint: string;
  /** Exact predecessor push approval retained by the pushed checkpoint. */
  publishApprovalFingerprint: string;
  /** Fresh approval for this independently prepared draft-PR mutation. */
  workflowApprovalFingerprint: string;
  branch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  titleFingerprint: string;
  bodyFingerprint: string;
}

export interface GitHubReviewRepairFastForwardPayloadV1 {
  publicationId: string;
  checkpointFingerprint: string;
  checkpointStatus: "repair_required";
  workflowApprovalFingerprint: string;
  repairId: string;
  pullRequestNumber: number;
  branch: string;
  baseBranch: string;
  baseSha: string;
  expectedOldHeadSha: string;
  newHeadSha: string;
  previousHandoffFingerprint: string;
  handoffFingerprint: string;
}

export interface GitHubMergePayloadV1 {
  publicationId: string;
  checkpointFingerprint: string;
  checkpointStatus: "review_or_merge_ready";
  workflowApprovalFingerprint: string;
  pullRequestNumber: number;
  branch: string;
  headSha: string;
  baseBranch: string;
  baseSha: string;
  pullRequestUpdatedAt: string;
  proofSnapshotFingerprint: string;
  requiredChecksFingerprint: string;
  mergeMethod: "squash" | "merge" | "rebase";
}

interface PreparedBackgroundGitHubActionCommonV1 {
  version: typeof PREPARED_BACKGROUND_GITHUB_ACTION_VERSION;
  kind: "prepared_background_github_action";
  status: "prepared";
  id: string;
  missionId: string;
  graphRevision: number;
  capabilityEnvelopeFingerprint: string;
  nodeId: string;
  nodeFingerprint: string;
  executionHost: "companion" | "headless_runtime";
  descriptorFingerprint: string;
  preparedActionId: string;
  preparedActionFingerprint: string;
  binding: PreparedBackgroundGitHubBindingV1;
  authority: ConsumedBackgroundGitHubGrantV1;
  idempotencyKey: string;
  reconciliationKey: string;
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export type PreparedBackgroundGitHubActionV1 =
  | (PreparedBackgroundGitHubActionCommonV1 & {
      operation: typeof GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1;
      toolName: "github_publish_verified_branch";
      payload: GitHubVerifiedBranchPushPayloadV1;
    })
  | (PreparedBackgroundGitHubActionCommonV1 & {
      operation: typeof GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1;
      toolName: "github_create_draft_pull_request";
      payload: GitHubDraftPullRequestPayloadV1;
    })
  | (PreparedBackgroundGitHubActionCommonV1 & {
      operation: typeof GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1;
      toolName: "github_update_owned_branch";
      payload: GitHubReviewRepairFastForwardPayloadV1;
    })
  | (PreparedBackgroundGitHubActionCommonV1 & {
      operation: typeof GITHUB_PULL_REQUEST_MERGE_OPERATION_V1;
      toolName: "github_merge_pull_request";
      payload: GitHubMergePayloadV1;
    })
  | (PreparedBackgroundGitHubActionCommonV1 & {
      operation: typeof GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1;
      toolName: "github_enable_auto_merge";
      payload: GitHubMergePayloadV1;
    });

export type PreparedBackgroundGitHubActionDraftV1 =
  PreparedBackgroundGitHubActionV1 extends infer T
    ? T extends PreparedBackgroundGitHubActionV1
      ? Omit<T, "version" | "kind" | "status" | "fingerprint">
      : never
    : never;

export class PreparedBackgroundGitHubActionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedBackgroundGitHubActionErrorV1";
  }
}

export function createPreparedBackgroundGitHubActionV1(
  draft: PreparedBackgroundGitHubActionDraftV1,
): PreparedBackgroundGitHubActionV1 {
  const evidence = normalizeEvidence({
    version: PREPARED_BACKGROUND_GITHUB_ACTION_VERSION,
    kind: "prepared_background_github_action",
    status: "prepared",
    ...draft,
  });
  return {
    ...evidence,
    fingerprint: fingerprintBackgroundGitHubValueV1(evidence),
  } as PreparedBackgroundGitHubActionV1;
}

export function parsePreparedBackgroundGitHubActionV1(
  value: unknown,
): PreparedBackgroundGitHubActionV1 {
  const record = exactRecord(value, [
    "version",
    "kind",
    "operation",
    "status",
    "id",
    "missionId",
    "graphRevision",
    "capabilityEnvelopeFingerprint",
    "nodeId",
    "nodeFingerprint",
    "executionHost",
    "toolName",
    "descriptorFingerprint",
    "preparedActionId",
    "preparedActionFingerprint",
    "binding",
    "authority",
    "payload",
    "idempotencyKey",
    "reconciliationKey",
    "preparedAt",
    "expiresAt",
    "fingerprint",
  ], "prepared background GitHub action");
  const observed = sha256(record.fingerprint, "handoff fingerprint");
  const { fingerprint: _ignored, ...unsigned } = record;
  const evidence = normalizeEvidence(unsigned);
  if (observed !== fingerprintBackgroundGitHubValueV1(evidence)) {
    fail("Prepared background GitHub action fingerprint does not match its evidence.");
  }
  return { ...evidence, fingerprint: observed } as PreparedBackgroundGitHubActionV1;
}

/** Stable provider-attempt identity; never includes a credential value. */
export function backgroundGitHubActionAttemptIdV1(
  jobId: string,
  value: PreparedBackgroundGitHubActionV1,
): string {
  const action = parsePreparedBackgroundGitHubActionV1(value);
  return fingerprintBackgroundGitHubValueV1({
    version: 1,
    jobId: identifier(jobId, "companion job id"),
    operation: action.operation,
    actionFingerprint: action.fingerprint,
    preparedActionFingerprint: action.preparedActionFingerprint,
    reconciliationKey: action.reconciliationKey,
  });
}

/** Stable exact provider target shared by package/WAL reconciliation checks. */
export function backgroundGitHubTargetFingerprintV1(
  value: PreparedBackgroundGitHubActionV1,
): string {
  const action = parsePreparedBackgroundGitHubActionV1(value);
  return fingerprintBackgroundGitHubValueV1({
    operation: action.operation,
    publicationId: action.payload.publicationId,
    binding: action.binding.repositoryBindingFingerprint,
    accountId: action.binding.verifiedAccountId,
    payload: action.payload,
  });
}

export function fingerprintBackgroundGitHubValueV1(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function normalizeEvidence(
  value: unknown,
): Omit<PreparedBackgroundGitHubActionV1, "fingerprint"> {
  const record = exactRecord(value, [
    "version",
    "kind",
    "operation",
    "status",
    "id",
    "missionId",
    "graphRevision",
    "capabilityEnvelopeFingerprint",
    "nodeId",
    "nodeFingerprint",
    "executionHost",
    "toolName",
    "descriptorFingerprint",
    "preparedActionId",
    "preparedActionFingerprint",
    "binding",
    "authority",
    "payload",
    "idempotencyKey",
    "reconciliationKey",
    "preparedAt",
    "expiresAt",
  ], "prepared background GitHub action evidence");
  if (
    record.version !== PREPARED_BACKGROUND_GITHUB_ACTION_VERSION ||
    record.kind !== "prepared_background_github_action" ||
    record.status !== "prepared"
  ) {
    fail("Unsupported prepared background GitHub action contract.");
  }
  if (record.executionHost !== "companion" && record.executionHost !== "headless_runtime") {
    fail("Prepared background GitHub actions require a background execution host.");
  }
  const operation = githubOperation(record.operation);
  const expectedTool = toolForOperation(operation);
  if (record.toolName !== expectedTool) {
    fail("Prepared background GitHub operation does not match its fixed tool.");
  }
  const bindingRecord = exactRecord(record.binding, [
    "id",
    "destinationFingerprint",
    "repositoryBindingKey",
    "repositoryBindingFingerprint",
    "repositoryProfileKey",
    "repositoryProfileFingerprint",
    "owner",
    "repository",
    "repositoryId",
    "verifiedAccountId",
    "verifiedAccountLogin",
    "credentialReferenceId",
  ], "prepared background GitHub binding");
  const authorityRecord = exactRecord(record.authority, [
    "id",
    "authorityFingerprint",
    "actionFingerprint",
    "consumedAt",
    "expiresAt",
    "requiredConfirmations",
    "confirmationReceipts",
  ], "consumed background GitHub grant");
  const preparedAt = timestamp(record.preparedAt, "preparedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  const consumedAt = timestamp(authorityRecord.consumedAt, "authority consumedAt");
  const grantExpiresAt = timestamp(authorityRecord.expiresAt, "authority expiresAt");
  if (
    Date.parse(consumedAt) > Date.parse(preparedAt) ||
    Date.parse(expiresAt) <= Date.parse(preparedAt) ||
    Date.parse(expiresAt) > Date.parse(grantExpiresAt)
  ) {
    fail("Prepared background GitHub timestamps are outside the consumed grant lifetime.");
  }
  const preparedActionFingerprint = sha256(
    record.preparedActionFingerprint,
    "prepared action fingerprint",
  );
  if (
    sha256(authorityRecord.actionFingerprint, "authority action fingerprint") !==
    preparedActionFingerprint
  ) {
    fail("Consumed GitHub authority is bound to a different prepared action.");
  }
  const requiredConfirmations = integer(
    authorityRecord.requiredConfirmations,
    "required confirmations",
    1,
    2,
  ) as 1 | 2;
  const confirmationReceipts = hostApprovalReceipts(
    authorityRecord.confirmationReceipts,
  );
  const mergeOperation =
    operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 ||
    operation === GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1;
  if (
    requiredConfirmations !== (mergeOperation ? 2 : 1) ||
    confirmationReceipts.length !== requiredConfirmations
  ) {
    fail("GitHub merge and auto-merge require two exact confirmation receipts; other actions require one.");
  }
  const preparedActionId = identifier(record.preparedActionId, "prepared action id");
  const identity = confirmationReceipts[0];
  for (let index = 0; index < confirmationReceipts.length; index += 1) {
    const receipt = confirmationReceipts[index];
    if (
      receipt.decision !== "approved" ||
      receipt.preparedActionId !== preparedActionId ||
      receipt.preparedActionFingerprint !== preparedActionFingerprint ||
      receipt.requiredConfirmations !== requiredConfirmations ||
      receipt.confirmationOrdinal !== index + 1 ||
      Date.parse(receipt.decidedAt) > Date.parse(consumedAt)
    ) {
      fail("Host approval receipts are denied, unbound, out of order, or outside the consumed grant.");
    }
    if (
      receipt.hostInstanceFingerprint !== identity.hostInstanceFingerprint ||
      receipt.actorFingerprint !== identity.actorFingerprint ||
      receipt.sessionFingerprint !== identity.sessionFingerprint ||
      receipt.signingKeyFingerprint !== identity.signingKeyFingerprint
    ) {
      fail("Double-exact GitHub approval receipts must come from one stable host, actor, and session identity.");
    }
  }
  const idempotencyKey = boundedText(record.idempotencyKey, "idempotency key", 1, 512);
  const reconciliationKey = boundedText(record.reconciliationKey, "reconciliation key", 1, 512);
  if (idempotencyKey !== reconciliationKey) {
    fail("Background GitHub idempotency and reconciliation keys must match.");
  }

  const binding: PreparedBackgroundGitHubBindingV1 = {
    id: identifier(bindingRecord.id, "binding id"),
    destinationFingerprint: sha256(
      bindingRecord.destinationFingerprint,
      "binding destination fingerprint",
    ),
    repositoryBindingKey: identifier(
      bindingRecord.repositoryBindingKey,
      "repository binding key",
    ),
    repositoryBindingFingerprint: sha256(
      bindingRecord.repositoryBindingFingerprint,
      "repository binding fingerprint",
    ),
    repositoryProfileKey: identifier(
      bindingRecord.repositoryProfileKey,
      "repository profile key",
    ),
    repositoryProfileFingerprint: sha256(
      bindingRecord.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    owner: githubName(bindingRecord.owner, "GitHub owner"),
    repository: githubName(bindingRecord.repository, "GitHub repository"),
    repositoryId: integer(bindingRecord.repositoryId, "GitHub repository id", 1, Number.MAX_SAFE_INTEGER),
    verifiedAccountId: integer(
      bindingRecord.verifiedAccountId,
      "verified GitHub account id",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    verifiedAccountLogin: githubLogin(bindingRecord.verifiedAccountLogin),
    credentialReferenceId: credentialReference(bindingRecord.credentialReferenceId),
  };
  const payload = normalizePayload(operation, record.payload);
  if (
    operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
    (payload as GitHubDraftPullRequestPayloadV1).workflowApprovalFingerprint !==
      preparedActionFingerprint
  ) {
    fail("Draft pull-request authority is not bound to its own exact workflow approval fingerprint.");
  }
  if (
    operation !== GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 &&
    operation !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
    (payload as GitHubReviewRepairFastForwardPayloadV1 | GitHubMergePayloadV1)
      .workflowApprovalFingerprint !== preparedActionFingerprint
  ) {
    fail("GitHub review repair, merge, and auto-merge authority must bind the exact workflow approval fingerprint.");
  }
  return {
    version: PREPARED_BACKGROUND_GITHUB_ACTION_VERSION,
    kind: "prepared_background_github_action",
    operation,
    status: "prepared",
    id: identifier(record.id, "handoff id"),
    missionId: identifier(record.missionId, "mission id"),
    graphRevision: integer(record.graphRevision, "graph revision", 0, Number.MAX_SAFE_INTEGER),
    capabilityEnvelopeFingerprint: sha256(
      record.capabilityEnvelopeFingerprint,
      "capability envelope fingerprint",
    ),
    nodeId: identifier(record.nodeId, "node id"),
    nodeFingerprint: sha256(record.nodeFingerprint, "node fingerprint"),
    executionHost: record.executionHost,
    toolName: expectedTool,
    descriptorFingerprint: sha256(record.descriptorFingerprint, "descriptor fingerprint"),
    preparedActionId,
    preparedActionFingerprint,
    binding,
    authority: {
      id: identifier(authorityRecord.id, "authority grant id"),
      authorityFingerprint: sha256(
        authorityRecord.authorityFingerprint,
        "authority grant fingerprint",
      ),
      actionFingerprint: preparedActionFingerprint,
      consumedAt,
      expiresAt: grantExpiresAt,
      requiredConfirmations,
      confirmationReceipts,
    },
    payload,
    idempotencyKey,
    reconciliationKey,
    preparedAt,
    expiresAt,
  } as Omit<PreparedBackgroundGitHubActionV1, "fingerprint">;
}

function normalizePayload(
  operation: PreparedBackgroundGitHubOperationV1,
  value: unknown,
): PreparedBackgroundGitHubActionV1["payload"] {
  if (operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
    const record = exactRecord(value, [
      "publicationId", "checkpointFingerprint", "checkpointStatus", "handoffFingerprint",
      "branch", "baseBranch", "baseSha", "headSha", "expectedRemoteSha", "pushMode",
    ], "verified GitHub branch push payload");
    if (record.checkpointStatus !== "local_verified" && record.checkpointStatus !== "push_prepared") {
      fail("Verified branch push requires a local-verified or push-prepared checkpoint.");
    }
    if (record.pushMode !== "create" && record.pushMode !== "fast_forward") {
      fail("GitHub push mode is invalid.");
    }
    const expectedRemoteSha = record.expectedRemoteSha === null
      ? null
      : gitSha(record.expectedRemoteSha, "expected remote SHA");
    if ((record.pushMode === "create") !== (expectedRemoteSha === null)) {
      fail("A new branch requires no remote SHA; a fast-forward requires the exact old remote SHA.");
    }
    return {
      publicationId: identifier(record.publicationId, "publication id"),
      checkpointFingerprint: sha256(record.checkpointFingerprint, "checkpoint fingerprint"),
      checkpointStatus: record.checkpointStatus,
      handoffFingerprint: sha256(record.handoffFingerprint, "publication handoff fingerprint"),
      branch: agentBranch(record.branch),
      baseBranch: gitBranch(record.baseBranch, "base branch"),
      baseSha: gitSha(record.baseSha, "base SHA"),
      headSha: gitSha(record.headSha, "head SHA"),
      expectedRemoteSha,
      pushMode: record.pushMode,
    };
  }
  if (operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    const record = exactRecord(value, [
      "publicationId", "checkpointFingerprint", "checkpointStatus", "handoffFingerprint",
      "publishApprovalFingerprint", "workflowApprovalFingerprint", "branch", "headSha", "baseBranch", "baseSha",
      "titleFingerprint", "bodyFingerprint",
    ], "draft pull request payload");
    if (record.checkpointStatus !== "pushed_verified") {
      fail("Draft pull-request continuation requires a pushed-verified checkpoint.");
    }
    return {
      publicationId: identifier(record.publicationId, "publication id"),
      checkpointFingerprint: sha256(record.checkpointFingerprint, "checkpoint fingerprint"),
      checkpointStatus: "pushed_verified",
      handoffFingerprint: sha256(record.handoffFingerprint, "publication handoff fingerprint"),
      publishApprovalFingerprint: sha256(
        record.publishApprovalFingerprint,
        "publish approval fingerprint",
      ),
      workflowApprovalFingerprint: sha256(
        record.workflowApprovalFingerprint,
        "draft pull-request workflow approval fingerprint",
      ),
      branch: agentBranch(record.branch),
      headSha: gitSha(record.headSha, "head SHA"),
      baseBranch: gitBranch(record.baseBranch, "base branch"),
      baseSha: gitSha(record.baseSha, "base SHA"),
      titleFingerprint: sha256(record.titleFingerprint, "pull request title fingerprint"),
      bodyFingerprint: sha256(record.bodyFingerprint, "pull request body fingerprint"),
    };
  }
  if (operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    const record = exactRecord(value, [
      "publicationId", "checkpointFingerprint", "checkpointStatus",
      "workflowApprovalFingerprint", "repairId", "pullRequestNumber", "branch",
      "baseBranch", "baseSha", "expectedOldHeadSha", "newHeadSha",
      "previousHandoffFingerprint", "handoffFingerprint",
    ], "review repair fast-forward payload");
    if (record.checkpointStatus !== "repair_required") {
      fail("Review repair fast-forward requires a repair-required checkpoint.");
    }
    const expectedOldHeadSha = gitSha(record.expectedOldHeadSha, "old head SHA");
    const newHeadSha = gitSha(record.newHeadSha, "new head SHA");
    if (expectedOldHeadSha === newHeadSha) {
      fail("Review repair must advance the owned branch to a new head.");
    }
    return {
      publicationId: identifier(record.publicationId, "publication id"),
      checkpointFingerprint: sha256(record.checkpointFingerprint, "checkpoint fingerprint"),
      checkpointStatus: "repair_required",
      workflowApprovalFingerprint: sha256(
        record.workflowApprovalFingerprint,
        "review repair workflow approval fingerprint",
      ),
      repairId: identifier(record.repairId, "review repair id"),
      pullRequestNumber: integer(
        record.pullRequestNumber,
        "pull request number",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      branch: agentBranch(record.branch),
      baseBranch: gitBranch(record.baseBranch, "base branch"),
      baseSha: gitSha(record.baseSha, "base SHA"),
      expectedOldHeadSha,
      newHeadSha,
      previousHandoffFingerprint: sha256(
        record.previousHandoffFingerprint,
        "previous handoff fingerprint",
      ),
      handoffFingerprint: sha256(record.handoffFingerprint, "repair handoff fingerprint"),
    };
  }
  const record = exactRecord(value, [
    "publicationId", "checkpointFingerprint", "checkpointStatus",
    "workflowApprovalFingerprint", "pullRequestNumber", "branch", "headSha",
    "baseBranch", "baseSha", "pullRequestUpdatedAt", "proofSnapshotFingerprint",
    "requiredChecksFingerprint", "mergeMethod",
  ], "merge payload");
  if (record.checkpointStatus !== "review_or_merge_ready") {
    fail("Merge continuation requires a review-or-merge-ready checkpoint.");
  }
  if (record.mergeMethod !== "squash" && record.mergeMethod !== "merge" && record.mergeMethod !== "rebase") {
    fail("GitHub merge method is invalid.");
  }
  return {
    publicationId: identifier(record.publicationId, "publication id"),
    checkpointFingerprint: sha256(record.checkpointFingerprint, "checkpoint fingerprint"),
    checkpointStatus: "review_or_merge_ready",
    workflowApprovalFingerprint: sha256(
      record.workflowApprovalFingerprint,
      "merge workflow approval fingerprint",
    ),
    pullRequestNumber: integer(
      record.pullRequestNumber,
      "pull request number",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    branch: agentBranch(record.branch),
    headSha: gitSha(record.headSha, "head SHA"),
    baseBranch: gitBranch(record.baseBranch, "base branch"),
    baseSha: gitSha(record.baseSha, "base SHA"),
    pullRequestUpdatedAt: timestamp(record.pullRequestUpdatedAt, "pull request updatedAt"),
    proofSnapshotFingerprint: sha256(
      record.proofSnapshotFingerprint,
      "proof snapshot fingerprint",
    ),
    requiredChecksFingerprint: sha256(
      record.requiredChecksFingerprint,
      "required checks fingerprint",
    ),
    mergeMethod: record.mergeMethod,
  };
}

function githubOperation(value: unknown): PreparedBackgroundGitHubOperationV1 {
  if (
    value !== GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 &&
    value !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
    value !== GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 &&
    value !== GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 &&
    value !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1
  ) {
    fail("Prepared background GitHub operation is outside the fixed catalog.");
  }
  return value;
}

function toolForOperation(
  operation: PreparedBackgroundGitHubOperationV1,
): PreparedBackgroundGitHubToolNameV1 {
  switch (operation) {
    case GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1:
      return "github_publish_verified_branch";
    case GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1:
      return "github_create_draft_pull_request";
    case GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1:
      return "github_update_owned_branch";
    case GITHUB_PULL_REQUEST_MERGE_OPERATION_V1:
      return "github_merge_pull_request";
    case GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1:
      return "github_enable_auto_merge";
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} does not match its closed contract.`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 256);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(result) ||
    ["__proto__", "prototype", "constructor"].includes(result)
  ) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function githubName(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 100);
  if (!/^[A-Za-z0-9_.-]+$/u.test(result) || result === "." || result === "..") {
    fail(`${label} is invalid.`);
  }
  return result;
}

function githubLogin(value: unknown): string {
  const result = boundedText(value, "verified GitHub account login", 1, 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(result) || result.endsWith("-")) {
    fail("Verified GitHub account login is invalid.");
  }
  return result;
}

function credentialReference(value: unknown): string {
  const result = boundedText(value, "credential reference id", 16, 256);
  if (!/^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/u.test(result)) {
    fail("Background GitHub actions require an opaque secure-store credential reference.");
  }
  return result;
}

function agentBranch(value: unknown): string {
  const result = gitBranch(value, "agent branch");
  if (!result.startsWith("codex/") || result.length <= "codex/".length) {
    fail("Background GitHub branch mutations are limited to agent-owned codex/ branches.");
  }
  return result;
}

function gitBranch(value: unknown, label: string): string {
  const result = boundedText(value, label, 1, 255);
  if (
    result.startsWith("-") ||
    result.startsWith("/") ||
    result.endsWith("/") ||
    result.endsWith(".") ||
    result.includes("..") ||
    result.includes("//") ||
    result.includes("@{") ||
    /[\s~^:?*[\\\]]/u.test(result)
  ) {
    fail(`${label} is invalid.`);
  }
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = boundedText(value, label, 40, 64).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) {
    fail(`${label} must be a complete Git object id.`);
  }
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = boundedText(value, label, 71, 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) {
    fail(`${label} must be a SHA-256 fingerprint.`);
  }
  return result;
}

function hostApprovalReceipts(value: unknown): HostApprovalReceiptV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    fail("Host approval receipt list is invalid.");
  }
  const receipts = value.map(parseHostApprovalReceiptV1).sort(
    (left, right) => left.confirmationOrdinal - right.confirmationOrdinal,
  );
  if (
    new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length ||
    new Set(receipts.map((receipt) => receipt.fingerprint)).size !== receipts.length ||
    new Set(receipts.map((receipt) => receipt.confirmationOrdinal)).size !== receipts.length
  ) {
    fail("Host approval receipt list must contain distinct receipts and confirmation ordinals.");
  }
  return receipts;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  const result = boundedText(value, label, 20, 40);
  if (!Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return result;
}

function boundedText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} must be bounded text.`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail("Prepared background GitHub evidence contains an unsafe number.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    fail("Prepared background GitHub evidence contains an unsupported value.");
  }
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function fail(message: string): never {
  throw new PreparedBackgroundGitHubActionErrorV1(message);
}
