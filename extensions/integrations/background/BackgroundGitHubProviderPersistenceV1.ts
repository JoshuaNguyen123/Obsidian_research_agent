import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  GitHubPublicationCheckpointNamespaceV1,
  GitHubPublicationCheckpointPersistenceV1,
} from "../../../src/integrations/github/GitHubPublicationCheckpointStore";
import type {
  GitPushAttemptNamespaceV1,
  GitPushAttemptPersistenceV1,
} from "../../../src/integrations/github/GitPushAttemptStore";
import {
  ensureSafeCompanionDirectoryV1,
  readSafeCompanionFileV1,
  validateCompanionAppDataRootV1,
  writeSafeCompanionFileAtomicV1,
} from "./SafeCompanionAppDataV1";

const DIRECTORY = "background-github-provider-v1";
const MAX_NAMESPACE_BYTES = 512 * 1024;
const MAX_CLAIM_BYTES = 2 * 1024;

export interface BackgroundGitHubProviderPersistenceOptionsV1 {
  randomId?: () => string;
}

interface RevisionClaimV1 {
  version: 1;
  namespaceFileName: string;
  expectedRevision: number;
  nextRevision: number;
  namespaceSha256: string;
}

interface CanonicalNamespaceReadbackV1 {
  bytes: Buffer | null;
  revision: number;
}

/**
 * Private app-data persistence for the provider's inner WALs.
 *
 * Cross-process CAS uses one immutable claim per namespace revision. A writer
 * first stages the complete next namespace in a content-addressed WAL, then
 * atomically installs a small claim by hard-linking its private claim source
 * into the fixed revision path. Exactly one claim can win. Claims and their
 * sources are retained as a small append-only election journal, so no stale
 * lock is ever unlinked or replaced. A crashed winner is completed by the next
 * reader/writer from the hash-verified WAL before newer state is observed.
 */
export class BackgroundGitHubProviderPersistenceV1 {
  private readonly root: string;
  private readonly directory: string;
  private readonly randomId: () => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    applicationDataRoot: string,
    options: BackgroundGitHubProviderPersistenceOptionsV1 = {},
  ) {
    this.root = validateCompanionAppDataRootV1(applicationDataRoot);
    this.directory = path.join(this.root, DIRECTORY);
    this.randomId = options.randomId ?? randomUUID;
  }

  gitPushAttempts(): GitPushAttemptPersistenceV1 {
    return this.namespace<GitPushAttemptNamespaceV1>("git-push-attempts.json");
  }

  publicationCheckpoints(): GitHubPublicationCheckpointPersistenceV1 {
    return this.namespace<GitHubPublicationCheckpointNamespaceV1>(
      "publication-checkpoints.json",
    );
  }

  private namespace<TNamespace extends { revision: number }>(fileName: string): {
    read(): Promise<unknown | null>;
    write(namespace: TNamespace, expectedRevision: number): Promise<boolean>;
  } {
    const filePath = path.join(this.directory, fileName);
    return {
      read: () => this.serialized(async () => {
        const current = await this.readCanonicalWithRecovery(fileName, filePath);
        if (!current.bytes) return null;
        try {
          return JSON.parse(current.bytes.toString("utf8")) as unknown;
        } catch {
          throw new Error("Background GitHub provider state is not valid JSON.");
        }
      }),
      write: (namespace, expectedRevision) => this.serialized(async () => {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw new Error("Background GitHub provider expected revision is invalid.");
        }
        if (namespace.revision !== expectedRevision + 1) {
          throw new Error("Background GitHub provider state revision did not advance once.");
        }
        const namespaceBytes = Buffer.from(JSON.stringify(namespace), "utf8");
        if (namespaceBytes.byteLength > MAX_NAMESPACE_BYTES) {
          throw new Error("Background GitHub provider state exceeds its fixed byte limit.");
        }
        const current = await this.readCanonicalWithRecovery(fileName, filePath);
        if (current.revision !== expectedRevision) return false;

        const proposedSha = sha256(namespaceBytes);
        const claim = await this.installOrReadClaim(
          fileName,
          expectedRevision,
          namespaceBytes,
          proposedSha,
        );
        const committed = await this.finalizeClaim(filePath, current, claim);
        return claim.namespaceSha256 === proposedSha && committed.equals(namespaceBytes);
      }),
    };
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readCanonicalWithRecovery(
    fileName: string,
    filePath: string,
  ): Promise<CanonicalNamespaceReadbackV1> {
    await ensureSafeCompanionDirectoryV1(this.root, this.directory);
    const current = await this.readCanonical(filePath);
    const claim = await this.readClaim(fileName, current.revision + 1);
    if (!claim) return current;
    const bytes = await this.finalizeClaim(filePath, current, claim);
    return { bytes, revision: claim.nextRevision };
  }

  private async readCanonical(filePath: string): Promise<CanonicalNamespaceReadbackV1> {
    const bytes = await readSafeCompanionFileV1({
      applicationDataRoot: this.root,
      filePath,
      maximumBytes: MAX_NAMESPACE_BYTES,
      allowMissing: true,
    });
    if (!bytes) return { bytes: null, revision: 0 };
    return { bytes, revision: parseRevision(bytes, "canonical state") };
  }

  private async installOrReadClaim(
    fileName: string,
    expectedRevision: number,
    namespaceBytes: Buffer,
    namespaceSha256: string,
  ): Promise<RevisionClaimV1> {
    const nextRevision = expectedRevision + 1;
    const existing = await this.readClaim(fileName, nextRevision);
    if (existing) return existing;

    const claim: RevisionClaimV1 = {
      version: 1,
      namespaceFileName: fileName,
      expectedRevision,
      nextRevision,
      namespaceSha256,
    };
    const claimBytes = Buffer.from(JSON.stringify(claim), "utf8");
    const walPath = this.walPath(fileName, nextRevision, namespaceSha256);
    const sourcePath = this.claimSourcePath(fileName, nextRevision, namespaceSha256);
    const claimPath = this.claimPath(fileName, nextRevision);

    await this.writeOrVerifySingleLink(walPath, namespaceBytes, MAX_NAMESPACE_BYTES);
    try {
      await this.writeOrVerifySingleLink(sourcePath, claimBytes, MAX_CLAIM_BYTES);
    } catch (error) {
      const racedClaim = await this.readClaim(fileName, nextRevision);
      if (racedClaim) return racedClaim;
      throw error;
    }

    try {
      await fs.link(sourcePath, claimPath);
      await syncDirectory(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const installed = await this.readClaim(fileName, nextRevision);
    if (!installed) {
      throw new Error("Background GitHub provider revision claim disappeared during installation.");
    }
    return installed;
  }

  private async writeOrVerifySingleLink(
    filePath: string,
    bytes: Buffer,
    maximumBytes: number,
  ): Promise<void> {
    const existing = await readSafeCompanionFileV1({
      applicationDataRoot: this.root,
      filePath,
      maximumBytes,
      allowMissing: true,
    });
    if (existing) {
      if (!existing.equals(bytes)) {
        throw new Error("Background GitHub provider content-addressed WAL changed bytes.");
      }
      return;
    }
    await writeSafeCompanionFileAtomicV1({
      applicationDataRoot: this.root,
      directory: this.directory,
      finalPath: filePath,
      bytes,
      maximumBytes,
      temporaryToken: this.randomId(),
    });
  }

  private async readClaim(
    fileName: string,
    nextRevision: number,
  ): Promise<RevisionClaimV1 | null> {
    const claimPath = this.claimPath(fileName, nextRevision);
    let claimStats: import("node:fs").BigIntStats;
    try {
      claimStats = await fs.lstat(claimPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    assertClaimLink(claimStats, "revision claim");
    const handle = await fs.open(claimPath, "r");
    let bytes: Buffer;
    try {
      const opened = await handle.stat({ bigint: true });
      assertClaimLink(opened, "opened revision claim");
      if (opened.dev !== claimStats.dev || opened.ino !== claimStats.ino) {
        throw new Error("Background GitHub provider revision claim changed during open.");
      }
      if (opened.size > BigInt(MAX_CLAIM_BYTES)) {
        throw new Error("Background GitHub provider revision claim exceeds its byte limit.");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const claim = parseClaim(bytes, fileName, nextRevision);
    const sourcePath = this.claimSourcePath(fileName, nextRevision, claim.namespaceSha256);
    const sourceStats = await fs.lstat(sourcePath, { bigint: true });
    assertClaimLink(sourceStats, "revision claim source");
    if (sourceStats.dev !== claimStats.dev || sourceStats.ino !== claimStats.ino) {
      throw new Error("Background GitHub provider revision claim is not linked to its exact private source.");
    }
    return claim;
  }

  private async finalizeClaim(
    filePath: string,
    previous: CanonicalNamespaceReadbackV1,
    claim: RevisionClaimV1,
  ): Promise<Buffer> {
    let current = await this.readCanonical(filePath);
    if (current.revision === claim.nextRevision) {
      if (!current.bytes || sha256(current.bytes) !== claim.namespaceSha256) {
        throw new Error("Background GitHub provider committed revision conflicts with its immutable claim.");
      }
      await this.removeFinalizedWal(claim);
      return current.bytes;
    }
    if (
      current.revision !== claim.expectedRevision ||
      previous.revision !== claim.expectedRevision
    ) {
      throw new Error("Background GitHub provider state advanced outside its immutable revision claim.");
    }
    const walPath = this.walPath(
      claim.namespaceFileName,
      claim.nextRevision,
      claim.namespaceSha256,
    );
    let wal = await readSafeWalAllowCommittedCleanup({
      applicationDataRoot: this.root,
      filePath: walPath,
      maximumBytes: MAX_NAMESPACE_BYTES,
      allowMissing: true,
    });
    if (!wal) {
      current = await this.readCanonical(filePath);
      if (
        current.revision === claim.nextRevision &&
        current.bytes &&
        sha256(current.bytes) === claim.namespaceSha256
      ) return current.bytes;
      throw new Error("Background GitHub provider winning revision WAL is missing.");
    }
    if (
      sha256(wal) !== claim.namespaceSha256 ||
      parseRevision(wal, "revision WAL") !== claim.nextRevision
    ) {
      throw new Error("Background GitHub provider winning revision WAL failed exact verification.");
    }
    current = await this.writeCanonicalOrAcceptExactPeer(
      filePath,
      wal,
      claim,
    );
    if (
      current.revision !== claim.nextRevision ||
      !current.bytes ||
      sha256(current.bytes) !== claim.namespaceSha256
    ) {
      throw new Error("Background GitHub provider revision failed canonical readback.");
    }
    wal = Buffer.alloc(0);
    await this.removeFinalizedWal(claim);
    return current.bytes;
  }

  private async writeCanonicalOrAcceptExactPeer(
    filePath: string,
    bytes: Buffer,
    claim: RevisionClaimV1,
  ): Promise<CanonicalNamespaceReadbackV1> {
    let writeError: unknown = null;
    try {
      await writeSafeCompanionFileAtomicV1({
        applicationDataRoot: this.root,
        directory: this.directory,
        finalPath: filePath,
        bytes,
        maximumBytes: MAX_NAMESPACE_BYTES,
        temporaryToken: this.randomId(),
      });
    } catch (error) {
      writeError = error;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await this.readCanonical(filePath);
      if (
        current.revision === claim.nextRevision &&
        current.bytes &&
        sha256(current.bytes) === claim.namespaceSha256
      ) return current;
      if (!writeError) return current;
      await delay(5);
    }
    throw writeError;
  }

  private async removeFinalizedWal(claim: RevisionClaimV1): Promise<void> {
    const walPath = this.walPath(
      claim.namespaceFileName,
      claim.nextRevision,
      claim.namespaceSha256,
    );
    const current = await readSafeWalAllowCommittedCleanup({
      applicationDataRoot: this.root,
      filePath: walPath,
      maximumBytes: MAX_NAMESPACE_BYTES,
      allowMissing: true,
    });
    if (!current) return;
    if (sha256(current) !== claim.namespaceSha256) {
      throw new Error("Background GitHub provider finalized WAL changed before cleanup.");
    }
    await fs.rm(walPath).catch((error) => {
      // Another finalizer may unlink this exact content-addressed WAL after
      // proving the same canonical revision/hash. No claim or canonical state
      // is removed here.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  private claimPath(fileName: string, nextRevision: number): string {
    return path.join(this.directory, `${fileName}.revision-${nextRevision}.claim.json`);
  }

  private claimSourcePath(
    fileName: string,
    nextRevision: number,
    namespaceSha256: string,
  ): string {
    return path.join(
      this.directory,
      `${fileName}.revision-${nextRevision}.${namespaceSha256}.claim-source.json`,
    );
  }

  private walPath(fileName: string, nextRevision: number, namespaceSha256: string): string {
    return path.join(
      this.directory,
      `${fileName}.revision-${nextRevision}.${namespaceSha256}.wal.json`,
    );
  }
}

function parseRevision(bytes: Buffer, label: string): number {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as { revision?: unknown };
    if (!Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 0) {
      throw new Error("invalid revision");
    }
    return Number(parsed.revision);
  } catch {
    throw new Error(`Background GitHub provider ${label} failed revision readback.`);
  }
}

function parseClaim(
  bytes: Buffer,
  fileName: string,
  nextRevision: number,
): RevisionClaimV1 {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Background GitHub provider revision claim is not valid JSON.");
  }
  if (
    Object.keys(value).sort().join("\n") !==
      ["expectedRevision", "namespaceFileName", "namespaceSha256", "nextRevision", "version"]
        .sort()
        .join("\n") ||
    value.version !== 1 ||
    value.namespaceFileName !== fileName ||
    value.nextRevision !== nextRevision ||
    value.expectedRevision !== nextRevision - 1 ||
    typeof value.namespaceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.namespaceSha256)
  ) {
    throw new Error("Background GitHub provider revision claim failed its exact contract.");
  }
  return value as unknown as RevisionClaimV1;
}

function assertClaimLink(
  stats: import("node:fs").BigIntStats,
  label: string,
): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Background GitHub provider ${label} is not a regular private file.`);
  }
  if (stats.nlink !== BigInt(2)) {
    throw new Error(`Background GitHub provider ${label} failed exact hard-link ownership.`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readSafeWalAllowCommittedCleanup(input: {
  applicationDataRoot: string;
  filePath: string;
  maximumBytes: number;
  allowMissing: true;
}): Promise<Buffer | null> {
  try {
    return await readSafeCompanionFileV1(input);
  } catch (error) {
    // A peer may complete the same immutable claim and unlink only its
    // content-addressed WAL between our safe lstat and open. The caller must
    // prove the canonical revision/hash before accepting this as committed.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32" ||
      !["EACCES", "EBADF", "EINVAL", "EPERM"].includes(code ?? "")
    ) throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}
