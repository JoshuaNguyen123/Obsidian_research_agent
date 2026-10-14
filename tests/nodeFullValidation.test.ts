import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";

function profile(manager: "npm" | "pnpm" | "yarn" = "npm") {
  const lock = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" }[manager];
  return detectRepositoryProfileV2({ key: "checks", displayName: "Checks", repositoryRoot: "/repo", defaultBranch: "main",
    files: ["package.json", lock, ".node-version"], fileContents: { ".node-version": "22.11.0" } });
}

function full(statuses: Array<{ status: number | null; error?: Error; signal?: string }>, manager: "npm" | "pnpm" | "yarn" = "npm") {
  const command = profile(manager).validationCatalog.find(row => row.phase === "full")!;
  assert.equal(command.executable, "node", "full validation must compose tests and build, not select build alone");
  assert.equal(command.args[0], "--input-type=commonjs");
  assert.equal(command.args[1], "-e");
  const calls: unknown[] = [], output: string[] = [];
  let exit = 0;
  const stop = {};
  try {
    runInNewContext(command.args[2], {
      require: (name: string) => {
        assert.equal(name, "node:child_process");
        return { spawnSync: (executable: string, args: string[], options: unknown) => {
          calls.push(JSON.parse(JSON.stringify({ executable, args, options })));
          return statuses[calls.length - 1] ?? { status: 0 };
        } };
      },
      process: { argv: ["node", ...command.args.slice(3)], exit: (code: number) => { exit = code; throw stop; } },
      console: { log: (text: string) => output.push(text) },
    }, { timeout: 1000 });
  } catch (error) { if (error !== stop) throw error; }
  return { calls, output, exit };
}

test("Node targeted validation runs tests explicitly for every detected package manager", () => {
  for (const manager of ["npm", "pnpm", "yarn"] as const) {
    const commands = profile(manager).validationCatalog;
    const targeted = commands.find(row => row.phase === "targeted");
    assert.ok(targeted, "targeted validation cannot fall back to build");
    assert.equal(targeted.executable, manager);
    assert.deepEqual(targeted.args, ["run", "test"]);
    assert.equal(targeted.network, "disabled");
    assert.equal(targeted.credentialPolicy, "none");
  }
});

test("Node full validation executes tests then build with bounded shell-free child processes", () => {
  for (const manager of ["npm", "pnpm", "yarn"] as const) {
    const result = full([{ status: 0 }, { status: 0 }], manager);
    assert.equal(result.exit, 0);
    assert.deepEqual(result.calls, ["test", "build"].map(script => ({ executable: manager, args: ["run", script],
      options: { shell: false, stdio: "inherit", timeout: 300000, killSignal: "SIGKILL" } })));
    assert.deepEqual(result.output, [`[validation] ${manager} run test`, `[validation] ${manager} run build`]);
  }
});

test("Node full validation never hides failed, missing, timed-out or signalled checks", () => {
  for (const failure of [{ status: 7 }, { status: null, error: new Error("missing executable") }, { status: null, signal: "SIGKILL" }]) {
    const first = full([failure, { status: 0 }]);
    assert.notEqual(first.exit, 0);
    assert.equal(first.calls.length, 1, "a failed test ends validation before build");
    const second = full([{ status: 0 }, failure]);
    assert.notEqual(second.exit, 0);
    assert.equal(second.calls.length, 2);
  }
});
