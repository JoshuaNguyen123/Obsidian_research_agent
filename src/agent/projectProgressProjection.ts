import {
  assertCanonicalContract,
  assertExactKeys,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
  parseHttpUrl,
  parseUniqueStrings,
} from "../integrations/linear/LinearContractSupport";
import {
  parseProjectStageEventV1,
  type ProjectEvidenceKindV1,
  type ProjectStageEventV1,
  type ProjectWorkUnitOutcomeV1,
} from "./projectRunReport";

export const PROJECT_WORK_UNIT_LINEAR_BINDING_SCHEMA_VERSION = 1 as const;
export const LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION = 1 as const;

export const LINEAR_PROJECT_PROGRESS_TARGETS_V1 = [
  "ready",
  "in_progress",
  "blocked",
  "ready_for_review",
  "in_review",
  "completed",
] as const;

export type LinearProjectProgressTargetV1 =
  (typeof LINEAR_PROJECT_PROGRESS_TARGETS_V1)[number];

export type LinearProgressCommentCodeV1 =
  | "linear_plan_verified"
  | "implementation_started"
  | "actionable_blocker_observed"
  | "validation_and_commit_verified"
  | "draft_pull_request_verified"
  | "reflection_and_acceptance_verified";

export interface ProjectWorkUnitLinearBindingV1 {
  schemaVersion: typeof PROJECT_WORK_UNIT_LINEAR_BINDING_SCHEMA_VERSION;
  bindingId: string;
  runId: string;
  workUnitId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearIssueUrl: string;
  acceptanceCriterionIds: string[];
  providerReadbackFingerprint: string;
  verifiedAt: string;
  bindingFingerprint: string;
}

export type ProjectWorkUnitLinearBindingV1Unsigned = Omit<
  ProjectWorkUnitLinearBindingV1,
  "bindingFingerprint"
>;

export interface LinearProjectProgressWorkUnitStateV1 {
  workUnitId: string;
  linearIssueId: string;
  target: LinearProjectProgressTargetV1 | null;
  commentCode: LinearProgressCommentCodeV1 | null;
  sourceEventIds: string[];
  paidAcceptanceCriterionIds: string[];
  unpaidAcceptanceCriterionIds: string[];
}

export interface LinearProjectProgressCursorV1 {
  schemaVersion: typeof LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION;
  runId: string;
  revision: number;
  processedEventIds: string[];
  workUnits: LinearProjectProgressWorkUnitStateV1[];
  updatedAt: string;
}

export type LinearProgressOutboxStatusV1 = "pending" | "applied" | "blocked";

export interface LinearProgressOutboxItemV1 {
  schemaVersion: typeof LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION;
  itemId: string;
  runId: string;
  workUnitId: string;
  linearIssueId: string;
  target: LinearProjectProgressTargetV1;
  commentCode: LinearProgressCommentCodeV1;
  sourceEventIds: string[];
  idempotencyKey: string;
  status: LinearProgressOutboxStatusV1;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  appliedReceiptId: string | null;
  appliedReceiptFingerprint: string | null;
  lastError: string | null;
}

export interface LinearProjectProgressProjectionV1 {
  cursor: LinearProjectProgressCursorV1;
  outbox: LinearProgressOutboxItemV1[];
}

export function createProjectWorkUnitLinearBindingV1(
  value: ProjectWorkUnitLinearBindingV1Unsigned,
): ProjectWorkUnitLinearBindingV1 {
  const unsigned = parseProjectWorkUnitLinearBindingUnsignedV1(value);
  return { ...unsigned, bindingFingerprint: fingerprintContract(unsigned) };
}

export function parseProjectWorkUnitLinearBindingV1(
  value: unknown,
): ProjectWorkUnitLinearBindingV1 {
  const record = expectPlainRecord(value, "project work-unit Linear binding");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "bindingId",
      "runId",
      "workUnitId",
      "linearIssueId",
      "linearIssueIdentifier",
      "linearIssueUrl",
      "acceptanceCriterionIds",
      "providerReadbackFingerprint",
      "verifiedAt",
      "bindingFingerprint",
    ],
    [],
    "project work-unit Linear binding",
  );
  const { bindingFingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseProjectWorkUnitLinearBindingUnsignedV1(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "Project work-unit Linear binding");
  const bindingFingerprint = expectSha256(
    rawFingerprint,
    "project work-unit Linear binding fingerprint",
  );
  if (
    !constantTimeFingerprintEqual(
      bindingFingerprint,
      fingerprintContract(unsigned),
    )
  ) {
    throw new DurableLinearContractError(
      "Project work-unit Linear binding fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, bindingFingerprint };
}

/**
 * Deterministically projects verified project evidence into durable Linear
 * status intents. The caller persists cursor + outbox atomically, then a
 * host-owned adapter dispatches pending entries and records provider receipts.
 */
export function projectLinearProgressV1(input: {
  runId: string;
  events: readonly ProjectStageEventV1[];
  bindings: readonly ProjectWorkUnitLinearBindingV1[];
  previousCursor?: LinearProjectProgressCursorV1 | null;
  previousOutbox?: readonly LinearProgressOutboxItemV1[];
  projectedAt: string;
}): LinearProjectProgressProjectionV1 {
  const runId = expectOpaqueId(input.runId, "project run id");
  const projectedAt = expectIsoTimestamp(input.projectedAt, "Linear projection time");
  const events = dedupeEvents(input.events.map(parseProjectStageEventV1));
  if (events.some((event) => event.runId !== runId)) {
    throw new DurableLinearContractError(
      "Linear progress projection received evidence from a different run.",
    );
  }
  const bindings = input.bindings
    .map(parseProjectWorkUnitLinearBindingV1)
    .sort((left, right) => left.workUnitId.localeCompare(right.workUnitId));
  if (bindings.some((binding) => binding.runId !== runId)) {
    throw new DurableLinearContractError(
      "Linear progress projection received a binding from a different run.",
    );
  }
  if (new Set(bindings.map((binding) => binding.workUnitId)).size !== bindings.length) {
    throw new DurableLinearContractError(
      "Each project work unit must have exactly one Linear binding.",
    );
  }
  if (new Set(bindings.map((binding) => binding.bindingId)).size !== bindings.length) {
    throw new DurableLinearContractError(
      "Each project work unit must have a unique Linear binding identity.",
    );
  }
  if (new Set(bindings.map((binding) => binding.linearIssueId)).size !== bindings.length) {
    throw new DurableLinearContractError(
      "A Linear child issue cannot be bound to more than one project work unit.",
    );
  }
  assertEventsUseExactBindings(events, bindings);

  const previousCursor = input.previousCursor
    ? parseLinearProjectProgressCursorV1(input.previousCursor)
    : null;
  if (previousCursor && previousCursor.runId !== runId) {
    throw new DurableLinearContractError(
      "Linear progress cursor belongs to a different run.",
    );
  }
  if (previousCursor) {
    if (projectedAt < previousCursor.updatedAt) {
      throw new DurableLinearContractError(
        "Linear progress projection time cannot move backwards.",
      );
    }
    const eventIds = new Set(events.map((event) => event.eventId));
    if (previousCursor.processedEventIds.some((eventId) => !eventIds.has(eventId))) {
      throw new DurableLinearContractError(
        "Linear progress projection cannot remove a previously processed project event.",
      );
    }
    const expectedUnits = bindings.map((binding) => ({
      workUnitId: binding.workUnitId,
      linearIssueId: binding.linearIssueId,
    }));
    const previousUnits = previousCursor.workUnits.map((unit) => ({
      workUnitId: unit.workUnitId,
      linearIssueId: unit.linearIssueId,
    }));
    if (JSON.stringify(expectedUnits) !== JSON.stringify(previousUnits)) {
      throw new DurableLinearContractError(
        "Linear progress bindings cannot change after projection has started.",
      );
    }
  }
  const previousWorkUnits = new Map(
    (previousCursor?.workUnits ?? []).map((item) => [item.workUnitId, item]),
  );
  const previousOutbox = (input.previousOutbox ?? []).map(
    parseLinearProgressOutboxItemV1,
  );
  if (previousOutbox.some((item) => item.runId !== runId)) {
    throw new DurableLinearContractError(
      "Linear progress outbox contains an item from a different run.",
    );
  }
  const outboxById = new Map(previousOutbox.map((item) => [item.itemId, item]));

  const workUnits = bindings.map((binding) => {
    const state = deriveWorkUnitState(binding, events);
    const previous = previousWorkUnits.get(binding.workUnitId);
    if (
      state.target !== null &&
      state.commentCode !== null &&
      (!previous ||
        previous.target !== state.target ||
        previous.commentCode !== state.commentCode)
    ) {
      const unsignedIdentity = {
        schemaVersion: LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION,
        runId,
        workUnitId: binding.workUnitId,
        linearIssueId: binding.linearIssueId,
        target: state.target,
        commentCode: state.commentCode,
        sourceEventIds: state.sourceEventIds,
      };
      const itemId = fingerprintContract(unsignedIdentity);
      if (!outboxById.has(itemId)) {
        outboxById.set(itemId, {
          ...unsignedIdentity,
          itemId,
          idempotencyKey: itemId,
          status: "pending",
          attemptCount: 0,
          createdAt: projectedAt,
          updatedAt: projectedAt,
          appliedReceiptId: null,
          appliedReceiptFingerprint: null,
          lastError: null,
        });
      }
    }
    return state;
  });

  const processedEventIds = events.map((event) => event.eventId).sort();
  const unchanged = previousCursor
    ? sameStrings(previousCursor.processedEventIds, processedEventIds) &&
      sameWorkUnitStates(previousCursor.workUnits, workUnits)
    : false;
  const cursor: LinearProjectProgressCursorV1 = unchanged
    ? previousCursor!
    : {
        schemaVersion: LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION,
        runId,
        revision: (previousCursor?.revision ?? 0) + 1,
        processedEventIds,
        workUnits,
        updatedAt: projectedAt,
      };
  return {
    cursor: parseLinearProjectProgressCursorV1(cursor),
    outbox: [...outboxById.values()]
      .map(parseLinearProgressOutboxItemV1)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.itemId.localeCompare(right.itemId),
      ),
  };
}

/**
 * Build the per-child Results outcomes from the same immutable Linear bindings
 * and exact child evidence used by the progress cursor. Aggregate project
 * events (`workUnits: []`) remain useful phase evidence, but can never pay a
 * child outcome here.
 *
 * A paid outcome deliberately requires the cursor's complete gate: every
 * bound acceptance criterion plus exact repository, draft-PR, and reflection
 * evidence for this work unit. This keeps Results fail-closed when a project-
 * level publication or reflection exists without truthful child attribution.
 */
export function projectWorkUnitOutcomesV1(input: {
  runId: string;
  events: readonly ProjectStageEventV1[];
  bindings: readonly ProjectWorkUnitLinearBindingV1[];
  projectedAt: string;
}): ProjectWorkUnitOutcomeV1[] {
  const events = dedupeEvents(input.events.map(parseProjectStageEventV1));
  const bindings = input.bindings.map(parseProjectWorkUnitLinearBindingV1);
  if (bindings.length === 0) return [];

  const projection = projectLinearProgressV1({
    runId: input.runId,
    events,
    bindings,
    projectedAt: input.projectedAt,
  });
  const bindingByWorkUnit = new Map(
    bindings.map((binding) => [binding.workUnitId, binding] as const),
  );

  return projection.cursor.workUnits.map((state) => {
    const binding = bindingByWorkUnit.get(state.workUnitId);
    if (!binding) {
      throw new DurableLinearContractError(
        "Projected work-unit outcome is missing its immutable Linear binding.",
      );
    }
    const exactEvents = events.filter((event) =>
      event.workUnits.some((unit) => unit.workUnitId === state.workUnitId),
    );
    const verifiedKinds = new Set(
      exactEvents
        .filter((event) => event.disposition === "verified")
        .map((event) => event.evidenceKind),
    );
    const status: ProjectWorkUnitOutcomeV1["status"] =
      state.target === "completed"
        ? "paid"
        : state.target === "blocked"
          ? "blocked"
          : "unpaid";
    const acceptanceEvents = exactEvents.filter(
      (event) =>
        event.disposition === "verified" &&
        event.evidenceKind === "acceptance_criterion",
    );
    const latestExactVerified = (kind: ProjectEvidenceKindV1) =>
      lastEvent(
        exactEvents.filter(
          (event) =>
            event.disposition === "verified" && event.evidenceKind === kind,
        ),
      );
    const outcomeEvidence = [
      ...acceptanceEvents,
      latestExactVerified("github_repository_readback"),
      latestExactVerified("github_draft_pr_readback"),
      latestExactVerified("reflection_writeback"),
      status === "blocked"
        ? lastEvent(
            exactEvents.filter(
              (event) =>
                event.disposition === "blocked" &&
                event.evidenceKind === "actionable_blocker",
            ),
          )
        : null,
    ].filter((event): event is ProjectStageEventV1 => event !== null);
    const proofDebt: string[] = [];
    if (status === "blocked") {
      proofDebt.push(
        "Exact work-unit blocker evidence remains newer than any verified recovery evidence.",
      );
    }
    if (!verifiedKinds.has("github_repository_readback")) {
      proofDebt.push(
        "Verified repository publication evidence is not bound to this work unit.",
      );
    }
    if (!verifiedKinds.has("github_draft_pr_readback")) {
      proofDebt.push(
        "Verified draft pull request evidence is not bound to this work unit.",
      );
    }
    if (!verifiedKinds.has("reflection_writeback")) {
      proofDebt.push(
        "Verified Results reflection evidence is not bound to this work unit.",
      );
    }

    return {
      workUnitId: state.workUnitId,
      linearIssueIdentifier: binding.linearIssueIdentifier,
      status,
      paidAcceptanceCriterionIds: state.paidAcceptanceCriterionIds,
      unpaidAcceptanceCriterionIds: state.unpaidAcceptanceCriterionIds,
      evidenceEventIds: [
        ...new Set(outcomeEvidence.map((event) => event.eventId)),
      ].sort(),
      proofDebt: status === "paid" ? [] : [...new Set(proofDebt)].sort(),
    };
  });
}

export function parseLinearProjectProgressCursorV1(
  value: unknown,
): LinearProjectProgressCursorV1 {
  const record = expectPlainRecord(value, "Linear project progress cursor");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "revision",
      "processedEventIds",
      "workUnits",
      "updatedAt",
    ],
    [],
    "Linear project progress cursor",
  );
  if (record.schemaVersion !== LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported Linear project progress cursor version.",
    );
  }
  if (!Array.isArray(record.workUnits)) {
    throw new DurableLinearContractError(
      "Linear project progress cursor work units must be a list.",
    );
  }
  const workUnits = record.workUnits.map(parseWorkUnitState);
  const workUnitIds = workUnits.map((item) => item.workUnitId);
  if (new Set(workUnitIds).size !== workUnitIds.length) {
    throw new DurableLinearContractError(
      "Linear project progress cursor work units must be unique.",
    );
  }
  workUnits.sort((left, right) => left.workUnitId.localeCompare(right.workUnitId));
  return {
    schemaVersion: LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION,
    runId: expectOpaqueId(record.runId, "project run id"),
    revision: expectInteger(record.revision, "Linear progress revision", 1, 1_000_000_000),
    processedEventIds: parseUniqueStrings(
      record.processedEventIds,
      "processed project event id",
      0,
      100_000,
      80,
      (entry, label) => expectSha256(entry, label),
    ).sort(),
    workUnits,
    updatedAt: expectIsoTimestamp(record.updatedAt, "Linear progress cursor update time"),
  };
}

export function parseLinearProgressOutboxItemV1(
  value: unknown,
): LinearProgressOutboxItemV1 {
  const record = expectPlainRecord(value, "Linear progress outbox item");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "itemId",
      "runId",
      "workUnitId",
      "linearIssueId",
      "target",
      "commentCode",
      "sourceEventIds",
      "idempotencyKey",
      "status",
      "attemptCount",
      "createdAt",
      "updatedAt",
      "appliedReceiptId",
      "appliedReceiptFingerprint",
      "lastError",
    ],
    [],
    "Linear progress outbox item",
  );
  if (record.schemaVersion !== LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported Linear progress outbox version.",
    );
  }
  const itemId = expectSha256(record.itemId, "Linear progress outbox item id");
  const idempotencyKey = expectSha256(
    record.idempotencyKey,
    "Linear progress idempotency key",
  );
  if (!constantTimeFingerprintEqual(itemId, idempotencyKey)) {
    throw new DurableLinearContractError(
      "Linear progress idempotency key must equal its immutable outbox item id.",
    );
  }
  const status = expectEnum(
    record.status,
    "Linear progress outbox status",
    ["pending", "applied", "blocked"] as const,
  );
  const appliedReceiptId = parseNullableOpaqueId(
    record.appliedReceiptId,
    "Linear progress applied receipt id",
  );
  const appliedReceiptFingerprint = record.appliedReceiptFingerprint === null
    ? null
    : expectSha256(
        record.appliedReceiptFingerprint,
        "Linear progress applied receipt fingerprint",
      );
  const lastError = parseNullableError(record.lastError);
  if (status === "applied" && !appliedReceiptId) {
    throw new DurableLinearContractError(
      "Applied Linear progress outbox entries require a provider receipt id.",
    );
  }
  if (status === "applied" && !appliedReceiptFingerprint) {
    throw new DurableLinearContractError(
      "Applied Linear progress outbox entries require a provider receipt fingerprint.",
    );
  }
  if (status === "applied" && lastError) {
    throw new DurableLinearContractError(
      "Applied Linear progress outbox entries cannot retain a host error.",
    );
  }
  if (status !== "applied" && appliedReceiptId) {
    throw new DurableLinearContractError(
      "Only applied Linear progress outbox entries may record a provider receipt id.",
    );
  }
  if (status !== "applied" && appliedReceiptFingerprint) {
    throw new DurableLinearContractError(
      "Only applied Linear progress outbox entries may record a provider receipt fingerprint.",
    );
  }
  if (status === "blocked" && !lastError) {
    throw new DurableLinearContractError(
      "Blocked Linear progress outbox entries require a host error.",
    );
  }
  const sourceEventIds = parseUniqueStrings(
    record.sourceEventIds,
    "Linear progress source event id",
    1,
    100,
    80,
    (entry, label) => expectSha256(entry, label),
  ).sort();
  const target = expectEnum(
    record.target,
    "Linear progress target",
    LINEAR_PROJECT_PROGRESS_TARGETS_V1,
  );
  const commentCode = parseCommentCode(record.commentCode);
  const identity = {
    schemaVersion: LINEAR_PROJECT_PROGRESS_SCHEMA_VERSION,
    runId: expectOpaqueId(record.runId, "project run id"),
    workUnitId: expectOpaqueId(record.workUnitId, "project work-unit id"),
    linearIssueId: expectOpaqueId(record.linearIssueId, "Linear issue id"),
    target,
    commentCode,
    sourceEventIds,
  };
  if (!constantTimeFingerprintEqual(itemId, fingerprintContract(identity))) {
    throw new DurableLinearContractError(
      "Linear progress outbox item id does not match its immutable projection payload.",
    );
  }
  const createdAt = expectIsoTimestamp(record.createdAt, "Linear progress outbox creation time");
  const updatedAt = expectIsoTimestamp(record.updatedAt, "Linear progress outbox update time");
  if (updatedAt < createdAt) {
    throw new DurableLinearContractError(
      "Linear progress outbox update cannot predate creation.",
    );
  }
  return {
    ...identity,
    itemId,
    idempotencyKey,
    status,
    attemptCount: expectInteger(record.attemptCount, "Linear progress attempt count", 0, 1_000_000),
    createdAt,
    updatedAt,
    appliedReceiptId,
    appliedReceiptFingerprint,
    lastError,
  };
}

export function recordLinearProgressOutboxFailureV1(
  rawItem: LinearProgressOutboxItemV1,
  input: { at: string; error: string; retryable: boolean },
): LinearProgressOutboxItemV1 {
  const item = parseLinearProgressOutboxItemV1(rawItem);
  if (item.status === "applied") return item;
  if (item.status === "blocked") return item;
  const at = expectIsoTimestamp(input.at, "Linear progress attempt time");
  if (at < item.updatedAt) {
    throw new DurableLinearContractError(
      "Linear progress attempt time cannot move backwards.",
    );
  }
  const updated: LinearProgressOutboxItemV1 = {
    ...item,
    status: input.retryable ? "pending" : "blocked",
    attemptCount: item.attemptCount + 1,
    updatedAt: at,
    appliedReceiptId: null,
    appliedReceiptFingerprint: null,
    lastError: expectString(input.error, "Linear progress host error", 1, 500),
  };
  return parseLinearProgressOutboxItemV1(updated);
}

export function acknowledgeLinearProgressOutboxItemV1(
  rawItem: LinearProgressOutboxItemV1,
  input: {
    at: string;
    providerReceiptId: string;
    providerReceiptFingerprint: string;
  },
): LinearProgressOutboxItemV1 {
  const item = parseLinearProgressOutboxItemV1(rawItem);
  const providerReceiptId = expectOpaqueId(
    input.providerReceiptId,
    "Linear progress provider receipt id",
  );
  const providerReceiptFingerprint = expectSha256(
    input.providerReceiptFingerprint,
    "Linear progress provider receipt fingerprint",
  );
  if (item.status === "applied") {
    if (
      item.appliedReceiptId !== providerReceiptId ||
      !constantTimeFingerprintEqual(
        item.appliedReceiptFingerprint!,
        providerReceiptFingerprint,
      )
    ) {
      throw new DurableLinearContractError(
        "Applied Linear progress command cannot be acknowledged with a different provider receipt.",
      );
    }
    return item;
  }
  if (item.status === "blocked") {
    throw new DurableLinearContractError(
      "A terminally blocked Linear progress command cannot be acknowledged without a new command.",
    );
  }
  const at = expectIsoTimestamp(input.at, "Linear progress application time");
  if (at < item.updatedAt) {
    throw new DurableLinearContractError(
      "Linear progress application time cannot move backwards.",
    );
  }
  const updated: LinearProgressOutboxItemV1 = {
    ...item,
    status: "applied",
    attemptCount: item.attemptCount + 1,
    updatedAt: at,
    appliedReceiptId: providerReceiptId,
    appliedReceiptFingerprint: providerReceiptFingerprint,
    lastError: null,
  };
  return parseLinearProgressOutboxItemV1(updated);
}

export function formatLinearProgressCommentV1(
  item: LinearProgressOutboxItemV1,
): string {
  const parsed = parseLinearProgressOutboxItemV1(item);
  const copy: Record<LinearProgressCommentCodeV1, string> = {
    linear_plan_verified: "Project plan and issue readback verified.",
    implementation_started: "Issue-bound workspace implementation started.",
    actionable_blocker_observed: "Execution paused on a verified actionable blocker.",
    validation_and_commit_verified: "Targeted and full validation passed; local commit readback verified.",
    draft_pull_request_verified: "Draft pull request and remote head readback verified.",
    reflection_and_acceptance_verified: "Acceptance evidence and final Results reflection verified.",
  };
  return `${copy[parsed.commentCode]} Evidence is recorded in the developer mission Results report.`;
}

function parseProjectWorkUnitLinearBindingUnsignedV1(
  value: unknown,
): ProjectWorkUnitLinearBindingV1Unsigned {
  const record = expectPlainRecord(value, "project work-unit Linear binding");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "bindingId",
      "runId",
      "workUnitId",
      "linearIssueId",
      "linearIssueIdentifier",
      "linearIssueUrl",
      "acceptanceCriterionIds",
      "providerReadbackFingerprint",
      "verifiedAt",
    ],
    [],
    "project work-unit Linear binding",
  );
  if (record.schemaVersion !== PROJECT_WORK_UNIT_LINEAR_BINDING_SCHEMA_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported project work-unit Linear binding version.",
    );
  }
  const identifier = expectString(
    record.linearIssueIdentifier,
    "Linear issue identifier",
    3,
    80,
  );
  if (!/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/u.test(identifier)) {
    throw new DurableLinearContractError(
      "Linear issue identifier must be an uppercase team key and issue number.",
    );
  }
  const url = parseHttpUrl(record.linearIssueUrl, "Linear issue URL");
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== "https:" ||
    (parsedUrl.hostname !== "linear.app" && !parsedUrl.hostname.endsWith(".linear.app"))
  ) {
    throw new DurableLinearContractError(
      "Project work-unit issue URL must be a canonical Linear HTTPS URL.",
    );
  }
  return {
    schemaVersion: PROJECT_WORK_UNIT_LINEAR_BINDING_SCHEMA_VERSION,
    bindingId: expectOpaqueId(record.bindingId, "project Linear binding id"),
    runId: expectOpaqueId(record.runId, "project run id"),
    workUnitId: expectOpaqueId(record.workUnitId, "project work-unit id"),
    linearIssueId: expectOpaqueId(record.linearIssueId, "Linear issue id"),
    linearIssueIdentifier: identifier,
    linearIssueUrl: url,
    acceptanceCriterionIds: parseUniqueStrings(
      record.acceptanceCriterionIds,
      "work-unit acceptance criterion id",
      1,
      100,
      160,
      (entry, label) => expectOpaqueId(entry, label),
    ).sort(),
    providerReadbackFingerprint: expectSha256(
      record.providerReadbackFingerprint,
      "Linear issue provider readback fingerprint",
    ),
    verifiedAt: expectIsoTimestamp(record.verifiedAt, "Linear issue binding verification time"),
  };
}

function deriveWorkUnitState(
  binding: ProjectWorkUnitLinearBindingV1,
  events: readonly ProjectStageEventV1[],
): LinearProjectProgressWorkUnitStateV1 {
  const globalLinearEvents = events.filter(
    (event) =>
      event.disposition === "verified" &&
      event.evidenceKind === "linear_hierarchy_readback",
  );
  const boundEvents = events.filter((event) =>
    event.workUnits.some((unit) => unit.workUnitId === binding.workUnitId),
  );
  const verified = boundEvents.filter((event) => event.disposition === "verified");
  const byKind = (kind: ProjectEvidenceKindV1) =>
    verified.filter((event) => event.evidenceKind === kind);
  const latestBlocker = lastEvent(
    boundEvents.filter((event) => event.disposition === "blocked"),
  );
  const paidAcceptanceCriterionIds = [
    ...new Set(
      byKind("acceptance_criterion").flatMap((event) =>
        event.workUnits
          .filter((unit) => unit.workUnitId === binding.workUnitId)
          .flatMap((unit) => unit.acceptanceCriterionIds),
      ),
    ),
  ]
    .filter((criterion) => binding.acceptanceCriterionIds.includes(criterion))
    .sort();
  const unpaidAcceptanceCriterionIds = binding.acceptanceCriterionIds.filter(
    (criterion) => !paidAcceptanceCriterionIds.includes(criterion),
  );

  let target: LinearProjectProgressTargetV1 | null = null;
  let commentCode: LinearProgressCommentCodeV1 | null = null;
  let sources: ProjectStageEventV1[] = [];
  if (globalLinearEvents.length > 0) {
    target = "ready";
    commentCode = "linear_plan_verified";
    sources = [lastEvent(globalLinearEvents)!];
  }
  if (byKind("workspace_mutation").length > 0) {
    target = "in_progress";
    commentCode = "implementation_started";
    sources = [lastEvent(byKind("workspace_mutation"))!];
  }
  const validationEvidence = [
    lastEvent(byKind("targeted_validation")),
    lastEvent(byKind("full_validation")),
    lastEvent(byKind("commit_readback")),
  ].filter((event): event is ProjectStageEventV1 => Boolean(event));
  if (validationEvidence.length === 3) {
    target = "ready_for_review";
    commentCode = "validation_and_commit_verified";
    sources = validationEvidence;
  }
  const publicationEvidence = [
    lastEvent(byKind("github_repository_readback")),
    lastEvent(byKind("github_draft_pr_readback")),
  ].filter((event): event is ProjectStageEventV1 => Boolean(event));
  if (publicationEvidence.length === 2) {
    target = "in_review";
    commentCode = "draft_pull_request_verified";
    sources = publicationEvidence;
  }
  const reflection = lastEvent(byKind("reflection_writeback"));
  if (
    reflection &&
    publicationEvidence.length === 2 &&
    unpaidAcceptanceCriterionIds.length === 0
  ) {
    target = "completed";
    commentCode = "reflection_and_acceptance_verified";
    sources = [
      ...publicationEvidence,
      ...byKind("acceptance_criterion"),
      reflection,
    ];
  }

  // Any newer receipt-backed work-unit proof resolves an older blocker. The
  // target still falls back to the highest fully paid phase, so one repair
  // receipt cannot skip the remaining validation gates.
  const latestProgress = lastEvent(verified);
  if (
    latestBlocker &&
    (!latestProgress || compareEvents(latestBlocker, latestProgress) > 0)
  ) {
    target = "blocked";
    commentCode = "actionable_blocker_observed";
    sources = [latestBlocker];
  }
  return {
    workUnitId: binding.workUnitId,
    linearIssueId: binding.linearIssueId,
    target,
    commentCode,
    sourceEventIds: [...new Set(sources.map((event) => event.eventId))].sort(),
    paidAcceptanceCriterionIds,
    unpaidAcceptanceCriterionIds,
  };
}

function parseWorkUnitState(value: unknown): LinearProjectProgressWorkUnitStateV1 {
  const record = expectPlainRecord(value, "Linear progress work-unit state");
  assertExactKeys(
    record,
    [
      "workUnitId",
      "linearIssueId",
      "target",
      "commentCode",
      "sourceEventIds",
      "paidAcceptanceCriterionIds",
      "unpaidAcceptanceCriterionIds",
    ],
    [],
    "Linear progress work-unit state",
  );
  const target =
    record.target === null
      ? null
      : expectEnum(
          record.target,
          "Linear progress target",
          LINEAR_PROJECT_PROGRESS_TARGETS_V1,
        );
  const commentCode = record.commentCode === null ? null : parseCommentCode(record.commentCode);
  if ((target === null) !== (commentCode === null)) {
    throw new DurableLinearContractError(
      "Linear progress target and comment code must both be present or both be null.",
    );
  }
  const paid = parseUniqueStrings(
    record.paidAcceptanceCriterionIds,
    "paid acceptance criterion id",
    0,
    100,
    160,
    (entry, label) => expectOpaqueId(entry, label),
  ).sort();
  const unpaid = parseUniqueStrings(
    record.unpaidAcceptanceCriterionIds,
    "unpaid acceptance criterion id",
    0,
    100,
    160,
    (entry, label) => expectOpaqueId(entry, label),
  ).sort();
  if (paid.some((criterion) => unpaid.includes(criterion))) {
    throw new DurableLinearContractError(
      "An acceptance criterion cannot be both paid and unpaid.",
    );
  }
  return {
    workUnitId: expectOpaqueId(record.workUnitId, "project work-unit id"),
    linearIssueId: expectOpaqueId(record.linearIssueId, "Linear issue id"),
    target,
    commentCode,
    sourceEventIds: parseUniqueStrings(
      record.sourceEventIds,
      "Linear progress source event id",
      target ? 1 : 0,
      100,
      80,
      (entry, label) => expectSha256(entry, label),
    ).sort(),
    paidAcceptanceCriterionIds: paid,
    unpaidAcceptanceCriterionIds: unpaid,
  };
}

function parseCommentCode(value: unknown): LinearProgressCommentCodeV1 {
  return expectEnum(
    value,
    "Linear progress comment code",
    [
      "linear_plan_verified",
      "implementation_started",
      "actionable_blocker_observed",
      "validation_and_commit_verified",
      "draft_pull_request_verified",
      "reflection_and_acceptance_verified",
    ] as const,
  );
}

function parseNullableOpaqueId(value: unknown, label: string): string | null {
  return value === null ? null : expectOpaqueId(value, label);
}

function parseNullableError(value: unknown): string | null {
  return value === null
    ? null
    : expectString(value, "Linear progress host error", 1, 500);
}

function dedupeEvents(events: ProjectStageEventV1[]): ProjectStageEventV1[] {
  const unique = new Map(events.map((event) => [event.eventId, event]));
  return [...unique.values()].sort(compareEvents);
}

function assertEventsUseExactBindings(
  events: readonly ProjectStageEventV1[],
  bindings: readonly ProjectWorkUnitLinearBindingV1[],
): void {
  const byWorkUnit = new Map(
    bindings.map((binding) => [binding.workUnitId, binding] as const),
  );
  for (const event of events) {
    for (const unit of event.workUnits) {
      const binding = byWorkUnit.get(unit.workUnitId);
      if (!binding) {
        throw new DurableLinearContractError(
          `Project event ${event.eventId} references an unbound work unit.`,
        );
      }
      if (
        unit.acceptanceCriterionIds.some(
          (criterionId) => !binding.acceptanceCriterionIds.includes(criterionId),
        )
      ) {
        throw new DurableLinearContractError(
          `Project event ${event.eventId} references an acceptance criterion outside its Linear binding.`,
        );
      }
      if (
        event.evidenceKind === "acceptance_criterion" &&
        unit.acceptanceCriterionIds.length === 0
      ) {
        throw new DurableLinearContractError(
          "Acceptance evidence must name at least one criterion from its exact work-unit binding.",
        );
      }
    }
  }
}

function lastEvent(
  events: readonly ProjectStageEventV1[],
): ProjectStageEventV1 | null {
  return [...events].sort(compareEvents).pop() ?? null;
}

function compareEvents(left: ProjectStageEventV1, right: ProjectStageEventV1): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameWorkUnitStates(
  left: readonly LinearProjectProgressWorkUnitStateV1[],
  right: readonly LinearProjectProgressWorkUnitStateV1[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
