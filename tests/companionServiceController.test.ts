import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

interface Materialization {
  runtimeRoot: string;
  bundleHash: string;
  fileHashes: Record<string, string>;
}

interface Controller {
  controlScriptPath: string;
  runtimeRoot: string;
  codeApplicationDataRoot: string;
  materializeRuntime(): Materialization;
  install(): Promise<Record<string, unknown>>;
  connectCredential(): Promise<{
    withToken<T>(use: (token: string) => Promise<T>): Promise<T>;
    dispose(): void;
  }>;
}

interface ControllerConstructor {
  new (options: {
    dataDir?: string;
    applicationDataRoot?: string;
    runtimeAssets?: Readonly<Record<string, string>>;
    port?: number;
    pythonCommands?: Array<{ executable: string; args: string[] }>;
  }): Controller;
}

test("companion and Code runtime defaults resolve the identical Code application-data root", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-companion-default-root-"));
  try {
    const Controller = await loadBundledController(fixtureRoot);
    const controller = new Controller({});
    const workspaceManager = new WorkspaceManagerV2();
    assert.equal(
      path.resolve(controller.codeApplicationDataRoot),
      path.resolve(workspaceManager.applicationDataRoot),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("companion controller hash-materializes sibling-artifact runtime assets under application data", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-companion-runtime-"));
  try {
    const Controller = await loadBundledController(fixtureRoot);
    // Production path: the assets live in companion-assets.json next to the
    // installed bundle, never inside it.
    await copyFile(
      path.resolve("companion-assets.json"),
      path.join(fixtureRoot, "companion-assets.json"),
    );
    const dataDir = path.join(fixtureRoot, "data");
    const controller = new Controller({ dataDir, applicationDataRoot: fixtureRoot });
    const materialized = controller.materializeRuntime();
    const manifest = JSON.parse(
      await readFile(
        path.resolve("extensions", "companion", "generated", "runtime-assets-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(materialized.bundleHash, manifest.bundleHash);

    assert.ok(isWithin(dataDir, materialized.runtimeRoot));
    assert.equal(materialized.runtimeRoot, controller.runtimeRoot);
    assert.match(materialized.bundleHash, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Object.keys(materialized.fileHashes).length >= 10);
    assert.ok(materialized.fileHashes["companion_control.py"]);
    assert.ok(materialized.fileHashes["server.py"]);
    assert.ok(materialized.fileHashes["requirements.txt"]);
    assert.ok(materialized.fileHashes["standalone-worker.cjs"]);

    for (const [relativePath, expectedHash] of Object.entries(
      materialized.fileHashes,
    )) {
      const installedPath = path.resolve(materialized.runtimeRoot, relativePath);
      assert.ok(isWithin(materialized.runtimeRoot, installedPath));
      assert.equal(sha256(await readFile(installedPath)), expectedHash);
    }

    await writeFile(controller.controlScriptPath, "tampered runtime", "utf8");
    assert.notEqual(
      sha256(await readFile(controller.controlScriptPath)),
      materialized.fileHashes["companion_control.py"],
    );
    const repaired = controller.materializeRuntime();
    assert.equal(repaired.bundleHash, materialized.bundleHash);
    assert.equal(
      sha256(await readFile(controller.controlScriptPath)),
      materialized.fileHashes["companion_control.py"],
    );

    const unsafeData = path.join(fixtureRoot, "unsafe-data");
    const unsafe = new Controller({
      dataDir: unsafeData,
      applicationDataRoot: fixtureRoot,
      runtimeAssets: { "../escape.py": "print('escape')\n" },
    });
    assert.throws(
      () => unsafe.materializeRuntime(),
      /unsafe asset path|escaped its materialization root/u,
    );
    await assert.rejects(readFile(path.join(unsafeData, "runtime", "escape.py")));

    await assertSymlinkAssetRejected(Controller, fixtureRoot);
    await assertSwappedRootRejected(Controller, fixtureRoot);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a missing sibling artifact disables the companion with a reinstall instruction", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-companion-missing-"));
  try {
    const Controller = await loadBundledController(fixtureRoot);
    // BRAT/manual installs historically copy only main.js, styles.css, and
    // manifest.json. Construction and runtime identity must still work — the
    // hashes are bundled — and only materialization fails, with a clear
    // actionable message instead of a crash.
    const controller = new Controller({
      dataDir: path.join(fixtureRoot, "data"),
      applicationDataRoot: fixtureRoot,
    });
    assert.match(controller.runtimeRoot, /runtime[\\/]v1-[a-f0-9]{16}$/u);
    assert.throws(
      () => controller.materializeRuntime(),
      /companion-assets\.json" was not found[\s\S]*Reinstall the plugin with its complete artifact set/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a stale or tampered sibling artifact fails closed before any write", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-companion-stale-"));
  try {
    const Controller = await loadBundledController(fixtureRoot);
    const artifact = JSON.parse(
      await readFile(path.resolve("companion-assets.json"), "utf8"),
    );
    artifact.files["auth.py"] = `${artifact.files["auth.py"]}\n# tampered`;
    await writeFile(
      path.join(fixtureRoot, "companion-assets.json"),
      JSON.stringify(artifact),
      "utf8",
    );
    const controller = new Controller({
      dataDir: path.join(fixtureRoot, "data"),
      applicationDataRoot: fixtureRoot,
    });
    assert.throws(
      () => controller.materializeRuntime(),
      /"auth\.py" asset does not match this plugin build[\s\S]*Reinstall the plugin/u,
    );
    // No runtime content may be written from unverified assets.
    await assert.rejects(readFile(path.join(fixtureRoot, "data", "runtime")));

    // A whole-artifact swap from a different build is rejected on the bundle
    // hash before any per-file work.
    artifact.bundleHash = "sha256:" + "0".repeat(64);
    await writeFile(
      path.join(fixtureRoot, "companion-assets.json"),
      JSON.stringify(artifact),
      "utf8",
    );
    const second = new Controller({
      dataDir: path.join(fixtureRoot, "data-second"),
      applicationDataRoot: fixtureRoot,
    });
    assert.throws(
      () => second.materializeRuntime(),
      /belongs to a different plugin build/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("constructing the controller never reads or hashes the bundled runtime assets", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-companion-lazy-"));
  try {
    const Controller = await loadBundledController(fixtureRoot);
    let assetReads = 0;
    const recordingAssets = new Proxy(
      { "companion_control.py": "print('safe')\n" },
      {
        get(target, property, receiver) {
          if (typeof property === "string" && property in target) {
            assetReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
        ownKeys(target) {
          assetReads += 1;
          return Reflect.ownKeys(target);
        },
      },
    );
    const controller = new Controller({
      dataDir: path.join(fixtureRoot, "data"),
      applicationDataRoot: fixtureRoot,
      runtimeAssets: recordingAssets,
    });
    assert.equal(
      assetReads,
      0,
      "plugin load must not pay the ~950 KB asset hash walk",
    );
    assert.match(controller.runtimeRoot, /runtime/u);
    assert.ok(
      assetReads > 0,
      "first runtime-identity access performs the deferred hash walk",
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("companion controller passes exact approved-root argv to service and token commands", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agentic-companion-argv-"));
  try {
    const Controller = await loadBundledController(fixtureRoot);
    await copyFile(
      path.resolve("companion-assets.json"),
      path.join(fixtureRoot, "companion-assets.json"),
    );
    const capturePath = path.join(fixtureRoot, "argv.jsonl");
    const helperPath = path.join(fixtureRoot, "fake-python.cjs");
    await writeFile(
      helperPath,
      `const fs=require("node:fs");\nconst [capture,...forwarded]=process.argv.slice(2);\nfs.appendFileSync(capture,JSON.stringify(forwarded)+"\\n");\nif(forwarded[1]==="token")process.stdout.write("fixture-bootstrap-token-0123456789abcdef");\nelse process.stdout.write(JSON.stringify({ok:true,platform:process.platform}));\n`,
      "utf8",
    );
    const dataDir = path.join(fixtureRoot, "approved", "data");
    const approvedRoot = path.join(fixtureRoot, "approved");
    const controller = new Controller({
      dataDir,
      applicationDataRoot: approvedRoot,
      port: 9876,
      pythonCommands: [{ executable: process.execPath, args: [helperPath, capturePath] }],
    });
    await controller.install();
    const credential = await controller.connectCredential();
    assert.equal(
      await credential.withToken(async (token) => token),
      "fixture-bootstrap-token-0123456789abcdef",
    );
    credential.dispose();
    const calls = (await readFile(capturePath, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0].slice(1, 8), [
      "install",
      "--data-dir",
      dataDir,
      "--approved-data-root",
      approvedRoot,
      "--port",
      "9876",
    ]);
    assert.ok(calls[0].includes("--node-executable"));
    assert.deepEqual(calls[1].slice(1), [
      "token",
      "--approved-data-root",
      approvedRoot,
      "--data-dir",
      dataDir,
    ]);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function loadBundledController(
  fixtureRoot: string,
): Promise<ControllerConstructor> {
  const outfile = path.join(fixtureRoot, "companion-controller.cjs");
  await build({
    entryPoints: [
      path.resolve("extensions", "companion", "CompanionServiceController.ts"),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    loader: {
      ".py": "text",
      ".txt": "text",
      ".html": "text",
    },
    logLevel: "silent",
  });
  const loaded = createRequire(import.meta.url)(outfile) as {
    CompanionServiceControllerV1?: ControllerConstructor;
  };
  assert.ok(loaded.CompanionServiceControllerV1);
  return loaded.CompanionServiceControllerV1;
}

async function assertSymlinkAssetRejected(
  Controller: ControllerConstructor,
  fixtureRoot: string,
) {
  const dataDir = path.join(fixtureRoot, "symlink-data");
  const controller = new Controller({
    dataDir,
    applicationDataRoot: fixtureRoot,
    runtimeAssets: { "companion_control.py": "print('safe')\n" },
  });
  await mkdir(controller.runtimeRoot, { recursive: true });
  const outside = path.join(fixtureRoot, "outside.py");
  await writeFile(outside, "outside\n", "utf8");
  try {
    await symlink(outside, controller.controlScriptPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return;
    }
    throw error;
  }
  assert.throws(
    () => controller.materializeRuntime(),
    /refuses symbolic-link (?:assets|or reparse-point parents)/u,
  );
  assert.equal((await readFile(outside, "utf8")), "outside\n");
}

async function assertSwappedRootRejected(
  Controller: ControllerConstructor,
  fixtureRoot: string,
) {
  const approvedRoot = path.join(fixtureRoot, "swapped-approved-root");
  const outside = path.join(fixtureRoot, "swapped-outside");
  const controller = new Controller({
    dataDir: path.join(approvedRoot, "data"),
    applicationDataRoot: approvedRoot,
    runtimeAssets: { "companion_control.py": "print('safe')\n" },
  });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, approvedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return;
    }
    throw error;
  }
  assert.throws(
    () => controller.materializeRuntime(),
    /symbolic-link|reparse-point/u,
  );
  await assert.rejects(readFile(path.join(outside, "data", "runtime", "companion_control.py")));
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
