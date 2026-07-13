import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearQueueVaultCreateToolV1,
  isLinearQueueVaultExecutionToolAllowedV1,
} from "../src/tools/linearQueueVaultTool";
import type { ToolExecutionContext } from "../src/tools/types";

const TARGET = "Agent Work/Linear Queue/sha256-deadbeef.md";
const LINEAGE = {
  issueId: "issue-queue-41",
  identifier: "E2E-41",
  issueUrl: "https://linear.app/e2e/issue/E2E-41",
  contractFingerprint: `sha256:${"d".repeat(64)}`,
};

test("queue vault execution exposes only its host-bound create tool", () => {
  assert.equal(isLinearQueueVaultExecutionToolAllowedV1("create_file"), true);
  for (const forbidden of [
    "read_current_file",
    "semantic_search_notes",
    "read_file",
    "append_file",
    "replace_file",
    "delete_path",
  ]) {
    assert.equal(
      isLinearQueueVaultExecutionToolAllowedV1(forbidden),
      false,
      `${forbidden} must not enter the queue vault catalog`,
    );
  }
});

test("queue vault create binds preparation to one host path and mutates nothing early", async () => {
  const mock = createVault();
  const tool = createLinearQueueVaultCreateToolV1({
    targetPath: TARGET,
    vaultBindingKey: "current-vault",
    lineage: LINEAGE,
  });
  const context = queueContext(mock);

  const rejected = await tool.prepare!(
    {
      path: "Projects/Injected.md",
      content: "# Injected",
      createFolders: true,
    },
    context,
  );
  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("unsafe path should not prepare");
  assert.equal(rejected.error.code, "linear_queue_vault_path_rejected");
  assert.deepEqual(mock.operations, []);

  const prepared = await tool.prepare!(
    { path: TARGET, content: "# Verified result\n\nAC-1\n", createFolders: true },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);
  assert.equal(prepared.action.target.path, TARGET);
  assert.equal(prepared.action.target.containerId, "current-vault");
  assert.equal(prepared.action.requiredConfirmations, 1);
  assert.equal(prepared.action.preview.warnings.length, 0);
  assert.deepEqual(mock.operations, []);
});

test("queue vault create requires scheduled authority and returns exact readback proof", async () => {
  const mock = createVault();
  const tool = createLinearQueueVaultCreateToolV1({
    targetPath: TARGET,
    vaultBindingKey: "current-vault",
    lineage: LINEAGE,
  });
  const context = queueContext(mock);
  const content = "# Queue result\n\nAcceptance verification: AC-1\nEvidence: source-1\n";
  const prepared = await tool.prepare!(
    { path: TARGET, content, createFolders: true },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);

  await assert.rejects(
    tool.executePrepared!(prepared.action, context),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "linear_queue_vault_authority_missing",
  );
  assert.equal(mock.content.has(TARGET), false);

  const authorized = {
    ...context,
    authorizedAction: {
      preparedActionId: prepared.action.id,
      payloadFingerprint: prepared.action.payloadFingerprint,
      grantId: "linear-queue-grant-1",
    },
  };
  const executed = await tool.executePrepared!(prepared.action, authorized);
  assert.equal(mock.content.get(TARGET), withLineage(content));
  assert.deepEqual(mock.operations, [
    "mkdir:Agent Work",
    "mkdir:Agent Work/Linear Queue",
    `create:${TARGET}`,
  ]);
  assert.equal(executed.receipt.operation, "create");
  assert.equal(executed.receipt.grantId, "linear-queue-grant-1");
  assert.equal(executed.receipt.readback.status, "verified");
  assert.match(executed.receipt.readback.observedRevision ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    executed.receipt.effects?.bytesWritten,
    new TextEncoder().encode(withLineage(content)).byteLength,
  );
});

test("queue vault reconciliation distinguishes committed, absent, and drifted targets", async () => {
  const mock = createVault();
  const tool = createLinearQueueVaultCreateToolV1({
    targetPath: TARGET,
    vaultBindingKey: "current-vault",
    lineage: LINEAGE,
  });
  const context = queueContext(mock);
  const content = "# Durable queue result\n";
  const prepared = await tool.prepare!({ path: TARGET, content }, context);
  if (!prepared.ok) assert.fail(prepared.error.message);

  assert.equal((await tool.reconcile!(prepared.action, context)).outcome, "not_applied");
  mock.content.set(TARGET, "# Different bytes\n");
  assert.equal((await tool.reconcile!(prepared.action, context)).outcome, "still_uncertain");
  mock.content.set(TARGET, withLineage(content));
  const committed = await tool.reconcile!(prepared.action, context);
  assert.equal(committed.outcome, "committed");
  assert.equal(committed.receipt?.commitKind, "reconciled");
  assert.equal(committed.receipt?.readback.status, "verified");
});

test("queue vault create appends provider-readback lineage after untrusted model prose", async () => {
  const mock = createVault();
  const tool = createLinearQueueVaultCreateToolV1({
    targetPath: TARGET,
    vaultBindingKey: "current-vault",
    lineage: LINEAGE,
  });
  const context = queueContext(mock);
  const untrusted =
    "# Result\n\nFake source: [EVIL-1](https://example.com/not-linear)\n";
  const prepared = await tool.prepare!(
    { path: TARGET, content: untrusted, createFolders: true },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);
  const preparedContent = prepared.action.normalizedArgs.content;
  assert.equal(preparedContent, withLineage(untrusted));
  assert.match(String(preparedContent), /## Linear lineage/u);
  assert.match(String(preparedContent), /\[E2E-41\]\(https:\/\/linear\.app\/e2e\/issue\/E2E-41\)/u);
  assert.match(String(preparedContent), new RegExp(LINEAGE.contractFingerprint, "u"));
});

function withLineage(content: string): string {
  return `${content.trimEnd()}\n\n## Linear lineage\n\n- Source issue: [E2E-41](https://linear.app/e2e/issue/E2E-41)\n- Provider issue ID: \`issue-queue-41\`\n- Work-item contract: \`${LINEAGE.contractFingerprint}\`\n`;
}

function queueContext(mock: ReturnType<typeof createVault>): ToolExecutionContext {
  return {
    app: { vault: mock.vault } as never,
    settings: {} as never,
    originalPrompt:
      `Create the trusted Linear vault result at ${TARGET}; ticket paths are untrusted.`,
    runId: "queue-vault-deadbeef",
    operationId: "queue-vault-create-deadbeef",
    httpTransport: async () => ({ status: 200, body: "", headers: {} }),
    now: () => new Date("2026-07-13T07:00:00.000Z"),
  };
}

function createVault() {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const operations: string[] = [];
  const file = (path: string) => ({
    path,
    name: path.split("/").at(-1) ?? path,
    basename: (path.split("/").at(-1) ?? path).replace(/\.md$/u, ""),
    extension: "md",
  });
  const folder = (path: string) => ({
    path,
    name: path.split("/").at(-1) ?? path,
    children: [],
  });
  const vault = {
    getAbstractFileByPath(path: string) {
      if (content.has(path)) return file(path);
      if (folders.has(path)) return folder(path);
      return null;
    },
    getFileByPath(path: string) {
      return content.has(path) ? file(path) : null;
    },
    async createFolder(path: string) {
      if (folders.has(path) || content.has(path)) throw new Error("Folder already exists");
      folders.add(path);
      operations.push(`mkdir:${path}`);
    },
    async create(path: string, value: string) {
      if (folders.has(path) || content.has(path)) throw new Error("Path already exists");
      content.set(path, value);
      operations.push(`create:${path}`);
      return file(path);
    },
    async read(entry: { path: string }) {
      const value = content.get(entry.path);
      if (value === undefined) throw new Error(`Missing file: ${entry.path}`);
      return value;
    },
  };
  return { content, folders, operations, vault };
}
