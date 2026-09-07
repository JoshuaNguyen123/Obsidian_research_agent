import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import {
  PROVIDER_EXIT_SIGNATURE_RETRY_DELAYS_MS_V2,
  SandboxSpawnRunnerV2Error,
  SpawnSandboxCommandRunnerV2,
  isProviderExitSignatureV2,
  type SandboxSpawnAdapterV2,
  type SandboxSpawnChildV2,
} from "../extensions/code/sandbox/SpawnSandboxCommandRunnerV2";
import {
  buildSandboxProbeCommandV2,
  sandboxExecutionFailedBlockerV2,
  type SandboxProviderConfigV2,
} from "../extensions/code/sandbox/SandboxManager";

/**
 * Provider exit SIGNATURES at the spawn boundary.
 *
 * Reliability cohort 11 (2026-09-07, compound-linear-github#004):
 * `code_validate_full` failed twice, eleven seconds apart, with "Sandbox
 * result exit code is invalid." The sandbox entrypoint clamps every command
 * status to 0..255 and the runner clamps null or negative close codes to 255,
 * so the only way past both is the provider binary exiting with a code above
 * 255: on Windows, wsl.exe reports its own failures as 32-bit codes. That is
 * a launch-level provider failure, not a command result. It is retried on a
 * short ladder and, if it persists, surfaced with its signature so the next
 * loss of this shape is attributable from retained telemetry.
 */

const PROBE = JSON.stringify({
  version: 1,
  uid: 65532,
  networkBlocked: true,
  rootReadOnly: true,
  hostRootAbsent: true,
  containerSocketAbsent: true,
  runtimeReadOnly: true,
  runtimeDigest: `sha256:${"f".repeat(64)}`,
  stagingIsolated: true,
  resourceLimitsEnforced: true,
});

const WSL_TORN_DOWN = 0xffffffff;
const WSL_ELEMENT_NOT_FOUND = 0x80070490;

test("a provider exit above 255 is retried on the ladder and a later launch's answer is returned", async () => {
  const adapter = scriptedAdapter([
    { exitCode: WSL_TORN_DOWN, stderr: "The Windows Subsystem for Linux instance has terminated." },
    { exitCode: WSL_ELEMENT_NOT_FOUND, stderr: "Wsl/Service/CreateInstance/E_FAIL" },
    { exitCode: 0, stdout: PROBE },
  ]);
  const runner = new SpawnSandboxCommandRunnerV2({
    spawnAdapter: adapter,
    hostEnvironment: { PATH: "C:\\Program Files\\Docker" },
    providerRetryDelaysMs: [0, 0, 0],
  });
  const result = await runner.run(buildSandboxProbeCommandV2(dockerProvider()));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, PROBE);
  assert.equal(adapter.launches, 3, "two signature exits, then the answer");
});

test("a provider that keeps exiting with a signature surfaces provider_exit_signature with the code and the launch count", async () => {
  const adapter = scriptedAdapter(
    Array.from({ length: 8 }, () => ({ exitCode: WSL_TORN_DOWN, stderr: "instance terminated" })),
  );
  const runner = new SpawnSandboxCommandRunnerV2({
    spawnAdapter: adapter,
    hostEnvironment: {},
    providerRetryDelaysMs: [0, 0, 0],
  });
  await assert.rejects(
    runner.run(buildSandboxProbeCommandV2(dockerProvider())),
    (error: unknown) => {
      assert.ok(error instanceof SandboxSpawnRunnerV2Error);
      assert.equal(error.code, "provider_exit_signature");
      assert.equal(error.exitCode, WSL_TORN_DOWN);
      assert.equal(error.launches, 4, "the ladder allows three relaunches");
      assert.match(error.message, /0xffffffff/u);
      assert.match(error.message, /4 launch/u);
      return true;
    },
  );
  assert.equal(adapter.launches, 4, "ladder length plus the first launch");
});

test("an ordinary non-zero command status is returned at once and never relaunched", async () => {
  const adapter = scriptedAdapter([{ exitCode: 1, stderr: "assertion failed" }]);
  const runner = new SpawnSandboxCommandRunnerV2({
    spawnAdapter: adapter,
    hostEnvironment: {},
    providerRetryDelaysMs: [0, 0, 0],
  });
  const result = await runner.run(buildSandboxProbeCommandV2(dockerProvider()));
  assert.equal(result.exitCode, 1);
  assert.equal(adapter.launches, 1);

  // The predicate is exactly "above 255": 255 is the clamp for a killed or
  // negative close, still a command-side status; anything larger is not.
  assert.equal(isProviderExitSignatureV2(0), false);
  assert.equal(isProviderExitSignatureV2(124), false);
  assert.equal(isProviderExitSignatureV2(255), false);
  assert.equal(isProviderExitSignatureV2(256), true);
  assert.equal(isProviderExitSignatureV2(WSL_ELEMENT_NOT_FOUND), true);
  assert.equal(isProviderExitSignatureV2(WSL_TORN_DOWN), true);
  assert.equal(isProviderExitSignatureV2(-1), false);
  assert.equal(isProviderExitSignatureV2(Number.NaN), false);
});

test("a caller abort during the relaunch wait is an abort, not a signature, and stops the ladder", async () => {
  const adapter = scriptedAdapter(
    Array.from({ length: 4 }, () => ({ exitCode: WSL_TORN_DOWN, stderr: "instance terminated" })),
  );
  const runner = new SpawnSandboxCommandRunnerV2({
    spawnAdapter: adapter,
    hostEnvironment: {},
    providerRetryDelaysMs: [60_000],
  });
  const controller = new AbortController();
  const pending = runner.run(buildSandboxProbeCommandV2(dockerProvider()), { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof SandboxSpawnRunnerV2Error);
    assert.equal(error.code, "provider_aborted");
    return true;
  });
  assert.equal(adapter.launches, 1, "aborted while waiting, before the second launch");
});

test("the default ladder is short enough for a fast validation budget and long enough to outlast a WSL relaunch", () => {
  const total = PROVIDER_EXIT_SIGNATURE_RETRY_DELAYS_MS_V2.reduce((sum, ms) => sum + ms, 0);
  assert.ok(PROVIDER_EXIT_SIGNATURE_RETRY_DELAYS_MS_V2.length >= 2, "more than one relaunch");
  assert.ok(total >= 10_000, "cohort 11 saw the same signature eleven seconds apart");
  assert.ok(total <= 20_000, "the fast validation command has a 60 s budget");
  for (const ms of PROVIDER_EXIT_SIGNATURE_RETRY_DELAYS_MS_V2) assert.ok(Number.isSafeInteger(ms) && ms > 0);
});

test("the manager's execution blocker carries the provider signature and nothing else from the error", () => {
  const leak = "C:/Users/joshb/OneDrive/vault/Quarterly Salary Review.md token=sk-live-9f2a41c7";
  const signature = sandboxExecutionFailedBlockerV2(
    new SandboxSpawnRunnerV2Error(
      "provider_exit_signature",
      `Sandbox provider process exited with signature on ${leak}`,
      { exitCode: WSL_ELEMENT_NOT_FOUND, launches: 4 },
    ),
  );
  assert.equal(signature.code, "sandbox_execution_failed");
  assert.match(signature.message, /0x80070490/u);
  assert.match(signature.message, /4 launch/u);
  assert.equal(signature.message.includes("C:/Users"), false);
  assert.equal(signature.message.includes("sk-live"), false);
  assert.equal(signature.message.includes("Quarterly"), false);

  // POSITIVE PROOF the signature text is doing work: a plain provider error
  // gets the fixed notice and no signature.
  const plain = sandboxExecutionFailedBlockerV2(
    new SandboxSpawnRunnerV2Error("provider_spawn_failed", `Unable to start ${leak}`),
  );
  assert.equal(plain.code, "sandbox_execution_failed");
  assert.equal(plain.message.includes("signature"), false);
  assert.equal(plain.message.includes("C:/Users"), false);

  const staging = sandboxExecutionFailedBlockerV2(
    new SandboxSpawnRunnerV2Error("unsupported_staging", "pipe closed"),
  );
  assert.equal(staging.code, "sandbox_staging_transport_unsupported");
});

test("a boundary probe whose provider exits with a signature is unavailable, never a verdict of fail", async () => {
  const { SandboxManagerV2 } = await import("../extensions/code/sandbox/SandboxManager");
  const manager = new SandboxManagerV2({
    runner: {
      async run() {
        throw new SandboxSpawnRunnerV2Error(
          "provider_exit_signature",
          "Sandbox provider process exited with signature 0xffffffff on 4 launch(es)",
          { exitCode: WSL_TORN_DOWN, launches: 4 },
        );
      },
    },
    providers: [dockerProvider()],
    now: () => new Date("2026-09-07T17:19:45.000Z"),
  });
  const status = await manager.probeProviders();
  assert.equal(status.executionAvailable, false);
  const docker = status.providers.find((provider) => provider.provider === "docker");
  assert.ok(docker, "the docker provider is reported");
  assert.equal(docker.state, "unavailable", "a host condition, not a boundary verdict");
  assert.notEqual(docker.state, "rejected");
});

/** Children that end with a scripted exit code; the last script repeats. */
function scriptedAdapter(
  script: readonly { exitCode: number; stdout?: string; stderr?: string }[],
): SandboxSpawnAdapterV2 & { launches: number } {
  const adapter = {
    launches: 0,
    spawn(): SandboxSpawnChildV2 {
      const step = script[Math.min(adapter.launches, script.length - 1)]!;
      adapter.launches += 1;
      return new ScriptedChild(step.exitCode, step.stdout ?? "", step.stderr ?? "") as unknown as SandboxSpawnChildV2;
    },
  };
  return adapter;
}

class ScriptedChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;

  constructor(
    private readonly exitCode: number,
    private readonly out: string,
    private readonly err: string,
  ) {
    super();
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => callback(),
    });
    this.stdin.once("finish", () => {
      queueMicrotask(() => {
        if (this.killed) return;
        this.stdout.end(this.out);
        this.stderr.end(this.err);
        this.emit("close", this.exitCode, null);
      });
    });
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
}

function dockerProvider(): SandboxProviderConfigV2 {
  return {
    version: 1,
    kind: "docker",
    executable: "docker",
    priority: 1,
    runtimeReference: "ghcr.io/openai/agentic-sandbox",
    runtimeDigest: `sha256:${"f".repeat(64)}`,
    wslDistribution: null,
    runtimeRoot: null,
  };
}
