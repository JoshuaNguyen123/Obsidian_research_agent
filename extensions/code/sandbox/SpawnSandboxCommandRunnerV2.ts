import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";

import type {
  SandboxCommandRunnerV2,
  SandboxHostCommandSpecV2,
  SandboxRunnerResultV2,
  SandboxStagedFileBytesV2,
} from "./SandboxManager";

export interface SandboxSpawnOptionsV2 {
  shell: false;
  windowsHide: true;
  stdio: ["pipe", "pipe", "pipe"];
  env: NodeJS.ProcessEnv;
}

export interface SandboxSpawnReadableV2 {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
}

export interface SandboxSpawnWritableV2 {
  end(data?: Uint8Array): void;
  once?(event: "error", listener: (error: Error) => void): this;
}

export interface SandboxSpawnChildV2 {
  stdin: SandboxSpawnWritableV2;
  stdout: SandboxSpawnReadableV2;
  stderr: SandboxSpawnReadableV2;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SandboxSpawnAdapterV2 {
  spawn(
    executable: string,
    args: readonly string[],
    options: SandboxSpawnOptionsV2,
  ): SandboxSpawnChildV2;
}

export interface SpawnSandboxCommandRunnerOptionsV2 {
  spawnAdapter?: SandboxSpawnAdapterV2;
  hostEnvironment?: NodeJS.ProcessEnv;
}

interface StagingBundleV1 {
  version: 1;
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
    contentBase64: string;
  }>;
  manifestFingerprint: string;
}

const SPEC_KEYS = [
  "version",
  "provider",
  "purpose",
  "executable",
  "args",
  "shell",
  "cwd",
  "env",
  "timeoutMs",
  "stdinMode",
  "stdoutMode",
] as const;
const HOST_ENV_ALLOWLIST = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
]);
const MAX_PROCESS_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_STDERR_BYTES = 1024 * 1024;
const MAX_COMMAND_STREAM_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/**
 * Production process adapter for fixed sandbox-provider specs only. It never
 * accepts a repository command directly and has no host execution fallback.
 */
export class SpawnSandboxCommandRunnerV2 implements SandboxCommandRunnerV2 {
  private readonly spawnAdapter: SandboxSpawnAdapterV2;
  private readonly hostEnvironment: NodeJS.ProcessEnv;

  constructor(options: SpawnSandboxCommandRunnerOptionsV2 = {}) {
    this.spawnAdapter = options.spawnAdapter ?? nodeSpawnAdapter();
    this.hostEnvironment = options.hostEnvironment ?? process.env;
  }

  async run(
    rawSpec: SandboxHostCommandSpecV2,
    input: {
      stagedFiles?: readonly SandboxStagedFileBytesV2[];
      signal?: AbortSignal;
    } = {},
  ): Promise<SandboxRunnerResultV2> {
    const spec = validateFixedProviderSpec(rawSpec);
    const stdin = buildStdin(spec, input.stagedFiles);
    const env = cleanEnvironment(this.hostEnvironment, spec.env);
    let result: SandboxRunnerResultV2;
    try {
      result = await spawnBounded(
        this.spawnAdapter,
        spec,
        env,
        stdin,
        input.signal,
      );
    } finally {
      stdin?.fill(0);
    }
    if (spec.purpose === "boundary_probe" || result.exitCode !== 0) {
      return result;
    }
    return parseArtifactBundle(result.stdout, result.stderr);
  }
}

export class SandboxSpawnRunnerV2Error extends Error {
  constructor(
    readonly code:
      | "invalid_provider_spec"
      | "unsupported_staging"
      | "output_limit_exceeded"
      | "provider_timeout"
      | "provider_aborted"
      | "provider_spawn_failed"
      | "invalid_artifact_bundle",
    message: string,
  ) {
    super(message);
    this.name = "SandboxSpawnRunnerV2Error";
  }
}

function nodeSpawnAdapter(): SandboxSpawnAdapterV2 {
  return {
    spawn(executable, args, options) {
      return nodeSpawn(executable, [...args], options) as unknown as SandboxSpawnChildV2;
    },
  };
}

function validateFixedProviderSpec(
  value: SandboxHostCommandSpecV2,
): SandboxHostCommandSpecV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidSpec("Sandbox provider spec must be an object.");
  }
  if (
    Object.keys(value as object).sort().join("\0") !==
    [...SPEC_KEYS].sort().join("\0")
  ) {
    invalidSpec("Sandbox provider spec does not match the fixed command contract.");
  }
  if (
    value.version !== 1 ||
    value.shell !== false ||
    value.cwd !== null ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1_000 ||
    value.timeoutMs > 1_800_000 ||
    !Array.isArray(value.args) ||
    value.args.length < 1 ||
    value.args.length > 256 ||
    value.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > 1_024 ||
        /[\0\r\n]/.test(argument),
    )
  ) {
    invalidSpec("Sandbox provider spec contains unsafe process fields.");
  }
  const expectedExecutable = {
    docker: "docker",
    podman: "podman",
    wsl2: "wsl.exe",
    bubblewrap: "bwrap",
  }[value.provider];
  if (!expectedExecutable || basename(value.executable).toLowerCase() !== expectedExecutable) {
    invalidSpec("Sandbox provider executable is not fixed for its provider.");
  }
  if (
    (value.purpose === "boundary_probe" &&
      (value.stdinMode !== "none" || value.stdoutMode !== "boundary_probe_json")) ||
    (value.purpose === "execute" &&
      (value.stdinMode !== "verified_staging_bundle" ||
        value.stdoutMode !== "artifact_bundle"))
  ) {
    invalidSpec("Sandbox provider stream protocol does not match its purpose.");
  }
  if (Object.keys(value.env).length !== 0) {
    invalidSpec("Sandbox provider processes cannot inherit action environment values.");
  }
  if (
    value.args.some((argument, index) =>
      /(?:docker\.sock|podman\.sock|\/var\/run)/i.test(argument) ||
      (argument === "/" && value.args[index - 1] !== "--remount-ro"),
    ) ||
    value.args.some((argument) =>
      ["--privileged", "--mount", "--volume", "-v", "--host", "-H"].includes(
        argument,
      ),
    )
  ) {
    invalidSpec("Sandbox provider spec attempted a root, host, or container-socket mount.");
  }
  if (value.provider === "docker" || value.provider === "podman") {
    requireSequence(value.args, ["run", "--rm"]);
    requireArgument(value.args, "--read-only");
    requireSequence(value.args, ["--user", "65532:65532"]);
    requireSequence(value.args, ["--cap-drop", "ALL"]);
    requireSequence(value.args, ["--security-opt", "no-new-privileges"]);
    requireArgument(value.args, "--pids-limit");
    requireArgument(value.args, "--memory");
    requireArgument(value.args, "--cpus");
    requireSequence(value.args, [
      "--entrypoint",
      "/opt/agentic/sandbox-entrypoint",
    ]);
    const network = value.args[value.args.indexOf("--network") + 1];
    if (!new Set(["none", "bridge"]).has(network)) {
      invalidSpec("OCI sandbox network mode is invalid.");
    }
    if (!value.args.some((argument) => /@sha256:[0-9a-f]{64}$/.test(argument))) {
      invalidSpec("OCI sandbox image is not digest pinned.");
    }
  } else {
    requireArgument(value.args, "--unshare-all");
    requireSequence(value.args, ["--ro-bind"]);
    requireArgument(value.args, "--die-with-parent");
    requireArgument(value.args, "--new-session");
    requireSequence(value.args, ["--remount-ro", "/"]);
    if (value.purpose === "execute") {
      requireArgument(value.args, "--cpu-count");
      requireArgument(value.args, "--memory-mb");
      requireArgument(value.args, "--pid-limit");
      requireArgument(value.args, "--timeout-ms");
    }
    if (value.provider === "wsl2") {
      requireArgument(value.args, "--distribution");
      requireSequence(value.args, ["--user", "agentic"]);
      requireSequence(value.args, ["--exec", "/usr/bin/bwrap"]);
    }
  }
  return value;
}

function buildStdin(
  spec: SandboxHostCommandSpecV2,
  stagedFiles: readonly SandboxStagedFileBytesV2[] | undefined,
): Buffer | null {
  if (spec.stdinMode === "none") {
    if (stagedFiles && stagedFiles.length > 0) {
      throw new SandboxSpawnRunnerV2Error(
        "unsupported_staging",
        "Boundary probes cannot accept staged repository bytes.",
      );
    }
    return null;
  }
  if (!stagedFiles || stagedFiles.length < 1 || stagedFiles.length > 100) {
    throw new SandboxSpawnRunnerV2Error(
      "unsupported_staging",
      "verified_staging_bundle requires 1-100 hash-verifiable files.",
    );
  }
  let total = 0;
  const files = stagedFiles
    .map((file) => {
      const path = safeRelativePath(file.path);
      if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 2_000_000) {
        unsupportedStaging(`Staged file is invalid or exceeds 2 MB: ${path}.`);
      }
      total += file.bytes.byteLength;
      return {
        path,
        sha256: sha256Bytes(file.bytes),
        bytes: file.bytes.byteLength,
        contentBase64: Buffer.from(file.bytes).toString("base64"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (total > 10_000_000 || new Set(files.map((file) => file.path)).size !== files.length) {
    unsupportedStaging("Staging bundle exceeds 10 MB or contains duplicate paths.");
  }
  const core = { version: 1 as const, files };
  const bundle: StagingBundleV1 = {
    ...core,
    manifestFingerprint: sha256Canonical(
      files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    ),
  };
  const encoded = Buffer.from(JSON.stringify(bundle), "utf8");
  if (encoded.byteLength > MAX_BUNDLE_BYTES) {
    encoded.fill(0);
    unsupportedStaging("Encoded staging bundle exceeds 16 MiB.");
  }
  return encoded;
}

async function spawnBounded(
  adapter: SandboxSpawnAdapterV2,
  spec: SandboxHostCommandSpecV2,
  env: NodeJS.ProcessEnv,
  stdin: Buffer | null,
  signal?: AbortSignal,
): Promise<SandboxRunnerResultV2> {
  if (signal?.aborted) {
    throw new SandboxSpawnRunnerV2Error(
      "provider_aborted",
      "Sandbox provider launch was aborted before spawn.",
    );
  }
  return new Promise<SandboxRunnerResultV2>((resolve, reject) => {
    let child: SandboxSpawnChildV2;
    try {
      child = adapter.spawn(spec.executable, spec.args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      reject(
        new SandboxSpawnRunnerV2Error(
          "provider_spawn_failed",
          `Unable to start fixed sandbox provider: ${safeDiagnostic(error)}.`,
        ),
      );
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (
      error: Error | null,
      result?: SandboxRunnerResultV2,
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        stdout.forEach((chunk) => chunk.fill(0));
        stderr.forEach((chunk) => chunk.fill(0));
        reject(error);
      }
      else resolve(result!);
    };
    const exceed = (stream: "stdout" | "stderr") => {
      child.kill("SIGKILL");
      finish(
        new SandboxSpawnRunnerV2Error(
          "output_limit_exceeded",
          `Sandbox provider ${stream} exceeded its fixed byte limit.`,
        ),
      );
    };
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.byteLength;
      if (stdoutBytes > MAX_PROCESS_STDOUT_BYTES) {
        bytes.fill(0);
        exceed("stdout");
      } else {
        stdout.push(bytes);
      }
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.byteLength;
      if (stderrBytes > MAX_PROCESS_STDERR_BYTES) {
        bytes.fill(0);
        exceed("stderr");
      } else {
        stderr.push(bytes);
      }
    });
    child.once("error", (error) => {
      finish(
        new SandboxSpawnRunnerV2Error(
          "provider_spawn_failed",
          `Sandbox provider process failed: ${safeDiagnostic(error)}.`,
        ),
      );
    });
    child.once("close", (code, closeSignal) => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const stdoutText = stdoutBuffer.toString("utf8");
      const stderrText = stderrBuffer.toString("utf8");
      stdout.forEach((chunk) => chunk.fill(0));
      stderr.forEach((chunk) => chunk.fill(0));
      finish(null, {
        exitCode: Number.isSafeInteger(code) && code! >= 0 ? code! : 255,
        stdout: stdoutText,
        stderr: closeSignal
          ? `${stderrText}\nprovider_signal=${closeSignal}`.trim()
          : stderrText,
      });
      stdoutBuffer.fill(0);
      stderrBuffer.fill(0);
    });
    const abort = () => {
      child.kill("SIGKILL");
      finish(
        new SandboxSpawnRunnerV2Error(
          "provider_aborted",
          "Sandbox provider process was aborted.",
        ),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new SandboxSpawnRunnerV2Error(
          "provider_timeout",
          "Sandbox provider process exceeded its fixed timeout.",
        ),
      );
    }, spec.timeoutMs);
    child.stdin.once?.("error", (error) => {
      finish(
        new SandboxSpawnRunnerV2Error(
          "unsupported_staging",
          `Sandbox staging pipe failed: ${safeDiagnostic(error)}.`,
        ),
      );
    });
    child.stdin.end(stdin ?? undefined);
  });
}

function parseArtifactBundle(
  stdout: string,
  providerStderr: string,
): SandboxRunnerResultV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SandboxSpawnRunnerV2Error(
      "invalid_artifact_bundle",
      "Sandbox runtime does not implement artifact_bundle protocol v1.",
    );
  }
  const record = exactRecord(
    parsed,
    ["version", "exitCode", "stdoutBase64", "stderrBase64", "artifacts"],
    "artifact bundle",
  );
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.exitCode) ||
    (record.exitCode as number) < 0 ||
    (record.exitCode as number) > 255
  ) {
    invalidBundle("Artifact bundle exit code is invalid.");
  }
  const commandStdout = decodeBase64(
    record.stdoutBase64,
    "command stdout",
    MAX_COMMAND_STREAM_BYTES,
  );
  const commandStderr = decodeBase64(
    record.stderrBase64,
    "command stderr",
    MAX_COMMAND_STREAM_BYTES,
  );
  if (!Array.isArray(record.artifacts) || record.artifacts.length > 100) {
    invalidBundle("Artifact bundle contains too many artifacts.");
  }
  const artifacts: Record<string, Uint8Array> = {};
  let total = 0;
  for (const rawArtifact of record.artifacts as unknown[]) {
    const artifact = exactRecord(
      rawArtifact,
      ["path", "sha256", "bytes", "contentBase64"],
      "artifact",
    );
    const path = safeRelativePath(artifact.path);
    if (Object.prototype.hasOwnProperty.call(artifacts, path)) {
      invalidBundle("Artifact bundle contains duplicate paths.");
    }
    const bytes = decodeBase64(
      artifact.contentBase64,
      `artifact ${path}`,
      MAX_ARTIFACT_BYTES,
    );
    total += bytes.byteLength;
    if (
      artifact.bytes !== bytes.byteLength ||
      artifact.sha256 !== sha256Bytes(bytes)
    ) {
      invalidBundle(`Artifact hash or size mismatch: ${path}.`);
    }
    artifacts[path] = bytes;
  }
  if (total > MAX_ARTIFACT_BYTES) {
    invalidBundle("Artifact bundle exceeds 10 MiB.");
  }
  const providerDiagnostic = safeDiagnostic(providerStderr);
  return {
    exitCode: record.exitCode as number,
    stdout: commandStdout.toString("utf8"),
    stderr: [commandStderr.toString("utf8"), providerDiagnostic]
      .filter(Boolean)
      .join("\n"),
    artifacts,
  };
}

function decodeBase64(
  value: unknown,
  label: string,
  maximumBytes: number,
): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximumBytes / 3) * 4 + 4) {
    invalidBundle(`${label} is not bounded base64.`);
  }
  const decoded = Buffer.from(value as string, "base64");
  if (
    decoded.byteLength > maximumBytes ||
    decoded.toString("base64") !== value
  ) {
    decoded.fill(0);
    invalidBundle(`${label} is not canonical base64.`);
  }
  return decoded;
}

function cleanEnvironment(
  host: NodeJS.ProcessEnv,
  action: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (HOST_ENV_ALLOWLIST.has(key) && value && !containsCredential(`${key}=${value}`)) {
      output[key] = value;
    }
  }
  if (Object.keys(action).length !== 0) invalidSpec("Sandbox provider process environment must be host-only and clean.");
  return output;
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) {
    unsupportedStaging("Sandbox bundle path is invalid.");
  }
  const path = (value as string).replace(/\/$/, "");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path === ".git" ||
    path.startsWith(".git/") ||
    /[\0\r\n]/.test(path)
  ) {
    unsupportedStaging("Sandbox bundle paths must be safe repository-relative non-Git paths.");
  }
  return path;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidBundle(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")
  ) {
    invalidBundle(`${label} does not match its closed protocol.`);
  }
  return record;
}

function requireArgument(args: readonly string[], value: string): void {
  if (!args.includes(value)) invalidSpec(`Sandbox provider spec lacks ${value}.`);
}

function requireSequence(args: readonly string[], expected: readonly string[]): void {
  const found = args.some((_, index) =>
    expected.every((value, offset) => args[index + offset] === value),
  );
  if (!found) invalidSpec(`Sandbox provider spec lacks required sequence ${expected.join(" ")}.`);
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function containsCredential(value: string): boolean {
  return /(?:token|secret|password|authorization|cookie|credential|api[_-]?key)/i.test(
    value,
  );
}

function safeDiagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /(?:token|secret|password|authorization|cookie|credential|api[_-]?key)\s*[=:]\s*\S+/gi,
      "credential=[REDACTED]",
    )
    .slice(0, 1_000);
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      unsupportedStaging("Staging bundle contains an unsafe number.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    unsupportedStaging("Staging bundle contains an unsupported value.");
  }
  return `{${Object.keys(value as object)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(",")}}`;
}

function invalidSpec(message: string): never {
  throw new SandboxSpawnRunnerV2Error("invalid_provider_spec", message);
}

function unsupportedStaging(message: string): never {
  throw new SandboxSpawnRunnerV2Error("unsupported_staging", message);
}

function invalidBundle(message: string): never {
  throw new SandboxSpawnRunnerV2Error("invalid_artifact_bundle", message);
}
