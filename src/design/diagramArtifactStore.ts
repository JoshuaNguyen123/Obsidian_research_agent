export const DIAGRAM_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const DIAGRAM_ARTIFACT_TRANSACTION_MAX_FILES = 16;

const ALLOWED_EXTENSIONS = new Set([".canvas", ".svg", ".md"]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface DiagramArtifactFileLike {
  path: string;
}

export interface DiagramArtifactVaultLike {
  getAbstractFileByPath(path: string): { path: string } | null;
  getFileByPath?(path: string): DiagramArtifactFileLike | null;
  getFolderByPath?(path: string): { path: string } | null;
  createFolder?(path: string): Promise<unknown>;
  read(file: DiagramArtifactFileLike): Promise<string>;
  create(path: string, content: string): Promise<DiagramArtifactFileLike>;
  modify(file: DiagramArtifactFileLike, content: string): Promise<void>;
  trash?(file: DiagramArtifactFileLike, system: boolean): Promise<void>;
  delete?(file: DiagramArtifactFileLike, force?: boolean): Promise<void>;
  adapter?: {
    exists(path: string): Promise<boolean>;
    mkdir?(path: string): Promise<void>;
    read?(path: string): Promise<string>;
    write?(path: string, content: string): Promise<void>;
    remove?(path: string): Promise<void>;
  };
}

export interface DiagramArtifactRead {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface DiagramArtifactValidationContext extends DiagramArtifactRead {}

export type DiagramArtifactValidatorResult =
  | void
  | boolean
  | { ok: boolean; errors?: readonly string[] };

export type DiagramArtifactValidator = (
  artifact: DiagramArtifactValidationContext,
) => DiagramArtifactValidatorResult | Promise<DiagramArtifactValidatorResult>;

export type DiagramArtifactRollbackStatus =
  | "not_required"
  | "verified"
  | "failed";

export interface DiagramArtifactUpdateReceipt {
  version: 1;
  operation: "update";
  status: "committed" | "rolled_back" | "rollback_failed";
  path: string;
  beforeSha256: string;
  expectedAfterSha256: string;
  afterSha256: string | null;
  finalSha256: string;
  backupPath: string;
  backupSha256: string;
  bytesWritten: number;
  validationStatus: "passed" | "failed" | "not_run";
  rollbackStatus: DiagramArtifactRollbackStatus;
  rollbackSha256: string | null;
  error: { code: string; message: string } | null;
}

export interface DiagramArtifactCreateInput {
  path: string;
  content: string;
  validator: DiagramArtifactValidator;
}

export interface DiagramArtifactCreateReceipt {
  path: string;
  beforeSha256: null;
  expectedAfterSha256: string;
  afterSha256: string | null;
  finalSha256: string | null;
  bytesWritten: number;
  validationStatus: "passed" | "failed" | "not_run";
  rollbackStatus: DiagramArtifactRollbackStatus;
}

export interface DiagramArtifactCreateTransactionReceipt {
  version: 1;
  operation: "create_many";
  status: "committed" | "rolled_back" | "rollback_failed";
  artifacts: DiagramArtifactCreateReceipt[];
  rollbackStatus: DiagramArtifactRollbackStatus;
  rollbackOrder: string[];
  error: { code: string; message: string } | null;
}

export interface DiagramArtifactStoreOptions {
  maxBytes?: number;
  backupRoot?: string;
  now?: () => Date;
  onStage?: (stage: DiagramArtifactStoreStage) => void;
}

export type DiagramArtifactStoreStage =
  | "reading_current"
  | "creating_backup"
  | "backup_verified"
  | "checking_precondition"
  | "writing_candidate"
  | "verifying_readback"
  | "validating_persisted"
  | "committed"
  | "rolling_back";

export class DiagramArtifactStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DiagramArtifactStoreError";
  }
}

/**
 * Optimistic-concurrency and transaction boundary for native diagram files.
 * It deliberately owns no layout or format semantics; callers provide the
 * exact structural/render validator that must pass against persisted bytes.
 */
export class DiagramArtifactStore {
  private readonly maxBytes: number;
  private readonly backupRoot: string;
  private readonly now: () => Date;
  private readonly onStage: (stage: DiagramArtifactStoreStage) => void;

  constructor(
    private readonly vault: DiagramArtifactVaultLike,
    options: DiagramArtifactStoreOptions = {},
  ) {
    this.maxBytes = boundedPositiveInteger(
      options.maxBytes ?? DIAGRAM_ARTIFACT_MAX_BYTES,
      "diagram artifact byte limit",
      DIAGRAM_ARTIFACT_MAX_BYTES,
    );
    // Keep diagram backups in the plugin's existing, proven backup folder.
    // Obsidian can leave Vault.createFolder() unresolved for nested hidden
    // folders because those folders are not indexed as normal vault entries.
    this.backupRoot = validateInternalFolderPath(
      options.backupRoot ?? ".agent-backups",
    );
    this.now = options.now ?? (() => new Date());
    this.onStage = options.onStage ?? (() => undefined);
  }

  async read(pathInput: string): Promise<DiagramArtifactRead> {
    const path = validateDiagramArtifactPath(pathInput);
    const file = this.requireFile(path);
    const content = await this.vault.read(file);
    return await this.describe(path, content);
  }

  async update(input: {
    path: string;
    expectedSha256: string;
    content: string;
    validator: DiagramArtifactValidator;
  }): Promise<DiagramArtifactUpdateReceipt> {
    const path = validateDiagramArtifactPath(input.path);
    const expectedSha256 = requireSha256(input.expectedSha256, "expected diagram hash");
    const targetFile = this.requireFile(path);
    this.onStage("reading_current");
    const original = await this.describe(path, await this.vault.read(targetFile));
    if (original.sha256 !== expectedSha256) {
      throw new DiagramArtifactStoreError(
        "expected_hash_mismatch",
        `Diagram changed before backup: ${path}.`,
      );
    }
    const candidate = await this.describe(path, requireContent(input.content));
    this.onStage("creating_backup");
    const backup = await this.createVerifiedBackup(original);
    this.onStage("backup_verified");

    let beforeWrite: DiagramArtifactRead;
    try {
      // This is intentionally the final asynchronous read immediately before
      // modify. The write never relies on the earlier pre-backup observation.
      this.onStage("checking_precondition");
      beforeWrite = await this.describe(path, await this.vault.read(targetFile));
      if (beforeWrite.sha256 !== expectedSha256) {
        await this.removeCreatedPath(backup.path);
        throw new DiagramArtifactStoreError(
          "expected_hash_mismatch",
          `Diagram changed immediately before write: ${path}.`,
        );
      }
    } catch (error) {
      if (!(error instanceof DiagramArtifactStoreError && error.code === "expected_hash_mismatch")) {
        await this.removeCreatedPath(backup.path).catch(() => undefined);
      }
      throw error;
    }

    let after: DiagramArtifactRead | null = null;
    let validationStatus: DiagramArtifactUpdateReceipt["validationStatus"] = "not_run";
    let failure: { code: string; message: string } | null = null;
    try {
      this.onStage("writing_candidate");
      await this.vault.modify(targetFile, candidate.content);
      this.onStage("verifying_readback");
      after = await this.describe(path, await this.vault.read(targetFile));
      if (after.sha256 !== candidate.sha256) {
        throw new DiagramArtifactStoreError(
          "write_readback_mismatch",
          `Diagram readback hash changed after write: ${path}.`,
        );
      }
      this.onStage("validating_persisted");
      await runValidator(input.validator, after);
      validationStatus = "passed";
      this.onStage("committed");
      return {
        version: 1,
        operation: "update",
        status: "committed",
        path,
        beforeSha256: original.sha256,
        expectedAfterSha256: candidate.sha256,
        afterSha256: after.sha256,
        finalSha256: after.sha256,
        backupPath: backup.path,
        backupSha256: backup.sha256,
        bytesWritten: after.bytes,
        validationStatus,
        rollbackStatus: "not_required",
        rollbackSha256: null,
        error: null,
      };
    } catch (error) {
      validationStatus = isValidationError(error) ? "failed" : validationStatus;
      failure = errorDetails(error, "diagram_update_failed");
    }

    this.onStage("rolling_back");
    const rollback = await this.rollbackUpdate(targetFile, path, original);
    return {
      version: 1,
      operation: "update",
      status: rollback.status === "verified" ? "rolled_back" : "rollback_failed",
      path,
      beforeSha256: original.sha256,
      expectedAfterSha256: candidate.sha256,
      afterSha256: after?.sha256 ?? null,
      finalSha256: rollback.sha256 ?? after?.sha256 ?? original.sha256,
      backupPath: backup.path,
      backupSha256: backup.sha256,
      bytesWritten: candidate.bytes,
      validationStatus,
      rollbackStatus: rollback.status,
      rollbackSha256: rollback.sha256,
      error: rollback.error ?? failure,
    };
  }

  async createMany(
    inputs: readonly DiagramArtifactCreateInput[],
  ): Promise<DiagramArtifactCreateTransactionReceipt> {
    if (
      !Array.isArray(inputs) ||
      inputs.length < 1 ||
      inputs.length > DIAGRAM_ARTIFACT_TRANSACTION_MAX_FILES
    ) {
      throw new DiagramArtifactStoreError(
        "invalid_transaction",
        `Diagram create transaction requires 1-${DIAGRAM_ARTIFACT_TRANSACTION_MAX_FILES} artifacts.`,
      );
    }
    const prepared = await Promise.all(inputs.map(async (input) => {
      const path = validateDiagramArtifactPath(input.path);
      const described = await this.describe(path, requireContent(input.content));
      if (typeof input.validator !== "function") {
        throw new DiagramArtifactStoreError(
          "validator_required",
          `Diagram validator is required: ${path}.`,
        );
      }
      return { ...described, validator: input.validator };
    }));
    if (new Set(prepared.map((artifact) => artifact.path)).size !== prepared.length) {
      throw new DiagramArtifactStoreError(
        "duplicate_path",
        "Diagram create transaction contains duplicate paths.",
      );
    }
    for (const artifact of prepared) {
      if (this.lookup(artifact.path)) {
        throw new DiagramArtifactStoreError(
          "path_exists",
          `Diagram create transaction cannot overwrite: ${artifact.path}.`,
        );
      }
    }

    const receipts: DiagramArtifactCreateReceipt[] = prepared.map((artifact) => ({
      path: artifact.path,
      beforeSha256: null,
      expectedAfterSha256: artifact.sha256,
      afterSha256: null,
      finalSha256: null,
      bytesWritten: artifact.bytes,
      validationStatus: "not_run",
      rollbackStatus: "not_required",
    }));
    const created: string[] = [];
    let failure: { code: string; message: string } | null = null;

    for (let index = 0; index < prepared.length; index += 1) {
      const artifact = prepared[index];
      try {
        // Close the no-overwrite race immediately before vault.create. The
        // vault create operation must independently reject an existing path.
        if (this.lookup(artifact.path)) {
          throw new DiagramArtifactStoreError(
            "path_exists",
            `Diagram appeared immediately before create: ${artifact.path}.`,
          );
        }
        const createdFile = await this.resolveCreatedFile(
          artifact.path,
          await this.vault.create(artifact.path, artifact.content),
        );
        created.push(artifact.path);
        const readback = await this.describe(
          artifact.path,
          await this.vault.read(createdFile),
        );
        receipts[index].afterSha256 = readback.sha256;
        receipts[index].finalSha256 = readback.sha256;
        if (readback.sha256 !== artifact.sha256) {
          throw new DiagramArtifactStoreError(
            "create_readback_mismatch",
            `Created diagram failed exact hash readback: ${artifact.path}.`,
          );
        }
        await runValidator(artifact.validator, readback);
        receipts[index].validationStatus = "passed";
      } catch (error) {
        receipts[index].validationStatus = isValidationError(error)
          ? "failed"
          : receipts[index].validationStatus;
        failure = errorDetails(error, "diagram_create_failed");
        break;
      }
    }

    if (!failure) {
      return {
        version: 1,
        operation: "create_many",
        status: "committed",
        artifacts: receipts,
        rollbackStatus: "not_required",
        rollbackOrder: [],
        error: null,
      };
    }

    const rollbackOrder: string[] = [];
    let rollbackFailure: { code: string; message: string } | null = null;
    for (const path of [...created].reverse()) {
      rollbackOrder.push(path);
      const removed = await this.removeCreatedPath(path);
      const receipt = receipts.find((candidate) => candidate.path === path)!;
      receipt.rollbackStatus = removed.status;
      receipt.finalSha256 = removed.status === "verified" ? null : receipt.afterSha256;
      if (removed.status !== "verified" && !rollbackFailure) {
        rollbackFailure = removed.error;
      }
    }
    return {
      version: 1,
      operation: "create_many",
      status: rollbackFailure ? "rollback_failed" : "rolled_back",
      artifacts: receipts,
      rollbackStatus: rollbackFailure ? "failed" : "verified",
      rollbackOrder,
      error: rollbackFailure ?? failure,
    };
  }

  private async describe(path: string, content: string): Promise<DiagramArtifactRead> {
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > this.maxBytes) {
      throw new DiagramArtifactStoreError(
        "artifact_too_large",
        `Diagram artifact exceeds ${this.maxBytes} bytes: ${path}.`,
      );
    }
    return {
      path,
      content,
      bytes: bytes.byteLength,
      sha256: await sha256DiagramContent(content),
    };
  }

  private async createVerifiedBackup(
    original: DiagramArtifactRead,
  ): Promise<DiagramArtifactRead> {
    await this.ensureFolder(this.backupRoot);
    const timestamp = canonicalTimestamp(this.now());
    const extension = extensionOf(original.path);
    const basename = original.path.split("/").pop()!.slice(0, -extension.length);
    const safeBasename = basename.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 120) || "diagram";
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const suffix = attempt === 0 ? "" : `.${attempt}`;
      const path = `${this.backupRoot}/${safeBasename}.${timestamp}.${original.sha256.slice(7, 19)}${suffix}.backup${extension}`;
      if (await this.pathExists(path)) continue;
      if (this.vault.adapter?.write && this.vault.adapter.read) {
        try {
          await this.vault.adapter.write(path, original.content);
          const readback = await this.describe(
            path,
            await this.vault.adapter.read(path),
          );
          if (readback.sha256 !== original.sha256) {
            throw new DiagramArtifactStoreError(
              "backup_readback_mismatch",
              `Diagram backup failed exact hash readback: ${path}.`,
            );
          }
          return readback;
        } catch (error) {
          await this.removeCreatedPath(path).catch(() => undefined);
          if (isAlreadyExists(error) || await this.pathExists(path)) continue;
          throw error;
        }
      }
      let createdFile: DiagramArtifactFileLike;
      try {
        createdFile = await this.resolveCreatedFile(
          path,
          await this.vault.create(path, original.content),
        );
      } catch (error) {
        if (isAlreadyExists(error) || this.lookup(path)) continue;
        throw error;
      }
      try {
        const readback = await this.describe(
          path,
          await this.vault.read(createdFile),
        );
        if (readback.sha256 !== original.sha256) {
          throw new DiagramArtifactStoreError(
            "backup_readback_mismatch",
            `Diagram backup failed exact hash readback: ${path}.`,
          );
        }
        return readback;
      } catch (error) {
        await this.removeCreatedPath(path).catch(() => undefined);
        throw error;
      }
    }
    throw new DiagramArtifactStoreError(
      "backup_collision_limit",
      `Unable to allocate a collision-free diagram backup for ${original.path}.`,
    );
  }

  private async rollbackUpdate(
    file: DiagramArtifactFileLike,
    path: string,
    original: DiagramArtifactRead,
  ): Promise<{
    status: "verified" | "failed";
    sha256: string | null;
    error: { code: string; message: string } | null;
  }> {
    try {
      await this.vault.modify(file, original.content);
      const readback = await this.describe(path, await this.vault.read(file));
      if (readback.sha256 !== original.sha256) {
        throw new DiagramArtifactStoreError(
          "rollback_readback_mismatch",
          `Diagram rollback failed exact hash readback: ${path}.`,
        );
      }
      return { status: "verified", sha256: readback.sha256, error: null };
    } catch (error) {
      const details = errorDetails(error, "diagram_rollback_failed");
      const current = await this.read(path).catch(() => null);
      return { status: "failed", sha256: current?.sha256 ?? null, error: details };
    }
  }

  private async removeCreatedPath(path: string): Promise<{
    status: "verified" | "failed";
    error: { code: string; message: string } | null;
  }> {
    const initial = this.lookupFile(path);
    if (!initial && this.vault.adapter?.remove) {
      try {
        if (await this.vault.adapter.exists(path)) {
          await this.vault.adapter.remove(path);
        }
        if (!(await this.vault.adapter.exists(path))) {
          return { status: "verified", error: null };
        }
      } catch (error) {
        return {
          status: "failed",
          error: errorDetails(error, "diagram_create_rollback_failed"),
        };
      }
    }
    if (!initial) return { status: "verified", error: null };
    let lastError: unknown = null;
    if (this.vault.trash) {
      try {
        await this.vault.trash(initial, true);
      } catch (error) {
        lastError = error;
      }
      if (!this.lookup(path)) return { status: "verified", error: null };
    }
    const current = this.lookupFile(path);
    if (current && this.vault.delete) {
      try {
        await this.vault.delete(current, true);
      } catch (error) {
        lastError = error;
      }
      if (!this.lookup(path)) return { status: "verified", error: null };
    }
    return {
      status: "failed",
      error: errorDetails(
        lastError ?? new Error(`Diagram rollback could not remove ${path}.`),
        "diagram_create_rollback_failed",
      ),
    };
  }

  private async readInternal(path: string): Promise<DiagramArtifactRead> {
    const file = this.requireFile(path);
    return await this.describe(path, await this.vault.read(file));
  }

  private lookup(path: string): { path: string } | null {
    return this.vault.getAbstractFileByPath(path);
  }

  private async pathExists(path: string): Promise<boolean> {
    if (this.lookup(path)) return true;
    return await this.vault.adapter?.exists(path) ?? false;
  }

  private lookupFile(path: string): DiagramArtifactFileLike | null {
    const direct = this.vault.getFileByPath?.(path);
    if (direct) return direct;
    const entry = this.lookup(path);
    return entry && entry.path === path ? entry : null;
  }

  private requireFile(path: string): DiagramArtifactFileLike {
    const file = this.lookupFile(path);
    if (!file) {
      throw new DiagramArtifactStoreError(
        "artifact_not_found",
        `Diagram artifact does not exist: ${path}.`,
      );
    }
    return file;
  }

  private async resolveCreatedFile(
    path: string,
    returned: DiagramArtifactFileLike | null | undefined,
  ): Promise<DiagramArtifactFileLike> {
    if (returned && typeof returned.path === "string") return returned;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const indexed = this.lookupFile(path);
      if (indexed) return indexed;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new DiagramArtifactStoreError(
      "create_handle_missing",
      `Vault create did not expose a file handle for ${path}.`,
    );
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.vault.adapter?.mkdir && await this.vault.adapter.exists(current)) {
        continue;
      }
      if (this.vault.adapter?.mkdir && !this.lookup(current)) {
        try {
          await this.vault.adapter.mkdir(current);
        } catch (error) {
          if (!isAlreadyExists(error) && !(await this.vault.adapter.exists(current))) {
            throw error;
          }
        }
        continue;
      }
      const existing = this.lookup(current);
      if (existing) {
        const folder = this.vault.getFolderByPath?.(current);
        if (this.vault.getFolderByPath && !folder) {
          throw new DiagramArtifactStoreError(
            "backup_path_conflict",
            `Diagram backup folder conflicts with a file: ${current}.`,
          );
        }
        continue;
      }
      if (!this.vault.createFolder) {
        throw new DiagramArtifactStoreError(
          "folder_creation_unavailable",
          `Vault cannot create diagram backup folder: ${current}.`,
        );
      }
      try {
        await this.vault.createFolder(current);
      } catch (error) {
        if (!isAlreadyExists(error) && !this.lookup(current)) throw error;
      }
    }
  }
}

export function validateDiagramArtifactPath(pathInput: string): string {
  if (
    typeof pathInput !== "string" ||
    pathInput.length < 1 ||
    pathInput.length > 500 ||
    pathInput !== pathInput.trim() ||
    pathInput.startsWith("/") ||
    pathInput.includes("\\") ||
    /^[A-Za-z]:/u.test(pathInput) ||
    /[\0\r\n]/u.test(pathInput)
  ) {
    throw new DiagramArtifactStoreError(
      "unsafe_path",
      "Diagram paths must be normalized vault-relative paths.",
    );
  }
  const parts = pathInput.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0].toLowerCase() === ".obsidian"
  ) {
    throw new DiagramArtifactStoreError(
      "unsafe_path",
      "Diagram paths cannot traverse parents, empty segments, or Obsidian system data.",
    );
  }
  const extension = extensionOf(pathInput).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new DiagramArtifactStoreError(
      "unsupported_extension",
      "Diagram artifacts must use .canvas, .svg, or .md.",
    );
  }
  return pathInput;
}

export async function sha256DiagramContent(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new DiagramArtifactStoreError(
      "sha256_unavailable",
      "SHA-256 is unavailable in this runtime.",
    );
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function runValidator(
  validator: DiagramArtifactValidator,
  artifact: DiagramArtifactRead,
): Promise<void> {
  if (typeof validator !== "function") {
    throw new DiagramArtifactStoreError(
      "validator_required",
      `Diagram validator is required: ${artifact.path}.`,
    );
  }
  let result: DiagramArtifactValidatorResult;
  try {
    result = await validator({ ...artifact });
  } catch (error) {
    throw new DiagramArtifactStoreError(
      "validation_failed",
      `Diagram validator rejected ${artifact.path}: ${safeMessage(error)}.`,
    );
  }
  if (result === false || (isValidationResult(result) && result.ok !== true)) {
    const errors = isValidationResult(result) && Array.isArray(result.errors)
      ? result.errors.map(String).slice(0, 10).join("; ")
      : "validator returned failure";
    throw new DiagramArtifactStoreError(
      "validation_failed",
      `Diagram validator rejected ${artifact.path}: ${errors}.`,
    );
  }
}

function isValidationResult(
  value: DiagramArtifactValidatorResult,
): value is { ok: boolean; errors?: readonly string[] } {
  return Boolean(value && typeof value === "object" && "ok" in value);
}

function isValidationError(error: unknown): boolean {
  return error instanceof DiagramArtifactStoreError &&
    error.code === "validation_failed";
}

function validateInternalFolderPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 300 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    /[\0\r\n]/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new DiagramArtifactStoreError(
      "unsafe_backup_root",
      "Diagram backup root must be vault-relative and normalized.",
    );
  }
  return value.replace(/\/$/u, "");
}

function requireContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new DiagramArtifactStoreError(
      "invalid_content",
      "Diagram artifact content must be text.",
    );
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new DiagramArtifactStoreError(
      "invalid_hash",
      `${label} must be a lowercase SHA-256 fingerprint.`,
    );
  }
  return value;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index);
}

function boundedPositiveInteger(
  value: number,
  label: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DiagramArtifactStoreError(
      "invalid_limit",
      `${label} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function canonicalTimestamp(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new DiagramArtifactStoreError(
      "invalid_clock",
      "Diagram backup timestamp is invalid.",
    );
  }
  return new Date(milliseconds).toISOString().replace(/[:.]/gu, "-");
}

function errorDetails(
  error: unknown,
  fallbackCode: string,
): { code: string; message: string } {
  return {
    code: error instanceof DiagramArtifactStoreError
      ? error.code
      : fallbackCode,
    message: safeMessage(error),
  };
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\0\r\n]+/gu, " ").slice(0, 2_000);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST",
  ) || /already exists|file exists/iu.test(safeMessage(error));
}
