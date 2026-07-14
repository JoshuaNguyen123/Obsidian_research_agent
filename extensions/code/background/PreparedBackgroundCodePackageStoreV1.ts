import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";
import {
  parsePreparedBackgroundCodeActionV1,
  type PreparedBackgroundCodeActionV1,
} from "../../../packages/core-api/src/preparedBackgroundCodeActionV1";
import {
  createPreparedBackgroundCodePackageIdentityV1,
  type PreparedBackgroundCodePackageIdentityV1,
} from "../../../packages/core-api/src/preparedBackgroundCodePackageIdentityV1";
import type { CodeRepairStageV1 } from "../repair";
import type { SandboxProviderKindV2 } from "../sandbox";

export const PREPARED_BACKGROUND_CODE_PACKAGE_VERSION = 1 as const;
export const PREPARED_BACKGROUND_CODE_LEASE_VERSION = 1 as const;

const PACKAGE_DIRECTORY = "prepared-background-code-v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const CHECKPOINT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const MAX_PACKAGE_BYTES = 64 * 1024;
const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 15 * 60_000;

const CODE_REPAIR_STAGES = new Set<CodeRepairStageV1>([
  "initialized",
  "initial_edit",
  "fast_validation",
  "diagnosing",
  "repairing",
  "diff_preview",
  "protected_approval",
  "targeted_validation",
  "full_validation",
  "final_readback",
  "committing",
  "commit_readback",
  "complete",
  "blocked",
]);
const SANDBOX_PROVIDERS = new Set<SandboxProviderKindV2>([
  "docker",
  "podman",
  "wsl2",
  "bubblewrap",
]);

/**
 * Immutable, path-free execution-package index. Checkpoint/profile bodies,
 * trusted paths, and fixed sandbox actions live only in the companion-owned
 * PreparedBackgroundCodeExecutionPlanV1 store and must match this index's
 * fingerprints. Neither store accepts credentials or vault content.
 */
export interface PreparedBackgroundCodePackageV1 {
  version: typeof PREPARED_BACKGROUND_CODE_PACKAGE_VERSION;
  kind: "prepared_background_code_package";
  id: string;
  jobId: string;
  missionId: string;
  nodeId: string;
  graphRevision: number;
  executionHost: "companion" | "headless_runtime";
  handoffFingerprint: string;
  executionPlanFingerprint: string;
  capabilityEnvelopeFingerprint: string;
  nodeFingerprint: string;
  descriptorFingerprint: string;
  preparedActionFingerprint: string;
  consumedActionAuthorityFingerprint: string;
  backgroundAuthorizationFingerprint: string;
  repairCheckpointId: string;
  repairRequestFingerprint: string;
  repairCheckpointSequence: number;
  repairCheckpointStage: CodeRepairStageV1;
  workspaceId: string;
  workspaceBindingFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  sandboxCapabilityFingerprint: string;
  sandboxProvider: SandboxProviderKindV2;
  sandboxBoundaryFingerprint: string;
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export interface PreparedBackgroundCodePackageDraftV1 {
  jobId: string;
  backgroundAuthorizationFingerprint: string;
  executionPlanFingerprint: string;
  repairCheckpointStage: CodeRepairStageV1;
  sandboxProvider: SandboxProviderKindV2;
  sandboxBoundaryFingerprint: string;
  handoff: PreparedBackgroundCodeActionV1;
}

export interface PreparedBackgroundCodePackageLeaseV1 {
  version: typeof PREPARED_BACKGROUND_CODE_LEASE_VERSION;
  kind: "prepared_background_code_package_lease";
  packageId: string;
  packageFingerprint: string;
  ownerId: string;
  leaseId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  fingerprint: string;
}

export interface PreparedBackgroundCodePackagePersistenceReceiptV1 {
  version: 1;
  kind: "prepared_background_code_package_persisted";
  packageId: string;
  packageFingerprint: string;
  fileSha256: string;
  bytes: number;
  persistedAt: string;
  readbackVerified: true;
  fingerprint: string;
}

export interface PreparedBackgroundCodePackageRequirementsV1 {
  packageId: string;
  packageFingerprint: string;
  jobId: string;
  handoffFingerprint: string;
  executionPlanFingerprint: string;
  workspaceId: string;
  workspaceBindingFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  consumedActionAuthorityFingerprint: string;
  backgroundAuthorizationFingerprint: string;
}

export interface PreparedBackgroundCodePackageStoreOptionsV1 {
  applicationDataRoot: string;
  now?: () => Date;
  randomId?: () => string;
}

export class PreparedBackgroundCodePackageStoreV1 {
  readonly applicationDataRoot: string;
  readonly packageRoot: string;

  private readonly now: () => Date;
  private readonly randomId: () => string;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: PreparedBackgroundCodePackageStoreOptionsV1) {
    if (!path.isAbsolute(options.applicationDataRoot)) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "unsafe_application_root",
        "Prepared Code package storage requires an absolute application-data directory.",
      );
    }
    this.applicationDataRoot = path.resolve(options.applicationDataRoot);
    if (
      this.applicationDataRoot === path.parse(this.applicationDataRoot).root
    ) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "unsafe_application_root",
        "Prepared Code package storage requires a non-root absolute application-data directory.",
      );
    }
    if (hasVaultSegment(this.applicationDataRoot)) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "vault_storage_forbidden",
        "Prepared Code packages cannot be stored in an Obsidian or vault path.",
      );
    }
    this.packageRoot = path.join(this.applicationDataRoot, PACKAGE_DIRECTORY);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  async persist(
    packageInput: PreparedBackgroundCodePackageV1,
  ): Promise<{
    package: PreparedBackgroundCodePackageV1;
    receipt: PreparedBackgroundCodePackagePersistenceReceiptV1;
  }> {
    return this.serialized(async () => {
      const preparedPackage = parsePreparedBackgroundCodePackageV1(packageInput);
      assertUnexpired(preparedPackage.expiresAt, this.now(), "prepared Code package");
      await this.ensurePackageRoot();
      const finalPath = this.packagePath(preparedPackage.id);
      const lockPath = `${finalPath}.write.lock`;
      const lock = await this.openExclusiveLock(lockPath);
      let tempPath: string | null = null;
      try {
        const existing = await this.readPackageFile(finalPath, true);
        if (existing) {
          if (existing.package.fingerprint !== preparedPackage.fingerprint) {
            throw new PreparedBackgroundCodePackageStoreErrorV1(
              "package_conflict",
              `Prepared Code package ${preparedPackage.id} already contains different evidence.`,
            );
          }
          return {
            package: existing.package,
            receipt: await this.persistenceReceipt(existing.package, existing.bytes),
          };
        }
        const bytes = encodeCanonicalPackage(preparedPackage);
        tempPath = `${finalPath}.${safeIdentifier(this.randomId(), "temporary id")}.tmp`;
        await this.assertStorageBoundary(tempPath, true);
        const handle = await fs.open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.assertStorageBoundary(finalPath, true);
        await fs.rename(tempPath, finalPath);
        tempPath = null;
        const readback = await this.readPackageFile(finalPath, false);
        if (!readback || readback.package.fingerprint !== preparedPackage.fingerprint) {
          throw new PreparedBackgroundCodePackageStoreErrorV1(
            "package_readback_failed",
            "Prepared Code package failed exact fingerprint readback.",
          );
        }
        return {
          package: readback.package,
          receipt: await this.persistenceReceipt(readback.package, readback.bytes),
        };
      } finally {
        if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => undefined);
        await lock.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async load(
    requirementsInput: PreparedBackgroundCodePackageRequirementsV1,
    options: { allowExpiredForReconciliation?: boolean } = {},
  ): Promise<PreparedBackgroundCodePackageV1> {
    const requirements = parseRequirements(requirementsInput);
    const readback = await this.readPackageFile(this.packagePath(requirements.packageId), true);
    if (!readback) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_not_found",
        `Prepared Code package ${requirements.packageId} is unavailable.`,
      );
    }
    if (!options.allowExpiredForReconciliation) {
      assertUnexpired(readback.package.expiresAt, this.now(), "prepared Code package");
    }
    assertPackageRequirements(readback.package, requirements);
    return readback.package;
  }

  async claim(input: {
    requirements: PreparedBackgroundCodePackageRequirementsV1;
    ownerId: string;
    leaseMs?: number;
    allowExpiredForReconciliation?: boolean;
  }): Promise<PreparedBackgroundCodePackageLeaseV1> {
    return this.serialized(async () => {
      const preparedPackage = await this.load(input.requirements, {
        allowExpiredForReconciliation: input.allowExpiredForReconciliation,
      });
      const ownerId = safeIdentifier(input.ownerId, "package lease owner id");
      const leaseMs = boundedLease(input.leaseMs ?? 60_000);
      const leasePath = this.leasePath(preparedPackage.id);
      const lockPath = `${leasePath}.write.lock`;
      const lock = await this.openExclusiveLock(lockPath);
      try {
        const existing = await this.readLeaseFile(leasePath, true);
        const now = this.now();
        if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
          if (
            existing.ownerId !== ownerId ||
            existing.packageFingerprint !== preparedPackage.fingerprint
          ) {
            throw new PreparedBackgroundCodePackageStoreErrorV1(
              "package_lease_conflict",
              "Prepared Code package already has a live owner lease.",
            );
          }
          return this.writeLease(
            leasePath,
            {
              ...existing,
              heartbeatAt: now.toISOString(),
              expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
            },
          );
        }
        const timestamp = now.toISOString();
        return this.writeLease(leasePath, {
          version: PREPARED_BACKGROUND_CODE_LEASE_VERSION,
          kind: "prepared_background_code_package_lease",
          packageId: preparedPackage.id,
          packageFingerprint: preparedPackage.fingerprint,
          ownerId,
          leaseId: `code-package-lease-${safeIdentifier(this.randomId(), "lease id")}`,
          acquiredAt: timestamp,
          heartbeatAt: timestamp,
          expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
          fingerprint: zeroFingerprint(),
        });
      } finally {
        await lock.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async renew(input: {
    packageId: string;
    packageFingerprint: string;
    ownerId: string;
    leaseId: string;
    leaseMs?: number;
  }): Promise<PreparedBackgroundCodePackageLeaseV1> {
    return this.serialized(async () => {
      const packageId = safeIdentifier(input.packageId, "package id");
      const packageFingerprint = fingerprint(input.packageFingerprint, "package fingerprint");
      const ownerId = safeIdentifier(input.ownerId, "package lease owner id");
      const leaseId = safeIdentifier(input.leaseId, "package lease id", 512);
      const leasePath = this.leasePath(packageId);
      const lockPath = `${leasePath}.write.lock`;
      const lock = await this.openExclusiveLock(lockPath);
      try {
        const existing = await this.readLeaseFile(leasePath, true);
        if (
          !existing ||
          existing.packageFingerprint !== packageFingerprint ||
          existing.ownerId !== ownerId ||
          existing.leaseId !== leaseId ||
          Date.parse(existing.expiresAt) <= this.now().getTime()
        ) {
          throw new PreparedBackgroundCodePackageStoreErrorV1(
            "package_lease_invalid",
            "Prepared Code package lease is absent, expired, or belongs to another owner.",
          );
        }
        const now = this.now();
        return this.writeLease(leasePath, {
          ...existing,
          heartbeatAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + boundedLease(input.leaseMs ?? 60_000)).toISOString(),
        });
      } finally {
        await lock.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async loadForWorker(input: {
    requirements: PreparedBackgroundCodePackageRequirementsV1;
    ownerId: string;
    leaseId: string;
    allowExpiredForReconciliation?: boolean;
  }): Promise<PreparedBackgroundCodePackageV1> {
    const preparedPackage = await this.load(input.requirements, {
      allowExpiredForReconciliation: input.allowExpiredForReconciliation,
    });
    const lease = await this.readLeaseFile(this.leasePath(preparedPackage.id), true);
    if (
      !lease ||
      lease.packageFingerprint !== preparedPackage.fingerprint ||
      lease.ownerId !== safeIdentifier(input.ownerId, "package lease owner id") ||
      lease.leaseId !== safeIdentifier(input.leaseId, "package lease id", 512) ||
      Date.parse(lease.expiresAt) <= this.now().getTime()
    ) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_lease_invalid",
        "Worker does not own the exact live prepared Code package lease.",
      );
    }
    return preparedPackage;
  }

  async release(input: {
    packageId: string;
    packageFingerprint: string;
    ownerId: string;
    leaseId: string;
  }): Promise<void> {
    return this.serialized(async () => {
      const packageId = safeIdentifier(input.packageId, "package id");
      const leasePath = this.leasePath(packageId);
      const lockPath = `${leasePath}.write.lock`;
      const lock = await this.openExclusiveLock(lockPath);
      try {
        const lease = await this.readLeaseFile(leasePath, true);
        if (!lease) return;
        if (
          lease.packageFingerprint !== fingerprint(input.packageFingerprint, "package fingerprint") ||
          lease.ownerId !== safeIdentifier(input.ownerId, "package lease owner id") ||
          lease.leaseId !== safeIdentifier(input.leaseId, "package lease id", 512)
        ) {
          throw new PreparedBackgroundCodePackageStoreErrorV1(
            "package_lease_invalid",
            "Prepared Code package lease belongs to another owner.",
          );
        }
        await fs.rm(leasePath, { force: false });
      } finally {
        await lock.close().catch(() => undefined);
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    });
  }

  private async persistenceReceipt(
    preparedPackage: PreparedBackgroundCodePackageV1,
    bytes: Uint8Array,
  ): Promise<PreparedBackgroundCodePackagePersistenceReceiptV1> {
    const evidence = {
      packageId: preparedPackage.id,
      packageFingerprint: preparedPackage.fingerprint,
      fileSha256: hashBytes(bytes),
      bytes: bytes.byteLength,
      persistedAt: this.now().toISOString(),
      readbackVerified: true as const,
    };
    return {
      version: 1,
      kind: "prepared_background_code_package_persisted",
      ...evidence,
      fingerprint: fingerprintOf(evidence),
    };
  }

  private async writeLease(
    leasePath: string,
    leaseInput: PreparedBackgroundCodePackageLeaseV1,
  ): Promise<PreparedBackgroundCodePackageLeaseV1> {
    const { fingerprint: _ignored, ...evidence } = leaseInput;
    const lease = parsePreparedBackgroundCodePackageLeaseV1({
      ...evidence,
      fingerprint: fingerprintOf(evidence),
    });
    const bytes = encodeCanonical(lease);
    const tempPath = `${leasePath}.${safeIdentifier(this.randomId(), "lease temporary id")}.tmp`;
    await this.assertStorageBoundary(tempPath, true);
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tempPath, leasePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const readback = await this.readLeaseFile(leasePath, false);
    if (!readback || readback.fingerprint !== lease.fingerprint) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_lease_readback_failed",
        "Prepared Code package lease failed exact readback.",
      );
    }
    return readback;
  }

  private async readPackageFile(
    filePath: string,
    optional: boolean,
  ): Promise<{ package: PreparedBackgroundCodePackageV1; bytes: Uint8Array } | null> {
    await this.assertStorageBoundary(filePath, optional);
    const stat = await fs.lstat(filePath).catch((error) => {
      if (optional && isNotFound(error)) return null;
      throw error;
    });
    if (!stat) return null;
    assertRegularPrivateFile(stat, "prepared Code package");
    if (stat.size < 2 || stat.size > MAX_PACKAGE_BYTES) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_size_invalid",
        "Prepared Code package exceeds its fixed size boundary.",
      );
    }
    const bytes = await fs.readFile(filePath);
    const preparedPackage = parsePreparedBackgroundCodePackageV1(
      parseJson(bytes, "prepared Code package"),
    );
    if (this.packagePath(preparedPackage.id) !== filePath) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_identity_mismatch",
        "Prepared Code package filename does not match its identity.",
      );
    }
    return { package: preparedPackage, bytes };
  }

  private async readLeaseFile(
    filePath: string,
    optional: boolean,
  ): Promise<PreparedBackgroundCodePackageLeaseV1 | null> {
    await this.assertStorageBoundary(filePath, optional);
    const stat = await fs.lstat(filePath).catch((error) => {
      if (optional && isNotFound(error)) return null;
      throw error;
    });
    if (!stat) return null;
    assertRegularPrivateFile(stat, "prepared Code package lease");
    if (stat.size < 2 || stat.size > 16 * 1024) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_lease_size_invalid",
        "Prepared Code package lease exceeds its fixed size boundary.",
      );
    }
    return parsePreparedBackgroundCodePackageLeaseV1(
      parseJson(await fs.readFile(filePath), "prepared Code package lease"),
    );
  }

  private async ensurePackageRoot(): Promise<void> {
    await fs.mkdir(this.applicationDataRoot, { recursive: true, mode: 0o700 });
    await this.assertStorageBoundary(this.applicationDataRoot, false);
    await fs.mkdir(this.packageRoot, { recursive: true, mode: 0o700 });
    await this.assertStorageBoundary(this.packageRoot, false);
  }

  private async openExclusiveLock(lockPath: string): Promise<fs.FileHandle> {
    await this.ensurePackageRoot();
    await this.assertStorageBoundary(lockPath, true);
    return fs.open(lockPath, "wx", 0o600).catch((error) => {
      if (isAlreadyExists(error)) {
        throw new PreparedBackgroundCodePackageStoreErrorV1(
          "package_write_locked",
          "Prepared Code package storage is already being updated by another process.",
        );
      }
      throw error;
    });
  }

  private async assertStorageBoundary(candidate: string, allowMissing: boolean): Promise<void> {
    const resolved = path.resolve(candidate);
    if (!isWithin(this.applicationDataRoot, resolved)) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_path_escape",
        "Prepared Code package path escaped application data.",
      );
    }
    let cursor = resolved;
    while (true) {
      const stat = await fs.lstat(cursor).catch((error) => {
        if (allowMissing && isNotFound(error)) return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) {
        throw new PreparedBackgroundCodePackageStoreErrorV1(
          "package_reparse_path",
          "Prepared Code package storage rejects symlinks, junctions, and reparse points.",
        );
      }
      if (cursor === this.applicationDataRoot) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || !isWithin(this.applicationDataRoot, parent)) break;
      cursor = parent;
      allowMissing = true;
    }
  }

  private packagePath(packageId: string): string {
    return path.join(this.packageRoot, `${safeIdentifier(packageId, "package id")}.json`);
  }

  private leasePath(packageId: string): string {
    return path.join(this.packageRoot, `${safeIdentifier(packageId, "package id")}.lease.json`);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class PreparedBackgroundCodePackageStoreErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreparedBackgroundCodePackageStoreErrorV1";
  }
}

export function createPreparedBackgroundCodePackageV1(
  draft: PreparedBackgroundCodePackageDraftV1,
): PreparedBackgroundCodePackageV1 {
  const handoff = parsePreparedBackgroundCodeActionV1(draft.handoff);
  const identity = fingerprintOf({
    version: 1,
    jobId: safeIdentifier(draft.jobId, "job id"),
    handoffFingerprint: handoff.fingerprint,
    executionPlanFingerprint: fingerprint(
      draft.executionPlanFingerprint,
      "execution plan fingerprint",
    ),
    backgroundAuthorizationFingerprint: fingerprint(
      draft.backgroundAuthorizationFingerprint,
      "background authorization fingerprint",
    ),
  });
  const evidence: Omit<PreparedBackgroundCodePackageV1, "fingerprint"> = {
    version: PREPARED_BACKGROUND_CODE_PACKAGE_VERSION,
    kind: "prepared_background_code_package",
    id: `background-code-package-${identity.slice("sha256:".length, "sha256:".length + 32)}`,
    jobId: safeIdentifier(draft.jobId, "job id"),
    missionId: handoff.missionId,
    nodeId: handoff.nodeId,
    graphRevision: handoff.graphRevision,
    executionHost: handoff.executionHost,
    handoffFingerprint: handoff.fingerprint,
    executionPlanFingerprint: fingerprint(
      draft.executionPlanFingerprint,
      "execution plan fingerprint",
    ),
    capabilityEnvelopeFingerprint: handoff.capabilityEnvelopeFingerprint,
    nodeFingerprint: handoff.nodeFingerprint,
    descriptorFingerprint: handoff.descriptorFingerprint,
    preparedActionFingerprint: handoff.preparedActionFingerprint,
    consumedActionAuthorityFingerprint: handoff.authority.authorityFingerprint,
    backgroundAuthorizationFingerprint: fingerprint(
      draft.backgroundAuthorizationFingerprint,
      "background authorization fingerprint",
    ),
    repairCheckpointId: handoff.payload.repairCheckpointId,
    repairRequestFingerprint: handoff.payload.repairRequestFingerprint,
    repairCheckpointSequence: handoff.payload.preparedCheckpointSequence,
    repairCheckpointStage: codeRepairStage(draft.repairCheckpointStage),
    workspaceId: handoff.binding.workspaceId,
    workspaceBindingFingerprint: handoff.payload.workspaceBindingFingerprint,
    repositoryProfileKey: handoff.binding.repositoryProfileKey,
    repositoryProfileFingerprint: handoff.payload.repositoryProfileFingerprint,
    sandboxCapabilityFingerprint: handoff.payload.sandboxCapabilityFingerprint,
    sandboxProvider: sandboxProvider(draft.sandboxProvider),
    sandboxBoundaryFingerprint: fingerprint(
      draft.sandboxBoundaryFingerprint,
      "sandbox boundary fingerprint",
    ),
    preparedAt: handoff.preparedAt,
    expiresAt: handoff.expiresAt,
  };
  return parsePreparedBackgroundCodePackageV1({
    ...evidence,
    fingerprint: fingerprintOf(evidence),
  });
}

export function preparedBackgroundCodePackageIdentityV1(
  value: PreparedBackgroundCodePackageV1,
): PreparedBackgroundCodePackageIdentityV1 {
  const preparedPackage = parsePreparedBackgroundCodePackageV1(value);
  return createPreparedBackgroundCodePackageIdentityV1({
    packageId: preparedPackage.id,
    packageFingerprint: preparedPackage.fingerprint,
    executionPlanFingerprint: preparedPackage.executionPlanFingerprint,
    handoffFingerprint: preparedPackage.handoffFingerprint,
    workspaceId: preparedPackage.workspaceId,
    workspaceBindingFingerprint: preparedPackage.workspaceBindingFingerprint,
    repositoryProfileKey: preparedPackage.repositoryProfileKey,
    repositoryProfileFingerprint: preparedPackage.repositoryProfileFingerprint,
    consumedActionAuthorityFingerprint:
      preparedPackage.consumedActionAuthorityFingerprint,
    backgroundAuthorizationFingerprint:
      preparedPackage.backgroundAuthorizationFingerprint,
    preparedAt: preparedPackage.preparedAt,
    expiresAt: preparedPackage.expiresAt,
  });
}

export function parsePreparedBackgroundCodePackageV1(
  value: unknown,
): PreparedBackgroundCodePackageV1 {
  const record = exactRecord(
    value,
    [
      "version", "kind", "id", "jobId", "missionId", "nodeId", "graphRevision",
      "executionHost", "handoffFingerprint", "executionPlanFingerprint", "capabilityEnvelopeFingerprint",
      "nodeFingerprint", "descriptorFingerprint", "preparedActionFingerprint",
      "consumedActionAuthorityFingerprint", "backgroundAuthorizationFingerprint",
      "repairCheckpointId", "repairRequestFingerprint", "repairCheckpointSequence",
      "repairCheckpointStage", "workspaceId", "workspaceBindingFingerprint",
      "repositoryProfileKey", "repositoryProfileFingerprint",
      "sandboxCapabilityFingerprint", "sandboxProvider", "sandboxBoundaryFingerprint",
      "preparedAt", "expiresAt", "fingerprint",
    ],
    "prepared background Code package",
  );
  assertNoSecretOrPathMaterial(record, "prepared background Code package");
  if (
    record.version !== PREPARED_BACKGROUND_CODE_PACKAGE_VERSION ||
    record.kind !== "prepared_background_code_package" ||
    (record.executionHost !== "companion" && record.executionHost !== "headless_runtime")
  ) {
    fail("Prepared background Code package contract is unsupported.");
  }
  const preparedAt = timestamp(record.preparedAt, "package preparedAt");
  const expiresAt = timestamp(record.expiresAt, "package expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(preparedAt)) {
    fail("Prepared background Code package expiry is invalid.");
  }
  const result: PreparedBackgroundCodePackageV1 = {
    version: PREPARED_BACKGROUND_CODE_PACKAGE_VERSION,
    kind: "prepared_background_code_package",
    id: safeIdentifier(record.id, "package id"),
    jobId: safeIdentifier(record.jobId, "job id"),
    missionId: safeIdentifier(record.missionId, "mission id"),
    nodeId: safeIdentifier(record.nodeId, "node id"),
    graphRevision: integer(record.graphRevision, "graph revision"),
    executionHost: record.executionHost,
    handoffFingerprint: fingerprint(record.handoffFingerprint, "handoff fingerprint"),
    executionPlanFingerprint: fingerprint(record.executionPlanFingerprint, "execution plan fingerprint"),
    capabilityEnvelopeFingerprint: fingerprint(record.capabilityEnvelopeFingerprint, "capability envelope fingerprint"),
    nodeFingerprint: fingerprint(record.nodeFingerprint, "node fingerprint"),
    descriptorFingerprint: fingerprint(record.descriptorFingerprint, "descriptor fingerprint"),
    preparedActionFingerprint: fingerprint(record.preparedActionFingerprint, "prepared action fingerprint"),
    consumedActionAuthorityFingerprint: fingerprint(record.consumedActionAuthorityFingerprint, "consumed action authority fingerprint"),
    backgroundAuthorizationFingerprint: fingerprint(record.backgroundAuthorizationFingerprint, "background authorization fingerprint"),
    repairCheckpointId: checkpointIdentifier(record.repairCheckpointId, "repair checkpoint id"),
    repairRequestFingerprint: fingerprint(record.repairRequestFingerprint, "repair request fingerprint"),
    repairCheckpointSequence: integer(record.repairCheckpointSequence, "repair checkpoint sequence"),
    repairCheckpointStage: codeRepairStage(record.repairCheckpointStage),
    workspaceId: safeIdentifier(record.workspaceId, "workspace id"),
    workspaceBindingFingerprint: fingerprint(record.workspaceBindingFingerprint, "workspace binding fingerprint"),
    repositoryProfileKey: safeIdentifier(record.repositoryProfileKey, "repository profile key"),
    repositoryProfileFingerprint: fingerprint(record.repositoryProfileFingerprint, "repository profile fingerprint"),
    sandboxCapabilityFingerprint: fingerprint(record.sandboxCapabilityFingerprint, "sandbox capability fingerprint"),
    sandboxProvider: sandboxProvider(record.sandboxProvider),
    sandboxBoundaryFingerprint: fingerprint(record.sandboxBoundaryFingerprint, "sandbox boundary fingerprint"),
    preparedAt,
    expiresAt,
    fingerprint: fingerprint(record.fingerprint, "package fingerprint"),
  };
  const { fingerprint: _ignored, ...evidence } = result;
  if (result.fingerprint !== fingerprintOf(evidence)) {
    fail("Prepared background Code package fingerprint does not match its evidence.");
  }
  return result;
}

export function parsePreparedBackgroundCodePackageLeaseV1(
  value: unknown,
): PreparedBackgroundCodePackageLeaseV1 {
  const record = exactRecord(
    value,
    [
      "version", "kind", "packageId", "packageFingerprint", "ownerId", "leaseId",
      "acquiredAt", "heartbeatAt", "expiresAt", "fingerprint",
    ],
    "prepared background Code package lease",
  );
  assertNoSecretOrPathMaterial(record, "prepared background Code package lease");
  if (
    record.version !== PREPARED_BACKGROUND_CODE_LEASE_VERSION ||
    record.kind !== "prepared_background_code_package_lease"
  ) fail("Prepared background Code package lease contract is unsupported.");
  const acquiredAt = timestamp(record.acquiredAt, "lease acquiredAt");
  const heartbeatAt = timestamp(record.heartbeatAt, "lease heartbeatAt");
  const expiresAt = timestamp(record.expiresAt, "lease expiresAt");
  if (
    Date.parse(heartbeatAt) < Date.parse(acquiredAt) ||
    Date.parse(expiresAt) <= Date.parse(heartbeatAt)
  ) fail("Prepared background Code package lease timestamps are invalid.");
  const result: PreparedBackgroundCodePackageLeaseV1 = {
    version: PREPARED_BACKGROUND_CODE_LEASE_VERSION,
    kind: "prepared_background_code_package_lease",
    packageId: safeIdentifier(record.packageId, "lease package id"),
    packageFingerprint: fingerprint(record.packageFingerprint, "lease package fingerprint"),
    ownerId: safeIdentifier(record.ownerId, "lease owner id"),
    leaseId: safeIdentifier(record.leaseId, "lease id", 512),
    acquiredAt,
    heartbeatAt,
    expiresAt,
    fingerprint: fingerprint(record.fingerprint, "lease fingerprint"),
  };
  const { fingerprint: _ignored, ...evidence } = result;
  if (result.fingerprint !== fingerprintOf(evidence)) {
    fail("Prepared background Code package lease fingerprint does not match its evidence.");
  }
  return result;
}

function parseRequirements(
  value: PreparedBackgroundCodePackageRequirementsV1,
): PreparedBackgroundCodePackageRequirementsV1 {
  const record = exactRecord(
    value,
    [
      "packageId", "packageFingerprint", "jobId", "handoffFingerprint", "executionPlanFingerprint", "workspaceId",
      "workspaceBindingFingerprint", "repositoryProfileKey", "repositoryProfileFingerprint",
      "consumedActionAuthorityFingerprint", "backgroundAuthorizationFingerprint",
    ],
    "prepared background Code package requirements",
  );
  return {
    packageId: safeIdentifier(record.packageId, "required package id"),
    packageFingerprint: fingerprint(record.packageFingerprint, "required package fingerprint"),
    jobId: safeIdentifier(record.jobId, "required job id"),
    handoffFingerprint: fingerprint(record.handoffFingerprint, "required handoff fingerprint"),
    executionPlanFingerprint: fingerprint(record.executionPlanFingerprint, "required execution plan fingerprint"),
    workspaceId: safeIdentifier(record.workspaceId, "required workspace id"),
    workspaceBindingFingerprint: fingerprint(record.workspaceBindingFingerprint, "required workspace binding fingerprint"),
    repositoryProfileKey: safeIdentifier(record.repositoryProfileKey, "required repository profile key"),
    repositoryProfileFingerprint: fingerprint(record.repositoryProfileFingerprint, "required repository profile fingerprint"),
    consumedActionAuthorityFingerprint: fingerprint(record.consumedActionAuthorityFingerprint, "required consumed authority fingerprint"),
    backgroundAuthorizationFingerprint: fingerprint(record.backgroundAuthorizationFingerprint, "required background authorization fingerprint"),
  };
}

function assertPackageRequirements(
  preparedPackage: PreparedBackgroundCodePackageV1,
  required: PreparedBackgroundCodePackageRequirementsV1,
): void {
  const actual: PreparedBackgroundCodePackageRequirementsV1 = {
    packageId: preparedPackage.id,
    packageFingerprint: preparedPackage.fingerprint,
    jobId: preparedPackage.jobId,
    handoffFingerprint: preparedPackage.handoffFingerprint,
    executionPlanFingerprint: preparedPackage.executionPlanFingerprint,
    workspaceId: preparedPackage.workspaceId,
    workspaceBindingFingerprint: preparedPackage.workspaceBindingFingerprint,
    repositoryProfileKey: preparedPackage.repositoryProfileKey,
    repositoryProfileFingerprint: preparedPackage.repositoryProfileFingerprint,
    consumedActionAuthorityFingerprint: preparedPackage.consumedActionAuthorityFingerprint,
    backgroundAuthorizationFingerprint: preparedPackage.backgroundAuthorizationFingerprint,
  };
  for (const key of Object.keys(required) as Array<keyof PreparedBackgroundCodePackageRequirementsV1>) {
    if (actual[key] !== required[key]) {
      throw new PreparedBackgroundCodePackageStoreErrorV1(
        "package_scope_mismatch",
        `Prepared Code package ${key} does not match the exact worker scope.`,
      );
    }
  }
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} does not match its closed contract.`);
  }
  return record as Record<T[number], unknown>;
}

function assertNoSecretOrPathMaterial(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  if (
    /(?:Bearer\s+\S+|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu.test(serialized) ||
    /"(?:token|secret|password|cookie|credential|apiKey|api_key|authorization)"\s*:/iu.test(serialized) ||
    /(?:[A-Za-z]:[\\/]|(?:^|["\s])\/(?!\/))[^"\s]*/u.test(serialized) ||
    /(?:^|[\\/])\.obsidian(?:[\\/]|$)|(?:^|[\\/])[^\\/]*vault[^\\/]*(?:[\\/]|$)/iu.test(serialized) ||
    /\b(?:powershell|pwsh|cmd\.exe|bash|sh|curl|wget|npm|pnpm|yarn|pip|cargo|go|dotnet|mvn|gradle)\b(?:\s|%20)+[-A-Za-z0-9]/iu.test(serialized)
  ) {
    fail(`${label} contains secret, path, vault, or command material.`);
  }
}

function safeIdentifier(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !IDENTIFIER.test(value)) {
    fail(`${label} is invalid.`);
  }
  if (["__proto__", "prototype", "constructor"].includes(value)) fail(`${label} is invalid.`);
  assertNoSecretOrPathMaterial(value, label);
  return value;
}

function checkpointIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !CHECKPOINT_IDENTIFIER.test(value)) fail(`${label} is invalid.`);
  assertNoSecretOrPathMaterial(value, label);
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a SHA-256 fingerprint.`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative integer.`);
  return Number(value);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function codeRepairStage(value: unknown): CodeRepairStageV1 {
  if (typeof value !== "string" || !CODE_REPAIR_STAGES.has(value as CodeRepairStageV1)) {
    fail("Prepared Code package repair stage is invalid.");
  }
  return value as CodeRepairStageV1;
}

function sandboxProvider(value: unknown): SandboxProviderKindV2 {
  if (typeof value !== "string" || !SANDBOX_PROVIDERS.has(value as SandboxProviderKindV2)) {
    fail("Prepared Code package sandbox provider is invalid.");
  }
  return value as SandboxProviderKindV2;
}

function boundedLease(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
    throw new PreparedBackgroundCodePackageStoreErrorV1(
      "package_lease_duration_invalid",
      "Prepared Code package lease duration is outside its safe bound.",
    );
  }
  return value;
}

function assertUnexpired(expiresAt: string, now: Date, label: string): void {
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw new PreparedBackgroundCodePackageStoreErrorV1(
      "package_expired",
      `${label} has expired.`,
    );
  }
}

function encodeCanonicalPackage(value: PreparedBackgroundCodePackageV1): Uint8Array {
  return encodeCanonical(value);
}

function encodeCanonical(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${canonicalJson(value)}\n`);
  if (bytes.byteLength > MAX_PACKAGE_BYTES) fail("Prepared Code package exceeds its fixed byte limit.");
  return bytes;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8.`);
  }
  if (text.includes("\0")) fail(`${label} contains NUL.`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON.`);
  }
}

function fingerprintOf(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("Package evidence contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("Package evidence contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function zeroFingerprint(): string {
  return `sha256:${"0".repeat(64)}`;
}

function hasVaultSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment.toLowerCase() === ".obsidian" || segment.toLowerCase().includes("vault"));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertRegularPrivateFile(stat: Awaited<ReturnType<typeof fs.lstat>>, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PreparedBackgroundCodePackageStoreErrorV1(
      "package_file_unsafe",
      `${label} is not a single-link regular file.`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function fail(message: string): never {
  throw new PreparedBackgroundCodePackageStoreErrorV1("invalid_package", message);
}
