import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  WORKSPACE_MAX_CHANGED_BYTES_V2,
  WORKSPACE_MAX_CHANGED_FILES_V2,
  WORKSPACE_MAX_SEARCH_RESULTS_V2,
  WORKSPACE_MAX_TEXT_BYTES_V2,
  assertWorkspaceRelativePathV2,
  isSha256FingerprintV2,
  parseWorkspaceManifestV2,
  serializeWorkspaceManifestV2,
  type WorkspaceManifestV2,
  type WorkspaceSandboxPolicyV2,
} from "./WorkspaceManifestV2";

const MANIFEST_FILE = "manifest.v2.json";
const ROOT_FOLDER = "root";
const TRASH_FOLDER = "trash";
const MAX_TREE_ENTRIES = 10_000;
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1_000;

export class WorkspaceManagerErrorV2 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceManagerErrorV2";
  }
}

export interface WorkspaceMutationReceiptV2 {
  version: 2;
  id: string;
  workspaceId: string;
  operation: "mkdir" | "create" | "append" | "write" | "patch" | "move" | "copy" | "trash" | "restore";
  path: string;
  relatedPath: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  bytesWritten: number;
  bytesDeleted: number;
  affectedCount: number;
  trashId: string | null;
  committedAt: string;
  manifestSha256: string;
  fingerprint: string;
}

export interface WorkspaceReadResultV2 {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceStatResultV2 {
  path: string;
  kind: "file" | "directory";
  bytes: number;
  sha256: string;
  modifiedAt: string;
}

export interface WorkspaceSearchResultV2 {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface WorkspaceManagerOptionsV2 {
  applicationDataRoot?: string;
  now?: () => Date;
  randomId?: () => string;
}

export interface VerifiedWorkspaceBaseReadbackV2 {
  worktreeRoot: string;
  branch: string;
  headSha: string;
  clean: true;
  fingerprint: string;
}

export interface WorkspaceBaseAdvanceReceiptV2 {
  version: 2;
  kind: "workspace_base_advance";
  id: string;
  operationId: string;
  workspaceId: string;
  ownerRunId: string;
  profileKey: string;
  branch: string;
  previousBaseSha: string;
  nextBaseSha: string;
  handoffFingerprint: string;
  headReadbackFingerprint: string;
  commitKind: "committed" | "reconciled";
  advancedAt: string;
  manifestSha256: string;
  fingerprint: string;
}

export function createVerifiedWorkspaceBaseReadbackV2(input: {
  operationId: string;
  workspaceId: string;
  worktreeRoot: string;
  branch: string;
  headSha: string;
  clean: true;
  handoffFingerprint: string;
}): VerifiedWorkspaceBaseReadbackV2 {
  const operationId = workspaceIdentifier(input.operationId);
  const workspaceId = workspaceIdentifier(input.workspaceId);
  const worktreeRoot = boundedText(input.worktreeRoot, "readback worktree root", 2_048);
  const branch = boundedText(input.branch, "readback branch", 255);
  const headSha = gitSha(input.headSha, "readback head SHA");
  if (!isSha256FingerprintV2(input.handoffFingerprint)) {
    throw new WorkspaceManagerErrorV2("invalid_handoff_fingerprint", "Verified handoff fingerprint is invalid.");
  }
  return {
    worktreeRoot,
    branch,
    headSha,
    clean: true,
    fingerprint: sha256Json({
      operationId,
      workspaceId,
      worktreeRoot,
      branch,
      headSha,
      clean: true,
      handoffFingerprint: input.handoffFingerprint,
    }),
  };
}

export class WorkspaceManagerV2 {
  readonly applicationDataRoot: string;
  readonly metadataRoot: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private writeChain = Promise.resolve();

  constructor(options: WorkspaceManagerOptionsV2 = {}) {
    this.applicationDataRoot = path.resolve(
      options.applicationDataRoot ?? defaultApplicationDataRoot(),
    );
    if (this.applicationDataRoot === path.parse(this.applicationDataRoot).root) {
      throw new WorkspaceManagerErrorV2("unsafe_application_root", "Workspace application-data root cannot be a filesystem root.");
    }
    this.metadataRoot = path.join(this.applicationDataRoot, "workspaces-v2");
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID());
  }

  async createScratchWorkspace(input: {
    workspaceId: string;
    ownerRunId: string;
    expiresAt?: string;
    sandboxPolicy?: WorkspaceSandboxPolicyV2;
  }): Promise<WorkspaceManifestV2> {
    const workspaceId = workspaceIdentifier(input.workspaceId);
    const container = this.containerPath(workspaceId);
    await this.assertMetadataBoundary(container, true);
    await fs.mkdir(this.applicationDataRoot, { recursive: true });
    await this.assertMetadataBoundary(container, true);
    await fs.mkdir(this.metadataRoot, { recursive: true });
    await this.assertMetadataBoundary(container, true);
    await fs.mkdir(container, { recursive: false });
    const root = path.join(container, ROOT_FOLDER);
    await fs.mkdir(root, { recursive: false });
    const canonicalRoot = await fs.realpath(root);
    const manifest = await this.newManifest({
      workspaceId,
      ownerRunId: input.ownerRunId,
      kind: "scratch",
      canonicalRoot,
      repositoryBinding: null,
      baseSha: null,
      expiresAt: input.expiresAt,
      sandboxPolicy: input.sandboxPolicy,
    });
    try {
      await this.persistNewManifest(manifest);
    } catch (error) {
      await fs.rm(container, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  }

  async registerTrustedRepositoryWorkspace(input: {
    workspaceId: string;
    ownerRunId: string;
    profileKey: string;
    repositoryRoot: string;
    worktreeRoot: string;
    branch: string;
    baseSha: string;
    bindingFingerprint: string;
    trusted: true;
    expiresAt?: string;
    sandboxPolicy?: WorkspaceSandboxPolicyV2;
  }): Promise<WorkspaceManifestV2> {
    if (input.trusted !== true) throw new WorkspaceManagerErrorV2("untrusted_worktree", "Repository workspaces require an explicit trusted worktree binding.");
    if (!isSha256FingerprintV2(input.bindingFingerprint)) throw new WorkspaceManagerErrorV2("invalid_binding", "Repository binding fingerprint is invalid.");
    if (!/^[a-f0-9]{40,64}$/iu.test(input.baseSha)) throw new WorkspaceManagerErrorV2("invalid_base_sha", "Repository base SHA is invalid.");
    const repositoryRoot = await canonicalDirectory(input.repositoryRoot, "repository root");
    const worktreeRoot = await canonicalDirectory(input.worktreeRoot, "worktree root");
    if (samePath(repositoryRoot, worktreeRoot)) {
      throw new WorkspaceManagerErrorV2("base_checkout_forbidden", "The original repository checkout cannot be used as an agent workspace.");
    }
    const gitMarker = path.join(worktreeRoot, ".git");
    const gitStat = await fs.lstat(gitMarker).catch(() => null);
    if (!gitStat || gitStat.isSymbolicLink() || (!gitStat.isFile() && !gitStat.isDirectory())) {
      throw new WorkspaceManagerErrorV2("invalid_worktree", "Trusted repository workspace is not a Git worktree.");
    }
    const workspaceId = workspaceIdentifier(input.workspaceId);
    const container = this.containerPath(workspaceId);
    const existing = await this.loadManifest(workspaceId).catch((error) =>
      error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_not_found"
        ? null
        : Promise.reject(error),
    );
    if (existing) {
      if (
        existing.kind === "repository" &&
        existing.ownerRunId === input.ownerRunId &&
        existing.canonicalRoot === worktreeRoot &&
        existing.baseSha === input.baseSha.toLowerCase() &&
        existing.repositoryBinding?.profileKey === workspaceIdentifier(input.profileKey) &&
        existing.repositoryBinding.branch === input.branch &&
        existing.repositoryBinding.bindingFingerprint === input.bindingFingerprint
      ) {
        return existing;
      }
      throw new WorkspaceManagerErrorV2("workspace_binding_conflict", "Workspace id is already bound to different durable state.");
    }
    await this.ensureMetadataContainer(container);
    const manifest = await this.newManifest({
      workspaceId,
      ownerRunId: input.ownerRunId,
      kind: "repository",
      canonicalRoot: worktreeRoot,
      repositoryBinding: {
        profileKey: workspaceIdentifier(input.profileKey),
        repositoryRoot,
        worktreeRoot,
        branch: input.branch,
        bindingFingerprint: input.bindingFingerprint,
      },
      baseSha: input.baseSha.toLowerCase(),
      expiresAt: input.expiresAt,
      sandboxPolicy: input.sandboxPolicy,
    });
    try {
      await this.persistNewManifest(manifest);
    } catch (error) {
      await fs.rm(container, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  }

  async loadManifest(workspaceId: string): Promise<WorkspaceManifestV2> {
    const manifestPath = this.manifestPath(workspaceIdentifier(workspaceId));
    const raw = await fs.readFile(manifestPath, "utf8").catch((error) => {
      if (isMissing(error)) throw new WorkspaceManagerErrorV2("workspace_not_found", `Workspace ${workspaceId} does not exist.`);
      throw error;
    });
    return parseWorkspaceManifestV2(JSON.parse(raw));
  }

  async resumeWorkspace(workspaceId: string, ownerRunId: string): Promise<WorkspaceManifestV2> {
    let manifest = await this.loadManifest(workspaceId);
    if (manifest.ownerRunId !== ownerRunId) throw new WorkspaceManagerErrorV2("workspace_owner_mismatch", "Workspace belongs to another run.");
    manifest = await this.applyExpiry(manifest);
    if (["expired", "closed", "blocked"].includes(manifest.status)) {
      throw new WorkspaceManagerErrorV2(`workspace_${manifest.status}`, `Workspace is ${manifest.status}.`);
    }
    await this.assertWorkspaceRoot(manifest);
    for (const [relative, expected] of Object.entries(manifest.hashes.files)) {
      const target = await this.resolveSafePath(manifest, relative, { mustExist: true, mutation: false });
      const actual = await hashFile(target.absolutePath);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        const blocked = { ...manifest, status: "blocked" as const, lease: null, updatedAt: this.isoNow() };
        await this.persistManifest(blocked);
        throw new WorkspaceManagerErrorV2("workspace_hash_drift", `Workspace file changed outside the durable manager: ${relative}.`);
      }
    }
    return manifest;
  }

  /**
   * Advance a repository workspace epoch only after a fixed-argv Git reader has
   * proven that the exact agent branch is clean at the verified prior commit.
   * This resets only the per-mission change budget; hashes remain as drift
   * guards for the newly baselined bytes. Repeating the same operation is a
   * readback-only reconciliation, never a second mutation.
   */
  async advanceRepositoryBaseAfterVerifiedReadback(input: {
    operationId: string;
    workspaceId: string;
    ownerRunId: string;
    profileKey: string;
    expectedWorktreeRoot: string;
    expectedBranch: string;
    expectedPreviousBaseSha: string;
    nextBaseSha: string;
    handoffFingerprint: string;
    readback: VerifiedWorkspaceBaseReadbackV2;
  }): Promise<WorkspaceBaseAdvanceReceiptV2> {
    return this.serializeWrite(async () => {
      const operationId = workspaceIdentifier(input.operationId);
      const workspaceId = workspaceIdentifier(input.workspaceId);
      const ownerRunId = boundedText(input.ownerRunId, "owner run id", 256);
      const profileKey = workspaceIdentifier(input.profileKey);
      const expectedBranch = boundedText(input.expectedBranch, "repository branch", 255);
      const previousBaseSha = gitSha(input.expectedPreviousBaseSha, "previous repository base SHA");
      const nextBaseSha = gitSha(input.nextBaseSha, "next repository base SHA");
      if (previousBaseSha === nextBaseSha) {
        throw new WorkspaceManagerErrorV2("base_advance_noop", "Repository base advance requires a new verified commit.");
      }
      if (!isSha256FingerprintV2(input.handoffFingerprint)) {
        throw new WorkspaceManagerErrorV2("invalid_handoff_fingerprint", "Verified handoff fingerprint is invalid.");
      }
      let manifest = await this.requireReadable(await this.loadManifest(workspaceId));
      if (manifest.status !== "active" || manifest.lease !== null) {
        throw new WorkspaceManagerErrorV2("base_advance_workspace_busy", "Repository base cannot advance while the workspace is leased.");
      }
      const binding = manifest.repositoryBinding;
      if (
        manifest.kind !== "repository" ||
        manifest.ownerRunId !== ownerRunId ||
        !binding ||
        binding.profileKey !== profileKey ||
        binding.branch !== expectedBranch ||
        !samePath(manifest.canonicalRoot, input.expectedWorktreeRoot) ||
        !samePath(binding.worktreeRoot, input.expectedWorktreeRoot)
      ) {
        throw new WorkspaceManagerErrorV2(
          "base_advance_binding_mismatch",
          "Repository base advance does not match the exact trusted workspace, owner, profile, root, and branch.",
        );
      }
      const readback = normalizeBaseReadback(input.readback);
      const expectedReadbackFingerprint = sha256Json({
        operationId,
        workspaceId,
        worktreeRoot: manifest.canonicalRoot,
        branch: expectedBranch,
        headSha: nextBaseSha,
        clean: true,
        handoffFingerprint: input.handoffFingerprint,
      });
      if (
        !samePath(readback.worktreeRoot, manifest.canonicalRoot) ||
        readback.branch !== expectedBranch ||
        readback.headSha !== nextBaseSha ||
        readback.clean !== true ||
        readback.fingerprint !== expectedReadbackFingerprint
      ) {
        throw new WorkspaceManagerErrorV2(
          "base_advance_readback_mismatch",
          "Fixed-argv Git readback does not prove a clean exact branch at the verified commit.",
        );
      }
      let commitKind: WorkspaceBaseAdvanceReceiptV2["commitKind"];
      if (manifest.baseSha === nextBaseSha) {
        commitKind = "reconciled";
      } else {
        if (manifest.baseSha !== previousBaseSha) {
          throw new WorkspaceManagerErrorV2(
            "base_advance_stale",
            "Repository workspace base changed before the verified advance.",
          );
        }
        manifest = parseWorkspaceManifestV2({
          ...manifest,
          baseSha: nextBaseSha,
          updatedAt: this.isoNow(),
          budget: {
            ...manifest.budget,
            changedPaths: [],
            changedBytes: 0,
          },
        });
        await this.persistManifest(manifest);
        const persisted = await this.loadManifest(workspaceId);
        if (
          persisted.baseSha !== nextBaseSha ||
          persisted.ownerRunId !== ownerRunId ||
          persisted.repositoryBinding?.profileKey !== profileKey ||
          persisted.repositoryBinding.branch !== expectedBranch ||
          !samePath(persisted.canonicalRoot, manifest.canonicalRoot)
        ) {
          throw new WorkspaceManagerErrorV2(
            "base_advance_readback_failed",
            "Advanced repository workspace manifest failed exact readback.",
          );
        }
        manifest = persisted;
        commitKind = "committed";
      }
      const advancedAt = this.isoNow();
      const manifestSha256 = sha256Text(serializeWorkspaceManifestV2(manifest));
      const core = {
        version: 2 as const,
        kind: "workspace_base_advance" as const,
        id: `workspace-base-${operationId}`,
        operationId,
        workspaceId,
        ownerRunId,
        profileKey,
        branch: expectedBranch,
        previousBaseSha,
        nextBaseSha,
        handoffFingerprint: input.handoffFingerprint,
        headReadbackFingerprint: readback.fingerprint,
        commitKind,
        advancedAt,
        manifestSha256,
      };
      return { ...core, fingerprint: sha256Json(core) };
    });
  }

  async status(workspaceId: string): Promise<{
    manifest: WorkspaceManifestV2;
    rootReadable: boolean;
    remainingChangedFiles: number;
    remainingChangedBytes: number;
  }> {
    const manifest = await this.applyExpiry(await this.loadManifest(workspaceId));
    let rootReadable = true;
    try { await this.assertWorkspaceRoot(manifest); } catch { rootReadable = false; }
    return {
      manifest,
      rootReadable,
      remainingChangedFiles: WORKSPACE_MAX_CHANGED_FILES_V2 - manifest.budget.changedPaths.length,
      remainingChangedBytes: WORKSPACE_MAX_CHANGED_BYTES_V2 - manifest.budget.changedBytes,
    };
  }

  async inspectTrash(workspaceId: string, trashIdInput: string): Promise<{
    trashId: string;
    originalPath: string;
    fingerprint: string;
    bytes: number;
    affectedCount: number;
    trashedAt: string;
  }> {
    const manifest = await this.requireReadable(await this.loadManifest(workspaceId));
    const trashId = workspaceIdentifier(trashIdInput);
    const trashRoot = path.join(this.containerPath(manifest.workspaceId), TRASH_FOLDER, trashId);
    await this.assertMetadataBoundary(trashRoot, false);
    const record = JSON.parse(await fs.readFile(path.join(trashRoot, "record.json"), "utf8")) as Record<string, unknown>;
    if (
      record.version !== 1 || record.trashId !== trashId ||
      record.workspaceId !== manifest.workspaceId || !isSha256FingerprintV2(record.fingerprint) ||
      !Number.isSafeInteger(record.bytes) || !Number.isSafeInteger(record.affectedCount) ||
      typeof record.trashedAt !== "string"
    ) throw new WorkspaceManagerErrorV2("invalid_trash_record", "Workspace trash record is invalid.");
    return {
      trashId,
      originalPath: assertWorkspaceRelativePathV2(record.originalPath),
      fingerprint: record.fingerprint,
      bytes: Number(record.bytes),
      affectedCount: Number(record.affectedCount),
      trashedAt: record.trashedAt,
    };
  }

  async findTrashEvidence(workspaceId: string, originalPathInput: string, fingerprint: string): Promise<{
    trashId: string;
    originalPath: string;
    fingerprint: string;
  } | null> {
    const manifest = await this.requireReadable(await this.loadManifest(workspaceId));
    const originalPath = assertWorkspaceRelativePathV2(originalPathInput);
    if (!isSha256FingerprintV2(fingerprint)) throw new WorkspaceManagerErrorV2("invalid_precondition", "Trash evidence fingerprint is invalid.");
    const trashFolder = path.join(this.containerPath(manifest.workspaceId), TRASH_FOLDER);
    const entries = await fs.readdir(trashFolder, { withFileTypes: true }).catch((error) => isMissing(error) ? [] : Promise.reject(error));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const evidence = await this.inspectTrash(workspaceId, entry.name).catch(() => null);
      if (evidence?.originalPath === originalPath && evidence.fingerprint === fingerprint) {
        const payload = path.join(trashFolder, entry.name, "payload");
        const tree = await scanAbsoluteTree(payload, originalPath).catch(() => null);
        if (tree?.fingerprint === fingerprint) return evidence;
      }
    }
    return null;
  }

  async acquireLease(workspaceId: string, ownerId: string, ttlMs = 120_000): Promise<WorkspaceManifestV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.applyExpiry(await this.loadManifest(workspaceId));
      const now = this.now();
      if (manifest.lease && Date.parse(manifest.lease.expiresAt) > now.getTime()) {
        if (manifest.lease.ownerId === ownerId) return manifest;
        throw new WorkspaceManagerErrorV2("workspace_lease_conflict", "Workspace already has an active lease.");
      }
      if (!["active", "leased"].includes(manifest.status)) throw new WorkspaceManagerErrorV2("workspace_unavailable", `Workspace is ${manifest.status}.`);
      const at = now.toISOString();
      manifest = {
        ...manifest,
        status: "leased",
        lease: {
          id: workspaceIdentifier(`lease-${this.randomId()}`),
          ownerId: boundedText(ownerId, "lease owner", 256),
          acquiredAt: at,
          heartbeatAt: at,
          expiresAt: new Date(now.getTime() + clamp(ttlMs, 5_000, 15 * 60_000)).toISOString(),
        },
        updatedAt: at,
      };
      await this.persistManifest(manifest);
      return manifest;
    });
  }

  async renewLease(workspaceId: string, leaseId: string, ttlMs = 120_000): Promise<WorkspaceManifestV2> {
    return this.serializeWrite(async () => {
      const manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const now = this.now();
      const next = {
        ...manifest,
        updatedAt: now.toISOString(),
        lease: {
          ...manifest.lease!,
          heartbeatAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + clamp(ttlMs, 5_000, 15 * 60_000)).toISOString(),
        },
      };
      await this.persistManifest(next);
      return next;
    });
  }

  async releaseLease(workspaceId: string, leaseId: string): Promise<WorkspaceManifestV2> {
    return this.serializeWrite(async () => {
      const manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const next = { ...manifest, status: "active" as const, lease: null, updatedAt: this.isoNow() };
      await this.persistManifest(next);
      return next;
    });
  }

  async stat(workspaceId: string, relativePath: string): Promise<WorkspaceStatResultV2> {
    const manifest = await this.requireReadable(await this.loadManifest(workspaceId));
    const target = await this.resolveSafePath(manifest, relativePath, { mustExist: true, mutation: false });
    const stat = await fs.lstat(target.absolutePath);
    if (stat.isFile()) {
      const hash = await hashFile(target.absolutePath);
      return { path: target.relativePath, kind: "file", bytes: hash.bytes, sha256: hash.sha256, modifiedAt: stat.mtime.toISOString() };
    }
    if (!stat.isDirectory()) throw new WorkspaceManagerErrorV2("unsupported_entry", "Workspace path is not a regular file or directory.");
    const tree = await this.scanTree(manifest, target.relativePath);
    return { path: target.relativePath, kind: "directory", bytes: tree.bytes, sha256: tree.fingerprint, modifiedAt: stat.mtime.toISOString() };
  }

  async list(workspaceId: string, relativePath = ""): Promise<Array<{ path: string; kind: "file" | "directory"; bytes: number; sha256: string | null }>> {
    const manifest = await this.requireReadable(await this.loadManifest(workspaceId));
    const target = relativePath
      ? await this.resolveSafePath(manifest, relativePath, { mustExist: true, mutation: false })
      : { absolutePath: manifest.canonicalRoot, relativePath: "" };
    const entries = await fs.readdir(target.absolutePath, { withFileTypes: true });
    const output: Array<{ path: string; kind: "file" | "directory"; bytes: number; sha256: string | null }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.toLowerCase() === ".git") continue;
      const relative = target.relativePath ? `${target.relativePath}/${entry.name}` : entry.name;
      const safe = await this.resolveSafePath(manifest, relative, { mustExist: true, mutation: false });
      const stat = await fs.lstat(safe.absolutePath);
      if (stat.isFile()) {
        assertSafeRegularFile(stat, relative, false);
        const hash = await hashFile(safe.absolutePath);
        output.push({ path: relative, kind: "file", bytes: hash.bytes, sha256: hash.sha256 });
      } else if (stat.isDirectory()) {
        output.push({ path: relative, kind: "directory", bytes: 0, sha256: null });
      }
      if (output.length >= 500) break;
    }
    return output;
  }

  async read(workspaceId: string, relativePath: string): Promise<WorkspaceReadResultV2> {
    const manifest = await this.requireReadable(await this.loadManifest(workspaceId));
    const target = await this.resolveSafePath(manifest, relativePath, { mustExist: true, mutation: false });
    return readTextFile(target.absolutePath, target.relativePath);
  }

  async search(workspaceId: string, query: string, options: { path?: string; caseSensitive?: boolean; limit?: number } = {}): Promise<WorkspaceSearchResultV2[]> {
    const needle = boundedText(query, "search query", 1_000);
    const manifest = await this.requireReadable(await this.loadManifest(workspaceId));
    const start = options.path ? assertWorkspaceRelativePathV2(options.path) : "";
    const tree = await this.scanTree(manifest, start);
    const limit = clamp(options.limit ?? WORKSPACE_MAX_SEARCH_RESULTS_V2, 1, WORKSPACE_MAX_SEARCH_RESULTS_V2);
    const expected = options.caseSensitive ? needle : needle.toLocaleLowerCase();
    const output: WorkspaceSearchResultV2[] = [];
    for (const file of tree.files) {
      const read = await this.read(workspaceId, file.path);
      for (const [index, line] of read.content.split(/\r?\n/u).entries()) {
        const candidate = options.caseSensitive ? line : line.toLocaleLowerCase();
        let offset = candidate.indexOf(expected);
        while (offset >= 0) {
          output.push({ path: file.path, line: index + 1, column: offset + 1, preview: line.slice(0, 500) });
          if (output.length >= limit) return output;
          offset = candidate.indexOf(expected, offset + Math.max(1, expected.length));
        }
      }
    }
    return output;
  }

  async mkdir(workspaceId: string, leaseId: string, relativePath: string): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const normalized = assertWorkspaceRelativePathV2(relativePath);
      const segments = normalized.split("/");
      let cursor = "";
      let affected = 0;
      const created: string[] = [];
      for (const segment of segments) {
        cursor = cursor ? `${cursor}/${segment}` : segment;
        const target = await this.resolveSafePath(manifest, cursor, { mustExist: false, mutation: true });
        if (target.exists) {
          const stat = await fs.lstat(target.absolutePath);
          if (!stat.isDirectory()) throw new WorkspaceManagerErrorV2("path_conflict", `${cursor} is not a directory.`);
          continue;
        }
        await this.revalidateGuard(target.parentGuard!);
        await fs.mkdir(target.absolutePath);
        created.push(target.absolutePath);
        affected += 1;
      }
      try {
        manifest = await this.touchManifest(manifest);
      } catch (error) {
        for (const directory of created.reverse()) await fs.rmdir(directory).catch(() => undefined);
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      return this.receipt(manifest, { operation: "mkdir", path: normalized, affectedCount: affected });
    });
  }

  async createFile(workspaceId: string, leaseId: string, relativePath: string, content: string): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const bytes = textBytes(content);
      const target = await this.resolveSafePath(manifest, relativePath, { mustExist: false, mutation: true });
      if (target.exists) throw new WorkspaceManagerErrorV2("path_exists", `${target.relativePath} already exists.`);
      this.assertBudget(manifest, [target.relativePath], bytes.byteLength);
      await this.revalidateGuard(target.parentGuard!);
      const handle = await fs.open(target.absolutePath, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const after = await hashFile(target.absolutePath);
      try {
        manifest = await this.recordChanges(manifest, [{ path: target.relativePath, hash: after }], bytes.byteLength);
      } catch (error) {
        await fs.rm(target.absolutePath, { force: true });
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      return this.receipt(manifest, { operation: "create", path: target.relativePath, afterSha256: after.sha256, bytesWritten: after.bytes, affectedCount: 1 });
    });
  }

  async appendFile(workspaceId: string, leaseId: string, relativePath: string, content: string, expectedSha256: string): Promise<WorkspaceMutationReceiptV2> {
    const current = await this.read(workspaceId, relativePath);
    if (current.sha256 !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Append precondition hash changed.");
    return this.writeExpectedInternal(workspaceId, leaseId, relativePath, `${current.content}${content}`, expectedSha256, "append", textBytes(content).byteLength);
  }

  async writeExpected(workspaceId: string, leaseId: string, relativePath: string, content: string, expectedSha256: string): Promise<WorkspaceMutationReceiptV2> {
    return this.writeExpectedInternal(workspaceId, leaseId, relativePath, content, expectedSha256, "write");
  }

  async patchExact(workspaceId: string, leaseId: string, relativePath: string, expectedSha256: string, replacements: Array<{ oldText: string; newText: string; expectedOccurrences?: 1 }>): Promise<WorkspaceMutationReceiptV2> {
    if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 50) throw new WorkspaceManagerErrorV2("invalid_patch", "Exact patch requires 1-50 replacements.");
    const current = await this.read(workspaceId, relativePath);
    if (current.sha256 !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Patch precondition hash changed.");
    let next = current.content;
    for (const replacement of replacements) {
      if (!replacement.oldText) throw new WorkspaceManagerErrorV2("invalid_patch", "Patch oldText cannot be empty.");
      const first = next.indexOf(replacement.oldText);
      if (first < 0 || next.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
        throw new WorkspaceManagerErrorV2("patch_mismatch", "Each exact patch oldText must match exactly once.");
      }
      next = `${next.slice(0, first)}${replacement.newText}${next.slice(first + replacement.oldText.length)}`;
    }
    return this.writeExpectedInternal(workspaceId, leaseId, relativePath, next, expectedSha256, "patch");
  }

  /**
   * Internal sandbox boundary for declared generated artifacts. This method is
   * intentionally not exposed as a model tool and accepts opaque bytes only
   * after the sandbox transport supplies their exact expected hash.
   */
  async importSandboxArtifact(input: {
    workspaceId: string;
    leaseId: string;
    relativePath: string;
    bytes: Uint8Array;
    expectedSha256: string;
    expectedExistingSha256?: string | null;
    maxBytes: number;
  }): Promise<WorkspaceMutationReceiptV2> {
    const [receipt] = await this.importSandboxArtifacts({
      workspaceId: input.workspaceId,
      leaseId: input.leaseId,
      artifacts: [{
        relativePath: input.relativePath,
        bytes: input.bytes,
        expectedSha256: input.expectedSha256,
        expectedExistingSha256: input.expectedExistingSha256,
        maxBytes: input.maxBytes,
      }],
    });
    return receipt;
  }

  /**
   * Atomically import a declared sandbox artifact set. All payloads,
   * preconditions, parent guards, backups, readbacks, and the next manifest
   * are verified before the transaction is retained. A failure restores every
   * file and removes directories created only for this batch.
   */
  async importSandboxArtifacts(input: {
    workspaceId: string;
    leaseId: string;
    artifacts: ReadonlyArray<{
      relativePath: string;
      bytes: Uint8Array;
      expectedSha256: string;
      expectedExistingSha256?: string | null;
      maxBytes: number;
    }>;
  }): Promise<WorkspaceMutationReceiptV2[]> {
    return this.serializeWrite(async () => {
      const originalManifest = await this.requireLease(
        await this.loadManifest(input.workspaceId),
        input.leaseId,
      );
      if (!Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > WORKSPACE_MAX_CHANGED_FILES_V2) {
        throw new WorkspaceManagerErrorV2(
          "sandbox_artifact_invalid",
          `Sandbox artifact batch requires 1-${WORKSPACE_MAX_CHANGED_FILES_V2} entries.`,
        );
      }
      const normalized = input.artifacts.map((artifact) => {
        const relativePath = assertWorkspaceRelativePathV2(artifact.relativePath);
        if (!(artifact.bytes instanceof Uint8Array)) {
          throw new WorkspaceManagerErrorV2("sandbox_artifact_invalid", `Sandbox artifact bytes are invalid: ${relativePath}.`);
        }
        if (!Number.isSafeInteger(artifact.maxBytes) || artifact.maxBytes < 1) {
          throw new WorkspaceManagerErrorV2("sandbox_artifact_invalid", `Sandbox artifact byte limit is invalid: ${relativePath}.`);
        }
        const maxBytes = Math.min(WORKSPACE_MAX_CHANGED_BYTES_V2, artifact.maxBytes);
        if (artifact.bytes.byteLength > maxBytes) {
          throw new WorkspaceManagerErrorV2("sandbox_artifact_too_large", `Sandbox artifact exceeds its declared byte limit: ${relativePath}.`);
        }
        const observedSha256 = sha256Bytes(artifact.bytes);
        if (!isSha256FingerprintV2(artifact.expectedSha256) || observedSha256 !== artifact.expectedSha256) {
          throw new WorkspaceManagerErrorV2("sandbox_artifact_hash_mismatch", `Sandbox artifact bytes do not match the declared SHA-256: ${relativePath}.`);
        }
        const expectedExistingSha256 = artifact.expectedExistingSha256 ?? null;
        if (expectedExistingSha256 !== null && !isSha256FingerprintV2(expectedExistingSha256)) {
          throw new WorkspaceManagerErrorV2("sandbox_artifact_invalid", `Sandbox artifact existing hash is invalid: ${relativePath}.`);
        }
        return { ...artifact, relativePath, expectedExistingSha256, maxBytes };
      }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      if (new Set(normalized.map((artifact) => artifact.relativePath)).size !== normalized.length) {
        throw new WorkspaceManagerErrorV2("sandbox_artifact_invalid", "Sandbox artifact batch contains duplicate paths.");
      }
      const changedBytes = normalized.reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
      this.assertBudget(originalManifest, normalized.map((artifact) => artifact.relativePath), changedBytes);

      const createdDirectories: string[] = [];
      const prepared: Array<{
        artifact: typeof normalized[number];
        target: Awaited<ReturnType<WorkspaceManagerV2["resolveSafePath"]>>;
        before: { sha256: string; bytes: number } | null;
        temporary: string;
        backup: string | null;
        applied: boolean;
        after: { sha256: string; bytes: number } | null;
      }> = [];
      let manifest = originalManifest;
      try {
        for (const parent of sandboxArtifactParentPaths(normalized.map((artifact) => artifact.relativePath))) {
          const segments = parent.split("/");
          let cursor = "";
          for (const segment of segments) {
            cursor = cursor ? `${cursor}/${segment}` : segment;
            const directory = await this.resolveSafePath(originalManifest, cursor, { mustExist: false, mutation: true });
            if (directory.exists) {
              const stat = await fs.lstat(directory.absolutePath);
              if (!stat.isDirectory()) throw new WorkspaceManagerErrorV2("sandbox_artifact_path_conflict", `${cursor} is not a directory.`);
              continue;
            }
            await this.revalidateGuard(directory.parentGuard!);
            await fs.mkdir(directory.absolutePath);
            createdDirectories.push(directory.absolutePath);
          }
        }
        for (const artifact of normalized) {
          const target = await this.resolveSafePath(originalManifest, artifact.relativePath, { mustExist: false, mutation: true });
          let before: { sha256: string; bytes: number } | null = null;
          if (target.exists) {
            before = await hashFile(target.absolutePath);
            if (!artifact.expectedExistingSha256 || before.sha256 !== artifact.expectedExistingSha256) {
              throw new WorkspaceManagerErrorV2("sandbox_artifact_precondition_failed", `Existing generated artifact changed before batch import: ${artifact.relativePath}.`);
            }
          } else if (artifact.expectedExistingSha256) {
            throw new WorkspaceManagerErrorV2(
              "sandbox_artifact_precondition_failed",
              `Expected generated artifact does not exist: ${artifact.relativePath}.`,
            );
          }
          const temporary = path.join(path.dirname(target.absolutePath), `.${path.basename(target.absolutePath)}.${this.randomId()}.sandbox.tmp`);
          const backup = before
            ? path.join(path.dirname(target.absolutePath), `.${path.basename(target.absolutePath)}.${this.randomId()}.sandbox.bak`)
            : null;
          const preparedEntry = { artifact, target, before, temporary, backup, applied: false, after: null };
          prepared.push(preparedEntry);
          const handle = await fs.open(temporary, "wx", 0o600);
          try { await handle.writeFile(artifact.bytes); await handle.sync(); } finally { await handle.close(); }
          if (backup && before) {
            await fs.copyFile(target.absolutePath, backup, fsConstants.COPYFILE_EXCL);
            if ((await hashFile(backup)).sha256 !== before.sha256) {
              throw new WorkspaceManagerErrorV2("sandbox_artifact_backup_failed", `Sandbox artifact backup failed hash readback: ${artifact.relativePath}.`);
            }
          }
        }
        for (const entry of prepared) {
          await this.revalidateGuard(entry.target.parentGuard!);
          if (entry.before) {
            const latest = await hashFile(entry.target.absolutePath);
            if (latest.sha256 !== entry.artifact.expectedExistingSha256) {
              throw new WorkspaceManagerErrorV2("sandbox_artifact_precondition_failed", `Generated artifact changed during batch import: ${entry.artifact.relativePath}.`);
            }
          }
        }
        for (const entry of prepared) {
          await renameWithBoundedWindowsRetry(entry.temporary, entry.target.absolutePath);
          entry.applied = true;
          entry.after = await hashFile(entry.target.absolutePath);
          if (entry.after.sha256 !== entry.artifact.expectedSha256) {
            throw new WorkspaceManagerErrorV2("sandbox_artifact_readback_failed", `Imported sandbox artifact failed SHA-256 readback: ${entry.artifact.relativePath}.`);
          }
        }
        manifest = await this.recordChanges(
          originalManifest,
          prepared.map((entry) => ({ path: entry.target.relativePath, hash: entry.after! })),
          changedBytes,
        );
      } catch (error) {
        let rollbackFailure: Error | null = null;
        for (const entry of [...prepared].reverse()) {
          try {
            await fs.rm(entry.temporary, { force: true });
            if (entry.applied) {
              await fs.rm(entry.target.absolutePath, { force: true });
              if (entry.backup) await renameWithBoundedWindowsRetry(entry.backup, entry.target.absolutePath);
            } else if (entry.backup) {
              await fs.rm(entry.backup, { force: true });
            }
          } catch (rollbackError) {
            rollbackFailure ??= rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          }
        }
        for (const directory of [...createdDirectories].reverse()) {
          try { await fs.rmdir(directory); } catch { /* retained only if another writer made it non-empty */ }
        }
        try {
          await this.persistManifest(originalManifest);
        } catch (rollbackError) {
          rollbackFailure ??= rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        if (rollbackFailure) {
          throw new WorkspaceManagerErrorV2(
            "sandbox_artifact_rollback_failed",
            `Sandbox artifact batch rollback failed: ${rollbackFailure.message}`,
          );
        }
        throw error;
      }
      for (const entry of prepared) if (entry.backup) await fs.rm(entry.backup, { force: true });
      return Promise.all(prepared.map((entry) => this.receipt(manifest, {
        operation: entry.before ? "write" : "create",
        path: entry.target.relativePath,
        beforeSha256: entry.before?.sha256 ?? null,
        afterSha256: entry.after!.sha256,
        bytesWritten: entry.after!.bytes,
        bytesDeleted: entry.before?.bytes ?? 0,
        affectedCount: 1,
      })));
    });
  }

  async move(workspaceId: string, leaseId: string, sourcePath: string, destinationPath: string, expectedSha256: string): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const source = await this.resolveSafePath(manifest, sourcePath, { mustExist: true, mutation: true });
      const destination = await this.resolveSafePath(manifest, destinationPath, { mustExist: false, mutation: true });
      if (destination.exists) throw new WorkspaceManagerErrorV2("path_exists", "Move destination already exists.");
      const tree = await this.scanTree(manifest, source.relativePath, true);
      const sourceFingerprint = mutationFingerprint(tree, source.relativePath);
      if (sourceFingerprint !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Move source fingerprint changed.");
      const changed = [...tree.files.map((file) => file.path), ...tree.files.map((file) => remapPath(file.path, source.relativePath, destination.relativePath))];
      this.assertBudget(manifest, changed, tree.bytes);
      await this.revalidateGuard(source.parentGuard!);
      await this.revalidateGuard(destination.parentGuard!);
      await fs.rename(source.absolutePath, destination.absolutePath);
      const movedTree = remapTree(tree, source.relativePath, destination.relativePath);
      const updates = tree.files.map((file) => ({ path: remapPath(file.path, source.relativePath, destination.relativePath), hash: { sha256: file.sha256, bytes: file.bytes } }));
      const removals = tree.files.map((file) => file.path);
      try {
        manifest = await this.recordChanges(manifest, updates, tree.bytes, removals, changed);
      } catch (error) {
        await fs.rename(destination.absolutePath, source.absolutePath);
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      return this.receipt(manifest, { operation: "move", path: source.relativePath, relatedPath: destination.relativePath, beforeSha256: sourceFingerprint, afterSha256: mutationFingerprint(movedTree, destination.relativePath), bytesWritten: tree.bytes, bytesDeleted: tree.bytes, affectedCount: tree.files.length });
    });
  }

  async copy(workspaceId: string, leaseId: string, sourcePath: string, destinationPath: string, expectedSha256: string): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const source = await this.resolveSafePath(manifest, sourcePath, { mustExist: true, mutation: false });
      const destination = await this.resolveSafePath(manifest, destinationPath, { mustExist: false, mutation: true });
      if (destination.exists) throw new WorkspaceManagerErrorV2("path_exists", "Copy destination already exists.");
      const tree = await this.scanTree(manifest, source.relativePath, true);
      const sourceFingerprint = mutationFingerprint(tree, source.relativePath);
      if (sourceFingerprint !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Copy source fingerprint changed.");
      const changed = tree.files.map((file) => remapPath(file.path, source.relativePath, destination.relativePath));
      this.assertBudget(manifest, changed, tree.bytes);
      await this.revalidateGuard(destination.parentGuard!);
      await copyTreeSafe(source.absolutePath, destination.absolutePath);
      const verify = await this.scanTree(manifest, destination.relativePath, true);
      const expectedDestinationTree = remapTree(
        tree,
        source.relativePath,
        destination.relativePath,
      );
      if (verify.fingerprint !== expectedDestinationTree.fingerprint) {
        await fs.rm(destination.absolutePath, { recursive: true, force: true });
        throw new WorkspaceManagerErrorV2("copy_readback_failed", "Copied workspace tree failed hash readback.");
      }
      const updates = verify.files.map((file) => ({ path: file.path, hash: { sha256: file.sha256, bytes: file.bytes } }));
      try {
        manifest = await this.recordChanges(manifest, updates, tree.bytes, [], changed);
      } catch (error) {
        await fs.rm(destination.absolutePath, { recursive: true, force: true });
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      return this.receipt(manifest, { operation: "copy", path: source.relativePath, relatedPath: destination.relativePath, beforeSha256: sourceFingerprint, afterSha256: mutationFingerprint(verify, destination.relativePath), bytesWritten: tree.bytes, affectedCount: tree.files.length });
    });
  }

  async trash(workspaceId: string, leaseId: string, relativePath: string, expectedSha256: string): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const source = await this.resolveSafePath(manifest, relativePath, { mustExist: true, mutation: true });
      const tree = await this.scanTree(manifest, source.relativePath, true);
      const sourceFingerprint = mutationFingerprint(tree, source.relativePath);
      if (sourceFingerprint !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Trash source fingerprint changed.");
      this.assertBudget(manifest, tree.files.map((file) => file.path), tree.bytes);
      const trashId = workspaceIdentifier(`trash-${this.randomId()}`);
      const trashRoot = path.join(this.containerPath(manifest.workspaceId), TRASH_FOLDER, trashId);
      await this.assertMetadataBoundary(trashRoot, true);
      await fs.mkdir(path.dirname(trashRoot), { recursive: true });
      await this.assertMetadataBoundary(trashRoot, true);
      await fs.mkdir(trashRoot);
      const payload = path.join(trashRoot, "payload");
      await this.revalidateGuard(source.parentGuard!);
      await moveAcrossDevices(source.absolutePath, payload);
      await fs.writeFile(path.join(trashRoot, "record.json"), `${JSON.stringify({ version: 1, trashId, workspaceId: manifest.workspaceId, originalPath: source.relativePath, fingerprint: tree.fingerprint, bytes: tree.bytes, affectedCount: tree.files.length, trashedAt: this.isoNow() }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        manifest = await this.recordChanges(manifest, [], tree.bytes, tree.files.map((file) => file.path));
      } catch (error) {
        await moveAcrossDevices(payload, source.absolutePath);
        await fs.rm(trashRoot, { recursive: true, force: true });
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      return this.receipt(manifest, { operation: "trash", path: source.relativePath, beforeSha256: sourceFingerprint, bytesDeleted: tree.bytes, affectedCount: tree.files.length, trashId });
    });
  }

  async restore(workspaceId: string, leaseId: string, trashIdInput: string, expectedTrashFingerprint: string): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      const trashId = workspaceIdentifier(trashIdInput);
      const trashRoot = path.join(this.containerPath(manifest.workspaceId), TRASH_FOLDER, trashId);
      await this.assertMetadataBoundary(trashRoot, false);
      const record = JSON.parse(await fs.readFile(path.join(trashRoot, "record.json"), "utf8")) as Record<string, unknown>;
      if (record.version !== 1 || record.trashId !== trashId || record.workspaceId !== manifest.workspaceId || record.fingerprint !== expectedTrashFingerprint) {
        throw new WorkspaceManagerErrorV2("trash_precondition_failed", "Trash record fingerprint changed.");
      }
      const originalPath = assertWorkspaceRelativePathV2(record.originalPath);
      const destination = await this.resolveSafePath(manifest, originalPath, { mustExist: false, mutation: true });
      if (destination.exists) throw new WorkspaceManagerErrorV2("path_exists", "Restore destination already exists.");
      const payload = path.join(trashRoot, "payload");
      const tree = await scanAbsoluteTree(payload, originalPath);
      if (tree.fingerprint !== expectedTrashFingerprint) throw new WorkspaceManagerErrorV2("trash_hash_drift", "Trash payload hash changed.");
      this.assertBudget(manifest, tree.files.map((file) => file.path), tree.bytes);
      await this.revalidateGuard(destination.parentGuard!);
      await moveAcrossDevices(payload, destination.absolutePath);
      try {
        manifest = await this.recordChanges(manifest, tree.files.map((file) => ({ path: file.path, hash: { sha256: file.sha256, bytes: file.bytes } })), tree.bytes);
      } catch (error) {
        await moveAcrossDevices(destination.absolutePath, payload);
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      await fs.rm(trashRoot, { recursive: true, force: true });
      return this.receipt(manifest, { operation: "restore", path: originalPath, afterSha256: tree.fingerprint, bytesWritten: tree.bytes, affectedCount: tree.files.length, trashId });
    });
  }

  private async writeExpectedInternal(workspaceId: string, leaseId: string, relativePath: string, content: string, expectedSha256: string, operation: "append" | "write" | "patch", budgetBytes?: number): Promise<WorkspaceMutationReceiptV2> {
    return this.serializeWrite(async () => {
      let manifest = await this.requireLease(await this.loadManifest(workspaceId), leaseId);
      if (!isSha256FingerprintV2(expectedSha256)) throw new WorkspaceManagerErrorV2("invalid_precondition", "Expected SHA-256 is invalid.");
      const bytes = textBytes(content);
      const target = await this.resolveSafePath(manifest, relativePath, { mustExist: true, mutation: true });
      const before = await hashFile(target.absolutePath);
      if (before.sha256 !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Workspace file changed after preparation.");
      this.assertBudget(manifest, [target.relativePath], budgetBytes ?? bytes.byteLength);
      const temporary = path.join(path.dirname(target.absolutePath), `.${path.basename(target.absolutePath)}.${this.randomId()}.tmp`);
      const backup = path.join(path.dirname(target.absolutePath), `.${path.basename(target.absolutePath)}.${this.randomId()}.rollback.bak`);
      await fs.copyFile(target.absolutePath, backup, fsConstants.COPYFILE_EXCL);
      if ((await hashFile(backup)).sha256 !== before.sha256) {
        await fs.rm(backup, { force: true });
        throw new WorkspaceManagerErrorV2("rollback_backup_failed", "Workspace replacement backup failed hash readback.");
      }
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try {
        await this.revalidateGuard(target.parentGuard!);
        const latest = await hashFile(target.absolutePath);
        if (latest.sha256 !== expectedSha256) throw new WorkspaceManagerErrorV2("precondition_failed", "Workspace file changed during atomic replacement.");
        await renameWithBoundedWindowsRetry(temporary, target.absolutePath);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        await fs.rm(backup, { force: true });
        throw error;
      }
      const after = await hashFile(target.absolutePath);
      try {
        manifest = await this.recordChanges(manifest, [{ path: target.relativePath, hash: after }], budgetBytes ?? bytes.byteLength);
      } catch (error) {
        await fs.rm(target.absolutePath, { force: true });
        await renameWithBoundedWindowsRetry(backup, target.absolutePath);
        await this.restoreManifestAfterFailedMutation(manifest);
        throw error;
      }
      await fs.rm(backup, { force: true });
      return this.receipt(manifest, { operation, path: target.relativePath, beforeSha256: before.sha256, afterSha256: after.sha256, bytesWritten: operation === "append" ? budgetBytes ?? 0 : after.bytes, bytesDeleted: operation === "append" ? 0 : before.bytes, affectedCount: 1 });
    });
  }

  private async newManifest(input: {
    workspaceId: string; ownerRunId: string; kind: "scratch" | "repository"; canonicalRoot: string;
    repositoryBinding: WorkspaceManifestV2["repositoryBinding"]; baseSha: string | null;
    expiresAt?: string; sandboxPolicy?: WorkspaceSandboxPolicyV2;
  }): Promise<WorkspaceManifestV2> {
    const now = this.isoNow();
    const expiresAt = input.expiresAt ?? new Date(Date.parse(now) + DEFAULT_EXPIRY_MS).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(now)) throw new WorkspaceManagerErrorV2("invalid_expiry", "Workspace expiry must be in the future.");
    return parseWorkspaceManifestV2({
      version: 2,
      workspaceId: input.workspaceId,
      kind: input.kind,
      ownerRunId: boundedText(input.ownerRunId, "owner run id", 256),
      repositoryBinding: input.repositoryBinding,
      canonicalRoot: input.canonicalRoot,
      baseSha: input.baseSha,
      sandboxPolicy: input.sandboxPolicy ?? { mode: "editing_only", provider: null, boundaryFingerprint: null, network: "disabled" },
      hashes: { files: {}, indexFingerprint: sha256Json({}) },
      validationHistory: [],
      lease: null,
      status: "active",
      expiresAt,
      createdAt: now,
      updatedAt: now,
      budget: { changedPaths: [], changedBytes: 0, maxChangedFiles: WORKSPACE_MAX_CHANGED_FILES_V2, maxChangedBytes: WORKSPACE_MAX_CHANGED_BYTES_V2 },
    });
  }

  private async requireReadable(manifest: WorkspaceManifestV2): Promise<WorkspaceManifestV2> {
    const current = await this.applyExpiry(manifest);
    if (["expired", "blocked", "closed"].includes(current.status)) throw new WorkspaceManagerErrorV2("workspace_unavailable", `Workspace is ${current.status}.`);
    await this.assertWorkspaceRoot(current);
    return current;
  }

  private async requireLease(manifest: WorkspaceManifestV2, leaseId: string): Promise<WorkspaceManifestV2> {
    const current = await this.requireReadable(manifest);
    if (current.status !== "leased" || !current.lease || current.lease.id !== leaseId || Date.parse(current.lease.expiresAt) <= this.now().getTime()) {
      throw new WorkspaceManagerErrorV2("invalid_lease", "Workspace mutation requires the current unexpired lease.");
    }
    return current;
  }

  private async applyExpiry(manifest: WorkspaceManifestV2): Promise<WorkspaceManifestV2> {
    const now = this.now().getTime();
    if (Date.parse(manifest.expiresAt) <= now) {
      if (manifest.status !== "expired") {
        const expired = { ...manifest, status: "expired" as const, lease: null, updatedAt: new Date(now).toISOString() };
        await this.persistManifest(expired);
        return expired;
      }
      return manifest;
    }
    if (manifest.lease && Date.parse(manifest.lease.expiresAt) <= now) {
      const released = { ...manifest, status: "active" as const, lease: null, updatedAt: new Date(now).toISOString() };
      await this.persistManifest(released);
      return released;
    }
    return manifest;
  }

  private async recordChanges(manifest: WorkspaceManifestV2, updates: Array<{ path: string; hash: { sha256: string; bytes: number } }>, changedBytes: number, removals: string[] = [], changedPaths?: string[]): Promise<WorkspaceManifestV2> {
    const now = this.isoNow();
    const files = { ...manifest.hashes.files };
    for (const removal of removals) delete files[removal];
    for (const update of updates) files[update.path] = { ...update.hash, updatedAt: now };
    const paths = [...new Set([...manifest.budget.changedPaths, ...(changedPaths ?? [...updates.map((item) => item.path), ...removals])])].sort();
    const next = parseWorkspaceManifestV2({
      ...manifest,
      updatedAt: now,
      hashes: { files, indexFingerprint: sha256Json(files) },
      budget: { ...manifest.budget, changedPaths: paths, changedBytes: manifest.budget.changedBytes + changedBytes },
    });
    await this.persistManifest(next);
    return next;
  }

  private async touchManifest(manifest: WorkspaceManifestV2): Promise<WorkspaceManifestV2> {
    const next = { ...manifest, updatedAt: this.isoNow() };
    await this.persistManifest(next);
    return next;
  }

  private async restoreManifestAfterFailedMutation(manifest: WorkspaceManifestV2): Promise<void> {
    try {
      await this.persistManifest(manifest);
      const readback = await this.loadManifest(manifest.workspaceId);
      if (serializeWorkspaceManifestV2(readback) !== serializeWorkspaceManifestV2(manifest)) {
        throw new Error("restored manifest readback differs from the pre-mutation manifest");
      }
    } catch (error) {
      throw new WorkspaceManagerErrorV2(
        "workspace_rollback_failed",
        `Workspace filesystem rollback completed but durable manifest rollback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private assertBudget(manifest: WorkspaceManifestV2, changedPaths: string[], bytes: number): void {
    const paths = new Set([...manifest.budget.changedPaths, ...changedPaths]);
    if (paths.size > WORKSPACE_MAX_CHANGED_FILES_V2) throw new WorkspaceManagerErrorV2("workspace_file_budget_exceeded", "Workspace mission exceeds 100 changed files.");
    if (manifest.budget.changedBytes + bytes > WORKSPACE_MAX_CHANGED_BYTES_V2) throw new WorkspaceManagerErrorV2("workspace_byte_budget_exceeded", "Workspace mission exceeds 10 MiB changed bytes.");
  }

  private async scanTree(manifest: WorkspaceManifestV2, relativePath: string, mutation = false) {
    const target = relativePath
      ? await this.resolveSafePath(manifest, relativePath, { mustExist: true, mutation })
      : { absolutePath: manifest.canonicalRoot, relativePath: "" };
    return scanAbsoluteTree(target.absolutePath, target.relativePath);
  }

  private async resolveSafePath(manifest: WorkspaceManifestV2, relativePath: string, options: { mustExist: boolean; mutation: boolean }): Promise<{ absolutePath: string; relativePath: string; exists: boolean; parentGuard: ParentGuard | null }> {
    const relative = assertWorkspaceRelativePathV2(relativePath);
    await this.assertWorkspaceRoot(manifest);
    const absolute = path.resolve(manifest.canonicalRoot, ...relative.split("/"));
    if (!inside(manifest.canonicalRoot, absolute)) throw new WorkspaceManagerErrorV2("path_escape", "Workspace path escaped its root.");
    const parts = relative.split("/");
    let cursor = manifest.canonicalRoot;
    let exists = true;
    for (let index = 0; index < parts.length; index += 1) {
      cursor = path.join(cursor, parts[index]);
      const stat = await fs.lstat(cursor).catch((error) => isMissing(error) ? null : Promise.reject(error));
      if (!stat) {
        exists = false;
        if (index !== parts.length - 1) throw new WorkspaceManagerErrorV2("parent_missing", "Workspace parent directory does not exist.");
        break;
      }
      if (stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("reparse_path", "Workspace paths cannot traverse symlinks, junctions, or reparse points.");
      const canonical = await fs.realpath(cursor);
      if (!inside(manifest.canonicalRoot, canonical)) throw new WorkspaceManagerErrorV2("canonical_escape", "Workspace path resolves outside its trusted root.");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new WorkspaceManagerErrorV2("invalid_parent", "Workspace path has a non-directory parent.");
      if (options.mutation && stat.isFile()) assertSafeRegularFile(stat, relative, true);
    }
    if (options.mustExist && !exists) throw new WorkspaceManagerErrorV2("path_not_found", `${relative} does not exist.`);
    const parent = path.dirname(absolute);
    const parentGuard = await captureParentGuard(parent, manifest.canonicalRoot);
    return { absolutePath: absolute, relativePath: relative, exists, parentGuard };
  }

  private async assertWorkspaceRoot(manifest: WorkspaceManifestV2): Promise<void> {
    const stat = await fs.lstat(manifest.canonicalRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("unsafe_workspace_root", "Workspace root is not a safe directory.");
    const canonical = await fs.realpath(manifest.canonicalRoot);
    if (!samePath(canonical, manifest.canonicalRoot)) throw new WorkspaceManagerErrorV2("workspace_root_drift", "Workspace canonical root changed.");
  }

  private async revalidateGuard(guard: ParentGuard): Promise<void> {
    const current = await captureParentGuard(guard.path, guard.root);
    if (current.canonical !== guard.canonical || current.dev !== guard.dev || current.ino !== guard.ino) {
      throw new WorkspaceManagerErrorV2("parent_swap", "Workspace parent changed immediately before mutation.");
    }
  }

  private async receipt(manifest: WorkspaceManifestV2, input: Partial<WorkspaceMutationReceiptV2> & Pick<WorkspaceMutationReceiptV2, "operation" | "path">): Promise<WorkspaceMutationReceiptV2> {
    const committedAt = this.isoNow();
    const manifestSha256 = sha256Text(serializeWorkspaceManifestV2(manifest));
    const core = {
      version: 2 as const,
      id: `workspace-receipt-${this.randomId()}`,
      workspaceId: manifest.workspaceId,
      operation: input.operation,
      path: input.path,
      relatedPath: input.relatedPath ?? null,
      beforeSha256: input.beforeSha256 ?? null,
      afterSha256: input.afterSha256 ?? null,
      bytesWritten: input.bytesWritten ?? 0,
      bytesDeleted: input.bytesDeleted ?? 0,
      affectedCount: input.affectedCount ?? 0,
      trashId: input.trashId ?? null,
      committedAt,
      manifestSha256,
    };
    return { ...core, fingerprint: sha256Json(core) };
  }

  private async persistNewManifest(manifest: WorkspaceManifestV2): Promise<void> {
    const manifestPath = this.manifestPath(manifest.workspaceId);
    await fs.writeFile(manifestPath, serializeWorkspaceManifestV2(manifest), { encoding: "utf8", flag: "wx" });
    const readback = parseWorkspaceManifestV2(JSON.parse(await fs.readFile(manifestPath, "utf8")));
    if (readback.workspaceId !== manifest.workspaceId) throw new WorkspaceManagerErrorV2("manifest_readback_failed", "Workspace manifest failed readback.");
  }

  private async persistManifest(manifest: WorkspaceManifestV2): Promise<void> {
    const parsed = parseWorkspaceManifestV2(manifest);
    const manifestPath = this.manifestPath(parsed.workspaceId);
    await this.assertMetadataBoundary(manifestPath, false);
    const temporary = `${manifestPath}.${this.randomId()}.tmp`;
    await fs.writeFile(temporary, serializeWorkspaceManifestV2(parsed), { encoding: "utf8", flag: "wx" });
    try { await renameWithBoundedWindowsRetry(temporary, manifestPath); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    parseWorkspaceManifestV2(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  }

  private async ensureMetadataContainer(container: string): Promise<void> {
    await this.assertMetadataBoundary(container, true);
    await fs.mkdir(this.applicationDataRoot, { recursive: true });
    await this.assertMetadataBoundary(container, true);
    await fs.mkdir(this.metadataRoot, { recursive: true });
    await this.assertMetadataBoundary(container, true);
    await fs.mkdir(container, { recursive: false });
  }

  private async assertMetadataBoundary(candidate: string, allowMissing: boolean): Promise<void> {
    const applicationRoot = path.resolve(this.applicationDataRoot);
    let cursor = path.resolve(candidate);
    if (!inside(applicationRoot, cursor)) throw new WorkspaceManagerErrorV2("metadata_escape", "Workspace metadata escaped application data.");
    while (true) {
      if (await existsPath(cursor)) {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("metadata_reparse", "Workspace metadata rejects symlinks, junctions, and reparse points.");
      } else if (!allowMissing) {
        throw new WorkspaceManagerErrorV2("metadata_missing", "Workspace metadata path is missing.");
      }
      // Only this application-owned tree is an authority boundary. System
      // paths above it may have stable aliases (macOS /var -> /private/var),
      // which do not grant a writable reparse point inside workspace metadata.
      if (samePath(cursor, applicationRoot)) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || !inside(applicationRoot, parent)) {
        throw new WorkspaceManagerErrorV2("metadata_escape", "Workspace metadata escaped application data.");
      }
      cursor = parent;
    }
  }

  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.writeChain.catch(() => undefined).then(operation);
    this.writeChain = current.then(() => undefined, () => undefined);
    return current;
  }

  private containerPath(workspaceId: string): string { return path.join(this.metadataRoot, workspaceId); }
  private manifestPath(workspaceId: string): string { return path.join(this.containerPath(workspaceId), MANIFEST_FILE); }
  private isoNow(): string { return this.now().toISOString(); }
}

interface ParentGuard { path: string; root: string; canonical: string; dev: number; ino: number; }

function sandboxArtifactParentPaths(paths: readonly string[]): string[] {
  const parents = new Set<string>();
  for (const relativePath of paths) {
    const parts = assertWorkspaceRelativePathV2(relativePath).split("/");
    for (let index = 1; index < parts.length; index += 1) {
      parents.add(parts.slice(0, index).join("/"));
    }
  }
  return [...parents].sort((left, right) =>
    left.split("/").length - right.split("/").length || left.localeCompare(right));
}

async function captureParentGuard(parent: string, root: string): Promise<ParentGuard> {
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("unsafe_parent", "Workspace mutation parent is unsafe.");
  const canonical = await fs.realpath(parent);
  if (!inside(root, canonical)) throw new WorkspaceManagerErrorV2("parent_escape", "Workspace mutation parent resolves outside the root.");
  return { path: parent, root, canonical, dev: stat.dev, ino: stat.ino };
}

async function readTextFile(absolutePath: string, relativePath: string): Promise<WorkspaceReadResultV2> {
  const stat = await fs.lstat(absolutePath);
  assertSafeRegularFile(stat, relativePath, false);
  if (stat.size > WORKSPACE_MAX_TEXT_BYTES_V2) throw new WorkspaceManagerErrorV2("file_too_large", "Workspace text file exceeds 2 MiB.");
  const bytes = await fs.readFile(absolutePath);
  const content = decodeText(bytes);
  return { path: relativePath, content, bytes: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

async function hashFile(absolutePath: string): Promise<{ sha256: string; bytes: number }> {
  const stat = await fs.lstat(absolutePath);
  assertSafeRegularFile(stat, absolutePath, false);
  if (stat.size > WORKSPACE_MAX_CHANGED_BYTES_V2) throw new WorkspaceManagerErrorV2("file_too_large", "Workspace file exceeds the 10 MiB artifact boundary.");
  const bytes = await fs.readFile(absolutePath);
  return { sha256: sha256Bytes(bytes), bytes: bytes.byteLength };
}

async function scanAbsoluteTree(absoluteRoot: string, relativeRoot: string): Promise<{ files: Array<{ path: string; sha256: string; bytes: number }>; bytes: number; fingerprint: string }> {
  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  let entriesVisited = 0;
  const rootStat = await fs.lstat(absoluteRoot);
  if (rootStat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("reparse_path", "Workspace tree contains a reparse point.");
  if (rootStat.isFile()) {
    const hash = await hashFile(absoluteRoot);
    files.push({ path: relativeRoot, ...hash });
  } else if (rootStat.isDirectory()) {
    const visit = async (folder: string, relative: string): Promise<void> => {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        entriesVisited += 1;
        if (entriesVisited > MAX_TREE_ENTRIES) throw new WorkspaceManagerErrorV2("tree_too_large", "Workspace tree exceeds 10,000 entries.");
        if (entry.name.toLowerCase() === ".git") {
          if (!relativeRoot && folder === absoluteRoot) continue;
          throw new WorkspaceManagerErrorV2("git_path_blocked", "Workspace operations cannot include .git.");
        }
        const absolute = path.join(folder, entry.name);
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("reparse_path", "Workspace tree contains a symlink, junction, or reparse point.");
        if (stat.isDirectory()) await visit(absolute, nextRelative);
        else if (stat.isFile()) {
          assertSafeRegularFile(stat, nextRelative, true);
          const hash = await hashFile(absolute);
          files.push({ path: nextRelative, ...hash });
        } else throw new WorkspaceManagerErrorV2("unsupported_entry", "Workspace tree contains an unsupported entry.");
      }
    };
    await visit(absoluteRoot, relativeRoot);
  } else throw new WorkspaceManagerErrorV2("unsupported_entry", "Workspace target is not a file or directory.");
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  return { files, bytes, fingerprint: sha256Json(files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))) };
}

async function copyTreeSafe(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("reparse_path", "Copy source contains a reparse point.");
  if (stat.isFile()) {
    assertSafeRegularFile(stat, source, true);
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    return;
  }
  await fs.mkdir(destination);
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git" || entry.isSymbolicLink()) throw new WorkspaceManagerErrorV2("reparse_path", "Copy source contains a blocked entry.");
    await copyTreeSafe(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

async function moveAcrossDevices(source: string, destination: string): Promise<void> {
  try { await fs.rename(source, destination); return; } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || (error as { code?: unknown }).code !== "EXDEV") throw error;
  }
  const before = await scanAbsoluteTree(source, "payload");
  await copyTreeSafe(source, destination);
  const after = await scanAbsoluteTree(destination, "payload");
  if (before.fingerprint !== after.fingerprint) { await fs.rm(destination, { recursive: true, force: true }); throw new WorkspaceManagerErrorV2("move_readback_failed", "Cross-device move failed readback."); }
  await fs.rm(source, { recursive: true, force: true });
}

async function renameWithBoundedWindowsRetry(
  source: string,
  destination: string,
): Promise<void> {
  const retryDelaysMs = [0, 5, 20, 50, 100] as const;
  let lastError: unknown = null;
  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    if (retryDelaysMs[index] > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[index]));
    }
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(code)) ||
        index === retryDelaysMs.length - 1
      ) {
        throw error;
      }
    }
  }
  throw lastError;
}

function assertSafeRegularFile(stat: Awaited<ReturnType<typeof fs.lstat>>, label: string, mutation: boolean): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("not_regular_file", `${label} is not a regular file.`);
  if (stat.nlink > 1) throw new WorkspaceManagerErrorV2("unsafe_hard_link", `${label} has multiple hard links.`);
}

function textBytes(content: string): Uint8Array {
  if (typeof content !== "string" || content.includes("\0")) throw new WorkspaceManagerErrorV2("invalid_text", "Workspace content must be UTF-8 text without null bytes.");
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > WORKSPACE_MAX_TEXT_BYTES_V2) throw new WorkspaceManagerErrorV2("file_too_large", "Workspace text file exceeds 2 MiB.");
  return bytes;
}

function decodeText(bytes: Uint8Array): string {
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new WorkspaceManagerErrorV2("binary_file", "Workspace operation accepts UTF-8 text files only."); }
  if (value.includes("\0")) throw new WorkspaceManagerErrorV2("binary_file", "Workspace operation rejects binary content.");
  return value;
}

function sha256Bytes(value: Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function sha256Text(value: string): string { return sha256Bytes(new TextEncoder().encode(value)); }
function sha256Json(value: unknown): string { return sha256Text(JSON.stringify(value)); }
function mutationFingerprint(tree: { files: Array<{ path: string; sha256: string }>; fingerprint: string }, root: string): string { return tree.files.length === 1 && tree.files[0].path === root ? tree.files[0].sha256 : tree.fingerprint; }
function remapTree(tree: { files: Array<{ path: string; sha256: string; bytes: number }>; bytes: number }, from: string, to: string) { const files = tree.files.map((file) => ({ ...file, path: remapPath(file.path, from, to) })); return { files, bytes: tree.bytes, fingerprint: sha256Json(files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))) }; }
function remapPath(file: string, from: string, to: string): string { return file === from ? to : `${to}${file.slice(from.length)}`; }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function inside(root: string, candidate: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function workspaceIdentifier(value: string): string { const normalized = String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 128); if (!normalized || ["__proto__", "prototype", "constructor"].includes(normalized)) throw new WorkspaceManagerErrorV2("invalid_identifier", "Workspace identifier is invalid."); return normalized; }
function boundedText(value: string, label: string, maximum: number): string { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/u.test(value)) throw new WorkspaceManagerErrorV2("invalid_text", `${label} is invalid.`); return value; }
function gitSha(value: string, label: string): string { const normalized = boundedText(value, label, 64).toLowerCase(); if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) throw new WorkspaceManagerErrorV2("invalid_git_sha", `${label} is invalid.`); return normalized; }
function normalizeBaseReadback(input: VerifiedWorkspaceBaseReadbackV2): VerifiedWorkspaceBaseReadbackV2 { if (!input || typeof input !== "object" || Array.isArray(input) || input.clean !== true || !isSha256FingerprintV2(input.fingerprint)) throw new WorkspaceManagerErrorV2("base_advance_readback_invalid", "Verified repository-head readback is invalid."); return { worktreeRoot: boundedText(input.worktreeRoot, "readback worktree root", 2_048), branch: boundedText(input.branch, "readback branch", 255), headSha: gitSha(input.headSha, "readback head SHA"), clean: true, fingerprint: input.fingerprint }; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Math.floor(value))); }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
async function existsPath(value: string): Promise<boolean> { return fs.lstat(value).then(() => true, (error) => isMissing(error) ? false : Promise.reject(error)); }
async function canonicalDirectory(value: string, label: string): Promise<string> { if (!path.isAbsolute(value)) throw new WorkspaceManagerErrorV2("invalid_absolute_path", `${label} must be absolute.`); const stat = await fs.lstat(value); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceManagerErrorV2("unsafe_directory", `${label} is unsafe.`); return fs.realpath(value); }
function defaultApplicationDataRoot(): string { if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "AgenticResearcher", "code"); if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "AgenticResearcher", "code"); return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "agentic-researcher", "code"); }
