import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { SpawnSandboxCommandRunnerV2 } from "../extensions/code/sandbox/SpawnSandboxCommandRunnerV2";
import { detectRepositoryProfileV2, parseRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { SandboxManagerV2, buildSandboxExecutionCommandV2, parsePreparedSandboxActionV2,
  type SandboxProviderConfigV2, type SandboxHostCommandSpecV2 } from "../extensions/code/sandbox/SandboxManager";

const digest = `sha256:${"f".repeat(64)}`;
const proof = { version: 1, uid: 65532, networkBlocked: true, rootReadOnly: true, hostRootAbsent: true,
  containerSocketAbsent: true, runtimeReadOnly: true, runtimeDigest: digest, stagingIsolated: true, resourceLimitsEnforced: true };
const provider: SandboxProviderConfigV2 = { version: 1, kind: "docker", executable: "docker", priority: 1,
  runtimeReference: "ghcr.io/openai/agentic-sandbox", runtimeDigest: digest, wslDistribution: null, runtimeRoot: null };
const hash = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function profile(expanded = false) {
  const legacy = detectRepositoryProfileV2({ key: "staging-fixture", displayName: "Staging fixture", repositoryRoot: "/work/staging-fixture",
    defaultBranch: "main", files: ["package.json", "package-lock.json", ".nvmrc", "src/index.ts"], fileContents: { ".nvmrc": "24.16.0" } });
  return expanded ? parseRepositoryProfileV2({ ...legacy, stagingProfile: "source-1000-v1" }) : legacy;
}
function files(count: number, bytes = 1) {
  return Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts`, bytes: Buffer.alloc(bytes, "x") }));
}
function input(expanded: boolean, staged = files(101)) {
  return { profile: profile(expanded), purpose: "validation_fast" as const, repairRequestId: "request-1", projectId: "root",
    commandId: "root-npm-test", workspaceId: "workspace-1", workspaceManifestFingerprint: `sha256:${"e".repeat(64)}`,
    stagingManifest: staged.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: hash(file.bytes) })) };
}
function fixture(...capabilities: unknown[]) {
  const expanded = capabilities.length ? capabilities[0] : ["source-1000-v1"];
  const specs: SandboxHostCommandSpecV2[] = [];
  const state = { expanded };
  const manager = new SandboxManagerV2({ providers: [provider], now: () => new Date("2026-10-14T00:00:00Z"), runner: {
    async run(spec) { specs.push(spec); return spec.purpose === "boundary_probe"
      ? { exitCode: 0, stdout: JSON.stringify({ ...proof, ...(state.expanded === undefined ? {} : { stagingProfiles: state.expanded }) }), stderr: "" }
      : { exitCode: 0, stdout: "verified execution", stderr: "" }; },
  } });
  return { manager, specs, state };
}
function grant(action: {id: string; payloadFingerprint: string}) {
  return { preparedActionId: action.id, payloadFingerprint: action.payloadFingerprint, grantId: "grant-1" };
}

test("legacy repository profiles retain their exact JSON and default 100-file boundary", async () => {
  const legacy = profile(); assert.deepEqual(parseRepositoryProfileV2(legacy), legacy);
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "stagingProfile"), false);
  const fx = fixture(undefined); await fx.manager.probeProviders();
  assert.equal((await fx.manager.prepareExecution(input(false, files(100)))).status, "prepared");
  await assert.rejects(fx.manager.prepareExecution(input(false, files(101))), /staging|manifest/i);
});

test("only the named reviewed expanded staging profile is accepted", () => {
  const legacy = profile();
  for (const value of [null, "", "source-10000-v1", 1000, { maxFiles: 1000 }])
    assert.throws(() => parseRepositoryProfileV2({ ...legacy, stagingProfile: value }), /staging|profile/i);
  const expanded = profile(true);
  assert.deepEqual(JSON.parse(JSON.stringify(expanded)), { ...legacy, stagingProfile: "source-1000-v1" });
});

test("reviewed 1000-file staging executes only under a matching fresh provider capability", async () => {
  const fx = fixture(); const staged = files(1000); await fx.manager.probeProviders();
  const prepared = await fx.manager.prepareExecution(input(true, staged)); assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared") throw new Error("Expected prepared action");
  assert.equal(prepared.action.stagingManifest.length, 1000);
  assert.deepEqual(parsePreparedSandboxActionV2(prepared.action), prepared.action);
  const spec = buildSandboxExecutionCommandV2(provider, prepared.action);
  assert.equal(spec.args[spec.args.indexOf("--staging-stdin") - 1], "--staging-profile-source-1000-v1");
  const result = await fx.manager.executePrepared(prepared.action, { authorization: grant(prepared.action), stagedFiles: staged });
  assert.equal(result.status, "verified");
  assert.equal(fx.specs.filter(spec => spec.purpose === "boundary_probe").length, 2);
  assert.equal(fx.specs.filter(spec => spec.purpose === "execute").length, 1);
});

test("an old provider refuses expanded staging before a command can run", async () => {
  const fx = fixture(undefined); await fx.manager.probeProviders();
  const result = await fx.manager.prepareExecution(input(true)); assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.blocker.code, "sandbox_staging_profile_unsupported");
  assert.equal(fx.specs.some(spec => spec.purpose === "execute"), false);
});

test("expanded staging retains per-file, total-byte and exact file-count bounds", async () => {
  const fx = fixture(); await fx.manager.probeProviders();
  for (const staged of [files(1001), files(1, 2_000_001), files(6, 2_000_000)])
    await assert.rejects(fx.manager.prepareExecution(input(true, staged)), /staging|staged|manifest/i);
  assert.equal(fx.specs.some(spec => spec.purpose === "execute"), false);
});

test("expanded staging binds authorization and current bytes without accepting partial input", async () => {
  const fx = fixture(); const staged = files(101); await fx.manager.probeProviders();
  const prepared = await fx.manager.prepareExecution(input(true, staged)); if (prepared.status !== "prepared") throw new Error("Expected prepared action");
  assert.throws(() => parsePreparedSandboxActionV2({ ...prepared.action, stagingProfile: undefined }), /staging|payload|fingerprint/i);
  assert.equal((await fx.manager.executePrepared(prepared.action, { authorization: null, stagedFiles: staged })).status, "blocked");
  assert.equal((await fx.manager.executePrepared(prepared.action, { authorization: grant(prepared.action), stagedFiles: staged.slice(1) })).status, "blocked");
  const changed = staged.map((file, index) => index === 0 ? { ...file, bytes: Buffer.from("z") } : file);
  assert.equal((await fx.manager.executePrepared(prepared.action, { authorization: grant(prepared.action), stagedFiles: changed })).status, "blocked");
  assert.equal(fx.specs.some(spec => spec.purpose === "execute"), false);
});

test("loss of the negotiated staging capability after preparation blocks execution", async () => {
  const fx = fixture(); const staged = files(101); await fx.manager.probeProviders();
  const prepared = await fx.manager.prepareExecution(input(true, staged)); if (prepared.status !== "prepared") throw new Error("Expected prepared action");
  fx.state.expanded = undefined;
  const result = await fx.manager.executePrepared(prepared.action, { authorization: grant(prepared.action), stagedFiles: staged });
  assert.equal(result.status, "blocked");
  assert.equal(fx.specs.some(spec => spec.purpose === "execute"), false);
});

test("malformed staging capabilities cannot verify a provider", async () => {
  for (const capability of [[], ["unknown"], ["source-1000-v1", "source-1000-v1"], "source-1000-v1", null]) {
    const fx = fixture(capability); const status = await fx.manager.probeProviders(); assert.equal(status.executionAvailable, false);
  }
});

class TransportChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  constructor(capture: (bytes: Buffer) => void) {
    super(); const parts: Buffer[] = [];
    this.stdin = new Writable({ write(chunk, _encoding, done) { parts.push(Buffer.from(chunk)); done(); },
      final: done => { capture(Buffer.concat(parts)); done(); queueMicrotask(() => {
        this.stdout.end(JSON.stringify({ version: 1, exitCode: 0, stdoutBase64: "", stderrBase64: "", artifacts: [] }));
        this.stderr.end(); this.emit("close", 0, null);
      }); } });
  }
  kill(): boolean { return true; }
}

for (const progress of [false, true]) test(`expanded transport carries every verified file with progress ${progress}`, async () => {
  const fx = fixture(); await fx.manager.probeProviders(); const staged = files(1000);
  const prepared = await fx.manager.prepareExecution(input(true, staged)); if (prepared.status !== "prepared") throw new Error("Expected prepared action");
  const spec = buildSandboxExecutionCommandV2(provider, prepared.action);
  if (progress) spec.args.splice(spec.args.indexOf("--staging-stdin"), 0, "--progress-stderr-v1");
  let captured: Buffer = Buffer.alloc(0);
  const runner = new SpawnSandboxCommandRunnerV2({ spawnAdapter: { spawn() { return new TransportChild(bytes => { captured = bytes; }); } } });
  const result = await runner.run(spec, { stagedFiles: staged }); assert.equal(result.exitCode, 0);
  const bundle = JSON.parse(captured.toString("utf8")) as { files: Array<{path:string;sha256:string;bytes:number;contentBase64:string}> };
  assert.equal(bundle.files.length, staged.length);
  const originals = new Map(staged.map(file => [file.path, file.bytes]));
  for (const file of bundle.files) { const bytes = originals.get(file.path); assert.ok(bytes); assert.equal(file.sha256, hash(bytes)); assert.equal(file.bytes, bytes.length); assert.deepEqual(Buffer.from(file.contentBase64, "base64"), bytes); }
});

test("a command argument cannot nominate a larger staging transport profile", async () => {
  const fx = fixture(undefined); await fx.manager.probeProviders();
  const prepared = await fx.manager.prepareExecution(input(false, files(1))); if (prepared.status !== "prepared") throw new Error("Expected prepared action");
  const spec = buildSandboxExecutionCommandV2(provider, prepared.action); spec.args.push("--staging-profile-source-1000-v1");
  let launches = 0; const runner = new SpawnSandboxCommandRunnerV2({ spawnAdapter: { spawn() { launches++; return new TransportChild(() => undefined); } } });
  await assert.rejects(runner.run(spec, { stagedFiles: files(101) }), /1-100/);
  assert.equal(launches, 0);
});
