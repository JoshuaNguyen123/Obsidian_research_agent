import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeWorkspaceRelativePath,
  ensureCodeWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../src/agent/codeWorkspace";
import { __setNodeRequireForTests } from "../src/platform/nodeRequire";

test("code workspace rejects unsafe paths", () => {
  assert.throws(() => assertSafeWorkspaceRelativePath("../x"), /Unsafe/);
  assert.throws(() => assertSafeWorkspaceRelativePath("C:/x"), /Unsafe/);
  assert.throws(() => assertSafeWorkspaceRelativePath("folder\\x"), /Unsafe/);
});

test("code workspace writes reads and lists safe files", async () => {
  __setNodeRequireForTests(require);
  const workspace = await ensureCodeWorkspace(`test-${Date.now()}`);
  const write = await writeWorkspaceFile(workspace, "src/main.txt", "hello");
  const read = await readWorkspaceFile(workspace, "src/main.txt");
  const files = await listWorkspaceFiles(workspace);

  assert.equal(write.path, "src/main.txt");
  assert.equal(read.content, "hello");
  assert.deepEqual(files.map((file) => file.path), ["src/main.txt"]);

  await writeWorkspaceFile(workspace, "src/main.txt", "hello hello");
  const replacedOnce = (await readWorkspaceFile(workspace, "src/main.txt")).content.replace(
    "hello",
    "hi",
  );
  assert.equal(replacedOnce, "hi hello");
  const replacedAll = "hello hello".split("hello").join("hi");
  assert.equal(replacedAll, "hi hi");
  __setNodeRequireForTests(undefined);
});

test("MAX_CODE_RUNS_PER_MISSION default is 16", async () => {
  const { MAX_CODE_RUNS_PER_MISSION } = await import("../src/tools/constants");
  assert.equal(MAX_CODE_RUNS_PER_MISSION, 16);
});
