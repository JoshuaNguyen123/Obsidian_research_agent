import test from "node:test";
import assert from "node:assert/strict";

import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";
import {
  CallbackCodeRepairCheckpointStoreV1,
  CommitOnlyVerifiedCommitGatewayV1,
  ProductionAdapterErrorV1,
  type ArtifactHashReadbackV1,
  type CodeDiffReceiptV1,
  type CodeRepairCheckpointNamespaceV1,
  type CodeRepairCheckpointV1,
  type CodeValidationReceiptV1,
  type FixedArgvGitRunnerV1,
  type NormalizedCodeRepairRequestV1,
} from "../extensions/code/repair";

const BASE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const BEFORE_HASH = `sha256:${"1".repeat(64)}`;
const AFTER_HASH = `sha256:${"2".repeat(64)}`;
const NOW = "2026-07-12T15:00:00.000Z";
const PATH = "src/index.ts";
const PATCH = [
  `diff --git a/${PATH} b/${PATH}`,
  "index 1111111..2222222 100644",
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  "@@ -1 +1 @@",
  "-bad",
  "+fixed",
  "",
].join("\n");

test("callback checkpoint store provides serialized create/update CAS without aliasing", async () => {
  let namespace: CodeRepairCheckpointNamespaceV1 | null = null;
  const store = new CallbackCodeRepairCheckpointStoreV1({
    async readNamespace() {
      return namespace ? structuredClone(namespace) : null;
    },
    async writeNamespace(next, expectedRevision) {
      assert.equal(expectedRevision, namespace?.revision ?? 0);
      namespace = structuredClone(next);
      return true;
    },
  });
  const created = await checkpoint(0, "initialized");
  await store.save(created, null);
  const loaded = await store.load(created.id);
  assert.deepEqual(loaded, created);
  loaded!.stage = "blocked";
  assert.equal((await store.load(created.id))?.stage, "initialized");

  const first = await checkpoint(1, "initial_edit");
  const competing = await checkpoint(1, "fast_validation");
  const outcomes = await Promise.allSettled([
    store.save(first, 0),
    store.save(competing, 0),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /sequence 0/i);
  assert.equal((namespace as CodeRepairCheckpointNamespaceV1 | null)?.revision, 2);
  assert.equal((await store.load(created.id))?.sequence, 1);
});

test("checkpoint store rejects corrupt namespaces and terminal rewrites", async () => {
  let namespace: CodeRepairCheckpointNamespaceV1 | null = null;
  const store = new CallbackCodeRepairCheckpointStoreV1({
    async readNamespace() {
      return namespace;
    },
    async writeNamespace(next, expectedRevision) {
      assert.equal(expectedRevision, namespace?.revision ?? 0);
      namespace = structuredClone(next);
      return true;
    },
  });
  const terminal = await checkpoint(0, "blocked");
  terminal.blocker = {
    code: "repair_cycles_exhausted",
    message: "Fixture terminal blocker.",
    evidenceFingerprint: null,
    blockedAt: NOW,
  };
  terminal.terminal = { status: "blocked", publicationEligible: false, completedAt: NOW };
  await store.save(terminal, null);
  const changed = structuredClone(terminal);
  changed.sequence = 1;
  changed.updatedAt = "2026-07-12T16:00:00.000Z";
  await assert.rejects(store.save(changed, 0), /terminal.*immutable/i);

  namespace = { version: 1, revision: -1, checkpoints: {} };
  await assert.rejects(store.load("anything"), /revision is invalid/i);
});

test("checkpoint store propagates a plugin-data namespace CAS conflict", async () => {
  const store = new CallbackCodeRepairCheckpointStoreV1({
    async readNamespace() {
      return null;
    },
    async writeNamespace(_next, expectedRevision) {
      assert.equal(expectedRevision, 0);
      return false;
    },
  });
  await assert.rejects(
    store.save(await checkpoint(0, "initialized"), null),
    (error: unknown) =>
      error instanceof ProductionAdapterErrorV1 &&
      error.code === "checkpoint_namespace_conflict",
  );
});

test("commit-only gateway rechecks exact evidence, disables hooks, and reads Git objects", async () => {
  const request = repairRequest();
  const diff = await preparedDiff();
  const targeted = await validationReceipt("targeted", "sandbox-targeted", false);
  const full = await validationReceipt("full", "sandbox-full-fresh", true);
  const git = new FakeFixedGit();
  const gateway = gatewayFor(git);

  const commit = await gateway.commit({
    operationId: "commit-operation-1",
    request,
    diff,
    artifactHashes: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
    targetedValidation: targeted,
    fullValidation: full,
  });
  assert.equal(commit.commitSha, COMMIT_SHA);
  assert.equal(git.commitCalls, 1);
  assert.equal(git.validationCommandCalls, 0);
  assert.ok(git.calls.every((call) => call.args[0] === "-c"));
  assert.ok(
    git.calls.every((call) =>
      call.args.includes("core.hooksPath=C:/host/empty-hooks"),
    ),
  );
  assert.ok(git.calls.every((call) => call.args.includes("commit.gpgSign=false")));
  const commitCall = git.calls.find((call) => command(call.args)[0] === "commit");
  assert.ok(commitCall);
  assert.ok(commitCall.args.includes("--no-verify"));
  assert.ok(commitCall.args.includes("--no-gpg-sign"));

  const readback = await gateway.readCommit({
    operationId: "readback-operation-1",
    request,
    commitSha: COMMIT_SHA,
  });
  assert.equal(readback.parentSha, BASE_SHA);
  assert.equal(readback.treeSha, TREE_SHA);
  assert.equal(readback.diffFingerprint, diff.fingerprint);
  assert.deepEqual(readback.changedPaths, [PATH]);
  assert.deepEqual(readback.artifactHashes, [
    { path: PATH, sha256: AFTER_HASH, bytes: 128 },
  ]);

  const reconciliation = await gateway.reconcilePreparedCommit({
    operationId: "commit-operation-reconcile",
    request,
    diff,
    artifactHashes: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
    targetedValidation: targeted,
    fullValidation: full,
  });
  assert.equal(reconciliation.outcome, "committed");
  assert.equal(git.commitCalls, 1, "read-only reconciliation must not create a commit");

  const reconciled = await gateway.commit({
    operationId: "commit-operation-retry",
    request,
    diff,
    artifactHashes: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
    targetedValidation: targeted,
    fullValidation: full,
  });
  assert.equal(reconciled.commitSha, COMMIT_SHA);
  assert.equal(git.commitCalls, 1, "idempotent retry must not create another commit");
});

test("commit-only gateway rejects unauthorized paths before invoking Git", async () => {
  const git = new FakeFixedGit();
  const diff = await preparedDiff();
  const gateway = gatewayFor(git, { allowedPaths: ["src/allowed.ts"] });
  await assert.rejects(
    gateway.commit({
      operationId: "commit-path-denied",
      request: repairRequest(),
      diff,
      artifactHashes: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
      targetedValidation: await validationReceipt("targeted", "sandbox-targeted", false),
      fullValidation: await validationReceipt("full", "sandbox-full", true),
    }),
    (error: unknown) =>
      error instanceof ProductionAdapterErrorV1 && error.code === "commit_path_not_allowed",
  );
  assert.equal(git.calls.length, 0);
});

test("artifact or staged patch drift prevents commit", async (t) => {
  const input = async () => ({
    operationId: "commit-drift",
    request: repairRequest(),
    diff: await preparedDiff(),
    artifactHashes: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
    targetedValidation: await validationReceipt("targeted", "sandbox-targeted", false),
    fullValidation: await validationReceipt("full", "sandbox-full", true),
  });

  await t.test("working artifact hash drift", async () => {
    const git = new FakeFixedGit();
    const gateway = gatewayFor(git, { workingHash: `sha256:${"9".repeat(64)}` });
    await assert.rejects(gateway.commit(await input()), /artifact hash or byte count changed/i);
    assert.equal(git.addCalls, 0);
    assert.equal(git.commitCalls, 0);
  });

  await t.test("staged canonical patch drift", async () => {
    const git = new FakeFixedGit({ stagedPatch: `${PATCH}unexpected\n` });
    const gateway = gatewayFor(git);
    await assert.rejects(gateway.commit(await input()), /staged Git patch differs/i);
    assert.equal(git.addCalls, 1);
    assert.equal(git.commitCalls, 0);
  });
});

test("forged green validation receipt is rejected before Git", async () => {
  const git = new FakeFixedGit();
  const targeted = await validationReceipt("targeted", "sandbox-targeted", false);
  targeted.checks[0].exitCode = 1;
  const gateway = gatewayFor(git);
  await assert.rejects(
    gateway.commit({
      operationId: "commit-forged-validation",
      request: repairRequest(),
      diff: await preparedDiff(),
      artifactHashes: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
      targetedValidation: targeted,
      fullValidation: await validationReceipt("full", "sandbox-full", true),
    }),
    /green targeted validation/i,
  );
  assert.equal(git.calls.length, 0);
});

async function checkpoint(
  sequence: number,
  stage: CodeRepairCheckpointV1["stage"],
): Promise<CodeRepairCheckpointV1> {
  const request = repairRequest();
  return {
    version: 1,
    id: "code-repair:mission-1:workspace-1:request-1",
    request,
    requestFingerprint: await sha256Fingerprint(request),
    sequence,
    stage,
    createdAt: NOW,
    updatedAt: NOW,
    attempts: [],
    failureHistory: [],
    validationHistory: [],
    approvalHistory: [],
  };
}

function repairRequest(): NormalizedCodeRepairRequestV1 {
  return {
    id: "request-1",
    runId: "mission-1",
    objective: "Repair fixture",
    worktree: {
      id: "workspace-1",
      path: "C:/trusted/worktree",
      repositoryRoot: "C:/trusted/repository",
      branch: "codex/repair-fixture",
      baseSha: BASE_SHA,
      profileId: "node-profile",
    },
    commitMessage: "Repair fixture",
    maxCycles: 3,
    expectedArtifacts: [{ path: PATH, sha256: AFTER_HASH }],
    protectedControlPaths: [],
  };
}

async function preparedDiff(): Promise<CodeDiffReceiptV1> {
  const files = [
    {
      path: PATH,
      status: "modified" as const,
      previousPath: null,
      beforeSha256: BEFORE_HASH,
      afterSha256: AFTER_HASH,
    },
  ];
  return {
    version: 1,
    kindName: "code_diff_readback",
    id: "diff-receipt-1",
    operationId: "diff-readback-1",
    baseSha: BASE_SHA,
    patch: PATCH,
    files,
    changedPaths: [PATH],
    readAt: NOW,
    fingerprint: await sha256Fingerprint({ baseSha: BASE_SHA, patch: PATCH, files }),
  };
}

async function validationReceipt(
  kind: "targeted" | "full",
  sandboxId: string,
  freshSandbox: boolean,
): Promise<CodeValidationReceiptV1> {
  const checks = [
    { label: `${kind} validation`, exitCode: 0, stdout: "ok", stderr: "", durationMs: 20 },
  ];
  const evidence = {
    operationId: `validation-${kind}`,
    kind,
    sandboxId,
    freshSandbox,
    startedAt: NOW,
    completedAt: NOW,
    checks,
    status: "passed" as const,
    failureFingerprint: null,
    binding: {
      requestId: "request-1",
      workspaceId: "workspace-1",
      profileKey: "node-profile",
      inputWorkspaceManifestFingerprint: `sha256:${"3".repeat(64)}`,
      validatedWorkspaceManifestFingerprint: `sha256:${"4".repeat(64)}`,
      workspaceChangedPaths: [PATH],
      stagingManifestFingerprint: `sha256:${"5".repeat(64)}`,
      stagedFiles: [{ path: PATH, sha256: AFTER_HASH, bytes: 128 }],
      importedArtifacts: [],
    },
  };
  return {
    version: 1,
    kindName: "code_validation",
    id: `validation-${kind}`,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

function gatewayFor(
  git: FakeFixedGit,
  options: { allowedPaths?: string[]; workingHash?: string } = {},
) {
  return new CommitOnlyVerifiedCommitGatewayV1({
    git,
    disabledHooksPath: "C:/host/empty-hooks",
    resolveAllowedPaths: () => options.allowedPaths ?? [PATH],
    now: () => NOW,
    artifactHashReader: {
      async readArtifactHash({ path, source }): Promise<ArtifactHashReadbackV1 | null> {
        assert.equal(path, PATH);
        if (source.kind === "working") {
          return { path, sha256: options.workingHash ?? AFTER_HASH, bytes: 128 };
        }
        if (source.revision === BASE_SHA) {
          return { path, sha256: BEFORE_HASH, bytes: 100 };
        }
        if (source.revision === COMMIT_SHA) {
          return { path, sha256: AFTER_HASH, bytes: 128 };
        }
        return null;
      },
    },
  });
}

class FakeFixedGit implements FixedArgvGitRunnerV1 {
  readonly calls: Array<{ cwd: string; args: readonly string[] }> = [];
  committed = false;
  staged = false;
  addCalls = 0;
  commitCalls = 0;
  validationCommandCalls = 0;

  constructor(private readonly options: { stagedPatch?: string } = {}) {}

  async run(input: { cwd: string; args: readonly string[] }) {
    this.calls.push({ cwd: input.cwd, args: [...input.args] });
    assert.equal(input.cwd, "C:/trusted/worktree");
    assert.equal(input.args[0], "-c");
    assert.ok(input.args.includes("--literal-pathspecs"));
    const argv = command(input.args);
    if (["npm", "node", "python", "cargo", "go", "dotnet"].includes(argv[0] ?? "")) {
      this.validationCommandCalls += 1;
      return failed("validation execution prohibited");
    }
    if (argv[0] === "rev-parse") {
      const target = argv[1];
      if (target === "--show-toplevel") return ok("C:/trusted/worktree\n");
      if (target === "HEAD") return ok(`${this.committed ? COMMIT_SHA : BASE_SHA}\n`);
      if (target === `${COMMIT_SHA}^`) return ok(`${BASE_SHA}\n`);
      if (target === `${COMMIT_SHA}^{tree}`) return ok(`${TREE_SHA}\n`);
    }
    if (argv[0] === "branch" && argv[1] === "--show-current") {
      return ok("codex/repair-fixture\n");
    }
    if (argv[0] === "status") {
      return ok(this.committed ? "" : ` M ${PATH}\u0000`);
    }
    if (argv[0] === "add") {
      this.addCalls += 1;
      this.staged = true;
      return ok("");
    }
    if (argv[0] === "diff" && argv.includes("--quiet")) return ok("");
    if (argv[0] === "diff" && argv.includes("--name-status")) {
      return ok(`M\u0000${PATH}\u0000`);
    }
    if (argv[0] === "diff" && argv.includes("--binary")) {
      return ok(argv.includes("--cached") ? this.options.stagedPatch ?? PATCH : PATCH);
    }
    if (argv[0] === "commit") {
      assert.equal(this.staged, true);
      this.commitCalls += 1;
      this.committed = true;
      return ok("committed\n");
    }
    if (argv[0] === "diff-tree") return ok(`M\u0000${PATH}\u0000`);
    return failed(`unexpected Git argv: ${argv.join(" ")}`);
  }
}

function command(args: readonly string[]): string[] {
  const boundary = args.indexOf("--literal-pathspecs");
  assert.ok(boundary >= 0);
  return args.slice(boundary + 1);
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string) {
  return { exitCode: 2, stdout: "", stderr };
}
