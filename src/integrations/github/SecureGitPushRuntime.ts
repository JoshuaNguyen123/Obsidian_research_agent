import type { Server as HttpServer } from "node:http";

import type { SecretStoreV1 } from "../../../packages/core-api/src/secretStoreV1";
import { requireNodeModule } from "../../platform/nodeRequire";
import type {
  EphemeralGitAskpassBrokerV1,
  EphemeralGitAskpassHandleV1,
  GitPushAttemptRecordV1,
  GitPushAttemptStoreV1,
  VerifiedGitCommandResultV1,
  VerifiedGitCommandRunnerV1,
} from "./VerifiedGitPushGateway";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 65_536;
const MAX_ARGUMENT_LENGTH = 8_192;
const MAX_ENVIRONMENT_VALUE_LENGTH = 4_096;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 1_048_576;
const DEFAULT_ASKPASS_LIFETIME_MS = 60_000;
const MAX_ASKPASS_REQUEST_BYTES = 1_024;

const CALLER_ENVIRONMENT_KEYS = new Set([
  "AGENTIC_RESEARCHER_ASKPASS_HANDLE",
  "GCM_INTERACTIVE",
  "GIT_ASKPASS",
  "GIT_ASKPASS_REQUIRE",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
]);

const HOST_ENVIRONMENT_KEYS = new Set([
  "COMSPEC",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

/** Transient process-local redaction capabilities keyed by an opaque handle. */
const ACTIVE_ASKPASS_SECRETS = new Map<string, string>();

export class SecureGitPushRuntimeErrorV1 extends Error {
  constructor(
    readonly code:
      | "invalid_runtime_configuration"
      | "invalid_git_command"
      | "git_spawn_failed"
      | "git_command_timeout"
      | "git_command_cancelled"
      | "git_output_limit_exceeded"
      | "askpass_unavailable"
      | "askpass_expired"
      | "askpass_secret_rejected"
      | "askpass_cleanup_failed",
    message: string,
  ) {
    super(message);
    this.name = "SecureGitPushRuntimeErrorV1";
  }
}

export interface SpawnVerifiedGitCommandRunnerOptionsV1 {
  /** Immutable, absolute Git executable selected by the host. */
  gitExecutable: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Read-only source; only the closed host allowlist is copied. */
  baseEnvironment?: NodeJS.ProcessEnv;
}

/**
 * Production shell-free command adapter for VerifiedGitPushGatewayV1.
 * It never inherits the ambient process environment and never logs commands.
 */
export class SpawnVerifiedGitCommandRunnerV1 implements VerifiedGitCommandRunnerV1 {
  private readonly gitExecutable: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly baseEnvironment: Readonly<Record<string, string>>;

  constructor(options: SpawnVerifiedGitCommandRunnerOptionsV1) {
    this.gitExecutable = requireExecutableFile(
      options.gitExecutable,
      "Git executable",
    );
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      100,
      600_000,
      "Git command timeout",
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
      1_024,
      8_388_608,
      "Git output limit",
    );
    this.baseEnvironment = copyHostEnvironment(
      options.baseEnvironment ?? process.env,
    );
  }

  async run(input: {
    cwd: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
    inheritEnvironment: false;
    signal?: AbortSignal;
  }): Promise<VerifiedGitCommandResultV1> {
    if (input.inheritEnvironment !== false) {
      throw new SecureGitPushRuntimeErrorV1(
        "invalid_git_command",
        "Git commands must explicitly disable environment inheritance.",
      );
    }
    if (input.signal?.aborted) {
      throw new SecureGitPushRuntimeErrorV1(
        "git_command_cancelled",
        "Git command was cancelled before dispatch.",
      );
    }
    const cwd = requireAbsoluteDirectory(input.cwd, "Git working directory");
    const args = normalizeArguments(input.args);
    const environment = buildCleanEnvironment(
      this.baseEnvironment,
      input.environment,
    );
    const handleId = environment.AGENTIC_RESEARCHER_ASKPASS_HANDLE;
    const activeSecret = handleId ? ACTIVE_ASKPASS_SECRETS.get(handleId) : undefined;
    if (activeSecret) {
      const serializedDispatch = JSON.stringify({
        executable: this.gitExecutable,
        args,
        environment,
      });
      if (serializedDispatch.includes(activeSecret)) {
        throw new SecureGitPushRuntimeErrorV1(
          "askpass_secret_rejected",
          "Secret material was rejected before Git dispatch.",
        );
      }
    }

    const { spawn } = requireNodeModule<typeof import("node:child_process")>(
      "node:child_process",
      "secure Git publication",
    );
    return new Promise<VerifiedGitCommandResultV1>((resolve, reject) => {
      let settled = false;
      let termination:
        | "timeout"
        | "cancelled"
        | "output_limit"
        | null = null;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let totalBytes = 0;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.gitExecutable, args, {
          cwd,
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(
          new SecureGitPushRuntimeErrorV1(
            "git_spawn_failed",
            "Git command could not be started.",
          ),
        );
        return;
      }

      const finishError = (error: SecureGitPushRuntimeErrorV1) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const terminate = (reason: NonNullable<typeof termination>) => {
        if (termination) return;
        termination = reason;
        child.kill();
      };
      const collect = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.byteLength;
        if (totalBytes > this.maxOutputBytes) {
          terminate("output_limit");
          return;
        }
        if (target === "stdout") stdout = Buffer.concat([stdout, bytes]);
        else stderr = Buffer.concat([stderr, bytes]);
      };
      const abort = () => terminate("cancelled");
      const timeout = globalThis.setTimeout(
        () => terminate("timeout"),
        this.timeoutMs,
      );
      const cleanup = () => {
        globalThis.clearTimeout(timeout);
        input.signal?.removeEventListener("abort", abort);
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.once("error", () => {
        finishError(
          new SecureGitPushRuntimeErrorV1(
            "git_spawn_failed",
            "Git command failed before a verified exit status was available.",
          ),
        );
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (termination === "cancelled") {
          reject(
            new SecureGitPushRuntimeErrorV1(
              "git_command_cancelled",
              "Git command was cancelled.",
            ),
          );
          return;
        }
        if (termination === "timeout") {
          reject(
            new SecureGitPushRuntimeErrorV1(
              "git_command_timeout",
              "Git command exceeded its bounded runtime.",
            ),
          );
          return;
        }
        if (termination === "output_limit") {
          reject(
            new SecureGitPushRuntimeErrorV1(
              "git_output_limit_exceeded",
              "Git command output exceeded its bounded capture limit.",
            ),
          );
          return;
        }
        const redact = (value: Buffer) =>
          redactSecret(value.toString("utf8"), activeSecret);
        resolve({
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          stdout: redact(stdout),
          stderr: redact(stderr),
        });
      });
    });
  }
}

export interface LoopbackEphemeralGitAskpassBrokerOptionsV1 {
  secretStore: SecretStoreV1;
  /** Existing host-owned directory used only as a parent for random helpers. */
  tempRoot: string;
  lifetimeMs?: number;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
  nodeExecutable?: string;
}

/**
 * One-shot loopback askpass broker. The helper answers the public username
 * locally and makes exactly one authenticated IPC request for the password.
 */
export class LoopbackEphemeralGitAskpassBrokerV1
  implements EphemeralGitAskpassBrokerV1
{
  private readonly lifetimeMs: number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly nodeExecutable: string;
  private readonly tempRoot: string;

  constructor(private readonly options: LoopbackEphemeralGitAskpassBrokerOptionsV1) {
    this.lifetimeMs = boundedInteger(
      options.lifetimeMs ?? DEFAULT_ASKPASS_LIFETIME_MS,
      1_000,
      120_000,
      "Askpass lifetime",
    );
    this.randomBytes = options.randomBytes ?? ((length) =>
      requireNodeModule<typeof import("node:crypto")>(
        "node:crypto",
        "secure Git askpass",
      ).randomBytes(length));
    this.nodeExecutable = requireExecutableFile(
      options.nodeExecutable ?? process.execPath,
      "Node executable",
    );
    this.tempRoot = requireAbsoluteDirectory(options.tempRoot, "Askpass temp root", true);
  }

  async withHandle<TResult>(input: {
    credentialReferenceId: string;
    repositoryBindingFingerprint: string;
    signal?: AbortSignal;
    use(handle: EphemeralGitAskpassHandleV1): Promise<TResult>;
  }): Promise<TResult> {
    requireBoundedText(input.credentialReferenceId, "credential reference id", 512);
    requireSha256(input.repositoryBindingFingerprint);
    if (input.signal?.aborted) {
      throw new SecureGitPushRuntimeErrorV1(
        "git_command_cancelled",
        "Git credential use was cancelled before preparation.",
      );
    }
    const lease = await this.options.secretStore.lease(input.credentialReferenceId, {
      ttlSeconds: Math.max(1, Math.ceil(this.lifetimeMs / 1_000)),
    });
    try {
      return await lease.withSecret(async (secret) => {
        assertGitHubToken(secret);
        return this.withSecretHandle(secret, input);
      });
    } finally {
      lease.dispose();
    }
  }

  private async withSecretHandle<TResult>(
    secret: string,
    input: {
      credentialReferenceId: string;
      repositoryBindingFingerprint: string;
      signal?: AbortSignal;
      use(handle: EphemeralGitAskpassHandleV1): Promise<TResult>;
    },
  ): Promise<TResult> {
    const fs = requireNodeModule<typeof import("node:fs/promises")>(
      "node:fs/promises",
      "secure Git askpass",
    );
    const nonce = hex(this.randomBytes(32));
    const handleId = reserveAskpassHandle(secret, this.randomBytes);
    let server: HttpServer | null = null;
    let helperDirectory: string | null = null;
    let helperPath: string | null = null;
    let clientPath: string | null = null;
    let lifetime: ReturnType<typeof globalThis.setTimeout> | null = null;
    const abort = () => server?.close();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const endpoint = await startOneShotAskpassServer({
        nonce,
        secret,
        lifetimeMs: this.lifetimeMs,
      });
      server = endpoint.server;
      lifetime = globalThis.setTimeout(() => server?.close(), this.lifetimeMs);
      const path = nodePath();
      helperDirectory = await fs.mkdtemp(path.join(this.tempRoot, "github-askpass-"));
      await assertSafeHelperDirectory(this.tempRoot, helperDirectory);
      clientPath = path.join(helperDirectory, "askpass-client.cjs");
      helperPath = path.join(
        helperDirectory,
        process.platform === "win32" ? "askpass.cmd" : "askpass.sh",
      );
      await fs.writeFile(
        clientPath,
        askpassClientSource(endpoint.port, nonce),
        { encoding: "utf8", flag: "wx", mode: 0o700 },
      );
      await fs.writeFile(
        helperPath,
        askpassWrapperSource(this.nodeExecutable, clientPath),
        { encoding: "utf8", flag: "wx", mode: 0o700 },
      );
      await assertSafeHelperFile(helperDirectory, clientPath);
      await assertSafeHelperFile(helperDirectory, helperPath);
      const helperContents =
        (await fs.readFile(clientPath, "utf8")) +
        (await fs.readFile(helperPath, "utf8"));
      if (helperContents.includes(secret)) {
        throw new SecureGitPushRuntimeErrorV1(
          "askpass_secret_rejected",
          "Askpass helper unexpectedly contained secret material.",
        );
      }
      try {
        const result = await input.use(
          Object.freeze({ id: handleId, executablePath: helperPath }),
        );
        if (containsSecret(result, secret)) {
          throw new SecureGitPushRuntimeErrorV1(
            "askpass_secret_rejected",
            "Secret material was rejected from the Git publication result.",
          );
        }
        return result;
      } catch (error) {
        if (error instanceof SecureGitPushRuntimeErrorV1) throw error;
        throw new SecureGitPushRuntimeErrorV1(
          "askpass_unavailable",
          redactSecret(error instanceof Error ? error.message : String(error), secret),
        );
      }
    } finally {
      ACTIVE_ASKPASS_SECRETS.delete(handleId);
      if (lifetime) globalThis.clearTimeout(lifetime);
      input.signal?.removeEventListener("abort", abort);
      await closeServer(server);
      if (helperDirectory) {
        try {
          await removeHelperDirectory(
            this.tempRoot,
            helperDirectory,
            [helperPath, clientPath].filter((value): value is string => Boolean(value)),
          );
        } catch {
          throw new SecureGitPushRuntimeErrorV1(
            "askpass_cleanup_failed",
            "Ephemeral Git credential helper cleanup could not be verified.",
          );
        }
      }
    }
  }
}

/** Process-local CAS adapter for tests and foreground-only execution. */
export class InMemoryGitPushAttemptStoreV1 implements GitPushAttemptStoreV1 {
  private readonly records = new Map<string, GitPushAttemptRecordV1>();

  async load(id: string): Promise<GitPushAttemptRecordV1 | null> {
    requireBoundedText(id, "Git push attempt id", 512);
    const record = this.records.get(id);
    return record ? cloneJson(record) : null;
  }

  async save(
    record: GitPushAttemptRecordV1,
    expectedRevision: number | null,
  ): Promise<boolean> {
    const current = this.records.get(record.id);
    if (
      expectedRevision === null
        ? current !== undefined
        : current?.revision !== expectedRevision
    ) {
      return false;
    }
    this.records.set(record.id, cloneJson(record));
    return true;
  }
}

export interface GitPushAttemptPersistenceSnapshotV1 {
  version: 1;
  generation: number;
  attempts: GitPushAttemptRecordV1[];
}

/** Plugin-owned persistence can implement this without exposing plugin data here. */
export interface GitPushAttemptPersistencePortV1 {
  load(): Promise<GitPushAttemptPersistenceSnapshotV1>;
  save(
    snapshot: GitPushAttemptPersistenceSnapshotV1,
    expectedGeneration: number,
  ): Promise<boolean>;
}

async function startOneShotAskpassServer(input: {
  nonce: string;
  secret: string;
  lifetimeMs: number;
}): Promise<{ server: HttpServer; port: number }> {
  const http = requireNodeModule<typeof import("node:http")>(
    "node:http",
    "secure Git askpass",
  );
  let consumed = false;
  let expectedHost = "";
  const server = http.createServer((request, response) => {
    if (consumed) {
      respond(response, 410, "Askpass credential was already consumed.");
      return;
    }
    consumed = true;
    const fail = (status: number, message: string) => {
      respond(response, status, message);
      server.close();
    };
    if (
      request.method !== "POST" ||
      request.url !== "/askpass" ||
      request.headers.host !== expectedHost ||
      request.headers.origin !== undefined ||
      request.headers["x-agentic-askpass"] !== input.nonce ||
      request.headers["content-type"] !== "application/json" ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      fail(403, "Askpass request rejected.");
      return;
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 1 ||
      declaredLength > MAX_ASKPASS_REQUEST_BYTES
    ) {
      fail(413, "Askpass request rejected.");
      return;
    }
    let total = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_ASKPASS_REQUEST_BYTES) {
        request.destroy();
        server.close();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (total !== declaredLength || total > MAX_ASKPASS_REQUEST_BYTES) {
        fail(413, "Askpass request rejected.");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail(400, "Askpass request rejected.");
        return;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !isGitHubPasswordPrompt((parsed as { prompt?: unknown }).prompt)
      ) {
        fail(403, "Askpass prompt rejected.");
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(input.secret);
      server.close();
    });
    request.on("error", () => server.close());
  });
  server.maxConnections = 1;
  server.requestTimeout = input.lifetimeMs;
  server.headersTimeout = Math.min(input.lifetimeMs, 5_000);
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(
      new SecureGitPushRuntimeErrorV1(
        "askpass_unavailable",
        "Ephemeral Git credential broker could not bind loopback.",
      ),
    );
    server.once("error", fail);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off("error", fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    await closeServer(server);
    throw new SecureGitPushRuntimeErrorV1(
      "askpass_unavailable",
      "Ephemeral Git credential broker did not bind IPv4 loopback.",
    );
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  return { server, port: address.port };
}

function askpassClientSource(port: number, nonce: string): string {
  return `"use strict";\nconst http=require("node:http");\nconst prompt=String(process.argv[2]||"");\nconst username=/^Username for ['\"]?https:\\/\\/(?:[^@/'\"]+@)?github\\.com(?=[:/'\"]|$)/i;\nconst password=/^Password for ['\"]?https:\\/\\/(?:[^@/'\"]+@)?github\\.com(?=[:/'\"]|$)/i;\nif(username.test(prompt)){process.stdout.write("x-access-token\\n");process.exit(0);}\nif(!password.test(prompt)){process.exit(2);}\nconst body=JSON.stringify({prompt});\nconst request=http.request({host:"${LOOPBACK_HOST}",port:${port},path:"/askpass",method:"POST",headers:{Host:"${LOOPBACK_HOST}:${port}","Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"X-Agentic-Askpass":"${nonce}"},timeout:5000},response=>{const chunks=[];let total=0;response.on("data",chunk=>{total+=chunk.length;if(total>8192){request.destroy();return;}chunks.push(chunk);});response.on("end",()=>{if(response.statusCode!==200){process.exit(3);return;}process.stdout.write(Buffer.concat(chunks));});});\nrequest.on("timeout",()=>request.destroy());\nrequest.on("error",()=>process.exit(4));\nrequest.end(body);\n`;
}

function askpassWrapperSource(nodeExecutable: string, clientPath: string): string {
  if (process.platform === "win32") {
    return `@echo off\r\n"${escapeCmdQuoted(nodeExecutable)}" "${escapeCmdQuoted(clientPath)}" "%~1"\r\n`;
  }
  return `#!/bin/sh\nexec ${quotePosix(nodeExecutable)} ${quotePosix(clientPath)} "$@"\n`;
}

function buildCleanEnvironment(
  base: Readonly<Record<string, string>>,
  supplied: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(supplied)) {
    if (!CALLER_ENVIRONMENT_KEYS.has(key)) {
      throw new SecureGitPushRuntimeErrorV1(
        "invalid_git_command",
        `Git environment key is not allowlisted: ${key}`,
      );
    }
    output[key] = requireBoundedText(
      value,
      `Git environment ${key}`,
      MAX_ENVIRONMENT_VALUE_LENGTH,
    );
  }
  if (output.GIT_ASKPASS) {
    output.GIT_ASKPASS = requireAbsoluteFilePath(output.GIT_ASKPASS, "Git askpass helper");
  }
  return Object.freeze(output);
}

function copyHostEnvironment(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!value || !HOST_ENVIRONMENT_KEYS.has(key.toUpperCase())) continue;
    output[key] = requireBoundedText(value, `Host environment ${key}`, 32_768);
  }
  return Object.freeze(output);
}

function normalizeArguments(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ARGUMENTS) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_git_command",
      "Git argument count is outside the closed runtime bounds.",
    );
  }
  let bytes = 0;
  const output = values.map((value) => {
    const normalized = requireBoundedText(value, "Git argument", MAX_ARGUMENT_LENGTH, true);
    bytes += Buffer.byteLength(normalized);
    return normalized;
  });
  if (bytes > MAX_ARGUMENT_BYTES) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_git_command",
      "Git arguments exceeded the closed runtime byte limit.",
    );
  }
  return output;
}

function requireAbsoluteDirectory(
  value: string,
  label: string,
  rejectSymlink = false,
): string {
  const fs = requireNodeModule<typeof import("node:fs")>(
    "node:fs",
    "secure Git publication",
  );
  const normalized = requireAbsoluteFilePath(value, label);
  let stat: import("node:fs").Stats;
  try {
    stat = fs.lstatSync(normalized);
  } catch {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      `${label} is unavailable.`,
    );
  }
  if (!stat.isDirectory() || (rejectSymlink && stat.isSymbolicLink())) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      `${label} must be a real directory.`,
    );
  }
  if (rejectSymlink) {
    const real = fs.realpathSync.native(normalized);
    if (!sameHostPath(real, normalized)) {
      throw new SecureGitPushRuntimeErrorV1(
        "invalid_runtime_configuration",
        `${label} must not traverse a link or reparse alias.`,
      );
    }
  }
  return normalized;
}

function requireAbsoluteFilePath(value: string, label: string): string {
  const path = nodePath();
  const normalized = requireBoundedText(value, label, 2_048);
  if (!path.isAbsolute(normalized) && !path.win32.isAbsolute(normalized)) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      `${label} must be an absolute host path.`,
    );
  }
  return normalized;
}

function requireExecutableFile(value: string, label: string): string {
  const normalized = requireAbsoluteFilePath(value, label);
  const fs = requireNodeModule<typeof import("node:fs")>(
    "node:fs",
    "secure Git publication",
  );
  try {
    if (!fs.statSync(normalized).isFile()) throw new Error("not a file");
  } catch {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      `${label} is unavailable.`,
    );
  }
  return normalized;
}

async function assertSafeHelperDirectory(root: string, directory: string): Promise<void> {
  const fs = requireNodeModule<typeof import("node:fs/promises")>(
    "node:fs/promises",
    "secure Git askpass",
  );
  const [rootReal, directoryReal, stat] = await Promise.all([
    fs.realpath(root),
    fs.realpath(directory),
    fs.lstat(directory),
  ]);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isInside(rootReal, directoryReal)
  ) {
    throw new SecureGitPushRuntimeErrorV1(
      "askpass_unavailable",
      "Ephemeral Git helper directory failed containment verification.",
    );
  }
}

async function assertSafeHelperFile(root: string, file: string): Promise<void> {
  const fs = requireNodeModule<typeof import("node:fs/promises")>(
    "node:fs/promises",
    "secure Git askpass",
  );
  const [rootReal, fileReal, stat] = await Promise.all([
    fs.realpath(root),
    fs.realpath(file),
    fs.lstat(file),
  ]);
  if (stat.isSymbolicLink() || !stat.isFile() || !isInside(rootReal, fileReal)) {
    throw new SecureGitPushRuntimeErrorV1(
      "askpass_unavailable",
      "Ephemeral Git helper file failed containment verification.",
    );
  }
}

async function removeHelperDirectory(
  root: string,
  directory: string,
  files: string[],
): Promise<void> {
  const path = nodePath();
  const fs = requireNodeModule<typeof import("node:fs/promises")>(
    "node:fs/promises",
    "secure Git askpass",
  );
  const rootReal = await fs.realpath(root);
  const directoryReal = await fs.realpath(directory);
  if (!isInside(rootReal, directoryReal)) throw new Error("Unsafe helper cleanup target.");
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!isInside(directoryReal, resolved)) throw new Error("Unsafe helper file cleanup target.");
    await fs.rm(resolved, { force: true });
  }
  await fs.rmdir(directoryReal);
}

async function closeServer(server: HttpServer | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as HttpServer & { closeAllConnections?: () => void }).closeAllConnections?.();
  });
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

function isGitHubPasswordPrompt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 1_024 &&
    !/[\0\r\n]/u.test(value) &&
    /^Password for ['"]?https:\/\/(?:[^@/'"]+@)?github\.com(?=[:/'"]|$)/iu.test(value)
  );
}

function assertGitHubToken(value: string): void {
  if (!/^[\x21-\x7e]{1,4096}$/u.test(value)) {
    throw new SecureGitPushRuntimeErrorV1(
      "askpass_secret_rejected",
      "GitHub credential did not match the bounded token contract.",
    );
  }
}

function requireSha256(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      "Repository binding fingerprint is invalid.",
    );
  }
}

function requireBoundedText(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length < 1) ||
    value.length > max ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      `${label} is invalid.`,
    );
  }
  return value;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SecureGitPushRuntimeErrorV1(
      "invalid_runtime_configuration",
      `${label} is outside the supported range.`,
    );
  }
  return value;
}

function redactSecret(value: string, secret: string | undefined): string {
  if (!secret) return value;
  return value.split(secret).join("[REDACTED]");
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  try {
    return JSON.stringify(value)?.includes(secret) ?? false;
  } catch {
    return false;
  }
}

function reserveAskpassHandle(
  secret: string,
  randomBytes: (length: number) => Uint8Array,
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `askpass_${hex(randomBytes(18))}`;
    if (ACTIVE_ASKPASS_SECRETS.has(id)) continue;
    ACTIVE_ASKPASS_SECRETS.set(id, secret);
    return id;
  }
  throw new SecureGitPushRuntimeErrorV1(
    "askpass_unavailable",
    "A unique ephemeral Git credential handle could not be allocated.",
  );
}

function isInside(root: string, candidate: string): boolean {
  const path = nodePath();
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameHostPath(left: string, right: string): boolean {
  const path = nodePath();
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function nodePath(): typeof import("node:path") {
  return requireNodeModule<typeof import("node:path")>(
    "node:path",
    "secure Git publication",
  );
}

function escapeCmdQuoted(value: string): string {
  if (/[\r\n\0%!"]/u.test(value)) {
    throw new SecureGitPushRuntimeErrorV1(
      "askpass_unavailable",
      "Windows askpass helper path contains unsupported characters.",
    );
  }
  return value;
}

function quotePosix(value: string): string {
  if (/[\r\n\0]/u.test(value)) {
    throw new SecureGitPushRuntimeErrorV1(
      "askpass_unavailable",
      "Askpass helper path contains unsupported characters.",
    );
  }
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
