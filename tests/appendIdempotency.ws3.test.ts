import assert from "node:assert/strict";
import test from "node:test";
import {
  appendIdempotencySnapshotVaultPath,
  appendToCurrentFileTool,
  applyAppendIdempotencySnapshotV1,
  noteTailHasExactAppendedBlock,
  resetAppendIdempotencyStateForTests,
  resolveAppendOperationIdentity,
  snapshotAppendIdempotencyV1,
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
  // The graph node outranks the per-step operation id: the runner mints
  // operationId as runId:step:toolIndex:tool, which changes on every retry
  // and every segment, so only the node makes a resumed append recognizable.
  assert.equal(
    resolveAppendOperationIdentity({
      runId: "segment-1",
      rootMissionId: "root-1",
      nodeId: "tool-03-append_to_current_file",
      operationId: "segment-1:2:0:append_to_current_file",
    }),
    "root-1::node:tool-03-append_to_current_file:append_to_current_file",
  );
  assert.equal(
    resolveAppendOperationIdentity({
      runId: "segment-2",
      rootMissionId: "root-1",
      missionGraphExecution: { nodeId: "tool-03-append_to_current_file" },
      operationId: "segment-2:1:0:append_to_current_file",
    }),
    "root-1::node:tool-03-append_to_current_file:append_to_current_file",
  );
  // A node without a durable id still yields nothing: content alone never keys.
  assert.equal(
    resolveAppendOperationIdentity({ nodeId: "tool-03-append_to_current_file" }),
    null,
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
  folders: Set<string>;
  modifies: number;
} {
  const content = new Map<string, string>([["Current.md", options.initial]]);
  const folders = new Set<string>();
  let modifies = 0;
  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? path,
          extension: path.split(".").pop() ?? "",
        }
      : null;
  const context: ToolExecutionContext = {
    app: {
      workspace: {
        getActiveFile: () => getFile("Current.md"),
      },
      vault: {
        read: async (file: { path: string }) => content.get(file.path) ?? "",
        process: async (file: { path: string }, transform: (current: string) => string) => {
          const next = transform(content.get(file.path) ?? "");
          await context.app.vault.modify(file as never, next);
          return next;
        },
        modify: async (file: { path: string }, data: string) => {
          if (file.path === "Current.md") {
            modifies += 1;
          }
          content.set(file.path, data);
        },
        create: async (path: string, data: string) => {
          content.set(path, data);
          return getFile(path);
        },
        createFolder: async (path: string) => {
          folders.add(path);
        },
        getFileByPath: getFile,
        getFolderByPath: (path: string) =>
          folders.has(path) ? { path } : null,
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
    folders,
    get modifies() {
      return modifies;
    },
  };
}

test("a retried append after segment turnover is skipped exactly once under its graph node", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  const first = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      {
        ...mock.context,
        runId: "segment-1",
        rootMissionId: "root-1",
        nodeId: "tool-03-append_to_current_file",
        operationId: "segment-1:2:0:append_to_current_file",
      },
    ),
  );
  assert.equal((first.bytesWritten ?? 0) > 0, true);
  assert.equal(mock.modifies, 1);

  // Segment turnover: new runId, new step-scoped operationId, same graph node.
  const resumed = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      {
        ...mock.context,
        runId: "segment-2",
        rootMissionId: "root-1",
        missionGraphExecution: { nodeId: "tool-03-append_to_current_file" },
        operationId: "segment-2:1:0:append_to_current_file",
      },
    ),
  );
  assert.equal(resumed.duplicateSkip, true);
  assert.equal(resumed.bytesWritten, 0);
  assert.equal(mock.content.get("Current.md"), "Initial note\nDurable mutation proof");
  assert.equal(mock.modifies, 1);

  // A different node under the same root mission is a different append.
  const nextNode = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      {
        ...mock.context,
        runId: "segment-2",
        rootMissionId: "root-1",
        nodeId: "tool-05-append_to_current_file",
        operationId: "segment-2:3:0:append_to_current_file",
      },
    ),
  );
  assert.equal(nextNode.reason, undefined);
  assert.equal(mock.modifies, 2);
});

test("reload hydrates append idempotency from the run snapshot and does not double-append", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  const identity = {
    runId: "run-reload-1",
    operationId: "run-reload-1:1:0:append_to_current_file",
  };
  await appendToCurrentFileTool.execute(
    { text: "Durable mutation proof" },
    { ...mock.context, ...identity },
  );
  assert.equal(mock.modifies, 1);
  const snapshot = snapshotAppendIdempotencyV1();
  assert.ok(snapshot.keys.length > 0);

  resetAppendIdempotencyStateForTests();
  applyAppendIdempotencySnapshotV1(snapshot);
  const retry = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      { ...mock.context, ...identity },
    ),
  );
  assert.equal(retry.duplicateSkip, true);
  assert.equal(retry.bytesWritten, 0);
  assert.equal(mock.modifies, 1);
  assert.equal(mock.content.get("Current.md"), "Initial note\nDurable mutation proof");
});

test("Continue after process restart hydrates keys from the vault run snapshot", async () => {
  resetAppendIdempotencyStateForTests();
  const mock = createAppendVaultContext({
    prompt: "Append one proof line to the current note.",
    initial: "Initial note",
  });
  const identity = {
    runId: "segment-reload",
    rootMissionId: "root-reload",
    nodeId: "tool-03-append_to_current_file",
    operationId: "segment-reload:2:0:append_to_current_file",
  };
  await appendToCurrentFileTool.execute(
    { text: "Durable mutation proof" },
    { ...mock.context, ...identity },
  );
  const sidecarPath = appendIdempotencySnapshotVaultPath(identity);
  assert.equal(sidecarPath, "Agent Runs/root-reload.append-idempotency.json");
  assert.ok(mock.content.has(sidecarPath!));

  resetAppendIdempotencyStateForTests();
  const resumed = asAppendReceipt(
    await appendToCurrentFileTool.execute(
      { text: "Durable mutation proof" },
      { ...mock.context, ...identity },
    ),
  );
  assert.equal(resumed.duplicateSkip, true);
  assert.equal(resumed.bytesWritten, 0);
  assert.equal(mock.modifies, 1);
});
