import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SandboxManagerV2,
  buildSandboxProbeCommandV2,
  type SandboxCommandRunnerV2,
  type SandboxHostCommandSpecV2,
  type SandboxProviderConfigV2,
  type SandboxRunnerResultV2,
} from "../extensions/code/sandbox/SandboxManager";

const PROBE_DIGEST = `sha256:${"f".repeat(64)}`;
const VERIFIED_PROBE = {
  version: 1,
  uid: 65532,
  networkBlocked: true,
  rootReadOnly: true,
  hostRootAbsent: true,
  containerSocketAbsent: true,
  runtimeReadOnly: true,
  runtimeDigest: PROBE_DIGEST,
  stagingIsolated: true,
  resourceLimitsEnforced: true,
};

const PLATFORM_PROVIDER = {
  win32: "wsl2",
  darwin: "podman",
  linux: "bubblewrap",
} as const;

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

export type SupportedSandboxCiPlatform = keyof typeof PLATFORM_PROVIDER;
export type SandboxCiProvider =
  (typeof PLATFORM_PROVIDER)[SupportedSandboxCiPlatform];
export type SandboxBoundaryCiMode = "deterministic" | "live";

export function resolveSandboxBoundaryCiMode(
  env: NodeJS.ProcessEnv = process.env,
): SandboxBoundaryCiMode {
  const value = env.AGENTIC_SANDBOX_CI_LIVE?.trim();
  if (!value || value === "0") return "deterministic";
  if (value === "1") return "live";
  throw new Error("AGENTIC_SANDBOX_CI_LIVE must be exactly 0 or 1.");
}

export function liveProviderConfiguration(
  provider: SandboxCiProvider,
  env: NodeJS.ProcessEnv = process.env,
): SandboxProviderConfigV2 {
  const executable = requiredLiveSetting(
    provider,
    env,
    "AGENTIC_SANDBOX_CI_EXECUTABLE",
  );
  const runtimeReference = requiredLiveSetting(
    provider,
    env,
    "AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE",
  );
  const runtimeDigest = requiredLiveSetting(
    provider,
    env,
    "AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
  );
  const wslDistribution = provider === "wsl2"
    ? requiredLiveSetting(
        provider,
        env,
        "AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION",
      )
    : null;
  const runtimeRoot = provider === "podman"
    ? null
    : requiredLiveSetting(
        provider,
        env,
        "AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
      );

  return {
    version: 1,
    kind: provider,
    executable,
    priority: 1,
    runtimeReference,
    runtimeDigest,
    wslDistribution,
    runtimeRoot,
  };
}

export function liveInfrastructureAction(provider: SandboxCiProvider): string {
  if (provider === "wsl2") {
    return [
      "install a self-hosted Windows runner with WSL2",
      "provision the declared dedicated distribution with /usr/bin/bwrap",
      "install the digest-reporting sandbox-entrypoint below the declared read-only runtime root",
      "then set AGENTIC_SANDBOX_CI_EXECUTABLE, AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE, AGENTIC_SANDBOX_CI_RUNTIME_DIGEST, AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION, and AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
    ].join("; ");
  }
  if (provider === "podman") {
    return [
      "install and start Podman on a self-hosted macOS runner",
      "publish or pre-pull the declared image containing /opt/agentic/sandbox-entrypoint at the exact digest",
      "then set AGENTIC_SANDBOX_CI_EXECUTABLE, AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE, and AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
    ].join("; ");
  }
  return [
    "install bubblewrap on a self-hosted Linux runner with user namespaces enabled",
    "provision the declared read-only runtime root with bin/sandbox-entrypoint",
    "then set AGENTIC_SANDBOX_CI_EXECUTABLE, AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE, AGENTIC_SANDBOX_CI_RUNTIME_DIGEST, and AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
  ].join("; ");
}

async function main(): Promise<void> {
  const platform = supportedPlatform(process.platform);
  const expectedProvider = PLATFORM_PROVIDER[platform];
  const provider = requestedProvider(expectedProvider);
  const mode = resolveSandboxBoundaryCiMode();
  if (mode === "live") {
    await runLiveBoundaryProbe(platform, provider);
    return;
  }
  await runDeterministicBoundaryContract(platform, provider);
}

async function runDeterministicBoundaryContract(
  platform: SupportedSandboxCiPlatform,
  provider: SandboxCiProvider,
): Promise<void> {
  const configuration = deterministicProviderConfiguration(provider);
  const expectedSpec = buildSandboxProbeCommandV2(configuration);
  assertBoundarySpec(expectedSpec, provider);

  const observed: SandboxHostCommandSpecV2[] = [];
  const manager = new SandboxManagerV2({
    providers: [configuration],
    runner: {
      async run(spec) {
        observed.push(spec);
        assert.deepEqual(spec, expectedSpec);
        return {
          exitCode: 0,
          stdout: JSON.stringify(VERIFIED_PROBE),
          stderr: "",
        };
      },
    },
  });
  const status = await manager.probeProviders();
  assert.equal(status.executionAvailable, true);
  assert.equal(status.editingAvailable, true);
  assert.equal(status.selectedProvider, provider);
  assert.equal(status.providers[0]?.state, "verified");
  assert.equal(observed.length, 1);

  const rejected = new SandboxManagerV2({
    providers: [configuration],
    runner: {
      async run() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ ...VERIFIED_PROBE, networkBlocked: false }),
          stderr: "",
        };
      },
    },
  });
  const rejectedStatus = await rejected.probeProviders();
  assert.equal(rejectedStatus.executionAvailable, false);
  assert.equal(rejectedStatus.editingAvailable, true);
  assert.equal(rejectedStatus.selectedProvider, null);
  assert.equal(rejectedStatus.providers[0]?.state, "rejected");

  console.log(
    `Sandbox boundary fixture passed for ${platform}/${provider}: verified proof enables execution and a weakened proof leaves editing-only mode.`,
  );
}

async function runLiveBoundaryProbe(
  platform: SupportedSandboxCiPlatform,
  provider: SandboxCiProvider,
): Promise<void> {
  const configuration = liveProviderConfiguration(provider);
  const expectedSpec = buildSandboxProbeCommandV2(configuration);
  assertBoundarySpec(expectedSpec, provider);
  let executionCount = 0;
  const runner: SandboxCommandRunnerV2 = {
    async run(spec, input) {
      assert.deepEqual(
        spec,
        expectedSpec,
        "Live CI may execute only the exact host-built boundary probe.",
      );
      if (input?.stagedFiles?.length) {
        throw new Error("Live boundary probes cannot receive staged repository data.");
      }
      executionCount += 1;
      return execFixedBoundaryProbe(spec, input?.signal);
    },
  };
  const manager = new SandboxManagerV2({ providers: [configuration], runner });
  const status = await manager.probeProviders();
  const providerStatus = status.providers.find(
    (candidate) => candidate.provider === provider,
  );
  if (
    executionCount !== 1 ||
    !status.executionAvailable ||
    status.selectedProvider !== provider ||
    providerStatus?.state !== "verified" ||
    !providerStatus.probeFingerprint
  ) {
    throw new Error(
      `LIVE_SANDBOX_INFRASTRUCTURE_REQUIRED: ${liveInfrastructureAction(provider)}. ` +
        `SandboxManager diagnostic: ${providerStatus?.diagnostic ?? "probe did not run"}`,
    );
  }
  console.log(
    `Live sandbox boundary passed for ${platform}/${provider}; ` +
      `SandboxManager verified real provider execution with probe ${providerStatus.probeFingerprint}.`,
  );
}

function execFixedBoundaryProbe(
  spec: SandboxHostCommandSpecV2,
  signal?: AbortSignal,
): Promise<SandboxRunnerResultV2> {
  assert.equal(spec.purpose, "boundary_probe");
  assert.equal(spec.shell, false);
  assert.equal(spec.cwd, null);
  assert.deepEqual(spec.env, {});
  assert.equal(spec.stdinMode, "none");
  assert.equal(spec.stdoutMode, "boundary_probe_json");
  const env = cleanHostEnvironment(process.env);
  return new Promise((resolve, reject) => {
    execFile(
      spec.executable,
      spec.args,
      {
        cwd: undefined,
        env,
        encoding: "utf8",
        timeout: spec.timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        shell: false,
        signal,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr });
          return;
        }
        const reason = typeof code === "string" ? code : error.message;
        reject(new Error(`Fixed sandbox provider probe could not execute: ${reason}`));
      },
    );
  });
}

function cleanHostEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(host)) {
    if (HOST_ENV_ALLOWLIST.has(key) && value) output[key] = value;
  }
  return output;
}

function deterministicProviderConfiguration(
  kind: SandboxCiProvider,
): SandboxProviderConfigV2 {
  if (kind === "podman") {
    return {
      version: 1,
      kind,
      executable: "podman",
      priority: 1,
      runtimeReference: "ghcr.io/openai/agentic-sandbox",
      runtimeDigest: PROBE_DIGEST,
      wslDistribution: null,
      runtimeRoot: null,
    };
  }
  if (kind === "wsl2") {
    return {
      version: 1,
      kind,
      executable: "wsl.exe",
      priority: 1,
      runtimeReference: "agentic-runtime",
      runtimeDigest: PROBE_DIGEST,
      wslDistribution: "AgenticResearcherSandbox",
      runtimeRoot: "/opt/agentic/runtime",
    };
  }
  return {
    version: 1,
    kind,
    executable: "bwrap",
    priority: 1,
    runtimeReference: "agentic-runtime",
    runtimeDigest: PROBE_DIGEST,
    wslDistribution: null,
    runtimeRoot: "/opt/agentic/runtime",
  };
}

function supportedPlatform(value: NodeJS.Platform): SupportedSandboxCiPlatform {
  if (value === "win32" || value === "darwin" || value === "linux") return value;
  throw new Error(`No Phase 8 sandbox boundary fixture is declared for ${value}.`);
}

function requestedProvider(expected: SandboxCiProvider): SandboxCiProvider {
  const requested = process.env.AGENTIC_SANDBOX_CI_PROVIDER?.trim() || expected;
  if (requested !== expected) {
    throw new Error(
      `Sandbox fixture ${requested} does not match the declared ${process.platform} provider ${expected}.`,
    );
  }
  return requested;
}

function requiredLiveSetting(
  provider: SandboxCiProvider,
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value || /[\0\r\n]/u.test(value)) {
    throw new Error(
      `LIVE_SANDBOX_INFRASTRUCTURE_REQUIRED: ${liveInfrastructureAction(provider)}. ` +
        `Missing or invalid setting: ${name}.`,
    );
  }
  return value;
}

function assertBoundarySpec(
  spec: SandboxHostCommandSpecV2,
  provider: SandboxCiProvider,
): void {
  assert.equal(spec.purpose, "boundary_probe");
  assert.equal(spec.shell, false);
  assert.equal(spec.cwd, null);
  assert.deepEqual(spec.env, {});
  assert.equal(
    spec.args.some((argument) =>
      /(?:docker\.sock|podman\.sock|\/var\/run|^\/$|--privileged)/iu.test(argument),
    ),
    false,
  );
  if (provider === "podman") {
    assert.ok(inSequence(spec.args, ["--network", "none"]));
    assert.ok(spec.args.includes("--read-only"));
    assert.ok(inSequence(spec.args, ["--user", "65532:65532"]));
    assert.ok(inSequence(spec.args, ["--cap-drop", "ALL"]));
    return;
  }
  assert.ok(spec.args.includes("--unshare-all"));
  assert.ok(spec.args.includes("--unshare-net"));
  assert.ok(spec.args.includes("--ro-bind"));
  if (provider === "wsl2") {
    assert.ok(inSequence(spec.args, ["--user", "agentic", "--exec"]));
  }
}

function inSequence(values: readonly string[], expected: readonly string[]): boolean {
  return values.some((_, index) =>
    expected.every((value, offset) => values[index + offset] === value),
  );
}

const directScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (directScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
