import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";
import {
  parseMissionGraphJournalEntryV1,
  parseMissionGraphPatchV1,
  parseMissionGraphV3,
  reduceMissionGraphPatchV1,
  replayPreparedMissionGraphPatchV1,
  type MissionGraphJournalEntryV1,
  type MissionGraphPatchV1,
  type MissionGraphV3,
} from "./missionGraphV3";
import { sha256Fingerprint } from "./actions/canonicalize";
import {
  createResourceLockState,
  normalizeResourceLockState,
  type ResourceLockStateV1,
} from "./queue/resourceLocks";

export const MISSION_GRAPH_STORE_RECORD_VERSION = 1 as const;
export const MISSION_GRAPH_STORE_FOLDER = "Agent Runs/Mission Graphs";
export const MISSION_GRAPH_STORE_HEADING = "## Mission Graph Store";
export const MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES = 64;

const MISSION_GRAPH_STORE_BLOCK_PATTERN =
  /## Mission Graph Store\r?\n```json\r?\n[\s\S]*?\r?\n```/;
const missionGraphStoreQueues = new WeakMap<object, Map<string, Promise<void>>>();

export interface MissionGraphStoreRecordV1 {
  version: typeof MISSION_GRAPH_STORE_RECORD_VERSION;
  /** Store CAS revision. This is deliberately independent of graph.revision. */
  storeRevision: number;
  missionId: string;
  graph: MissionGraphV3;
  journal: MissionGraphJournalEntryV1[];
  resourceLocks: ResourceLockStateV1;
  createdAt: string;
  updatedAt: string;
  recordFingerprint: string;
}

export interface StoredMissionGraphRecord {
  path: string;
  record: MissionGraphStoreRecordV1;
}

export interface MissionGraphStoreWriteResult extends StoredMissionGraphRecord {
  bytesWritten: number;
  written: boolean;
}

export interface MissionGraphStoreRecoveryResult
  extends MissionGraphStoreWriteResult {
  recovered: boolean;
  patchId?: string;
}

export interface MissionGraphStorePatchOptions {
  expectedStoreRevision: number;
  preparedAt?: string;
  appliedAt?: string;
}

export class MissionGraphStoreRevisionConflictError extends Error {
  readonly code = "mission_graph_store_revision_conflict";

  constructor(
    readonly path: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Mission graph store revision conflict at ${path}: expected ${expectedRevision}, found ${actualRevision}.`,
    );
    this.name = "MissionGraphStoreRevisionConflictError";
  }
}

export class MissionGraphStoreIntegrityError extends Error {
  readonly code = "mission_graph_store_integrity_error";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    if (Object.prototype.hasOwnProperty.call(options, "cause")) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: true,
      });
    }
    this.name = "MissionGraphStoreIntegrityError";
  }
}

export class MissionGraphStorePatchConflictError extends Error {
  readonly code = "mission_graph_store_patch_conflict";

  constructor(message: string) {
    super(message);
    this.name = "MissionGraphStorePatchConflictError";
  }
}

export function getMissionGraphStorePath(missionId: string): string {
  const normalizedMissionId = requireMissionId(missionId);
  return normalizeVaultPath(
    `${MISSION_GRAPH_STORE_FOLDER}/${sanitizeMissionId(normalizedMissionId)}.md`,
    { requireMarkdown: true },
  );
}

export function canPersistMissionGraphStore(
  context: ToolExecutionContext,
): boolean {
  return hasMissionGraphStoreVaultApi(context);
}

export function formatMissionGraphStoreBlock(
  record: MissionGraphStoreRecordV1,
): string {
  return [
    MISSION_GRAPH_STORE_HEADING,
    "```json",
    JSON.stringify(record, null, 2),
    "```",
    "",
  ].join("\n");
}

/**
 * Returns null only when the store block is absent. A present but malformed,
 * tampered, or internally inconsistent block always throws and therefore
 * fails closed.
 */
export async function parseMissionGraphStoreRecordFromMarkdown(
  markdown: string,
): Promise<MissionGraphStoreRecordV1 | null> {
  const match = MISSION_GRAPH_STORE_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return null;
  }
  const json = /```json\r?\n([\s\S]*?)\r?\n```/.exec(match[0])?.[1];
  if (!json) {
    throw new MissionGraphStoreIntegrityError(
      "Mission graph store block is missing its JSON payload.",
    );
  }
  try {
    return await parseMissionGraphStoreRecord(JSON.parse(json));
  } catch (error) {
    if (error instanceof MissionGraphStoreIntegrityError) {
      throw error;
    }
    throw new MissionGraphStoreIntegrityError(
      `Mission graph store block is invalid: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function parseMissionGraphStoreRecord(
  value: unknown,
): Promise<MissionGraphStoreRecordV1> {
  try {
    const source = expectRecord(value, "Mission graph store record");
    assertExactKeys(source, [
      "version",
      "storeRevision",
      "missionId",
      "graph",
      "journal",
      "resourceLocks",
      "createdAt",
      "updatedAt",
      "recordFingerprint",
    ]);
    if (source.version !== MISSION_GRAPH_STORE_RECORD_VERSION) {
      throw new Error("Unsupported mission graph store record version.");
    }
    const storeRevision = expectNonNegativeInteger(
      source.storeRevision,
      "storeRevision",
    );
    if (storeRevision < 1) {
      throw new Error("Persisted mission graph storeRevision must be at least 1.");
    }
    const missionId = requireMissionId(source.missionId);
    const graph = await parseMissionGraphV3(source.graph);
    if (graph.missionId !== missionId) {
      throw new Error("Mission graph store and graph mission IDs do not match.");
    }
    if (!Array.isArray(source.journal)) {
      throw new Error("Mission graph store journal must be an array.");
    }
    if (source.journal.length > MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES) {
      throw new Error(
        `Mission graph store journal exceeds ${MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES} entries.`,
      );
    }
    const journal: MissionGraphJournalEntryV1[] = [];
    for (const entry of source.journal) {
      journal.push(await parseMissionGraphJournalEntryV1(entry));
    }
    let resourceLocks: ResourceLockStateV1;
    try {
      resourceLocks = normalizeResourceLockState(source.resourceLocks);
    } catch (error) {
      throw new Error(
        `Mission graph resource lock state is invalid: ${getErrorMessage(error)}`,
      );
    }
    const createdAt = expectCanonicalTimestamp(source.createdAt, "createdAt");
    const updatedAt = expectCanonicalTimestamp(source.updatedAt, "updatedAt");
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw new Error("Mission graph store updatedAt precedes createdAt.");
    }
    const recordFingerprint = expectFingerprint(
      source.recordFingerprint,
      "recordFingerprint",
    );
    const payload = {
      version: MISSION_GRAPH_STORE_RECORD_VERSION,
      storeRevision,
      missionId,
      graph,
      journal,
      resourceLocks,
      createdAt,
      updatedAt,
    };
    if ((await sha256Fingerprint(payload)) !== recordFingerprint) {
      throw new Error("Mission graph store record fingerprint does not match.");
    }
    await assertJournalChain(graph, journal);
    return cloneJson({ ...payload, recordFingerprint });
  } catch (error) {
    if (error instanceof MissionGraphStoreIntegrityError) {
      throw error;
    }
    throw new MissionGraphStoreIntegrityError(
      `Mission graph store record is invalid: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function readMissionGraphStoreRecord(
  context: ToolExecutionContext,
  missionId: string,
): Promise<StoredMissionGraphRecord | null> {
  if (!hasMissionGraphStoreVaultApi(context)) {
    return null;
  }
  const normalizedMissionId = requireMissionId(missionId);
  const vault = context.app.vault;
  return withSerializedMissionGraphStoreWrite(
    vault,
    normalizedMissionId,
    () => readStoredRecordUnlocked(context, normalizedMissionId),
  );
}

export async function persistInitialMissionGraph(
  context: ToolExecutionContext,
  graphValue: unknown,
  options: { resourceLocks?: ResourceLockStateV1 } = {},
): Promise<MissionGraphStoreWriteResult> {
  const graph = await parseMissionGraphV3(graphValue);
  if (
    graph.revision !== 0 ||
    graph.journalHeadFingerprint !== null ||
    graph.continuationCheckpoint !== null
  ) {
    throw new MissionGraphStoreIntegrityError(
      "An initial mission graph must start at revision 0 without a journal head or continuation checkpoint.",
    );
  }
  return mutateMissionGraphStoreRecord(
    context,
    graph.missionId,
    0,
    async (current, now) => {
      if (current) {
        throw new MissionGraphStoreRevisionConflictError(
          getMissionGraphStorePath(graph.missionId),
          0,
          current.storeRevision,
        );
      }
      const resourceLocks = options.resourceLocks
        ? normalizeResourceLockState(options.resourceLocks)
        : createResourceLockState(now);
      return {
        graph,
        journal: [],
        resourceLocks,
      };
    },
  );
}

/** Persist the full prepared patch record while leaving the graph unchanged. */
export async function persistPreparedMissionGraphPatch(
  context: ToolExecutionContext,
  missionId: string,
  patchValue: unknown,
  options: MissionGraphStorePatchOptions,
): Promise<MissionGraphStoreWriteResult> {
  const patch = parseMissionGraphPatchV1(patchValue);
  if (patch.missionId !== requireMissionId(missionId)) {
    throw new MissionGraphStorePatchConflictError(
      "Mission graph patch belongs to another mission.",
    );
  }
  return mutateMissionGraphStoreRecord(
    context,
    missionId,
    normalizeExpectedRevision(options.expectedStoreRevision),
    async (current) => {
      const stored = requireCurrentRecord(current, missionId);
      assertNoPendingPreparedPatch(stored.journal);
      if (stored.journal.some((entry) => entry.patchId === patch.patchId)) {
        throw new MissionGraphStorePatchConflictError(
          `Mission graph patch id ${patch.patchId} is already present in the retained journal.`,
        );
      }
      const reduction = await reduceMissionGraphPatchV1(stored.graph, patch, {
        preparedAt: options.preparedAt,
        appliedAt: options.appliedAt,
      });
      return {
        graph: stored.graph,
        journal: appendBoundedJournal(
          stored.journal,
          reduction.preparedJournalEntry,
        ),
        resourceLocks: stored.resourceLocks,
      };
    },
  );
}

/**
 * Replay the final prepared patch against the persisted graph and atomically
 * persist both the applied graph and the applied journal record.
 */
export async function persistAppliedMissionGraphPatch(
  context: ToolExecutionContext,
  missionId: string,
  patchId: string,
  options: { expectedStoreRevision: number },
): Promise<MissionGraphStoreWriteResult> {
  const normalizedPatchId = requirePatchId(patchId);
  return mutateMissionGraphStoreRecord(
    context,
    missionId,
    normalizeExpectedRevision(options.expectedStoreRevision),
    async (current) => {
      const stored = requireCurrentRecord(current, missionId);
      const last = stored.journal.at(-1);
      if (last?.patchId === normalizedPatchId && last.state === "applied") {
        return null;
      }
      if (!last || last.patchId !== normalizedPatchId || last.state !== "prepared") {
        const retained = stored.journal.some(
          (entry) => entry.patchId === normalizedPatchId,
        );
        throw new MissionGraphStorePatchConflictError(
          retained
            ? `Mission graph patch ${normalizedPatchId} is not the final prepared patch.`
            : `Mission graph patch ${normalizedPatchId} is not prepared.`,
        );
      }
      const replayed = await replayPreparedMissionGraphPatchV1(
        stored.graph,
        last,
      );
      return {
        graph: replayed.graph,
        journal: [
          ...stored.journal.slice(0, -1),
          replayed.journalEntry,
        ],
        resourceLocks: stored.resourceLocks,
      };
    },
  );
}

/** Convenience wrapper that necessarily performs two durable CAS writes. */
export async function persistMissionGraphPatchTransaction(
  context: ToolExecutionContext,
  missionId: string,
  patchValue: unknown,
  options: MissionGraphStorePatchOptions,
): Promise<MissionGraphStoreWriteResult> {
  const patch = parseMissionGraphPatchV1(patchValue);
  const prepared = await persistPreparedMissionGraphPatch(
    context,
    missionId,
    patch,
    options,
  );
  return persistAppliedMissionGraphPatch(context, missionId, patch.patchId, {
    expectedStoreRevision: prepared.record.storeRevision,
  });
}

/**
 * Recovers the only safe crash window: a final prepared patch. Calling this
 * repeatedly is idempotent; once applied, later calls perform no write.
 */
export async function recoverFinalPreparedMissionGraphPatch(
  context: ToolExecutionContext,
  missionId: string,
  options: { expectedStoreRevision?: number } = {},
): Promise<MissionGraphStoreRecoveryResult> {
  let recoveredPatchId: string | undefined;
  const result = await mutateMissionGraphStoreRecord(
    context,
    missionId,
    options.expectedStoreRevision === undefined
      ? undefined
      : normalizeExpectedRevision(options.expectedStoreRevision),
    async (current) => {
      const stored = requireCurrentRecord(current, missionId);
      const last = stored.journal.at(-1);
      if (!last || last.state !== "prepared") {
        return null;
      }
      recoveredPatchId = last.patchId;
      const replayed = await replayPreparedMissionGraphPatchV1(
        stored.graph,
        last,
      );
      return {
        graph: replayed.graph,
        journal: [
          ...stored.journal.slice(0, -1),
          replayed.journalEntry,
        ],
        resourceLocks: stored.resourceLocks,
      };
    },
  );
  return {
    ...result,
    recovered: result.written && recoveredPatchId !== undefined,
    ...(recoveredPatchId ? { patchId: recoveredPatchId } : {}),
  };
}

/** Persist a validated lock-state revision without changing graph authority. */
export async function persistMissionGraphResourceLocks(
  context: ToolExecutionContext,
  missionId: string,
  resourceLocksValue: unknown,
  options: { expectedStoreRevision: number },
): Promise<MissionGraphStoreWriteResult> {
  let resourceLocks: ResourceLockStateV1;
  try {
    resourceLocks = normalizeResourceLockState(resourceLocksValue);
  } catch (error) {
    throw new MissionGraphStoreIntegrityError(
      `Refusing to persist malformed mission resource locks: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  return mutateMissionGraphStoreRecord(
    context,
    missionId,
    normalizeExpectedRevision(options.expectedStoreRevision),
    async (current) => {
      const stored = requireCurrentRecord(current, missionId);
      return {
        graph: stored.graph,
        journal: stored.journal,
        resourceLocks,
      };
    },
  );
}

/** Serializes reads and CAS writes per vault and canonical mission id. */
export async function withSerializedMissionGraphStoreWrite<T>(
  vault: object,
  missionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = missionGraphStoreQueues.get(vault);
  if (!queues) {
    queues = new Map<string, Promise<void>>();
    missionGraphStoreQueues.set(vault, queues);
  }
  const key = sanitizeMissionId(requireMissionId(missionId));
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

interface MissionGraphStoreState {
  graph: MissionGraphV3;
  journal: MissionGraphJournalEntryV1[];
  resourceLocks: ResourceLockStateV1;
}

async function mutateMissionGraphStoreRecord(
  context: ToolExecutionContext,
  missionIdValue: string,
  expectedStoreRevision: number | undefined,
  mutate: (
    current: MissionGraphStoreRecordV1 | null,
    now: string,
  ) => Promise<MissionGraphStoreState | null>,
): Promise<MissionGraphStoreWriteResult> {
  if (!hasMissionGraphStoreVaultApi(context)) {
    throw new Error("Mission graph persistence is unavailable in this vault.");
  }
  const missionId = requireMissionId(missionIdValue);
  const path = getMissionGraphStorePath(missionId);
  const vault = context.app.vault;
  return withSerializedMissionGraphStoreWrite(vault, missionId, async () => {
    const stored = await readStoredRecordUnlocked(context, missionId);
    const current = stored?.record ?? null;
    const actualRevision = current?.storeRevision ?? 0;
    if (
      expectedStoreRevision !== undefined &&
      actualRevision !== expectedStoreRevision
    ) {
      throw new MissionGraphStoreRevisionConflictError(
        path,
        expectedStoreRevision,
        actualRevision,
      );
    }
    const now = (context.now?.() ?? new Date()).toISOString();
    const nextState = await mutate(current, now);
    if (nextState === null) {
      if (!current) {
        throw new MissionGraphStoreIntegrityError(
          "Mission graph mutation returned no record for an absent mission.",
        );
      }
      return {
        path,
        record: current,
        bytesWritten: 0,
        written: false,
      };
    }
    const next = await buildMissionGraphStoreRecord({
      storeRevision: actualRevision + 1,
      missionId,
      graph: nextState.graph,
      journal: nextState.journal,
      resourceLocks: nextState.resourceLocks,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    const bytesWritten = await writeStoreRecordUnlocked(
      context,
      path,
      next,
      current !== null,
    );
    const readback = await readStoredRecordUnlocked(context, missionId);
    if (
      !readback ||
      readback.record.storeRevision !== next.storeRevision ||
      readback.record.recordFingerprint !== next.recordFingerprint
    ) {
      throw new MissionGraphStoreIntegrityError(
        `Mission graph store readback did not match revision ${next.storeRevision}.`,
      );
    }
    return {
      path,
      record: readback.record,
      bytesWritten,
      written: true,
    };
  });
}

async function buildMissionGraphStoreRecord(input: {
  storeRevision: number;
  missionId: string;
  graph: unknown;
  journal: unknown[];
  resourceLocks: unknown;
  createdAt: string;
  updatedAt: string;
}): Promise<MissionGraphStoreRecordV1> {
  const storeRevision = expectNonNegativeInteger(
    input.storeRevision,
    "storeRevision",
  );
  if (storeRevision < 1) {
    throw new MissionGraphStoreIntegrityError(
      "Persisted mission graph storeRevision must be at least 1.",
    );
  }
  const missionId = requireMissionId(input.missionId);
  const graph = await parseMissionGraphV3(input.graph);
  if (graph.missionId !== missionId) {
    throw new MissionGraphStoreIntegrityError(
      "Mission graph store and graph mission IDs do not match.",
    );
  }
  if (input.journal.length > MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES) {
    throw new MissionGraphStoreIntegrityError(
      `Mission graph store journal exceeds ${MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES} entries.`,
    );
  }
  const journal: MissionGraphJournalEntryV1[] = [];
  for (const entry of input.journal) {
    journal.push(await parseMissionGraphJournalEntryV1(entry));
  }
  let resourceLocks: ResourceLockStateV1;
  try {
    resourceLocks = normalizeResourceLockState(input.resourceLocks);
  } catch (error) {
    throw new MissionGraphStoreIntegrityError(
      `Mission graph resource lock state is invalid: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  const createdAt = expectCanonicalTimestamp(input.createdAt, "createdAt");
  const updatedAt = expectCanonicalTimestamp(input.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new MissionGraphStoreIntegrityError(
      "Mission graph store updatedAt precedes createdAt.",
    );
  }
  const payload = {
    version: MISSION_GRAPH_STORE_RECORD_VERSION,
    storeRevision,
    missionId,
    graph,
    journal,
    resourceLocks,
    createdAt,
    updatedAt,
  };
  await assertJournalChain(graph, journal);
  return cloneJson({
    ...payload,
    recordFingerprint: await sha256Fingerprint(payload),
  });
}

async function assertJournalChain(
  graph: MissionGraphV3,
  journal: MissionGraphJournalEntryV1[],
): Promise<void> {
  const patchIds = new Set<string>();
  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index];
    if (entry.missionId !== graph.missionId) {
      throw new Error("Mission graph journal contains another mission ID.");
    }
    if (patchIds.has(entry.patchId)) {
      throw new Error(`Mission graph journal has duplicate patch id ${entry.patchId}.`);
    }
    patchIds.add(entry.patchId);
    if (entry.state === "prepared" && index !== journal.length - 1) {
      throw new Error("Only the final mission graph journal entry may be prepared.");
    }
    if (index === 0) {
      continue;
    }
    const previous = journal[index - 1];
    if (previous.state !== "applied") {
      throw new Error("A prepared mission graph patch cannot have a successor.");
    }
    if (
      previous.nextRevision !== entry.previousRevision ||
      previous.journalFingerprint !== entry.previousJournalFingerprint ||
      previous.afterGraphFingerprint !== entry.beforeGraphFingerprint
    ) {
      throw new Error("Mission graph journal chain is broken.");
    }
  }

  const last = journal.at(-1);
  const graphFingerprint = await sha256Fingerprint(graph);
  if (!last) {
    if (graph.revision !== 0 || graph.journalHeadFingerprint !== null) {
      throw new Error("A journal-free mission graph must be at revision 0.");
    }
    return;
  }
  if (last.state === "applied") {
    if (
      graphFingerprint !== last.afterGraphFingerprint ||
      graph.revision !== last.nextRevision ||
      graph.journalHeadFingerprint !== last.journalFingerprint
    ) {
      throw new Error("Applied mission graph journal head does not match the graph.");
    }
    return;
  }

  const graphIsBefore = graphFingerprint === last.beforeGraphFingerprint;
  const graphIsAfter = graphFingerprint === last.afterGraphFingerprint;
  if (!graphIsBefore && !graphIsAfter) {
    throw new Error("Prepared mission graph journal does not match graph state.");
  }
  if (
    graphIsBefore &&
    (graph.revision !== last.previousRevision ||
      graph.journalHeadFingerprint !== last.previousJournalFingerprint)
  ) {
    throw new Error("Prepared mission graph journal has an invalid before state.");
  }
  if (
    graphIsAfter &&
    (graph.revision !== last.nextRevision ||
      graph.journalHeadFingerprint !== last.journalFingerprint)
  ) {
    throw new Error("Prepared mission graph journal has an invalid after state.");
  }
}

function appendBoundedJournal(
  journal: MissionGraphJournalEntryV1[],
  entry: MissionGraphJournalEntryV1,
): MissionGraphJournalEntryV1[] {
  return [...journal, entry].slice(-MAX_MISSION_GRAPH_STORE_JOURNAL_ENTRIES);
}

function assertNoPendingPreparedPatch(
  journal: MissionGraphJournalEntryV1[],
): void {
  const pending = journal.at(-1);
  if (pending?.state === "prepared") {
    throw new MissionGraphStorePatchConflictError(
      `Mission graph patch ${pending.patchId} is prepared and must be recovered or applied first.`,
    );
  }
}

function requireCurrentRecord(
  current: MissionGraphStoreRecordV1 | null,
  missionId: string,
): MissionGraphStoreRecordV1 {
  if (!current) {
    throw new MissionGraphStorePatchConflictError(
      `Mission graph ${requireMissionId(missionId)} is not persisted.`,
    );
  }
  return current;
}

async function readStoredRecordUnlocked(
  context: ToolExecutionContext,
  missionId: string,
): Promise<StoredMissionGraphRecord | null> {
  const path = getMissionGraphStorePath(missionId);
  const file = context.app.vault.getFileByPath(path);
  if (!file) {
    return null;
  }
  const markdown = await context.app.vault.read(file as TFile);
  const record = await parseMissionGraphStoreRecordFromMarkdown(markdown);
  if (!record) {
    throw new MissionGraphStoreIntegrityError(
      `Refusing to use mission graph file without a store block: ${path}.`,
    );
  }
  if (record.missionId !== missionId) {
    throw new MissionGraphStoreIntegrityError(
      `Mission graph path collision at ${path}; stored mission id is ${record.missionId}.`,
    );
  }
  return { path, record };
}

async function writeStoreRecordUnlocked(
  context: ToolExecutionContext,
  path: string,
  record: MissionGraphStoreRecordV1,
  existing: boolean,
): Promise<number> {
  await ensureMissionGraphStoreFolders(context);
  const block = formatMissionGraphStoreBlock(record);
  if (!existing) {
    const content = [
      `# Mission Graph ${sanitizeMissionId(record.missionId)}`,
      "",
      block,
    ].join("\n");
    await context.app.vault.create(path, content);
    return getByteLength(content);
  }
  const file = context.app.vault.getFileByPath(path);
  if (!file) {
    throw new MissionGraphStoreIntegrityError(
      `Mission graph store disappeared before write: ${path}.`,
    );
  }
  const current = await context.app.vault.read(file as TFile);
  if (!MISSION_GRAPH_STORE_BLOCK_PATTERN.test(current)) {
    throw new MissionGraphStoreIntegrityError(
      `Refusing to overwrite mission graph file without a valid store block: ${path}.`,
    );
  }
  const next = current.replace(
    MISSION_GRAPH_STORE_BLOCK_PATTERN,
    block.trimEnd(),
  );
  await context.app.vault.modify(file as TFile, next);
  return getByteLength(block);
}

async function ensureMissionGraphStoreFolders(
  context: ToolExecutionContext,
): Promise<void> {
  for (const folder of ["Agent Runs", MISSION_GRAPH_STORE_FOLDER]) {
    if (context.app.vault.getFolderByPath(folder)) {
      continue;
    }
    try {
      await context.app.vault.createFolder(folder);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
}

function hasMissionGraphStoreVaultApi(
  context: ToolExecutionContext,
): boolean {
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

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new Error("Mission graph store record keys are invalid.");
  }
}

function expectNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function normalizeExpectedRevision(value: number): number {
  return expectNonNegativeInteger(value, "expectedStoreRevision");
}

function expectCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  const canonical = new Date(value).toISOString();
  if (value !== canonical) {
    throw new Error(`${label} must use canonical UTC ISO form.`);
  }
  return canonical;
}

function expectFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function requireMissionId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("missionId must be text.");
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error("missionId is invalid.");
  }
  return normalized;
}

function requirePatchId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("patchId must be text.");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("patchId is invalid.");
  }
  return normalized;
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
  return /already exists/i.test(getErrorMessage(error));
}

function getByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
