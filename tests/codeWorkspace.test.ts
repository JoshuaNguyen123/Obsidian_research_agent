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

test("replace_workspace_text fails closed when the replacement changes nothing", async () => {
  __setNodeRequireForTests(require);
  try {
    const { createCodeWorkspaceTools } = await import(
      "../src/tools/codeWorkspaceTools"
    );
    const tool = createCodeWorkspaceTools().find(
      (candidate) => candidate.name === "replace_workspace_text",
    );
    assert.ok(tool);
    const runId = `test-nsc-${Date.now()}`;
    const workspace = await ensureCodeWorkspace(runId);
    await writeWorkspaceFile(workspace, "src/app.js", "let x = 1;\nlet y = 1;\n");
    const context = {
      runId,
      originalPrompt: "Update the code in my workspace file.",
    } as unknown as import("../src/tools/types").ToolExecutionContext;

    // find === replace rewrites identical bytes: no state change, so the
    // tool must fail closed (github_no_state_change semantics) instead of
    // minting a vacuous write receipt.
    await assert.rejects(
      () =>
        tool!.execute(
          { path: "src/app.js", find: "let x", replace: "let x" },
          context,
        ),
      (error: unknown) => {
        const failure = error as { code?: string; message?: string };
        assert.equal(failure.code, "workspace_no_state_change");
        assert.match(failure.message ?? "", /would not change/i);
        return true;
      },
    );
    // The file is untouched and a real replacement still works.
    assert.equal(
      (await readWorkspaceFile(workspace, "src/app.js")).content,
      "let x = 1;\nlet y = 1;\n",
    );
    const changed = (await tool!.execute(
      { path: "src/app.js", find: "let x", replace: "let z" },
      context,
    )) as { replacements: number; bytesWritten: number };
    assert.equal(changed.replacements, 1);
    assert.ok(changed.bytesWritten > 0);
  } finally {
    __setNodeRequireForTests(undefined);
  }
});
