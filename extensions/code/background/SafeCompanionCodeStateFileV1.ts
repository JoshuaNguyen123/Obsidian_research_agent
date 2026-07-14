import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Hardened companion-owned JSON file with a cross-process write lock. */
export class SafeCompanionCodeStateFileV1 {
  readonly applicationDataRoot: string;
  readonly filePath: string;
  private readonly maxBytes: number;

  constructor(input: {
    applicationDataRoot: string;
    directory: string;
    fileName: string;
    maxBytes?: number;
  }) {
    if (!path.isAbsolute(input.applicationDataRoot)) throw new Error("Companion Code state requires an absolute application-data root.");
    this.applicationDataRoot = path.resolve(input.applicationDataRoot);
    if (this.applicationDataRoot === path.parse(this.applicationDataRoot).root || hasVaultSegment(this.applicationDataRoot)) throw new Error("Companion Code state cannot use a filesystem root or vault path.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.directory) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/u.test(input.fileName)) throw new Error("Companion Code state path components are invalid.");
    this.filePath = path.join(this.applicationDataRoot, input.directory, input.fileName);
    this.maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async readJson<T>(): Promise<T | null> {
    await this.ensureDirectory();
    await this.assertBoundary(this.filePath, true);
    const stat = await fs.lstat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > this.maxBytes) throw new Error("Companion Code state file is linked, unsafe, empty, or oversized.");
    return JSON.parse(await fs.readFile(this.filePath, "utf8")) as T;
  }

  async writeJsonAtomic(value: unknown): Promise<void> {
    await this.ensureDirectory();
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.byteLength < 2 || bytes.byteLength > this.maxBytes) throw new Error("Companion Code state exceeds its size boundary.");
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await this.assertBoundary(temporary, true);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.assertBoundary(this.filePath, true);
      await fs.rename(temporary, this.filePath);
      await this.assertBoundary(this.filePath, false);
      const readback = await fs.readFile(this.filePath);
      if (!readback.equals(bytes)) throw new Error("Companion Code state failed exact byte readback.");
      const stat = await fs.lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Companion Code state readback became linked or unsafe.");
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lockPath = `${this.filePath}.lock`;
    await this.assertBoundary(lockPath, true);
    const lock = await fs.open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("Companion Code state is already owned by another process.");
      throw error;
    });
    try {
      return await operation();
    } finally {
      await lock.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async ensureDirectory(): Promise<void> {
    await assertNoLinkParents(this.applicationDataRoot);
    await fs.mkdir(this.applicationDataRoot, { recursive: true, mode: 0o700 });
    await this.assertBoundary(this.applicationDataRoot, false);
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.assertBoundary(directory, false);
  }

  private async assertBoundary(candidate: string, allowMissing: boolean): Promise<void> {
    const resolved = path.resolve(candidate);
    if (!isWithin(this.applicationDataRoot, resolved)) throw new Error("Companion Code state escaped application data.");
    let cursor = resolved;
    while (true) {
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (allowMissing && error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error("Companion Code state rejects symlinks, junctions, and reparse points.");
      if (stat?.isFile() && stat.nlink !== 1) throw new Error("Companion Code state rejects hard-linked files.");
      if (cursor === this.applicationDataRoot) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || !isWithin(this.applicationDataRoot, parent)) break;
      cursor = parent;
      allowMissing = true;
    }
  }
}

async function assertNoLinkParents(candidate: string): Promise<void> {
  let cursor = path.resolve(candidate);
  while (true) {
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error("Companion Code application-data parents cannot be reparse points.");
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasVaultSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((part) => part.toLowerCase() === ".obsidian" || /(?:^|[_ -])vault(?:$|[_ -])/iu.test(part));
}
