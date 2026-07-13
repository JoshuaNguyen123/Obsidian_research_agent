import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";
import type { PreparedActionV1, ScopedExtensionContextV1 } from "../packages/core-api/src";
import {
  DurableValidationReceiptRegistryV1,
  FixedArgvArtifactHashReaderV1,
  FixedArgvRepairProofAdapterV1,
  SpawnFixedArgvGitRunnerV1,
  createCodeRepairToolRuntimeV1,
  createFixedArgvVerifiedCommitGatewayV1,
  normalizeCodeRepairRequestV1,
  type CodeDiffReceiptV1,
  type CodeRepairCheckpointNamespaceV1,
  type CodeValidationReceiptV1,
  type DurableValidationReceiptNamespaceV1,
  type VerifiedCommitGatewayV1,
} from "../extensions/code/repair";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories";
import {
  type PreparedSandboxActionV2,
  type SandboxExecutionReceiptV2,
} from "../extensions/code/sandbox";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-07-12T20:00:00.000Z");
const SHA = (character: string) => `sha256:${character.repeat(64)}`;

test("durable validation registry captures only exact request-scoped sandbox evidence", async () => {
  let namespace: DurableValidationReceiptNamespaceV1 | null = null;
  const registry = new DurableValidationReceiptRegistryV1({
    async readNamespace() {
      return namespace ? structuredClone(namespace) : null;
    },
    async writeNamespace(next, expectedRevision) {
      if ((namespace?.revision ?? 0) !== expectedRevision) return false;
      namespace = structuredClone(next);
      return true;
    },
  }, () => NOW);
  const action = await sandboxAction("validation_fast");
  const receipt = await sandboxReceipt(action, 1);
  const scope = { runId: "mission-1", workspaceId: "workspace-1", requestId: "request-1" };
  const captureInput = {
    scope,
    action,
    receipt,
    diagnostics: {
      version: 1 as const,
      stdout: "FAIL C:/volatile/one/src/index.ts at 2026-07-12T20:00:00.000Z",
      stderr: "expected true, received false after 812ms",
      truncated: false,
      redactedLines: 0,
    },
    validatedWorkspaceManifestFingerprint: SHA("8"),
    workspaceChangedPaths: ["src/index.ts"],
  };
  const captured = await registry.capture(captureInput);
  assert.equal(captured.kind, "fast");
  assert.equal(captured.status, "failed");
  assert.match(captured.failureFingerprint ?? "", /^sha256:/u);
  assert.equal(captured.checks[0].stderr, `sha256=${receipt.stderrSha256};bytes=${receipt.stderrBytes}`);
  assert.deepEqual(
    await registry.readValidation({ receiptId: receipt.id, ...scope }),
    captured,
  );
  await assert.rejects(
    registry.readValidation({
      receiptId: receipt.id,
      ...scope,
      expectedAction: await sandboxAction("validation_targeted"),
    }),
    /not bound to the exact prepared sandbox action/i,
  );
  const untamperedNamespace = structuredClone(namespace!);
  namespace!.receipts[receipt.id].validation.checks[0].exitCode = 0;
  await assert.rejects(
    registry.readValidation({ receiptId: receipt.id, ...scope }),
    /status and failure evidence disagree|fingerprint is invalid/i,
    "persisted green-bit tampering must fail closed on readback",
  );
  namespace = untamperedNamespace;
  assert.equal(
    await registry.readValidation({ ...scope, requestId: "another-request", receiptId: receipt.id }),
    null,
  );
  assert.deepEqual(await registry.capture(captureInput), captured);

  const semanticallySame = await sandboxReceipt(
    await sandboxAction("validation_fast", "request-semantic"),
    1,
  );
  const semanticScope = { ...scope, requestId: "request-semantic" };
  const semanticCapture = await registry.capture({
    ...captureInput,
    scope: semanticScope,
    action: await sandboxAction("validation_fast", "request-semantic"),
    receipt: semanticallySame,
    diagnostics: {
      version: 1,
      stdout: "FAIL D:/different/root/src/index.ts at 2027-01-01T01:02:03.000Z",
      stderr: "expected true, received false after 2.1 seconds",
      truncated: false,
      redactedLines: 0,
    },
  });
  assert.equal(
    semanticCapture.failureFingerprint,
    captured.failureFingerprint,
    "failure fingerprint must ignore volatile paths, timestamps, and durations",
  );

  await assert.rejects(
    registry.capture({ ...captureInput, scope: { ...scope, requestId: "wrong-request" } }),
    /repair request.*scope/i,
  );

  const tampered = { ...receipt, exitCode: 0 };
  await assert.rejects(
    registry.capture({ ...captureInput, receipt: tampered }),
    /fingerprint verification/i,
  );
  const invalidArtifactCore = {
    ...receipt,
    importedArtifacts: [{
      path: "dist/result.bin",
      sha256: SHA("a"),
      bytes: 4,
      readbackSha256: SHA("b"),
    }],
  };
  const { fingerprint: _oldFingerprint, ...invalidArtifactEvidence } = invalidArtifactCore;
  await assert.rejects(
    registry.capture({
      ...captureInput,
      receipt: {
        ...invalidArtifactEvidence,
        fingerprint: await sha256Fingerprint(invalidArtifactEvidence),
      },
    }),
    /artifact readback evidence/i,
  );
});

test("fixed-argv ephemeral index commits mixed modified and WorkspaceManager-authorized added files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repair-live-adapters-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  const appData = path.join(root, "app-data");
  await fs.mkdir(repository, { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "Fixture");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "config", "core.autocrlf", "false");
  await fs.mkdir(path.join(repository, "src"), { recursive: true });
  await fs.writeFile(path.join(repository, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  await fs.writeFile(path.join(repository, "src", "index.ts"), "export const value = 'broken';\n");
  await git(repository, "add", "--all");
  await git(repository, "commit", "-m", "base");
  const baseSha = await gitText(repository, "rev-parse", "HEAD");
  await git(repository, "worktree", "add", "-b", "codex/fixture", worktree, baseSha);
  const canonicalRepository = await fs.realpath(repository);
  const canonicalWorktree = await fs.realpath(worktree);

  const manager = new WorkspaceManagerV2({ applicationDataRoot: appData, now: () => NOW });
  await manager.registerTrustedRepositoryWorkspace({
    workspaceId: "workspace-1",
    ownerRunId: "mission-1",
    profileKey: "profile-1",
    repositoryRoot: canonicalRepository,
    worktreeRoot: canonicalWorktree,
    branch: "codex/fixture",
    baseSha,
    bindingFingerprint: SHA("4"),
    trusted: true,
  });
  const lease = await manager.acquireLease("workspace-1", "mission-1");
  const before = await manager.read("workspace-1", "src/index.ts");
  await manager.writeExpected(
    "workspace-1",
    lease.lease!.id,
    "src/index.ts",
    "export const value = 'fixed';\n",
    before.sha256,
  );
  await manager.createFile(
    "workspace-1",
    lease.lease!.id,
    "src/added.ts",
    "export const added = true;\n",
  );
  await manager.releaseLease("workspace-1", lease.lease!.id);

  const profile = detectRepositoryProfileV2({
    key: "profile-1",
    displayName: "Fixture",
    repositoryRoot: canonicalRepository,
    defaultBranch: "main",
    files: ["package.json", "src/added.ts", "src/index.ts"],
    fileContents: { "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n" },
    runtimeDigests: { node: SHA("5") },
    allowedPaths: ["package.json", "src/added.ts", "src/index.ts"],
  });
  const runner = new SpawnFixedArgvGitRunnerV1();
  const artifacts = new FixedArgvArtifactHashReaderV1(runner);
  const proof = new FixedArgvRepairProofAdapterV1({
    workspaceManager: manager,
    git: runner,
    artifactHashReader: artifacts,
    getProfile: async (key) => key === profile.key ? profile : null,
    now: () => NOW,
  });
  const manifest = await manager.loadManifest("workspace-1");
  const resolution = await proof.resolve({
    profileKey: profile.key,
    workspaceId: "workspace-1",
    runId: "mission-1",
    requestId: "request-1",
    manifest,
  });
  assert.equal(resolution?.worktreeBranch, "codex/fixture");
  const request = normalizeCodeRepairRequestV1({
    id: "request-1",
    runId: "mission-1",
    objective: "Repair fixture",
    worktree: {
      id: "workspace-1",
      path: canonicalWorktree,
      repositoryRoot: canonicalRepository,
      branch: resolution!.worktreeBranch,
      baseSha,
      profileId: profile.key,
    },
    commitMessage: "Repair fixture",
    maxCycles: 3,
  });
  const rawDiff = await proof.readDiff({ operationId: "proof-1", request });
  assert.deepEqual(rawDiff.files.map((file) => file.path), ["src/added.ts", "src/index.ts"]);
  assert.deepEqual(rawDiff.files.map((file) => file.status), ["added", "modified"]);
  assert.equal(await gitText(canonicalWorktree, "diff", "--cached", "--name-only"), "");
  const diff: CodeDiffReceiptV1 = {
    version: 1,
    kindName: "code_diff_readback",
    id: "proof-1:diff",
    ...rawDiff,
    changedPaths: rawDiff.files.map((file) => file.path),
    fingerprint: await sha256Fingerprint({
      baseSha: rawDiff.baseSha,
      patch: rawDiff.patch,
      files: rawDiff.files,
    }),
  };
  const expectedArtifacts = rawDiff.files.map((file) => ({
    path: file.path,
    sha256: file.afterSha256!,
  }));
  const artifactReadback = await proof.readArtifactHashes({
    operationId: "proof-1:artifacts",
    request,
    expectedArtifacts,
  });
  const gateway = await createFixedArgvVerifiedCommitGatewayV1({
    workspaceManager: manager,
    git: runner,
    artifactHashReader: artifacts,
    disabledHooksPath: path.join(root, "disabled-hooks"),
    now: () => NOW,
  });
  const validationBinding = await validationBindingFor({
    requestId: "request-1",
    workspaceId: "workspace-1",
    profileKey: profile.key,
    manifestFingerprint: manifest.hashes.indexFingerprint,
    changedPaths: manifest.budget.changedPaths,
    files: artifactReadback,
  });
  const fast = await codeValidation("fast", "fast-sandbox", new Date(NOW.getTime() - 1_000), validationBinding);
  const targeted = await codeValidation("targeted", "targeted-sandbox", NOW, validationBinding);
  const full = await codeValidation("full", "full-sandbox", new Date(NOW.getTime() + 1_000), validationBinding);
  const validations = new Map([fast, targeted, full].map((entry) => [entry.id, entry]));
  let checkpoints: CodeRepairCheckpointNamespaceV1 | null = null;
  let crashOnce = true;
  const crashingGateway: VerifiedCommitGatewayV1 = {
    async commit(input) {
      const committed = await gateway.commit(input);
      if (crashOnce) {
        crashOnce = false;
        throw new Error("simulated process crash after Git commit");
      }
      return committed;
    },
    readCommit: (input) => gateway.readCommit(input),
  };
  const handlers = createCodeRepairToolRuntimeV1({
    workspaceManager: manager,
    repositoryProfiles: proof,
    validations: {
      async readValidation({ receiptId }) {
        return validations.get(receiptId) ?? null;
      },
    },
    checkpointPersistence: {
      async readNamespace() {
        return checkpoints ? structuredClone(checkpoints) : null;
      },
      async writeNamespace(next, expectedRevision) {
        if ((checkpoints?.revision ?? 0) !== expectedRevision) return false;
        checkpoints = structuredClone(next);
        return true;
      },
    },
    proofReader: proof,
    commitGateway: crashingGateway,
    now: () => NOW,
  });
  const liveContext = repairContext();
  const cyclePrepared = await handlers.prepareCycleRecord({
    runId: "mission-1",
    workspaceId: "workspace-1",
    requestId: "request-1",
    cycle: 1,
    checkpointSequence: 0,
    validationReceiptId: fast.id,
    cycleFingerprint: fast.fingerprint,
  }, liveContext);
  assert.equal(cyclePrepared.ok, true);
  if (!cyclePrepared.ok) return;
  await handlers.executePreparedCycleRecord(
    cyclePrepared.action,
    repairContext(cyclePrepared.action),
  );
  const commitPrepared = await handlers.prepareVerifiedCommit({
    runId: "mission-1",
    workspaceId: "workspace-1",
    requestId: "request-1",
    checkpointSequence: 1,
    targetedValidationReceiptId: targeted.id,
    fullValidationReceiptId: full.id,
  }, liveContext);
  assert.equal(commitPrepared.ok, true);
  if (!commitPrepared.ok) return;
  await assert.rejects(
    handlers.executePreparedVerifiedCommit(
      commitPrepared.action,
      repairContext(commitPrepared.action),
    ),
    /simulated process crash/u,
  );
  const committedHead = await gitText(canonicalWorktree, "rev-parse", "HEAD");
  assert.notEqual(committedHead, baseSha);
  const reconciled = await handlers.executePreparedVerifiedCommit(
    commitPrepared.action,
    repairContext(commitPrepared.action),
  );
  assert.equal(reconciled.domainReceipt.commitSha, committedHead);
  assert.equal(await gitText(canonicalWorktree, "rev-list", "--count", `${baseSha}..HEAD`), "1");
  assert.equal(await gitText(canonicalWorktree, "status", "--porcelain=v1"), "");
});

test("added-only 3 MiB sandbox artifact is hash-proved through an ephemeral index and committed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "repair-added-binary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(repository, { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await git(repository, "config", "user.name", "Fixture");
  await git(repository, "config", "user.email", "fixture@example.invalid");
  await git(repository, "config", "core.autocrlf", "false");
  await fs.writeFile(path.join(repository, "package.json"), "{\"scripts\":{\"test\":\"node --test\"}}\n");
  await git(repository, "add", "--all");
  await git(repository, "commit", "-m", "base");
  const baseSha = await gitText(repository, "rev-parse", "HEAD");
  await git(repository, "worktree", "add", "-b", "codex/added-binary", worktree, baseSha);
  const canonicalRepository = await fs.realpath(repository);
  const canonicalWorktree = await fs.realpath(worktree);
  const manager = new WorkspaceManagerV2({
    applicationDataRoot: path.join(root, "app-data"),
    now: () => NOW,
  });
  await manager.registerTrustedRepositoryWorkspace({
    workspaceId: "workspace-binary",
    ownerRunId: "mission-binary",
    profileKey: "profile-binary",
    repositoryRoot: canonicalRepository,
    worktreeRoot: canonicalWorktree,
    branch: "codex/added-binary",
    baseSha,
    bindingFingerprint: SHA("4"),
    trusted: true,
  });
  const lease = await manager.acquireLease("workspace-binary", "mission-binary");
  await manager.mkdir("workspace-binary", lease.lease!.id, "dist");
  const binary = new Uint8Array(3 * 1024 * 1024);
  for (let index = 0; index < binary.length; index += 4096) binary[index] = index % 251;
  const binarySha = `sha256:${(await import("node:crypto")).createHash("sha256").update(binary).digest("hex")}`;
  await manager.importSandboxArtifact({
    workspaceId: "workspace-binary",
    leaseId: lease.lease!.id,
    relativePath: "dist/generated.bin",
    bytes: binary,
    expectedSha256: binarySha,
    maxBytes: 4 * 1024 * 1024,
  });
  await manager.releaseLease("workspace-binary", lease.lease!.id);
  const profile = detectRepositoryProfileV2({
    key: "profile-binary",
    displayName: "Binary fixture",
    repositoryRoot: canonicalRepository,
    defaultBranch: "main",
    files: ["package.json", "dist/generated.bin"],
    fileContents: { "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n" },
    runtimeDigests: { node: SHA("5") },
    allowedPaths: ["dist", "package.json"],
    generatedOutputs: ["dist"],
  });
  const runner = new SpawnFixedArgvGitRunnerV1();
  const artifacts = new FixedArgvArtifactHashReaderV1(runner);
  const proof = new FixedArgvRepairProofAdapterV1({
    workspaceManager: manager,
    git: runner,
    artifactHashReader: artifacts,
    getProfile: async () => profile,
    now: () => NOW,
  });
  const request = normalizeCodeRepairRequestV1({
    id: "request-binary",
    runId: "mission-binary",
    objective: "Commit generated binary",
    worktree: {
      id: "workspace-binary",
      path: canonicalWorktree,
      repositoryRoot: canonicalRepository,
      branch: "codex/added-binary",
      baseSha,
      profileId: profile.key,
    },
    commitMessage: "Add generated binary",
  });
  const rawDiff = await proof.readDiff({ operationId: "proof-binary", request });
  assert.deepEqual(rawDiff.files.map(({ path, status }) => ({ path, status })), [
    { path: "dist/generated.bin", status: "added" },
  ]);
  assert.equal(await gitText(canonicalWorktree, "diff", "--cached", "--name-only"), "");
  const diff: CodeDiffReceiptV1 = {
    version: 1,
    kindName: "code_diff_readback",
    id: "proof-binary:diff",
    ...rawDiff,
    changedPaths: ["dist/generated.bin"],
    fingerprint: await sha256Fingerprint({
      baseSha: rawDiff.baseSha,
      patch: rawDiff.patch,
      files: rawDiff.files,
    }),
  };
  const artifactReadback = await proof.readArtifactHashes({
    operationId: "proof-binary:artifacts",
    request,
    expectedArtifacts: [{ path: "dist/generated.bin", sha256: binarySha }],
  });
  assert.equal(artifactReadback[0].bytes, binary.byteLength);
  const gateway = await createFixedArgvVerifiedCommitGatewayV1({
    workspaceManager: manager,
    git: runner,
    artifactHashReader: artifacts,
    disabledHooksPath: path.join(root, "disabled-hooks"),
    now: () => NOW,
  });
  const binaryManifest = await manager.loadManifest("workspace-binary");
  const binaryValidationBinding = await validationBindingFor({
    requestId: "request-binary",
    workspaceId: "workspace-binary",
    profileKey: profile.key,
    manifestFingerprint: binaryManifest.hashes.indexFingerprint,
    changedPaths: binaryManifest.budget.changedPaths,
    files: artifactReadback,
  });
  const commit = await gateway.commit({
    operationId: "commit-binary",
    request,
    diff,
    artifactHashes: artifactReadback,
    targetedValidation: await codeValidation("targeted", "targeted-binary", NOW, binaryValidationBinding),
    fullValidation: await codeValidation("full", "full-binary", new Date(NOW.getTime() + 1_000), binaryValidationBinding),
  });
  assert.match(commit.commitSha, /^[0-9a-f]{40}$/u);
  assert.equal(await gitText(canonicalWorktree, "status", "--porcelain=v1"), "");
});

async function sandboxAction(
  purpose: PreparedSandboxActionV2["purpose"],
  repairRequestId = "request-1",
): Promise<PreparedSandboxActionV2> {
  const core = {
    version: 1 as const,
    purpose,
    provider: "docker" as const,
    profileKey: "profile-1",
    projectId: "project-1",
    commandId: "validate-fast",
    workspaceId: "workspace-1",
    repairRequestId,
    workspaceManifestFingerprint: SHA("1"),
    runtimeDigest: SHA("2"),
    probeFingerprint: SHA("3"),
    command: { executable: "npm", args: ["test"], cwd: "src", timeoutMs: 60_000 },
    network: { mode: "disabled" as const, credentialPolicy: "none" as const },
    resources: { cpuCount: 1, memoryMb: 256, pidLimit: 32, timeoutMs: 60_000 },
    environment: { CI: "1" },
    stagingManifest: [{ path: "src/index.ts", sha256: SHA("4"), bytes: 20 }],
    expectedArtifacts: [],
    preparedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  const payloadFingerprint = await sha256Fingerprint(core);
  return {
    ...core,
    id: `sandbox-action-${payloadFingerprint.slice(7, 39)}`,
    payloadFingerprint,
  };
}

async function sandboxReceipt(
  action: PreparedSandboxActionV2,
  exitCode: number,
): Promise<SandboxExecutionReceiptV2> {
  const core = {
    version: 1 as const,
    id: `sandbox-receipt-${action.payloadFingerprint.slice(7, 31)}`,
    actionId: action.id,
    provider: action.provider,
    profileKey: action.profileKey,
    projectId: action.projectId,
    commandId: action.commandId,
    purpose: action.purpose,
    status: exitCode === 0 ? "verified" as const : "failed" as const,
    exitCode,
    commandFingerprint: await sha256Fingerprint(action.command),
    stagingManifestFingerprint: await sha256Fingerprint(action.stagingManifest),
    boundaryProbeFingerprint: action.probeFingerprint,
    stdoutSha256: SHA("6"),
    stderrSha256: SHA("7"),
    stdoutBytes: 12,
    stderrBytes: 24,
    importedArtifacts: [],
    authorizationGrantId: "grant-1",
    startedAt: NOW.toISOString(),
    completedAt: new Date(NOW.getTime() + 1_000).toISOString(),
  };
  return { ...core, fingerprint: await sha256Fingerprint(core) };
}

async function codeValidation(
  kind: "fast" | "targeted" | "full",
  sandboxId: string,
  at: Date,
  binding: CodeValidationReceiptV1["binding"],
): Promise<CodeValidationReceiptV1> {
  const checks = [{ label: kind, exitCode: 0, stdout: "ok", stderr: "", durationMs: 10 }];
  const evidence = {
    operationId: `validation-${kind}`,
    kind,
    sandboxId,
    freshSandbox: true,
    startedAt: at.toISOString(),
    completedAt: new Date(at.getTime() + 10).toISOString(),
    checks,
    status: "passed" as const,
    failureFingerprint: null,
    binding,
  };
  return {
    version: 1,
    kindName: "code_validation",
    id: `validation-${kind}`,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

async function validationBindingFor(input: {
  requestId: string;
  workspaceId: string;
  profileKey: string;
  manifestFingerprint: string;
  changedPaths: string[];
  files: Array<{ path: string; sha256: string; bytes: number }>;
}): Promise<NonNullable<CodeValidationReceiptV1["binding"]>> {
  const stagedFiles = input.files
    .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    profileKey: input.profileKey,
    inputWorkspaceManifestFingerprint: input.manifestFingerprint,
    validatedWorkspaceManifestFingerprint: input.manifestFingerprint,
    workspaceChangedPaths: [...input.changedPaths].sort(),
    stagingManifestFingerprint: await sha256Fingerprint(stagedFiles),
    stagedFiles,
    importedArtifacts: [],
  };
}

function repairContext(action?: PreparedActionV1): ScopedExtensionContextV1 {
  return {
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: "mission-1",
    operationId: "repair-live-operation",
    originalPrompt: "Repair the fixture and create a verified local commit.",
    abortSignal: new AbortController().signal,
    ...(action
      ? {
          authorizedAction: {
            preparedActionId: action.id,
            payloadFingerprint: action.payloadFingerprint,
            grantId: "grant-live",
          },
        }
      : {}),
    now: () => new Date(NOW),
    reportProgress() {},
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return result.stdout.trim();
}
