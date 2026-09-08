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
      "Git push attempt persistence readback did not match the exact written namespace " +
        `(differs: ${describeNamespaceDifference(namespace, readback)}).`,
    );
  }
  const cachedAfter = parseGitPushAttemptNamespaceV1(options.readCached());
  if (!sameNamespace(cachedBefore, cachedAfter)) {
    throw new Error(
      "Git push attempt in-memory namespace changed during its durable write " +
        `(differs: ${describeNamespaceDifference(cachedBefore, cachedAfter)}).`,
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
          "Git push attempt persistence did not return the exact written namespace " +
            `(differs: ${describeNamespaceDifference(candidate, readback)}).`,
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

export interface GitPushReceiptAttemptBindingV1 {
  /**
   * The name reported when this binding drifts. It names the binding only and
   * never carries a value, so it is safe to place in a durable blocker record.
   */
  readonly field: string;
  readonly matches: (
    receipt: VerifiedGitPushReceiptV1,
    attempt: GitPushAttemptRecordV1,
    expectedReceiptId: string,
  ) => boolean;
}

export interface GitPushReceiptAttemptOrderingV1 {
  /** The name reported when this ordering is violated; a name, never a time. */
  readonly fault: string;
  readonly ordered: (
    receipt: VerifiedGitPushReceiptV1,
    attempt: GitPushAttemptRecordV1,
  ) => boolean;
}

/**
 * Every equality a verified receipt owes its containing attempt, named. These
 * lived as one thirteen-clause conjunction behind a single sentence, so a
 * publication blocked here could only be diagnosed by reproducing the twelve
 * minute live mission that produced it; collecting the failures by name costs
 * nothing and turns the blocker into a readable one. The table is exported so
 * a test can enumerate it and prove each clause is represented in the message,
 * which is what stops this from silently regressing to a bare sentence.
 *
 * Only field names ever reach the message, never the compared values. The
 * fingerprints and SHAs here are digests and would be safe to quote, but the
 * remote URL is not: userinfo is rejected upstream, yet a query string such as
 * "?access_token=..." survives the trusted-host check, and the branch is
 * caller-supplied text. Rather than leave a later editor to re-derive which of
 * the thirteen values is safe, the rule is uniform — name the binding, quote
 * nothing — which also keeps the message inside its length budget.
 */
export const GIT_PUSH_RECEIPT_ATTEMPT_BINDINGS_V1: readonly GitPushReceiptAttemptBindingV1[] = [
  {
    field: "receipt id",
    matches: (receipt, _attempt, expectedReceiptId) => receipt.id === expectedReceiptId,
  },
  {
    field: "handoff fingerprint",
    matches: (receipt, attempt) => receipt.handoffFingerprint === attempt.handoffFingerprint,
  },
  {
    field: "binding fingerprint",
    matches: (receipt, attempt) =>
      receipt.repositoryBindingFingerprint === attempt.bindingFingerprint,
  },
  {
    field: "visibility binding fingerprint",
    matches: (receipt, attempt) =>
      receipt.repositoryVisibilityBindingFingerprint === attempt.visibilityBindingFingerprint,
  },
  {
    field: "visibility attestation fingerprint",
    matches: (receipt, attempt) =>
      receipt.repositoryVisibilityAttestationFingerprint ===
      attempt.visibilityAttestationFingerprint,
  },
  {
    field: "repository readback fingerprint",
    matches: (receipt, attempt) =>
      receipt.repositoryReadbackFingerprint === attempt.repositoryReadbackFingerprint,
  },
  {
    field: "repository visibility",
    matches: (receipt, attempt) => receipt.repositoryVisibility === attempt.expectedVisibility,
  },
  {
    field: "remote URL",
    matches: (receipt, attempt) => receipt.remoteUrl === attempt.remoteUrl,
  },
  {
    field: "branch",
    matches: (receipt, attempt) => receipt.branch === attempt.branch,
  },
  {
    field: "before-remote SHA",
    matches: (receipt, attempt) => receipt.beforeRemoteSha === attempt.beforeRemoteSha,
  },
  {
    field: "remote SHA",
    matches: (receipt, attempt) => receipt.remoteSha === attempt.expectedCommitSha,
  },
  {
    field: "commit SHA",
    matches: (receipt, attempt) => receipt.commitSha === attempt.expectedCommitSha,
  },
  {
    field: "verified-at",
    matches: (receipt, attempt) => receipt.verifiedAt === attempt.updatedAt,
  },
];

/**
 * The orderings the receipt owes the attempt it sits in. They are separated
 * from the equalities because a time that is merely out of order is a
 * different failure from a binding that points at another attempt, and the
 * original message could not tell an operator which of the two had happened.
 */
export const GIT_PUSH_RECEIPT_ATTEMPT_ORDERINGS_V1: readonly GitPushReceiptAttemptOrderingV1[] = [
  {
    fault: "pushed-at precedes the attempt start",
    ordered: (receipt, attempt) =>
      Date.parse(receipt.pushedAt) >= Date.parse(attempt.startedAt),
  },
  {
    fault: "pushed-at follows its own verification",
    ordered: (receipt) => Date.parse(receipt.pushedAt) <= Date.parse(receipt.verifiedAt),
  },
];

const MAX_NAMED_FAULTS = 5;

/**
 * Names the faults that actually occurred and stops. The message travels into
 * a blocker record that downstream truncates near 400 characters, so spelling
 * out all thirteen bindings would push the first — and in practice the only —
 * real mismatch out of the record that an operator reads. Five names plus a
 * count of the remainder keeps the diagnosis inside that budget.
 *
 * The limit is a parameter because not every fault name costs the same. A
 * receipt binding is a short fixed phrase; a namespace fault also carries the
 * attempt it happened in, so fewer of those fit in the same 400 characters.
 */
function summarizeFaults(
  faults: readonly string[],
  limit: number = MAX_NAMED_FAULTS,
): string {
  const named = faults.slice(0, limit);
  const remaining = faults.length - named.length;
  return remaining > 0 ? `${named.join(", ")} and ${remaining} more` : named.join(", ");
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
  const mismatched = GIT_PUSH_RECEIPT_ATTEMPT_BINDINGS_V1.filter(
    (binding) => !binding.matches(receipt, attempt, expectedReceiptId),
  ).map((binding) => binding.field);
  if (mismatched.length > 0) {
    throw new Error(
      `Verified Git push receipt does not match its containing attempt (mismatched: ${summarizeFaults(mismatched)}).`,
    );
  }
  const misordered = GIT_PUSH_RECEIPT_ATTEMPT_ORDERINGS_V1.filter(
    (ordering) => !ordering.ordered(receipt, attempt),
  ).map((ordering) => ordering.fault);
  if (misordered.length > 0) {
    throw new Error(
      `Verified Git push receipt timestamps do not match its containing attempt (${summarizeFaults(misordered)}).`,
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

/**
 * Rejects a record whose key set is not exactly the closed contract, and says
 * which keys were wrong. The bare form of this message hid a field rename
 * behind the same sentence as a truncated record.
 *
 * Missing keys are named because they come from the closed contract written
 * above — our own text, with no value in it. Unknown keys are only counted:
 * they are attacker-reachable strings out of persisted JSON, and the namespace
 * call site runs before any credential scan, so echoing them would be the one
 * way a secret could reach a durable blocker record from here.
 */
function exact(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") === expected.join("\0")) return;
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key)).length;
  throw new Error(
    `${label} keys are invalid (missing: ${missing.length > 0 ? summarizeFaults(missing) : "none"}; unknown: ${unknown}).`,
  );
}

export interface GitPushAttemptNamespaceFacetV1 {
  /**
   * The namespace field reported when it drifts. It names the field only and
   * never carries a value, so it is safe to place in a durable blocker record.
   */
  readonly field: string;
  readonly same: (
    left: GitPushAttemptNamespaceV1,
    right: GitPushAttemptNamespaceV1,
  ) => boolean;
}

export interface GitPushAttemptRecordFacetV1 {
  /** The attempt field reported when it drifts; a name, never a value. */
  readonly field: string;
  readonly same: (
    left: GitPushAttemptRecordV1,
    right: GitPushAttemptRecordV1,
  ) => boolean;
}

/**
 * Every namespace field outside the attempt map, named. `attempts` is absent on
 * purpose: it is not one comparison but a membership check plus the record
 * facets below, and the difference report walks it that way. A test derives
 * both key sets from a parsed namespace and asserts this table plus `attempts`
 * accounts for all of them, so a field added to the namespace cannot slip past
 * the message.
 */
export const GIT_PUSH_ATTEMPT_NAMESPACE_FACETS_V1: readonly GitPushAttemptNamespaceFacetV1[] = [
  { field: "version", same: (left, right) => left.version === right.version },
  { field: "revision", same: (left, right) => left.revision === right.revision },
];

/**
 * Every field an attempt owes its own readback, named. `sameNamespace` compares
 * one digest of the whole map, so it can prove a durable write was not applied
 * verbatim but never say what the writer changed; an operator who hit this had
 * to reproduce the live publication that produced it to find out. Naming the
 * differing fields costs nothing on a path that is already about to throw.
 *
 * `retryHistory` and `receipt` are nested, so they are compared by their own
 * canonical digest rather than by identity — a facet that compared references
 * would report every readback as drifted, and one that compared them loosely
 * would report a real drift as clean.
 *
 * Only field names ever reach the message; the differing values never do. The
 * remote URL is the reason the rule has to be uniform rather than per-field:
 * userinfo is rejected upstream, but a query string such as "?access_token=..."
 * survives the trusted-host check and the credential scan does not recognise
 * it, so quoting even one "obviously safe" value invites the next editor to
 * quote that one.
 */
export const GIT_PUSH_ATTEMPT_RECORD_FACETS_V1: readonly GitPushAttemptRecordFacetV1[] = [
  { field: "version", same: (left, right) => left.version === right.version },
  { field: "id", same: (left, right) => left.id === right.id },
  { field: "revision", same: (left, right) => left.revision === right.revision },
  {
    field: "handoffFingerprint",
    same: (left, right) => left.handoffFingerprint === right.handoffFingerprint,
  },
  {
    field: "bindingFingerprint",
    same: (left, right) => left.bindingFingerprint === right.bindingFingerprint,
  },
  {
    field: "visibilityBindingFingerprint",
    same: (left, right) =>
      left.visibilityBindingFingerprint === right.visibilityBindingFingerprint,
  },
  {
    field: "visibilityAttestationFingerprint",
    same: (left, right) =>
      left.visibilityAttestationFingerprint === right.visibilityAttestationFingerprint,
  },
  {
    field: "repositoryReadbackFingerprint",
    same: (left, right) =>
      left.repositoryReadbackFingerprint === right.repositoryReadbackFingerprint,
  },
  {
    field: "expectedVisibility",
    same: (left, right) => left.expectedVisibility === right.expectedVisibility,
  },
  {
    field: "retryHistory",
    same: (left, right) =>
      fingerprintContract(left.retryHistory) === fingerprintContract(right.retryHistory),
  },
  { field: "branch", same: (left, right) => left.branch === right.branch },
  { field: "remoteUrl", same: (left, right) => left.remoteUrl === right.remoteUrl },
  {
    field: "beforeRemoteSha",
    same: (left, right) => left.beforeRemoteSha === right.beforeRemoteSha,
  },
  {
    field: "expectedCommitSha",
    same: (left, right) => left.expectedCommitSha === right.expectedCommitSha,
  },
  { field: "status", same: (left, right) => left.status === right.status },
  {
    field: "dispatchCount",
    same: (left, right) => left.dispatchCount === right.dispatchCount,
  },
  {
    field: "reconciliationKey",
    same: (left, right) => left.reconciliationKey === right.reconciliationKey,
  },
  { field: "startedAt", same: (left, right) => left.startedAt === right.startedAt },
  { field: "updatedAt", same: (left, right) => left.updatedAt === right.updatedAt },
  {
    field: "receipt",
    same: (left, right) =>
      fingerprintContract(left.receipt) === fingerprintContract(right.receipt),
  },
  { field: "diagnostic", same: (left, right) => left.diagnostic === right.diagnostic },
];

/**
 * Namespace faults carry an attempt id as well as a field name, so three of
 * them plus the id bound below is what fits beside the sentence inside the
 * ~400-character blocker record. A drifted write in practice reports one.
 */
const MAX_NAMED_NAMESPACE_FAULTS = 3;

/**
 * An attempt id is minted as "git-push-" plus a 40-character digest, so the
 * real ones arrive whole; the bound exists because the parser accepts any
 * identifier up to 256 characters out of persisted JSON, and three of those
 * would bury the sentence that explains them.
 */
const MAX_NAMED_ATTEMPT_ID = 52;

/**
 * Reported only if the digests disagree while every named facet agrees. The
 * facets cover both key sets and compare nested values by the same canonical
 * digest `sameNamespace` uses, so this is unreachable, and the suite drives
 * every facet to keep it that way. It exists so the path can never answer a
 * real mismatch with an empty list — a message that named nothing while
 * claiming a difference would be the defect being repaired here, one layer
 * down.
 */
const UNNAMED_NAMESPACE_FAULT = "an unnamed field";

/**
 * Attempt ids are safe to name where the compared values are not. Both sides of
 * every difference reported here have already been through
 * parseGitPushAttemptNamespaceV1, so each id has passed expectIdentifier — no
 * whitespace, quotes, "?", "=" or "&", which is every shape a query-string
 * secret needs — and both credential scans, and has been proved equal to the
 * key it is filed under. That is exactly what the unknown keys in `exact` lack:
 * those are read before any scan runs, which is why they are counted there and
 * named here.
 */
function boundedAttemptId(id: string): string {
  return id.length > MAX_NAMED_ATTEMPT_ID
    ? `${id.slice(0, MAX_NAMED_ATTEMPT_ID - 3)}...`
    : id;
}

/**
 * Says what differs between a written namespace and what came back, in the
 * vocabulary an operator can act on: the attempt, and the field inside it or
 * the fact that the record was not there. Ids are sorted so the same drift
 * always reports the same message.
 */
function describeNamespaceDifference(
  written: GitPushAttemptNamespaceV1,
  observed: GitPushAttemptNamespaceV1,
): string {
  const faults: string[] = [];
  for (const facet of GIT_PUSH_ATTEMPT_NAMESPACE_FACETS_V1) {
    if (!facet.same(written, observed)) faults.push(facet.field);
  }
  const writtenIds = Object.keys(written.attempts).sort();
  const observedIds = Object.keys(observed.attempts).sort();
  const present = new Set(observedIds);
  for (const id of writtenIds) {
    const counterpart = observed.attempts[id];
    if (!present.has(id)) {
      faults.push(`attempt ${boundedAttemptId(id)} vanished`);
      continue;
    }
    for (const facet of GIT_PUSH_ATTEMPT_RECORD_FACETS_V1) {
      if (!facet.same(written.attempts[id], counterpart)) {
        faults.push(`attempt ${boundedAttemptId(id)} ${facet.field}`);
      }
    }
  }
  const wrote = new Set(writtenIds);
  for (const id of observedIds) {
    if (!wrote.has(id)) faults.push(`attempt ${boundedAttemptId(id)} appeared`);
  }
  if (faults.length < 1) faults.push(UNNAMED_NAMESPACE_FAULT);
  return summarizeFaults(faults, MAX_NAMED_NAMESPACE_FAULTS);
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
