import { createHash } from "node:crypto";

import type { JsonValueV1 } from "@agentic-researcher/core-api";
import { canonicalJson } from "../../../packages/headless-runtime/src/canonicalize";
import {
  parsePreparedSandboxActionV2,
  type PreparedSandboxActionV2,
  type SandboxExecutionReceiptV2,
} from "./SandboxManager";

const JOURNAL_VERSION = 1 as const;
const MAX_RECORDS = 512;
const MAX_RETIRED_RECORD_IDS = 512;
const RETIREMENT_FILTER_BYTES = 8_192;
const RETIREMENT_FILTER_BITS = RETIREMENT_FILTER_BYTES * 8;
const RETIREMENT_FILTER_HASHES = 7;
const RETIREMENT_FILTER_HEX = new RegExp(`^[0-9a-f]{${RETIREMENT_FILTER_BYTES * 2}}$`, "u");
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type DurableSandboxExecutionStatusV1 =
  | "prepared"
  | "dispatch_uncertain"
  | "execution_verified"
  | "committed"
  | "not_applied";

export interface SandboxNotAppliedProofV2 {
  actionId: string;
  actionFingerprint: string;
  checkedAt: string;
  fingerprint: string;
}

export type SandboxExecutionReconciliationV2 =
  | {
      outcome: "committed";
      receipt: SandboxExecutionReceiptV2;
      validationReceipt?: JsonValueV1;
    }
  | {
      outcome: "not_applied";
      proof: SandboxNotAppliedProofV2;
      message: string;
    }
  | { outcome: "still_uncertain"; message: string };

export interface DurableSandboxExecutionRecordV1 {
  version: typeof JOURNAL_VERSION;
  id: string;
  revision: number;
  runId: string;
  action: PreparedSandboxActionV2;
  status: DurableSandboxExecutionStatusV1;
  preparedAt: string;
  dispatchStartedAt: string | null;
  receiptRecordedAt: string | null;
  committedAt: string | null;
  updatedAt: string;
  receipt: SandboxExecutionReceiptV2 | null;
  validationReceipt: JsonValueV1 | null;
  notAppliedProof: SandboxNotAppliedProofV2 | null;
  fingerprint: string;
}

export interface DurableSandboxExecutionNamespaceV1 {
  version: typeof JOURNAL_VERSION;
  revision: number;
  records: Record<string, DurableSandboxExecutionRecordV1>;
  retirement: DurableSandboxExecutionRetirementV1;
}

/**
 * Bounded replay fence. `filterHex` is an append-only Bloom accumulator: a
 * retired identity can never become absent, while a rare false positive blocks
 * a genuinely new action safely. `recordIds` retains recent exact identities
 * for diagnostics without making journal growth unbounded.
 */
export interface DurableSandboxExecutionRetirementV1 {
  version: typeof JOURNAL_VERSION;
  recordIds: string[];
  filterHex: string;
  retiredCount: number;
  fingerprint: string;
}

export interface DurableSandboxExecutionJournalPersistenceV1 {
  readNamespace(): Promise<DurableSandboxExecutionNamespaceV1 | null | undefined>;
  writeNamespace(
    namespace: DurableSandboxExecutionNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean>;
}

export interface SandboxExecutionJournalV1 {
  recordPrepared(input: {
    runId: string;
    action: PreparedSandboxActionV2;
  }): Promise<DurableSandboxExecutionRecordV1>;
  markDispatching(input: {
    runId: string;
    action: PreparedSandboxActionV2;
  }): Promise<DurableSandboxExecutionRecordV1>;
  recordExecutionReceipt(input: {
    runId: string;
    action: PreparedSandboxActionV2;
    receipt: SandboxExecutionReceiptV2;
  }): Promise<DurableSandboxExecutionRecordV1>;
  recordValidationReceipt(input: {
    runId: string;
    action: PreparedSandboxActionV2;
    validationReceipt: JsonValueV1;
  }): Promise<DurableSandboxExecutionRecordV1>;
  reconcile(input: {
    runId: string;
    action: PreparedSandboxActionV2;
  }): Promise<SandboxExecutionReconciliationV2>;
}

/**
 * Durable write-ahead journal for every prepared sandbox action. The
 * dispatch marker is committed before the caller may start a child process.
 * Once that marker exists, absence of a receipt is deliberately ambiguous.
 */
export class DurableSandboxExecutionJournalV1
  implements SandboxExecutionJournalV1
{
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: DurableSandboxExecutionJournalPersistenceV1,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordPrepared(input: {
    runId: string;
    action: PreparedSandboxActionV2;
  }): Promise<DurableSandboxExecutionRecordV1> {
    return this.serialized(async () => {
      const scope = parseScope(input);
      let namespace = parseNamespace(await this.persistence.readNamespace());
      const id = recordId(scope.runId, scope.action);
      const existing = namespace.records[id];
      if (existing) {
        assertRecordBinding(existing, scope.runId, scope.action);
        return clone(existing);
      }
      if (isRetiredRecordId(namespace.retirement, id)) {
        throw replayBlocked(id);
      }
      let prunedRecordIds: string[] = [];
      if (Object.keys(namespace.records).length >= MAX_RECORDS) {
        const pruned = pruneOldestTerminalRecords(namespace, 1);
        namespace = pruned.namespace;
        prunedRecordIds = pruned.recordIds;
      }
      const timestamp = this.timestamp();
      const record = sealRecord({
        version: JOURNAL_VERSION,
        id,
        revision: 0,
        runId: scope.runId,
        action: scope.action,
        status: "prepared",
        preparedAt: timestamp,
        dispatchStartedAt: null,
        receiptRecordedAt: null,
        committedAt: null,
        updatedAt: timestamp,
        receipt: null,
        validationReceipt: null,
        notAppliedProof: null,
      });
      return await this.save(namespace, record, prunedRecordIds);
    });
  }

  markDispatching(input: {
    runId: string;
    action: PreparedSandboxActionV2;
  }): Promise<DurableSandboxExecutionRecordV1> {
    return this.serialized(async () => {
      const scope = parseScope(input);
      const namespace = parseNamespace(await this.persistence.readNamespace());
      const current = requiredRecord(namespace, scope.runId, scope.action);
      if (current.status !== "prepared") {
        throw new DurableSandboxExecutionJournalErrorV1(
          "sandbox_journal_transition",
          `Sandbox action ${current.id} cannot dispatch from ${current.status}.`,
        );
      }
      const timestamp = this.timestamp();
      const next = replaceRecord(current, {
        status: "dispatch_uncertain",
        dispatchStartedAt: timestamp,
        updatedAt: timestamp,
      });
      return await this.save(namespace, next);
    });
  }

  recordExecutionReceipt(input: {
    runId: string;
    action: PreparedSandboxActionV2;
    receipt: SandboxExecutionReceiptV2;
  }): Promise<DurableSandboxExecutionRecordV1> {
    return this.serialized(async () => {
      const scope = parseScope(input);
      const receipt = parseDurableSandboxExecutionReceiptV2(input.receipt, scope.action);
      const namespace = parseNamespace(await this.persistence.readNamespace());
      const current = requiredRecord(namespace, scope.runId, scope.action);
      if (current.receipt) {
        if (canonical(current.receipt) !== canonical(receipt)) {
          throw new DurableSandboxExecutionJournalErrorV1(
            "sandbox_receipt_conflict",
            "Sandbox action is already bound to different execution evidence.",
          );
        }
        return clone(current);
      }
      if (current.status !== "dispatch_uncertain") {
        throw new DurableSandboxExecutionJournalErrorV1(
          "sandbox_journal_transition",
          "Sandbox execution receipt cannot be recorded without a durable pre-dispatch marker.",
        );
      }
      const timestamp = this.timestamp();
      const requiresValidation = scope.action.repairRequestId !== null;
      const next = replaceRecord(current, {
        status: requiresValidation ? "execution_verified" : "committed",
        receipt,
        receiptRecordedAt: timestamp,
        committedAt: requiresValidation ? null : timestamp,
        updatedAt: timestamp,
      });
      return await this.save(namespace, next);
    });
  }

  recordValidationReceipt(input: {
    runId: string;
    action: PreparedSandboxActionV2;
    validationReceipt: JsonValueV1;
  }): Promise<DurableSandboxExecutionRecordV1> {
    return this.serialized(async () => {
      const scope = parseScope(input);
      if (scope.action.repairRequestId === null) {
        throw new DurableSandboxExecutionJournalErrorV1(
          "sandbox_validation_scope",
          "Only repair-bound validation actions may attach a validation receipt.",
        );
      }
      const namespace = parseNamespace(await this.persistence.readNamespace());
      const current = requiredRecord(namespace, scope.runId, scope.action);
      if (!current.receipt) {
        throw new DurableSandboxExecutionJournalErrorV1(
          "sandbox_journal_transition",
          "Validation receipt cannot precede durable sandbox execution evidence.",
        );
      }
      const validation = parseDurableSandboxValidationReceiptV1(
        input.validationReceipt,
        scope.action,
        current.receipt,
      );
      if (current.validationReceipt) {
        if (canonical(current.validationReceipt) !== canonical(validation)) {
          throw new DurableSandboxExecutionJournalErrorV1(
            "sandbox_validation_receipt_conflict",
            "Sandbox action is already bound to different validation evidence.",
          );
        }
        return clone(current);
      }
      if (current.status !== "execution_verified") {
        throw new DurableSandboxExecutionJournalErrorV1(
          "sandbox_journal_transition",
          `Validation receipt cannot be attached from ${current.status}.`,
        );
      }
      const timestamp = this.timestamp();
      const next = replaceRecord(current, {
        status: "committed",
        validationReceipt: validation,
        committedAt: timestamp,
        updatedAt: timestamp,
      });
      return await this.save(namespace, next);
    });
  }

  reconcile(input: {
    runId: string;
    action: PreparedSandboxActionV2;
  }): Promise<SandboxExecutionReconciliationV2> {
    return this.serialized(async () => {
      const scope = parseScope(input);
      const namespace = parseNamespace(await this.persistence.readNamespace());
      let current = namespace.records[recordId(scope.runId, scope.action)];
      if (!current) {
        if (isRetiredRecordId(namespace.retirement, recordId(scope.runId, scope.action))) {
          return {
            outcome: "still_uncertain",
            message: "The terminal sandbox record was compacted behind a durable replay fence. Its exact outcome is no longer retained; do not replay.",
          };
        }
        return {
          outcome: "still_uncertain",
          message: "No durable sandbox execution journal record matches the prepared action.",
        };
      }
      assertRecordBinding(current, scope.runId, scope.action);
      if (current.status === "prepared") {
        const checkedAt = this.timestamp();
        const proofEvidence = {
          actionId: scope.action.id,
          actionFingerprint: scope.action.payloadFingerprint,
          checkedAt,
        };
        const proof: SandboxNotAppliedProofV2 = {
          ...proofEvidence,
          fingerprint: sha256(proofEvidence),
        };
        current = replaceRecord(current, {
          status: "not_applied",
          notAppliedProof: proof,
          updatedAt: checkedAt,
        });
        current = await this.save(namespace, current);
      }
      if (current.status === "not_applied" && current.notAppliedProof) {
        return {
          outcome: "not_applied",
          proof: clone(current.notAppliedProof),
          message: "Durable journal readback proves the sandbox action never crossed its dispatch boundary.",
        };
      }
      if (current.status === "committed" && current.receipt) {
        return {
          outcome: "committed",
          receipt: clone(current.receipt),
          ...(current.validationReceipt === null
            ? {}
            : { validationReceipt: clone(current.validationReceipt) }),
        };
      }
      return {
        outcome: "still_uncertain",
        message: current.status === "execution_verified"
          ? "Sandbox execution is durably verified, but its required validation receipt is not durable. Do not replay."
          : "Sandbox dispatch crossed the durable boundary without complete receipt proof. Do not replay.",
      };
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private timestamp(): string {
    return isoTimestamp(this.now().toISOString(), "journal timestamp");
  }

  private async save(
    namespace: DurableSandboxExecutionNamespaceV1,
    record: DurableSandboxExecutionRecordV1,
    requiredAbsentRecordIds: readonly string[] = [],
  ): Promise<DurableSandboxExecutionRecordV1> {
    const next: DurableSandboxExecutionNamespaceV1 = {
      version: JOURNAL_VERSION,
      revision: namespace.revision + 1,
      records: { ...namespace.records, [record.id]: clone(record) },
      retirement: clone(namespace.retirement),
    };
    if (!await this.persistence.writeNamespace(clone(next), namespace.revision)) {
      throw new DurableSandboxExecutionJournalErrorV1(
        "sandbox_journal_conflict",
        `Sandbox execution journal no longer has revision ${namespace.revision}.`,
      );
    }
    const readback = parseNamespace(await this.persistence.readNamespace());
    const persisted = readback.records[record.id];
    if (
      canonical(readback) !== canonical(next) ||
      !persisted ||
      canonical(persisted) !== canonical(record) ||
      requiredAbsentRecordIds.some((id) => readback.records[id] !== undefined)
    ) {
      throw new DurableSandboxExecutionJournalErrorV1(
        "sandbox_journal_readback",
        "Persisted sandbox execution journal record failed exact post-write readback.",
      );
    }
    return clone(persisted);
  }
}

export class DurableSandboxExecutionJournalErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DurableSandboxExecutionJournalErrorV1";
  }
}

export function parseDurableSandboxExecutionReceiptV2(
  input: unknown,
  expectedAction: PreparedSandboxActionV2,
): SandboxExecutionReceiptV2 {
  const action = parsePreparedSandboxActionV2(expectedAction);
  const receipt = exactRecord(input, [
    "version", "id", "actionId", "provider", "profileKey", "projectId",
    "commandId", "purpose", "status", "exitCode", "commandFingerprint",
    "stagingManifestFingerprint", "boundaryProbeFingerprint", "stdoutSha256",
    "stderrSha256", "stdoutBytes", "stderrBytes", "importedArtifacts",
    "authorizationGrantId", "startedAt", "completedAt", "fingerprint",
  ], "sandbox execution receipt") as unknown as SandboxExecutionReceiptV2;
  const cloneReceipt = clone(receipt);
  const { fingerprint, ...evidence } = cloneReceipt;
  if (
    cloneReceipt.version !== 1 ||
    cloneReceipt.actionId !== action.id ||
    cloneReceipt.provider !== action.provider ||
    cloneReceipt.profileKey !== action.profileKey ||
    cloneReceipt.projectId !== action.projectId ||
    cloneReceipt.commandId !== action.commandId ||
    cloneReceipt.purpose !== action.purpose ||
    cloneReceipt.commandFingerprint !== sha256(action.command) ||
    cloneReceipt.stagingManifestFingerprint !== sha256(action.stagingManifest) ||
    cloneReceipt.boundaryProbeFingerprint !== action.probeFingerprint ||
    !["verified", "failed"].includes(cloneReceipt.status) ||
    (cloneReceipt.status === "verified") !== (cloneReceipt.exitCode === 0) ||
    !Number.isSafeInteger(cloneReceipt.exitCode) ||
    fingerprint !== sha256(evidence)
  ) {
    throw new DurableSandboxExecutionJournalErrorV1(
      "sandbox_receipt_invalid",
      "Sandbox execution receipt does not match its exact prepared action or canonical evidence.",
    );
  }
  identifier(cloneReceipt.id, "sandbox receipt id");
  identifier(cloneReceipt.authorizationGrantId, "sandbox authorization grant id");
  fingerprintValue(cloneReceipt.stdoutSha256, "sandbox stdout hash");
  fingerprintValue(cloneReceipt.stderrSha256, "sandbox stderr hash");
  boundedInteger(cloneReceipt.stdoutBytes, "sandbox stdout bytes", 0, 32 * 1024 * 1024);
  boundedInteger(cloneReceipt.stderrBytes, "sandbox stderr bytes", 0, 32 * 1024 * 1024);
  const startedAt = isoTimestamp(cloneReceipt.startedAt, "sandbox startedAt");
  const completedAt = isoTimestamp(cloneReceipt.completedAt, "sandbox completedAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error("Sandbox completion predates dispatch.");
  }
  if (!Array.isArray(cloneReceipt.importedArtifacts) || cloneReceipt.importedArtifacts.length > 100) {
    throw new Error("Sandbox imported artifact evidence is invalid.");
  }
  const paths = new Set<string>();
  for (const artifact of cloneReceipt.importedArtifacts) {
    exactRecord(artifact, ["path", "sha256", "bytes", "readbackSha256"], "sandbox imported artifact");
    const path = safeRelativePath(artifact.path, "sandbox imported artifact path");
    if (paths.has(path)) throw new Error("Sandbox imported artifact paths repeat.");
    paths.add(path);
    if (
      fingerprintValue(artifact.sha256, "sandbox artifact hash") !==
        fingerprintValue(artifact.readbackSha256, "sandbox artifact readback hash")
    ) throw new Error("Sandbox artifact hash readback mismatched.");
    boundedInteger(artifact.bytes, "sandbox artifact bytes", 0, 10 * 1024 * 1024);
  }
  return cloneReceipt;
}

export function parseDurableSandboxValidationReceiptV1(
  input: unknown,
  expectedAction: PreparedSandboxActionV2,
  executionReceipt: SandboxExecutionReceiptV2,
): JsonValueV1 {
  const action = parsePreparedSandboxActionV2(expectedAction);
  if (action.repairRequestId === null) {
    throw new Error("Non-validation sandbox action cannot bind a validation receipt.");
  }
  const execution = parseDurableSandboxExecutionReceiptV2(executionReceipt, action);
  const receipt = exactRecord(input, [
    "version", "kindName", "id", "operationId", "kind", "sandboxId",
    "freshSandbox", "startedAt", "completedAt", "checks", "status",
    "failureFingerprint", "binding", "fingerprint",
  ], "sandbox validation receipt");
  const binding = exactRecord(receipt.binding, [
    "requestId", "workspaceId", "profileKey", "inputWorkspaceManifestFingerprint",
    "validatedWorkspaceManifestFingerprint", "workspaceChangedPaths",
    "stagingManifestFingerprint", "stagedFiles", "importedArtifacts",
  ], "sandbox validation binding");
  const { version: _version, kindName: _kindName, id: _id, fingerprint, ...evidence } = receipt;
  const expectedKind = action.purpose === "validation_fast"
    ? "fast"
    : action.purpose === "validation_targeted"
      ? "targeted"
      : action.purpose === "validation_full"
        ? "full"
        : null;
  if (
    expectedKind === null ||
    receipt.version !== 1 ||
    receipt.kindName !== "code_validation" ||
    receipt.id !== execution.id ||
    receipt.operationId !== action.id ||
    receipt.kind !== expectedKind ||
    receipt.status !== (execution.status === "verified" ? "passed" : "failed") ||
    receipt.startedAt !== execution.startedAt ||
    receipt.completedAt !== execution.completedAt ||
    binding.requestId !== action.repairRequestId ||
    binding.workspaceId !== action.workspaceId ||
    binding.profileKey !== action.profileKey ||
    binding.inputWorkspaceManifestFingerprint !== action.workspaceManifestFingerprint ||
    binding.stagingManifestFingerprint !== sha256(action.stagingManifest) ||
    receipt.freshSandbox !== true ||
    fingerprint !== sha256(evidence)
  ) {
    throw new DurableSandboxExecutionJournalErrorV1(
      "sandbox_validation_receipt_invalid",
      "Sandbox validation receipt does not match the exact prepared action and execution evidence.",
    );
  }
  fingerprintValue(
    binding.validatedWorkspaceManifestFingerprint,
    "validated workspace manifest fingerprint",
  );
  if (!Array.isArray(binding.workspaceChangedPaths) || binding.workspaceChangedPaths.length > 100) {
    throw new Error("Validation changed paths are invalid.");
  }
  const changedPaths = binding.workspaceChangedPaths.map((path: unknown) =>
    safeRelativePath(path, "validation changed path")
  );
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new Error("Validation changed paths repeat.");
  }
  for (const key of ["stagedFiles", "importedArtifacts"] as const) {
    const entries = binding[key];
    if (!Array.isArray(entries) || entries.length > 100) throw new Error(`Validation ${key} are invalid.`);
    for (const entry of entries) {
      const artifact = exactRecord(entry, ["path", "sha256", "bytes"], `validation ${key} artifact`);
      safeRelativePath(artifact.path, `validation ${key} path`);
      fingerprintValue(artifact.sha256, `validation ${key} hash`);
      boundedInteger(artifact.bytes, `validation ${key} bytes`, 0, 10 * 1024 * 1024);
    }
    const paths = entries.map((entry) => String(entry.path));
    if (new Set(paths).size !== paths.length) throw new Error(`Validation ${key} paths repeat.`);
  }
  if (canonical(binding.stagedFiles) !== canonical(action.stagingManifest)) {
    throw new Error("Validation staged-file evidence does not match the prepared sandbox action.");
  }
  const imported = execution.importedArtifacts.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  if (canonical(binding.importedArtifacts) !== canonical(imported)) {
    throw new Error("Validation imported-artifact evidence does not match sandbox execution readback.");
  }
  if (!Array.isArray(receipt.checks) || receipt.checks.length < 1 || receipt.checks.length > 50) {
    throw new Error("Validation checks are invalid.");
  }
  for (const check of receipt.checks) {
    const record = exactRecord(check, ["label", "exitCode", "stdout", "stderr", "durationMs"], "validation check");
    boundedText(record.label, "validation label", 1, 1_000);
    boundedInteger(record.exitCode, "validation exit code", -2_147_483_648, 2_147_483_647);
    boundedText(record.stdout, "validation stdout evidence", 0, 32_000);
    boundedText(record.stderr, "validation stderr evidence", 0, 32_000);
    boundedInteger(record.durationMs, "validation duration", 0, 86_400_000);
  }
  if (typeof receipt.freshSandbox !== "boolean") throw new Error("Validation freshness is invalid.");
  if (
    (receipt.status === "passed" && receipt.failureFingerprint !== null) ||
    (receipt.status === "failed" && !SHA256.test(String(receipt.failureFingerprint)))
  ) throw new Error("Validation failure fingerprint is invalid.");
  return clone(receipt) as JsonValueV1;
}

export function parseDurableSandboxExecutionNamespaceV1(
  input: unknown,
): DurableSandboxExecutionNamespaceV1 {
  return parseNamespace(input);
}

function parseNamespace(input: unknown): DurableSandboxExecutionNamespaceV1 {
  if (input === null || input === undefined) {
    return {
      version: JOURNAL_VERSION,
      revision: 0,
      records: {},
      retirement: sealRetirement([], emptyRetirementFilterHex(), 0),
    };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("sandbox execution namespace must be an object.");
  }
  const keys = Object.keys(input as object).sort();
  const legacyKeys = ["records", "revision", "version"];
  const currentKeys = ["records", "retirement", "revision", "version"];
  const legacy = canonical(keys) === canonical(legacyKeys);
  if (!legacy && canonical(keys) !== canonical(currentKeys)) {
    throw new Error("sandbox execution namespace has unknown or missing fields.");
  }
  const namespace = input as Record<string, any>;
  if (namespace.version !== JOURNAL_VERSION) throw new Error("Unsupported sandbox execution journal version.");
  boundedInteger(namespace.revision, "sandbox namespace revision", 0, Number.MAX_SAFE_INTEGER);
  if (!namespace.records || typeof namespace.records !== "object" || Array.isArray(namespace.records)) {
    throw new Error("Sandbox execution journal records are invalid.");
  }
  const entries = Object.entries(namespace.records as Record<string, unknown>);
  if (entries.length > MAX_RECORDS) throw new Error("Sandbox execution journal exceeds its record limit.");
  const records: Record<string, DurableSandboxExecutionRecordV1> = {};
  for (const [id, value] of entries) {
    const record = parseRecord(value);
    if (id !== record.id || records[id]) throw new Error("Sandbox execution journal record key is invalid.");
    records[id] = record;
  }
  return {
    version: JOURNAL_VERSION,
    revision: namespace.revision as number,
    records,
    retirement: legacy
      ? parseLegacyRetirement(namespace.revision as number, entries.length)
      : parseRetirement(namespace.retirement),
  };
}

function parseRetirement(input: unknown): DurableSandboxExecutionRetirementV1 {
  const retirement = exactRecord(input, [
    "version", "recordIds", "filterHex", "retiredCount", "fingerprint",
  ], "sandbox execution retirement fence");
  if (retirement.version !== JOURNAL_VERSION) {
    throw new Error("Unsupported sandbox execution retirement fence version.");
  }
  if (!Array.isArray(retirement.recordIds) || retirement.recordIds.length > MAX_RETIRED_RECORD_IDS) {
    throw new Error("Sandbox execution retirement fence exceeds its identity limit.");
  }
  const recordIds = retirement.recordIds.map((id: unknown) =>
    identifier(id, "retired sandbox journal record id")
  );
  if (
    recordIds.some((id) => !id.startsWith("sandbox-execution:")) ||
    new Set(recordIds).size !== recordIds.length
  ) {
    throw new Error("Sandbox execution retirement identities are invalid.");
  }
  if (typeof retirement.filterHex !== "string" || !RETIREMENT_FILTER_HEX.test(retirement.filterHex)) {
    throw new Error("Sandbox execution retirement accumulator is invalid.");
  }
  const retiredCount = boundedInteger(
    retirement.retiredCount,
    "sandbox execution retired identity count",
    recordIds.length,
    Number.MAX_SAFE_INTEGER,
  );
  for (const id of recordIds) {
    if (!retirementFilterIncludes(retirement.filterHex, id)) {
      throw new Error("Sandbox execution retirement accumulator omits a retained identity.");
    }
  }
  const result: DurableSandboxExecutionRetirementV1 = {
    version: JOURNAL_VERSION,
    recordIds,
    filterHex: retirement.filterHex,
    retiredCount,
    fingerprint: fingerprintValue(
      retirement.fingerprint,
      "sandbox execution retirement fingerprint",
    ),
  };
  const { fingerprint, ...evidence } = result;
  if (fingerprint !== sha256(evidence)) {
    throw new Error("Sandbox execution retirement fingerprint is invalid.");
  }
  return result;
}

function parseLegacyRetirement(
  revision: number,
  recordCount: number,
): DurableSandboxExecutionRetirementV1 {
  if (revision !== 0 || recordCount !== 0) {
    throw new Error(
      "Legacy sandbox execution journal history cannot be migrated without a durable replay fence.",
    );
  }
  return sealRetirement([], emptyRetirementFilterHex(), 0);
}

function parseRecord(input: unknown): DurableSandboxExecutionRecordV1 {
  const record = exactRecord(input, [
    "version", "id", "revision", "runId", "action", "status", "preparedAt",
    "dispatchStartedAt", "receiptRecordedAt", "committedAt", "updatedAt",
    "receipt", "validationReceipt", "notAppliedProof", "fingerprint",
  ], "sandbox execution journal record");
  if (record.version !== JOURNAL_VERSION) throw new Error("Unsupported sandbox journal record version.");
  const action = parsePreparedSandboxActionV2(record.action);
  const result: DurableSandboxExecutionRecordV1 = {
    version: JOURNAL_VERSION,
    id: identifier(record.id, "sandbox journal record id"),
    revision: boundedInteger(record.revision, "sandbox record revision", 0, Number.MAX_SAFE_INTEGER),
    runId: identifier(record.runId, "sandbox journal run id"),
    action,
    status: enumValue(record.status, [
      "prepared", "dispatch_uncertain", "execution_verified", "committed", "not_applied",
    ] as const, "sandbox journal status"),
    preparedAt: isoTimestamp(record.preparedAt, "sandbox journal preparedAt"),
    dispatchStartedAt: nullableTimestamp(record.dispatchStartedAt, "sandbox journal dispatchStartedAt"),
    receiptRecordedAt: nullableTimestamp(record.receiptRecordedAt, "sandbox journal receiptRecordedAt"),
    committedAt: nullableTimestamp(record.committedAt, "sandbox journal committedAt"),
    updatedAt: isoTimestamp(record.updatedAt, "sandbox journal updatedAt"),
    receipt: record.receipt === null
      ? null
      : parseDurableSandboxExecutionReceiptV2(record.receipt, action),
    validationReceipt: null,
    notAppliedProof: record.notAppliedProof === null
      ? null
      : parseNotAppliedProof(record.notAppliedProof, action),
    fingerprint: fingerprintValue(record.fingerprint, "sandbox journal record fingerprint"),
  };
  if (record.validationReceipt !== null) {
    if (!result.receipt) throw new Error("Validation receipt has no sandbox execution evidence.");
    result.validationReceipt = parseDurableSandboxValidationReceiptV1(
      record.validationReceipt,
      action,
      result.receipt,
    );
  }
  assertRecordState(result);
  const { fingerprint, ...evidence } = result;
  if (fingerprint !== sha256(evidence)) throw new Error("Sandbox journal record fingerprint is invalid.");
  if (result.id !== recordId(result.runId, result.action)) throw new Error("Sandbox journal record identity is invalid.");
  return result;
}

function assertRecordState(record: DurableSandboxExecutionRecordV1): void {
  const hasDispatch = record.dispatchStartedAt !== null;
  const hasReceipt = record.receipt !== null && record.receiptRecordedAt !== null;
  const hasValidation = record.validationReceipt !== null;
  const hasCommit = record.committedAt !== null;
  const hasNotApplied = record.notAppliedProof !== null;
  if (Date.parse(record.updatedAt) < Date.parse(record.preparedAt)) {
    throw new Error("Sandbox journal update predates preparation.");
  }
  if (
    (record.dispatchStartedAt !== null && Date.parse(record.dispatchStartedAt) < Date.parse(record.preparedAt)) ||
    (record.receiptRecordedAt !== null && (
      record.dispatchStartedAt === null ||
      Date.parse(record.receiptRecordedAt) < Date.parse(record.dispatchStartedAt)
    )) ||
    (record.committedAt !== null && (
      record.receiptRecordedAt === null ||
      Date.parse(record.committedAt) < Date.parse(record.receiptRecordedAt)
    )) ||
    (record.notAppliedProof !== null && Date.parse(record.notAppliedProof.checkedAt) < Date.parse(record.preparedAt))
  ) throw new Error("Sandbox journal evidence timestamps are out of order.");
  if (record.status === "prepared" && (hasDispatch || hasReceipt || hasValidation || hasCommit || hasNotApplied)) {
    throw new Error("Prepared sandbox journal record contains later-stage evidence.");
  }
  if (record.status === "dispatch_uncertain" && (!hasDispatch || hasReceipt || hasValidation || hasCommit || hasNotApplied)) {
    throw new Error("Uncertain sandbox dispatch record is inconsistent.");
  }
  if (record.status === "execution_verified" && (!hasDispatch || !hasReceipt || hasValidation || hasCommit || hasNotApplied || record.action.repairRequestId === null)) {
    throw new Error("Verified sandbox execution record is inconsistent.");
  }
  if (record.status === "committed" && (!hasDispatch || !hasReceipt || !hasCommit || hasNotApplied || (record.action.repairRequestId !== null) !== hasValidation)) {
    throw new Error("Committed sandbox journal record is inconsistent.");
  }
  if (record.status === "not_applied" && (hasDispatch || hasReceipt || hasValidation || hasCommit || !hasNotApplied)) {
    throw new Error("Not-applied sandbox journal record is inconsistent.");
  }
}

function parseNotAppliedProof(input: unknown, action: PreparedSandboxActionV2): SandboxNotAppliedProofV2 {
  const proof = exactRecord(input, [
    "actionId", "actionFingerprint", "checkedAt", "fingerprint",
  ], "sandbox not-applied proof");
  const result = {
    actionId: identifier(proof.actionId, "not-applied action id"),
    actionFingerprint: fingerprintValue(proof.actionFingerprint, "not-applied action fingerprint"),
    checkedAt: isoTimestamp(proof.checkedAt, "not-applied checkedAt"),
    fingerprint: fingerprintValue(proof.fingerprint, "not-applied proof fingerprint"),
  };
  const { fingerprint, ...evidence } = result;
  if (
    result.actionId !== action.id ||
    result.actionFingerprint !== action.payloadFingerprint ||
    fingerprint !== sha256(evidence)
  ) throw new Error("Sandbox not-applied proof does not match the prepared action.");
  return result;
}

function parseScope(input: {
  runId: string;
  action: PreparedSandboxActionV2;
}): { runId: string; action: PreparedSandboxActionV2 } {
  return {
    runId: identifier(input.runId, "sandbox journal run id"),
    action: parsePreparedSandboxActionV2(input.action),
  };
}

function requiredRecord(
  namespace: DurableSandboxExecutionNamespaceV1,
  runId: string,
  action: PreparedSandboxActionV2,
): DurableSandboxExecutionRecordV1 {
  const id = recordId(runId, action);
  const record = namespace.records[id];
  if (!record) {
    if (isRetiredRecordId(namespace.retirement, id)) throw replayBlocked(id);
    throw new DurableSandboxExecutionJournalErrorV1(
      "sandbox_journal_prepared_missing",
      "Sandbox dispatch is blocked because its durable prepared journal record is absent.",
    );
  }
  assertRecordBinding(record, runId, action);
  return record;
}

function replayBlocked(id: string): DurableSandboxExecutionJournalErrorV1 {
  return new DurableSandboxExecutionJournalErrorV1(
    "sandbox_journal_replay_blocked",
    `Sandbox action ${id} is behind the durable retirement fence and cannot be prepared or dispatched again.`,
  );
}

function assertRecordBinding(
  record: DurableSandboxExecutionRecordV1,
  runId: string,
  action: PreparedSandboxActionV2,
): void {
  if (
    record.runId !== runId ||
    canonical(record.action) !== canonical(action) ||
    record.id !== recordId(runId, action)
  ) {
    throw new DurableSandboxExecutionJournalErrorV1(
      "sandbox_journal_binding",
      "Sandbox journal record does not match the exact run and prepared action.",
    );
  }
}

function recordId(runId: string, action: PreparedSandboxActionV2): string {
  return `sandbox-execution:${sha256({ runId, actionFingerprint: action.payloadFingerprint }).slice(7, 47)}`;
}

function pruneOldestTerminalRecords(
  namespace: DurableSandboxExecutionNamespaceV1,
  requiredSlots: number,
): {
  namespace: DurableSandboxExecutionNamespaceV1;
  recordIds: string[];
} {
  const terminals = Object.values(namespace.records)
    .filter((record) => record.status === "committed" || record.status === "not_applied")
    .sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.preparedAt.localeCompare(right.preparedAt) ||
      left.id.localeCompare(right.id)
    );
  if (terminals.length < requiredSlots) {
    throw new DurableSandboxExecutionJournalErrorV1(
      "sandbox_journal_capacity",
      `Sandbox execution journal is limited to ${MAX_RECORDS} records and all retained records may still require reconciliation.`,
    );
  }
  const recordIds = terminals.slice(0, requiredSlots).map((record) => record.id);
  const records = { ...namespace.records };
  for (const id of recordIds) delete records[id];
  return {
    namespace: {
      ...namespace,
      records,
      retirement: retireRecordIds(namespace.retirement, recordIds),
    },
    recordIds,
  };
}

function retireRecordIds(
  current: DurableSandboxExecutionRetirementV1,
  recordIds: readonly string[],
): DurableSandboxExecutionRetirementV1 {
  const filter = retirementFilterBytes(current.filterHex);
  const retained = [...current.recordIds];
  const retainedSet = new Set(retained);
  let retiredCount = current.retiredCount;
  if (recordIds.length > Number.MAX_SAFE_INTEGER - retiredCount) {
    throw new DurableSandboxExecutionJournalErrorV1(
      "sandbox_journal_capacity",
      "Sandbox execution retirement counter is exhausted; new action preparation is blocked.",
    );
  }
  for (const id of recordIds) {
    for (const index of retirementFilterIndexes(id)) {
      filter[Math.floor(index / 8)]! |= 1 << (index % 8);
    }
    if (!retainedSet.has(id)) {
      retained.push(id);
      retainedSet.add(id);
    }
    retiredCount += 1;
  }
  return sealRetirement(
    retained.slice(-MAX_RETIRED_RECORD_IDS),
    Buffer.from(filter).toString("hex"),
    retiredCount,
  );
}

function isRetiredRecordId(
  retirement: DurableSandboxExecutionRetirementV1,
  id: string,
): boolean {
  return retirement.recordIds.includes(id) || retirementFilterIncludes(retirement.filterHex, id);
}

function sealRetirement(
  recordIds: readonly string[],
  filterHex: string,
  retiredCount: number,
): DurableSandboxExecutionRetirementV1 {
  const evidence = {
    version: JOURNAL_VERSION,
    recordIds: [...recordIds],
    filterHex,
    retiredCount,
  };
  return { ...evidence, fingerprint: sha256(evidence) };
}

function emptyRetirementFilterHex(): string {
  return "0".repeat(RETIREMENT_FILTER_BYTES * 2);
}

function retirementFilterBytes(filterHex: string): Uint8Array {
  if (!RETIREMENT_FILTER_HEX.test(filterHex)) {
    throw new Error("Sandbox execution retirement accumulator is invalid.");
  }
  return Uint8Array.from(Buffer.from(filterHex, "hex"));
}

function retirementFilterIncludes(filterHex: string, id: string): boolean {
  const filter = retirementFilterBytes(filterHex);
  return retirementFilterIndexes(id).every((index) =>
    (filter[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0
  );
}

function retirementFilterIndexes(id: string): number[] {
  const digest = createHash("sha256")
    .update(`sandbox-execution-retirement-v1:${id}`, "utf8")
    .digest();
  return Array.from({ length: RETIREMENT_FILTER_HASHES }, (_, index) =>
    digest.readUInt32BE(index * 4) % RETIREMENT_FILTER_BITS
  );
}

function replaceRecord(
  current: DurableSandboxExecutionRecordV1,
  patch: Partial<Omit<DurableSandboxExecutionRecordV1, "version" | "id" | "revision" | "runId" | "action" | "fingerprint">>,
): DurableSandboxExecutionRecordV1 {
  const { fingerprint: _fingerprint, ...evidence } = current;
  return sealRecord({
    ...evidence,
    ...patch,
    revision: current.revision + 1,
  });
}

function sealRecord(
  evidence: Omit<DurableSandboxExecutionRecordV1, "fingerprint">,
): DurableSandboxExecutionRecordV1 {
  const cloned = clone(evidence);
  return { ...cloned, fingerprint: sha256(cloned) };
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(input as object).sort();
  const expected = [...keys].sort();
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${label} has unknown or missing fields.`);
  }
  return input as Record<string, any>;
}

function identifier(input: unknown, label: string): string {
  if (typeof input !== "string" || !IDENTIFIER.test(input)) {
    throw new Error(`${label} is not a bounded identifier.`);
  }
  return input;
}

function fingerprintValue(input: unknown, label: string): string {
  if (typeof input !== "string" || !SHA256.test(input)) {
    throw new Error(`${label} is not a canonical SHA-256 fingerprint.`);
  }
  return input;
}

function boundedInteger(input: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    throw new Error(`${label} is outside its bounded integer range.`);
  }
  return input as number;
}

function boundedText(input: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof input !== "string" || input.length < minimum || input.length > maximum || /[\0\r\n]/u.test(input)) {
    throw new Error(`${label} is invalid.`);
  }
  return input;
}

function isoTimestamp(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  ) throw new Error(`${label} is not a canonical ISO timestamp.`);
  return input;
}

function nullableTimestamp(input: unknown, label: string): string | null {
  return input === null ? null : isoTimestamp(input, label);
}

function safeRelativePath(input: unknown, label: string): string {
  const path = boundedText(input, label, 1, 2_048);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`${label} is unsafe.`);
  return path;
}

function enumValue<const T extends readonly string[]>(
  input: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof input !== "string" || !allowed.includes(input)) {
    throw new Error(`${label} is invalid.`);
  }
  return input as T[number];
}

function sha256(input: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(input), "utf8").digest("hex")}`;
}

function canonical(input: unknown): string {
  return canonicalJson(input);
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}
