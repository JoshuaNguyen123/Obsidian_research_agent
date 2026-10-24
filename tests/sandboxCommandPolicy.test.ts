import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_SANDBOX_RUN_INSTALL_REFUSAL_V1,
  CODE_SANDBOX_RUN_PROGRAMS_V1,
  codeSandboxRunLineV1,
  codeSandboxRunPolicyV1,
  type CodeSandboxRunRequestV1,
} from "../extensions/code/sandbox/SandboxCommandPolicyV1";

/*
 * The core's mirror of the host's command policy (CODE-17 under CODE-16's
 * review). The cases are the host's tests/commandPolicy.test.ts, at the argv
 * level the agent's tool takes: a line is never split here, so the splitter's
 * cases (pipes, variables, wildcards) are arguments the program receives as
 * written, and only the program, argument, install, folder and time rules
 * apply.
 */

const policy = (argv: string[], extra: Omit<CodeSandboxRunRequestV1, "argv"> = {}) =>
  codeSandboxRunPolicyV1({ argv, ...extra });

test("the program is a bare name from the list; a shell, a launcher and a path are refused with the reason", () => {
  assert.deepEqual([...CODE_SANDBOX_RUN_PROGRAMS_V1], ["node", "npm", "python", "python3"]);
  for (const program of CODE_SANDBOX_RUN_PROGRAMS_V1) assert.equal(policy([program, "--version"]).ok, true, program);
  for (const [argv, pattern] of [
    [["sh", "-c", "npm test"], /sh is a shell/u],
    [["bash", "run.sh"], /bash is a shell/u],
    [["env", "node", "x.js"], /runs another program/u],
    [["xargs", "node"], /runs another program/u],
    [["sudo", "npm", "test"], /as another user/u],
    [["npx", "jest"], /npm exec/u],
    [["pip", "install", "requests"], /installing needs the network/u],
    [["/bin/sh", "-c", "x"], /not a path/u],
    [["./node_modules/.bin/jest"], /not a path/u],
    [["C:/Python/python.exe", "x.py"], /not a path/u],
    [["ruby", "x.rb"], /not a program the sandbox runs/u],
    [["PowerShell.exe", "-c", "x"], /is a shell/u],
  ] as const) {
    const decision = policy([...argv]);
    assert.equal(decision.ok, false, argv.join(" "));
    if (!decision.ok) {
      assert.equal(decision.code, "command_program", argv.join(" "));
      assert.match(decision.reason, pattern, argv.join(" "));
    }
  }
});

test("running code is the point: -e, -c, npm run and npm exec are admitted, under the program's ecosystem", () => {
  const python = policy(["python3", "-c", "print(1+1)"]);
  assert.ok(python.ok);
  if (python.ok) {
    assert.deepEqual(python.command, { executable: "python3", args: ["-c", "print(1+1)"], cwd: ".", timeoutMs: 120_000, ecosystem: "python" });
  }
  const node = policy(["node", "-e", "console.log(2)"], { cwd: "packages/app", timeoutSeconds: 30 });
  assert.ok(node.ok);
  if (node.ok) {
    assert.deepEqual(node.command, { executable: "node", args: ["-e", "console.log(2)"], cwd: "packages/app", timeoutMs: 30_000, ecosystem: "node" });
  }
  for (const argv of [["npm", "run", "test"], ["npm", "test"], ["npm", "exec", "--", "tsc", "--noEmit"], ["python3", "-m", "pytest", "-q"]]) {
    assert.equal(policy(argv).ok, true, argv.join(" "));
  }
  // An argv is never a shell line: what a shell would read is the program's text.
  for (const argv of [["python3", "-c", "print('a|b > c')"], ["node", "-e", "console.log(1 && 2)"], ["python3", "-m", "pytest", "tests/*.py"]]) {
    const decision = policy(argv);
    assert.ok(decision.ok, argv.join(" "));
    if (decision.ok) assert.deepEqual(decision.command.args, argv.slice(1));
  }
});

test("installs are refused, since the sandbox has no network", () => {
  for (const argv of [
    ["npm", "install"],
    ["npm", "i", "left-pad"],
    ["npm", "ci"],
    ["npm", "add", "x"],
    ["npm", "update"],
    ["npm", "--silent", "install"],
    ["python3", "-m", "pip", "install", "requests"],
    ["python", "-m", "pip", "download", "x"],
    ["python3", "-m", "ensurepip"],
  ]) {
    const decision = policy(argv);
    assert.equal(decision.ok, false, argv.join(" "));
    if (!decision.ok) {
      assert.equal(decision.code, "command_install", argv.join(" "));
      assert.equal(decision.reason, CODE_SANDBOX_RUN_INSTALL_REFUSAL_V1);
    }
  }
  assert.equal(policy(["python3", "-m", "pip", "list"]).ok, true, "pip that reads is not an install");
  assert.equal(policy(["npm", "ls"]).ok, true);
});

test("the provider's refused arguments, the length limits, the working folder and the time limit", () => {
  const verbose = policy(["python3", "-m", "unittest", "-v"]);
  assert.equal(verbose.ok, false);
  if (!verbose.ok) {
    assert.equal(verbose.code, "command_sandbox_argument");
    assert.match(verbose.reason, /--verbose/u);
  }
  assert.equal(policy(["node", "/"]).ok, false);
  assert.equal(policy(["node", "--privileged"]).ok, false);
  assert.equal(policy(["node", "/var/run/docker.sock"]).ok, false);
  assert.equal(policy(["node", ...Array.from({ length: 65 }, () => "x")]).ok, false);
  assert.equal(policy(["node", ...Array.from({ length: 64 }, () => "x")]).ok, true);
  assert.equal(policy(["node", "x".repeat(501)]).ok, false);
  assert.equal(policy(["node", "a\nb"]).ok, false);
  const empty = policy(["python3", "-c", ""]);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "command_args");
  for (const cwd of ["../outside", "/etc", "C:/x", "~", "src/../..", ".git", "src/.git"]) {
    const decision = policy(["node", "x.js"], { cwd });
    assert.equal(decision.ok, false, cwd);
    if (!decision.ok) assert.equal(decision.code, "command_cwd", cwd);
  }
  const nested = policy(["node", "x.js"], { cwd: "./src\\lib" });
  assert.ok(nested.ok);
  if (nested.ok) assert.equal(nested.command.cwd, "src/lib");
  // The agent's tool stops at ten minutes; the person's tab goes to thirty.
  for (const timeoutSeconds of [0, 601, Number.NaN, "soon"]) {
    const decision = policy(["node", "x.js"], { timeoutSeconds });
    assert.equal(decision.ok, false, String(timeoutSeconds));
    if (!decision.ok) assert.equal(decision.code, "command_timeout");
  }
  assert.equal(policy(["node", "x.js"], { timeoutSeconds: 600 }).ok, true);
  assert.equal(codeSandboxRunPolicyV1({ argv: ["node", "x.js"], timeoutSeconds: 1_800 }, { maxTimeoutSeconds: 1_800 }).ok, true);
  for (const argv of [[], [""], ["node", 1 as unknown as string]]) {
    const decision = policy(argv as string[]);
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, "command_empty");
  }
});

test("a command is written back as a person would type it", () => {
  assert.equal(codeSandboxRunLineV1(["python3", "-m", "pytest", "-q", "tests/test_x.py"]), "python3 -m pytest -q tests/test_x.py");
  assert.equal(codeSandboxRunLineV1(["python3", "-c", "print('a b')"]), "python3 -c 'print('\\''a b'\\'')'");
  assert.equal(codeSandboxRunLineV1(["python3", ""]), "python3 ''");
});
