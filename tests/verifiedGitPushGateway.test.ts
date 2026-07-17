import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createVerifiedCodePublicationHandoffV1 } from "../packages/core-api/src/verifiedCodePublicationHandoffV1";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import type { VerifiedLocalCommitReceiptV1 } from "../extensions/code/repair/types";
import {
  buildTrustedGitHubHttpsRemoteUrlV1,
  createTrustedGitHubRepositoryBindingV1,
  parseTrustedGitHubRepositoryBindingV1,
} from "../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  VerifiedGitPushErrorV1,
  VerifiedGitPushGatewayV1,
  type EphemeralGitAskpassBrokerV1,
  type GitPushAttemptRecordV1,
  type GitPushAttemptStoreV1,
  type VerifiedGitCommandRunnerV1,
} from "../src/integrations/github/VerifiedGitPushGateway";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);
const REMOTE_OLD = "d".repeat(40);
const FP_A = `sha256:${"a".repeat(64)}`;
const FP_B = `sha256:${"b".repeat(64)}`;
const ROOT = "C:\\agent-worktrees\\repair-1";
const TOKEN = "github-secret-that-must-never-cross-the-broker";

test("VerifiedGitPushGateway pushes a new agent branch and verifies remote readback", async () => {
  const fixture = createFixture();
  const result = await fixture.gateway.push(fixture.input);

  assert.equal(result.status, "pushed_verified");
  if (result.status !== "pushed_verified") return;
  assert.equal(result.receipt.commitKind, "committed");
  assert.equal(result.receipt.remoteSha, COMMIT);
  assert.equal(result.receipt.remoteUrl, "https://github.com/acme/research-agent.git");
  assert.equal(result.receipt.diffFingerprint, FP_A);
  assert.equal(result.receipt.fullValidationFingerprint, FP_B);
  assert.equal(fixture.runner.pushes, 1);
  assert.equal(fixture.broker.calls, 1);

  const serialized = JSON.stringify(fixture.runner.calls);
  assert.doesNotMatch(serialized, new RegExp(TOKEN, "u"));
  assert.doesNotMatch(serialized, /--force/iu);
  const push = fixture.runner.calls.find((call) => operation(call.args) === "push");
  assert.ok(push);
  assert.equal(push?.inheritEnvironment, false);
  assert.deepEqual(push?.args.slice(-7), [
    "push",
    "--atomic",
    "--porcelain",
    "--no-verify",
    "https://github.com/acme/research-agent.git",
    `${BASE}:refs/heads/main`,
    `${COMMIT}:refs/heads/codex/repair-1`,
  ]);
  assert.equal(push?.environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(push?.environment.GIT_ASKPASS, "C:\\askpass\\github-helper.exe");
  assert.equal(push?.environment.AGENTIC_RESEARCHER_ASKPASS_HANDLE, "opaque-handle-1");
  assert.deepEqual(Object.keys(push?.environment ?? {}).sort(), [
    "AGENTIC_RESEARCHER_ASKPASS_HANDLE",
    "GCM_INTERACTIVE",
    "GIT_ASKPASS",
    "GIT_ASKPASS_REQUIRE",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
  ]);
});

test("VerifiedGitPushGateway permits only a verified fast-forward update", async () => {
  const fixture = createFixture({ remoteSha: REMOTE_OLD });
  const result = await fixture.gateway.push(fixture.input);
  assert.equal(result.status, "pushed_verified");
  assert.equal(fixture.runner.fetches, 1);
  assert.equal(fixture.runner.mergeBaseChecks, 1);
  assert.equal(fixture.runner.pushes, 1);

  const rejected = createFixture({ remoteSha: REMOTE_OLD, fastForward: false });
  await assert.rejects(
    rejected.gateway.push(rejected.input),
    (error: unknown) => error instanceof VerifiedGitPushErrorV1 && error.code === "remote_non_fast_forward",
  );
  assert.equal(rejected.runner.pushes, 0);
});

test("ambiguous push is persisted for reconciliation and is never retried", async () => {
  const fixture = createFixture({ pushMode: "applied_throw" });
  const first = await fixture.gateway.push(fixture.input);
  assert.equal(first.status, "reconcile_required");
  assert.equal(fixture.runner.pushes, 1);

  const second = await fixture.gateway.push(fixture.input);
  assert.equal(second.status, "reconcile_required");
  assert.equal(fixture.runner.pushes, 1, "a durable ambiguous attempt must suppress retry");

  const reconciled = await fixture.gateway.reconcile(fixture.input);
  assert.equal(reconciled.status, "pushed_verified");
  if (reconciled.status === "pushed_verified") {
    assert.equal(reconciled.receipt.commitKind, "reconciled");
  }
  assert.equal(fixture.runner.pushes, 1);
});

test("failed remote readback remains reconcile-required without a second dispatch", async () => {
  const fixture = createFixture({ pushMode: "readback_mismatch" });
  const result = await fixture.gateway.push(fixture.input);
  assert.equal(result.status, "reconcile_required");
  assert.equal(fixture.runner.pushes, 1);
  assert.equal((await fixture.gateway.push(fixture.input)).status, "reconcile_required");
  assert.equal(fixture.runner.pushes, 1);
});

test("local commit identity drift blocks before remote access", async () => {
  const fixture = createFixture({ localTreeSha: "e".repeat(40) });
  await assert.rejects(
    fixture.gateway.push(fixture.input),
    (error: unknown) => error instanceof VerifiedGitPushErrorV1 && error.code === "local_commit_drift",
  );
  assert.equal(fixture.runner.remoteReads, 0);
  assert.equal(fixture.broker.calls, 0);
});

test("an already-present exact remote commit is verified without push", async () => {
  const fixture = createFixture({ remoteSha: COMMIT, remoteBaseSha: BASE });
  const result = await fixture.gateway.push(fixture.input);
  assert.equal(result.status, "pushed_verified");
  if (result.status === "pushed_verified") assert.equal(result.receipt.commitKind, "already_present");
  assert.equal(fixture.runner.pushes, 0);
});

test("an existing remote base that differs from the verified local base blocks atomically", async () => {
  const fixture = createFixture({ remoteBaseSha: REMOTE_OLD });
  await assert.rejects(
    fixture.gateway.push(fixture.input),
    (error: unknown) =>
      error instanceof VerifiedGitPushErrorV1 && error.code === "remote_non_fast_forward",
  );
  assert.equal(fixture.runner.pushes, 0);
});

test("trusted GitHub binding is closed, profile-bound, and builds the remote host-side", () => {
  const fixture = createFixture();
  assert.equal(buildTrustedGitHubHttpsRemoteUrlV1(fixture.binding), "https://github.com/acme/research-agent.git");
  assert.throws(
    () => parseTrustedGitHubRepositoryBindingV1({ ...fixture.binding, owner: "evil/other" }),
    /owner is invalid/iu,
  );
  assert.throws(
    () => parseTrustedGitHubRepositoryBindingV1({ ...fixture.binding, remoteUrl: "https://evil.example/repo.git" }),
    /closed contract/iu,
  );
});

function createFixture(options: {
  remoteSha?: string | null;
  remoteBaseSha?: string | null;
  fastForward?: boolean;
  pushMode?: "success" | "applied_throw" | "readback_mismatch";
  localTreeSha?: string;
} = {}) {
  const profile = detectRepositoryProfileV2({
    key: "fixture",
    displayName: "Fixture",
    repositoryRoot: "C:\\repos\\fixture",
    defaultBranch: "main",
    files: ["package.json", "package-lock.json"],
    requiredGitHubChecks: ["ci"],
  });
  const binding = createTrustedGitHubRepositoryBindingV1({
    key: "github-fixture",
    profile,
    owner: "acme",
    repository: "research-agent",
    repositoryId: 101,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-12T12:02:00.000Z",
  });
  const handoff = createVerifiedCodePublicationHandoffV1({
    id: "handoff-1",
    repositoryProfileKey: profile.key,
    repositoryProfileFingerprint: binding.repositoryProfileFingerprint,
    canonicalWorktreeRoot: ROOT,
    baseBranch: profile.defaultBranch,
    localCommit: localCommitReceipt(),
    preparedAt: "2026-07-12T12:01:00.000Z",
  });
  const runner = new FakeGitRunner({
    remoteSha: options.remoteSha ?? null,
    remoteBaseSha: options.remoteBaseSha ?? null,
    fastForward: options.fastForward ?? true,
    pushMode: options.pushMode ?? "success",
    localTreeSha: options.localTreeSha ?? TREE,
  });
  const broker = new FakeAskpassBroker();
  const store = new MemoryAttemptStore();
  const gateway = new VerifiedGitPushGatewayV1({
    runner,
    askpassBroker: broker,
    attemptStore: store,
    disabledHooksPath: "C:\\agent-runtime\\empty-hooks",
    now: tickingClock(),
  });
  return {
    gateway,
    runner,
    broker,
    store,
    profile,
    binding,
    handoff,
    input: {
      handoff,
      binding,
      profile,
      credentialReferenceId: "secret-ref-github-1",
    },
  };
}

class FakeAskpassBroker implements EphemeralGitAskpassBrokerV1 {
  calls = 0;
  private readonly secret = TOKEN;

  async withHandle<TResult>(input: {
    credentialReferenceId: string;
    repositoryBindingFingerprint: string;
    signal?: AbortSignal;
    use(handle: { readonly id: string; readonly executablePath: string }): Promise<TResult>;
  }): Promise<TResult> {
    this.calls += 1;
    assert.equal(input.credentialReferenceId, "secret-ref-github-1");
    assert.ok(this.secret.length > 0);
    return input.use({
      id: "opaque-handle-1",
      executablePath: "C:\\askpass\\github-helper.exe",
    });
  }
}

class MemoryAttemptStore implements GitPushAttemptStoreV1 {
  private readonly records = new Map<string, GitPushAttemptRecordV1>();

  async load(id: string): Promise<GitPushAttemptRecordV1 | null> {
    return clone(this.records.get(id) ?? null);
  }

  async save(record: GitPushAttemptRecordV1, expectedRevision: number | null): Promise<boolean> {
    const current = this.records.get(record.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    this.records.set(record.id, clone(record));
    return true;
  }
}

class FakeGitRunner implements VerifiedGitCommandRunnerV1 {
  readonly calls: Array<Parameters<VerifiedGitCommandRunnerV1["run"]>[0]> = [];
  pushes = 0;
  fetches = 0;
  mergeBaseChecks = 0;
  remoteReads = 0;
  private remoteSha: string | null;
  private remoteBaseSha: string | null;

  constructor(private readonly options: {
    remoteSha: string | null;
    remoteBaseSha: string | null;
    fastForward: boolean;
    pushMode: "success" | "applied_throw" | "readback_mismatch";
    localTreeSha: string;
  }) {
    this.remoteSha = options.remoteSha;
    this.remoteBaseSha = options.remoteBaseSha;
  }

  async run(input: Parameters<VerifiedGitCommandRunnerV1["run"]>[0]) {
    this.calls.push(clone(input));
    const op = operation(input.args);
    if (op === "rev-parse") {
      const subject = input.args.at(-1);
      if (subject === "--show-toplevel") return ok(ROOT);
      if (subject === "HEAD") return ok(COMMIT);
      if (subject === "HEAD^{tree}") return ok(this.options.localTreeSha);
      if (subject === "HEAD^") return ok(BASE);
    }
    if (op === "branch") return ok("codex/repair-1");
    if (op === "ls-remote") {
      this.remoteReads += 1;
      const ref = input.args.at(-1);
      if (ref === "refs/heads/main") {
        return ok(this.remoteBaseSha ? `${this.remoteBaseSha}\t${ref}` : "");
      }
      if (ref === "refs/heads/codex/repair-1") {
        return ok(this.remoteSha ? `${this.remoteSha}\t${ref}` : "");
      }
      return { exitCode: 2, stdout: "", stderr: `Unexpected remote ref ${String(ref)}` };
    }
    if (op === "fetch") {
      this.fetches += 1;
      return ok("");
    }
    if (op === "merge-base") {
      this.mergeBaseChecks += 1;
      return { exitCode: this.options.fastForward ? 0 : 1, stdout: "", stderr: "" };
    }
    if (op === "push") {
      this.pushes += 1;
      if (this.options.pushMode === "applied_throw") {
        this.remoteBaseSha = BASE;
        this.remoteSha = COMMIT;
        throw new Error("transport closed after dispatch");
      }
      if (this.options.pushMode === "readback_mismatch") {
        this.remoteBaseSha = BASE;
        this.remoteSha = "e".repeat(40);
        return ok("push dispatched");
      }
      this.remoteBaseSha = BASE;
      this.remoteSha = COMMIT;
      return ok("push dispatched");
    }
    return { exitCode: 2, stdout: "", stderr: `Unexpected operation ${op}` };
  }
}

function operation(args: readonly string[]): string {
  return args.find((arg) => ["rev-parse", "branch", "ls-remote", "fetch", "merge-base", "push"].includes(arg)) ?? "unknown";
}

function ok(stdout: string) {
  return { exitCode: 0, stdout: stdout ? `${stdout}\n` : "", stderr: "" };
}

function localCommitReceipt(): VerifiedLocalCommitReceiptV1 {
  const evidence = {
    requestId: "repair-1",
    runId: "run-1",
    worktreeId: "worktree-1",
    workspaceId: "workspace-1",
    branch: "codex/repair-1",
    baseSha: BASE,
    commitSha: COMMIT,
    parentSha: BASE,
    treeSha: TREE,
    diffFingerprint: FP_A,
    changedPaths: ["src/fix.ts"],
    artifactHashes: [{ path: "src/fix.ts", sha256: FP_A, bytes: 42 }],
    changedArtifacts: [{ path: "src/fix.ts", sha256: FP_A }],
    targetedValidationReceiptId: "targeted-1",
    fullValidationReceiptId: "full-1",
    targetedValidationFingerprint: FP_A,
    fullValidationFingerprint: FP_B,
    committedAt: "2026-07-12T12:00:00.000Z",
  };
  return {
    version: 1,
    kind: "verified_local_commit",
    id: "verified-commit-1",
    status: "verified",
    ...evidence,
    fingerprint: hash(evidence),
  };
}

function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.parse("2026-07-12T12:03:00.000Z") + tick++ * 1000);
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
