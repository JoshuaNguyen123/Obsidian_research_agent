import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
  backgroundGitHubActionAttemptIdV1,
  backgroundGitHubTargetFingerprintV1,
  fingerprintBackgroundGitHubValueV1,
  parsePreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubOperationV1,
} from "../../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import {
  parseVerifiedCodePublicationHandoffV1,
  type VerifiedCodePublicationHandoffV1,
} from "../../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import {
  createPreparedBackgroundGitHubPackageIdentityV1,
  type PreparedBackgroundGitHubPackageIdentityV1,
} from "../../../packages/core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import {
  parseGitHubPublicationCheckpointV1,
} from "../../../src/integrations/github/GitHubPublicationCheckpointStore";
import type {
  GitHubMergeMethodV1,
  GitHubPublicationCheckpointV1,
} from "../../../src/integrations/github/GitHubPublicationWorkflow";
import {
  parseTrustedGitHubRepositoryBindingV1,
  type TrustedGitHubRepositoryBindingV1,
} from "../../../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  ensureSafeCompanionDirectoryV1,
  readSafeCompanionFileV1,
  validateCompanionAppDataRootV1,
  writeSafeCompanionFileAtomicV1,
} from "./SafeCompanionAppDataV1";
import {
  parseBackgroundGitHubActionAttemptV1,
  type BackgroundGitHubActionAttemptStoreV1,
} from "./BackgroundGitHubAttemptStoreV1";

export const PREPARED_BACKGROUND_GITHUB_PACKAGE_VERSION = 1 as const;

const PACKAGE_DIRECTORY = "prepared-background-github-v1";
const MAX_PACKAGE_BYTES = 128 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface BackgroundGitHubRepositoryProofV1 {
  version: 1;
  kind: "background_github_repository_proof";
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalRepositoryRoot: string;
  defaultBranch: string;
  requiredChecks: string[];
  requiredChecksFingerprint: string;
  mergeMethod: GitHubMergeMethodV1;
  forbidForcePush: true;
  fingerprint: string;
}

export interface BackgroundGitHubPullRequestDocumentV1 {
  title: string;
  body: string;
  titleFingerprint: string;
  bodyFingerprint: string;
}

/**
 * Local-only immutable effect plan. Unlike the remote action, this companion
 * app-data record contains the canonical worktree proof and fixed PR document
 * needed to continue while Obsidian is unavailable. It still cannot contain a
 * token, arbitrary command, review prose, or provider endpoint.
 */
export interface BackgroundGitHubLocalOperationPlanV1 {
  version: 1;
  kind: "background_github_local_operation_plan";
  repositoryBinding: TrustedGitHubRepositoryBindingV1;
  repositoryProof: BackgroundGitHubRepositoryProofV1;
  checkpoint: GitHubPublicationCheckpointV1;
  checkpointFingerprint: string;
  verifiedCodeHandoff: VerifiedCodePublicationHandoffV1 | null;
  pullRequestDocument: BackgroundGitHubPullRequestDocumentV1 | null;
  fingerprint: string;
}

/**
 * Integrations-owned, restart-safe package. Remote jobs carry only the closed
 * action proof; this local package is the self-sufficient effect input source.
 */
export interface PreparedBackgroundGitHubPackageV1 {
  version: typeof PREPARED_BACKGROUND_GITHUB_PACKAGE_VERSION;
  kind: "prepared_background_github_package";
  id: string;
  jobId: string;
  backgroundAuthorizationFingerprint: string;
  missionId: string;
  nodeId: string;
  operation: PreparedBackgroundGitHubOperationV1;
  publicationId: string;
  actionFingerprint: string;
  preparedActionFingerprint: string;
  repositoryBindingFingerprint: string;
  repositoryProfileFingerprint: string;
  verifiedAccountId: number;
  handoffFingerprint: string;
  preparedAt: string;
  expiresAt: string;
  action: PreparedBackgroundGitHubActionV1;
  localPlan: BackgroundGitHubLocalOperationPlanV1;
  fingerprint: string;
}

export interface PreparedBackgroundGitHubPackageRequirementsV1 {
  packageId: string;
  packageFingerprint: string;
  jobId: string;
  backgroundAuthorizationFingerprint: string;
  actionFingerprint: string;
  operation: PreparedBackgroundGitHubOperationV1;
  publicationId: string;
  repositoryBindingFingerprint: string;
  repositoryProfileFingerprint: string;
  verifiedAccountId: number;
}

export interface PreparedBackgroundGitHubPackagePersistenceReceiptV1 {
  version: 1;
  kind: "prepared_background_github_package_persisted";
  packageId: string;
  packageFingerprint: string;
  fileSha256: string;
  bytes: number;
  persistedAt: string;
  readbackVerified: true;
  fingerprint: string;
}

export interface PreparedBackgroundGitHubPackageStoreOptionsV1 {
  applicationDataRoot: string;
  now?: () => Date;
  randomId?: () => string;
}

export interface PreparedBackgroundGitHubPackageLoadOptionsV1 {
  /**
   * Required only after expiry. The store itself reads and validates the exact
   * durable pre-expiry dispatch marker; caller-supplied marker objects are not
   * accepted as proof.
   */
  reconciliationAttempts?: Pick<BackgroundGitHubActionAttemptStoreV1, "load">;
}

export class PreparedBackgroundGitHubPackageStoreErrorV1 extends Error {
  constructor(
    readonly code:
      | "unsafe_application_root"
      | "vault_storage_forbidden"
      | "package_conflict"
      | "package_missing"
      | "package_invalid"
      | "package_expired",
    message: string,
  ) {
    super(message);
    this.name = "PreparedBackgroundGitHubPackageStoreErrorV1";
  }
}

export function createPreparedBackgroundGitHubPackageV1(input: {
  jobId: string;
  backgroundAuthorizationFingerprint: string;
  action: PreparedBackgroundGitHubActionV1;
  repositoryBinding: TrustedGitHubRepositoryBindingV1;
  repositoryProof: BackgroundGitHubRepositoryProofV1;
  checkpoint: GitHubPublicationCheckpointV1;
  verifiedCodeHandoff?: VerifiedCodePublicationHandoffV1 | null;
  pullRequestDocument?: BackgroundGitHubPullRequestDocumentV1 | null;
}): PreparedBackgroundGitHubPackageV1 {
  const action = parsePreparedBackgroundGitHubActionV1(input.action);
  const localPlan = createBackgroundGitHubLocalOperationPlanV1({
    action,
    repositoryBinding: input.repositoryBinding,
    repositoryProof: input.repositoryProof,
    checkpoint: input.checkpoint,
    verifiedCodeHandoff: input.verifiedCodeHandoff ?? null,
    pullRequestDocument: input.pullRequestDocument ?? null,
  });
  const evidence: Omit<PreparedBackgroundGitHubPackageV1, "fingerprint"> = {
    version: PREPARED_BACKGROUND_GITHUB_PACKAGE_VERSION,
    kind: "prepared_background_github_package",
    id: `github-package-${action.fingerprint.slice("sha256:".length, "sha256:".length + 40)}`,
    jobId: identifier(input.jobId, "companion job id"),
    backgroundAuthorizationFingerprint: fingerprint(
      input.backgroundAuthorizationFingerprint,
      "background authorization fingerprint",
    ),
    missionId: action.missionId,
    nodeId: action.nodeId,
    operation: action.operation,
    publicationId: action.payload.publicationId,
    actionFingerprint: action.fingerprint,
    preparedActionFingerprint: action.preparedActionFingerprint,
    repositoryBindingFingerprint: action.binding.repositoryBindingFingerprint,
    repositoryProfileFingerprint: action.binding.repositoryProfileFingerprint,
    verifiedAccountId: action.binding.verifiedAccountId,
    handoffFingerprint: handoffFingerprint(action),
    preparedAt: action.preparedAt,
    expiresAt: action.expiresAt,
    action,
    localPlan,
  };
  return { ...evidence, fingerprint: fingerprintBackgroundGitHubValueV1(evidence) };
}

export function createPreparedBackgroundGitHubPackageIdentityFromPackageV1(
  packageInput: PreparedBackgroundGitHubPackageV1,
): PreparedBackgroundGitHubPackageIdentityV1 {
  const preparedPackage = parsePreparedBackgroundGitHubPackageV1(packageInput);
  return createPreparedBackgroundGitHubPackageIdentityV1({
    packageId: preparedPackage.id,
    packageFingerprint: preparedPackage.fingerprint,
    actionFingerprint: preparedPackage.actionFingerprint,
    preparedActionFingerprint: preparedPackage.preparedActionFingerprint,
    operation: preparedPackage.operation,
    publicationId: preparedPackage.publicationId,
    repositoryBindingFingerprint: preparedPackage.repositoryBindingFingerprint,
    repositoryProfileFingerprint: preparedPackage.repositoryProfileFingerprint,
    verifiedAccountId: preparedPackage.verifiedAccountId,
    backgroundAuthorizationFingerprint: preparedPackage.backgroundAuthorizationFingerprint,
    preparedAt: preparedPackage.preparedAt,
    expiresAt: preparedPackage.expiresAt,
  });
}

export function parsePreparedBackgroundGitHubPackageV1(
  value: unknown,
): PreparedBackgroundGitHubPackageV1 {
  const record = exactRecord(value, [
    "version", "kind", "id", "jobId", "backgroundAuthorizationFingerprint",
    "missionId", "nodeId", "operation", "publicationId", "actionFingerprint",
    "preparedActionFingerprint", "repositoryBindingFingerprint",
    "repositoryProfileFingerprint", "verifiedAccountId", "handoffFingerprint",
    "preparedAt", "expiresAt", "action", "localPlan", "fingerprint",
  ], "prepared background GitHub package");
  const action = parsePreparedBackgroundGitHubActionV1(record.action);
  const localPlan = parseBackgroundGitHubLocalOperationPlanV1(record.localPlan, action);
  const observedFingerprint = fingerprint(record.fingerprint, "package fingerprint");
  const evidence: Omit<PreparedBackgroundGitHubPackageV1, "fingerprint"> = {
    version: version(record.version),
    kind: kind(record.kind),
    id: identifier(record.id, "package id"),
    jobId: identifier(record.jobId, "companion job id"),
    backgroundAuthorizationFingerprint: fingerprint(
      record.backgroundAuthorizationFingerprint,
      "background authorization fingerprint",
    ),
    missionId: identifier(record.missionId, "mission id"),
    nodeId: identifier(record.nodeId, "node id"),
    operation: action.operation,
    publicationId: identifier(record.publicationId, "publication id"),
    actionFingerprint: fingerprint(record.actionFingerprint, "action fingerprint"),
    preparedActionFingerprint: fingerprint(
      record.preparedActionFingerprint,
      "prepared action fingerprint",
    ),
    repositoryBindingFingerprint: fingerprint(
      record.repositoryBindingFingerprint,
      "repository binding fingerprint",
    ),
    repositoryProfileFingerprint: fingerprint(
      record.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    verifiedAccountId: positiveInteger(record.verifiedAccountId, "verified account id"),
    handoffFingerprint: fingerprint(record.handoffFingerprint, "handoff fingerprint"),
    preparedAt: timestamp(record.preparedAt, "preparedAt"),
    expiresAt: timestamp(record.expiresAt, "expiresAt"),
    action,
    localPlan,
  };
  if (
    evidence.id !== `github-package-${action.fingerprint.slice("sha256:".length, "sha256:".length + 40)}` ||
    evidence.missionId !== action.missionId ||
    evidence.nodeId !== action.nodeId ||
    record.operation !== action.operation ||
    evidence.publicationId !== action.payload.publicationId ||
    evidence.actionFingerprint !== action.fingerprint ||
    evidence.preparedActionFingerprint !== action.preparedActionFingerprint ||
    evidence.repositoryBindingFingerprint !== action.binding.repositoryBindingFingerprint ||
    evidence.repositoryProfileFingerprint !== action.binding.repositoryProfileFingerprint ||
    evidence.verifiedAccountId !== action.binding.verifiedAccountId ||
    evidence.handoffFingerprint !== handoffFingerprint(action) ||
    evidence.preparedAt !== action.preparedAt ||
    evidence.expiresAt !== action.expiresAt
  ) {
    invalid("Prepared background GitHub package drifted from its exact action proof.");
  }
  if (observedFingerprint !== fingerprintBackgroundGitHubValueV1(evidence)) {
    invalid("Prepared background GitHub package fingerprint does not match its evidence.");
  }
  return { ...evidence, fingerprint: observedFingerprint };
}

export function createBackgroundGitHubRepositoryProofV1(input: {
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  canonicalRepositoryRoot: string;
  defaultBranch: string;
  requiredChecks: readonly string[];
  mergeMethod: GitHubMergeMethodV1;
}): BackgroundGitHubRepositoryProofV1 {
  const requiredChecks = uniqueText(input.requiredChecks, "required GitHub check", 64, 200);
  const evidence: Omit<BackgroundGitHubRepositoryProofV1, "fingerprint"> = {
    version: 1,
    kind: "background_github_repository_proof",
    repositoryProfileKey: identifier(input.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: fingerprint(
      input.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    canonicalRepositoryRoot: absolutePath(input.canonicalRepositoryRoot),
    defaultBranch: gitBranch(input.defaultBranch, "default branch"),
    requiredChecks,
    requiredChecksFingerprint: fingerprintBackgroundGitHubValueV1(requiredChecks),
    mergeMethod: mergeMethod(input.mergeMethod),
    forbidForcePush: true,
  };
  return { ...evidence, fingerprint: fingerprintBackgroundGitHubValueV1(evidence) };
}

export function parseBackgroundGitHubLocalOperationPlanV1(
  value: unknown,
  actionInput?: PreparedBackgroundGitHubActionV1,
): BackgroundGitHubLocalOperationPlanV1 {
  const record = exactRecord(value, [
    "version", "kind", "repositoryBinding", "repositoryProof", "checkpoint",
    "checkpointFingerprint", "verifiedCodeHandoff", "pullRequestDocument", "fingerprint",
  ], "background GitHub local operation plan");
  if (record.version !== 1 || record.kind !== "background_github_local_operation_plan") {
    invalid("Unsupported background GitHub local operation plan.");
  }
  const repositoryBinding = parseTrustedGitHubRepositoryBindingV1(record.repositoryBinding);
  const repositoryProof = parseRepositoryProof(record.repositoryProof);
  const checkpoint = parseGitHubPublicationCheckpointV1(record.checkpoint);
  const checkpointFingerprint = fingerprint(
    record.checkpointFingerprint,
    "local checkpoint fingerprint",
  );
  if (checkpointFingerprint !== fingerprintBackgroundGitHubValueV1(checkpoint)) {
    invalid("Local GitHub checkpoint fingerprint does not match its snapshot.");
  }
  const verifiedCodeHandoff = record.verifiedCodeHandoff === null
    ? null
    : parseVerifiedCodePublicationHandoffV1(record.verifiedCodeHandoff);
  const pullRequestDocument = record.pullRequestDocument === null
    ? null
    : parsePullRequestDocument(record.pullRequestDocument);
  const observed = fingerprint(record.fingerprint, "local operation plan fingerprint");
  const evidence: Omit<BackgroundGitHubLocalOperationPlanV1, "fingerprint"> = {
    version: 1,
    kind: "background_github_local_operation_plan",
    repositoryBinding,
    repositoryProof,
    checkpoint,
    checkpointFingerprint,
    verifiedCodeHandoff,
    pullRequestDocument,
  };
  if (observed !== fingerprintBackgroundGitHubValueV1(evidence)) {
    invalid("Background GitHub local operation plan fingerprint does not match its evidence.");
  }
  if (actionInput) validateLocalPlanAgainstAction(actionInput, evidence);
  return { ...evidence, fingerprint: observed };
}

function createBackgroundGitHubLocalOperationPlanV1(input: {
  action: PreparedBackgroundGitHubActionV1;
  repositoryBinding: TrustedGitHubRepositoryBindingV1;
  repositoryProof: BackgroundGitHubRepositoryProofV1;
  checkpoint: GitHubPublicationCheckpointV1;
  verifiedCodeHandoff: VerifiedCodePublicationHandoffV1 | null;
  pullRequestDocument: BackgroundGitHubPullRequestDocumentV1 | null;
}): BackgroundGitHubLocalOperationPlanV1 {
  const repositoryBinding = parseTrustedGitHubRepositoryBindingV1(input.repositoryBinding);
  const repositoryProof = parseRepositoryProof(input.repositoryProof);
  const checkpoint = parseGitHubPublicationCheckpointV1(input.checkpoint);
  const verifiedCodeHandoff = input.verifiedCodeHandoff === null
    ? null
    : parseVerifiedCodePublicationHandoffV1(input.verifiedCodeHandoff);
  const pullRequestDocument = input.pullRequestDocument === null
    ? null
    : parsePullRequestDocument(input.pullRequestDocument);
  const evidence: Omit<BackgroundGitHubLocalOperationPlanV1, "fingerprint"> = {
    version: 1,
    kind: "background_github_local_operation_plan",
    repositoryBinding,
    repositoryProof,
    checkpoint,
    checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
    verifiedCodeHandoff,
    pullRequestDocument,
  };
  validateLocalPlanAgainstAction(input.action, evidence);
  return { ...evidence, fingerprint: fingerprintBackgroundGitHubValueV1(evidence) };
}

export class PreparedBackgroundGitHubPackageStoreV1 {
  readonly applicationDataRoot: string;
  readonly packageRoot: string;

  private readonly now: () => Date;
  private readonly randomId: () => string;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: PreparedBackgroundGitHubPackageStoreOptionsV1) {
    try {
      this.applicationDataRoot = validateCompanionAppDataRootV1(options.applicationDataRoot);
    } catch (error) {
      throw new PreparedBackgroundGitHubPackageStoreErrorV1(
        /vault|obsidian/iu.test(error instanceof Error ? error.message : "")
          ? "vault_storage_forbidden"
          : "unsafe_application_root",
        error instanceof Error ? error.message : "Prepared GitHub package root is unsafe.",
      );
    }
    this.packageRoot = path.join(this.applicationDataRoot, PACKAGE_DIRECTORY);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  async persist(packageInput: PreparedBackgroundGitHubPackageV1): Promise<{
    package: PreparedBackgroundGitHubPackageV1;
    receipt: PreparedBackgroundGitHubPackagePersistenceReceiptV1;
  }> {
    return this.serialized(async () => {
      const preparedPackage = parsePreparedBackgroundGitHubPackageV1(packageInput);
      assertUnexpired(preparedPackage, this.now());
      await ensureSafeCompanionDirectoryV1(this.applicationDataRoot, this.packageRoot);
      const finalPath = this.packagePath(preparedPackage.id);
      const existing = await this.readPackage(finalPath, true);
      if (existing && existing.fingerprint !== preparedPackage.fingerprint) {
        throw new PreparedBackgroundGitHubPackageStoreErrorV1(
          "package_conflict",
          "A different prepared GitHub package already owns this identity.",
        );
      }
      if (!existing) {
        const bytes = Buffer.from(`${JSON.stringify(preparedPackage)}\n`, "utf8");
        if (bytes.byteLength > MAX_PACKAGE_BYTES) invalid("Prepared GitHub package exceeds its byte limit.");
        await writeSafeCompanionFileAtomicV1({
          applicationDataRoot: this.applicationDataRoot,
          directory: this.packageRoot,
          finalPath,
          bytes,
          maximumBytes: MAX_PACKAGE_BYTES,
          temporaryToken: this.randomId(),
        });
      }
      const readbackBytes = await readSafeCompanionFileV1({
        applicationDataRoot: this.applicationDataRoot,
        filePath: finalPath,
        maximumBytes: MAX_PACKAGE_BYTES,
      });
      if (!readbackBytes) invalid("Stored GitHub package disappeared before readback.");
      if (readbackBytes.byteLength > MAX_PACKAGE_BYTES) invalid("Stored GitHub package exceeds its byte limit.");
      const readback = parsePreparedBackgroundGitHubPackageV1(
        JSON.parse(readbackBytes.toString("utf8")) as unknown,
      );
      if (readback.fingerprint !== preparedPackage.fingerprint) {
        invalid("Stored GitHub package failed exact readback verification.");
      }
      const persistedAt = this.now().toISOString();
      const receiptEvidence: Omit<PreparedBackgroundGitHubPackagePersistenceReceiptV1, "fingerprint"> = {
        version: 1,
        kind: "prepared_background_github_package_persisted",
        packageId: readback.id,
        packageFingerprint: readback.fingerprint,
        fileSha256: `sha256:${createHash("sha256").update(readbackBytes).digest("hex")}`,
        bytes: readbackBytes.byteLength,
        persistedAt,
        readbackVerified: true,
      };
      return {
        package: readback,
        receipt: {
          ...receiptEvidence,
          fingerprint: fingerprintBackgroundGitHubValueV1(receiptEvidence),
        },
      };
    });
  }

  async load(
    requirementsInput: PreparedBackgroundGitHubPackageRequirementsV1,
    options: PreparedBackgroundGitHubPackageLoadOptionsV1 = {},
  ): Promise<PreparedBackgroundGitHubPackageV1> {
    return this.serialized(async () => {
      const requirements = normalizeRequirements(requirementsInput);
      await ensureSafeCompanionDirectoryV1(this.applicationDataRoot, this.packageRoot);
      const preparedPackage = await this.readPackage(this.packagePath(requirements.packageId), false);
      if (!preparedPackage) {
        throw new PreparedBackgroundGitHubPackageStoreErrorV1(
          "package_missing",
          "Prepared background GitHub package is missing.",
        );
      }
      if (
        preparedPackage.fingerprint !== requirements.packageFingerprint ||
        preparedPackage.jobId !== requirements.jobId ||
        preparedPackage.backgroundAuthorizationFingerprint !== requirements.backgroundAuthorizationFingerprint ||
        preparedPackage.actionFingerprint !== requirements.actionFingerprint ||
        preparedPackage.operation !== requirements.operation ||
        preparedPackage.publicationId !== requirements.publicationId ||
        preparedPackage.repositoryBindingFingerprint !== requirements.repositoryBindingFingerprint ||
        preparedPackage.repositoryProfileFingerprint !== requirements.repositoryProfileFingerprint ||
        preparedPackage.verifiedAccountId !== requirements.verifiedAccountId
      ) {
        invalid("Prepared background GitHub package does not match the exact worker scope.");
      }
      if (Date.parse(preparedPackage.expiresAt) <= this.now().getTime()) {
        await assertExactPriorDispatchForExpiredLoad(
          preparedPackage,
          options.reconciliationAttempts,
        );
      }
      return preparedPackage;
    });
  }

  private packagePath(id: string): string {
    return path.join(this.packageRoot, `${identifier(id, "package id")}.json`);
  }

  private async readPackage(
    filePath: string,
    allowMissing: boolean,
  ): Promise<PreparedBackgroundGitHubPackageV1 | null> {
    const bytes = await readSafeCompanionFileV1({
      applicationDataRoot: this.applicationDataRoot,
      filePath,
      maximumBytes: MAX_PACKAGE_BYTES,
      allowMissing,
    });
    if (!bytes) return null;
    if (bytes.byteLength > MAX_PACKAGE_BYTES) invalid("Stored GitHub package exceeds its byte limit.");
    try {
      return parsePreparedBackgroundGitHubPackageV1(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      if (error instanceof PreparedBackgroundGitHubPackageStoreErrorV1) throw error;
      invalid(error instanceof Error ? error.message : "Stored GitHub package is invalid.");
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeRequirements(
  value: PreparedBackgroundGitHubPackageRequirementsV1,
): PreparedBackgroundGitHubPackageRequirementsV1 {
  return {
    packageId: identifier(value.packageId, "package id"),
    packageFingerprint: fingerprint(value.packageFingerprint, "package fingerprint"),
    jobId: identifier(value.jobId, "companion job id"),
    backgroundAuthorizationFingerprint: fingerprint(
      value.backgroundAuthorizationFingerprint,
      "background authorization fingerprint",
    ),
    actionFingerprint: fingerprint(value.actionFingerprint, "action fingerprint"),
    operation: operation(value.operation),
    publicationId: identifier(value.publicationId, "publication id"),
    repositoryBindingFingerprint: fingerprint(
      value.repositoryBindingFingerprint,
      "repository binding fingerprint",
    ),
    repositoryProfileFingerprint: fingerprint(
      value.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    verifiedAccountId: positiveInteger(value.verifiedAccountId, "verified account id"),
  } as PreparedBackgroundGitHubPackageRequirementsV1;
}

function parseRepositoryProof(value: unknown): BackgroundGitHubRepositoryProofV1 {
  const record = exactRecord(value, [
    "version", "kind", "repositoryProfileKey", "repositoryProfileFingerprint",
    "canonicalRepositoryRoot", "defaultBranch", "requiredChecks",
    "requiredChecksFingerprint", "mergeMethod", "forbidForcePush", "fingerprint",
  ], "background GitHub repository proof");
  if (
    record.version !== 1 ||
    record.kind !== "background_github_repository_proof" ||
    record.forbidForcePush !== true
  ) {
    invalid("Unsupported background GitHub repository proof.");
  }
  const requiredChecks = uniqueText(record.requiredChecks, "required GitHub check", 64, 200);
  const observed = fingerprint(record.fingerprint, "repository proof fingerprint");
  const evidence: Omit<BackgroundGitHubRepositoryProofV1, "fingerprint"> = {
    version: 1,
    kind: "background_github_repository_proof",
    repositoryProfileKey: identifier(record.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: fingerprint(
      record.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    canonicalRepositoryRoot: absolutePath(record.canonicalRepositoryRoot),
    defaultBranch: gitBranch(record.defaultBranch, "default branch"),
    requiredChecks,
    requiredChecksFingerprint: fingerprint(
      record.requiredChecksFingerprint,
      "required checks fingerprint",
    ),
    mergeMethod: mergeMethod(record.mergeMethod),
    forbidForcePush: true,
  };
  if (
    evidence.requiredChecksFingerprint !== fingerprintBackgroundGitHubValueV1(requiredChecks) ||
    observed !== fingerprintBackgroundGitHubValueV1(evidence)
  ) {
    invalid("Background GitHub repository proof fingerprint is invalid.");
  }
  return { ...evidence, fingerprint: observed };
}

function parsePullRequestDocument(value: unknown): BackgroundGitHubPullRequestDocumentV1 {
  const record = exactRecord(value, [
    "title", "body", "titleFingerprint", "bodyFingerprint",
  ], "background GitHub pull-request document");
  const title = boundedMultilineText(record.title, "pull request title", 1, 256, false);
  const body = boundedMultilineText(record.body, "pull request body", 1, 65_536, true);
  rejectCredentialMaterial(title, "pull request title");
  rejectCredentialMaterial(body, "pull request body");
  const result: BackgroundGitHubPullRequestDocumentV1 = {
    title,
    body,
    titleFingerprint: fingerprint(record.titleFingerprint, "pull request title fingerprint"),
    bodyFingerprint: fingerprint(record.bodyFingerprint, "pull request body fingerprint"),
  };
  if (
    result.titleFingerprint !== fingerprintBackgroundGitHubValueV1(title) ||
    result.bodyFingerprint !== fingerprintBackgroundGitHubValueV1(body)
  ) {
    invalid("Pull-request document fingerprints do not match the fixed local text.");
  }
  return result;
}

function validateLocalPlanAgainstAction(
  action: PreparedBackgroundGitHubActionV1,
  plan: Omit<BackgroundGitHubLocalOperationPlanV1, "fingerprint">,
): void {
  const { repositoryBinding: binding, repositoryProof: proof, checkpoint } = plan;
  if (
    binding.key !== action.binding.repositoryBindingKey ||
    binding.fingerprint !== action.binding.repositoryBindingFingerprint ||
    binding.repositoryProfileKey !== action.binding.repositoryProfileKey ||
    binding.repositoryProfileFingerprint !== action.binding.repositoryProfileFingerprint ||
    binding.owner !== action.binding.owner ||
    binding.repository !== action.binding.repository ||
    binding.repositoryId !== action.binding.repositoryId ||
    binding.verifiedAccountId !== action.binding.verifiedAccountId ||
    binding.verifiedAccountLogin !== action.binding.verifiedAccountLogin ||
    proof.repositoryProfileKey !== binding.repositoryProfileKey ||
    proof.repositoryProfileFingerprint !== binding.repositoryProfileFingerprint ||
    proof.canonicalRepositoryRoot !== binding.canonicalRepositoryRoot ||
    proof.defaultBranch !== binding.defaultBranch ||
    checkpoint.publicationId !== action.payload.publicationId ||
    checkpoint.bindingFingerprint !== binding.fingerprint ||
    plan.checkpointFingerprint !== action.payload.checkpointFingerprint ||
    checkpoint.status !== action.payload.checkpointStatus
  ) {
    invalid("Local background GitHub plan drifted from its repository, account, or checkpoint authority.");
  }

  if (action.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
    const handoff = requiredHandoff(plan.verifiedCodeHandoff, action.operation);
    if (
      plan.pullRequestDocument !== null ||
      handoff.fingerprint !== action.payload.handoffFingerprint ||
      handoff.repositoryProfileKey !== proof.repositoryProfileKey ||
      handoff.repositoryProfileFingerprint !== proof.repositoryProfileFingerprint ||
      handoff.branch !== action.payload.branch ||
      handoff.baseBranch !== action.payload.baseBranch ||
      handoff.baseSha !== action.payload.baseSha ||
      handoff.commitSha !== action.payload.headSha ||
      checkpoint.branch !== action.payload.branch ||
      checkpoint.headSha !== action.payload.headSha ||
      checkpoint.handoffFingerprint !== action.payload.handoffFingerprint
    ) {
      invalid("Local verified-push plan does not match the exact verified worktree handoff.");
    }
    return;
  }

  if (action.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    const document = plan.pullRequestDocument;
    if (
      plan.verifiedCodeHandoff !== null ||
      !document ||
      document.titleFingerprint !== action.payload.titleFingerprint ||
      document.bodyFingerprint !== action.payload.bodyFingerprint ||
      checkpoint.handoffFingerprint !== action.payload.handoffFingerprint ||
      checkpoint.publishApprovalFingerprint !== action.payload.publishApprovalFingerprint ||
      checkpoint.branch !== action.payload.branch ||
      checkpoint.headSha !== action.payload.headSha ||
      checkpoint.remoteSha !== action.payload.headSha ||
      proof.defaultBranch !== action.payload.baseBranch
    ) {
      invalid("Local draft pull-request plan does not match the pushed checkpoint and fixed document.");
    }
    return;
  }

  if (action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    const handoff = requiredHandoff(plan.verifiedCodeHandoff, action.operation);
    const pullRequest = checkpoint.pullRequest;
    if (
      plan.pullRequestDocument !== null ||
      handoff.fingerprint !== action.payload.handoffFingerprint ||
      handoff.repositoryProfileKey !== proof.repositoryProfileKey ||
      handoff.repositoryProfileFingerprint !== proof.repositoryProfileFingerprint ||
      handoff.branch !== action.payload.branch ||
      handoff.baseBranch !== action.payload.baseBranch ||
      handoff.baseSha !== action.payload.expectedOldHeadSha ||
      handoff.commitSha !== action.payload.newHeadSha ||
      checkpoint.handoffFingerprint !== action.payload.previousHandoffFingerprint ||
      checkpoint.headSha !== action.payload.expectedOldHeadSha ||
      !pullRequest ||
      pullRequest.number !== action.payload.pullRequestNumber ||
      pullRequest.head.ref !== action.payload.branch ||
      pullRequest.head.sha !== action.payload.expectedOldHeadSha ||
      pullRequest.base.ref !== action.payload.baseBranch
    ) {
      invalid("Local review-repair plan does not match the exact owned PR and verified descendant.");
    }
    return;
  }

  const pullRequest = checkpoint.pullRequest;
  const snapshot = checkpoint.proofSnapshot;
  if (
    plan.verifiedCodeHandoff !== null ||
    plan.pullRequestDocument !== null ||
    !pullRequest ||
    !snapshot ||
    pullRequest.number !== action.payload.pullRequestNumber ||
    pullRequest.state !== "open" ||
    pullRequest.draft ||
    pullRequest.merged ||
    pullRequest.head.ref !== action.payload.branch ||
    pullRequest.head.sha !== action.payload.headSha ||
    pullRequest.base.ref !== action.payload.baseBranch ||
    pullRequest.base.sha !== action.payload.baseSha ||
    pullRequest.updatedAt !== action.payload.pullRequestUpdatedAt ||
    snapshot.headSha !== action.payload.headSha ||
    snapshot.snapshotFingerprint !== action.payload.proofSnapshotFingerprint ||
    proof.requiredChecksFingerprint !== action.payload.requiredChecksFingerprint ||
    proof.mergeMethod !== action.payload.mergeMethod ||
    proof.defaultBranch !== action.payload.baseBranch ||
    checkpoint.mergeApprovalFingerprint !== null
  ) {
    invalid("Local merge plan does not match the exact PR head, base, check snapshot, and repository policy.");
  }
}

function requiredHandoff(
  value: VerifiedCodePublicationHandoffV1 | null,
  operationName: string,
): VerifiedCodePublicationHandoffV1 {
  if (!value) invalid(`${operationName} requires a local verified-code handoff.`);
  return value;
}

function handoffFingerprint(action: PreparedBackgroundGitHubActionV1): string {
  if (action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 ||
      action.operation === GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1) {
    return action.payload.proofSnapshotFingerprint;
  }
  return action.payload.handoffFingerprint;
}

function version(value: unknown): 1 {
  if (value !== PREPARED_BACKGROUND_GITHUB_PACKAGE_VERSION) invalid("Unsupported GitHub package version.");
  return PREPARED_BACKGROUND_GITHUB_PACKAGE_VERSION;
}

function operation(value: unknown): PreparedBackgroundGitHubOperationV1 {
  if (
    value !== GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 &&
    value !== GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
    value !== GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 &&
    value !== GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 &&
    value !== GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1
  ) {
    invalid("Prepared background GitHub package operation is outside the fixed catalog.");
  }
  return value;
}

function kind(value: unknown): "prepared_background_github_package" {
  if (value !== "prepared_background_github_package") invalid("Unsupported GitHub package kind.");
  return value;
}

function assertUnexpired(value: PreparedBackgroundGitHubPackageV1, now: Date): void {
  if (Date.parse(value.expiresAt) <= now.getTime()) {
    throw new PreparedBackgroundGitHubPackageStoreErrorV1(
      "package_expired",
      "Prepared background GitHub package has expired.",
    );
  }
}

async function assertExactPriorDispatchForExpiredLoad(
  preparedPackage: PreparedBackgroundGitHubPackageV1,
  attempts: Pick<BackgroundGitHubActionAttemptStoreV1, "load"> | undefined,
): Promise<void> {
  if (!attempts) {
    throw new PreparedBackgroundGitHubPackageStoreErrorV1(
      "package_expired",
      "Expired GitHub packages may load only for exact readback reconciliation of a prior dispatch.",
    );
  }
  const attemptId = backgroundGitHubActionAttemptIdV1(
    preparedPackage.jobId,
    preparedPackage.action,
  );
  const input = await attempts.load(attemptId);
  if (!input) {
    throw new PreparedBackgroundGitHubPackageStoreErrorV1(
      "package_expired",
      "Expired GitHub package has no durable prior-dispatch marker for readback reconciliation.",
    );
  }
  let attempt;
  try {
    attempt = parseBackgroundGitHubActionAttemptV1(input);
  } catch {
    throw new PreparedBackgroundGitHubPackageStoreErrorV1(
      "package_expired",
      "Expired GitHub package prior-dispatch marker is invalid.",
    );
  }
  if (
    attempt.id !== attemptId ||
    attempt.jobId !== preparedPackage.jobId ||
    attempt.actionFingerprint !== preparedPackage.action.fingerprint ||
    attempt.preparedActionFingerprint !== preparedPackage.preparedActionFingerprint ||
    attempt.operation !== preparedPackage.operation ||
    attempt.publicationId !== preparedPackage.publicationId ||
    attempt.repositoryBindingFingerprint !== preparedPackage.repositoryBindingFingerprint ||
    attempt.targetFingerprint !== backgroundGitHubTargetFingerprintV1(preparedPackage.action) ||
    (attempt.status !== "dispatching" && attempt.status !== "reconcile_required") ||
    Date.parse(attempt.startedAt) >= Date.parse(preparedPackage.expiresAt)
  ) {
    throw new PreparedBackgroundGitHubPackageStoreErrorV1(
      "package_expired",
      "Expired GitHub package prior-dispatch marker does not match its exact reconciliation scope.",
    );
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    invalid(`${label} does not match its closed contract.`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} must be a SHA-256 fingerprint.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${label} must be a positive integer.`);
  return Number(value);
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 2_048 ||
    /[\0\r\n]/u.test(value) ||
    (!/^[A-Za-z]:[\\/]/u.test(value) && !value.startsWith("/"))
  ) {
    invalid("Canonical repository root must be an absolute host path.");
  }
  return path.resolve(value);
}

function gitBranch(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[~^:?*[\\\s\]]/u.test(value)
  ) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function mergeMethod(value: unknown): GitHubMergeMethodV1 {
  if (value !== "squash" && value !== "merge" && value !== "rebase") {
    invalid("GitHub merge method is invalid.");
  }
  return value;
}

function uniqueText(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) invalid(`${label} list is invalid.`);
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > maximumLength || /[\0\r\n]/u.test(entry)) {
      invalid(`${label} is invalid.`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) invalid(`${label} list contains duplicates.`);
  return result;
}

function boundedMultilineText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  allowNewlines: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes("\0") ||
    (!allowNewlines && /[\r\n]/u.test(value))
  ) {
    invalid(`${label} is invalid.`);
  }
  return value.replace(/\r\n?/gu, "\n");
}

function rejectCredentialMaterial(value: string, label: string): void {
  if (
    /(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+\S+)/iu.test(value)
  ) {
    invalid(`${label} cannot persist credential material.`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    invalid(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function invalid(message: string): never {
  throw new PreparedBackgroundGitHubPackageStoreErrorV1("package_invalid", message);
}
