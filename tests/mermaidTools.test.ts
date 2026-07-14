import assert from "node:assert/strict";
import test from "node:test";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import {
  readMermaidBlockTool,
  upsertMermaidBlockTool,
} from "../src/tools/mermaidTools";
import type { ToolExecutionContext } from "../src/tools/types";

test("default core registry exposes explicit Mermaid read and prepared-update descriptors", () => {
  const registry = createDefaultToolRegistry({
    optionalCapabilities: { code: false, integrations: false, companion: false },
  });
  const definitions = new Set(registry.getDefinitions().map((tool) => tool.function.name));
  assert.equal(definitions.has("read_mermaid_block"), true);
  assert.equal(definitions.has("upsert_mermaid_block"), true);
  assert.deepEqual(registry.getDescriptor?.("read_mermaid_block")?.capability, {
    system: "vault",
    resourceType: "mermaid_block",
    action: "read",
  });
  assert.equal(
    registry.getDescriptor?.("upsert_mermaid_block")?.execution.preparation,
    "required",
  );
  assert.equal(registry.getDescriptor?.("upsert_mermaid_block")?.approval.fallback, "exact");
});

test("read_mermaid_block returns exact note hash and selected block metadata", async () => {
  const mock = createMockVault();
  const path = "Designs/architecture.md";
  const markdown = [
    "# Architecture",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Old] --> B[Keep]",
    "```",
    "",
    "## Unrelated",
    "Sentinel text.",
    "",
  ].join("\n");
  mock.put(path, markdown);

  const output = await readMermaidBlockTool.execute(
    { path, selector: { kind: "heading", heading: "Architecture" } },
    mock.context,
  ) as {
    sha256: string;
    mermaid: string;
    metadata: { heading: { text: string } | null };
  };

  assert.equal(output.sha256, await sha256DiagramContent(markdown));
  assert.equal(output.mermaid, "flowchart LR\n  A[Old] --> B[Keep]");
  assert.equal(output.metadata.heading?.text, "Architecture");
});

test("missing block read returns the note hash needed for an approved insert", async () => {
  const mock = createMockVault();
  const path = "Designs/new-flow.md";
  const before = "# Design\n\nUnrelated sentinel.\n";
  mock.put(path, before);
  const selector = { kind: "block_id", blockId: "primary-flow" } as const;
  const read = await readMermaidBlockTool.execute(
    { path, selector },
    mock.context,
  ) as { sha256: string; matched: boolean; mermaid: string | null };
  assert.equal(read.sha256, await sha256DiagramContent(before));
  assert.equal(read.matched, false);
  assert.equal(read.mermaid, null);

  const context = {
    ...mock.context,
    originalPrompt: "Add a Mermaid diagram for the primary flow.",
    runId: "run-mermaid-insert",
    operationId: "call-mermaid-insert",
  };
  const prepared = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: read.sha256,
      selector,
      mermaid: "flowchart LR\n A --> B",
    },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);
  const execution = await upsertMermaidBlockTool.executePrepared!(
    prepared.action,
    {
      ...context,
      authorizedAction: {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: "grant-mermaid-insert",
      },
    },
  );
  assert.equal((execution.output as { operation: string }).operation, "insert");
  assert.match(mock.get(path) ?? "", /agentic-mermaid:block-id=primary-flow/u);
  assert.match(mock.get(path) ?? "", /Unrelated sentinel\./u);
});

test("prepared Mermaid upsert preserves unrelated Markdown and emits verified hashes and backup", async () => {
  const mock = createMockVault(new Date("2026-07-12T20:00:00.000Z"));
  const path = "Designs/architecture.md";
  const before = [
    "# Architecture",
    "Intro sentinel.",
    "",
    "```mermaid",
    "flowchart LR",
    "  A[Old] --> B[Keep]",
    "```",
    "",
    "## Unrelated",
    "Do not change this sentinel.",
    "",
  ].join("\n");
  mock.put(path, before);
  const read = await readMermaidBlockTool.execute(
    { path, selector: { kind: "heading", heading: "Architecture" } },
    mock.context,
  ) as { sha256: string };
  const context = {
    ...mock.context,
    originalPrompt: "Update the Mermaid diagram under Architecture.",
    runId: "run-mermaid-update",
    operationId: "call-mermaid-update",
  };
  const prepared = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: read.sha256,
      selector: { kind: "heading", heading: "Architecture" },
      mermaid: "flowchart LR\n  A[Revised] --> B[Keep]",
    },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);

  assert.equal(mock.get(path), before, "prepare must not mutate note bytes");
  assert.equal(prepared.action.expectedTargetRevision, read.sha256);
  assert.equal(prepared.action.preview.before?.sha256, read.sha256);
  const execution = await upsertMermaidBlockTool.executePrepared!(
    prepared.action,
    {
      ...context,
      authorizedAction: {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: "grant-mermaid-update",
      },
    },
  );

  const after = mock.get(path) ?? "";
  assert.match(after, /A\[Revised\] --> B\[Keep\]/u);
  assert.match(after, /Intro sentinel\./u);
  assert.match(after, /## Unrelated\nDo not change this sentinel\./u);
  assert.equal(execution.receipt.operation, "update");
  assert.equal(execution.receipt.readback.status, "verified");
  const output = execution.output as {
    beforeSha256: string;
    afterSha256: string;
    backupPath: string;
    backupSha256: string;
    rollbackStatus: string;
  };
  assert.equal(output.beforeSha256, read.sha256);
  assert.equal(output.afterSha256, await sha256DiagramContent(after));
  assert.equal(output.backupSha256, read.sha256);
  assert.equal(mock.get(output.backupPath), before);
  assert.equal(output.rollbackStatus, "not_required");
});

test("Mermaid upsert rejects stale hash and dangerous source without changing bytes", async () => {
  const mock = createMockVault();
  const path = "Designs/safe.md";
  const before = "# Flow\n\n```mermaid\nflowchart LR\n A --> B\n```\n";
  mock.put(path, before);
  const context = {
    ...mock.context,
    originalPrompt: "Update the Mermaid flowchart safely.",
    runId: "run-mermaid-safety",
    operationId: "call-mermaid-safety",
  };

  const stale = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: `sha256:${"0".repeat(64)}`,
      selector: { kind: "heading", heading: "Flow" },
      mermaid: "flowchart LR\n A --> C",
    },
    context,
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "vault_precondition_changed");

  const dangerous = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: await sha256DiagramContent(before),
      selector: { kind: "heading", heading: "Flow" },
      mermaid: "flowchart LR\n click A https://evil.example",
    },
    context,
  );
  assert.equal(dangerous.ok, false);
  if (!dangerous.ok) assert.equal(dangerous.error.code, "dangerous_mermaid");

  const wrongArtifactIntent = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: await sha256DiagramContent(before),
      selector: { kind: "heading", heading: "Flow" },
      mermaid: "flowchart LR\n A --> C",
    },
    {
      ...context,
      originalPrompt: "Update the existing Canvas diagram safely.",
    },
  );
  assert.equal(wrongArtifactIntent.ok, false);
  if (!wrongArtifactIntent.ok) {
    assert.equal(wrongArtifactIntent.error.code, "intent_required");
  }
  assert.equal(mock.get(path), before);
  assert.deepEqual(mock.operations, []);
});

test("prepared Mermaid upsert requires its exact authorization binding", async () => {
  const mock = createMockVault();
  const path = "Designs/auth.md";
  const before = "# Flow\n\n```mermaid\nflowchart LR\n A --> B\n```\n";
  mock.put(path, before);
  const context = {
    ...mock.context,
    originalPrompt: "Revise the Mermaid diagram.",
    runId: "run-mermaid-auth",
    operationId: "call-mermaid-auth",
  };
  const prepared = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: await sha256DiagramContent(before),
      selector: { kind: "heading", heading: "Flow" },
      mermaid: "flowchart LR\n A --> C",
    },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);

  await assert.rejects(
    () => upsertMermaidBlockTool.executePrepared!(prepared.action, context),
    /exact authority binding/u,
  );
  assert.equal(mock.get(path), before);
  assert.deepEqual(mock.operations, []);
});

test("failed Mermaid readback rolls the note back to its original bytes", async () => {
  const mock = createMockVault();
  const path = "Designs/rollback.md";
  const before = "# Flow\n\n```mermaid\nflowchart LR\n A --> B\n```\n";
  mock.put(path, before);
  const context = {
    ...mock.context,
    originalPrompt: "Update the Mermaid diagram.",
    runId: "run-mermaid-rollback",
    operationId: "call-mermaid-rollback",
  };
  const prepared = await upsertMermaidBlockTool.prepare!(
    {
      path,
      baseHash: await sha256DiagramContent(before),
      selector: { kind: "heading", heading: "Flow" },
      mermaid: "flowchart LR\n A --> C",
    },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);
  mock.corruptNextTargetWrite(path);

  await assert.rejects(
    () => upsertMermaidBlockTool.executePrepared!(
      prepared.action,
      {
        ...context,
        authorizedAction: {
          preparedActionId: prepared.action.id,
          payloadFingerprint: prepared.action.payloadFingerprint,
          grantId: "grant-mermaid-rollback",
        },
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "mermaid_upsert_rolled_back",
  );
  assert.equal(mock.get(path), before);
});

function createMockVault(now = new Date("2026-07-12T19:00:00.000Z")) {
  const content = new Map<string, string>();
  const folders = new Set<string>(["Designs"]);
  const operations: string[] = [];
  let corruptPath: string | null = null;

  const file = (path: string) => content.has(path) ? { path } : null;
  const folder = (path: string) => folders.has(path) ? { path } : null;
  const vault = {
    getAbstractFileByPath: (path: string) => file(path) ?? folder(path),
    getFileByPath: file,
    getFolderByPath: folder,
    createFolder: async (path: string) => {
      operations.push(`createFolder:${path}`);
      folders.add(path);
    },
    read: async (entry: { path: string }) => content.get(entry.path) ?? "",
    create: async (path: string, value: string) => {
      operations.push(`create:${path}`);
      content.set(path, value);
      return { path };
    },
    modify: async (entry: { path: string }, value: string) => {
      operations.push(`modify:${entry.path}`);
      if (entry.path === corruptPath) {
        corruptPath = null;
        content.set(entry.path, `${value}\ncorrupted`);
        return;
      }
      content.set(entry.path, value);
    },
    delete: async (entry: { path: string }) => {
      operations.push(`delete:${entry.path}`);
      content.delete(entry.path);
    },
  };
  const context: ToolExecutionContext = {
    app: { vault } as never,
    settings: {} as never,
    originalPrompt: "Read the Mermaid diagram.",
    httpTransport: async () => ({ status: 200, body: "", headers: {} }),
    now: () => new Date(now),
  };
  return {
    context,
    operations,
    put(path: string, value: string) {
      content.set(path, value);
    },
    get(path: string) {
      return content.get(path);
    },
    corruptNextTargetWrite(path: string) {
      corruptPath = path;
    },
  };
}
