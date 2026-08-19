import {
  assertCanonicalContract,
  assertExactKeys,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectInteger,
  expectIsoTimestamp,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
} from "../integrations/linear/LinearContractSupport";
import { assertCleanLinearHumanOutputV1 } from "../integrations/linear/LinearIssueFormatV1";
import {
  acknowledgeLinearProgressOutboxItemV1,
  formatLinearProgressCommentV1,
  parseLinearProgressOutboxItemV1,
  parseLinearProjectProgressCursorV1,
  parseProjectWorkUnitLinearBindingV1,
  projectLinearProgressV1,
  recordLinearProgressOutboxFailureV1,
  type LinearProgressOutboxItemV1,
  type LinearProjectProgressCursorV1,
  type LinearProjectProgressTargetV1,
  type ProjectWorkUnitLinearBindingV1,
} from "./projectProgressProjection";
import {
  parseProjectStageEventV1,
  type ProjectStageEventV1,
} from "./projectRunReport";

export const PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION = 1 as const;
export const PROJECT_LINEAR_PROGRESS_RUN_LIMIT = 200;
// Timeline replay deliberately re-derives every phase boundary. Keep this cap
// low enough that corrupted plugin data cannot turn exact parsing into an
// unbounded quadratic startup cost.
export const PROJECT_LINEAR_PROGRESS_EVENT_LIMIT = 500;
export const PROJECT_LINEAR_PROGRESS_OUTBOX_LIMIT = 2_000;

export interface ProjectLinearProgressRunV1 {
  version: typeof PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION;
  runId: string;
  revision: number;
  bindings: ProjectWorkUnitLinearBindingV1[];
  events: ProjectStageEventV1[];
  cursor: LinearProjectProgressCursorV1;
  outbox: LinearProgressOutboxItemV1[];
  updatedAt: string;
  stateFingerprint: string;
}

type ProjectLinearProgressRunUnsignedV1 = Omit<
  ProjectLinearProgressRunV1,
  "stateFingerprint"
>;

export interface ProjectLinearProgressNamespaceV1 {
  version: typeof PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION;
  revision: number;
  runs: Record<string, ProjectLinearProgressRunV1>;
  namespaceFingerprint: string;
}

type ProjectLinearProgressNamespaceUnsignedV1 = Omit<
  ProjectLinearProgressNamespaceV1,
  "namespaceFingerprint"
>;

/**
 * The host owns the physical plugin-data write and must compare expectedRevision
 * before replacing this namespace. Returning false is an explicit CAS conflict.
 */
export interface ProjectLinearProgressPersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(
    namespace: ProjectLinearProgressNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean | void>;
}

export interface LinearProgressPhaseBoundaryCommandV1 {
  version: typeof PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION;
  commandId: string;
  runId: string;
  workUnitId: string;
  linearIssueId: string;
  target: LinearProjectProgressTargetV1;
  comment: string;
  sourceEventIds: string[];
  idempotencyKey: string;
  requiredReadbacks: ["comment", "issue_state"];
  commandFingerprint: string;
}

type LinearProgressPhaseBoundaryCommandUnsignedV1 = Omit<
  LinearProgressPhaseBoundaryCommandV1,
  "commandFingerprint"
>;

export interface IngestProjectLinearProgressInputV1 {
  runId: string;
  events: readonly ProjectStageEventV1[];
  bindings: readonly ProjectWorkUnitLinearBindingV1[];
  processedAt: string;
}

export interface AcknowledgeProjectLinearProgressInputV1 {
  runId: string;
  commandId: string;
  commandFingerprint: string;
  providerReceiptId: string;
  providerReceiptFingerprint: string;
  verifiedAt: string;
}

export interface FailProjectLinearProgressInputV1 {
  runId: string;
  commandId: string;
  commandFingerprint: string;
  failedAt: string;
  error: string;
  /** Retry is allowed only when provider readback proves no mutation landed. */
  outcome: "verified_not_applied" | "terminal_blocked";
}

/**
 * Durable, provider-agnostic Linear progress controller.
 *
 * It never calls Linear. The host reads explicit pending commands, prepares the
 * fixed comment/state mutations under its existing authority grant, performs
 * provider readback, then acknowledges with a composite receipt fingerprint.
 * Ambiguous provider outcomes must not be acknowledged or marked retryable.
 */
export class ProjectLinearProgressRuntimeV1 {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: ProjectLinearProgressPersistenceV1,
  ) {}

  recordEvents(
    input: IngestProjectLinearProgressInputV1,
  ): Promise<{
    run: ProjectLinearProgressRunV1;
    pendingCommands: LinearProgressPhaseBoundaryCommandV1[];
    changed: boolean;
  }> {
    return this.ingest(input);
  }

  ingest(
    input: IngestProjectLinearProgressInputV1,
  ): Promise<{
    run: ProjectLinearProgressRunV1;
    pendingCommands: LinearProgressPhaseBoundaryCommandV1[];
    changed: boolean;
  }> {
    return this.serialized(async () => {
      const runId = expectOpaqueId(input.runId, "project run id");
      const processedAt = expectIsoTimestamp(
        input.processedAt,
        "Linear progress processing time",
      );
      const suppliedBindings = normalizeBindings(input.bindings);
      if (suppliedBindings.length === 0) {
        throw new DurableLinearContractError(
          "Linear progress requires at least one exact work-unit binding.",
        );
      }
      const suppliedEvents = normalizeEvents(input.events);
      if (suppliedEvents.length === 0) {
        throw new DurableLinearContractError(
          "Linear progress requires at least one durable project-stage event.",
        );
      }
      assertRunIdentity(runId, suppliedBindings, suppliedEvents);

      const namespace = parseProjectLinearProgressNamespaceV1(
        await this.persistence.read(),
      );
      const previous = namespace.runs[runId] ?? null;
      if (previous) {
        assertBindingsUnchanged(previous.bindings, suppliedBindings);
        if (processedAt < previous.updatedAt) {
          throw new DurableLinearContractError(
            "Linear progress processing time cannot move backwards.",
          );
        }
      }

      const events = mergeEvents(previous?.events ?? [], suppliedEvents);
      assertEventLimit(events);
      if (events.some((event) => event.occurredAt > processedAt)) {
        throw new DurableLinearContractError(
          "Linear progress cannot persist a project event from the future.",
        );
      }
      const changed = !previous || events.length !== previous.events.length;
      if (!changed) {
        return {
          run: clone(previous!),
          pendingCommands: commandsFromRun(previous!),
          changed: false,
        };
      }

      const projection = projectEventTimeline(
        runId,
        events,
        suppliedBindings,
        previous?.outbox ?? [],
      );
      const run = createRunState({
        version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
        runId,
        revision: (previous?.revision ?? 0) + 1,
        bindings: suppliedBindings,
        events,
        cursor: projection.cursor,
        outbox: projection.outbox,
        updatedAt: processedAt,
      });
      const saved = await this.saveRun(namespace, run);
      return {
        run: clone(saved),
        pendingCommands: commandsFromRun(saved),
        changed: true,
      };
    });
  }

  load(runIdInput: string): Promise<ProjectLinearProgressRunV1 | null> {
    return this.serialized(async () => {
      const runId = expectOpaqueId(runIdInput, "project run id");
      const namespace = parseProjectLinearProgressNamespaceV1(
        await this.persistence.read(),
      );
      return clone(namespace.runs[runId] ?? null);
    });
  }

  pendingCommands(
    runIdInput: string,
  ): Promise<LinearProgressPhaseBoundaryCommandV1[]> {
    return this.serialized(async () => {
      const runId = expectOpaqueId(runIdInput, "project run id");
      const namespace = parseProjectLinearProgressNamespaceV1(
        await this.persistence.read(),
      );
      const run = namespace.runs[runId];
      return run ? commandsFromRun(run) : [];
    });
  }

  nextPending(
    runIdInput: string,
  ): Promise<LinearProgressPhaseBoundaryCommandV1 | null> {
    return this.pendingCommands(runIdInput).then(
      (commands) => commands[0] ?? null,
    );
  }

  acknowledgeVerified(
    input: AcknowledgeProjectLinearProgressInputV1,
  ): Promise<ProjectLinearProgressRunV1> {
    return this.serialized(async () => {
      const runId = expectOpaqueId(input.runId, "project run id");
      const commandId = expectSha256(input.commandId, "Linear progress command id");
      const verifiedAt = expectIsoTimestamp(
        input.verifiedAt,
        "Linear progress provider verification time",
      );
      const namespace = parseProjectLinearProgressNamespaceV1(
        await this.persistence.read(),
      );
      const previous = requireRun(namespace, runId);
      const itemIndex = previous.outbox.findIndex((item) => item.itemId === commandId);
      if (itemIndex < 0) {
        throw new DurableLinearContractError(
          "Linear progress command is not present in the durable outbox.",
        );
      }
      const item = previous.outbox[itemIndex]!;
      assertCommandFingerprint(item, input.commandFingerprint);
      const acknowledged = acknowledgeLinearProgressOutboxItemV1(item, {
        at: verifiedAt,
        providerReceiptId: input.providerReceiptId,
        providerReceiptFingerprint: input.providerReceiptFingerprint,
      });
      if (acknowledged === item || sameJson(acknowledged, item)) {
        return clone(previous);
      }
      if (verifiedAt < item.updatedAt || verifiedAt < previous.updatedAt) {
        throw new DurableLinearContractError(
          "Linear progress provider verification time cannot move backwards.",
        );
      }
      const outbox = [...previous.outbox];
      outbox[itemIndex] = acknowledged;
      const run = createRunState({
        ...withoutRunFingerprint(previous),
        revision: previous.revision + 1,
        outbox,
        updatedAt: verifiedAt,
      });
      return clone(await this.saveRun(namespace, run));
    });
  }

  recordFailure(
    input: FailProjectLinearProgressInputV1,
  ): Promise<ProjectLinearProgressRunV1> {
    return this.serialized(async () => {
      const runId = expectOpaqueId(input.runId, "project run id");
      const commandId = expectSha256(input.commandId, "Linear progress command id");
      const failedAt = expectIsoTimestamp(
        input.failedAt,
        "Linear progress failure time",
      );
      const namespace = parseProjectLinearProgressNamespaceV1(
        await this.persistence.read(),
      );
      const previous = requireRun(namespace, runId);
      const itemIndex = previous.outbox.findIndex((item) => item.itemId === commandId);
      if (itemIndex < 0) {
        throw new DurableLinearContractError(
          "Linear progress command is not present in the durable outbox.",
        );
      }
      const item = previous.outbox[itemIndex]!;
      assertCommandFingerprint(item, input.commandFingerprint);
      if (item.status !== "pending") {
        throw new DurableLinearContractError(
          "Only a pending Linear progress command may record a dispatch failure.",
        );
      }
      if (failedAt < item.updatedAt || failedAt < previous.updatedAt) {
        throw new DurableLinearContractError(
          "Linear progress failure time cannot move backwards.",
        );
      }
      const outcome = input.outcome;
      if (outcome !== "verified_not_applied" && outcome !== "terminal_blocked") {
        throw new DurableLinearContractError(
          "Linear progress failure outcome must be verified_not_applied or terminal_blocked.",
        );
      }
      const failed = recordLinearProgressOutboxFailureV1(item, {
        at: failedAt,
        error: expectString(input.error, "Linear progress host error", 1, 500),
        retryable: outcome === "verified_not_applied",
      });
      const outbox = [...previous.outbox];
      outbox[itemIndex] = failed;
      const run = createRunState({
        ...withoutRunFingerprint(previous),
        revision: previous.revision + 1,
        outbox,
        updatedAt: failedAt,
      });
      return clone(await this.saveRun(namespace, run));
    });
  }

  private async saveRun(
    namespace: ProjectLinearProgressNamespaceV1,
    run: ProjectLinearProgressRunV1,
  ): Promise<ProjectLinearProgressRunV1> {
    if (
      !namespace.runs[run.runId] &&
      Object.keys(namespace.runs).length >= PROJECT_LINEAR_PROGRESS_RUN_LIMIT
    ) {
      throw new DurableLinearContractError(
        `Linear progress storage is limited to ${PROJECT_LINEAR_PROGRESS_RUN_LIMIT} runs.`,
      );
    }
    const next = createNamespace({
      version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
      revision: namespace.revision + 1,
      runs: { ...namespace.runs, [run.runId]: run },
    });
    const written = await this.persistence.write(clone(next), namespace.revision);
    if (written === false) {
      throw new DurableLinearContractError(
        "Linear progress state changed before its compare-and-swap write.",
      );
    }
    const readback = parseProjectLinearProgressNamespaceV1(
      await this.persistence.read(),
    );
    if (
      !constantTimeFingerprintEqual(
        next.namespaceFingerprint,
        readback.namespaceFingerprint,
      )
    ) {
      throw new DurableLinearContractError(
        "Linear progress persistence did not read back the exact written namespace.",
      );
    }
    const saved = readback.runs[run.runId];
    if (!saved) {
      throw new DurableLinearContractError(
        "Linear progress persistence lost the saved run during readback.",
      );
    }
    return saved;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function parseProjectLinearProgressNamespaceV1(
  value: unknown,
): ProjectLinearProgressNamespaceV1 {
  if (value === null || value === undefined) {
    return createNamespace({
      version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
      revision: 0,
      runs: {},
    });
  }
  const record = expectPlainRecord(value, "project Linear progress namespace");
  assertExactKeys(
    record,
    ["version", "revision", "runs", "namespaceFingerprint"],
    [],
    "project Linear progress namespace",
  );
  if (record.version !== PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported project Linear progress namespace version.",
    );
  }
  const rawRuns = expectPlainRecord(record.runs, "project Linear progress runs");
  const entries = Object.entries(rawRuns);
  if (entries.length > PROJECT_LINEAR_PROGRESS_RUN_LIMIT) {
    throw new DurableLinearContractError(
      "Project Linear progress run limit is exceeded.",
    );
  }
  const runs: Record<string, ProjectLinearProgressRunV1> = {};
  for (const [rawRunId, rawRun] of entries) {
    const runId = expectOpaqueId(rawRunId, "project Linear progress run key");
    const run = parseProjectLinearProgressRunV1(rawRun);
    if (run.runId !== runId) {
      throw new DurableLinearContractError(
        "Project Linear progress run key does not match its durable identity.",
      );
    }
    runs[runId] = run;
  }
  const unsigned: ProjectLinearProgressNamespaceUnsignedV1 = {
    version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
    revision: expectInteger(
      record.revision,
      "project Linear progress namespace revision",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    runs,
  };
  const namespaceFingerprint = expectSha256(
    record.namespaceFingerprint,
    "project Linear progress namespace fingerprint",
  );
  if (
    !constantTimeFingerprintEqual(
      namespaceFingerprint,
      fingerprintContract(unsigned),
    )
  ) {
    throw new DurableLinearContractError(
      "Project Linear progress namespace fingerprint does not match its canonical state.",
    );
  }
  return { ...unsigned, namespaceFingerprint };
}

export function parseProjectLinearProgressRunV1(
  value: unknown,
): ProjectLinearProgressRunV1 {
  const record = expectPlainRecord(value, "project Linear progress run");
  assertExactKeys(
    record,
    [
      "version",
      "runId",
      "revision",
      "bindings",
      "events",
      "cursor",
      "outbox",
      "updatedAt",
      "stateFingerprint",
    ],
    [],
    "project Linear progress run",
  );
  if (record.version !== PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported project Linear progress run version.",
    );
  }
  if (!Array.isArray(record.bindings) || !Array.isArray(record.events) || !Array.isArray(record.outbox)) {
    throw new DurableLinearContractError(
      "Project Linear progress bindings, events, and outbox must be lists.",
    );
  }
  const bindings = normalizeBindings(record.bindings);
  const events = normalizeEvents(record.events);
  assertEventLimit(events);
  if (record.outbox.length > PROJECT_LINEAR_PROGRESS_OUTBOX_LIMIT) {
    throw new DurableLinearContractError(
      "Project Linear progress outbox limit is exceeded.",
    );
  }
  const outbox = record.outbox
    .map(parseLinearProgressOutboxItemV1)
    .sort(compareOutboxItems);
  if (new Set(outbox.map((item) => item.itemId)).size !== outbox.length) {
    throw new DurableLinearContractError(
      "Project Linear progress outbox identities must be unique.",
    );
  }
  const cursor = parseLinearProjectProgressCursorV1(record.cursor);
  const unsigned: ProjectLinearProgressRunUnsignedV1 = {
    version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
    runId: expectOpaqueId(record.runId, "project run id"),
    revision: expectInteger(
      record.revision,
      "project Linear progress run revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    bindings,
    events,
    cursor,
    outbox,
    updatedAt: expectIsoTimestamp(
      record.updatedAt,
      "project Linear progress update time",
    ),
  };
  assertCanonicalContract(
    withoutRecordKey(record, "stateFingerprint"),
    unsigned,
    "Project Linear progress run",
  );
  const stateFingerprint = expectSha256(
    record.stateFingerprint,
    "project Linear progress state fingerprint",
  );
  if (
    !constantTimeFingerprintEqual(
      stateFingerprint,
      fingerprintContract(unsigned),
    )
  ) {
    throw new DurableLinearContractError(
      "Project Linear progress state fingerprint does not match its canonical state.",
    );
  }
  assertRunSemantics(unsigned);
  return { ...unsigned, stateFingerprint };
}

export function parseLinearProgressPhaseBoundaryCommandV1(
  value: unknown,
): LinearProgressPhaseBoundaryCommandV1 {
  const record = expectPlainRecord(value, "Linear progress phase-boundary command");
  assertExactKeys(
    record,
    [
      "version",
      "commandId",
      "runId",
      "workUnitId",
      "linearIssueId",
      "target",
      "comment",
      "sourceEventIds",
      "idempotencyKey",
      "requiredReadbacks",
      "commandFingerprint",
    ],
    [],
    "Linear progress phase-boundary command",
  );
  if (record.version !== PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported Linear progress phase-boundary command version.",
    );
  }
  if (
    !Array.isArray(record.sourceEventIds) ||
    !Array.isArray(record.requiredReadbacks) ||
    record.requiredReadbacks.length !== 2 ||
    record.requiredReadbacks[0] !== "comment" ||
    record.requiredReadbacks[1] !== "issue_state"
  ) {
    throw new DurableLinearContractError(
      "Linear progress command requires exact comment and issue-state readbacks.",
    );
  }
  const sourceEventIds = record.sourceEventIds.map((entry, index) =>
    expectSha256(entry, `Linear progress command source event ${index + 1}`),
  );
  if (sourceEventIds.length < 1 || sourceEventIds.length > 100 || new Set(sourceEventIds).size !== sourceEventIds.length) {
    throw new DurableLinearContractError(
      "Linear progress command source events must be a unique bounded list.",
    );
  }
  const target = record.target;
  if (
    target !== "ready" &&
    target !== "in_progress" &&
    target !== "blocked" &&
    target !== "ready_for_review" &&
    target !== "in_review" &&
    target !== "completed"
  ) {
    throw new DurableLinearContractError("Linear progress command target is invalid.");
  }
  const comment = expectString(record.comment, "Linear progress comment", 1, 4_000, {
    allowNewlines: true,
  });
  try {
    assertCleanLinearHumanOutputV1(comment, "Linear progress comment");
  } catch (error) {
    throw new DurableLinearContractError(
      error instanceof Error ? error.message : "Linear progress comment is invalid.",
    );
  }
  const unsigned: LinearProgressPhaseBoundaryCommandUnsignedV1 = {
    version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
    commandId: expectSha256(record.commandId, "Linear progress command id"),
    runId: expectOpaqueId(record.runId, "project run id"),
    workUnitId: expectOpaqueId(record.workUnitId, "project work-unit id"),
    linearIssueId: expectOpaqueId(record.linearIssueId, "Linear issue id"),
    target,
    comment,
    sourceEventIds: [...sourceEventIds].sort(),
    idempotencyKey: expectSha256(
      record.idempotencyKey,
      "Linear progress command idempotency key",
    ),
    requiredReadbacks: ["comment", "issue_state"],
  };
  assertCanonicalContract(
    withoutRecordKey(record, "commandFingerprint"),
    unsigned,
    "Linear progress phase-boundary command",
  );
  if (
    !constantTimeFingerprintEqual(unsigned.commandId, unsigned.idempotencyKey)
  ) {
    throw new DurableLinearContractError(
      "Linear progress command idempotency key must equal its durable outbox identity.",
    );
  }
  const commandFingerprint = expectSha256(
    record.commandFingerprint,
    "Linear progress command fingerprint",
  );
  if (
    !constantTimeFingerprintEqual(
      commandFingerprint,
      fingerprintContract(unsigned),
    )
  ) {
    throw new DurableLinearContractError(
      "Linear progress command fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, commandFingerprint };
}

function projectEventTimeline(
  runId: string,
  events: readonly ProjectStageEventV1[],
  bindings: readonly ProjectWorkUnitLinearBindingV1[],
  previousOutbox: readonly LinearProgressOutboxItemV1[],
): { cursor: LinearProjectProgressCursorV1; outbox: LinearProgressOutboxItemV1[] } {
  let cursor: LinearProjectProgressCursorV1 | null = null;
  let outbox: LinearProgressOutboxItemV1[] = [];
  const prefix: ProjectStageEventV1[] = [];
  for (const event of events) {
    prefix.push(event);
    const projection = projectLinearProgressV1({
      runId,
      events: prefix,
      bindings,
      previousCursor: cursor,
      previousOutbox: outbox,
      projectedAt: event.occurredAt,
    });
    cursor = projection.cursor;
    outbox = projection.outbox;
  }
  if (!cursor) {
    throw new DurableLinearContractError(
      "Linear progress timeline requires at least one durable event.",
    );
  }
  const generatedById = new Map(outbox.map((item) => [item.itemId, item]));
  const previousIds = new Set(previousOutbox.map((item) => item.itemId));
  for (const previous of previousOutbox) {
    const generated = generatedById.get(previous.itemId);
    if (generated) {
      assertSameOutboxIdentity(previous, generated);
      generatedById.set(previous.itemId, previous);
    } else {
      // Provider-visible history is append-only even if a late event changes
      // the locally derived path through phase boundaries.
      generatedById.set(previous.itemId, previous);
    }
  }
  const merged = [...generatedById.values()].sort(compareOutboxItems);
  const latestAppliedByWorkUnit = new Map<string, LinearProgressOutboxItemV1>();
  for (const item of merged) {
    if (item.status === "applied") {
      latestAppliedByWorkUnit.set(item.workUnitId, item);
    }
  }
  const active = merged.filter((item) => {
    if (previousIds.has(item.itemId)) return true;
    const latestApplied = latestAppliedByWorkUnit.get(item.workUnitId);
    return !latestApplied || compareOutboxItems(item, latestApplied) > 0;
  });
  if (active.length > PROJECT_LINEAR_PROGRESS_OUTBOX_LIMIT) {
    throw new DurableLinearContractError(
      "Project Linear progress outbox limit is exceeded.",
    );
  }
  return { cursor, outbox: active };
}

function assertRunSemantics(run: ProjectLinearProgressRunUnsignedV1): void {
  assertRunIdentity(run.runId, run.bindings, run.events);
  if (run.events.some((event) => event.occurredAt > run.updatedAt)) {
    throw new DurableLinearContractError(
      "Project Linear progress run contains an event newer than its durable update time.",
    );
  }
  if (
    run.events.some((event) => event.occurredAt > run.cursor.updatedAt) ||
    run.cursor.updatedAt > run.updatedAt
  ) {
    throw new DurableLinearContractError(
      "Project Linear progress cursor time must cover its exact event frontier and precede durable persistence.",
    );
  }
  const eventIds = run.events.map((event) => event.eventId).sort();
  if (!sameJson(eventIds, run.cursor.processedEventIds)) {
    throw new DurableLinearContractError(
      "Project Linear progress cursor does not account for the exact durable event set.",
    );
  }
  const current = projectLinearProgressV1({
    runId: run.runId,
    events: run.events,
    bindings: run.bindings,
    projectedAt: run.cursor.updatedAt,
  }).cursor;
  if (!sameJson(current.workUnits, run.cursor.workUnits)) {
    throw new DurableLinearContractError(
      "Project Linear progress cursor does not match its verified event evidence.",
    );
  }
  const bindingByWorkUnit = new Map(
    run.bindings.map((binding) => [binding.workUnitId, binding] as const),
  );
  const eventsById = new Map(run.events.map((event) => [event.eventId, event] as const));
  const expectedOutbox = new Map(
    projectEventTimeline(run.runId, run.events, run.bindings, []).outbox.map(
      (item) => [item.itemId, item] as const,
    ),
  );
  for (const item of run.outbox) {
    const binding = bindingByWorkUnit.get(item.workUnitId);
    if (!binding || binding.linearIssueId !== item.linearIssueId) {
      throw new DurableLinearContractError(
        "Project Linear progress outbox is not bound to its exact child issue.",
      );
    }
    const sources = item.sourceEventIds.map((eventId) => {
      const event = eventsById.get(eventId);
      if (!event) {
        throw new DurableLinearContractError(
          "Project Linear progress outbox references missing durable evidence.",
        );
      }
      return event;
    });
    const expected = expectedOutbox.get(item.itemId);
    if (!expected) {
      throw new DurableLinearContractError(
        "Project Linear progress outbox contains a command that is not a verified phase boundary.",
      );
    }
    assertSameOutboxIdentity(item, expected);
    if (
      item.updatedAt > run.updatedAt ||
      sources.some((event) => event.occurredAt > item.createdAt)
    ) {
      throw new DurableLinearContractError(
        "Project Linear progress outbox time does not cover its exact source evidence.",
      );
    }
    if (item.target === "completed") {
      assertChildCompletionProof(binding, sources);
    }
  }
}

function assertChildCompletionProof(
  binding: ProjectWorkUnitLinearBindingV1,
  sources: readonly ProjectStageEventV1[],
): void {
  const boundVerified = sources.filter(
    (event) =>
      event.disposition === "verified" &&
      event.workUnits.some((unit) => unit.workUnitId === binding.workUnitId),
  );
  const hasPullRequest = boundVerified.some(
    (event) => event.evidenceKind === "github_draft_pr_readback",
  );
  const hasReflection = boundVerified.some(
    (event) => event.evidenceKind === "reflection_writeback",
  );
  const paidCriteria = new Set(
    boundVerified
      .filter((event) => event.evidenceKind === "acceptance_criterion")
      .flatMap((event) =>
        event.workUnits
          .filter((unit) => unit.workUnitId === binding.workUnitId)
          .flatMap((unit) => unit.acceptanceCriterionIds),
      ),
  );
  if (
    !hasPullRequest ||
    !hasReflection ||
    binding.acceptanceCriterionIds.some((criterionId) => !paidCriteria.has(criterionId))
  ) {
    throw new DurableLinearContractError(
      "A Linear child cannot complete without its own acceptance criteria, verified pull request, and reflection evidence.",
    );
  }
}

function commandsFromRun(
  run: ProjectLinearProgressRunV1,
): LinearProgressPhaseBoundaryCommandV1[] {
  const ordered = [...run.outbox].sort(compareOutboxItems);
  const byWorkUnit = new Map<string, LinearProgressOutboxItemV1[]>();
  for (const item of ordered) {
    const items = byWorkUnit.get(item.workUnitId) ?? [];
    items.push(item);
    byWorkUnit.set(item.workUnitId, items);
  }
  const eligible = new Set<string>();
  for (const items of byWorkUnit.values()) {
    let latestAppliedIndex = -1;
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]!.status === "applied") latestAppliedIndex = index;
    }
    for (let index = latestAppliedIndex + 1; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.status === "blocked") break;
      if (item.status === "pending") eligible.add(item.itemId);
    }
  }
  return ordered
    .filter((item) => eligible.has(item.itemId))
    .map((item) => createCommand(item));
}

function createCommand(
  item: LinearProgressOutboxItemV1,
): LinearProgressPhaseBoundaryCommandV1 {
  const parsed = parseLinearProgressOutboxItemV1(item);
  const unsigned: LinearProgressPhaseBoundaryCommandUnsignedV1 = {
    version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
    commandId: parsed.itemId,
    runId: parsed.runId,
    workUnitId: parsed.workUnitId,
    linearIssueId: parsed.linearIssueId,
    target: parsed.target,
    comment: formatLinearProgressCommentV1(parsed),
    sourceEventIds: [...parsed.sourceEventIds],
    idempotencyKey: parsed.idempotencyKey,
    requiredReadbacks: ["comment", "issue_state"],
  };
  return parseLinearProgressPhaseBoundaryCommandV1({
    ...unsigned,
    commandFingerprint: fingerprintContract(unsigned),
  });
}

function assertCommandFingerprint(
  item: LinearProgressOutboxItemV1,
  fingerprintInput: string,
): void {
  const fingerprint = expectSha256(
    fingerprintInput,
    "Linear progress command fingerprint",
  );
  const expected = createCommand(item).commandFingerprint;
  if (!constantTimeFingerprintEqual(fingerprint, expected)) {
    throw new DurableLinearContractError(
      "Linear progress acknowledgement does not match the exact pending command.",
    );
  }
}

function createRunState(
  unsignedInput: ProjectLinearProgressRunUnsignedV1,
): ProjectLinearProgressRunV1 {
  const unsigned: ProjectLinearProgressRunUnsignedV1 = {
    ...unsignedInput,
    bindings: normalizeBindings(unsignedInput.bindings),
    events: normalizeEvents(unsignedInput.events),
    cursor: parseLinearProjectProgressCursorV1(unsignedInput.cursor),
    outbox: unsignedInput.outbox
      .map(parseLinearProgressOutboxItemV1)
      .sort(compareOutboxItems),
  };
  return parseProjectLinearProgressRunV1({
    ...unsigned,
    stateFingerprint: fingerprintContract(unsigned),
  });
}

function createNamespace(
  unsignedInput: ProjectLinearProgressNamespaceUnsignedV1,
): ProjectLinearProgressNamespaceV1 {
  const unsigned: ProjectLinearProgressNamespaceUnsignedV1 = {
    version: PROJECT_LINEAR_PROGRESS_RUNTIME_VERSION,
    revision: unsignedInput.revision,
    runs: unsignedInput.runs,
  };
  return {
    ...unsigned,
    namespaceFingerprint: fingerprintContract(unsigned),
  };
}

function normalizeBindings(
  values: readonly unknown[],
): ProjectWorkUnitLinearBindingV1[] {
  const bindings = values
    .map(parseProjectWorkUnitLinearBindingV1)
    .sort((left, right) => left.workUnitId.localeCompare(right.workUnitId));
  if (new Set(bindings.map((binding) => binding.workUnitId)).size !== bindings.length) {
    throw new DurableLinearContractError(
      "Project Linear progress work-unit bindings must be unique.",
    );
  }
  if (new Set(bindings.map((binding) => binding.bindingId)).size !== bindings.length) {
    throw new DurableLinearContractError(
      "Project Linear progress binding identities must be unique.",
    );
  }
  if (new Set(bindings.map((binding) => binding.linearIssueId)).size !== bindings.length) {
    throw new DurableLinearContractError(
      "Project Linear progress child issue bindings must be one-to-one.",
    );
  }
  return bindings;
}

function normalizeEvents(values: readonly unknown[]): ProjectStageEventV1[] {
  const byId = new Map<string, ProjectStageEventV1>();
  for (const value of values) {
    const event = parseProjectStageEventV1(value);
    byId.set(event.eventId, event);
  }
  return [...byId.values()].sort(compareEvents);
}

function mergeEvents(
  previous: readonly ProjectStageEventV1[],
  supplied: readonly ProjectStageEventV1[],
): ProjectStageEventV1[] {
  return normalizeEvents([...previous, ...supplied]);
}

function assertRunIdentity(
  runId: string,
  bindings: readonly ProjectWorkUnitLinearBindingV1[],
  events: readonly ProjectStageEventV1[],
): void {
  if (
    bindings.some((binding) => binding.runId !== runId) ||
    events.some((event) => event.runId !== runId)
  ) {
    throw new DurableLinearContractError(
      "Project Linear progress evidence and bindings must belong to one exact run.",
    );
  }
  // The pure projector owns the detailed work-unit and acceptance-binding gate.
  projectLinearProgressV1({
    runId,
    events,
    bindings,
    projectedAt: events.at(-1)?.occurredAt ?? new Date(0).toISOString(),
  });
}

function assertBindingsUnchanged(
  previous: readonly ProjectWorkUnitLinearBindingV1[],
  supplied: readonly ProjectWorkUnitLinearBindingV1[],
): void {
  if (!sameJson(previous, supplied)) {
    throw new DurableLinearContractError(
      "Project Linear progress work-unit bindings are immutable after first persistence.",
    );
  }
}

function assertEventLimit(events: readonly ProjectStageEventV1[]): void {
  if (events.length > PROJECT_LINEAR_PROGRESS_EVENT_LIMIT) {
    throw new DurableLinearContractError(
      `Project Linear progress is limited to ${PROJECT_LINEAR_PROGRESS_EVENT_LIMIT} events per run.`,
    );
  }
}

function assertSameOutboxIdentity(
  previous: LinearProgressOutboxItemV1,
  generated: LinearProgressOutboxItemV1,
): void {
  const identity = (item: LinearProgressOutboxItemV1) => ({
    schemaVersion: item.schemaVersion,
    itemId: item.itemId,
    runId: item.runId,
    workUnitId: item.workUnitId,
    linearIssueId: item.linearIssueId,
    target: item.target,
    commentCode: item.commentCode,
    sourceEventIds: item.sourceEventIds,
    idempotencyKey: item.idempotencyKey,
  });
  if (!sameJson(identity(previous), identity(generated))) {
    throw new DurableLinearContractError(
      "Linear progress outbox identity changed during deterministic replay.",
    );
  }
}

function requireRun(
  namespace: ProjectLinearProgressNamespaceV1,
  runId: string,
): ProjectLinearProgressRunV1 {
  const run = namespace.runs[runId];
  if (!run) {
    throw new DurableLinearContractError(
      "Project Linear progress run does not exist.",
    );
  }
  return run;
}

function withoutRunFingerprint(
  run: ProjectLinearProgressRunV1,
): ProjectLinearProgressRunUnsignedV1 {
  const { stateFingerprint: _fingerprint, ...unsigned } = run;
  return unsigned;
}

function withoutRecordKey(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));
}

function compareEvents(left: ProjectStageEventV1, right: ProjectStageEventV1): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId);
}

function compareOutboxItems(
  left: LinearProgressOutboxItemV1,
  right: LinearProgressOutboxItemV1,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.itemId.localeCompare(right.itemId);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone<T>(value: T): T {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value)) as T;
}
