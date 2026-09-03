import assert from "node:assert/strict";
import test from "node:test";
import {
  appendToCurrentFileTool,
  noteTailHasExactAppendedBlock,
  resetAppendIdempotencyStateForTests,
  resolveAppendOperationIdentity,
} from "../src/tools/vaultTools";
import type { ToolExecutionContext } from "../src/tools/types";

type AppendReceipt = {
  path?: string;
  operation?: string;
  bytesWritten?: number;
  reason?: string;
  duplicateSkip?: boolean;
};

function asAppendReceipt(value: unknown): AppendReceipt {
  return value as AppendReceipt;
}

test("append identity requires run/root plus operation id and never keys on content alone", () => {
  assert.equal(resolveAppendOperationIdentity({}), null);
  assert.equal(resolveAppendOperationIdentity({ runId: "run-a" }), null);
  assert.equal(
    resolveAppendOperationIdentity({ operationId: "run-a:1:0:append_to_current_file" }),
    null,
  );
  assert.equal(
    resolveAppendOperationIdentity({
      runId: "run-a",
      operationId: "run-a:1:0:append_to_current_file",
    }),
    "run-a::run-a:1:0:append_to_current_file",
  );
  assert.equal(
    resolveAppendOperationIdentity({
      runId: "segment-2",
      rootMissionId: "root-1",
      operationId: "root-1:write-node:append_to_current_file",
    }),
    "root-1::root-1:write-node:append_to_current_file",
  );
});

test("tail compare only inspects the last block-length characters", () => {
  const block = "APPEND_BLOCK";
  assert.equal(noteTailHasExactAppendedBlock(`prefix\n${block}`, block), true);
  assert.equal(noteTailHasExactAppendedBlock(`${block}\nnot-at-tail`, block), false);
  assert.equal(noteTailHasExactAppendedBlock(block.slice(1), block), false);
  assert.equal(noteTailHasExactAppendedBlock("", block), false);
});

test("same-identity retry of append_to_current_file skips a second write", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  const identity = {
    runId: "run-append-1",
    operationId: "run-append-1:2:0:append_to_current_file",
  };
  const first = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      { ...mock.context, ...identity },
    ),
  );
  assert.equal((first.bytesWritten ?? 0) > 0, true);
  assert.equal(first.reason, undefined);
  assert.equal(mock.content.get("Current.md"), "Initial note\nDurable mutation proof");
  assert.equal(mock.modifies, 1);

  const retry = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      { ...mock.context, ...identity },
    ),
  );
  assert.equal(retry.path, "Current.md");
  assert.equal(retry.operation, "append_to_current_file");
  assert.equal(retry.bytesWritten, 0);
  assert.equal(retry.reason, "duplicate-skip");
  assert.equal(retry.duplicateSkip, true);
  assert.equal(mock.content.get("Current.md"), "Initial note\nDurable mutation proof");
  assert.equal(mock.modifies, 1);
});

test("a second mission with the same line still appends", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  await appendToCurrentFileTool.execute(
    { text: "Same line" },
    {
      ...mock.context,
      runId: "mission-1",
      operationId: "mission-1:1:0:append_to_current_file",
    },
  );
  const second = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Same line" },
      {
        ...mock.context,
        runId: "mission-2",
        operationId: "mission-2:1:0:append_to_current_file",
      },
    ),
  );
  assert.equal(second.reason, undefined);
  assert.equal((second.bytesWritten ?? 0) > 0, true);
  assert.equal(
    mock.content.get("Current.md"),
    "Initial note\nSame line\nSame line",
  );
  assert.equal(mock.modifies, 2);
});

test("same identity with a different payload still writes", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  const identity = {
    runId: "run-append-diff",
    operationId: "run-append-diff:1:0:append_to_current_file",
  };
  await appendToCurrentFileTool.execute(
    { text: "First block" },
    { ...mock.context, ...identity },
  );
  const second = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Second block" },
      { ...mock.context, ...identity },
    ),
  );
  assert.equal(second.reason, undefined);
  assert.equal((second.bytesWritten ?? 0) > 0, true);
  assert.equal(
    mock.content.get("Current.md"),
    "Initial note\nFirst block\nSecond block",
  );
});

test("same identity rewrites when the note tail no longer matches", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  const identity = {
    runId: "run-append-edited",
    operationId: "run-append-edited:1:0:append_to_current_file",
  };
  await appendToCurrentFileTool.execute(
    { text: "Durable mutation proof" },
    { ...mock.context, ...identity },
  );
  mock.content.set("Current.md", "User edited the tail away");
  const retry = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      { ...mock.context, ...identity },
    ),
  );
  assert.equal(retry.reason, undefined);
  assert.equal((retry.bytesWritten ?? 0) > 0, true);
  assert.equal(
    mock.content.get("Current.md"),
    "User edited the tail away\nDurable mutation proof",
  );
});

test("content-only repeats without operation identity still write", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note\nAlready there",
  });
  const first = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Already there" },
      mock.context,
    ),
  );
  assert.equal(first.reason, undefined);
  assert.equal((first.bytesWritten ?? 0) > 0, true);
  assert.equal(
    mock.content.get("Current.md"),
    "Initial note\nAlready there\nAlready there",
  );
});

function createAppendVaultContext(options: {
  prompt: string;
  initial: string;
}): {
  context: ToolExecutionContext;
  content: Map<string, string>;
  modifies: number;
} {
  const content = new Map<string, string>([["Current.md", options.initial]]);
  let modifies = 0;
  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: "Current",
          extension: "md",
        }
      : null;
  const context: ToolExecutionContext = {
    app: {
      workspace: {
        getActiveFile: () => getFile("Current.md"),
      },
      vault: {
        read: async (file: { path: string }) => content.get(file.path) ?? "",
        modify: async (file: { path: string }, data: string) => {
          modifies += 1;
          content.set(file.path, data);
        },
        getFileByPath: getFile,
        getFolderByPath: () => null,
        getAbstractFileByPath: (path: string) => getFile(path),
        getAllLoadedFiles: () => [getFile("Current.md")!],
      },
    } as never,
    settings: {
      modelProvider: "ollama",
      researchMemoryEnabled: false,
    } as never,
    originalPrompt: options.prompt,
    httpTransport: async () => ({
      status: 500,
      headers: {},
      json: { error: "not mocked" },
    }),
    now: () => new Date("2026-09-02T12:00:00.000Z"),
  };
  return {
    context,
    content,
    get modifies() {
      return modifies;
    },
  };
}
