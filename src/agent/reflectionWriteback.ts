import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import type { VerifiedCodeReflectionExamplesV1 } from "../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import {
  appendJupyterReflectionV1,
  verifyJupyterReflectionReadbackV1,
} from "../../extensions/code/JupyterNotebookV1";
import {
  appendInitiatingNoteReflectionMarkdown,
  type InitiatingNoteReflectionPlanV1,
} from "./initiatingNoteReflection";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const OPERATION_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const pathQueues = new Map<string, Promise<void>>();

export interface ReflectionWritebackStoreV1 {
  /** Read an existing explicitly bound file as UTF-8 text. */
  read(path: string): Promise<string>;
  /** Replace that exact existing file; creation and path resolution stay host-owned. */
  modify(path: string, content: string): Promise<void>;
}

export interface ReflectionWritebackReceiptV1 {
  version: 1;
  kind: "verified_reflection_writeback";
  id: string;
  status: "committed" | "already_applied";
  targetKind: "markdown_note" | "jupyter_notebook";
  path: string;
  operation: "append";
  marker: string;
  beforeSha256: string;
  afterSha256: string;
  bytesWritten: number;
  readbackVerified: true;
  executionPerformed: false;
  completedAt: string;
  fingerprint: string;
}

export interface AppendMarkdownReflectionWritebackInputV1 {
  operationId: string;
  target: { kind: "markdown_note"; notePath: string };
  expectedBeforeSha256: string;
  plan: Pick<InitiatingNoteReflectionPlanV1, "marker" | "markdown">;
  completedAt: string;
  store: ReflectionWritebackStoreV1;
}

export interface AppendJupyterReflectionWritebackInputV1 {
  operationId: string;
  target: { kind: "jupyter_notebook"; notebookPath: string };
  expectedBeforeSha256: string;
  markerId: string;
  markdown: string;
  codeExamples?: VerifiedCodeReflectionExamplesV1 | null;
  completedAt: string;
  store: ReflectionWritebackStoreV1;
}

/**
 * Append one meaningful Markdown reflection to an exact existing note, then
 * independently read it back and hash the result. Calls for the same path are
 * serialized inside the host process; stale pre-write hashes fail closed.
 */
export async function appendMarkdownReflectionWritebackV1(
  input: AppendMarkdownReflectionWritebackInputV1,
): Promise<ReflectionWritebackReceiptV1> {
  const path = safeVaultPath(input.target?.notePath, ".md", "Markdown reflection");
  if (input.target?.kind !== "markdown_note") {
    throw new Error("Markdown reflection requires an explicit note target.");
  }
  return serializePath(path, async () => {
    const common = parseWritebackCommon(input, path);
    const current = await readBounded(input.store, path);
    const beforeSha256 = sha256Text(current);
    const next = appendInitiatingNoteReflectionMarkdown(current, input.plan);
    const exactBody = input.plan.markdown.trim();
    if (next === current && (!exactBody || !current.includes(exactBody))) {
      throw new Error("Markdown reflection marker already exists with different content or provenance.");
    }
    if (beforeSha256 !== common.expectedBeforeSha256) {
      if (next !== current || !exactBody || !current.includes(exactBody)) {
        throw new Error("Markdown reflection target changed after its expected pre-write hash was captured.");
      }
    }
    return commitAndVerify({
      ...common,
      targetKind: "markdown_note",
      marker: boundedMarker(input.plan.marker),
      store: input.store,
      current,
      next,
    });
  });
}

/** Notebook equivalent of appendMarkdownReflectionWritebackV1; never executes cells. */
export async function appendJupyterReflectionWritebackV1(
  input: AppendJupyterReflectionWritebackInputV1,
): Promise<ReflectionWritebackReceiptV1> {
  const path = safeVaultPath(input.target?.notebookPath, ".ipynb", "Jupyter reflection");
  if (input.target?.kind !== "jupyter_notebook") {
    throw new Error("Jupyter reflection requires an explicit notebook target.");
  }
  return serializePath(path, async () => {
    const common = parseWritebackCommon(input, path);
    const current = await readBounded(input.store, path);
    const appended = appendJupyterReflectionV1({
      target: { kind: "jupyter_notebook", notebookPath: path },
      currentContent: current,
      expectedBeforeSha256: common.expectedBeforeSha256,
      markerId: input.markerId,
      markdown: input.markdown,
      codeExamples: input.codeExamples,
    });
    const receipt = await commitAndVerify({
      ...common,
      targetKind: "jupyter_notebook",
      marker: appended.marker,
      store: input.store,
      current,
      next: appended.content,
    });
    verifyJupyterReflectionReadbackV1(
      await readBounded(input.store, path),
      receipt.afterSha256,
    );
    return receipt;
  });
}

interface ParsedWritebackCommonV1 {
  id: string;
  path: string;
  expectedBeforeSha256: string;
  completedAt: string;
}

function parseWritebackCommon(
  input: {
    operationId: string;
    expectedBeforeSha256: string;
    completedAt: string;
    store: ReflectionWritebackStoreV1;
  },
  path: string,
): ParsedWritebackCommonV1 {
  if (!input.store || typeof input.store.read !== "function" || typeof input.store.modify !== "function") {
    throw new Error("Reflection writeback requires a read/modify store.");
  }
  if (!OPERATION_ID.test(input.operationId)) {
    throw new Error("Reflection writeback operation id is invalid.");
  }
  if (!SHA256.test(input.expectedBeforeSha256)) {
    throw new Error("Reflection writeback expected pre-write hash is invalid.");
  }
  if (
    typeof input.completedAt !== "string" ||
    !Number.isFinite(Date.parse(input.completedAt)) ||
    new Date(Date.parse(input.completedAt)).toISOString() !== input.completedAt
  ) {
    throw new Error("Reflection writeback completion time must be canonical ISO text.");
  }
  return {
    id: input.operationId,
    path,
    expectedBeforeSha256: input.expectedBeforeSha256,
    completedAt: input.completedAt,
  };
}

async function commitAndVerify(
  input: ParsedWritebackCommonV1 & {
    targetKind: ReflectionWritebackReceiptV1["targetKind"];
    marker: string;
    store: ReflectionWritebackStoreV1;
    current: string;
    next: string;
  },
): Promise<ReflectionWritebackReceiptV1> {
  const beforeSha256 = sha256Text(input.current);
  const expectedAfterSha256 = sha256Text(input.next);
  const alreadyApplied = input.current === input.next;
  if (!alreadyApplied) {
    const lastRead = await readBounded(input.store, input.path);
    if (sha256Text(lastRead) !== beforeSha256) {
      throw new Error("Reflection target changed immediately before writeback.");
    }
    await input.store.modify(input.path, input.next);
  }
  const observed = await readBounded(input.store, input.path);
  const afterSha256 = sha256Text(observed);
  if (afterSha256 !== expectedAfterSha256 || observed !== input.next) {
    throw new Error("Reflection writeback readback did not match the expected content hash.");
  }
  const evidence: Omit<ReflectionWritebackReceiptV1, "fingerprint"> = {
    version: 1,
    kind: "verified_reflection_writeback",
    id: input.id,
    status: alreadyApplied ? "already_applied" : "committed",
    targetKind: input.targetKind,
    path: input.path,
    operation: "append",
    marker: input.marker,
    beforeSha256,
    afterSha256,
    bytesWritten: alreadyApplied
      ? 0
      : new TextEncoder().encode(input.next).byteLength -
        new TextEncoder().encode(input.current).byteLength,
    readbackVerified: true,
    executionPerformed: false,
    completedAt: input.completedAt,
  };
  return {
    ...evidence,
    fingerprint: sha256Text(canonicalJson(evidence)),
  };
}

async function readBounded(
  store: ReflectionWritebackStoreV1,
  path: string,
): Promise<string> {
  const content = await store.read(path);
  if (typeof content !== "string" || content.length > 10_000_000 || content.includes("\0")) {
    throw new Error("Reflection target readback must be bounded text without null bytes.");
  }
  return content;
}

function safeVaultPath(value: unknown, extension: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    throw new Error(`${label} target path must be bounded text.`);
  }
  const path = value.trim();
  const parts = path.split("/");
  if (
    !path.toLowerCase().endsWith(extension) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /^[a-z]:/iu.test(path) ||
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))
  ) {
    throw new Error(`${label} target must be a safe vault-relative ${extension} path.`);
  }
  return path;
}

function boundedMarker(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new Error("Reflection writeback marker is invalid.");
  }
  return value;
}

function sha256Text(value: string): string {
  return `sha256:${portableSha256Text(value)}`;
}

async function serializePath<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  pathQueues.set(path, queued);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (pathQueues.get(path) === queued) pathQueues.delete(path);
  }
}
