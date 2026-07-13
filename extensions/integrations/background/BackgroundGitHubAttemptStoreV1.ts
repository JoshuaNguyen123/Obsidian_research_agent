import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  type PreparedBackgroundGitHubOperationV1,
} from "../../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import {
  createBackgroundGitHubVerifiedResultV1,
  parseBackgroundGitHubVerifiedResultV1,
  type BackgroundGitHubVerifiedResultV1,
} from "../../../packages/core-api/src/backgroundGitHubVerifiedResultV1";
export {
  createBackgroundGitHubVerifiedResultV1,
  parseBackgroundGitHubVerifiedResultV1,
  type BackgroundGitHubVerifiedResultV1,
} from "../../../packages/core-api/src/backgroundGitHubVerifiedResultV1";
import {
  parsePendingExternalActionStateV2,
  type PendingExternalActionStateV2,
} from "../../../src/integrations/PendingExternalActionStateV2";
import {
  ensureSafeCompanionDirectoryV1,
  readSafeCompanionFileV1,
  validateCompanionAppDataRootV1,
  writeSafeCompanionFileAtomicV1,
} from "./SafeCompanionAppDataV1";

const ATTEMPT_DIRECTORY = "background-github-attempts-v1";
const MAX_ATTEMPT_BYTES = 64 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type BackgroundGitHubAttemptStatusV1 =
  | "dispatching"
  | "reconcile_required"
  | "verified"
  | "not_applied"
  | "blocked";

export interface BackgroundGitHubActionAttemptV1 {
  version: 1;
  id: string;
  revision: number;
  jobId: string;
  actionFingerprint: string;
  preparedActionFingerprint: string;
  operation: PreparedBackgroundGitHubOperationV1;
  publicationId: string;
  repositoryBindingFingerprint: string;
  targetFingerprint: string;
  status: BackgroundGitHubAttemptStatusV1;
  dispatchCount: 1;
  startedAt: string;
  updatedAt: string;
  pendingAction: PendingExternalActionStateV2 | null;
  result: BackgroundGitHubVerifiedResultV1 | null;
  diagnostic: string | null;
}

export interface BackgroundGitHubActionAttemptStoreV1 {
  load(id: string): Promise<BackgroundGitHubActionAttemptV1 | null>;
  save(
    record: BackgroundGitHubActionAttemptV1,
    expectedRevision: number | null,
  ): Promise<boolean>;
}

export class FileBackgroundGitHubActionAttemptStoreV1
  implements BackgroundGitHubActionAttemptStoreV1 {
  readonly applicationDataRoot: string;
  readonly attemptRoot: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    applicationDataRoot: string,
    private readonly randomId: () => string = randomUUID,
  ) {
    this.applicationDataRoot = validateCompanionAppDataRootV1(applicationDataRoot);
    this.attemptRoot = path.join(this.applicationDataRoot, ATTEMPT_DIRECTORY);
  }

  load(id: string): Promise<BackgroundGitHubActionAttemptV1 | null> {
    return this.serialized(async () => {
      await ensureSafeCompanionDirectoryV1(this.applicationDataRoot, this.attemptRoot);
      return this.read(id);
    });
  }

  save(
    recordInput: BackgroundGitHubActionAttemptV1,
    expectedRevision: number | null,
  ): Promise<boolean> {
    return this.serialized(async () => {
      const record = parseBackgroundGitHubActionAttemptV1(recordInput);
      await ensureSafeCompanionDirectoryV1(this.applicationDataRoot, this.attemptRoot);
      const current = await this.read(record.id);
      if (expectedRevision === null) {
        if (current || record.revision !== 0) return false;
      } else {
        if (
          !current ||
          current.revision !== expectedRevision ||
          record.revision !== expectedRevision + 1
        ) {
          return false;
        }
        validateReplacement(current, record);
      }
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (bytes.byteLength > MAX_ATTEMPT_BYTES) {
        throw new Error("Background GitHub WAL record exceeds its byte limit.");
      }
      const finalPath = this.attemptPath(record.id);
      await writeSafeCompanionFileAtomicV1({
        applicationDataRoot: this.applicationDataRoot,
        directory: this.attemptRoot,
        finalPath,
        bytes,
        maximumBytes: MAX_ATTEMPT_BYTES,
        temporaryToken: this.randomId(),
      });
      const verified = await this.read(record.id);
      if (!verified || JSON.stringify(verified) !== JSON.stringify(record)) {
        throw new Error("Background GitHub WAL failed exact readback verification.");
      }
      return true;
    });
  }

  private async read(id: string): Promise<BackgroundGitHubActionAttemptV1 | null> {
    const filePath = this.attemptPath(id);
    const bytes = await readSafeCompanionFileV1({
      applicationDataRoot: this.applicationDataRoot,
      filePath,
      maximumBytes: MAX_ATTEMPT_BYTES,
      allowMissing: true,
    });
    if (!bytes) return null;
    if (bytes.byteLength > MAX_ATTEMPT_BYTES) {
      throw new Error("Stored background GitHub WAL record exceeds its byte limit.");
    }
    return parseBackgroundGitHubActionAttemptV1(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
  }

  private attemptPath(id: string): string {
    const fingerprint = sha256(id, "background GitHub attempt id");
    return path.join(this.attemptRoot, `${fingerprint.slice("sha256:".length)}.json`);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function parseBackgroundGitHubActionAttemptV1(
  value: unknown,
): BackgroundGitHubActionAttemptV1 {
  const record = exactRecord(value, [
    "version", "id", "revision", "jobId", "actionFingerprint",
    "preparedActionFingerprint", "operation", "publicationId",
    "repositoryBindingFingerprint", "targetFingerprint", "status",
    "dispatchCount", "startedAt", "updatedAt", "pendingAction", "result",
    "diagnostic",
  ], "background GitHub action attempt");
  if (record.version !== 1 || record.dispatchCount !== 1) {
    throw new Error("Unsupported background GitHub attempt contract.");
  }
  const status = attemptStatus(record.status);
  const pendingAction = record.pendingAction === null
    ? null
    : parsePendingExternalActionStateV2(record.pendingAction);
  const result = record.result === null ? null : parseBackgroundGitHubVerifiedResultV1(record.result);
  const normalized: BackgroundGitHubActionAttemptV1 = {
    version: 1,
    id: sha256(record.id, "background GitHub attempt id"),
    revision: integer(record.revision, "attempt revision", 0, Number.MAX_SAFE_INTEGER),
    jobId: identifier(record.jobId, "job id"),
    actionFingerprint: sha256(record.actionFingerprint, "action fingerprint"),
    preparedActionFingerprint: sha256(
      record.preparedActionFingerprint,
      "prepared action fingerprint",
    ),
    operation: operation(record.operation),
    publicationId: identifier(record.publicationId, "publication id"),
    repositoryBindingFingerprint: sha256(
      record.repositoryBindingFingerprint,
      "repository binding fingerprint",
    ),
    targetFingerprint: sha256(record.targetFingerprint, "target fingerprint"),
    status,
    dispatchCount: 1,
    startedAt: timestamp(record.startedAt, "attempt start time"),
    updatedAt: timestamp(record.updatedAt, "attempt update time"),
    pendingAction,
    result,
    diagnostic: record.diagnostic === null
      ? null
      : safeDiagnostic(record.diagnostic),
  };
  if (Date.parse(normalized.updatedAt) < Date.parse(normalized.startedAt)) {
    throw new Error("Background GitHub attempt time cannot move backwards.");
  }
  if ((status === "verified") !== Boolean(result)) {
    throw new Error("Verified background GitHub attempt state must match result proof presence.");
  }
  if (status === "verified" && pendingAction !== null) {
    throw new Error("Verified background GitHub attempts cannot retain pending mutation state.");
  }
  if (status !== "verified" && status !== "not_applied" && status !== "blocked" && !pendingAction) {
    throw new Error("Nonterminal background GitHub attempts require pending mutation state.");
  }
  if (pendingAction && (
    pendingAction.provider !== "github" ||
    pendingAction.preparedActionFingerprint !== normalized.preparedActionFingerprint ||
    pendingAction.targetFingerprint !== normalized.targetFingerprint
  )) {
    throw new Error("Background GitHub pending action drifted from its WAL identity.");
  }
  if (result && (
    result.operation !== normalized.operation ||
    result.publicationId !== normalized.publicationId ||
    result.repositoryBindingFingerprint !== normalized.repositoryBindingFingerprint
  )) {
    throw new Error("Background GitHub verified result drifted from its WAL identity.");
  }
  return normalized;
}

function validateReplacement(
  previous: BackgroundGitHubActionAttemptV1,
  next: BackgroundGitHubActionAttemptV1,
): void {
  for (const key of [
    "id", "jobId", "actionFingerprint", "preparedActionFingerprint", "operation",
    "publicationId", "repositoryBindingFingerprint", "targetFingerprint",
    "dispatchCount", "startedAt",
  ] as const) {
    if (previous[key] !== next[key]) throw new Error(`Background GitHub WAL ${key} is immutable.`);
  }
  if (["verified", "not_applied", "blocked"].includes(previous.status) && previous.status !== next.status) {
    throw new Error("Terminal background GitHub WAL state is immutable.");
  }
}

function operation(value: unknown): PreparedBackgroundGitHubOperationV1 {
  const allowed: PreparedBackgroundGitHubOperationV1[] = [
    "github_verified_branch_push_v1",
    "github_draft_pull_request_v1",
    "github_review_repair_fast_forward_v1",
    "github_pull_request_merge_v1",
    "github_pull_request_auto_merge_v1",
  ];
  if (typeof value !== "string" || !allowed.includes(value as PreparedBackgroundGitHubOperationV1)) {
    throw new Error("Background GitHub operation is outside the fixed catalog.");
  }
  return value as PreparedBackgroundGitHubOperationV1;
}

function attemptStatus(value: unknown): BackgroundGitHubAttemptStatusV1 {
  const allowed: BackgroundGitHubAttemptStatusV1[] = [
    "dispatching", "reconcile_required", "verified", "not_applied", "blocked",
  ];
  if (typeof value !== "string" || !allowed.includes(value as BackgroundGitHubAttemptStatusV1)) {
    throw new Error("Background GitHub attempt status is invalid.");
  }
  return value as BackgroundGitHubAttemptStatusV1;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} does not match its closed contract.`);
  }
  return record;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function safeDiagnostic(value: unknown): string {
  if (typeof value !== "string") throw new Error("Background GitHub diagnostic is invalid.");
  const redacted = value
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/gu, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]+/gu, "[REDACTED]");
  return redacted.slice(0, 2_000);
}
