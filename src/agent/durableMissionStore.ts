import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";
import {
  isDurableMissionRecoverable,
  normalizeDurableMissionManifest,
  type DurableMissionManifestV1,
} from "./durableMission";

export const DURABLE_MISSION_FOLDER = "Agent Runs/Missions";
export const DURABLE_MISSION_MANIFEST_HEADING =
  "## Durable Mission Manifest";

const DURABLE_MISSION_MANIFEST_BLOCK_PATTERN =
  /## Durable Mission Manifest\r?\n```json\r?\n[\s\S]*?\r?\n```/;
const durableMissionWriteQueues = new WeakMap<
  object,
  Map<string, Promise<void>>
>();

export interface DurableMissionManifestWriteOptions {
  /**
   * Compare-and-swap revision. When omitted, the manifest's current revision
   * is used so stale callers cannot silently overwrite a newer checkpoint.
   */
  expectedRevision?: number;
}

export interface DurableMissionManifestWriteResult {
  path: string;
  bytesWritten: number;
  revision: number;
}

export interface StoredDurableMissionManifest {
  path: string;
  manifest: DurableMissionManifestV1;
}

export interface StoredDurableMissionRecord extends StoredDurableMissionManifest {
  mtime: number;
}

export interface RecoverableDurableMission extends StoredDurableMissionRecord {}

export class DurableMissionRevisionConflictError extends Error {
  readonly code = "durable_mission_revision_conflict";

  constructor(
    readonly path: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Durable mission revision conflict at ${path}: expected ${expectedRevision}, found ${actualRevision}.`,
    );
    this.name = "DurableMissionRevisionConflictError";
  }
}

export function getDurableMissionManifestPath(missionId: string): string {
  return normalizeVaultPath(
    `${DURABLE_MISSION_FOLDER}/${sanitizeMissionId(missionId)}.md`,
    { requireMarkdown: true },
  );
}

export function formatDurableMissionManifestBlock(
  manifest: DurableMissionManifestV1,
): string {
  return [
    DURABLE_MISSION_MANIFEST_HEADING,
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "",
  ].join("\n");
}

export function parseDurableMissionManifestFromMarkdown(
  markdown: string,
): DurableMissionManifestV1 | null {
  const match = DURABLE_MISSION_MANIFEST_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return null;
  }
  const json = /```json\r?\n([\s\S]*?)\r?\n```/.exec(match[0])?.[1];
  if (!json) {
    return null;
  }
  try {
    return normalizeDurableMissionManifest(JSON.parse(json));
  } catch {
    return null;
  }
}

export function canPersistDurableMissionManifest(
  context: ToolExecutionContext,
): boolean {
  return hasDurableMissionVaultApi(context);
}

export async function writeDurableMissionManifest(
  context: ToolExecutionContext,
  manifest: DurableMissionManifestV1,
  options: DurableMissionManifestWriteOptions = {},
): Promise<DurableMissionManifestWriteResult | null> {
  if (!hasDurableMissionVaultApi(context)) {
    return null;
  }

  const requested = normalizeDurableMissionManifest(
    JSON.parse(JSON.stringify(manifest)),
  );
  if (!requested) {
    throw new Error("Cannot serialize an invalid durable mission manifest.");
  }
  const expectedRevision = normalizeExpectedRevision(
    options.expectedRevision ?? requested.revision,
  );
  const vault = context.app.vault;
  const path = getDurableMissionManifestPath(requested.missionId);

  return withSerializedDurableMissionWrite(
    vault,
    requested.missionId,
    async () => {
      const file = vault.getFileByPath(path);
      let current = "";
      let persisted: DurableMissionManifestV1 | null = null;
      if (file) {
        current = await vault.read(file as TFile);
        persisted = parseDurableMissionManifestFromMarkdown(current);
        if (
          DURABLE_MISSION_MANIFEST_BLOCK_PATTERN.test(current) &&
          !persisted
        ) {
          throw new Error(
            `Refusing to overwrite a malformed durable mission manifest at ${path}.`,
          );
        }
      }

      const actualRevision = persisted?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        throw new DurableMissionRevisionConflictError(
          path,
          expectedRevision,
          actualRevision,
        );
      }

      await ensureDurableMissionFolders(context);
      requested.revision = actualRevision + 1;
      requested.updatedAt = (context.now?.() ?? new Date()).toISOString();
      const block = formatDurableMissionManifestBlock(requested);

      if (!file) {
        const content = [
          `# Durable Mission ${sanitizeMissionId(requested.missionId)}`,
          "",
          block,
        ].join("\n");
        await vault.create(path, content);
        manifest.revision = requested.revision;
        manifest.updatedAt = requested.updatedAt;
        return {
          path,
          bytesWritten: getByteLength(content),
          revision: requested.revision,
        };
      }

      const next = replaceDurableMissionManifestBlock(current, block);
      await vault.modify(file as TFile, next);
      manifest.revision = requested.revision;
      manifest.updatedAt = requested.updatedAt;
      return {
        path,
        bytesWritten: getByteLength(block),
        revision: requested.revision,
      };
    },
  );
}

export async function readDurableMissionManifestById(
  context: ToolExecutionContext,
  missionId: string,
): Promise<StoredDurableMissionManifest | null> {
  if (!hasDurableMissionVaultApi(context)) {
    return null;
  }
  const vault = context.app.vault;
  return withSerializedDurableMissionWrite(vault, missionId, async () => {
    const path = getDurableMissionManifestPath(missionId);
    const file = vault.getFileByPath(path);
    if (!file) {
      return null;
    }
    const markdown = await vault.read(file as TFile);
    const manifest = parseDurableMissionManifestFromMarkdown(markdown);
    return manifest ? { path, manifest } : null;
  });
}

export async function listRecoverableDurableMissions(
  context: ToolExecutionContext,
  now: Date = context.now?.() ?? new Date(),
): Promise<RecoverableDurableMission[]> {
  return (await listDurableMissionManifests(context)).filter(({ manifest }) =>
    isDurableMissionRecoverable(manifest, now),
  );
}

export async function listDurableMissionManifests(
  context: ToolExecutionContext,
): Promise<StoredDurableMissionRecord[]> {
  if (
    !hasDurableMissionVaultApi(context) ||
    typeof context.app.vault.getFiles !== "function"
  ) {
    return [];
  }
  const vault = context.app.vault;
  const candidates = vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/Missions\/[^/]+\.md$/i.test(file.path));
  const records: StoredDurableMissionRecord[] = [];

  for (const file of candidates) {
    const markdown = await withSerializedDurableMissionWrite(
      vault,
      file.basename || file.path,
      () => vault.read(file),
    );
    const manifest = parseDurableMissionManifestFromMarkdown(markdown);
    if (manifest) {
      records.push({
        path: file.path,
        manifest,
        mtime: file.stat?.mtime ?? 0,
      });
    }
  }

  return records.sort((left, right) => {
    const updatedDelta =
      Date.parse(right.manifest.updatedAt) - Date.parse(left.manifest.updatedAt);
    return updatedDelta || right.mtime - left.mtime;
  });
}

export async function readLatestRecoverableDurableMission(
  context: ToolExecutionContext,
  now: Date = context.now?.() ?? new Date(),
): Promise<RecoverableDurableMission | null> {
  return (await listRecoverableDurableMissions(context, now))[0] ?? null;
}

/** Serializes reads and compare-and-swap writes per vault and mission id. */
export async function withSerializedDurableMissionWrite<T>(
  vault: object,
  missionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = durableMissionWriteQueues.get(vault);
  if (!queues) {
    queues = new Map<string, Promise<void>>();
    durableMissionWriteQueues.set(vault, queues);
  }
  const key = sanitizeMissionId(missionId);
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  try {
    return await result;
  } finally {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  }
}

async function ensureDurableMissionFolders(
  context: ToolExecutionContext,
): Promise<void> {
  const vault = context.app.vault;
  for (const folder of ["Agent Runs", DURABLE_MISSION_FOLDER]) {
    if (vault.getFolderByPath(folder)) {
      continue;
    }
    try {
      await vault.createFolder(folder);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
}

function replaceDurableMissionManifestBlock(
  current: string,
  block: string,
): string {
  if (DURABLE_MISSION_MANIFEST_BLOCK_PATTERN.test(current)) {
    return current.replace(
      DURABLE_MISSION_MANIFEST_BLOCK_PATTERN,
      block.trimEnd(),
    );
  }
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${block}`;
}

function hasDurableMissionVaultApi(context: ToolExecutionContext): boolean {
  const vault = context.app?.vault;
  return Boolean(
    vault &&
      typeof vault.getFileByPath === "function" &&
      typeof vault.create === "function" &&
      typeof vault.modify === "function" &&
      typeof vault.read === "function" &&
      typeof vault.getFolderByPath === "function" &&
      typeof vault.createFolder === "function",
  );
}

function normalizeExpectedRevision(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("expectedRevision must be a non-negative integer.");
  }
  return value;
}

function sanitizeMissionId(missionId: string): string {
  return (
    missionId
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "mission"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
