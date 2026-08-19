import assert from "node:assert/strict";
import test from "node:test";

import { buildJupyterNotebookV1 } from "../extensions/code/JupyterNotebookV1";
import { portableSha256Text } from "../packages/core-api/src/portableSha256";
import {
  appendJupyterReflectionWritebackV1,
  appendMarkdownReflectionWritebackV1,
  type ReflectionWritebackStoreV1,
} from "../src/agent/reflectionWriteback";
import { verifiedCodeReflectionFixture } from "./fixtures/verifiedCodeReflection";

class MemoryStore implements ReflectionWritebackStoreV1 {
  readonly files = new Map<string, string>();
  writes = 0;
  corruptWrites = false;

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`missing ${path}`);
    return content;
  }

  async modify(path: string, content: string): Promise<void> {
    this.writes += 1;
    this.files.set(path, this.corruptWrites ? `${content}\ncorrupt` : content);
  }
}

test("Markdown reflection writeback verifies exact pre/post hashes and is idempotent", async () => {
  const path = "Research/Source.md";
  const store = new MemoryStore();
  store.files.set(path, "# Source\n\nExisting research.\n");
  const originalSha256 = hash(store.files.get(path)!);
  const marker = "<!-- agentic-initiating-reflection:run-writeback -->";
  const markdown = [
    "## Mission completion reflection",
    marker,
    "",
    "The verified implementation completed its targeted and full validation, and the resulting draft pull request preserves the accepted research requirements.",
  ].join("\n");
  const first = await appendMarkdownReflectionWritebackV1({
    operationId: "reflection-writeback-1",
    target: { kind: "markdown_note", notePath: path },
    expectedBeforeSha256: originalSha256,
    plan: { marker, markdown },
    completedAt: "2026-08-19T13:00:00.000Z",
    store,
  });
  assert.equal(first.status, "committed");
  assert.equal(first.readbackVerified, true);
  assert.equal(first.afterSha256, hash(store.files.get(path)!));
  assert.ok(first.bytesWritten > 0);
  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(store.writes, 1);

  const retry = await appendMarkdownReflectionWritebackV1({
    operationId: "reflection-writeback-1-retry",
    target: { kind: "markdown_note", notePath: path },
    expectedBeforeSha256: originalSha256,
    plan: { marker, markdown },
    completedAt: "2026-08-19T13:01:00.000Z",
    store,
  });
  assert.equal(retry.status, "already_applied");
  assert.equal(retry.bytesWritten, 0);
  assert.equal(store.writes, 1);

  await assert.rejects(
    appendMarkdownReflectionWritebackV1({
      operationId: "reflection-writeback-1-collision",
      target: { kind: "markdown_note", notePath: path },
      expectedBeforeSha256: retry.afterSha256,
      plan: {
        marker,
        markdown: `${marker}\n\nA different completion claim must never replace or impersonate the already verified reflection body under the same marker.`,
      },
      completedAt: "2026-08-19T13:01:30.000Z",
      store,
    }),
    /marker already exists with different content/iu,
  );
});

test("reflection writeback rejects stale targets and post-write mismatch", async () => {
  const path = "Research/Source.md";
  const marker = "<!-- agentic-initiating-reflection:run-stale -->";
  const markdown = `${marker}\n\nThe completed implementation passed all required checks and records a clear outcome for the next person reviewing this work.`;
  const stale = new MemoryStore();
  stale.files.set(path, "# Changed\n");
  await assert.rejects(
    appendMarkdownReflectionWritebackV1({
      operationId: "reflection-stale-1",
      target: { kind: "markdown_note", notePath: path },
      expectedBeforeSha256: hash("# Original\n"),
      plan: { marker, markdown },
      completedAt: "2026-08-19T13:02:00.000Z",
      store: stale,
    }),
    /changed after its expected pre-write hash/iu,
  );

  const corrupt = new MemoryStore();
  corrupt.files.set(path, "# Original\n");
  corrupt.corruptWrites = true;
  await assert.rejects(
    appendMarkdownReflectionWritebackV1({
      operationId: "reflection-corrupt-1",
      target: { kind: "markdown_note", notePath: path },
      expectedBeforeSha256: hash("# Original\n"),
      plan: { marker, markdown },
      completedAt: "2026-08-19T13:03:00.000Z",
      store: corrupt,
    }),
    /readback did not match/iu,
  );
});

test("Jupyter reflection writeback returns a verified hash receipt without execution", async () => {
  const path = "Research/Reflection.ipynb";
  const store = new MemoryStore();
  store.files.set(path, buildJupyterNotebookV1({
    cells: [{ type: "markdown", source: "# Existing analysis" }],
  }).content);
  const { examples } = verifiedCodeReflectionFixture();
  const receipt = await appendJupyterReflectionWritebackV1({
    operationId: "jupyter-reflection-1",
    target: { kind: "jupyter_notebook", notebookPath: path },
    expectedBeforeSha256: hash(store.files.get(path)!),
    markerId: "run-jupyter-writeback",
    markdown: "The verified implementation passed targeted and full validation, and this notebook records the exact committed example for later review.",
    codeExamples: examples,
    completedAt: "2026-08-19T13:04:00.000Z",
    store,
  });
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.targetKind, "jupyter_notebook");
  assert.equal(receipt.executionPerformed, false);
  assert.equal(receipt.afterSha256, hash(store.files.get(path)!));
  assert.equal(store.writes, 1);
});

function hash(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
}
