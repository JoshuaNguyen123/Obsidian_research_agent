import { createSessionBootstrapTokenLeaseV1 } from "@agentic-researcher/headless-runtime";
import type { BootstrapTokenLeaseV1 } from "@agentic-researcher/headless-runtime";
import { requireNodeModule } from "../../src/platform/nodeRequire";
import { COMPANION_RUNTIME_ASSETS_V1 } from "./runtimeAssets";

export interface CompanionServiceCommandResultV1 {
  ok: boolean;
  action?: string;
  platform: string;
  installed?: boolean;
  active?: boolean;
  artifactPath?: string | null;
}

export interface CompanionServiceControllerOptionsV1 {
  dataDir?: string;
  applicationDataRoot?: string;
  port?: number;
  pythonCommands?: Array<{ executable: string; args: string[] }>;
  timeoutMs?: number;
  runtimeAssets?: Readonly<Record<string, string>>;
}

export interface CompanionRuntimeMaterializationV1 {
  runtimeRoot: string;
  bundleHash: string;
  fileHashes: Record<string, string>;
}

export type CompanionRuntimeModeV1 = "materialize" | "attest";

export interface CompanionRuntimeAccessOptionsV1 {
  runtimeMode?: CompanionRuntimeModeV1;
}

/** Desktop-only command boundary for the bundled Python service manager. */
export class CompanionServiceControllerV1 {
  readonly baseUrl: string;
  readonly controlScriptPath: string;
  readonly dataDir: string;
  /** Pinned sibling used by the Code capability and the standalone worker. */
  readonly codeApplicationDataRoot: string;
  readonly runtimeRoot: string;
  readonly bundleHash: string;
  readonly port: number;
  private readonly pythonCommands: Array<{ executable: string; args: string[] }>;
  private readonly timeoutMs: number;
  private readonly runtimeAssets: Readonly<Record<string, string>>;
  private readonly fileHashes: Record<string, string>;
  private readonly applicationDataRoot: string;
  private nodeExecutable: string | null = null;

  constructor(options: CompanionServiceControllerOptionsV1) {
    const path = requireNodeModule<typeof import("path")>(
      "path",
      "companion_service_control",
    );
    const os = requireNodeModule<typeof import("os")>(
      "os",
      "companion_service_control",
    );
    const defaultRoot = path.resolve(defaultDataDir(path, os));
    this.applicationDataRoot = path.resolve(
      options.applicationDataRoot ?? defaultApplicationDataRoot(path, os),
    );
    this.dataDir = path.resolve(options.dataDir ?? defaultRoot);
    this.codeApplicationDataRoot = path.join(this.applicationDataRoot, "code");
    assertSafeApplicationDataPath(this.applicationDataRoot, this.dataDir, path);
    this.runtimeAssets = options.runtimeAssets ?? COMPANION_RUNTIME_ASSETS_V1;
    const crypto = requireNodeModule<typeof import("crypto")>(
      "crypto",
      "companion_service_control",
    );
    this.fileHashes = Object.fromEntries(
      Object.entries(this.runtimeAssets)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, content]) => [name, sha256(content, crypto)]),
    );
    this.bundleHash = sha256(JSON.stringify(this.fileHashes), crypto);
    this.runtimeRoot = path.join(
      this.dataDir,
      "runtime",
      `v1-${this.bundleHash.slice("sha256:".length, "sha256:".length + 16)}`,
    );
    this.controlScriptPath = path.join(this.runtimeRoot, "companion_control.py");
    this.port = clampInteger(options.port ?? 8765, 1, 65_535);
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.pythonCommands = options.pythonCommands ?? defaultPythonCommands(os.platform());
    this.timeoutMs = clampInteger(options.timeoutMs ?? 120_000, 1_000, 300_000);
  }

  async install(): Promise<CompanionServiceCommandResultV1> {
    return this.runJsonCommand("install");
  }

  async status(
    options: CompanionRuntimeAccessOptionsV1 = {},
  ): Promise<CompanionServiceCommandResultV1> {
    return this.runJsonCommand("status", [], options.runtimeMode ?? "materialize");
  }

  async remove(input: { removeBootstrapToken?: boolean } = {}): Promise<CompanionServiceCommandResultV1> {
    return this.runJsonCommand(
      "remove",
      input.removeBootstrapToken ? ["--remove-bootstrap-token"] : [],
    );
  }

  /**
   * Captures the keyring-backed bootstrap token through a private stdout pipe,
   * immediately moves it into a closure-backed lease, and zeroes all buffers.
   */
  async connectCredential(
    options: CompanionRuntimeAccessOptionsV1 = {},
  ): Promise<BootstrapTokenLeaseV1> {
    const output = await this.runProcess([
      this.controlScriptPath,
      "token",
      "--approved-data-root",
      this.applicationDataRoot,
      "--data-dir",
      this.dataDir,
    ], true, options.runtimeMode ?? "materialize");
    try {
      const token = output.toString("utf8");
      return createSessionBootstrapTokenLeaseV1(token, {
        source: "secure_store_lease",
        persistent: true,
      });
    } finally {
      output.fill(0);
    }
  }

  /** Atomically materialize and hash-readback the runtime embedded in main.js. */
  materializeRuntime(): CompanionRuntimeMaterializationV1 {
    const fs = requireNodeModule<typeof import("fs")>(
      "fs",
      "companion_service_control",
    );
    const path = requireNodeModule<typeof import("path")>(
      "path",
      "companion_service_control",
    );
    const crypto = requireNodeModule<typeof import("crypto")>(
      "crypto",
      "companion_service_control",
    );
    assertSafeApplicationDataPath(this.applicationDataRoot, this.dataDir, path);
    ensureDirectoryTreeSafely(this.applicationDataRoot, null, fs, path);
    revalidateApplicationDataBoundary(
      this.applicationDataRoot,
      this.dataDir,
      this.applicationDataRoot,
      fs,
      path,
    );
    ensureDirectoryTreeSafely(this.runtimeRoot, this.applicationDataRoot, fs, path);
    revalidateApplicationDataBoundary(
      this.applicationDataRoot,
      this.dataDir,
      this.runtimeRoot,
      fs,
      path,
    );
    const resolvedRoot = fs.realpathSync(this.runtimeRoot);
    for (const [relativePath, content] of Object.entries(this.runtimeAssets)) {
      if (
        !relativePath ||
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes("..")
      ) {
        throw new Error("Companion runtime contains an unsafe asset path.");
      }
      const destination = path.resolve(resolvedRoot, relativePath);
      if (!isWithin(resolvedRoot, destination, path)) {
        throw new Error("Companion runtime asset escaped its materialization root.");
      }
      ensureDirectoryTreeSafely(
        path.dirname(destination),
        this.applicationDataRoot,
        fs,
        path,
      );
      revalidateApplicationDataBoundary(
        this.applicationDataRoot,
        this.dataDir,
        destination,
        fs,
        path,
      );
      rejectSymlinkPath(resolvedRoot, destination, fs, path);
      const expected = this.fileHashes[relativePath];
      const existing = fs.existsSync(destination)
        ? sha256(fs.readFileSync(destination), crypto)
        : null;
      if (existing !== expected) {
        const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
        revalidateApplicationDataBoundary(
          this.applicationDataRoot,
          this.dataDir,
          temporary,
          fs,
          path,
        );
        fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
        if (sha256(fs.readFileSync(temporary), crypto) !== expected) {
          fs.rmSync(temporary, { force: true });
          throw new Error("Companion runtime asset writeback hash failed.");
        }
        revalidateApplicationDataBoundary(
          this.applicationDataRoot,
          this.dataDir,
          destination,
          fs,
          path,
        );
        fs.renameSync(temporary, destination);
      }
      if (sha256(fs.readFileSync(destination), crypto) !== expected) {
        throw new Error("Companion runtime asset readback hash failed.");
      }
    }
    return {
      runtimeRoot: resolvedRoot,
      bundleHash: this.bundleHash,
      fileHashes: { ...this.fileHashes },
    };
  }

  /**
   * Verify an already-installed embedded runtime without creating or repairing
   * files. Live proof uses this mode so stale runtime state is evidence, not
   * something the attestation command silently fixes.
   */
  attestMaterializedRuntime(): CompanionRuntimeMaterializationV1 {
    const fs = requireNodeModule<typeof import("fs")>(
      "fs",
      "companion_service_control",
    );
    const path = requireNodeModule<typeof import("path")>(
      "path",
      "companion_service_control",
    );
    const crypto = requireNodeModule<typeof import("crypto")>(
      "crypto",
      "companion_service_control",
    );
    assertSafeApplicationDataPath(this.applicationDataRoot, this.dataDir, path);
    if (!fs.existsSync(this.runtimeRoot)) {
      throw new Error("Companion runtime is not materialized.");
    }
    const runtimeStat = fs.lstatSync(this.runtimeRoot);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
      throw new Error("Companion runtime root is not a regular directory.");
    }
    revalidateApplicationDataBoundary(
      this.applicationDataRoot,
      this.dataDir,
      this.runtimeRoot,
      fs,
      path,
    );
    const resolvedRoot = fs.realpathSync(this.runtimeRoot);
    for (const relativePath of Object.keys(this.runtimeAssets)) {
      if (
        !relativePath ||
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes("..")
      ) {
        throw new Error("Companion runtime contains an unsafe asset path.");
      }
      const destination = path.resolve(resolvedRoot, relativePath);
      if (!isWithin(resolvedRoot, destination, path)) {
        throw new Error("Companion runtime asset escaped its materialization root.");
      }
      if (!fs.existsSync(destination)) {
        throw new Error("Companion runtime asset is missing: " + relativePath + ".");
      }
      revalidateApplicationDataBoundary(
        this.applicationDataRoot,
        this.dataDir,
        destination,
        fs,
        path,
      );
      rejectSymlinkPath(resolvedRoot, destination, fs, path);
      const assetStat = fs.lstatSync(destination);
      if (!assetStat.isFile() || assetStat.isSymbolicLink()) {
        throw new Error(
          "Companion runtime asset is not a regular file: " + relativePath + ".",
        );
      }
      if (sha256(fs.readFileSync(destination), crypto) !== this.fileHashes[relativePath]) {
        throw new Error(
          "Companion runtime asset hash mismatch: " + relativePath + ".",
        );
      }
    }
    return {
      runtimeRoot: resolvedRoot,
      bundleHash: this.bundleHash,
      fileHashes: { ...this.fileHashes },
    };
  }

  private async runJsonCommand(
    command: "install" | "status" | "remove",
    trailingArgs: string[] = [],
    runtimeMode: CompanionRuntimeModeV1 = "materialize",
  ): Promise<CompanionServiceCommandResultV1> {
    const nodeExecutable = await this.resolveNodeExecutable();
    const output = await this.runProcess([
      this.controlScriptPath,
      command,
      "--data-dir",
      this.dataDir,
      "--approved-data-root",
      this.applicationDataRoot,
      "--port",
      String(this.port),
      "--node-executable",
      nodeExecutable,
      ...trailingArgs,
    ], false, runtimeMode);
    try {
      const parsed = JSON.parse(output.toString("utf8")) as CompanionServiceCommandResultV1;
      if (!parsed || parsed.ok !== true || typeof parsed.platform !== "string") {
        throw new Error("Companion service helper returned an invalid response.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("Companion service helper returned invalid JSON.");
      }
      throw error;
    } finally {
      output.fill(0);
    }
  }

  private async resolveNodeExecutable(): Promise<string> {
    if (this.nodeExecutable) return this.nodeExecutable;
    const path = requireNodeModule<typeof import("path")>(
      "path",
      "companion_service_control",
    );
    const fs = requireNodeModule<typeof import("fs")>(
      "fs",
      "companion_service_control",
    );
    if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) {
      this.nodeExecutable = fs.realpathSync(process.execPath);
      return this.nodeExecutable;
    }
    const os = requireNodeModule<typeof import("os")>(
      "os",
      "companion_service_control",
    );
    const locator = os.platform() === "win32" ? "where.exe" : "which";
    const output = await spawnBounded({
      executable: locator,
      args: ["node"],
      timeoutMs: 10_000,
      secretOutput: false,
    });
    try {
      const candidate = output
        .toString("utf8")
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find(Boolean);
      if (!candidate || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) {
        throw new Error("A trusted Node.js executable is required for background continuation.");
      }
      this.nodeExecutable = fs.realpathSync(candidate);
      return this.nodeExecutable;
    } finally {
      output.fill(0);
    }
  }

  private async runProcess(
    args: string[],
    secretOutput = false,
    runtimeMode: CompanionRuntimeModeV1 = "materialize",
  ): Promise<Buffer> {
    const fs = requireNodeModule<typeof import("fs")>(
      "fs",
      "companion_service_control",
    );
    if (runtimeMode === "attest") {
      this.attestMaterializedRuntime();
    } else {
      this.materializeRuntime();
    }
    if (!fs.existsSync(this.controlScriptPath)) {
      throw new Error("The bundled companion control helper could not be materialized.");
    }
    const path = requireNodeModule<typeof import("path")>(
      "path",
      "companion_service_control",
    );
    revalidateApplicationDataBoundary(
      this.applicationDataRoot,
      this.dataDir,
      this.controlScriptPath,
      fs,
      path,
    );
    let lastMissingRuntime: Error | null = null;
    for (const candidate of this.pythonCommands) {
      try {
        return await spawnBounded({
          executable: candidate.executable,
          args: [...candidate.args, ...args],
          timeoutMs: this.timeoutMs,
          secretOutput,
        });
      } catch (error) {
        if (isMissingExecutable(error)) {
          lastMissingRuntime = error as Error;
          continue;
        }
        throw error;
      }
    }
    throw lastMissingRuntime ?? new Error("Python 3 is required for companion service control.");
  }
}

async function spawnBounded(input: {
  executable: string;
  args: string[];
  timeoutMs: number;
  secretOutput: boolean;
}): Promise<Buffer> {
  const { spawn } = requireNodeModule<typeof import("child_process")>(
    "child_process",
    "companion_service_control",
  );
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnvironment(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxBytes = 1_048_576;
    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      if (error) {
        stdout.forEach((chunk) => chunk.fill(0));
        stderr.forEach((chunk) => chunk.fill(0));
        reject(error);
      } else {
        const result = value ?? Buffer.alloc(0);
        stdout.forEach((chunk) => chunk.fill(0));
        stderr.forEach((chunk) => chunk.fill(0));
        resolve(result);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      stdoutBytes += copy.byteLength;
      if (stdoutBytes > maxBytes) {
        copy.fill(0);
        child.kill();
        finish(new Error("Companion service helper output exceeded 1 MiB."));
        return;
      }
      stdout.push(copy);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      stderrBytes += copy.byteLength;
      if (stderrBytes <= maxBytes) stderr.push(copy);
      else copy.fill(0);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        const detail = input.secretOutput
          ? ""
          : sanitizeProcessError(Buffer.concat(stderr).toString("utf8"));
        finish(
          new Error(
            `Companion service helper failed with exit code ${String(code)}${detail ? `: ${detail}` : "."}`,
          ),
        );
        return;
      }
      finish(null, Buffer.concat(stdout));
    });
    const timer = globalThis.setTimeout(() => {
      child.kill();
      finish(new Error("Companion service helper timed out."));
    }, input.timeoutMs);
  });
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_DATA_HOME",
    "LANG",
    "LC_ALL",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}

function defaultDataDir(
  path: typeof import("path"),
  os: typeof import("os"),
): string {
  if (os.platform() === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "AgenticResearcher",
      "companion",
    );
  }
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AgenticResearcher", "companion");
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "agentic-researcher",
    "companion",
  );
}

function defaultApplicationDataRoot(
  path: typeof import("path"),
  os: typeof import("os"),
): string {
  if (os.platform() === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "AgenticResearcher",
    );
  }
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "AgenticResearcher");
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "agentic-researcher",
  );
}

function defaultPythonCommands(platform: NodeJS.Platform) {
  return platform === "win32"
    ? [
        { executable: "py", args: ["-3"] },
        { executable: "python", args: [] },
      ]
    : [
        { executable: "python3", args: [] },
        { executable: "python", args: [] },
      ];
}

function isWithin(
  root: string,
  candidate: string,
  path: typeof import("path"),
): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rejectSymlinkPath(
  root: string,
  destination: string,
  fs: typeof import("fs"),
  path: typeof import("path"),
): void {
  let cursor = path.dirname(destination);
  while (isWithin(root, cursor, path) && cursor !== root) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Companion runtime materialization refuses symbolic-link parents.");
    }
    cursor = path.dirname(cursor);
  }
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error("Companion runtime materialization refuses symbolic-link assets.");
  }
}

function assertSafeApplicationDataPath(
  applicationDataRoot: string,
  dataDir: string,
  path: typeof import("path"),
): void {
  const fs = requireNodeModule<typeof import("fs")>(
    "fs",
    "companion_service_control",
  );
  if (
    applicationDataRoot === path.parse(applicationDataRoot).root ||
    dataDir === path.parse(dataDir).root ||
    !isWithin(applicationDataRoot, dataDir, path)
  ) {
    throw new Error("Companion data must remain inside the per-user application-data root.");
  }
  const segments = dataDir.split(/[\\/]/).map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment === ".obsidian" || segment.includes("vault"))) {
    throw new Error("Companion data cannot be materialized inside an Obsidian or vault path.");
  }
  let cursor = dataDir;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
    throw new Error("Companion data path refuses symbolic-link or reparse-point parents.");
  }
  let parent = cursor;
  while (isWithin(applicationDataRoot, parent, path) && parent !== applicationDataRoot) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
      throw new Error("Companion data path refuses symbolic-link or reparse-point parents.");
    }
    parent = path.dirname(parent);
  }
}

function revalidateApplicationDataBoundary(
  applicationDataRoot: string,
  dataDir: string,
  destination: string,
  fs: typeof import("fs"),
  path: typeof import("path"),
): void {
  assertSafeApplicationDataPath(applicationDataRoot, dataDir, path);
  if (destination !== applicationDataRoot && !isWithin(dataDir, destination, path)) {
    throw new Error("Companion operation escaped its approved data directory.");
  }
  for (const candidate of [applicationDataRoot, dataDir]) {
    if (!fs.existsSync(candidate)) continue;
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw new Error("Companion data path refuses symbolic-link or reparse-point parents.");
    }
  }
  let existing = fs.existsSync(destination) ? destination : path.dirname(destination);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let cursor = existing;
  while (isWithin(applicationDataRoot, cursor, path)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Companion data path refuses symbolic-link or reparse-point parents.");
    }
    if (cursor === applicationDataRoot) break;
    cursor = path.dirname(cursor);
  }
  if (fs.existsSync(applicationDataRoot) && fs.existsSync(existing)) {
    const canonicalRoot = fs.realpathSync(applicationDataRoot);
    const canonicalExisting = fs.realpathSync(existing);
    if (!isWithin(canonicalRoot, canonicalExisting, path)) {
      throw new Error("Companion data path escaped the canonical application-data root.");
    }
  }
}

function ensureDirectoryTreeSafely(
  target: string,
  approvedRoot: string | null,
  fs: typeof import("fs"),
  path: typeof import("path"),
): void {
  const resolvedTarget = path.resolve(target);
  const missing: string[] = [];
  let existing = resolvedTarget;
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  rejectReparseAncestors(existing, fs, path);
  let cursor = existing;
  for (const segment of missing) {
    rejectReparseAncestors(cursor, fs, path);
    if (approvedRoot && fs.existsSync(approvedRoot)) {
      const canonicalRoot = fs.realpathSync(approvedRoot);
      const canonicalParent = fs.realpathSync(cursor);
      if (!isWithin(canonicalRoot, canonicalParent, path)) {
        throw new Error("Companion directory creation escaped the canonical application-data root.");
      }
    }
    const next = path.join(cursor, segment);
    fs.mkdirSync(next);
    if (fs.lstatSync(next).isSymbolicLink()) {
      throw new Error("Companion directory creation encountered a reparse point.");
    }
    cursor = next;
  }
  rejectReparseAncestors(resolvedTarget, fs, path);
}

function rejectReparseAncestors(
  candidate: string,
  fs: typeof import("fs"),
  path: typeof import("path"),
): void {
  let cursor = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Companion data path refuses symbolic-link or reparse-point parents.");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function sha256(
  value: string | Buffer,
  crypto: typeof import("crypto"),
): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sanitizeProcessError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, 4_096);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
