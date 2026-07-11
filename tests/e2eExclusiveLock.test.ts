import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// @ts-ignore The production runner is an intentionally unbundled Node ESM script.
import { acquireE2eLock, resolveE2eLockPath } from "../scripts/run-e2e-exclusive.mjs";

const quietLogger = { warn() {} };

test("exclusive e2e lock rejects a live concurrent owner and releases cleanly", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-lock-test-"));
  const lockPath = path.join(tempRoot, "e2e.lock");
  try {
    const first = await acquireE2eLock({
      lockPath,
      waitMs: 0,
      playwrightArgs: ["--grep", "first"],
      log: quietLogger,
    });
    const metadata = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.playwrightArgs[1], "first");
    assert.match(metadata.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    await assert.rejects(
      acquireE2eLock({
        lockPath,
        waitMs: 20,
        pollMs: 10,
        log: quietLogger,
      }),
      /Timed out after 20 ms.*Owner PID.*Lock file:/,
    );

    await first.release();
    const second = await acquireE2eLock({
      lockPath,
      waitMs: 0,
      log: quietLogger,
    });
    await second.release();
    await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("exclusive e2e lock recovers only after its recorded owner exits", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-e2e-lock-test-"));
  const lockPath = path.join(tempRoot, "e2e.lock");
  try {
    const deadPid = await createExitedPid();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: 1,
        token: "stale-owner",
        pid: deadPid,
        hostname: os.hostname(),
        startedAt: new Date(0).toISOString(),
      })}\n`,
      "utf8",
    );

    const replacement = await acquireE2eLock({
      lockPath,
      waitMs: 0,
      log: quietLogger,
    });
    assert.equal(replacement.metadata.pid, process.pid);
    assert.notEqual(replacement.metadata.token, "stale-owner");
    await replacement.release();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("default e2e lock path coordinates all runs using the same CDP port", () => {
  const first = resolveE2eLockPath({ OBSIDIAN_CDP_PORT: "11223" });
  const second = resolveE2eLockPath({
    OBSIDIAN_CDP_PORT: "11223",
    OBSIDIAN_VAULT: "D:/another-vault",
  });
  assert.equal(first, second);
  assert.match(first, /obsidian-e2e-cdp-11223\.lock$/);
});

async function createExitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  return pid;
}
