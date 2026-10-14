import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { SandboxManagerV2, type SandboxTransientDiagnosticExcerptV1 } from "../extensions/code/sandbox/SandboxManager";
import { SpawnSandboxCommandRunnerV2 } from "../extensions/code/sandbox/SpawnSandboxCommandRunnerV2";
import { readHostProvisionedSandboxBindingV1 } from "../extensions/code/sandbox/HostProvisionedSandboxBindingV1";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("real sandbox output is redacted before exit with unchanged final receipt bytes", {
  skip: process.env.CIP4_STREAM_NATIVE !== "1" ? "CIP4_STREAM_NATIVE=1 requires an explicit provisioned runtime" : false,
  timeout: 180000,
}, async () => {
  const binding = readHostProvisionedSandboxBindingV1(process.env, process.platform);
  assert.ok(binding);
  const manager = new SandboxManagerV2({ providers: [binding.provider], runner: new SpawnSandboxCommandRunnerV2() });
  const cases: unknown[] = [];
  let failure: unknown;
  try {
    assert.equal((await manager.probeProviders()).executionAvailable, true);
    const early: boolean[] = [];
    const files = {
      "package.json": JSON.stringify({ name: "progress-fixture", version: "1.0.0", scripts: { test: "node stream.cjs", build: "node stream.cjs" } }),
      "package-lock.json": JSON.stringify({ name: "progress-fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }),
      "stream.cjs": 'process.stdout.write("PUBLIC_FIRST\\napi_"); setTimeout(() => { process.stdout.write("key=synthetic-test-sentinel\\n"); setTimeout(() => process.stdout.write("PUBLIC_LAST\\n"), 1000); }, 1000);\n',
    };
    const detected = detectRepositoryProfileV2({ key: "progress-fixture", displayName: "Progress fixture", repositoryRoot: "/qualification", defaultBranch: "main", files: Object.keys(files), fileContents: files, runtimeDigests: { node: binding.provider.runtimeDigest } });
    const base = detected.validationCatalog.find(command => command.phase === "fast")!;
    const command = { ...base, executable: "node", args: ["stream.cjs"] };
    const profile = { ...detected, validationCatalog: [command] };
    const stagingManifest = Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: hash(content) }));
    for (let repetition = 1; repetition <= 3; repetition++) {
      const prepared = await manager.prepareExecution({ profile, purpose: "validation_fast", projectId: command.projectId, commandId: command.id, workspaceId: "progress-fixture", repairRequestId: "progress-request", workspaceManifestFingerprint: hash(JSON.stringify(stagingManifest)), stagingManifest });
      assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
      if (prepared.status !== "prepared") throw Error("Expected prepared action");
      const start = performance.now();
      let ended = false;
      const snapshots: Array<{ elapsedMs: number; beforeExit: boolean; excerpt: SandboxTransientDiagnosticExcerptV1 }> = [];
      const result = await manager.executePrepared(prepared.action, { authorization: { preparedActionId: prepared.action.id, payloadFingerprint: prepared.action.payloadFingerprint, grantId: "synthetic-progress-qualification" }, stagedFiles: Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.from(content) })),
        onProgress: excerpt => snapshots.push({ elapsedMs: performance.now() - start, beforeExit: !ended, excerpt }),
      });
      ended = true;
      const elapsedMs = performance.now() - start;
      cases.push({ repetition, elapsedMs, snapshots, result });
      assert.equal(result.status, "verified", JSON.stringify(result));
      assert.equal(result.receipt.stdoutSha256, hash("PUBLIC_FIRST\napi_key=synthetic-test-sentinel\nPUBLIC_LAST\n"));
      assert.doesNotMatch(JSON.stringify(snapshots), /synthetic-test-sentinel|api_/u);
      assert.doesNotMatch(JSON.stringify(result.diagnosticExcerpt), /synthetic-test-sentinel/u);
      early.push(snapshots.some(row => row.beforeExit && row.elapsedMs < elapsedMs - 500 && row.excerpt.stdout.includes("PUBLIC_FIRST")));
    }
    assert.deepEqual(early, [true, true, true], "the first marker must be visible while each command still has work remaining");
  } catch (error) { failure = String(error); throw error; }
  finally {
    await mkdir(".cache/cip4-streaming", { recursive: true });
    await writeFile(`.cache/cip4-streaming/native-${Date.now()}.json`, JSON.stringify({ binding, cases, failure }, null, 2) + "\n", { flag: "wx" });
  }
});
