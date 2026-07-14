import assert from "node:assert/strict";
import test from "node:test";

import {
  DiagramArtifactStore,
  DiagramArtifactStoreError,
  sha256DiagramContent,
  validateDiagramArtifactPath,
  type DiagramArtifactFileLike,
  type DiagramArtifactVaultLike,
} from "../src/design/diagramArtifactStore";

test("diagram artifact paths are normalized vault-relative Canvas, SVG, or Markdown paths", () => {
  for (const path of [
    "Designs/flow.canvas",
    "Designs/wireframe.SVG",
    "Design Packages/brief.md",
  ]) {
    assert.equal(validateDiagramArtifactPath(path), path);
  }
  for (const path of [
    "../escape.canvas",
    "/absolute.svg",
    "C:/absolute.md",
    "safe\\escape.canvas",
    "Designs//empty.canvas",
    ".obsidian/workspace.md",
    "Designs/unsupported.json",
    " Designs/space.canvas",
  ]) {
    assert.throws(
      () => validateDiagramArtifactPath(path),
      DiagramArtifactStoreError,
      path,
    );
  }
});

test("bounded reads return exact UTF-8 byte hashes", async () => {
  const vault = new MemoryDiagramVault({ "Designs/flow.canvas": "é\n" });
  const store = new DiagramArtifactStore(vault, { maxBytes: 4 });
  const read = await store.read("Designs/flow.canvas");
  assert.equal(read.bytes, 3);
  assert.equal(read.sha256, await sha256DiagramContent("é\n"));

  vault.files.set("Designs/flow.canvas", "12345");
  await assert.rejects(
    store.read("Designs/flow.canvas"),
    /exceeds 4 bytes/u,
  );
});

test("update creates a collision-safe verified backup and commits only validated readback", async () => {
  const original = '{"nodes":[],"edges":[]}';
  const updated = '{"nodes":[{"id":"one"}],"edges":[]}';
  const vault = new MemoryDiagramVault({ "Designs/flow.canvas": original });
  vault.failNextBackupCreateAsCollision = true;
  const store = fixtureStore(vault);

  const receipt = await store.update({
    path: "Designs/flow.canvas",
    expectedSha256: await sha256DiagramContent(original),
    content: updated,
    validator: ({ path, content, sha256 }) => ({
      ok:
        path === "Designs/flow.canvas" &&
        content === updated &&
        sha256.length === 71,
    }),
  });

  assert.equal(receipt.status, "committed");
  assert.equal(receipt.beforeSha256, await sha256DiagramContent(original));
  assert.equal(receipt.expectedAfterSha256, await sha256DiagramContent(updated));
  assert.equal(receipt.afterSha256, receipt.expectedAfterSha256);
  assert.equal(receipt.finalSha256, receipt.afterSha256);
  assert.equal(receipt.backupSha256, receipt.beforeSha256);
  assert.match(receipt.backupPath, /^\.agent-backups\/.+\.1\.backup\.canvas$/u);
  assert.equal(receipt.rollbackStatus, "not_required");
  assert.equal(vault.files.get(receipt.backupPath), original);
  assert.equal(vault.files.get("Designs/flow.canvas"), updated);
});

test("hidden diagram backups use the vault adapter and never wait for indexed file handles", async () => {
  const original = '{"nodes":[],"edges":[]}';
  const updated = '{"nodes":[{"id":"one"}],"edges":[]}';
  const vault = new MemoryDiagramVault({ "Designs/flow.canvas": original });
  const hiddenFiles = new Map<string, string>();
  vault.adapter = {
    exists: async (path) => hiddenFiles.has(path) || path === ".agent-backups",
    mkdir: async () => undefined,
    read: async (path) => {
      const content = hiddenFiles.get(path);
      if (content === undefined) throw new Error(`Missing adapter file: ${path}`);
      return content;
    },
    write: async (path, content) => {
      if (hiddenFiles.has(path)) throw existsError(path);
      hiddenFiles.set(path, content);
      vault.operations.push(`adapterWrite:${path}`);
    },
    remove: async (path) => {
      hiddenFiles.delete(path);
    },
  };

  const receipt = await fixtureStore(vault).update({
    path: "Designs/flow.canvas",
    expectedSha256: await sha256DiagramContent(original),
    content: updated,
    validator: () => true,
  });

  assert.equal(receipt.status, "committed");
  assert.equal(hiddenFiles.get(receipt.backupPath), original);
  assert.ok(vault.operations.includes(`adapterWrite:${receipt.backupPath}`));
  assert.equal(
    vault.operations.some((operation) => operation.startsWith("create:.agent-backups/")),
    false,
  );
});

test("update rechecks the expected hash immediately before write", async () => {
  const original = "<svg><rect /></svg>";
  const drifted = "<svg><circle /></svg>";
  const vault = new MemoryDiagramVault({ "Designs/flow.svg": original });
  vault.onRead = (path, count) => {
    if (path === "Designs/flow.svg" && count === 2) {
      vault.files.set(path, drifted);
    }
  };
  const store = fixtureStore(vault);

  await assert.rejects(
    store.update({
      path: "Designs/flow.svg",
      expectedSha256: await sha256DiagramContent(original),
      content: "<svg><line /></svg>",
      validator: () => ({ ok: true }),
    }),
    /changed immediately before write/u,
  );
  assert.equal(vault.files.get("Designs/flow.svg"), drifted);
  assert.equal(
    vault.operations.some((operation) => operation === "modify:Designs/flow.svg"),
    false,
  );
  assert.equal(
    [...vault.files.keys()].some((path) => path.startsWith(".agent-backups/")),
    false,
    "unused backup is removed when the pre-write precondition drifts",
  );
});

test("failed persisted validation rolls an update back with exact readback", async () => {
  const original = "# Diagram brief\n";
  const candidate = "# Invalid brief\n";
  const vault = new MemoryDiagramVault({ "Designs/brief.md": original });
  const store = fixtureStore(vault);

  const receipt = await store.update({
    path: "Designs/brief.md",
    expectedSha256: await sha256DiagramContent(original),
    content: candidate,
    validator: () => ({ ok: false, errors: ["missing required diagram link"] }),
  });

  assert.equal(receipt.status, "rolled_back");
  assert.equal(receipt.validationStatus, "failed");
  assert.equal(receipt.afterSha256, await sha256DiagramContent(candidate));
  assert.equal(receipt.rollbackStatus, "verified");
  assert.equal(receipt.rollbackSha256, await sha256DiagramContent(original));
  assert.equal(receipt.finalSha256, receipt.beforeSha256);
  assert.equal(receipt.error?.code, "validation_failed");
  assert.equal(vault.files.get("Designs/brief.md"), original);
  assert.equal(vault.files.get(receipt.backupPath), original);
});

test("rollback failure remains explicit and never reports a committed update", async () => {
  const original = "<svg></svg>";
  const candidate = "<svg><script /></svg>";
  const vault = new MemoryDiagramVault({ "Designs/unsafe.svg": original });
  vault.failModifyContent = original;
  const store = fixtureStore(vault);

  const receipt = await store.update({
    path: "Designs/unsafe.svg",
    expectedSha256: await sha256DiagramContent(original),
    content: candidate,
    validator: () => ({ ok: false, errors: ["script rejected"] }),
  });

  assert.equal(receipt.status, "rollback_failed");
  assert.equal(receipt.rollbackStatus, "failed");
  assert.equal(receipt.finalSha256, await sha256DiagramContent(candidate));
  assert.equal(receipt.error?.code, "diagram_rollback_failed");
  assert.equal(vault.files.get("Designs/unsafe.svg"), candidate);
});

test("multi-artifact create commits only after exact readback and validation", async () => {
  const vault = new MemoryDiagramVault();
  const store = fixtureStore(vault);
  const canvas = '{"nodes":[],"edges":[]}';
  const brief = "# Flow\n\nSee [[flow.canvas]].\n";

  const receipt = await store.createMany([
    {
      path: "Designs/flow.canvas",
      content: canvas,
      validator: ({ content }) => ({ ok: JSON.parse(content).nodes.length === 0 }),
    },
    {
      path: "Designs/flow.md",
      content: brief,
      validator: ({ content }) => ({ ok: content.includes("[[flow.canvas]]") }),
    },
  ]);

  assert.equal(receipt.status, "committed");
  assert.equal(receipt.rollbackStatus, "not_required");
  assert.deepEqual(receipt.rollbackOrder, []);
  assert.deepEqual(
    receipt.artifacts.map((artifact) => artifact.validationStatus),
    ["passed", "passed"],
  );
  assert.equal(receipt.artifacts[0].afterSha256, await sha256DiagramContent(canvas));
  assert.equal(receipt.artifacts[1].afterSha256, await sha256DiagramContent(brief));
});

test("multi-artifact failure removes created files in reverse order with trash/delete fallback", async () => {
  const vault = new MemoryDiagramVault();
  vault.failTrashPaths.add("Designs/package.md");
  const store = fixtureStore(vault);

  const receipt = await store.createMany([
    {
      path: "Designs/package.canvas",
      content: '{"nodes":[],"edges":[]}',
      validator: () => ({ ok: true }),
    },
    {
      path: "Designs/package.md",
      content: "# Missing canvas link\n",
      validator: () => ({ ok: false, errors: ["canvas link missing"] }),
    },
  ]);

  assert.equal(receipt.status, "rolled_back");
  assert.equal(receipt.rollbackStatus, "verified");
  assert.deepEqual(receipt.rollbackOrder, ["Designs/package.md", "Designs/package.canvas"]);
  assert.equal(receipt.artifacts[0].rollbackStatus, "verified");
  assert.equal(receipt.artifacts[1].rollbackStatus, "verified");
  assert.equal(vault.files.has("Designs/package.canvas"), false);
  assert.equal(vault.files.has("Designs/package.md"), false);
  assert.deepEqual(
    vault.operations.filter((operation) => /^(?:trash|delete):/u.test(operation)),
    [
      "trash:Designs/package.md",
      "delete:Designs/package.md",
      "trash:Designs/package.canvas",
    ],
  );
});

test("multi-artifact create refuses any existing destination before writing", async () => {
  const vault = new MemoryDiagramVault({ "Designs/existing.svg": "<svg />" });
  const store = fixtureStore(vault);

  await assert.rejects(
    store.createMany([
      {
        path: "Designs/new.canvas",
        content: '{"nodes":[],"edges":[]}',
        validator: () => true,
      },
      {
        path: "Designs/existing.svg",
        content: "<svg><rect /></svg>",
        validator: () => true,
      },
    ]),
    /cannot overwrite/u,
  );
  assert.equal(vault.files.has("Designs/new.canvas"), false);
  assert.equal(
    vault.operations.some((operation) => operation.startsWith("create:Designs/")),
    false,
  );
});

function fixtureStore(vault: MemoryDiagramVault): DiagramArtifactStore {
  return new DiagramArtifactStore(vault, {
    now: () => new Date("2026-07-12T22:00:00.000Z"),
  });
}

class MemoryDiagramVault implements DiagramArtifactVaultLike {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>(["Designs"]);
  readonly operations: string[] = [];
  readonly failTrashPaths = new Set<string>();
  failNextBackupCreateAsCollision = false;
  failModifyContent: string | null = null;
  onRead: ((path: string, count: number) => void) | null = null;
  adapter?: DiagramArtifactVaultLike["adapter"];
  private readonly readCounts = new Map<string, number>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  getAbstractFileByPath(path: string): { path: string } | null {
    return this.files.has(path) || this.folders.has(path) ? { path } : null;
  }

  getFileByPath(path: string): DiagramArtifactFileLike | null {
    return this.files.has(path) ? { path } : null;
  }

  getFolderByPath(path: string): { path: string } | null {
    return this.folders.has(path) ? { path } : null;
  }

  async createFolder(path: string): Promise<void> {
    if (this.files.has(path) || this.folders.has(path)) throw existsError(path);
    this.operations.push(`createFolder:${path}`);
    this.folders.add(path);
  }

  async read(file: DiagramArtifactFileLike): Promise<string> {
    const count = (this.readCounts.get(file.path) ?? 0) + 1;
    this.readCounts.set(file.path, count);
    this.onRead?.(file.path, count);
    const content = this.files.get(file.path);
    if (content === undefined) throw new Error(`Missing file: ${file.path}`);
    return content;
  }

  async create(path: string, content: string): Promise<DiagramArtifactFileLike> {
    if (
      this.failNextBackupCreateAsCollision &&
      path.startsWith(".agent-backups/")
    ) {
      this.failNextBackupCreateAsCollision = false;
      throw existsError(path);
    }
    if (this.getAbstractFileByPath(path)) throw existsError(path);
    this.operations.push(`create:${path}`);
    this.files.set(path, content);
    return { path };
  }

  async modify(file: DiagramArtifactFileLike, content: string): Promise<void> {
    this.operations.push(`modify:${file.path}`);
    if (this.failModifyContent !== null && content === this.failModifyContent) {
      throw new Error("Injected rollback modify failure.");
    }
    if (!this.files.has(file.path)) throw new Error(`Missing file: ${file.path}`);
    this.files.set(file.path, content);
  }

  async trash(file: DiagramArtifactFileLike): Promise<void> {
    this.operations.push(`trash:${file.path}`);
    if (this.failTrashPaths.has(file.path)) throw new Error("Injected trash failure.");
    this.files.delete(file.path);
  }

  async delete(file: DiagramArtifactFileLike): Promise<void> {
    this.operations.push(`delete:${file.path}`);
    this.files.delete(file.path);
  }
}

function existsError(path: string): Error & { code: string } {
  return Object.assign(new Error(`File already exists: ${path}`), { code: "EEXIST" });
}
