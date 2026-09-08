import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  commitGitPushAttemptNamespaceAfterVerifiedWriteV1,
  DurableGitPushAttemptStoreV1,
  parseGitPushAttemptNamespaceV1,
  GIT_PUSH_ATTEMPT_NAMESPACE_FACETS_V1,
  GIT_PUSH_ATTEMPT_RECORD_FACETS_V1,
  GIT_PUSH_RECEIPT_ATTEMPT_BINDINGS_V1,
  GIT_PUSH_RECEIPT_ATTEMPT_ORDERINGS_V1,
  type GitPushAttemptNamespaceV1,
} from "../src/integrations/github/GitPushAttemptStore";
import type {
  GitPushAttemptRecordV1,
  GitPushNotAppliedAttemptAuditV1,
  VerifiedGitPushReceiptV1,
} from "../src/integrations/github/VerifiedGitPushGateway";
import { fingerprintContract } from "../src/integrations/linear/LinearContractSupport";

const FP = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;

test("durable Git push attempts use CAS and retain ambiguous dispatch for readback", async () => {
  let namespace: GitPushAttemptNamespaceV1 | null = null;
  const store = new DurableGitPushAttemptStoreV1({
    async read() { return clone(namespace); },
    async write(next, expectedRevision) {
      assert.equal(expectedRevision, namespace?.revision ?? 0);
      namespace = clone(next);
      return true;
    },
  });
  const first = attempt();
  assert.equal(await store.save(first, null), true);
  assert.equal(await store.save({
    ...first,
    revision: 1,
    status: "reconcile_required",
    updatedAt: "2026-07-12T12:00:01.000Z",
    diagnostic: "Remote readback was unavailable.",
  }, 0), true);
  assert.equal((await store.load(first.id))?.status, "reconcile_required");
});

test("durable Git push attempts reject credentials and immutable binding drift", async () => {
  let namespace: GitPushAttemptNamespaceV1 | null = null;
  const store = new DurableGitPushAttemptStoreV1({
    async read() { return clone(namespace); },
    async write(next) { namespace = clone(next); return true; },
  });
  const first = attempt();
  await store.save(first, null);
  await assert.rejects(store.save({
    ...first,
    revision: 1,
    diagnostic: `Bearer ${"x".repeat(32)}`,
    updatedAt: "2026-07-12T12:00:01.000Z",
  }, 0), /credential material/i);
  await assert.rejects(store.save({
    ...first,
    revision: 1,
    bindingFingerprint: `sha256:${"b".repeat(64)}`,
    updatedAt: "2026-07-12T12:00:01.000Z",
  }, 0), /immutable/i);
});

test("failed durable save does not advance the cache and the same write may retry", async () => {
  let cached = parseGitPushAttemptNamespaceV1(null);
  let durable: GitPushAttemptNamespaceV1 | null = null;
  let failSave = true;
  const persistence = {
    async read() { return clone(durable); },
    async write(next: GitPushAttemptNamespaceV1, expectedRevision: number) {
      return commitGitPushAttemptNamespaceAfterVerifiedWriteV1({
        readCached: () => cached,
        async writeAndReadback(candidate, expected) {
          assert.equal(expected, expectedRevision);
          assert.equal(durable?.revision ?? 0, expected);
          if (failSave) throw new Error("simulated saveData failure");
          durable = clone(candidate);
          return clone(durable);
        },
        commitCached(namespace) { cached = clone(namespace); },
      }, next, expectedRevision);
    },
  };
  const store = new DurableGitPushAttemptStoreV1(persistence);
  const first = attempt();

  await assert.rejects(store.save(first, null), /simulated saveData failure/);
  assert.equal(cached.revision, 0);
  assert.equal(durable, null);

  failSave = false;
  assert.equal(await store.save(first, null), true);
  assert.equal(cached.revision, 1);
  assert.equal((await store.load(first.id))?.status, "dispatching");
});

test("durable attempt save rejects a success boolean without exact persisted readback", async () => {
  const store = new DurableGitPushAttemptStoreV1({
    async read() { return null; },
    async write() { return true; },
  });
  await assert.rejects(
    store.save(attempt(), null),
    /exact written namespace/i,
  );
  assert.equal(await store.load(attempt().id), null);
});

test("verified receipts are closed and cannot be swapped between attempts", () => {
  const first = verifiedAttempt({
    id: "git-push-attempt-a",
    handoffFingerprint: FP,
    bindingFingerprint: FP,
    visibilityBindingFingerprint: FP,
    visibilityAttestationFingerprint: FP,
    repositoryReadbackFingerprint: FP,
    branch: "codex/eng-12",
    expectedCommitSha: "a".repeat(40),
  });
  const second = verifiedAttempt({
    id: "git-push-attempt-b",
    handoffFingerprint: FP_B,
    bindingFingerprint: FP_B,
    visibilityBindingFingerprint: FP_B,
    visibilityAttestationFingerprint: FP_B,
    repositoryReadbackFingerprint: FP_B,
    branch: "codex/eng-13",
    expectedCommitSha: "b".repeat(40),
  });
  assert.throws(
    () => parseGitPushAttemptNamespaceV1({
      version: 1,
      revision: 2,
      attempts: {
        [first.id]: { ...first, receipt: second.receipt },
        [second.id]: second,
      },
    }),
    /does not match its containing attempt/i,
  );
  assert.throws(
    () => parseGitPushAttemptNamespaceV1({
      version: 1,
      revision: 1,
      attempts: {
        [first.id]: {
          ...first,
          receipt: { ...first.receipt, unexpected: true },
        },
      },
    }),
    /receipt keys are invalid/i,
  );
});

test("a receipt that matches its attempt is still accepted verbatim", () => {
  const base = verifiedAttempt(BASE_IDENTITY);
  const parsed = parseGitPushAttemptNamespaceV1({
    version: 1,
    revision: 1,
    attempts: { [base.id]: base },
  });
  assert.deepEqual(parsed.attempts[base.id], base);
});

test("a drifted receipt binding is named, and no other binding is", () => {
  const declared = GIT_PUSH_RECEIPT_ATTEMPT_BINDINGS_V1.map((binding) => binding.field);
  assert.deepEqual(
    Object.keys(BINDING_BREAKERS).sort(),
    [...declared].sort(),
    "every declared receipt binding needs a breaker here, so a new comparison cannot be added to the store without proving that the message names it",
  );
  const base = verifiedAttempt(BASE_IDENTITY);
  for (const field of declared) {
    const message = messageFromParse(BINDING_BREAKERS[field](base));
    assert.deepEqual(
      mismatchList(message, "mismatched: "),
      [field],
      `the message for a drifted ${field} named the wrong bindings`,
    );
    assertMessageNamesNoValues(message);
  }
});

test("a receipt timestamp fault is named, and the unreachable ordering is proved unreachable", () => {
  const declared = GIT_PUSH_RECEIPT_ATTEMPT_ORDERINGS_V1.map((ordering) => ordering.fault);
  assert.deepEqual(
    Object.keys(ORDERING_PROBES).sort(),
    [...declared].sort(),
    "every declared ordering needs a probe here, so a new ordering cannot be added to the store without proving what its message says",
  );
  const base = verifiedAttempt(BASE_IDENTITY);
  for (const fault of declared) {
    const probe = ORDERING_PROBES[fault];
    const message = messageFromParse(probe.drift(base));
    if (probe.reachable) {
      assert.deepEqual(mismatchList(message, ""), [fault]);
    } else {
      // This ordering cannot be reached through the record boundary: the
      // receipt parser rejects the same evidence first. Asserting the earlier
      // rejection keeps the claim positive rather than skipping the case.
      assert.match(message, probe.earlierRejection);
    }
    assertMessageNamesNoValues(message);
  }
});

test("a receipt from another attempt reports a bounded, capped list of bindings", () => {
  const first = verifiedAttempt(BASE_IDENTITY);
  const second = verifiedAttempt({
    id: "git-push-attempt-b",
    handoffFingerprint: FP_B,
    bindingFingerprint: FP_B,
    visibilityBindingFingerprint: FP_B,
    visibilityAttestationFingerprint: FP_B,
    repositoryReadbackFingerprint: FP_B,
    branch: "codex/eng-13",
    expectedCommitSha: "b".repeat(40),
  });
  const message = messageFromParse({ ...first, receipt: second.receipt });
  const named = mismatchList(message, "mismatched: ");
  assert.equal(named.length, MAX_NAMED_FAULTS);
  assert.match(named[named.length - 1], / and \d+ more$/u);
  const declared = new Set(GIT_PUSH_RECEIPT_ATTEMPT_BINDINGS_V1.map((binding) => binding.field));
  for (const entry of named) {
    assert.ok(
      declared.has(entry.replace(/ and \d+ more$/u, "")),
      `the message invented a binding name: ${entry}`,
    );
  }
  assertMessageNamesNoValues(message);
});

test("receipt mismatch messages never quote a remote URL that can carry a token", () => {
  // The trusted-host check rejects userinfo but not a query string, and the
  // credential scan does not recognise a bare access_token parameter, so a
  // remote URL holding a secret really does reach this validation. Proving it
  // is accepted first is what makes the redaction assertion below non-vacuous.
  const sealed = verifiedAttempt(BASE_IDENTITY);
  const tokened = withReceipt(
    { ...sealed, remoteUrl: TOKEN_BEARING_URL },
    { remoteUrl: TOKEN_BEARING_URL },
  );
  assert.doesNotThrow(() =>
    parseGitPushAttemptNamespaceV1({
      version: 1,
      revision: 1,
      attempts: { [tokened.id]: tokened },
    }),
  );
  const message = messageFromParse({
    ...tokened,
    receipt: withReceipt(tokened, { remoteUrl: OTHER_REMOTE_URL }).receipt,
  });
  assert.deepEqual(mismatchList(message, "mismatched: "), ["remote URL"]);
  assertMessageNamesNoValues(message);
});

test("receipt-attempt validation keeps every comparison inside the named tables", () => {
  const source = readFileSync(
    new URL("../src/integrations/github/GitPushAttemptStore.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function validateReceiptAgainstAttempt(");
  assert.notEqual(start, -1);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.ok(
    !/[!=]==/u.test(body),
    "a comparison was inlined into validateReceiptAgainstAttempt; it belongs in one of the named tables or its failure cannot be reported by name",
  );
  assert.ok(body.includes("GIT_PUSH_RECEIPT_ATTEMPT_BINDINGS_V1"));
  assert.ok(body.includes("GIT_PUSH_RECEIPT_ATTEMPT_ORDERINGS_V1"));
});

test("the namespace difference tables cover every field the digest compares", () => {
  const parsed = parseGitPushAttemptNamespaceV1(rawNamespace(DISPATCHING));
  const namespaceKeys = Object.keys(parsed).sort();
  assert.deepEqual(
    [...GIT_PUSH_ATTEMPT_NAMESPACE_FACETS_V1.map((facet) => facet.field), "attempts"].sort(),
    namespaceKeys,
    "sameNamespace digests the whole namespace, so a field it compares that no facet names would drift without the message saying so; attempts is named through membership and the record facets instead",
  );
  const recordKeys = Object.keys(parsed.attempts[DISPATCHING.id]).sort();
  assert.deepEqual(
    GIT_PUSH_ATTEMPT_RECORD_FACETS_V1.map((facet) => facet.field).sort(),
    recordKeys,
    "every field of a parsed attempt needs a facet, so a field added to the record cannot drift unnamed",
  );
  assert.deepEqual(
    Object.keys(NAMESPACE_DRIFTS).sort(),
    namespaceKeys,
    "every namespace field needs a drift here, so a new comparison cannot be added without proving what its message says",
  );
  assert.deepEqual(
    Object.keys(RECORD_DRIFTS).sort(),
    recordKeys,
    "every attempt field needs a drift here, so a new comparison cannot be added without proving what its message says",
  );
});

test("a drifted namespace field is named, and no other field is", async () => {
  for (const [field, drift] of Object.entries(NAMESPACE_DRIFTS)) {
    const written = parseGitPushAttemptNamespaceV1(rawNamespace(DISPATCHING));
    const message = await commitReadbackMessage(written, drift.observed(written));
    if (drift.reachable) {
      assert.deepEqual(
        mismatchList(message, "differs: "),
        [...drift.faults],
        `the message for a drifted namespace ${field} named the wrong fields`,
      );
    } else {
      // The difference cannot reach the digest comparison: the namespace parser
      // refuses this shape first. Asserting that earlier rejection keeps the
      // claim positive rather than skipping the field.
      assert.match(message, drift.earlierRejection);
    }
    assertMessageNamesNoValues(message);
  }
});

test("a drifted attempt field is named against its attempt, and no other field is", async () => {
  for (const [field, drift] of Object.entries(RECORD_DRIFTS)) {
    if (!drift.reachable) {
      // Same shape as above: prove the parser refuses the differing record
      // before the digest ever compares it, rather than leaving a silent hole.
      assert.throws(() => parseGitPushAttemptNamespaceV1(drift.rejected()), drift.earlierRejection);
      continue;
    }
    const written = parseGitPushAttemptNamespaceV1(rawNamespace(drift.base));
    const message = await commitReadbackMessage(
      written,
      rawNamespace({ ...drift.base, ...drift.patch }),
    );
    assert.deepEqual(
      mismatchList(message, "differs: "),
      [`attempt ${drift.base.id} ${field}`],
      `the message for a drifted ${field} named the wrong fields`,
    );
    assertMessageNamesNoValues(message);
  }
});

test("a record the durable writer dropped or invented is named by id", async () => {
  const written = parseGitPushAttemptNamespaceV1(
    rawNamespace(DISPATCHING, VERIFIED),
  );
  const dropped = await commitReadbackMessage(written, rawNamespace(VERIFIED));
  assert.deepEqual(
    mismatchList(dropped, "differs: "),
    [`attempt ${DISPATCHING.id} vanished`],
  );
  const invented = await commitReadbackMessage(
    parseGitPushAttemptNamespaceV1(rawNamespace(VERIFIED)),
    rawNamespace(VERIFIED, DISPATCHING),
  );
  assert.deepEqual(
    mismatchList(invented, "differs: "),
    [`attempt ${DISPATCHING.id} appeared`],
  );
  assertMessageNamesNoValues(dropped);
  assertMessageNamesNoValues(invented);
});

test("an in-memory namespace that moved under a durable write names what moved", async () => {
  const before = parseGitPushAttemptNamespaceV1(rawNamespace(DISPATCHING));
  const after = parseGitPushAttemptNamespaceV1(
    rawNamespace({ ...DISPATCHING, status: "reconcile_required" }),
  );
  const message = await cacheDriftMessage(before, after);
  assert.match(message, /in-memory namespace changed during its durable write/u);
  assert.deepEqual(
    mismatchList(message, "differs: "),
    [`attempt ${DISPATCHING.id} status`],
  );
  assertMessageNamesNoValues(message);
});

test("a durable save whose readback lost the record names the record", async () => {
  const message = await saveReadbackMessage(DISPATCHING, () => ({
    version: 1,
    revision: 1,
    attempts: {},
  }));
  assert.match(message, /did not return the exact written namespace/u);
  assert.deepEqual(
    mismatchList(message, "differs: "),
    [`attempt ${DISPATCHING.id} vanished`],
  );
  assertMessageNamesNoValues(message);
});

test("a durable save whose readback rewrote a field names that field", async () => {
  const message = await saveReadbackMessage(DISPATCHING, (written) => ({
    ...written,
    attempts: {
      [DISPATCHING.id]: { ...DISPATCHING, dispatchCount: 0 },
    },
  }));
  assert.deepEqual(
    mismatchList(message, "differs: "),
    [`attempt ${DISPATCHING.id} dispatchCount`],
  );
  assertMessageNamesNoValues(message);
});

test("a namespace that differs everywhere reports a bounded, capped list", async () => {
  // Ids are bounded, not sanitised: the parser accepts any identifier up to 256
  // characters out of persisted JSON, and three untrimmed ones would push the
  // sentence that explains them out of the blocker record.
  const wide = [0, 1, 2, 3].map((index) => ({
    ...DISPATCHING,
    id: `git-push-attempt-${String(index)}${"a".repeat(238)}`,
  }));
  const written = parseGitPushAttemptNamespaceV1(rawNamespace(...wide));
  const message = await commitReadbackMessage(
    written,
    rawNamespace(
      ...wide.map((record) => ({
        ...record,
        revision: 9,
        status: "reconcile_required" as const,
        visibilityAttestationFingerprint: FP_B,
        diagnostic: "Remote readback was unavailable.",
      })),
    ),
  );
  const named = mismatchList(message, "differs: ");
  assert.equal(named.length, MAX_NAMED_NAMESPACE_FAULTS);
  assert.match(named[named.length - 1], / and \d+ more$/u);
  for (const entry of named) {
    const id = /^attempt (\S+) /u.exec(entry)?.[1];
    assert.ok(id, `the message named a fault without its attempt: ${entry}`);
    assert.ok(
      id.length <= MAX_NAMED_ATTEMPT_ID,
      `the message carried an unbounded attempt id: ${String(id.length)} characters`,
    );
    assert.match(id, /\.\.\.$/u, "an id past the bound must say it was trimmed");
  }
  assertMessageNamesNoValues(message);
});

test("namespace difference keeps every comparison inside the named tables", () => {
  const source = readFileSync(
    new URL("../src/integrations/github/GitPushAttemptStore.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function describeNamespaceDifference(");
  assert.notEqual(start, -1);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.ok(
    !/[!=]==/u.test(body),
    "a comparison was inlined into describeNamespaceDifference; it belongs in one of the named tables or its failure cannot be reported by name",
  );
  assert.ok(body.includes("GIT_PUSH_ATTEMPT_NAMESPACE_FACETS_V1"));
  assert.ok(body.includes("GIT_PUSH_ATTEMPT_RECORD_FACETS_V1"));
});

function attempt(): GitPushAttemptRecordV1 {
  return {
    version: 1,
    id: "git-push-attempt-1",
    revision: 0,
    handoffFingerprint: FP,
    bindingFingerprint: FP,
    visibilityBindingFingerprint: FP,
    visibilityAttestationFingerprint: FP,
    repositoryReadbackFingerprint: FP,
    expectedVisibility: "private",
    retryHistory: [],
    branch: "codex/eng-12",
    remoteUrl: "https://github.com/acme/research-agent.git",
    beforeRemoteSha: null,
    expectedCommitSha: "a".repeat(40),
    status: "dispatching",
    dispatchCount: 1,
    reconciliationKey: "github-ref:acme/research-agent:refs/heads/codex/eng-12",
    startedAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:00.000Z",
    receipt: null,
    diagnostic: null,
  };
}

function verifiedAttempt(
  identity: Pick<
    GitPushAttemptRecordV1,
    | "id"
    | "handoffFingerprint"
    | "bindingFingerprint"
    | "visibilityBindingFingerprint"
    | "visibilityAttestationFingerprint"
    | "repositoryReadbackFingerprint"
    | "branch"
    | "expectedCommitSha"
  >,
): GitPushAttemptRecordV1 {
  const base: GitPushAttemptRecordV1 = {
    ...attempt(),
    ...identity,
    revision: 1,
    status: "verified",
    updatedAt: "2026-07-12T12:00:01.000Z",
  };
  const evidence: Omit<VerifiedGitPushReceiptV1, "fingerprint"> = {
    version: 1,
    kind: "verified_git_push",
    id: `github-push-${fingerprintContract({
      handoff: base.handoffFingerprint,
      visibilityBinding: base.visibilityBindingFingerprint,
      expectedVisibility: base.expectedVisibility,
    }).slice("sha256:".length, "sha256:".length + 32)}`,
    status: "verified",
    commitKind: "committed",
    handoffId: `handoff-${base.id.slice(-1)}`,
    handoffFingerprint: base.handoffFingerprint,
    repositoryBindingKey: "github:acme/research-agent",
    repositoryBindingFingerprint: base.bindingFingerprint,
    repositoryVisibility: base.expectedVisibility,
    repositoryVisibilityBindingFingerprint:
      base.visibilityBindingFingerprint,
    repositoryVisibilityAttestationFingerprint:
      base.visibilityAttestationFingerprint,
    repositoryReadbackFingerprint: base.repositoryReadbackFingerprint,
    repositoryProfileKey: "repository-profile:research-agent",
    repositoryProfileFingerprint: FP,
    canonicalWorktreeRoot: "C:\\work\\research-agent",
    canonicalWorktreeFingerprint: FP,
    remoteUrl: base.remoteUrl,
    branch: base.branch,
    baseBranch: "main",
    beforeRemoteSha: base.beforeRemoteSha,
    remoteSha: base.expectedCommitSha,
    baseSha: "c".repeat(40),
    parentSha: "c".repeat(40),
    commitSha: base.expectedCommitSha,
    treeSha: "d".repeat(40),
    diffFingerprint: FP,
    artifactFingerprint: FP,
    localCommitReceiptId: "local-commit-receipt-1",
    localCommitReceiptFingerprint: FP,
    targetedValidationReceiptId: "targeted-validation-1",
    fullValidationReceiptId: "full-validation-1",
    targetedValidationFingerprint: FP,
    fullValidationFingerprint: FP,
    pushedAt: "2026-07-12T12:00:00.500Z",
    verifiedAt: base.updatedAt,
  };
  return {
    ...base,
    receipt: { ...evidence, fingerprint: fingerprintContract(evidence) },
  };
}

const BASE_IDENTITY = {
  id: "git-push-attempt-a",
  handoffFingerprint: FP,
  bindingFingerprint: FP,
  visibilityBindingFingerprint: FP,
  visibilityAttestationFingerprint: FP,
  repositoryReadbackFingerprint: FP,
  branch: "codex/eng-12",
  expectedCommitSha: "a".repeat(40),
} as const;

const OTHER_REMOTE_URL = "https://github.com/acme/other-agent.git";
// A query string survives the trusted-host check and the credential scan does
// not recognise this parameter, so this is exactly the shape of remote URL the
// message must describe rather than quote.
const TOKEN_BEARING_URL =
  "https://github.com/acme/research-agent.git?access_token=tokenvalue0123456789abcdef";

/** Mirrors MAX_NAMED_FAULTS in the store; the cap is part of the contract. */
const MAX_NAMED_FAULTS = 5;
/** The blocker record downstream truncates near this many characters. */
const MAX_BLOCKER_MESSAGE = 400;

const CREDENTIAL_SHAPED =
  /(?:access[_-]?token|api[_-]?key|password|secret|token=|bearer\s+\S+|gh[pousr]_[A-Za-z0-9]{8,})/iu;

const SENSITIVE_VALUES = [
  FP,
  FP_B,
  "a".repeat(40),
  "b".repeat(40),
  "c".repeat(40),
  "d".repeat(40),
  "e".repeat(40),
  "f".repeat(40),
  "https://github.com/acme/research-agent.git",
  OTHER_REMOTE_URL,
  TOKEN_BEARING_URL,
  "codex/eng-12",
  "codex/eng-13",
  "codex/eng-99",
  "github-ref:acme/research-agent:refs/heads/codex/eng-12",
  "2026-07-12T11:59:59.000Z",
  "2026-07-12T12:00:00.000Z",
  "2026-07-12T12:00:00.500Z",
  "2026-07-12T12:00:01.000Z",
  "2026-07-12T12:00:02.000Z",
  "2026-07-12T12:00:03.000Z",
];

/**
 * One drift per declared binding. Each breaker moves a single receipt field so
 * exactly one comparison in the store's table can fail, which is what lets the
 * assertions prove the message names that binding and not its neighbours.
 */
const BINDING_BREAKERS: Record<
  string,
  (base: GitPushAttemptRecordV1) => GitPushAttemptRecordV1
> = {
  "receipt id": (base) =>
    withReceipt(base, { id: "github-push-0123456789abcdef0123456789abcdef" }),
  "handoff fingerprint": (base) => withReceipt(base, { handoffFingerprint: FP_B }),
  "binding fingerprint": (base) =>
    withReceipt(base, { repositoryBindingFingerprint: FP_B }),
  "visibility binding fingerprint": (base) =>
    withReceipt(base, { repositoryVisibilityBindingFingerprint: FP_B }),
  "visibility attestation fingerprint": (base) =>
    withReceipt(base, { repositoryVisibilityAttestationFingerprint: FP_B }),
  "repository readback fingerprint": (base) =>
    withReceipt(base, { repositoryReadbackFingerprint: FP_B }),
  "repository visibility": (base) =>
    withReceipt(base, { repositoryVisibility: "public" }),
  "remote URL": (base) => withReceipt(base, { remoteUrl: OTHER_REMOTE_URL }),
  branch: (base) => withReceipt(base, { branch: "codex/eng-99" }),
  "before-remote SHA": (base) => withReceipt(base, { beforeRemoteSha: "e".repeat(40) }),
  "remote SHA": (base) => withReceipt(base, { remoteSha: "f".repeat(40) }),
  "commit SHA": (base) => withReceipt(base, { commitSha: "f".repeat(40) }),
  "verified-at": (base) => withReceipt(base, { verifiedAt: "2026-07-12T12:00:02.000Z" }),
};

type OrderingProbe = {
  readonly drift: (base: GitPushAttemptRecordV1) => GitPushAttemptRecordV1;
} & (
  | { readonly reachable: true }
  | { readonly reachable: false; readonly earlierRejection: RegExp }
);

const ORDERING_PROBES: Record<string, OrderingProbe> = {
  "pushed-at precedes the attempt start": {
    reachable: true,
    drift: (base) => withReceipt(base, { pushedAt: "2026-07-12T11:59:59.000Z" }),
  },
  "pushed-at follows its own verification": {
    reachable: false,
    earlierRejection: /verification predates its push evidence/iu,
    drift: (base) => withReceipt(base, { pushedAt: "2026-07-12T12:00:03.000Z" }),
  },
};

/** Mirrors MAX_NAMED_NAMESPACE_FAULTS in the store; the cap is part of the contract. */
const MAX_NAMED_NAMESPACE_FAULTS = 3;
/** Mirrors MAX_NAMED_ATTEMPT_ID in the store; so is the id bound. */
const MAX_NAMED_ATTEMPT_ID = 52;

const DISPATCHING = attempt();
const VERIFIED = verifiedAttempt(BASE_IDENTITY);

const NOT_APPLIED_AUDIT: GitPushNotAppliedAttemptAuditV1 = (() => {
  const evidence: Omit<GitPushNotAppliedAttemptAuditV1, "fingerprint"> = {
    outcome: "not_applied",
    revision: 0,
    visibilityAttestationFingerprint: FP,
    beforeRemoteSha: null,
    dispatchCount: 1,
    startedAt: "2026-07-12T12:00:00.000Z",
    notAppliedAt: "2026-07-12T12:00:00.000Z",
    diagnostic: "Remote readback was unavailable.",
  };
  return { ...evidence, fingerprint: fingerprintContract(evidence) };
})();

type NamespaceDrift = {
  readonly observed: (written: GitPushAttemptNamespaceV1) => unknown;
} & (
  | { readonly reachable: true; readonly faults: readonly string[] }
  | { readonly reachable: false; readonly earlierRejection: RegExp }
);

/**
 * One drift per namespace field, so the message for each can be read off the
 * real boundary rather than off the source. `attempts` is driven through a
 * dropped record because that is how the namespace map differs; the fields
 * inside a surviving record are RECORD_DRIFTS below.
 */
const NAMESPACE_DRIFTS: Record<string, NamespaceDrift> = {
  version: {
    reachable: false,
    earlierRejection: /Unsupported Git push attempt namespace version/u,
    observed: (written) => ({ ...written, version: 2 }),
  },
  revision: {
    reachable: true,
    faults: ["revision"],
    observed: (written) => ({ ...written, revision: written.revision + 1 }),
  },
  attempts: {
    reachable: true,
    faults: [`attempt ${DISPATCHING.id} vanished`],
    observed: (written) => ({ ...written, attempts: {} }),
  },
};

type RecordDrift =
  | {
      readonly reachable: true;
      readonly base: GitPushAttemptRecordV1;
      readonly patch: Partial<GitPushAttemptRecordV1>;
    }
  | {
      readonly reachable: false;
      readonly rejected: () => unknown;
      readonly earlierRejection: RegExp;
    };

/**
 * One drift per attempt field. Each moves a single field of a record that both
 * sides otherwise share, so exactly one facet in the store's table can fail,
 * which is what lets the assertions prove the message names that field against
 * that attempt and not its neighbours. `receipt` drifts off the verified
 * fixture because a receipt cannot appear on a dispatching attempt at all;
 * moving a receipt field the attempt does not bind leaves `receipt` as the one
 * difference.
 */
const RECORD_DRIFTS: Record<string, RecordDrift> = {
  version: {
    reachable: false,
    earlierRejection: /Unsupported Git push attempt version/u,
    rejected: () => ({
      version: 1,
      revision: 1,
      attempts: { [DISPATCHING.id]: { ...DISPATCHING, version: 2 } },
    }),
  },
  id: {
    reachable: false,
    earlierRejection: /key does not match its identity/u,
    rejected: () => ({
      version: 1,
      revision: 1,
      attempts: { "git-push-attempt-elsewhere": DISPATCHING },
    }),
  },
  revision: { reachable: true, base: DISPATCHING, patch: { revision: 7 } },
  handoffFingerprint: {
    reachable: true,
    base: DISPATCHING,
    patch: { handoffFingerprint: FP_B },
  },
  bindingFingerprint: {
    reachable: true,
    base: DISPATCHING,
    patch: { bindingFingerprint: FP_B },
  },
  visibilityBindingFingerprint: {
    reachable: true,
    base: DISPATCHING,
    patch: { visibilityBindingFingerprint: FP_B },
  },
  visibilityAttestationFingerprint: {
    reachable: true,
    base: DISPATCHING,
    patch: { visibilityAttestationFingerprint: FP_B },
  },
  repositoryReadbackFingerprint: {
    reachable: true,
    base: DISPATCHING,
    patch: { repositoryReadbackFingerprint: FP_B },
  },
  expectedVisibility: {
    reachable: true,
    base: DISPATCHING,
    patch: { expectedVisibility: "public" },
  },
  retryHistory: {
    reachable: true,
    base: DISPATCHING,
    patch: { retryHistory: [NOT_APPLIED_AUDIT] },
  },
  branch: { reachable: true, base: DISPATCHING, patch: { branch: "codex/eng-99" } },
  remoteUrl: { reachable: true, base: DISPATCHING, patch: { remoteUrl: OTHER_REMOTE_URL } },
  beforeRemoteSha: {
    reachable: true,
    base: DISPATCHING,
    patch: { beforeRemoteSha: "e".repeat(40) },
  },
  expectedCommitSha: {
    reachable: true,
    base: DISPATCHING,
    patch: { expectedCommitSha: "f".repeat(40) },
  },
  status: { reachable: true, base: DISPATCHING, patch: { status: "reconcile_required" } },
  dispatchCount: { reachable: true, base: DISPATCHING, patch: { dispatchCount: 0 } },
  reconciliationKey: {
    reachable: true,
    base: DISPATCHING,
    patch: { reconciliationKey: "github-ref:acme/research-agent:refs/heads/codex/eng-99" },
  },
  startedAt: {
    reachable: true,
    base: DISPATCHING,
    patch: { startedAt: "2026-07-12T11:59:59.000Z" },
  },
  updatedAt: {
    reachable: true,
    base: DISPATCHING,
    patch: { updatedAt: "2026-07-12T12:00:02.000Z" },
  },
  receipt: {
    reachable: true,
    base: VERIFIED,
    patch: { receipt: withReceipt(VERIFIED, { treeSha: "e".repeat(40) }).receipt },
  },
  diagnostic: {
    reachable: true,
    base: DISPATCHING,
    patch: { diagnostic: "Remote readback was unavailable." },
  },
};

function rawNamespace(...records: readonly GitPushAttemptRecordV1[]): unknown {
  return {
    version: 1,
    revision: 1,
    attempts: Object.fromEntries(records.map((record) => [record.id, record])),
  };
}

/** Drives the real commit boundary and returns the message it refused with. */
async function commitReadbackMessage(
  written: GitPushAttemptNamespaceV1,
  observed: unknown,
): Promise<string> {
  const refusal = "the commit accepted a readback that is not the written namespace";
  try {
    await commitGitPushAttemptNamespaceAfterVerifiedWriteV1(
      {
        readCached: () => written,
        async writeAndReadback() {
          return observed;
        },
        commitCached() {
          assert.fail(refusal);
        },
      },
      written,
      written.revision,
    );
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail(refusal);
}

/** Moves the in-memory cache between the two reads that bracket the write. */
async function cacheDriftMessage(
  before: GitPushAttemptNamespaceV1,
  after: GitPushAttemptNamespaceV1,
): Promise<string> {
  const refusal = "the commit accepted a cache that moved under its durable write";
  let reads = 0;
  try {
    await commitGitPushAttemptNamespaceAfterVerifiedWriteV1(
      {
        readCached() {
          reads += 1;
          return reads > 1 ? after : before;
        },
        async writeAndReadback(candidate) {
          return candidate;
        },
        commitCached() {
          assert.fail(refusal);
        },
      },
      before,
      before.revision,
    );
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail(refusal);
}

/** Drives the real durable save and returns the message its readback refused with. */
async function saveReadbackMessage(
  record: GitPushAttemptRecordV1,
  rewrite: (written: GitPushAttemptNamespaceV1) => unknown,
): Promise<string> {
  let durable: unknown = null;
  const store = new DurableGitPushAttemptStoreV1({
    async read() {
      return clone(durable);
    },
    async write(next) {
      durable = rewrite(next);
      return true;
    },
  });
  try {
    await store.save(record, null);
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail("the store accepted a readback that is not the written namespace");
}

function withReceipt(
  base: GitPushAttemptRecordV1,
  patch: Partial<VerifiedGitPushReceiptV1>,
): GitPushAttemptRecordV1 {
  assert.ok(base.receipt, "the fixture attempt must already carry a receipt");
  const { fingerprint: sealed, ...evidence } = { ...base.receipt, ...patch };
  assert.equal(typeof sealed, "string");
  return { ...base, receipt: { ...evidence, fingerprint: fingerprintContract(evidence) } };
}

/** Drives the real parse boundary and returns the message it refused with. */
function messageFromParse(record: GitPushAttemptRecordV1): string {
  try {
    parseGitPushAttemptNamespaceV1({
      version: 1,
      revision: 1,
      attempts: { [record.id]: record },
    });
  } catch (error) {
    return (error as Error).message;
  }
  return assert.fail("the store accepted a receipt that does not match its attempt");
}

function mismatchList(message: string, prefix: string): string[] {
  const match = new RegExp(`\\(${prefix}(.+)\\)\\.$`, "u").exec(message);
  assert.ok(match, `the message carried no named faults: ${message}`);
  return match[1].split(", ");
}

/**
 * Attempt ids are deliberately absent from SENSITIVE_VALUES: a namespace fault
 * has to say which attempt it happened in, and by the time it is reported the
 * id has been through expectIdentifier and both credential scans. Everything a
 * record is compared on stays out.
 */
function assertMessageNamesNoValues(message: string): void {
  assert.ok(
    message.length <= MAX_BLOCKER_MESSAGE,
    `the message would be truncated in a blocker record: ${message.length} characters`,
  );
  for (const value of SENSITIVE_VALUES) {
    assert.ok(!message.includes(value), `the message quoted a compared value: ${value}`);
  }
  assert.ok(!message.includes("sha256:"), `the message quoted a digest: ${message}`);
  assert.ok(
    !CREDENTIAL_SHAPED.test(message),
    `the message carried credential-shaped text: ${message}`,
  );
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
