import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { SandboxManagerV2 } from "../extensions/code/sandbox/SandboxManager";
import { SpawnSandboxCommandRunnerV2 } from "../extensions/code/sandbox/SpawnSandboxCommandRunnerV2";
import { readHostProvisionedSandboxBindingV1 } from "../extensions/code/sandbox/HostProvisionedSandboxBindingV1";

const hash = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("detected Node full validation cannot pass red tests or a red build in the real sandbox", {
  skip: process.env.CIP4_NATIVE !== "1" ? "CIP4_NATIVE=1 requires a provisioned sandbox" : false,
  timeout: 600000,
}, async () => {
  const binding = readHostProvisionedSandboxBindingV1(process.env, process.platform);
  assert.ok(binding, "explicit runtime identity is required");
  const actual = new SpawnSandboxCommandRunnerV2();
  const captured: unknown[] = [];
  const manager = new SandboxManagerV2({ providers: [binding.provider], runner: { async run(spec, input) {
    const result = await actual.run(spec, input);
    captured.push({ purpose: spec.purpose, ...result });
    return result;
  } } });
  const report: { startedAt: string; probe?: unknown; cases: unknown[]; error?: string } = { startedAt: new Date().toISOString(), cases: [] };
  try {
    report.probe = await manager.probeProviders();
    assert.equal(manager.readStatus().executionAvailable, true, JSON.stringify(report.probe));
    const observed: string[] = [];
    for (const [name, value, buildExit] of [["both-green", 5, 0], ["test-red-build-green", 4, 0], ["test-green-build-red", 5, 9]] as const) {
      const files: Record<string, string> = {
        "package.json": JSON.stringify({ name: "full-validation", version: "1.0.0", scripts: { test: "node test.cjs", build: "node build.cjs" } }),
        "package-lock.json": JSON.stringify({ name: "full-validation", version: "1.0.0", lockfileVersion: 3, packages: {} }),
        "src/value.cjs": `module.exports = ${value};\n`,
        "test.cjs": 'require("node:assert/strict").equal(require("./src/value.cjs"), 5); console.log("TEST_RAN");\n',
        "build.cjs": `console.log("BUILD_RAN"); process.exit(${buildExit});\n`,
      };
      const profile = detectRepositoryProfileV2({ key: "full-validation", displayName: "Full validation", repositoryRoot: "/qualification", defaultBranch: "main",
        files: Object.keys(files), fileContents: files, runtimeDigests: { node: binding.provider.runtimeDigest } });
      const stagingManifest = Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: hash(content) }));
      const command = profile.validationCatalog.find(row => row.phase === "full")!;
      const prepared = await manager.prepareExecution({ profile, purpose: "validation_full", projectId: "root", commandId: command.id,
        workspaceId: `full-${name}`, repairRequestId: `request-${name}`, workspaceManifestFingerprint: hash(JSON.stringify(stagingManifest)), stagingManifest });
      assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
      if (prepared.status !== "prepared") throw Error("unreachable");
      const result = await manager.executePrepared(prepared.action, { authorization: { preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint, grantId: `qualification-${name}` },
        stagedFiles: Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.from(content) })) });
      report.cases.push({ name, files, profile, prepared, result });
      observed.push(result.status);
    }
    assert.deepEqual(observed, ["verified", "failed", "failed"]);
  } catch (error) { report.error = String(error); throw error; }
  finally {
    await mkdir(".cache/cip4-full-validation", { recursive: true });
    await writeFile(`.cache/cip4-full-validation/native-${Date.now()}.json`, JSON.stringify({ ...report, captured, endedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  }
});
