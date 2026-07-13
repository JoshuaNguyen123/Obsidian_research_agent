import test from "node:test";
import assert from "node:assert/strict";
import {
  readSvgDesignTool,
  updateSvgDesignTool,
} from "../src/tools/designTools";
import { sha256DiagramContent } from "../src/design/diagramArtifactStore";
import type { ToolExecutionContext } from "../src/tools/types";

const INITIAL_SVG = [
  '<svg id="root" xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">',
  "  <!-- unrelated sentinel comment -->",
  '  <rect id="sentinel" x="10" y="20" width="100" height="60" fill="#061007"/>',
  '  <text id="title" x="20" y="50" fill="#a8ffbf" font-size="16">Original title</text>',
  "</svg>",
  "",
].join("\n");

test("SVG read and prepared patch preserve unrelated source with exact hashes", async () => {
  const mock = createMockContext({
    prompt: "Revise the existing SVG diagram title without replacing unrelated elements.",
    now: new Date("2026-07-12T19:00:00.000Z"),
  });
  const path = "Designs/existing.svg";
  mock.folders.add("Designs");
  mock.content.set(path, INITIAL_SVG);

  assert.deepEqual(readSvgDesignTool.descriptor?.capability, {
    system: "vault",
    resourceType: "svg",
    action: "read",
  });
  assert.equal(updateSvgDesignTool.descriptor?.risk, "high");
  assert.equal(updateSvgDesignTool.descriptor?.execution.preparation, "required");
  assert.equal(updateSvgDesignTool.descriptor?.approval.fallback, "exact");

  const read = await readSvgDesignTool.execute({ path }, mock.context) as {
    sha256: string;
    stableIds: string[];
    document: { elementCount: number };
  };
  assert.equal(read.sha256, await sha256DiagramContent(INITIAL_SVG));
  assert.deepEqual(read.stableIds, ["root", "sentinel", "title"]);
  assert.equal(read.document.elementCount, 3);

  const context = {
    ...mock.context,
    runId: "run-svg-patch",
    operationId: "call-svg-patch",
  };
  const operationsBeforePrepare = [...mock.operations];
  const prepared = await updateSvgDesignTool.prepare!(
    {
      path,
      baseHash: read.sha256,
      operations: [
        { op: "update_text", id: "title", text: "Revised title" },
        { op: "update_attributes", id: "title", attributes: { fill: "#5cff8d" } },
      ],
    },
    context,
  );
  if (!prepared.ok) assert.fail(prepared.error.message);
  assert.deepEqual(mock.operations, operationsBeforePrepare);
  assert.equal(mock.content.get(path), INITIAL_SVG);
  assert.equal(prepared.action.expectedTargetRevision, read.sha256);
  assert.equal(prepared.action.preview.before?.sha256, read.sha256);

  await assert.rejects(
    () => updateSvgDesignTool.executePrepared!(prepared.action, context),
    /exact authority binding/i,
  );
  assert.equal(mock.content.get(path), INITIAL_SVG);

  const executed = await updateSvgDesignTool.executePrepared!(
    prepared.action,
    {
      ...context,
      authorizedAction: {
        preparedActionId: prepared.action.id,
        payloadFingerprint: prepared.action.payloadFingerprint,
        grantId: "grant-svg-patch",
      },
    },
  );
  const persisted = mock.content.get(path) ?? "";
  assert.match(persisted, /<!-- unrelated sentinel comment -->/);
  assert.match(persisted, /id="sentinel" x="10" y="20" width="100" height="60" fill="#061007"/);
  assert.match(persisted, /id="title" x="20" y="50" fill="#5cff8d" font-size="16">Revised title<\/text>/);
  assert.equal(executed.receipt.operation, "update");
  assert.equal(executed.receipt.resource.resourceType, "svg");
  assert.equal(executed.receipt.relatedResources?.[0]?.resourceType, "svg_backup");
  assert.equal(executed.receipt.readback.status, "verified");
  const output = executed.output as {
    beforeSha256: string;
    afterSha256: string;
    backupPath: string;
    backupSha256: string;
    preservation: { unrelatedSourceSlicesPreserved: boolean };
  };
  assert.equal(output.beforeSha256, read.sha256);
  assert.equal(output.afterSha256, await sha256DiagramContent(persisted));
  assert.equal(output.backupSha256, read.sha256);
  assert.equal(mock.content.get(output.backupPath), INITIAL_SVG);
  assert.equal(output.preservation.unrelatedSourceSlicesPreserved, true);
});

test("SVG patch preparation rejects stale hashes and malformed operations without mutation", async () => {
  const mock = createMockContext({ prompt: "Update the existing SVG diagram safely." });
  const path = "Designs/stale.svg";
  mock.folders.add("Designs");
  mock.content.set(path, INITIAL_SVG);
  const beforeOperations = [...mock.operations];

  const stale = await updateSvgDesignTool.prepare!(
    {
      path,
      baseHash: `sha256:${"0".repeat(64)}`,
      operations: [{ op: "update_text", id: "title", text: "changed" }],
    },
    { ...mock.context, runId: "run-svg-stale", operationId: "call-svg-stale" },
  );
  assert.equal(stale.ok, false);

  const malformed = await updateSvgDesignTool.prepare!(
    {
      path,
      baseHash: await sha256DiagramContent(INITIAL_SVG),
      operations: [{ op: "update_attributes", id: "title", attributes: { onclick: "evil()" } }],
    },
    { ...mock.context, runId: "run-svg-invalid", operationId: "call-svg-invalid" },
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.ok ? "" : malformed.error.message, /not allowed|event handler/i);
  assert.equal(mock.content.get(path), INITIAL_SVG);
  assert.deepEqual(mock.operations, beforeOperations);
});

function createMockContext(options: { prompt: string; now?: Date }) {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const operations: string[] = [];
  const getFile = (path: string) => {
    if (!content.has(path)) return null;
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.[^.]+$/u, ""),
      extension: name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "",
      stat: { ctime: 0, mtime: 0, size: content.get(path)?.length ?? 0 },
    };
  };
  const getFolder = (path: string) => folders.has(path)
    ? { path, name: path.split("/").pop() ?? path }
    : null;
  const app = {
    workspace: {
      getActiveFile: () => null,
      getLeaf: () => ({ openFile: async () => undefined }),
    },
    vault: {
      getFiles: () => [...content.keys()].flatMap((path) => {
        const file = getFile(path);
        return file ? [file] : [];
      }),
      getFileByPath: getFile,
      getFolderByPath: getFolder,
      getAbstractFileByPath: (path: string) => getFile(path) ?? getFolder(path),
      createFolder: async (path: string) => {
        operations.push(`createFolder:${path}`);
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        operations.push(`create:${path}`);
        content.set(path, data);
        return getFile(path);
      },
      read: async (file: { path: string }) => content.get(file.path) ?? "",
      cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
      modify: async (file: { path: string }, data: string) => {
        operations.push(`modify:${file.path}`);
        content.set(file.path, data);
      },
      delete: async (file: { path: string }) => {
        operations.push(`delete:${file.path}`);
        content.delete(file.path);
      },
      trash: async (file: { path: string }) => {
        operations.push(`trash:${file.path}`);
        content.delete(file.path);
      },
    },
  };
  const context: ToolExecutionContext = {
    app: app as never,
    settings: {} as never,
    originalPrompt: options.prompt,
    httpTransport: async () => ({ status: 500, headers: {}, json: {} }),
    now: () => options.now ?? new Date(123),
  };
  return { context, content, folders, operations };
}
