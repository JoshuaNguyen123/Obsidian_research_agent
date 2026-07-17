import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  GitWorktreeManager,
  createNodeValidationProfile,
  type GitCommandExecutor,
  type ManagedGitWorktree,
} from "../src/orchestrator/gitWorktreeManager";

const WORKER_SHA = "a".repeat(40);
const INTEGRATION_SHA = "b".repeat(40);

test("Git operations disable hooks and integration returns the cherry-pick SHA", async () => {
  const calls: string[][] = [];
  const executor: GitCommandExecutor = async ({ args }) => {
    calls.push([...args]);
    if (args.includes("rev-parse")) {
      return { exitCode: 0, stdout: `${INTEGRATION_SHA}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const manager = new GitWorktreeManager(executor);
  const actual = await manager.integrateCommit({
    integration: worktree("C:\\safe\\integration"),
    commitSha: WORKER_SHA,
  });

  assert.equal(actual, INTEGRATION_SHA);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.equal(args[0], "-c");
    assert.ok(args.some((arg) => arg.startsWith("core.hooksPath=")));
    assert.ok(args.includes("core.fsmonitor=false"));
    assert.ok(args.includes("commit.gpgSign=false"));
  }
  assert.ok(calls[0].includes("cherry-pick"));
});

test("legacy native validation is retired without running lifecycle scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-validation-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "orchestrator-validation-test",
        version: "1.0.0",
        scripts: {
          preinstall: "node -e \"require('fs').writeFileSync('lifecycle-ran.txt','bad')\"",
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "orchestrator-validation-test",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "orchestrator-validation-test",
            version: "1.0.0",
            hasInstallScript: true,
          },
        },
      }),
      "utf8",
    );
    const executor: GitCommandExecutor = async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const manager = new GitWorktreeManager(executor);
    const validationCommands = [
      { command: "node", args: ["-e", "process.exit(0)"], label: "direct node check" },
    ];
    await assert.rejects(
      manager.runValidationCommands({
        worktree: worktree(root),
        validationCommands,
        profile: createNodeValidationProfile(validationCommands),
      }),
      /Native repository validation is disabled/u,
    );
    await assert.rejects(readFile(join(root, "lifecycle-ran.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation profile rejects worker changes to protected controls", async () => {
  const executor: GitCommandExecutor = async ({ args }) => ({
    exitCode: 0,
    stdout: args.includes("status") ? " M package.json\n" : "",
    stderr: "",
  });
  const manager = new GitWorktreeManager(executor);
  const validationCommands = [
    { command: "node", args: ["-e", "process.exit(0)"], label: "direct node check" },
  ];
  await assert.rejects(
    manager.runValidationCommands({
      worktree: worktree("C:\\safe\\worker"),
      validationCommands,
      profile: createNodeValidationProfile(validationCommands),
    }),
    /Native repository validation is disabled/i,
  );
});

test("validation profile rejects worker changes to local GitHub Actions", async () => {
  const executor: GitCommandExecutor = async ({ args }) => ({
    exitCode: 0,
    stdout: args.includes("status") ? " M .github/actions/setup/action.yml\n" : "",
    stderr: "",
  });
  const manager = new GitWorktreeManager(executor);
  const validationCommands = [
    { command: "node", args: ["-e", "process.exit(0)"], label: "direct node check" },
  ];
  await assert.rejects(
    manager.runValidationCommands({
      worktree: worktree("C:\\safe\\worker"),
      validationCommands,
      profile: createNodeValidationProfile(validationCommands),
    }),
    /Native repository validation is disabled/i,
  );
});

test("commit refuses files introduced by validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-validation-drift-"));
  let statusCalls = 0;
  let addCalled = false;
  try {
    const executor: GitCommandExecutor = async ({ args }) => {
      if (args.includes("status")) {
        statusCalls += 1;
        return {
          exitCode: 0,
          stdout: statusCalls === 1
            ? " M src/example.ts\n"
            : " M src/example.ts\n?? build/generated.js\n",
          stderr: "",
        };
      }
      if (args.includes("add")) addCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new GitWorktreeManager(executor);
    await assert.rejects(
      manager.commitGreenWorktree({
        worktree: worktree(root),
        message: "scoped change",
        validationCommands: [
          { command: "node", args: ["-e", "process.exit(0)"], label: "direct check" },
        ],
      }),
      /Native repository validation is disabled/i,
    );
    assert.equal(addCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy commit path cannot bypass retired native validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-validation-generated-"));
  let fullStatusCalls = 0;
  try {
    const executor: GitCommandExecutor = async ({ args }) => {
      if (args.includes("status")) {
        if (args.includes("--")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        fullStatusCalls += 1;
        return {
          exitCode: 0,
          stdout: fullStatusCalls === 1
            ? " M src/example.ts\n"
            : " M src/example.ts\n M main.js\n",
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) {
        return { exitCode: 0, stdout: `${INTEGRATION_SHA}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const manager = new GitWorktreeManager(executor);
    const validationCommands = [
      { command: "node", args: ["-e", "process.exit(0)"], label: "direct check" },
    ];
    await assert.rejects(
      manager.commitGreenWorktree({
        worktree: worktree(root),
        message: "scoped change",
        validationCommands,
        profile: {
          id: "generated-main-js",
          bootstrapCommands: [],
          validationCommands,
          protectedPaths: ["package.json"],
          allowedGeneratedPaths: ["main.js"],
        },
      }),
      /Native repository validation is disabled/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function worktree(path: string): ManagedGitWorktree {
  return {
    id: "run:task",
    taskId: "task",
    repositoryRoot: path,
    path,
    branch: "codex/agent-run-task",
    baseBranch: "main",
    baseSha: "c".repeat(40),
    baseWasClean: true,
  };
}
