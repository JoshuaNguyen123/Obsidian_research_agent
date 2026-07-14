import type {
  GitPushAttemptRecordV1,
  GitPushAttemptStoreV1,
  VerifiedGitPushReceiptV1,
} from "./VerifiedGitPushGateway";
import {
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
import { fingerprintContract } from "../linear/LinearContractSupport";
import type { JsonValue } from "../../agent/actions";

export interface GitPushAttemptNamespaceV1 {
  version: 1;
  revision: number;
  attempts: Record<string, GitPushAttemptRecordV1>;
}

export interface GitPushAttemptPersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(namespace: GitPushAttemptNamespaceV1, expectedRevision: number): Promise<boolean>;
}

export class DurableGitPushAttemptStoreV1 implements GitPushAttemptStoreV1 {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: GitPushAttemptPersistenceV1) {}

  load(id: string): Promise<GitPushAttemptRecordV1 | null> {
    return this.serialized(async () => {
      const key = expectIdentifier(id, "Git push attempt id", 256);
      const namespace = parseGitPushAttemptNamespaceV1(await this.persistence.read());
      return clone(namespace.attempts[key] ?? null);
    });
  }

  save(recordInput: GitPushAttemptRecordV1, expectedRevision: number | null): Promise<boolean> {
    return this.serialized(async () => {
      const record = parseGitPushAttemptRecordV1(recordInput);
      const namespace = parseGitPushAttemptNamespaceV1(await this.persistence.read());
      const current = namespace.attempts[record.id];
      if (expectedRevision === null) {
        if (current || record.revision !== 0) return false;
      } else {
        if (!current || current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
          return false;
        }
        validateReplacement(current, record);
      }
      if (!current && Object.keys(namespace.attempts).length >= 500) {
        throw new Error("Git push attempt storage exceeds its fixed 500-record limit.");
      }
      return this.persistence.write({
        version: 1,
        revision: namespace.revision + 1,
        attempts: { ...namespace.attempts, [record.id]: record },
      }, namespace.revision);
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function parseGitPushAttemptNamespaceV1(value: unknown): GitPushAttemptNamespaceV1 {
  if (value === null || value === undefined) return { version: 1, revision: 0, attempts: {} };
  const record = expectRecord(value, "Git push attempt namespace");
  exact(record, ["version", "revision", "attempts"], "Git push attempt namespace");
  if (record.version !== 1) throw new Error("Unsupported Git push attempt namespace version.");
  const raw = expectRecord(record.attempts, "Git push attempts");
  if (Object.keys(raw).length > 500) throw new Error("Git push attempt namespace exceeds its limit.");
  const attempts: Record<string, GitPushAttemptRecordV1> = {};
  for (const [id, value] of Object.entries(raw)) {
    const parsed = parseGitPushAttemptRecordV1(value);
    if (parsed.id !== id) throw new Error("Git push attempt key does not match its identity.");
    attempts[id] = parsed;
  }
  return {
    version: 1,
    revision: expectSafeInteger(record.revision, "Git push attempt namespace revision", 0, Number.MAX_SAFE_INTEGER),
    attempts,
  };
}

export function parseGitPushAttemptRecordV1(value: unknown): GitPushAttemptRecordV1 {
  const json = expectJsonRecord(value, "Git push attempt", 300_000);
  assertNoCredentialKeys(json as JsonValue, "Git push attempt");
  assertNoCredentialMaterial(json as JsonValue, "Git push attempt");
  const record = expectRecord(json, "Git push attempt");
  exact(record, [
    "version", "id", "revision", "handoffFingerprint", "bindingFingerprint",
    "branch", "remoteUrl", "beforeRemoteSha", "expectedCommitSha", "status",
    "dispatchCount", "reconciliationKey", "startedAt", "updatedAt", "receipt", "diagnostic",
  ], "Git push attempt");
  if (record.version !== 1) throw new Error("Unsupported Git push attempt version.");
  const status = record.status;
  if (!["dispatching", "reconcile_required", "verified", "not_applied"].includes(String(status))) {
    throw new Error("Git push attempt status is invalid.");
  }
  const remoteUrl = expectText(record.remoteUrl, "Git push remote URL", 2_000);
  const url = new URL(remoteUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || !url.pathname.endsWith(".git")) {
    throw new Error("Git push remote URL is outside the trusted GitHub host.");
  }
  const receipt = record.receipt === null ? null : parseVerifiedPushReceipt(record.receipt);
  if ((status === "verified") !== Boolean(receipt)) {
    throw new Error("Verified Git push attempt state must match receipt presence.");
  }
  const result: GitPushAttemptRecordV1 = {
    version: 1,
    id: expectIdentifier(record.id, "Git push attempt id", 256),
    revision: expectSafeInteger(record.revision, "Git push attempt revision", 0, Number.MAX_SAFE_INTEGER),
    handoffFingerprint: expectFingerprint(record.handoffFingerprint, "Git push handoff fingerprint"),
    bindingFingerprint: expectFingerprint(record.bindingFingerprint, "Git push binding fingerprint"),
    branch: agentBranch(record.branch),
    remoteUrl,
    beforeRemoteSha: record.beforeRemoteSha === null ? null : gitSha(record.beforeRemoteSha, "Git push before SHA"),
    expectedCommitSha: gitSha(record.expectedCommitSha, "Git push expected SHA"),
    status: status as GitPushAttemptRecordV1["status"],
    dispatchCount: expectSafeInteger(record.dispatchCount, "Git push dispatch count", 0, 1) as 0 | 1,
    reconciliationKey: expectText(record.reconciliationKey, "Git push reconciliation key", 500),
    startedAt: expectIsoTimestamp(record.startedAt, "Git push start time"),
    updatedAt: expectIsoTimestamp(record.updatedAt, "Git push update time"),
    receipt,
    diagnostic: record.diagnostic === null ? null : expectText(record.diagnostic, "Git push diagnostic", 2_000),
  };
  if (Date.parse(result.updatedAt) < Date.parse(result.startedAt)) {
    throw new Error("Git push attempt time moved backwards.");
  }
  return result;
}

function parseVerifiedPushReceipt(value: unknown): VerifiedGitPushReceiptV1 {
  const record = expectRecord(value, "verified Git push receipt");
  if (record.version !== 1 || record.kind !== "verified_git_push" || record.status !== "verified") {
    throw new Error("Git push receipt is not verified.");
  }
  const fingerprint = expectFingerprint(record.fingerprint, "Git push receipt fingerprint");
  const { fingerprint: _ignored, ...evidence } = record;
  if (fingerprintContract(evidence) !== fingerprint) {
    throw new Error("Git push receipt fingerprint does not match its evidence.");
  }
  return clone(record) as unknown as VerifiedGitPushReceiptV1;
}

function validateReplacement(previous: GitPushAttemptRecordV1, next: GitPushAttemptRecordV1): void {
  for (const key of [
    "id", "handoffFingerprint", "bindingFingerprint", "branch", "remoteUrl",
    "beforeRemoteSha", "expectedCommitSha", "dispatchCount", "reconciliationKey", "startedAt",
  ] as const) {
    if (previous[key] !== next[key]) throw new Error(`Git push attempt ${key} is immutable.`);
  }
  if (["verified", "not_applied"].includes(previous.status) && previous.status !== next.status) {
    throw new Error("Terminal Git push attempt state is immutable.");
  }
}

function agentBranch(value: unknown): string {
  const branch = expectText(value, "Git push branch", 255);
  if (!branch.startsWith("codex/") || branch.includes("..") || /[\s~^:?*[\\\]]/u.test(branch)) {
    throw new Error("Git push branch is not agent owned.");
  }
  return branch;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function exact(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) throw new Error(`${label} keys are invalid.`);
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
