import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ScopedExtensionContextV1 } from "../packages/core-api/src";
import { verifyPreparedActionFingerprint } from "../src/agent/actions";

import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import {
  SandboxManagerV2,
  buildSandboxExecutionCommandV2,
  buildSandboxProbeCommandV2,
  type SandboxCommandRunnerV2,
  type SandboxHostCommandSpecV2,
  type SandboxProviderConfigV2,
  type SandboxRunnerResultV2,
} from "../extensions/code/sandbox/SandboxManager";
import {
  SandboxSpawnRunnerV2Error,
  SpawnSandboxCommandRunnerV2,
  type SandboxSpawnAdapterV2,
  type SandboxSpawnChildV2,
  type SandboxSpawnOptionsV2,
} from "../extensions/code/sandbox/SpawnSandboxCommandRunnerV2";
import {
  CODE_EXECUTION_TOOL_NAMES_V2,
  CodeSandboxContributionErrorV2,
  createCodeExecutionContributionsV2,
} from "../extensions/code/sandbox/CodeExecutionContributionsV2";

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

test("SandboxManager stays editing-only until a provider passes its explicit boundary probe", async () => {
  let calls = 0;
  const manager = new SandboxManagerV2({
    runner: {
      async run() {
        calls += 1;
        return { exitCode: 1, stdout: "", stderr: "provider unavailable" };
      },
    },
    providers: [dockerProvider()],
  });
  const initial = manager.readStatus();
  assert.equal(initial.mode, "editing_only");
  assert.equal(initial.executionAvailable, false);
  assert.equal(initial.editingAvailable, true);
  assert.equal(calls, 0, "status reads must not start provider processes");

  const probed = await manager.probeProviders();
  assert.equal(probed.mode, "editing_only");
  assert.equal(calls, 1);
  assert.match(
    probed.blocker?.message ?? "",
    /docker unavailable: Probe exited 1\./u,
  );
  assert.ok(probed.providers[0]?.checkedAt, "failed probes retain an evidence timestamp");
  const prepared = await manager.prepareExecution(prepareInput());
  assert.equal(prepared.status, "blocked");
  if (prepared.status === "blocked") {
    assert.equal(prepared.blocker.code, "sandbox_provider_unavailable");
    assert.equal(prepared.blocker.editingAvailable, true);
    assert.equal(prepared.blocker.executionAvailable, false);
  }
});

test("SandboxManager verifies staging, re-probes, executes with fixed argv, and emits canonical receipt", async () => {
  const specs: SandboxHostCommandSpecV2[] = [];
  const artifact = new TextEncoder().encode("generated output\n");
  const runner: SandboxCommandRunnerV2 = {
    async run(spec): Promise<SandboxRunnerResultV2> {
      specs.push(spec);
      if (spec.purpose === "boundary_probe") {
        return { exitCode: 0, stdout: PROBE, stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: "validation complete",
        stderr: "",
        artifacts: { "dist/output.js": artifact },
      };
    },
  };
  const now = new Date("2026-07-12T12:00:00.000Z");
  const manager = new SandboxManagerV2({
    runner,
    providers: [dockerProvider()],
    now: () => new Date(now),
  });
  await manager.probeProviders();
  const source = new TextEncoder().encode("export const value = 1;\n");
  const staging = [{ path: "src/index.ts", bytes: source }];
  const preparation = await manager.prepareExecution({
    ...prepareInput(),
    stagingManifest: [
      { path: "src/index.ts", bytes: source.byteLength, sha256: sha256(source) },
    ],
    expectedArtifacts: [
      {
        path: "dist/output.js",
        expectedSha256: sha256(artifact),
        maxBytes: 10_000,
        required: true,
      },
    ],
  });
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") return;

  const unauthorized = await manager.executePrepared(preparation.action, {
    authorization: null,
    stagedFiles: staging,
  });
  assert.equal(unauthorized.status, "blocked");
  if (unauthorized.status === "blocked") {
    assert.equal(unauthorized.blocker.code, "sandbox_authorization_required");
  }

  const mismatched = await manager.executePrepared(preparation.action, {
    authorization: authorization(preparation.action),
    stagedFiles: [{ path: "src/index.ts", bytes: new TextEncoder().encode("tampered") }],
  });
  assert.equal(mismatched.status, "blocked");
  if (mismatched.status === "blocked") {
    assert.equal(mismatched.blocker.code, "sandbox_staging_mismatch");
  }

  const imported: string[] = [];
  const result = await manager.executePrepared(preparation.action, {
    authorization: authorization(preparation.action),
    stagedFiles: staging,
    artifactImporter: {
      async importArtifacts(inputs) {
        return inputs.map((input) => {
          imported.push(input.path);
          return { path: input.path, readbackSha256: sha256(input.bytes) };
        });
      },
    },
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") return;
  assert.deepEqual(imported, ["dist/output.js"]);
  assert.match(result.receipt.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.receipt.status, "verified");
  assert.equal(result.receipt.importedArtifacts[0].readbackSha256, sha256(artifact));

  const execute = specs.find((spec) => spec.purpose === "execute")!;
  assert.equal(execute.shell, false);
  assert.equal(execute.stdinMode, "verified_staging_bundle");
  assert.deepEqual(execute.env, {});
  assert.ok(inSequence(execute.args, ["--env", "CI=true"]));
  assert.ok(inSequence(execute.args, ["--network", "none"]));
  assert.ok(execute.args.includes("--read-only"));
  assert.ok(inSequence(execute.args, ["--user", "65532:65532"]));
  assert.ok(inSequence(execute.args, ["--cap-drop", "ALL"]));
  assert.equal(execute.args.some((arg) => /docker\.sock|podman\.sock/i.test(arg)), false);
  assert.equal(execute.args.includes("-v"), false);
  assert.equal(execute.args.includes("--volume"), false);
});

test("lockfile restoration is exact-approved, credential-free, and cannot become arbitrary install", async () => {
  const specs: SandboxHostCommandSpecV2[] = [];
  const runner: SandboxCommandRunnerV2 = {
    async run(spec) {
      specs.push(spec);
      return spec.purpose === "boundary_probe"
        ? { exitCode: 0, stdout: PROBE, stderr: "" }
        : { exitCode: 0, stdout: "restored", stderr: "" };
    },
  };
  const manager = new SandboxManagerV2({ runner, providers: [dockerProvider()] });
  await manager.probeProviders();
  const lock = new TextEncoder().encode("lockfile");
  const preparation = await manager.prepareExecution({
    ...prepareInput(),
    purpose: "lockfile_restore",
    repairRequestId: null,
    commandId: "root-npm-restore",
    stagingManifest: [
      { path: "package-lock.json", bytes: lock.byteLength, sha256: sha256(lock) },
    ],
    environment: { CI: "true" },
  });
  assert.equal(preparation.status, "prepared");
  if (preparation.status !== "prepared") return;
  assert.equal(preparation.action.network.mode, "exact_approval_required");
  assert.equal(preparation.action.network.credentialPolicy, "none");
  assert.deepEqual(preparation.action.command.args, [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);

  const result = await manager.executePrepared(preparation.action, {
    authorization: authorization(preparation.action),
    stagedFiles: [{ path: "package-lock.json", bytes: lock }],
  });
  assert.equal(result.status, "verified");
  const execution = specs.find((spec) => spec.purpose === "execute")!;
  assert.ok(inSequence(execution.args, ["--network", "bridge"]));
  assert.equal(
    Object.entries(execution.env).some(([key, value]) =>
      /token|secret|password|credential|authorization/i.test(`${key}=${value}`),
    ),
    false,
  );

  await assert.rejects(
    manager.prepareExecution({
      ...prepareInput(),
      purpose: "lockfile_restore",
      repairRequestId: null,
      commandId: "root-npm-test",
    }),
    /requires a bootstrap catalog command/i,
  );
});

test("all provider command specs are shell-free, bounded, and omit host/root/socket mounts", async () => {
  const providers: SandboxProviderConfigV2[] = [
    dockerProvider(),
    { ...dockerProvider(), kind: "podman", executable: "podman", priority: 2 },
    {
      version: 1,
      kind: "wsl2",
      executable: "wsl.exe",
      priority: 3,
      runtimeReference: "agentic-runtime",
      runtimeDigest: `sha256:${"f".repeat(64)}`,
      wslDistribution: "AgenticResearcherSandbox",
      runtimeRoot: "/opt/agentic/runtime",
    },
    {
      version: 1,
      kind: "bubblewrap",
      executable: "bwrap",
      priority: 4,
      runtimeReference: "agentic-runtime",
      runtimeDigest: `sha256:${"f".repeat(64)}`,
      wslDistribution: null,
      runtimeRoot: "/opt/agentic/runtime",
    },
  ];
  for (const provider of providers) {
    const manager = new SandboxManagerV2({
      runner: { async run() { return { exitCode: 0, stdout: PROBE, stderr: "" }; } },
      providers: [provider],
    });
    await manager.probeProviders();
    const prepared = await manager.prepareExecution(prepareInput());
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") continue;
    assert.equal(
      prepared.action.runtimeDigest,
      provider.runtimeDigest,
      "execution must use the freshly probed immutable bundle digest rather than a repository pin hash",
    );
    const probe = buildSandboxProbeCommandV2(provider);
    const execute = buildSandboxExecutionCommandV2(provider, prepared.action);
    assert.equal(
      probe.timeoutMs,
      provider.kind === "wsl2" ? 60_000 : 30_000,
      "WSL2 cold-start attestation has a bounded provider-specific budget",
    );
    assert.deepEqual(execute.env, {}, "action environment must not be inherited by the host provider process");
    assert.ok(inSequence(execute.args, ["--command-cwd", "."]));
    for (const spec of [probe, execute]) {
      assert.equal(spec.shell, false);
      assert.equal(spec.cwd, null);
      assert.equal(spec.args.some((arg) => /docker\.sock|podman\.sock/i.test(arg)), false);
      assert.deepEqual(
        spec.args.flatMap((arg, index) => arg === "/" ? [spec.args[index - 1]] : []),
        provider.kind === "wsl2" || provider.kind === "bubblewrap"
          ? ["--remount-ro"]
          : [],
      );
      assert.equal(spec.args.includes("--privileged"), false);
    }
    if (provider.kind === "wsl2" || provider.kind === "bubblewrap") {
      assert.ok(execute.args.includes("--unshare-all"));
      assert.ok(execute.args.includes("--unshare-net"));
      assert.ok(inSequence(execute.args, ["--ro-bind", "/opt/agentic/runtime", "/runtime"]));
      assert.ok(inSequence(execute.args, ["--ro-bind", "/opt/agentic/runtime/bin", "/bin"]));
      assert.ok(inSequence(execute.args, ["--ro-bind", "/opt/agentic/runtime/lib", "/lib"]));
      assert.ok(inSequence(execute.args, ["--ro-bind", "/opt/agentic/runtime/lib64", "/lib64"]));
      assert.ok(inSequence(execute.args, ["--remount-ro", "/"]));
      assert.ok(inSequence(execute.args, ["--setenv", "CI", "true"]));
    } else {
      assert.ok(inSequence(execute.args, ["--env", "CI=true"]));
    }
  }
});

test("SandboxManager imports declared artifacts as one atomic batch and rejects incomplete readback", async () => {
  const first = new Uint8Array([1, 2, 3]);
  const second = new Uint8Array([4, 5, 6]);
  const runner: SandboxCommandRunnerV2 = {
    async run(spec) {
      if (spec.purpose === "boundary_probe") return { exitCode: 0, stdout: PROBE, stderr: "" };
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        artifacts: {
          "dist/first.bin": first,
          "dist/second.bin": second,
        },
      };
    },
  };
  const manager = new SandboxManagerV2({ runner, providers: [dockerProvider()] });
  await manager.probeProviders();
  const prepared = await manager.prepareExecution({
    ...prepareInput(),
    expectedArtifacts: [
      { path: "dist/first.bin", expectedSha256: sha256(first), maxBytes: 100, required: true },
      { path: "dist/second.bin", expectedSha256: sha256(second), maxBytes: 100, required: true },
    ],
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  let calls = 0;
  const blocked = await manager.executePrepared(prepared.action, {
    authorization: authorization(prepared.action),
    stagedFiles: [{ path: "src/index.ts", bytes: new TextEncoder().encode("export const value = 1;\n") }],
    artifactImporter: {
      async importArtifacts(inputs) {
        calls += 1;
        assert.deepEqual(inputs.map((entry) => entry.path), ["dist/first.bin", "dist/second.bin"]);
        return [{ path: inputs[0].path, readbackSha256: inputs[0].sha256 }];
      },
    },
  });
  assert.equal(calls, 1);
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") assert.equal(blocked.blocker.code, "sandbox_artifact_readback_failed");
});

test("sandbox provider configuration requires a separate immutable digest and rejects embedded digest or URL syntax", () => {
  assert.throws(
    () => buildSandboxProbeCommandV2({
      ...dockerProvider(),
      runtimeReference: `ghcr.io/example/runtime@sha256:${"f".repeat(64)}`,
    }),
    /without a digest/iu,
  );
  assert.throws(
    () => buildSandboxProbeCommandV2({ ...dockerProvider(), runtimeReference: "https://registry.example/runtime" }),
    /registry image name/iu,
  );
});

test("code contribution factory replaces compatibility execution tools with prepared sandbox-only actions", async () => {
  let executions = 0;
  const runner: SandboxCommandRunnerV2 = {
    async run(spec) {
      if (spec.purpose === "boundary_probe") {
        return { exitCode: 0, stdout: PROBE, stderr: "" };
      }
      executions += 1;
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
  const manager = new SandboxManagerV2({
    runner,
    providers: [dockerProvider()],
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  const fixture = prepareInput();
  const source = new TextEncoder().encode("export const value = 1;\n");
  let observedValidationReceipts = 0;
  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    async getProfile(key) {
      return key === fixture.profile.key ? fixture.profile : null;
    },
    async resolvePreparationInput(input) {
      assert.equal(input.purpose, "validation_fast");
      assert.equal(input.workspaceId, "model-workspace-alias");
      return {
        profile: fixture.profile,
        projectId: fixture.projectId,
        commandId: fixture.commandId,
        workspaceId: fixture.workspaceId,
        repairRequestId: "request-1",
        workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
        stagingManifest: fixture.stagingManifest,
      };
    },
    async resolveExecutionInput() {
      return { stagedFiles: [{ path: "src/index.ts", bytes: source }] };
    },
    async observeValidationReceipt(input) {
      observedValidationReceipts += 1;
      assert.equal(input.requestId, "request-1");
      assert.equal(input.action.repairRequestId, "request-1");
      assert.equal(input.receipt.actionId, input.action.id);
      return {
        version: 1,
        kindName: "code_validation",
        kind: "fast",
        id: input.receipt.id,
        fingerprint: `sha256:${"9".repeat(64)}`,
        failureFingerprint: null,
      };
    },
  });
  const tools = contributions
    .filter((contribution) => contribution.descriptor.kind === "tool")
    .map((contribution) => contribution as Extract<typeof contribution, { tool: unknown }>);
  assert.deepEqual(
    tools.map((contribution) => contribution.tool.name),
    [...CODE_EXECUTION_TOOL_NAMES_V2],
  );

  const statusTool = tools.find((contribution) => contribution.tool.name === "code_sandbox_status")!.tool;
  assert.equal(
    (await statusTool.execute({}, context()) as { executionAvailable: boolean })
      .executionAvailable,
    false,
  );
  assert.equal(executions, 0);

  const direct = tools.find((contribution) => contribution.tool.name === "run_code_block")!.tool;
  assert.equal(
    (await direct.execute({}, context()) as { executionAvailable: boolean })
      .executionAvailable,
    false,
  );
  assert.equal(direct.descriptor.execution.preparation, "required");
  assert.equal(direct.descriptor.approval.fallback, "exact");
  assert.equal(executions, 0, "direct compatibility execution must never invoke the runner");

  const preview = tools.find((contribution) => contribution.tool.name === "render_html_preview")!.tool;
  const previewResult = await preview.execute(
    { html: "<script>globalThis.pwned=true</script><h1>Preview</h1>" },
    context(),
  ) as Record<string, unknown>;
  assert.deepEqual(previewResult.iframeSandboxTokens, []);
  assert.match(String(previewResult.csp), /script-src 'none'/);
  assert.equal(previewResult.hostExecution, false);
  assert.equal(String(previewResult.csp).includes("allow-scripts"), false);

  await manager.probeProviders();
  const validation = tools.find((contribution) => contribution.tool.name === "code_validate_fast")!.tool;
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      validation.parameters.properties ?? {},
      "workspaceManifestFingerprint",
    ),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      validation.parameters.properties ?? {},
      "stagingManifest",
    ),
    false,
  );
  for (const modelOwnedSelector of ["profileKey", "projectId", "commandId"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        validation.parameters.properties ?? {},
        modelOwnedSelector,
      ),
      false,
    );
  }
  const prepared = await validation.prepare!(
    {
      workspaceId: "model-workspace-alias",
      repairRequestId: "model-request-alias",
      environment: fixture.environment,
    },
    context(),
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(await verifyPreparedActionFingerprint(prepared.action), true);
  const authorized = context({
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-outer",
    },
  });
  const executed = await validation.executePrepared!(prepared.action, authorized);
  assert.equal((executed.output as { nativeFallbackUsed: boolean }).nativeFallbackUsed, false);
  assert.equal(executed.receipt.payloadFingerprint, prepared.action.payloadFingerprint);
  assert.equal(executed.receipt.grantId, "grant-outer");
  assert.equal(
    (executed.output as { validationReceipt: { id: string } }).validationReceipt.id,
    (executed.output as { sandboxReceipt: { id: string } }).sandboxReceipt.id,
  );
  assert.equal(executions, 1);
  assert.equal(observedValidationReceipts, 1);
});

test("validation contribution withholds success when durable receipt persistence/readback fails", async () => {
  let executions = 0;
  const manager = new SandboxManagerV2({
    providers: [dockerProvider()],
    runner: {
      async run(spec) {
        if (spec.purpose === "boundary_probe") {
          return { exitCode: 0, stdout: PROBE, stderr: "" };
        }
        executions += 1;
        return { exitCode: 0, stdout: "green", stderr: "" };
      },
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  const fixture = prepareInput();
  const source = new TextEncoder().encode("export const value = 1;\n");
  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    getProfile: async () => fixture.profile,
    resolveExecutionInput: async () => ({
      stagedFiles: [{ path: "src/index.ts", bytes: source }],
    }),
    async observeValidationReceipt() {
      throw new Error("readback hash mismatch");
    },
  });
  await manager.probeProviders();
  const validation = contributions
    .filter((entry) => entry.descriptor.kind === "tool")
    .map((entry) => entry as Extract<typeof entry, { tool: unknown }>)
    .find((entry) => entry.tool.name === "code_validate_fast")!.tool;
  const prepared = await validation.prepare!({
    profileKey: fixture.profile.key,
    projectId: fixture.projectId,
    commandId: fixture.commandId,
    workspaceId: fixture.workspaceId,
    repairRequestId: "request-1",
    workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
    stagingManifest: fixture.stagingManifest,
    environment: fixture.environment,
  }, context());
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  await assert.rejects(
    validation.executePrepared!(prepared.action, context({
      authorizedAction: {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: "grant-1",
      },
    })),
    (error: unknown) =>
      error instanceof CodeSandboxContributionErrorV2 &&
      error.code === "validation_receipt_persistence_failed" &&
      /readback hash mismatch/u.test(error.message),
  );
  assert.equal(executions, 1, "sandbox ran once, but no green tool result was returned");
});

test("failed validation exposes a redacted bounded foreground excerpt while durable observer sees hashes only", async () => {
  const durableSources: unknown[] = [];
  const bareCredential = `github_pat_${"z".repeat(40)}`;
  const stderr = [
    "API_TOKEN=do-not-persist",
    bareCredential,
    "AssertionError: expected 2, received 3",
  ].join("\n");
  const manager = new SandboxManagerV2({
    providers: [dockerProvider()],
    runner: {
      async run(spec) {
        if (spec.purpose === "boundary_probe") {
          return { exitCode: 0, stdout: PROBE, stderr: "" };
        }
        return {
          exitCode: 1,
          stdout: "src/index.ts(4,3): TS2322 expected string but received number",
          stderr,
        };
      },
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  const fixture = prepareInput();
  const source = new TextEncoder().encode("export const value = 1;\n");
  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    getProfile: async () => fixture.profile,
    resolveExecutionInput: async () => ({
      stagedFiles: [{ path: "src/index.ts", bytes: source }],
    }),
    async observeValidationReceipt(input) {
      durableSources.push(structuredClone(input.diagnostics));
      return {
        version: 1,
        kindName: "code_validation",
        kind: "fast",
        id: input.receipt.id,
        status: "failed",
        fingerprint: `sha256:${"8".repeat(64)}`,
        failureFingerprint: `sha256:${"7".repeat(64)}`,
      };
    },
  });
  await manager.probeProviders();
  const validation = contributions
    .filter((entry) => entry.descriptor.kind === "tool")
    .map((entry) => entry as Extract<typeof entry, { tool: unknown }>)
    .find((entry) => entry.tool.name === "code_validate_fast")!.tool;
  const prepared = await validation.prepare!({
    profileKey: fixture.profile.key,
    projectId: fixture.projectId,
    commandId: fixture.commandId,
    workspaceId: fixture.workspaceId,
    repairRequestId: "request-1",
    workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
    stagingManifest: fixture.stagingManifest,
    environment: fixture.environment,
  }, context());
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const executed = await validation.executePrepared!(prepared.action, context({
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "grant-1",
    },
  }));
  const output = executed.output as {
    validationDiagnostics: {
      stdoutSha256: string;
      stderrSha256: string;
      stdoutBytes: number;
      stderrBytes: number;
      redactedLines: number;
    };
    validationDiagnosticExcerpt: {
      stdout: string;
      stderr: string;
      truncated: boolean;
      redactedLines: number;
    };
  };
  assert.match(output.validationDiagnostics.stdoutSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.match(output.validationDiagnostics.stderrSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(output.validationDiagnostics.stdoutBytes, Buffer.byteLength("src/index.ts(4,3): TS2322 expected string but received number", "utf8"));
  assert.equal(output.validationDiagnostics.stderrBytes, Buffer.byteLength(stderr, "utf8"));
  assert.equal(output.validationDiagnostics.redactedLines, 2);
  assert.match(output.validationDiagnosticExcerpt.stdout, /TS2322/iu);
  assert.match(output.validationDiagnosticExcerpt.stderr, /AssertionError/iu);
  assert.match(output.validationDiagnosticExcerpt.stderr, /redacted credential-shaped/iu);
  assert.doesNotMatch(JSON.stringify(output), /do-not-persist/iu);
  assert.doesNotMatch(JSON.stringify(output), new RegExp(bareCredential, "u"));
  assert.doesNotMatch(JSON.stringify(durableSources), /TS2322|AssertionError|do-not-persist/iu);
});

test("SpawnSandboxCommandRunnerV2 launches only fixed provider argv with clean bounded staging protocol", async () => {
  const calls: Array<{
    executable: string;
    args: string[];
    options: SandboxSpawnOptionsV2;
    child: FakeSandboxChild;
  }> = [];
  const adapter: SandboxSpawnAdapterV2 = {
    spawn(executable, args, options) {
      const probe = args.includes("--boundary-probe-json");
      const output = probe
        ? PROBE
        : JSON.stringify({
            version: 1,
            exitCode: 0,
            stdoutBase64: Buffer.from("validated", "utf8").toString("base64"),
            stderrBase64: "",
            artifacts: [],
          });
      const child = new FakeSandboxChild(output);
      calls.push({ executable, args: [...args], options, child });
      return child as unknown as SandboxSpawnChildV2;
    },
  };
  const runner = new SpawnSandboxCommandRunnerV2({
    spawnAdapter: adapter,
    hostEnvironment: {
      PATH: "C:\\Program Files\\Docker",
      SYSTEMROOT: "C:\\Windows",
      GITHUB_TOKEN: "must-not-cross-boundary",
      NODE_OPTIONS: "--require hostile.js",
    },
  });
  const manager = new SandboxManagerV2({
    runner,
    providers: [dockerProvider()],
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  await manager.probeProviders();
  const readme = new TextEncoder().encode("# Fixture\n");
  const prepared = await manager.prepareExecution({
    ...prepareInput(),
    stagingManifest: [
      ...prepareInput().stagingManifest,
      { path: "README.md", bytes: readme.byteLength, sha256: sha256(readme) },
    ],
  });
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") return;
  const source = new TextEncoder().encode("export const value = 1;\n");
  const result = await manager.executePrepared(prepared.action, {
    authorization: authorization(prepared.action),
    stagedFiles: [
      { path: "src/index.ts", bytes: source },
      { path: "README.md", bytes: readme },
    ],
  });
  assert.equal(result.status, "verified");
  assert.equal(calls.length, 3, "initial probe, fresh probe, then one provider execution");
  for (const call of calls) {
    assert.equal(call.executable, "docker");
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal("GITHUB_TOKEN" in call.options.env, false);
    assert.equal("NODE_OPTIONS" in call.options.env, false);
    assert.equal(call.options.env.PATH, "C:\\Program Files\\Docker");
  }
  const execution = calls.at(-1)!;
  assert.equal(execution.options.env.CI, undefined, "guest action environment must not reach the host provider process");
  assert.ok(inSequence(execution.args, ["--env", "CI=true"]));
  const stagingBundle = JSON.parse(
    Buffer.concat(execution.child.stdinChunks).toString("utf8"),
  ) as {
    version: number;
    files: Array<{ path: string; sha256: string; bytes: number; contentBase64: string }>;
    manifestFingerprint: string;
  };
  assert.equal(stagingBundle.version, 1);
  assert.deepEqual(
    stagingBundle.files.map((file) => file.path),
    ["README.md", "src/index.ts"],
    "staging order must use canonical UTF-8 bytes, never host locale collation",
  );
  assert.equal(stagingBundle.files[1].sha256, sha256(source));
  assert.equal(
    Buffer.from(stagingBundle.files[1].contentBase64, "base64").toString("utf8"),
    "export const value = 1;\n",
  );
  const pythonCanonicalManifest = stagingBundle.files.map(
    ({ path, sha256: fileSha256, bytes }) => ({ bytes, path, sha256: fileSha256 }),
  );
  assert.equal(
    stagingBundle.manifestFingerprint,
    sha256(new TextEncoder().encode(JSON.stringify(pythonCanonicalManifest))),
    "host fingerprint must match the Python runtime's sorted canonical JSON",
  );

  const spec = buildSandboxExecutionCommandV2(dockerProvider(), prepared.action);
  await assert.rejects(
    runner.run(spec),
    (error: unknown) =>
      error instanceof SandboxSpawnRunnerV2Error &&
      error.code === "unsupported_staging",
  );
});

function prepareInput() {
  const source = new TextEncoder().encode("export const value = 1;\n");
  return {
    profile: detectRepositoryProfileV2({
      key: "sandbox-fixture",
      displayName: "Sandbox fixture",
      repositoryRoot: "/work/sandbox-fixture",
      defaultBranch: "main",
      files: ["package.json", "package-lock.json", ".nvmrc", "src/index.ts"],
      fileContents: { ".nvmrc": "24.16.0" },
    }),
    purpose: "validation_fast" as const,
    repairRequestId: "request-1",
    projectId: "root",
    commandId: "root-npm-test",
    workspaceId: "workspace-1",
    workspaceManifestFingerprint: `sha256:${"e".repeat(64)}`,
    stagingManifest: [
      { path: "src/index.ts", bytes: source.byteLength, sha256: sha256(source) },
    ],
    environment: { CI: "true" },
  };
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

function authorization(action: { id: string; payloadFingerprint: string }) {
  return {
    preparedActionId: action.id,
    payloadFingerprint: action.payloadFingerprint,
    grantId: "grant-1",
  };
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inSequence(values: readonly string[], expected: readonly string[]): boolean {
  return values.some((_, index) =>
    expected.every((value, offset) => values[index + offset] === value),
  );
}

function context(
  overrides: Partial<ScopedExtensionContextV1> = {},
): ScopedExtensionContextV1 {
  return {
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: "mission-1",
    operationId: "operation-1",
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    reportProgress() {},
    ...overrides,
  };
}

class FakeSandboxChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinChunks: Buffer[] = [];
  readonly stdin: Writable;
  killed = false;

  constructor(private readonly output: string) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinChunks.push(Buffer.from(chunk));
        callback();
      },
    });
    this.stdin.once("finish", () => {
      queueMicrotask(() => {
        if (this.killed) return;
        this.stdout.end(this.output);
        this.stderr.end();
        this.emit("close", 0, null);
      });
    });
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
}
