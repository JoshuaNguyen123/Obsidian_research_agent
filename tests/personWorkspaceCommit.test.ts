import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  AGENT_GIT_COMMIT_EMAIL_V1,
  AGENT_GIT_COMMIT_NAME_V1,
} from "../packages/core-api/src/agentGitCommitIdentityV1";
import type { ScopedExtensionContextV1 } from "../packages/core-api/src";
import { sha256Fingerprint } from "../packages/headless-runtime/src/canonicalize";
import {
  FixedArgvArtifactHashReaderV1,
  FixedArgvRepairProofAdapterV1,
  PERSON_COMMIT_LEASE_OWNER_V1,
  PersonWorkspaceCommitRuntimeV1,
  SpawnFixedArgvGitRunnerV1,
  createCodeRepairToolRuntimeV1,
  createFixedArgvVerifiedCommitGatewayV1,
  parseCodeRepairCheckpointV1,
  type CodeRepairCheckpointNamespaceV1,
  type CodeValidationReceiptV1,
  type ProtectedDiffApprovalRequestV1,
  type ValidationKindV1,
} from "../extensions/code/repair";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

/*
 * A person's Validate and commit (CODE-15) and its revert (DEBT-125), on a
 * real repository and worktree with the real workspace manager, the real
 * fixed-argv proof reader and commit gateway, and a stand-in for the sandbox
 * that answers each validation with a receipt bound to the tree as it is.
 */

const execFileAsync = promisify(execFile);
const PERSON_OWNER = "person:code-page";
const ADA = { name: "Ada Lovelace", email: "ada@example.com" };
const SHA = (character: string) => `sha256:${character.repeat(64)}`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true, encoding: "utf8" });
  return result.stdout.trim();
}

async function repository(t: TestContext, options: { owner?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "person-commit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(path.join(repositoryRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(repositoryRoot, "notes"), { recursive: true });
  await git(repositoryRoot, "init", "--initial-branch=main");
  await git(repositoryRoot, "config", "user.name", "Fixture");
  await git(repositoryRoot, "config", "user.email", "fixture@example.invalid");
  await git(repositoryRoot, "config", "core.autocrlf", "false");
  const files: Record<string, string> = {
    "README.md": "broken\n",
    "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n",
    "src/app.ts": "export const app = 1;\n",
    "notes/old.txt": "an old note\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.writeFile(path.join(repositoryRoot, relative), content);
  }
  await git(repositoryRoot, "add", "--all");
  await git(repositoryRoot, "commit", "-m", "base");
  const baseSha = await gitText(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "worktree", "add", "-b", "codex/person", worktree, baseSha);
  const canonicalRepository = await fs.realpath(repositoryRoot);
  const canonicalWorktree = await fs.realpath(worktree);
  let tick = Date.parse("2026-10-16T12:00:00.000Z");
  const now = () => new Date(tick += 1_000);
  const manager = new WorkspaceManagerV2({ applicationDataRoot: path.join(root, "app-data"), now });
  await manager.registerTrustedRepositoryWorkspace({
    workspaceId: "person-repo",
    ownerRunId: options.owner ?? PERSON_OWNER,
    profileKey: "profile-1",
    repositoryRoot: canonicalRepository,
    worktreeRoot: canonicalWorktree,
    branch: "codex/person",
    baseSha,
    bindingFingerprint: SHA("4"),
    trusted: true,
  });
  const profile = detectRepositoryProfileV2({
    key: "profile-1",
    displayName: "Fixture",
    repositoryRoot: canonicalRepository,
    defaultBranch: "main",
    files: [...Object.keys(files), "src/new.ts", "src/main.ts", "notes/new.txt"],
    fileContents: { "package.json": files["package.json"]! },
    runtimeDigests: { node: SHA("5") },
    allowedPaths: ["README.md", "package.json", "src", "notes"],
  });
  let namespace: CodeRepairCheckpointNamespaceV1 | null = null;
  const checkpointPersistence = {
    async readNamespace() {
      return namespace ? structuredClone(namespace) : null;
    },
    async writeNamespace(next: CodeRepairCheckpointNamespaceV1, expectedRevision: number) {
      if ((namespace?.revision ?? 0) !== expectedRevision) return false;
      namespace = structuredClone(next);
      return true;
    },
  };
  const validations: ValidationKindV1[] = [];
  const failing = new Set<ValidationKindV1>();
  let sandboxes = 0;
  const git_ = new SpawnFixedArgvGitRunnerV1();
  const runtime = new PersonWorkspaceCommitRuntimeV1({
    workspaceManager: manager,
    getRepositoryProfile: async (key) => (key === profile.key ? profile : null),
    checkpointPersistence,
    validate: async ({ operationId, request, kind }) => {
      validations.push(kind);
      return boundReceipt(manager, { operationId, request, kind, failed: failing.has(kind), sandboxId: `sandbox-${++sandboxes}`, at: now() });
    },
    sandboxReady: async () => ({ ready: true }),
    git: git_,
    disabledHooksPath: path.join(root, "disabled-hooks"),
    now,
  });
  const edit = async (change: (leaseId: string) => Promise<unknown>) => {
    const lease = await manager.acquireLease("person-repo", "person:code-workspaces-pane");
    try {
      await change(lease.lease!.id);
    } finally {
      await manager.releaseLease("person-repo", lease.lease!.id);
    }
  };
  return {
    root,
    worktree: canonicalWorktree,
    repositoryRoot: canonicalRepository,
    baseSha,
    manager,
    profile,
    runtime,
    validations,
    failing,
    edit,
    namespace: () => namespace,
    checkpointPersistence,
    git: git_,
  };
}

async function boundReceipt(
  manager: WorkspaceManagerV2,
  input: {
    operationId: string;
    request: { id: string; worktree: { id: string; profileId: string } };
    kind: ValidationKindV1;
    failed: boolean;
    sandboxId: string;
    at: Date;
  },
): Promise<CodeValidationReceiptV1> {
  const manifest = await manager.loadManifest(input.request.worktree.id);
  const stagedFiles = [];
  for (const changed of manifest.budget.changedPaths) {
    const stat = await manager.stat(input.request.worktree.id, changed).catch(() => null);
    if (stat?.kind === "file") stagedFiles.push({ path: stat.path, sha256: stat.sha256, bytes: stat.bytes });
  }
  const byBytes = (left: string, right: string) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  stagedFiles.sort((left, right) => byBytes(left.path, right.path));
  const binding = {
    requestId: input.request.id,
    workspaceId: input.request.worktree.id,
    profileKey: input.request.worktree.profileId,
    inputWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
    validatedWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
    workspaceChangedPaths: [...manifest.budget.changedPaths].sort(byBytes),
    stagingManifestFingerprint: await sha256Fingerprint(stagedFiles),
    stagedFiles,
    importedArtifacts: [],
  };
  const evidence = {
    operationId: input.operationId,
    kind: input.kind,
    sandboxId: input.sandboxId,
    freshSandbox: true,
    startedAt: input.at.toISOString(),
    completedAt: new Date(input.at.getTime() + 10).toISOString(),
    checks: [{ label: input.kind, exitCode: input.failed ? 1 : 0, stdout: "", stderr: input.failed ? "1 failed" : "", durationMs: 10 }],
    status: input.failed ? "failed" as const : "passed" as const,
    failureFingerprint: input.failed ? await sha256Fingerprint({ kind: input.kind, failed: true }) : null,
    binding,
  };
  return {
    version: 1,
    kindName: "code_validation",
    id: input.operationId,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

/** README fixed, a file added, a file deleted and a file renamed. */
async function personChanges(fixture: Awaited<ReturnType<typeof repository>>): Promise<void> {
  const { manager } = fixture;
  await fixture.edit(async (leaseId) => {
    const readme = await manager.read("person-repo", "README.md");
    await manager.writeExpected("person-repo", leaseId, "README.md", "fixed\n", readme.sha256);
    await manager.createFile("person-repo", leaseId, "src/new.ts", "export const added = true;\n");
    const old = await manager.stat("person-repo", "notes/old.txt");
    await manager.trash("person-repo", leaseId, "notes/old.txt", old.sha256);
    const app = await manager.stat("person-repo", "src/app.ts");
    await manager.move("person-repo", leaseId, "src/app.ts", "src/main.ts", app.sha256);
  });
}

test("a person's changes are validated and committed as the person, with their message, and the base moves", async (t) => {
  const fixture = await repository(t);
  await personChanges(fixture);
  const result = await fixture.runtime.commit({
    workspaceId: "person-repo",
    operationId: "op-1",
    message: "Fix the readme\n\nAnd tidy the notes.",
    person: ADA,
  });
  assert.equal(result.status, "committed", JSON.stringify(result));
  if (result.status !== "committed") return;
  assert.deepEqual(fixture.validations, ["fast", "targeted", "full"]);
  const head = await gitText(fixture.worktree, "rev-parse", "HEAD");
  assert.equal(result.commitSha, head);
  assert.equal(
    await gitText(fixture.worktree, "show", "--no-patch", "--format=%an%x00%ae%x00%cn%x00%ce", head),
    ["Ada Lovelace", "ada@example.com", "Ada Lovelace", "ada@example.com"].join("\0"),
  );
  assert.equal(await gitText(fixture.worktree, "log", "-1", "--format=%B"), "Fix the readme\n\nAnd tidy the notes.");
  assert.equal(await gitText(fixture.worktree, "rev-parse", `${head}^`), fixture.baseSha);
  assert.equal(await gitText(fixture.worktree, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.deepEqual(result.receipt.identity, {
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.com",
    committerName: "Ada Lovelace",
    committerEmail: "ada@example.com",
  });
  assert.equal(result.receipt.runId, PERSON_OWNER);
  assert.equal(result.base.advanced, true);
  const manifest = await fixture.manager.loadManifest("person-repo");
  assert.equal(manifest.baseSha, head);
  assert.deepEqual(manifest.budget.changedPaths, []);
  assert.equal(manifest.ownerRunId, PERSON_OWNER);
  assert.equal(manifest.lease, null, "the person's lease is released");
  // The proof is durable and reads back under the closed checkpoint parser.
  const stored = fixture.namespace()!.checkpoints[result.checkpointId]!;
  const parsed = await parseCodeRepairCheckpointV1(stored);
  assert.deepEqual(parsed.request.commitIdentity, result.receipt.identity);
  assert.equal(parsed.verifiedCommitReceipt?.fingerprint, result.receipt.fingerprint);

  // The same attempt asked again answers the same commit and runs nothing.
  const again = await fixture.runtime.commit({
    workspaceId: "person-repo",
    operationId: "op-1",
    message: "Fix the readme\n\nAnd tidy the notes.",
    person: ADA,
  });
  assert.equal(again.status, "committed", JSON.stringify(again));
  if (again.status === "committed") assert.equal(again.commitSha, head);
  assert.deepEqual(fixture.validations, ["fast", "targeted", "full"]);
  // The id cannot be reused for another commit, and a clean tree has nothing.
  const reused = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-1", message: "Other", person: ADA });
  assert.equal(reused.status === "refused" && reused.code, "operation_mismatch");
  const clean = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-2", message: "Nothing", person: ADA });
  assert.equal(clean.status === "refused" && clean.code, "nothing_to_commit");
});

test("a failed validation commits nothing and says which check failed", async (t) => {
  const fixture = await repository(t);
  await personChanges(fixture);
  fixture.failing.add("targeted");
  const result = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-red", message: "Try it", person: ADA });
  assert.equal(result.status, "blocked", JSON.stringify(result));
  if (result.status !== "blocked") return;
  assert.equal(result.code, "targeted_validation_failed");
  assert.equal(result.validation?.kind, "targeted");
  assert.deepEqual(fixture.validations, ["fast", "targeted"]);
  assert.equal(await gitText(fixture.worktree, "rev-parse", "HEAD"), fixture.baseSha);
  const manifest = await fixture.manager.loadManifest("person-repo");
  assert.equal(manifest.baseSha, fixture.baseSha);
  assert.ok(manifest.budget.changedPaths.length > 0, "the person's changes are still there");
  assert.equal(manifest.lease, null);

  fixture.failing.clear();
  fixture.failing.add("fast");
  const fast = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-red-2", message: "Try again", person: ADA });
  assert.equal(fast.status === "blocked" && fast.code, "fast_validation_failed");
  assert.equal(await gitText(fixture.worktree, "rev-parse", "HEAD"), fixture.baseSha);
});

test("a change to a protected control needs the person's exact approval", async (t) => {
  const fixture = await repository(t);
  await fixture.edit(async (leaseId) => {
    const pkg = await fixture.manager.read("person-repo", "package.json");
    await fixture.manager.writeExpected("person-repo", leaseId, "package.json", "{\"scripts\":{\"test\":\"node --test\",\"lint\":\"true\"}}\n", pkg.sha256);
  });
  const denied = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-pkg", message: "Add lint", person: ADA });
  assert.equal(denied.status === "blocked" && denied.code, "approval_denied");
  assert.equal(await gitText(fixture.worktree, "rev-parse", "HEAD"), fixture.baseSha);

  const asked: ProtectedDiffApprovalRequestV1[] = [];
  const approved = await fixture.runtime.commit({
    workspaceId: "person-repo",
    operationId: "op-pkg-2",
    message: "Add lint",
    person: ADA,
    approve: async (request) => {
      asked.push(request);
      return true;
    },
  });
  assert.equal(approved.status, "committed", JSON.stringify(approved));
  assert.ok(asked.some((request) => request.purpose === "protected_diff" && request.protectedPaths.includes("package.json")));
  assert.ok(asked.some((request) => request.purpose === "verified_commit"));
});

test("what a person's commit refuses, before anything runs", async (t) => {
  const fixture = await repository(t);
  await personChanges(fixture);
  const ask = (input: Partial<Parameters<typeof fixture.runtime.commit>[0]>) =>
    fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-x", message: "A commit", person: ADA, ...input });
  const code = async (input: Partial<Parameters<typeof fixture.runtime.commit>[0]>) => {
    const result = await ask(input);
    return result.status === "refused" ? result.code : result.status;
  };
  assert.equal(await code({ person: { name: AGENT_GIT_COMMIT_NAME_V1, email: AGENT_GIT_COMMIT_EMAIL_V1 } }), "person_identity_is_agent");
  assert.equal(await code({ person: { name: "Ada <x>", email: "ada@example.com" } }), "person_identity_invalid");
  assert.equal(await code({ person: { name: "Ada", email: "not an address" } }), "person_identity_invalid");
  assert.equal(await code({ message: "   " }), "commit_message_invalid");
  assert.equal(await code({ operationId: "../op" }), "invalid_input");
  assert.equal(await code({ workspaceId: "missing" }), "workspace_not_found");

  await fixture.manager.attachRunToPersonWorkspace("person-repo", "run-code-page-1");
  assert.equal(await code({}), "workspace_attached_to_run");
  await fixture.manager.detachRunFromPersonWorkspace("person-repo", "run-code-page-1");

  const pane = await fixture.manager.acquireLease("person-repo", "person:code-workspaces-pane");
  assert.equal(await code({}), "workspace_in_use");
  await fixture.manager.releaseLease("person-repo", pane.lease!.id);

  await fixture.manager.createScratchWorkspace({ workspaceId: "scratch-space", ownerRunId: PERSON_OWNER });
  assert.equal(await code({ workspaceId: "scratch-space" }), "workspace_not_repository");
  assert.equal(fixture.validations.length, 0, "no validation ran");
  assert.equal(PERSON_COMMIT_LEASE_OWNER_V1, "person:validate-and-commit");
});

test("a verified commit is reverted as a new verified commit by the person", async (t) => {
  const fixture = await repository(t);
  await personChanges(fixture);
  const first = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-1", message: "Fix the readme", person: ADA });
  assert.equal(first.status, "committed", JSON.stringify(first));
  if (first.status !== "committed") return;

  // Only a verified commit, and only the newest.
  const unknown = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-0", commitSha: fixture.baseSha, person: ADA });
  assert.equal(unknown.status === "refused" && unknown.code, "revert_commit_not_verified");

  const reverted = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-1", commitSha: first.commitSha, person: ADA });
  assert.equal(reverted.status, "committed", JSON.stringify(reverted));
  if (reverted.status !== "committed") return;
  assert.deepEqual(reverted.reverted, {
    commitSha: first.commitSha,
    paths: ["README.md", "notes/old.txt", "src/app.ts", "src/main.ts", "src/new.ts"],
  });
  const head = await gitText(fixture.worktree, "rev-parse", "HEAD");
  assert.equal(reverted.commitSha, head);
  assert.equal(await gitText(fixture.worktree, "rev-parse", `${head}^`), first.commitSha);
  assert.equal(
    await gitText(fixture.worktree, "rev-parse", `${head}^{tree}`),
    await gitText(fixture.worktree, "rev-parse", `${fixture.baseSha}^{tree}`),
    "the revert puts back exactly the tree before the commit",
  );
  assert.equal(
    await gitText(fixture.worktree, "log", "-1", "--format=%B"),
    `Revert "Fix the readme"\n\nThis reverts commit ${first.commitSha}.`,
  );
  assert.equal(await gitText(fixture.worktree, "log", "-1", "--format=%an <%ae>"), "Ada Lovelace <ada@example.com>");
  assert.equal(await fs.readFile(path.join(fixture.worktree, "README.md"), "utf8"), "broken\n");
  assert.equal(await fs.readFile(path.join(fixture.worktree, "src", "app.ts"), "utf8"), "export const app = 1;\n");
  await assert.rejects(fs.stat(path.join(fixture.worktree, "src", "new.ts")));
  assert.equal(reverted.base.advanced, true);
  assert.equal((await fixture.manager.loadManifest("person-repo")).baseSha, head);

  // The reverted commit is no longer the newest; a dirty workspace is not reverted.
  const older = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-2", commitSha: first.commitSha, person: ADA });
  assert.equal(older.status === "refused" && older.code, "revert_not_latest");
  // Somebody's later work on a file the revert touches is never clobbered.
  await fixture.edit(async (leaseId) => {
    const readme = await fixture.manager.read("person-repo", "README.md");
    await fixture.manager.writeExpected("person-repo", leaseId, "README.md", "work in progress\n", readme.sha256);
  });
  const conflict = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-3", commitSha: head, person: ADA });
  assert.equal(conflict.status === "refused" && conflict.code, "revert_conflict");
  // Uncommitted work anywhere else keeps the workspace from being reverted.
  await fixture.edit(async (leaseId) => {
    const pkg = await fixture.manager.read("person-repo", "package.json");
    await fixture.manager.writeExpected("person-repo", leaseId, "package.json", "{}\n", pkg.sha256);
  });
  const dirty = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-4", commitSha: head, person: ADA });
  assert.equal(dirty.status === "refused" && dirty.code, "revert_workspace_dirty");
  assert.equal(await gitText(fixture.worktree, "rev-parse", "HEAD"), head, "nothing was committed");
  assert.equal(await fs.readFile(path.join(fixture.worktree, "README.md"), "utf8"), "work in progress\n");
});

test("a revert that stopped part-way finishes when it is asked again", async (t) => {
  const fixture = await repository(t);
  await personChanges(fixture);
  const first = await fixture.runtime.commit({ workspaceId: "person-repo", operationId: "op-1", message: "Fix the readme", person: ADA });
  assert.equal(first.status, "committed", JSON.stringify(first));
  if (first.status !== "committed") return;
  // The full validation fails once: the revert is written but not committed.
  fixture.failing.add("full");
  const blocked = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-1", commitSha: first.commitSha, person: ADA });
  assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
  if (blocked.status !== "blocked") return;
  assert.equal(blocked.code, "full_validation_failed");
  assert.equal(blocked.reverted?.commitSha, first.commitSha);
  assert.equal(await gitText(fixture.worktree, "rev-parse", "HEAD"), first.commitSha);
  assert.equal(await fs.readFile(path.join(fixture.worktree, "README.md"), "utf8"), "broken\n", "the revert is written");
  // Asked again under a new id, the written revert is taken as it stands.
  fixture.failing.clear();
  const finished = await fixture.runtime.revert({ workspaceId: "person-repo", operationId: "rev-2", commitSha: first.commitSha, person: ADA });
  assert.equal(finished.status, "committed", JSON.stringify(finished));
  if (finished.status !== "committed") return;
  assert.equal(
    await gitText(fixture.worktree, "rev-parse", `${finished.commitSha}^{tree}`),
    await gitText(fixture.worktree, "rev-parse", `${fixture.baseSha}^{tree}`),
  );
});

test("a run attached to a person's workspace is told the person commits, not refused as a stranger", async (t) => {
  const fixture = await repository(t);
  await fixture.manager.attachRunToPersonWorkspace("person-repo", "run-code-page-1");
  const artifactHashReader = new FixedArgvArtifactHashReaderV1(fixture.git);
  const proof = new FixedArgvRepairProofAdapterV1({
    workspaceManager: fixture.manager,
    git: fixture.git,
    artifactHashReader,
    getProfile: async (key) => (key === fixture.profile.key ? fixture.profile : null),
  });
  const handlers = createCodeRepairToolRuntimeV1({
    workspaceManager: fixture.manager,
    repositoryProfiles: proof,
    validations: { async readValidation() { return null; } },
    checkpointPersistence: fixture.checkpointPersistence,
    proofReader: proof,
    commitGateway: await createFixedArgvVerifiedCommitGatewayV1({
      workspaceManager: fixture.manager,
      git: fixture.git,
      artifactHashReader,
      disabledHooksPath: path.join(fixture.root, "disabled-hooks"),
    }),
  });
  const scoped: ScopedExtensionContextV1 = {
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: "run-code-page-1",
    operationId: "attached-commit",
    originalPrompt: "Commit my change.",
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    reportProgress() {},
  };
  const prepared = await handlers.prepareVerifiedCommit({
    runId: "run-code-page-1",
    workspaceId: "person-repo",
    requestId: "request-1",
  }, scoped);
  assert.equal(prepared.ok, false);
  if (!prepared.ok) {
    assert.equal(prepared.error.code, "workspace_commit_by_person");
    assert.match(prepared.error.message, /the person commits them/u);
  }
});
