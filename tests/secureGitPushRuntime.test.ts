import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { InMemorySecretStoreV1 } from "../packages/headless-runtime/src/secretStoreV1";
import {
  InMemoryGitPushAttemptStoreV1,
  LoopbackEphemeralGitAskpassBrokerV1,
  SecureGitPushRuntimeErrorV1,
  SpawnVerifiedGitCommandRunnerV1,
} from "../src/integrations/github/SecureGitPushRuntime";
import type { GitPushAttemptRecordV1 } from "../src/integrations/github/VerifiedGitPushGateway";

const TOKEN = "github_pat_memory_only_1234567890";
const BINDING_FINGERPRINT = `sha256:${"a".repeat(64)}`;

test("spawn Git runner uses a fixed executable, shell-free clean environment, and bounded output", async () => {
  const runner = new SpawnVerifiedGitCommandRunnerV1({
    gitExecutable: process.execPath,
    timeoutMs: 5_000,
    maxOutputBytes: 4_096,
    baseEnvironment: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SystemRoot,
      COMSPEC: process.env.ComSpec,
      SECRET_PARENT_VALUE: "must-not-be-inherited",
      NODE_OPTIONS: "--inspect",
    },
  });
  const result = await runner.run({
    cwd: process.cwd(),
    args: [
      "-e",
      "process.stdout.write(JSON.stringify({keys:Object.keys(process.env).sort(),secret:process.env.SECRET_PARENT_VALUE,nodeOptions:process.env.NODE_OPTIONS}))",
    ],
    environment: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
    inheritEnvironment: false,
  });
  assert.equal(result.exitCode, 0);
  const observed = JSON.parse(result.stdout) as {
    keys: string[];
    secret?: string;
    nodeOptions?: string;
  };
  assert.equal(observed.secret, undefined);
  assert.equal(observed.nodeOptions, undefined);
  assert.ok(observed.keys.includes("GIT_CONFIG_NOSYSTEM"));
  assert.ok(observed.keys.includes("GIT_TERMINAL_PROMPT"));
  assert.ok(!observed.keys.includes("SECRET_PARENT_VALUE"));
  assert.ok(!observed.keys.includes("NODE_OPTIONS"));

  await assert.rejects(
    runner.run({
      cwd: process.cwd(),
      args: ["-e", "process.stdout.write('x'.repeat(8192))"],
      environment: { GIT_TERMINAL_PROMPT: "0" },
      inheritEnvironment: false,
    }),
    (error: unknown) =>
      error instanceof SecureGitPushRuntimeErrorV1 &&
      error.code === "git_output_limit_exceeded",
  );
});

test("spawn Git runner bounds runtime and supports cancellation", async () => {
  const runner = new SpawnVerifiedGitCommandRunnerV1({
    gitExecutable: process.execPath,
    timeoutMs: 100,
    maxOutputBytes: 1_024,
  });
  await assert.rejects(
    runner.run({
      cwd: process.cwd(),
      args: ["-e", "setInterval(()=>{},1000)"],
      environment: { GIT_TERMINAL_PROMPT: "0" },
      inheritEnvironment: false,
    }),
    (error: unknown) =>
      error instanceof SecureGitPushRuntimeErrorV1 &&
      error.code === "git_command_timeout",
  );

  const controller = new AbortController();
  const pending = new SpawnVerifiedGitCommandRunnerV1({
    gitExecutable: process.execPath,
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  }).run({
    cwd: process.cwd(),
    args: ["-e", "setInterval(()=>{},1000)"],
    environment: { GIT_TERMINAL_PROMPT: "0" },
    inheritEnvironment: false,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof SecureGitPushRuntimeErrorV1 &&
      error.code === "git_command_cancelled",
  );
});

test("ephemeral askpass uses one authenticated loopback request and removes all helper files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-git-push-test-"));
  try {
    const secretStore = new InMemorySecretStoreV1({
      randomBytes: deterministicBytes,
    });
    const credential = await secretStore.put({
      value: TOKEN,
      label: "GitHub test token",
      metadata: { provider: "github", credentialKind: "fine_grained_pat" },
    });
    const broker = new LoopbackEphemeralGitAskpassBrokerV1({
      secretStore,
      tempRoot: root,
      randomBytes: deterministicBytes,
      nodeExecutable: process.execPath,
      lifetimeMs: 10_000,
    });
    const runner = new SpawnVerifiedGitCommandRunnerV1({
      gitExecutable: process.execPath,
      timeoutMs: 5_000,
      maxOutputBytes: 8_192,
    });
    let helperPath = "";
    let helperDirectory = "";
    const result = await broker.withHandle({
      credentialReferenceId: credential.referenceId,
      repositoryBindingFingerprint: BINDING_FINGERPRINT,
      use: async (handle) => {
        helperPath = handle.executablePath;
        helperDirectory = path.dirname(helperPath);
        const names = await fs.readdir(helperDirectory);
        assert.deepEqual(names.sort(), [
          process.platform === "win32" ? "askpass.cmd" : "askpass.sh",
          "askpass-client.cjs",
        ].sort());
        const helperContents = (
          await Promise.all(
            names.map((name) => fs.readFile(path.join(helperDirectory, name), "utf8")),
          )
        ).join("\n");
        assert.doesNotMatch(helperContents, new RegExp(TOKEN, "u"));
        assert.match(helperContents, /x-access-token/u);
        assert.match(helperContents, /127\.0\.0\.1/u);

        const username = await invokeHelper(
          handle.executablePath,
          "Username for 'https://github.com':",
        );
        assert.equal(username.exitCode, 0, JSON.stringify(username));
        assert.equal(username.stdout.trim(), "x-access-token");
        assert.doesNotMatch(JSON.stringify(username), new RegExp(TOKEN, "u"));

        const environment = {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS_REQUIRE: "force",
          GIT_ASKPASS: handle.executablePath,
          GCM_INTERACTIVE: "Never",
          AGENTIC_RESEARCHER_ASKPASS_HANDLE: handle.id,
        };
        assert.doesNotMatch(JSON.stringify(environment), new RegExp(TOKEN, "u"));
        const commandResult = await runner.run({
          cwd: process.cwd(),
          args: ["-e", DIRECT_ASKPASS_CLIENT.replace(/\r?\n/gu, "")],
          environment,
          inheritEnvironment: false,
        });
        assert.equal(commandResult.exitCode, 0);
        assert.doesNotMatch(commandResult.stdout, new RegExp(TOKEN, "u"));
        assert.match(commandResult.stdout, /\[REDACTED\]/u);

        const secondPassword = await invokeHelper(
          handle.executablePath,
          "Password for 'https://x-access-token@github.com':",
        );
        assert.notEqual(secondPassword.exitCode, 0);
        assert.doesNotMatch(JSON.stringify(secondPassword), new RegExp(TOKEN, "u"));
        return { status: "verified", log: commandResult.stdout } as const;
      },
    });
    assert.equal(result.status, "verified");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN, "u"));
    await assert.rejects(fs.stat(helperPath), /ENOENT/u);
    await assert.rejects(fs.stat(helperDirectory), /ENOENT/u);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ephemeral askpass rejects token-shaped leakage from arguments and errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "secure-git-push-leak-test-"));
  try {
    const secretStore = new InMemorySecretStoreV1({ randomBytes: deterministicBytes });
    const credential = await secretStore.put({ value: TOKEN, label: "GitHub token" });
    const broker = new LoopbackEphemeralGitAskpassBrokerV1({
      secretStore,
      tempRoot: root,
      randomBytes: deterministicBytes,
      lifetimeMs: 5_000,
    });
    const runner = new SpawnVerifiedGitCommandRunnerV1({
      gitExecutable: process.execPath,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });
    await assert.rejects(
      broker.withHandle({
        credentialReferenceId: credential.referenceId,
        repositoryBindingFingerprint: BINDING_FINGERPRINT,
        use: (handle) => runner.run({
          cwd: process.cwd(),
          args: ["-e", `process.stdout.write(${JSON.stringify(TOKEN)})`],
          environment: {
            GIT_ASKPASS: handle.executablePath,
            AGENTIC_RESEARCHER_ASKPASS_HANDLE: handle.id,
          },
          inheritEnvironment: false,
        }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof SecureGitPushRuntimeErrorV1);
        assert.equal(error.code, "askpass_secret_rejected");
        assert.doesNotMatch(error.message, new RegExp(TOKEN, "u"));
        return true;
      },
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("in-memory Git push attempt store provides compare-and-swap semantics and clones records", async () => {
  const store = new InMemoryGitPushAttemptStoreV1();
  const first = attemptRecord(0, "dispatching");
  assert.equal(await store.save(first, null), true);
  assert.equal(await store.save(first, null), false);
  const loaded = await store.load(first.id);
  assert.ok(loaded);
  if (!loaded) return;
  loaded.status = "not_applied";
  assert.equal((await store.load(first.id))?.status, "dispatching");

  const replacement = attemptRecord(1, "verified");
  assert.equal(await store.save(replacement, 99), false);
  assert.equal(await store.save(replacement, 0), true);
  assert.equal((await store.load(first.id))?.revision, 1);
  assert.equal((await store.load(first.id))?.status, "verified");
});

const DIRECT_ASKPASS_CLIENT = String.raw`
const fs=require("node:fs");
const path=require("node:path");
const http=require("node:http");
const source=fs.readFileSync(path.join(path.dirname(process.env.GIT_ASKPASS),"askpass-client.cjs"),"utf8");
const port=Number(/port:(\d+)/.exec(source)[1]);
const nonce=/"X-Agentic-Askpass":"([a-f0-9]+)"/.exec(source)[1];
const prompt="Password for 'https://x-access-token@github.com':";
const body=JSON.stringify({prompt});
const request=http.request({host:"127.0.0.1",port,path:"/askpass",method:"POST",headers:{Host:"127.0.0.1:"+port,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"X-Agentic-Askpass":nonce}},response=>{const chunks=[];response.on("data",chunk=>chunks.push(chunk));response.on("end",()=>{process.stdout.write(Buffer.concat(chunks));process.exit(response.statusCode===200?0:5);});});
request.on("error",()=>process.exit(6));
request.end(body);
`;

async function invokeHelper(
  helperPath: string,
  prompt: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const executable = process.execPath;
  const args = [path.join(path.dirname(helperPath), "askpass-client.cjs"), prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: cleanHelperEnvironment(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function cleanHelperEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function deterministicBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 17 + 23) % 256);
}

function attemptRecord(
  revision: number,
  status: GitPushAttemptRecordV1["status"],
): GitPushAttemptRecordV1 {
  return {
    version: 1,
    id: "git-push-attempt-1",
    revision,
    handoffFingerprint: `sha256:${"b".repeat(64)}`,
    bindingFingerprint: BINDING_FINGERPRINT,
    branch: "codex/secure-push",
    remoteUrl: "https://github.com/acme/research-agent.git",
    beforeRemoteSha: null,
    expectedCommitSha: "c".repeat(40),
    status,
    dispatchCount: 1,
    reconciliationKey: "github-ref:acme/research-agent:refs/heads/codex/secure-push",
    startedAt: "2026-07-12T12:00:00.000Z",
    updatedAt: "2026-07-12T12:00:01.000Z",
    receipt: null,
    diagnostic: null,
  };
}
