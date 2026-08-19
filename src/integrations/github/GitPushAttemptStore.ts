import type {
  GitPushAttemptRecordV1,
  GitPushAttemptStoreV1,
  GitPushNotAppliedAttemptAuditV1,
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

export interface CommitVerifiedGitPushAttemptNamespaceOptionsV1 {
  readCached(): unknown | null | undefined;
  writeAndReadback(
    namespace: GitPushAttemptNamespaceV1,
    expectedRevision: number,
  ): Promise<unknown | null | undefined | false>;
  commitCached(namespace: GitPushAttemptNamespaceV1): void;
}

/**
 * Commits the in-memory namespace only after the durable writer returns the
 * exact bytes it persisted. Callers must keep writeAndReadback inside their
 * persistence lock so another plugin-data write cannot interleave between the
 * write, readback, and cache commit.
 */
export async function commitGitPushAttemptNamespaceAfterVerifiedWriteV1(
  options: CommitVerifiedGitPushAttemptNamespaceOptionsV1,
  namespaceInput: GitPushAttemptNamespaceV1,
  expectedRevision: number,
): Promise<boolean> {
  const namespace = parseGitPushAttemptNamespaceV1(namespaceInput);
  const cachedBefore = parseGitPushAttemptNamespaceV1(options.readCached());
  if (cachedBefore.revision !== expectedRevision) return false;
  const readbackInput = await options.writeAndReadback(
    clone(namespace),
    expectedRevision,
  );
  if (readbackInput === false) return false;
  const readback = parseGitPushAttemptNamespaceV1(readbackInput);
  if (!sameNamespace(namespace, readback)) {
    throw new Error(
      "Git push attempt persistence readback did not match the exact written namespace.",
    );
  }
  const cachedAfter = parseGitPushAttemptNamespaceV1(options.readCached());
  if (!sameNamespace(cachedBefore, cachedAfter)) {
    throw new Error(
      "Git push attempt in-memory namespace changed during its durable write.",
    );
  }
  options.commitCached(clone(readback));
  return true;
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
      const candidate: GitPushAttemptNamespaceV1 = {
        version: 1,
        revision: namespace.revision + 1,
        attempts: { ...namespace.attempts, [record.id]: record },
      };
      if (!(await this.persistence.write(candidate, namespace.revision))) {
        return false;
      }
      const readback = parseGitPushAttemptNamespaceV1(
        await this.persistence.read(),
      );
      if (!sameNamespace(candidate, readback)) {
        throw new Error(
          "Git push attempt persistence did not return the exact written namespace.",
        );
      }
      return true;
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
    "visibilityBindingFingerprint", "visibilityAttestationFingerprint",
    "repositoryReadbackFingerprint", "expectedVisibility",
    "retryHistory",
    "branch", "remoteUrl", "beforeRemoteSha", "expectedCommitSha", "status",
    "dispatchCount", "reconciliationKey", "startedAt", "updatedAt", "receipt", "diagnostic",
  ], "Git push attempt");
  if (record.version !== 1) throw new Error("Unsupported Git push attempt version.");
  const status = record.status;
  if (!["dispatching", "reconcile_required", "verified", "not_applied"].includes(String(status))) {
    throw new Error("Git push attempt status is invalid.");
  }
  if (record.expectedVisibility !== "private" && record.expectedVisibility !== "public") {
    throw new Error("Git push attempt expected visibility is invalid.");
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
    visibilityBindingFingerprint: expectFingerprint(
      record.visibilityBindingFingerprint,
      "Git push visibility binding fingerprint",
    ),
    visibilityAttestationFingerprint: expectFingerprint(
      record.visibilityAttestationFingerprint,
      "Git push visibility attestation fingerprint",
    ),
    repositoryReadbackFingerprint: expectFingerprint(
      record.repositoryReadbackFingerprint,
      "Git push repository readback fingerprint",
    ),
    expectedVisibility: record.expectedVisibility,
    retryHistory: parseRetryHistory(record.retryHistory),
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
  if (receipt) validateReceiptAgainstAttempt(receipt, result);
  return result;
}

function parseVerifiedPushReceipt(value: unknown): VerifiedGitPushReceiptV1 {
  const json = expectJsonRecord(value, "verified Git push receipt", 100_000);
  assertNoCredentialKeys(json as JsonValue, "verified Git push receipt");
  assertNoCredentialMaterial(json as JsonValue, "verified Git push receipt");
  const record = expectRecord(json, "verified Git push receipt");
  exact(record, [
    "version", "kind", "id", "status", "commitKind", "handoffId",
    "handoffFingerprint", "repositoryBindingKey", "repositoryBindingFingerprint",
    "repositoryVisibility", "repositoryVisibilityBindingFingerprint",
    "repositoryVisibilityAttestationFingerprint", "repositoryReadbackFingerprint",
    "repositoryProfileKey", "repositoryProfileFingerprint", "canonicalWorktreeRoot",
    "canonicalWorktreeFingerprint", "remoteUrl", "branch", "baseBranch",
    "beforeRemoteSha", "remoteSha", "baseSha", "parentSha", "commitSha", "treeSha",
    "diffFingerprint", "artifactFingerprint", "localCommitReceiptId",
    "localCommitReceiptFingerprint", "targetedValidationReceiptId",
    "fullValidationReceiptId", "targetedValidationFingerprint",
    "fullValidationFingerprint", "pushedAt", "verifiedAt", "fingerprint",
  ], "verified Git push receipt");
  if (
    record.version !== 1 ||
    record.kind !== "verified_git_push" ||
    record.status !== "verified"
  ) {
    throw new Error("Git push receipt is not verified.");
  }
  if (
    record.commitKind !== "committed" &&
    record.commitKind !== "reconciled" &&
    record.commitKind !== "already_present"
  ) {
    throw new Error("Git push receipt commit kind is invalid.");
  }
  if (record.repositoryVisibility !== "private" && record.repositoryVisibility !== "public") {
    throw new Error("Git push receipt repository visibility is invalid.");
  }
  const remoteUrl = expectText(record.remoteUrl, "Git push receipt remote URL", 2_000);
  const url = new URL(remoteUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    !url.pathname.endsWith(".git")
  ) {
    throw new Error("Git push receipt remote URL is outside the trusted GitHub host.");
  }
  const evidence: Omit<VerifiedGitPushReceiptV1, "fingerprint"> = {
    version: 1,
    kind: "verified_git_push",
    id: expectIdentifier(record.id, "Git push receipt id", 256),
    status: "verified",
    commitKind: record.commitKind,
    handoffId: expectIdentifier(record.handoffId, "Git push receipt handoff id", 256),
    handoffFingerprint: expectFingerprint(record.handoffFingerprint, "Git push receipt handoff fingerprint"),
    repositoryBindingKey: expectIdentifier(record.repositoryBindingKey, "Git push receipt binding key", 512),
    repositoryBindingFingerprint: expectFingerprint(record.repositoryBindingFingerprint, "Git push receipt binding fingerprint"),
    repositoryVisibility: record.repositoryVisibility,
    repositoryVisibilityBindingFingerprint: expectFingerprint(record.repositoryVisibilityBindingFingerprint, "Git push receipt visibility binding fingerprint"),
    repositoryVisibilityAttestationFingerprint: expectFingerprint(record.repositoryVisibilityAttestationFingerprint, "Git push receipt visibility attestation fingerprint"),
    repositoryReadbackFingerprint: expectFingerprint(record.repositoryReadbackFingerprint, "Git push receipt repository readback fingerprint"),
    repositoryProfileKey: expectIdentifier(record.repositoryProfileKey, "Git push receipt profile key", 512),
    repositoryProfileFingerprint: expectFingerprint(record.repositoryProfileFingerprint, "Git push receipt profile fingerprint"),
    canonicalWorktreeRoot: expectText(record.canonicalWorktreeRoot, "Git push receipt worktree root", 4_096),
    canonicalWorktreeFingerprint: expectFingerprint(record.canonicalWorktreeFingerprint, "Git push receipt worktree fingerprint"),
    remoteUrl,
    branch: agentBranch(record.branch),
    baseBranch: gitBranch(record.baseBranch, "Git push receipt base branch"),
    beforeRemoteSha: record.beforeRemoteSha === null ? null : gitSha(record.beforeRemoteSha, "Git push receipt before SHA"),
    remoteSha: gitSha(record.remoteSha, "Git push receipt remote SHA"),
    baseSha: gitSha(record.baseSha, "Git push receipt base SHA"),
    parentSha: gitSha(record.parentSha, "Git push receipt parent SHA"),
    commitSha: gitSha(record.commitSha, "Git push receipt commit SHA"),
    treeSha: gitSha(record.treeSha, "Git push receipt tree SHA"),
    diffFingerprint: expectFingerprint(record.diffFingerprint, "Git push receipt diff fingerprint"),
    artifactFingerprint: expectFingerprint(record.artifactFingerprint, "Git push receipt artifact fingerprint"),
    localCommitReceiptId: expectIdentifier(record.localCommitReceiptId, "Git push receipt local commit receipt id", 512),
    localCommitReceiptFingerprint: expectFingerprint(record.localCommitReceiptFingerprint, "Git push receipt local commit fingerprint"),
    targetedValidationReceiptId: expectIdentifier(record.targetedValidationReceiptId, "Git push receipt targeted validation id", 512),
    fullValidationReceiptId: expectIdentifier(record.fullValidationReceiptId, "Git push receipt full validation id", 512),
    targetedValidationFingerprint: expectFingerprint(record.targetedValidationFingerprint, "Git push receipt targeted validation fingerprint"),
    fullValidationFingerprint: expectFingerprint(record.fullValidationFingerprint, "Git push receipt full validation fingerprint"),
    pushedAt: expectIsoTimestamp(record.pushedAt, "Git push receipt push time"),
    verifiedAt: expectIsoTimestamp(record.verifiedAt, "Git push receipt verification time"),
  };
  const fingerprint = expectFingerprint(record.fingerprint, "Git push receipt fingerprint");
  if (fingerprintContract(evidence) !== fingerprint) {
    throw new Error("Git push receipt fingerprint does not match its evidence.");
  }
  if (Date.parse(evidence.verifiedAt) < Date.parse(evidence.pushedAt)) {
    throw new Error("Git push receipt verification predates its push evidence.");
  }
  return { ...evidence, fingerprint };
}

function validateReceiptAgainstAttempt(
  receipt: VerifiedGitPushReceiptV1,
  attempt: GitPushAttemptRecordV1,
): void {
  const expectedReceiptId = `github-push-${fingerprintContract({
    handoff: attempt.handoffFingerprint,
    visibilityBinding: attempt.visibilityBindingFingerprint,
    expectedVisibility: attempt.expectedVisibility,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const bindingsMatch =
    receipt.id === expectedReceiptId &&
    receipt.handoffFingerprint === attempt.handoffFingerprint &&
    receipt.repositoryBindingFingerprint === attempt.bindingFingerprint &&
    receipt.repositoryVisibilityBindingFingerprint ===
      attempt.visibilityBindingFingerprint &&
    receipt.repositoryVisibilityAttestationFingerprint ===
      attempt.visibilityAttestationFingerprint &&
    receipt.repositoryReadbackFingerprint ===
      attempt.repositoryReadbackFingerprint &&
    receipt.repositoryVisibility === attempt.expectedVisibility &&
    receipt.remoteUrl === attempt.remoteUrl &&
    receipt.branch === attempt.branch &&
    receipt.beforeRemoteSha === attempt.beforeRemoteSha &&
    receipt.remoteSha === attempt.expectedCommitSha &&
    receipt.commitSha === attempt.expectedCommitSha &&
    receipt.verifiedAt === attempt.updatedAt;
  if (!bindingsMatch) {
    throw new Error(
      "Verified Git push receipt does not match its containing attempt.",
    );
  }
  if (
    Date.parse(receipt.pushedAt) < Date.parse(attempt.startedAt) ||
    Date.parse(receipt.pushedAt) > Date.parse(receipt.verifiedAt)
  ) {
    throw new Error(
      "Verified Git push receipt timestamps do not match its containing attempt.",
    );
  }
}

function validateReplacement(previous: GitPushAttemptRecordV1, next: GitPushAttemptRecordV1): void {
  const retryingProvedNotApplied =
    previous.status === "not_applied" && next.status === "dispatching";
  if (retryingProvedNotApplied) {
    for (const key of [
      "id", "handoffFingerprint", "bindingFingerprint",
      "visibilityBindingFingerprint", "repositoryReadbackFingerprint",
      "expectedVisibility", "branch", "remoteUrl", "expectedCommitSha",
      "reconciliationKey",
    ] as const) {
      if (previous[key] !== next[key]) {
        throw new Error(`Git push retry ${key} is immutable.`);
      }
    }
    const expectedHistory = [
      ...previous.retryHistory,
      retryAuditFromRecord(previous),
    ];
    if (JSON.stringify(next.retryHistory) !== JSON.stringify(expectedHistory)) {
      throw new Error(
        "Git push retry must append the exact prior not-applied audit evidence.",
      );
    }
    return;
  }
  for (const key of [
    "id", "handoffFingerprint", "bindingFingerprint", "visibilityBindingFingerprint",
    "visibilityAttestationFingerprint", "repositoryReadbackFingerprint",
    "expectedVisibility", "branch", "remoteUrl",
    "beforeRemoteSha", "expectedCommitSha", "dispatchCount", "reconciliationKey", "startedAt",
  ] as const) {
    if (previous[key] !== next[key]) throw new Error(`Git push attempt ${key} is immutable.`);
  }
  if (JSON.stringify(previous.retryHistory) !== JSON.stringify(next.retryHistory)) {
    throw new Error("Git push attempt retry history is immutable outside a proved retry transition.");
  }
  if (["verified", "not_applied"].includes(previous.status) && previous.status !== next.status) {
    throw new Error("Terminal Git push attempt state is immutable.");
  }
}

function parseRetryHistory(value: unknown): GitPushNotAppliedAttemptAuditV1[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("Git push retry history exceeds its fixed safety limit.");
  }
  return value.map((entry) => {
    const record = expectRecord(entry, "Git push not-applied retry audit");
    exact(record, [
      "outcome", "revision", "visibilityAttestationFingerprint",
      "beforeRemoteSha", "dispatchCount", "startedAt", "notAppliedAt",
      "diagnostic", "fingerprint",
    ], "Git push not-applied retry audit");
    if (record.outcome !== "not_applied") {
      throw new Error("Git push retry audit outcome is invalid.");
    }
    const evidence: Omit<GitPushNotAppliedAttemptAuditV1, "fingerprint"> = {
      outcome: "not_applied",
      revision: expectSafeInteger(
        record.revision,
        "Git push retry revision",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      visibilityAttestationFingerprint: expectFingerprint(
        record.visibilityAttestationFingerprint,
        "Git push retry visibility attestation fingerprint",
      ),
      beforeRemoteSha: record.beforeRemoteSha === null
        ? null
        : gitSha(record.beforeRemoteSha, "Git push retry before SHA"),
      dispatchCount: expectSafeInteger(
        record.dispatchCount,
        "Git push retry dispatch count",
        0,
        1,
      ) as 0 | 1,
      startedAt: expectIsoTimestamp(record.startedAt, "Git push retry start time"),
      notAppliedAt: expectIsoTimestamp(
        record.notAppliedAt,
        "Git push retry not-applied time",
      ),
      diagnostic: expectText(record.diagnostic, "Git push retry diagnostic", 2_000),
    };
    if (Date.parse(evidence.notAppliedAt) < Date.parse(evidence.startedAt)) {
      throw new Error("Git push retry audit time moved backwards.");
    }
    const fingerprint = expectFingerprint(
      record.fingerprint,
      "Git push retry audit fingerprint",
    );
    if (fingerprintContract(evidence) !== fingerprint) {
      throw new Error("Git push retry audit fingerprint does not match its evidence.");
    }
    return { ...evidence, fingerprint };
  });
}

function retryAuditFromRecord(
  attempt: GitPushAttemptRecordV1,
): GitPushNotAppliedAttemptAuditV1 {
  if (attempt.status !== "not_applied" || !attempt.diagnostic) {
    throw new Error("Git push retry lacks exact durable not-applied evidence.");
  }
  const evidence: Omit<GitPushNotAppliedAttemptAuditV1, "fingerprint"> = {
    outcome: "not_applied",
    revision: attempt.revision,
    visibilityAttestationFingerprint:
      attempt.visibilityAttestationFingerprint,
    beforeRemoteSha: attempt.beforeRemoteSha,
    dispatchCount: attempt.dispatchCount,
    startedAt: attempt.startedAt,
    notAppliedAt: attempt.updatedAt,
    diagnostic: attempt.diagnostic,
  };
  return { ...evidence, fingerprint: fingerprintContract(evidence) };
}

function agentBranch(value: unknown): string {
  const branch = expectText(value, "Git push branch", 255);
  if (!branch.startsWith("codex/") || branch.includes("..") || /[\s~^:?*[\\\]]/u.test(branch)) {
    throw new Error("Git push branch is not agent owned.");
  }
  return branch;
}

function gitBranch(value: unknown, label: string): string {
  const branch = expectText(value, label, 255);
  if (
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    /[\s~^:?*[\\\]]/u.test(branch)
  ) {
    throw new Error(`${label} is invalid.`);
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

function sameNamespace(
  left: GitPushAttemptNamespaceV1,
  right: GitPushAttemptNamespaceV1,
): boolean {
  return fingerprintContract(left) === fingerprintContract(right);
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
