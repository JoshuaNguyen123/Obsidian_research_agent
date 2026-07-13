import {
  parseAcceptedResearchArtifactV1,
  type AcceptedResearchArtifactV1,
} from "./AcceptedResearchArtifactV1";
import {
  parseExternalWorkItemBindingV1,
  type ExternalWorkItemBindingV1,
} from "./ExternalWorkItemBindingV1";
import {
  assertExactKeys,
  assertSecretFree,
  DurableLinearContractError,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  parseHttpUrl,
  parseVaultMarkdownPath,
} from "./LinearContractSupport";
import type { ResearchNoteBacklinkResultV1 } from "./AcceptedResearchNoteWriter";
import {
  RESEARCH_PUBLICATION_CHECKPOINT_SCHEMA_VERSION,
  type ResearchPublicationCheckpointStatusV1,
  type ResearchPublicationCheckpointV1,
  type ResearchPublicationErrorV1,
  type ResearchPublicationIssueReferenceV1,
  type ResearchPublicationLineagePortV1,
  type ResearchPublicationPendingActionV1,
} from "./ResearchPublicationWorkflow";
import {
  parseWorkItemLineageV1,
  type WorkItemLineageV1,
} from "./WorkItemLineageV1";

export const RESEARCH_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION = 1 as const;
export const RESEARCH_PUBLICATION_CHECKPOINT_LIMIT = 500;

export interface ResearchPublicationCheckpointNamespaceV1 {
  version: typeof RESEARCH_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION;
  revision: number;
  checkpoints: Record<string, ResearchPublicationCheckpointV1>;
}

/**
 * Adapter boundary for an owning plugin's loadData/saveData namespace.
 * Implementations may use expectedRevision for a compare-and-swap write and
 * return false when another owner changed the namespace.
 */
export interface ResearchPublicationCheckpointPersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(
    namespace: ResearchPublicationCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<void | boolean>;
}

export class ResearchPublicationCheckpointStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResearchPublicationCheckpointStoreError";
  }
}

/**
 * Crash-durable research publication checkpoints. All mutations are queued so
 * two workflow callbacks in the same host cannot overwrite one another.
 */
export class ResearchPublicationCheckpointStoreV1
  implements ResearchPublicationLineagePortV1 {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: ResearchPublicationCheckpointPersistenceV1,
  ) {}

  async get(publicationId: string): Promise<ResearchPublicationCheckpointV1 | null> {
    await this.mutationTail;
    const id = expectLogicalKey(publicationId, "research publication id", 180);
    const namespace = parseResearchPublicationCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return cloneCheckpoint(namespace.checkpoints[id] ?? null);
  }

  async list(): Promise<ResearchPublicationCheckpointV1[]> {
    await this.mutationTail;
    const namespace = parseResearchPublicationCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return Object.values(namespace.checkpoints)
      .sort((left, right) => left.publicationId.localeCompare(right.publicationId))
      .map((checkpoint) => cloneCheckpoint(checkpoint) as ResearchPublicationCheckpointV1);
  }

  async persist(checkpoint: ResearchPublicationCheckpointV1): Promise<void> {
    await this.upsert(checkpoint);
  }

  async upsert(
    checkpoint: ResearchPublicationCheckpointV1,
  ): Promise<ResearchPublicationCheckpointV1> {
    const operation = this.mutationTail.then(async () => {
      const normalized = parseResearchPublicationCheckpointV1(checkpoint);
      const current = parseResearchPublicationCheckpointNamespaceV1(
        await this.persistence.read(),
      );
      const previous = current.checkpoints[normalized.publicationId];
      if (previous) {
        validateCheckpointTransition(previous, normalized);
      } else if (Object.keys(current.checkpoints).length >= RESEARCH_PUBLICATION_CHECKPOINT_LIMIT) {
        throw new ResearchPublicationCheckpointStoreError(
          "research_publication_checkpoint_limit",
          `Research publication checkpoint storage is limited to ${RESEARCH_PUBLICATION_CHECKPOINT_LIMIT} entries.`,
        );
      }
      const next: ResearchPublicationCheckpointNamespaceV1 = {
        version: RESEARCH_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION,
        revision: current.revision + 1,
        checkpoints: {
          ...current.checkpoints,
          [normalized.publicationId]: normalized,
        },
      };
      const written = await this.persistence.write(cloneNamespace(next), current.revision);
      if (written === false) {
        throw new ResearchPublicationCheckpointStoreError(
          "research_publication_checkpoint_conflict",
          "Research publication checkpoint state changed before it could be saved.",
        );
      }
      return normalized;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return cloneCheckpoint(await operation) as ResearchPublicationCheckpointV1;
  }
}

export function parseResearchPublicationCheckpointNamespaceV1(
  value: unknown,
): ResearchPublicationCheckpointNamespaceV1 {
  if (value === null || value === undefined) {
    return emptyResearchPublicationCheckpointNamespaceV1();
  }
  const record = expectPlainRecord(value, "research publication checkpoint namespace");
  assertExactKeys(
    record,
    ["version", "revision", "checkpoints"],
    [],
    "research publication checkpoint namespace",
  );
  if (record.version !== RESEARCH_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported research publication checkpoint namespace version.",
    );
  }
  const rawCheckpoints = expectPlainRecord(
    record.checkpoints,
    "research publication checkpoints",
  );
  const entries = Object.entries(rawCheckpoints);
  if (entries.length > RESEARCH_PUBLICATION_CHECKPOINT_LIMIT) {
    throw new DurableLinearContractError(
      `Research publication checkpoint storage exceeds ${RESEARCH_PUBLICATION_CHECKPOINT_LIMIT} entries.`,
    );
  }
  const checkpoints: Record<string, ResearchPublicationCheckpointV1> = {};
  for (const [rawId, rawCheckpoint] of entries) {
    const id = expectLogicalKey(rawId, "research publication checkpoint key", 180);
    const checkpoint = parseResearchPublicationCheckpointV1(rawCheckpoint);
    if (checkpoint.publicationId !== id) {
      throw new DurableLinearContractError(
        "Research publication checkpoint key must match its publication id.",
      );
    }
    checkpoints[id] = checkpoint;
  }
  return {
    version: RESEARCH_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION,
    revision: expectInteger(record.revision, "research publication checkpoint revision", 0, Number.MAX_SAFE_INTEGER),
    checkpoints,
  };
}

export function parseResearchPublicationCheckpointV1(
  value: unknown,
): ResearchPublicationCheckpointV1 {
  const record = expectPlainRecord(value, "research publication checkpoint");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "publicationId",
      "status",
      "updatedAt",
      "artifact",
      "lineage",
      "workItemFingerprint",
      "approvalFingerprint",
      "binding",
      "issue",
      "pendingAction",
      "backlink",
      "error",
    ],
    [],
    "research publication checkpoint",
  );
  if (record.schemaVersion !== RESEARCH_PUBLICATION_CHECKPOINT_SCHEMA_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported research publication checkpoint version.",
    );
  }
  const publicationId = expectLogicalKey(record.publicationId, "research publication id", 180);
  const status = expectEnum<ResearchPublicationCheckpointStatusV1>(
    record.status,
    "research publication checkpoint status",
    [
      "note_verified",
      "approval_denied",
      "failed",
      "reconcile_required",
      "linear_verified",
      "waiting_obsidian",
      "complete",
    ],
  );
  const updatedAt = expectIsoTimestamp(record.updatedAt, "research publication checkpoint update time");
  const artifact = parseAcceptedResearchArtifactV1(record.artifact);
  const lineage = record.lineage === null ? null : parseWorkItemLineageV1(record.lineage);
  const workItemFingerprint = nullableSha256(record.workItemFingerprint, "work item fingerprint");
  const approvalFingerprint = nullableSha256(record.approvalFingerprint, "approval fingerprint");
  const binding = record.binding === null
    ? null
    : parseExternalWorkItemBindingV1(record.binding);
  const issue = record.issue === null ? null : parseIssueReference(record.issue);
  const pendingAction = record.pendingAction === null
    ? null
    : parsePendingAction(record.pendingAction);
  const backlink = record.backlink === null ? null : parseBacklink(record.backlink);
  const error = record.error === null ? null : parseError(record.error, "research publication error");
  const normalized: ResearchPublicationCheckpointV1 = {
    schemaVersion: RESEARCH_PUBLICATION_CHECKPOINT_SCHEMA_VERSION,
    publicationId,
    status,
    updatedAt,
    artifact,
    lineage,
    workItemFingerprint,
    approvalFingerprint,
    binding,
    issue,
    pendingAction,
    backlink,
    error,
  };
  validateCheckpointConsistency(normalized);
  return normalized;
}

function emptyResearchPublicationCheckpointNamespaceV1(): ResearchPublicationCheckpointNamespaceV1 {
  return {
    version: RESEARCH_PUBLICATION_CHECKPOINT_NAMESPACE_VERSION,
    revision: 0,
    checkpoints: {},
  };
}

function parseIssueReference(value: unknown): ResearchPublicationIssueReferenceV1 {
  const record = expectPlainRecord(value, "research publication issue reference");
  assertExactKeys(
    record,
    ["id", "identifier", "url", "updatedAt", "snapshotHash"],
    [],
    "research publication issue reference",
  );
  const identifier = expectString(record.identifier, "Linear issue identifier", 3, 80);
  if (!/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/u.test(identifier)) {
    throw new DurableLinearContractError("Linear issue identifier is invalid.");
  }
  const url = parseCanonicalLinearUrl(record.url, "Linear issue URL");
  return {
    id: expectOpaqueId(record.id, "Linear issue id"),
    identifier,
    url,
    updatedAt: expectIsoTimestamp(record.updatedAt, "Linear issue update time"),
    snapshotHash: expectSha256(record.snapshotHash, "Linear issue snapshot hash"),
  };
}

function parsePendingAction(value: unknown): ResearchPublicationPendingActionV1 {
  const record = expectPlainRecord(value, "research publication pending action");
  assertExactKeys(
    record,
    ["provider", "operation", "actionId", "issueId", "grantId", "workItemFingerprint", "error"],
    [],
    "research publication pending action",
  );
  if (record.provider !== "linear" || record.operation !== "publish_research_ticket") {
    throw new DurableLinearContractError("Research publication pending action must be a Linear publication.");
  }
  return {
    provider: "linear",
    operation: "publish_research_ticket",
    actionId: nullableOpaqueId(record.actionId, "pending Linear action id"),
    issueId: nullableOpaqueId(record.issueId, "pending Linear issue id"),
    grantId: nullableOpaqueId(record.grantId, "pending authority grant id"),
    workItemFingerprint: expectSha256(record.workItemFingerprint, "pending work item fingerprint"),
    error: parseError(record.error, "pending Linear action error"),
  };
}

function parseBacklink(value: unknown): ResearchNoteBacklinkResultV1 {
  const record = expectPlainRecord(value, "research note backlink");
  assertExactKeys(
    record,
    ["path", "operation", "beforeSha256", "afterSha256", "issueUrl", "transaction"],
    [],
    "research note backlink",
  );
  const operation = expectEnum<ResearchNoteBacklinkResultV1["operation"]>(
    record.operation,
    "research note backlink operation",
    ["append", "no_op"],
  );
  const transaction = record.transaction === null
    ? null
    : cloneSecretFreeJson(record.transaction, "research note backlink transaction");
  if ((operation === "append") !== (transaction !== null)) {
    throw new DurableLinearContractError(
      "An appended research backlink requires a transaction and a no-op backlink must omit it.",
    );
  }
  return {
    path: parseVaultMarkdownPath(record.path, "research note backlink path"),
    operation,
    beforeSha256: expectSha256(record.beforeSha256, "research note backlink before hash"),
    afterSha256: expectSha256(record.afterSha256, "research note backlink after hash"),
    issueUrl: parseCanonicalLinearUrl(record.issueUrl, "research note backlink issue URL"),
    transaction: transaction as ResearchNoteBacklinkResultV1["transaction"],
  };
}

function parseError(value: unknown, label: string): ResearchPublicationErrorV1 {
  const record = expectPlainRecord(value, label);
  assertExactKeys(record, ["code", "message"], [], label);
  return {
    code: expectLogicalKey(record.code, `${label} code`, 160),
    message: expectString(record.message, `${label} message`, 1, 2_000, {
      allowNewlines: true,
      secretFree: true,
    }),
  };
}

function validateCheckpointConsistency(checkpoint: ResearchPublicationCheckpointV1): void {
  const {
    artifact,
    lineage,
    workItemFingerprint,
    binding,
    issue,
    pendingAction,
    backlink,
    error,
    status,
  } = checkpoint;
  if (Date.parse(checkpoint.updatedAt) < Date.parse(artifact.acceptedAt)) {
    throw new DurableLinearContractError("Checkpoint update cannot predate accepted research.");
  }
  if (lineage) {
    if (
      lineage.originRunId !== artifact.originRunId ||
      lineage.researchArtifactFingerprint !== artifact.artifactFingerprint ||
      lineage.workItemFingerprint !== workItemFingerprint
    ) {
      throw new DurableLinearContractError("Checkpoint lineage does not match the accepted research artifact.");
    }
    const latest = lineage.events[lineage.events.length - 1];
    if (latest && Date.parse(checkpoint.updatedAt) < Date.parse(latest.occurredAt)) {
      throw new DurableLinearContractError("Checkpoint update cannot predate its latest lineage receipt.");
    }
  }
  if (binding) {
    if (
      !lineage ||
      binding.originRunId !== artifact.originRunId ||
      binding.acceptedResearchArtifactFingerprint !== artifact.artifactFingerprint ||
      binding.workItemFingerprint !== workItemFingerprint ||
      lineage.externalWorkItemBindingFingerprint !== binding.bindingFingerprint
    ) {
      throw new DurableLinearContractError("Checkpoint binding does not match its artifact and lineage.");
    }
  }
  if (issue && binding && (
    issue.id !== binding.issueId ||
    issue.identifier !== binding.issueIdentifier ||
    issue.url !== binding.issueUrl ||
    issue.updatedAt !== binding.issueUpdatedAt
  )) {
    throw new DurableLinearContractError("Checkpoint issue readback does not match its verified binding.");
  }
  if (pendingAction && pendingAction.workItemFingerprint !== workItemFingerprint) {
    throw new DurableLinearContractError("Pending Linear action does not match the work item fingerprint.");
  }
  if (backlink && (
    !issue ||
    backlink.path !== artifact.notePath ||
    backlink.issueUrl !== issue.url
  )) {
    throw new DurableLinearContractError("Research note backlink does not match its artifact and Linear issue.");
  }

  if (status === "note_verified" && (!lineage || !workItemFingerprint || binding || issue || pendingAction || backlink || error)) {
    throw invalidStatus(status);
  }
  if (status === "approval_denied" && (!lineage || !workItemFingerprint || !checkpoint.approvalFingerprint || binding || issue || pendingAction || backlink || !error)) {
    throw invalidStatus(status);
  }
  if (status === "failed" && (!error || binding || pendingAction || backlink)) {
    throw invalidStatus(status);
  }
  if (status === "reconcile_required" && (!lineage || !workItemFingerprint || !checkpoint.approvalFingerprint || binding || !pendingAction || backlink || !error)) {
    throw invalidStatus(status);
  }
  if (status === "linear_verified" && (!lineage || !workItemFingerprint || !checkpoint.approvalFingerprint || !binding || !issue || pendingAction || backlink || error)) {
    throw invalidStatus(status);
  }
  if (status === "waiting_obsidian" && (!lineage || !workItemFingerprint || !checkpoint.approvalFingerprint || !binding || !issue || pendingAction || backlink || !error)) {
    throw invalidStatus(status);
  }
  if (status === "complete" && (!lineage || !workItemFingerprint || !checkpoint.approvalFingerprint || !binding || !issue || pendingAction || !backlink || error)) {
    throw invalidStatus(status);
  }
}

function validateCheckpointTransition(
  previous: ResearchPublicationCheckpointV1,
  next: ResearchPublicationCheckpointV1,
): void {
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new ResearchPublicationCheckpointStoreError(
      "research_publication_checkpoint_stale",
      "Research publication checkpoints cannot move backwards in time.",
    );
  }
  if (
    previous.artifact.artifactFingerprint !== next.artifact.artifactFingerprint ||
    (previous.workItemFingerprint && previous.workItemFingerprint !== next.workItemFingerprint) ||
    (previous.approvalFingerprint && previous.approvalFingerprint !== next.approvalFingerprint)
  ) {
    throw new ResearchPublicationCheckpointStoreError(
      "research_publication_checkpoint_identity_changed",
      "A durable research publication identity cannot be rewritten.",
    );
  }
  const allowed = STATUS_TRANSITIONS[previous.status];
  if (!allowed.includes(next.status)) {
    throw new ResearchPublicationCheckpointStoreError(
      "research_publication_checkpoint_invalid_transition",
      `Research publication cannot transition from ${previous.status} to ${next.status}.`,
    );
  }
}

const STATUS_TRANSITIONS: Readonly<Record<
  ResearchPublicationCheckpointStatusV1,
  readonly ResearchPublicationCheckpointStatusV1[]
>> = {
  note_verified: ["note_verified", "approval_denied", "failed", "reconcile_required", "linear_verified"],
  approval_denied: ["approval_denied"],
  failed: ["failed"],
  reconcile_required: ["reconcile_required", "failed", "linear_verified"],
  linear_verified: ["linear_verified", "reconcile_required", "waiting_obsidian", "complete"],
  waiting_obsidian: ["waiting_obsidian", "complete"],
  complete: ["complete"],
};

function invalidStatus(status: ResearchPublicationCheckpointStatusV1): DurableLinearContractError {
  return new DurableLinearContractError(
    `Research publication checkpoint fields are inconsistent with ${status}.`,
  );
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : expectSha256(value, label);
}

function nullableOpaqueId(value: unknown, label: string): string | null {
  return value === null ? null : expectOpaqueId(value, label);
}

function parseCanonicalLinearUrl(value: unknown, label: string): string {
  const normalized = parseHttpUrl(value, label);
  const url = new URL(normalized);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "linear.app" && !url.hostname.endsWith(".linear.app")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DurableLinearContractError(`${label} must be a canonical linear.app HTTPS URL.`);
  }
  return url.toString();
}

function cloneSecretFreeJson(value: unknown, label: string, depth = 0): unknown {
  if (depth > 12) {
    throw new DurableLinearContractError(`${label} exceeds the supported nesting depth.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DurableLinearContractError(`${label} contains a non-finite number.`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 20_000) throw new DurableLinearContractError(`${label} contains an oversized string.`);
    assertSecretFree(value, label);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new DurableLinearContractError(`${label} contains too many entries.`);
    return value.map((entry, index) => cloneSecretFreeJson(entry, `${label} ${index + 1}`, depth + 1));
  }
  const record = expectPlainRecord(value, label);
  const entries = Object.entries(record);
  if (entries.length > 500) throw new DurableLinearContractError(`${label} contains too many fields.`);
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (key === "__proto__" || key === "prototype" || key === "constructor" || entry === undefined) {
      throw new DurableLinearContractError(`${label} contains an unsafe or undefined field.`);
    }
    assertSecretFree(key, `${label} field name`);
    cloned[key] = cloneSecretFreeJson(entry, `${label}.${key}`, depth + 1);
  }
  return cloned;
}

function cloneCheckpoint(
  checkpoint: ResearchPublicationCheckpointV1 | null,
): ResearchPublicationCheckpointV1 | null {
  if (!checkpoint) return null;
  return parseResearchPublicationCheckpointV1(cloneSecretFreeJson(checkpoint, "research publication checkpoint clone"));
}

function cloneNamespace(
  namespace: ResearchPublicationCheckpointNamespaceV1,
): ResearchPublicationCheckpointNamespaceV1 {
  return parseResearchPublicationCheckpointNamespaceV1(
    cloneSecretFreeJson(namespace, "research publication checkpoint namespace clone"),
  );
}

