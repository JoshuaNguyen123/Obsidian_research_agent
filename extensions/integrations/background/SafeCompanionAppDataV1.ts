import * as fs from "node:fs/promises";
import * as path from "node:path";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export class SafeCompanionAppDataErrorV1 extends Error {
  constructor(
    readonly code:
      | "unsafe_root"
      | "path_escape"
      | "link_or_reparse_rejected"
      | "hard_link_rejected"
      | "unsafe_file_type"
      | "atomic_write_failed",
    message: string,
  ) {
    super(message);
    this.name = "SafeCompanionAppDataErrorV1";
  }
}

export function validateCompanionAppDataRootV1(rootInput: string): string {
  if (!path.isAbsolute(rootInput)) {
    fail("unsafe_root", "Companion app-data storage requires an absolute directory.");
  }
  const root = path.resolve(rootInput);
  if (root === path.parse(root).root || hasVaultSegment(root)) {
    fail("unsafe_root", "Companion app-data storage cannot use a filesystem root, vault, or .obsidian directory.");
  }
  return root;
}

export async function ensureSafeCompanionDirectoryV1(
  applicationDataRoot: string,
  directory: string,
): Promise<void> {
  const root = validateCompanionAppDataRootV1(applicationDataRoot);
  const target = contained(root, directory);
  await ensureDirectoryChain(root);
  await ensureDirectoryChain(target);
  await assertSafeDirectory(root, root);
  await assertSafeDirectory(root, target);
  await assertRealContainment(root, target);
}

export async function readSafeCompanionFileV1(input: {
  applicationDataRoot: string;
  filePath: string;
  maximumBytes: number;
  allowMissing?: boolean;
}): Promise<Buffer | null> {
  const root = validateCompanionAppDataRootV1(input.applicationDataRoot);
  const filePath = contained(root, input.filePath);
  await assertSafeDirectory(root, path.dirname(filePath));
  await assertRealContainment(root, path.dirname(filePath));
  let stats;
  try {
    stats = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && input.allowMissing) return null;
    throw error;
  }
  assertRegularPrivateFile(stats, filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegularPrivateFile(opened, filePath);
    if (opened.size > BigInt(input.maximumBytes)) {
      fail("unsafe_file_type", "Companion app-data file exceeds its byte limit.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > input.maximumBytes) {
      fail("unsafe_file_type", "Companion app-data file exceeds its byte limit.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function writeSafeCompanionFileAtomicV1(input: {
  applicationDataRoot: string;
  directory: string;
  finalPath: string;
  bytes: Buffer;
  maximumBytes: number;
  temporaryToken: string;
}): Promise<Buffer> {
  const root = validateCompanionAppDataRootV1(input.applicationDataRoot);
  const directory = contained(root, input.directory);
  const finalPath = contained(directory, input.finalPath);
  if (input.bytes.byteLength > input.maximumBytes) {
    fail("unsafe_file_type", "Companion app-data write exceeds its byte limit.");
  }
  await ensureSafeCompanionDirectoryV1(root, directory);
  const token = input.temporaryToken.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 80) || "temp";
  const temporaryPath = contained(directory, `${finalPath}.${token}.tmp`);
  await assertAbsentOrSafeRegularFile(root, finalPath);
  await assertAbsent(root, temporaryPath);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(input.bytes);
    await handle.sync();
    const temporaryStats = await handle.stat({ bigint: true });
    assertRegularPrivateFile(temporaryStats, temporaryPath);
    await handle.close();
    handle = null;
    await assertSafeDirectory(root, directory);
    await assertRealContainment(root, directory);
    await fs.rename(temporaryPath, finalPath);
    await chmodPrivate(finalPath);
    await syncDirectory(directory);
    const readback = await readSafeCompanionFileV1({
      applicationDataRoot: root,
      filePath: finalPath,
      maximumBytes: input.maximumBytes,
    });
    if (!readback || !readback.equals(input.bytes)) {
      fail("atomic_write_failed", "Companion app-data atomic write failed exact readback verification.");
    }
    return readback;
  } catch (error) {
    if (error instanceof SafeCompanionAppDataErrorV1) throw error;
    return fail(
      "atomic_write_failed",
      error instanceof Error ? error.message : "Companion app-data atomic write failed.",
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function ensureDirectoryChain(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const relativeParts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    try {
      const stats = await fs.lstat(cursor, { bigint: true });
      assertDirectoryNoLinks(stats, cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(cursor, { mode: PRIVATE_DIRECTORY_MODE }).catch((mkdirError) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      });
      const created = await fs.lstat(cursor, { bigint: true });
      assertDirectoryNoLinks(created, cursor);
      await chmodPrivate(cursor, true);
    }
  }
}

async function assertSafeDirectory(root: string, target: string): Promise<void> {
  const containedTarget = contained(root, target);
  const relative = path.relative(path.parse(containedTarget).root, containedTarget);
  let cursor = path.parse(containedTarget).root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stats = await fs.lstat(cursor, { bigint: true });
    assertDirectoryNoLinks(stats, cursor);
  }
}

function assertDirectoryNoLinks(stats: import("node:fs").BigIntStats, target: string): void {
  if (stats.isSymbolicLink()) {
    fail("link_or_reparse_rejected", `Companion app-data directory link or reparse point is rejected: ${target}`);
  }
  if (!stats.isDirectory()) {
    fail("unsafe_file_type", `Companion app-data parent is not a directory: ${target}`);
  }
}

function assertRegularPrivateFile(
  stats: import("node:fs").BigIntStats,
  target: string,
): void {
  if (stats.isSymbolicLink()) {
    fail("link_or_reparse_rejected", `Companion app-data file link or reparse point is rejected: ${target}`);
  }
  if (!stats.isFile()) {
    fail("unsafe_file_type", `Companion app-data target is not a regular file: ${target}`);
  }
  if (stats.nlink !== BigInt(1)) {
    fail("hard_link_rejected", `Companion app-data hard-linked file is rejected: ${target}`);
  }
}

async function assertAbsentOrSafeRegularFile(root: string, filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath, { bigint: true });
    assertRegularPrivateFile(stats, filePath);
    await assertRealContainment(root, path.dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertAbsent(root: string, filePath: string): Promise<void> {
  contained(root, filePath);
  try {
    await fs.lstat(filePath);
    fail("atomic_write_failed", "Companion app-data temporary file already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function assertRealContainment(root: string, target: string): Promise<void> {
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);
  contained(realRoot, realTarget);
}

function contained(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return resolvedTarget;
  }
  fail("path_escape", "Companion app-data path escaped its configured root.");
}

async function chmodPrivate(target: string, directory = false): Promise<void> {
  await fs.chmod(target, directory ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE).catch((error) => {
    if (process.platform !== "win32") throw error;
  });
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function hasVaultSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) =>
    segment.toLowerCase() === ".obsidian" || /(?:^|[_-])vault(?:[_-]|$)/iu.test(segment));
}

function fail(code: SafeCompanionAppDataErrorV1["code"], message: string): never {
  throw new SafeCompanionAppDataErrorV1(code, message);
}
