import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  executeCodeWorkerTool,
  resolveCodeWorkerPath,
  runCodeWorker,
} from "../src/orchestrator/codeWorker";

test("code worker rejects worktree escapes and non-text extensions", () => {
  const root = join(tmpdir(), "code-worker-root");
  assert.throws(() => resolveCodeWorkerPath(root, "../outside.ts"), /escapes/);
  assert.throws(() => resolveCodeWorkerPath(root, "bin.exe"), /extension/);
});

test("code worker performs exact worktree-confined replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-worker-"));
  try {
    await writeFile(join(root, "sample.ts"), "export const value = 1;\n", "utf8");
    const changed = new Set<string>();
    const result = await executeCodeWorkerTool({
      root,
      changed,
      call: {
        name: "code_replace_text",
        arguments: {
          path: "sample.ts",
          oldText: "value = 1",
          newText: "value = 2",
        },
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual([...changed], ["sample.ts"]);
    assert.match(await readFile(join(root, "sample.ts"), "utf8"), /value = 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code worker blocks edits to execution-control files and scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-worker-controls-"));
  try {
    await writeFile(join(root, "package.json"), '{"name":"safe"}\n', "utf8");
    await mkdir(join(root, "scripts"));
    const packageResult = await executeCodeWorkerTool({
      root,
      call: {
        name: "code_write_file",
        arguments: { path: "package.json", content: '{"scripts":{"test":"calc"}}' },
      },
    });
    const scriptResult = await executeCodeWorkerTool({
      root,
      call: {
        name: "code_write_file",
        arguments: { path: "scripts/validate.ts", content: "process.exit(0);" },
      },
    });
    const configResult = await executeCodeWorkerTool({
      root,
      call: {
        name: "code_write_file",
        arguments: { path: "esbuild.config.mjs", content: "process.exit(0);" },
      },
    });
    assert.equal(packageResult.ok, false);
    assert.equal(scriptResult.ok, false);
    assert.equal(configResult.ok, false);
    assert.match(await readFile(join(root, "package.json"), "utf8"), /safe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code worker rejects writes through symbolic links or junctions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "code-worker-links-"));
  const outside = await mkdtemp(join(tmpdir(), "code-worker-outside-"));
  try {
    try {
      await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String((error as { code?: unknown }).code))
      ) {
        t.skip("This filesystem does not permit test symlink creation.");
        return;
      }
      throw error;
    }
    const result = await executeCodeWorkerTool({
      root,
      call: {
        name: "code_write_file",
        arguments: { path: "linked/escaped.ts", content: "outside" },
      },
    });
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? "" : result.error?.message ?? "",
      /symbolic links|junctions|outside/i,
    );
    await assert.rejects(readFile(join(outside, "escaped.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("code worker observes cancellation between batched mutation calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-worker-abort-"));
  const controller = new AbortController();
  try {
    await assert.rejects(
      runCodeWorker({
        runId: "run-abort",
        participantId: "code_worker",
        leadParticipantId: "lead",
        taskId: "task",
        assignment: "Make two files",
        worktreePath: root,
        abortSignal: controller.signal,
        modelClient: {
          chat: async () => ({
            message: { role: "assistant", content: "" },
            toolCalls: [
              {
                id: "one",
                name: "code_write_file",
                arguments: { path: "one.ts", content: "export const one = 1;" },
              },
              {
                id: "two",
                name: "code_write_file",
                arguments: { path: "two.ts", content: "export const two = 2;" },
              },
            ],
          }),
          streamChat: async () => {
            throw new Error("unused");
          },
        },
        events: {
          onFileChanged: () => controller.abort(),
        },
      }),
      /cancelled/i,
    );
    assert.match(await readFile(join(root, "one.ts"), "utf8"), /one/);
    await assert.rejects(readFile(join(root, "two.ts"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
