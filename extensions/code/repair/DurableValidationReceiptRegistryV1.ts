import { sha256Fingerprint } from "../../../packages/headless-runtime/src/canonicalize";
import {
  parsePreparedSandboxActionV2,
  type PreparedSandboxActionV2,
  type SandboxExecutionReceiptV2,
  type SandboxValidationDiagnosticsV1,
} from "../sandbox/SandboxManager";
import type { ValidationReceiptRegistryV1 } from "./CodeRepairToolRuntimeV1";
import { parseBoundCodeValidationReceiptV1 } from "./codeRepairCoordinator";
import {
  CODE_REPAIR_RECEIPT_VERSION,
  type CodeValidationReceiptV1,
  type ValidationKindV1,
} from "./types";

const REGISTRY_VERSION = 1 as const;
const MAX_RECEIPTS = 512;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export interface ValidationReceiptScopeV1 {
  runId: string;
  workspaceId: string;
  requestId: string;
}

export interface DurableValidationReceiptRecordV1 {
  version: 1;
  scope: ValidationReceiptScopeV1;
  profileKey: string;
  projectId: string;
  commandId: string;
  workspaceManifestFingerprint: string;
  sandboxActionFingerprint: string;
  sandboxReceiptFingerprint: string;
  capturedAt: string;
  validation: CodeValidationReceiptV1;
}

export interface DurableValidationReceiptNamespaceV1 {
  version: typeof REGISTRY_VERSION;
  revision: number;
  receipts: Record<string, DurableValidationReceiptRecordV1>;
}

export interface ValidationReceiptPersistenceV1 {
  readNamespace(): Promise<DurableValidationReceiptNamespaceV1 | null | undefined>;
  writeNamespace(
    next: DurableValidationReceiptNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean>;
}

/**
 * Durable bridge from sandbox receipts to repair-validation receipts. Capture
 * requires an explicit request scope; it never infers request identity from a
 * prompt, active tab, default branch, or model output.
 */
export class DurableValidationReceiptRegistryV1
  implements ValidationReceiptRegistryV1
{
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: ValidationReceiptPersistenceV1,
    private readonly now: () => Date = () => new Date(),
  ) {}

  capture(input: {
    scope: ValidationReceiptScopeV1;
    action: PreparedSandboxActionV2;
    receipt: SandboxExecutionReceiptV2;
    diagnostics: SandboxValidationDiagnosticsV1;
    validatedWorkspaceManifestFingerprint: string;
    workspaceChangedPaths: string[];
  }): Promise<CodeValidationReceiptV1> {
    return this.serialized(async () => {
      const scope = parseScope(input.scope);
      const action = parsePreparedSandboxActionV2(input.action);
      const receipt = await parseSandboxReceipt(input.receipt);
      const diagnostics = parseDiagnostics(input.diagnostics);
      const kind = validationKind(action.purpose);
      if (action.workspaceId !== scope.workspaceId) {
        throw new DurableValidationReceiptErrorV1(
          "validation_scope_mismatch",
          "Sandbox action workspace does not match the explicit repair scope.",
        );
      }
      if (action.repairRequestId !== scope.requestId) {
        throw new DurableValidationReceiptErrorV1(
          "validation_request_mismatch",
          "Sandbox action repair request does not match the explicit durable receipt scope.",
        );
      }
      if (receipt.actionId !== action.id) {
        throw new DurableValidationReceiptErrorV1(
          "validation_action_mismatch",
          "Sandbox receipt does not belong to the prepared sandbox action.",
        );
      }
      if (
        diagnostics.stdoutSha256 !== receipt.stdoutSha256 ||
        diagnostics.stderrSha256 !== receipt.stderrSha256 ||
        diagnostics.stdoutBytes !== receipt.stdoutBytes ||
        diagnostics.stderrBytes !== receipt.stderrBytes
      ) {
        throw new DurableValidationReceiptErrorV1(
          "validation_diagnostics_mismatch",
          "Redacted validation diagnostics do not match the sandbox receipt.",
        );
      }
      if (
        receipt.profileKey !== action.profileKey ||
        receipt.projectId !== action.projectId ||
        receipt.commandId !== action.commandId ||
        receipt.purpose !== action.purpose ||
        receipt.commandFingerprint !== await sha256Fingerprint(action.command) ||
        receipt.stagingManifestFingerprint !== await sha256Fingerprint(action.stagingManifest) ||
        receipt.boundaryProbeFingerprint !== action.probeFingerprint
      ) {
        throw new DurableValidationReceiptErrorV1(
          "validation_source_mismatch",
          "Sandbox receipt no longer matches its closed action, command, staging, or boundary proof.",
        );
      }
      const validatedWorkspaceManifestFingerprint = fingerprint(
        input.validatedWorkspaceManifestFingerprint,
        "validated workspace manifest fingerprint",
      );
      const workspaceChangedPaths = normalizePaths(input.workspaceChangedPaths);
      const validation = await toValidationReceipt(
        action,
        receipt,
        kind,
        scope,
        validatedWorkspaceManifestFingerprint,
        workspaceChangedPaths,
        diagnostics,
      );
      const record: DurableValidationReceiptRecordV1 = {
        version: 1,
        scope,
        profileKey: action.profileKey,
        projectId: action.projectId,
        commandId: action.commandId,
        workspaceManifestFingerprint: action.workspaceManifestFingerprint,
        sandboxActionFingerprint: action.payloadFingerprint,
        sandboxReceiptFingerprint: receipt.fingerprint,
        capturedAt: this.timestamp(),
        validation,
      };
      const namespace = await parseNamespace(await this.persistence.readNamespace());
      const existing = namespace.receipts[validation.id];
      if (existing) {
        if (await sha256Fingerprint(existing) !== await sha256Fingerprint(record)) {
          throw new DurableValidationReceiptErrorV1(
            "validation_receipt_conflict",
            `Validation receipt ${validation.id} is already bound to different durable evidence.`,
          );
        }
        return cloneJson(existing.validation);
      }
      if (Object.keys(namespace.receipts).length >= MAX_RECEIPTS) {
        throw new DurableValidationReceiptErrorV1(
          "validation_registry_capacity",
          `Validation receipt registry is limited to ${MAX_RECEIPTS} records.`,
        );
      }
      const next: DurableValidationReceiptNamespaceV1 = {
        version: REGISTRY_VERSION,
        revision: namespace.revision + 1,
        receipts: { ...namespace.receipts, [validation.id]: record },
      };
      if (!await this.persistence.writeNamespace(cloneJson(next), namespace.revision)) {
        throw new DurableValidationReceiptErrorV1(
          "validation_registry_conflict",
          `Validation registry no longer has revision ${namespace.revision}.`,
        );
      }
      const readback = await parseNamespace(await this.persistence.readNamespace());
      const stored = readback.receipts[validation.id];
      if (!stored || await sha256Fingerprint(stored) !== await sha256Fingerprint(record)) {
        throw new DurableValidationReceiptErrorV1(
          "validation_registry_readback_failed",
          "Persisted validation receipt failed exact readback verification.",
        );
      }
      return cloneJson(stored.validation);
    });
  }

  readValidation(input: {
    receiptId: string;
    runId: string;
    workspaceId: string;
    requestId: string;
    expectedAction?: PreparedSandboxActionV2;
  }): Promise<CodeValidationReceiptV1 | null> {
    return this.serialized(async () => {
      const receiptId = identifier(input.receiptId, "validation receipt id");
      const requestedScope = parseScope(input);
      const namespace = await parseNamespace(await this.persistence.readNamespace());
      const record = namespace.receipts[receiptId];
      if (!record) return null;
      if (!sameScope(record.scope, requestedScope)) return null;
      if (input.expectedAction) {
        const action = parsePreparedSandboxActionV2(input.expectedAction);
        if (
          record.sandboxActionFingerprint !== action.payloadFingerprint ||
          record.workspaceManifestFingerprint !== action.workspaceManifestFingerprint ||
          record.profileKey !== action.profileKey ||
          record.projectId !== action.projectId ||
          record.commandId !== action.commandId ||
          record.validation.binding?.stagingManifestFingerprint !==
            await sha256Fingerprint(action.stagingManifest)
        ) {
          throw new DurableValidationReceiptErrorV1(
            "validation_action_binding_mismatch",
            "Persisted validation receipt is not bound to the exact prepared sandbox action.",
          );
        }
      }
      return cloneJson(record.validation);
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private timestamp(): string {
    const value = this.now().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new Error("Host clock is invalid.");
    return value;
  }
}

export class DurableValidationReceiptErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DurableValidationReceiptErrorV1";
  }
}

async function toValidationReceipt(
  action: PreparedSandboxActionV2,
  receipt: SandboxExecutionReceiptV2,
  kind: ValidationKindV1,
  scope: ValidationReceiptScopeV1,
  validatedWorkspaceManifestFingerprint: string,
  workspaceChangedPaths: string[],
  diagnostics: SandboxValidationDiagnosticsV1,
): Promise<CodeValidationReceiptV1> {
  const status = receipt.status === "verified" && receipt.exitCode === 0
    ? "passed" as const
    : "failed" as const;
  if (
    (receipt.status === "verified") !== (receipt.exitCode === 0)
  ) {
    throw new DurableValidationReceiptErrorV1(
      "validation_status_invalid",
      "Sandbox receipt status disagrees with its process exit code.",
    );
  }
  const checks = [{
    label: `${action.projectId}:${action.commandId}`,
    exitCode: receipt.exitCode,
    stdout: `sha256=${receipt.stdoutSha256};bytes=${receipt.stdoutBytes}`,
    stderr: `sha256=${receipt.stderrSha256};bytes=${receipt.stderrBytes}`,
    durationMs: Math.max(
      0,
      Math.min(86_400_000, Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt)),
    ),
  }];
  const failureFingerprint = status === "failed"
    ? await sha256Fingerprint({
        kind,
        profileKey: action.profileKey,
        projectId: action.projectId,
        commandId: action.commandId,
        exitCode: receipt.exitCode,
        signal: semanticFailureSignal(diagnostics),
      })
    : null;
  const evidence = {
    operationId: receipt.actionId,
    kind,
    sandboxId: `sandbox-${receipt.provider}-${action.payloadFingerprint.slice(7, 31)}`,
    freshSandbox: true,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    checks,
    status,
    failureFingerprint,
    binding: {
      requestId: scope.requestId,
      workspaceId: scope.workspaceId,
      profileKey: action.profileKey,
      inputWorkspaceManifestFingerprint: action.workspaceManifestFingerprint,
      validatedWorkspaceManifestFingerprint,
      workspaceChangedPaths,
      stagingManifestFingerprint: receipt.stagingManifestFingerprint,
      stagedFiles: action.stagingManifest.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      importedArtifacts: receipt.importedArtifacts.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    },
  };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kindName: "code_validation",
    id: receipt.id,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

function normalizePaths(input: string[]): string[] {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Workspace changed paths are invalid.");
  const paths = [...new Set(input.map((value) => {
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Workspace changed path is unsafe.");
    }
    return value;
  }))].sort();
  if (paths.length !== input.length) throw new Error("Workspace changed paths repeat.");
  return paths;
}

async function parseSandboxReceipt(
  input: SandboxExecutionReceiptV2,
): Promise<SandboxExecutionReceiptV2> {
  const record = cloneJson(input);
  const exactKeys = [
    "version", "id", "actionId", "provider", "profileKey", "projectId",
    "commandId", "purpose", "status", "exitCode", "commandFingerprint",
    "stagingManifestFingerprint", "boundaryProbeFingerprint", "stdoutSha256",
    "stderrSha256", "stdoutBytes", "stderrBytes", "importedArtifacts",
    "authorizationGrantId", "startedAt", "completedAt", "fingerprint",
  ];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Sandbox receipt must be an object.");
  }
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(exactKeys.sort())) {
    throw new Error("Sandbox receipt has unknown or missing fields.");
  }
  if (record.version !== 1) throw new Error("Unsupported sandbox receipt version.");
  for (const [label, value] of [
    ["id", record.id], ["actionId", record.actionId], ["profileKey", record.profileKey],
    ["projectId", record.projectId], ["commandId", record.commandId],
    ["authorizationGrantId", record.authorizationGrantId],
  ] as const) identifier(value, label);
  if (!["docker", "podman", "wsl2", "bubblewrap"].includes(record.provider)) {
    throw new Error("Sandbox receipt provider is invalid.");
  }
  if (!["validation_fast", "validation_targeted", "validation_full", "code_block", "lockfile_restore"].includes(record.purpose)) {
    throw new Error("Sandbox receipt purpose is invalid.");
  }
  if (record.status !== "verified" && record.status !== "failed") {
    throw new Error("Sandbox receipt status is invalid.");
  }
  if (!Number.isSafeInteger(record.exitCode)) throw new Error("Sandbox exit code is invalid.");
  for (const value of [
    record.commandFingerprint,
    record.stagingManifestFingerprint,
    record.boundaryProbeFingerprint,
    record.stdoutSha256,
    record.stderrSha256,
    record.fingerprint,
  ]) fingerprint(value, "sandbox fingerprint");
  for (const value of [record.stdoutBytes, record.stderrBytes]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 32 * 1024 * 1024) {
      throw new Error("Sandbox output byte count is invalid.");
    }
  }
  if (!Array.isArray(record.importedArtifacts) || record.importedArtifacts.length > 100) {
    throw new Error("Sandbox imported artifact list is invalid.");
  }
  const importedPaths = new Set<string>();
  for (const artifact of record.importedArtifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      JSON.stringify(Object.keys(artifact).sort()) !==
        JSON.stringify(["bytes", "path", "readbackSha256", "sha256"])
    ) {
      throw new Error("Sandbox imported artifact evidence is invalid.");
    }
    const path = normalizePaths([artifact.path])[0];
    if (importedPaths.has(path)) throw new Error("Sandbox imported artifact paths repeat.");
    importedPaths.add(path);
    fingerprint(artifact.sha256, "sandbox artifact hash");
    fingerprint(artifact.readbackSha256, "sandbox artifact readback hash");
    if (
      artifact.sha256 !== artifact.readbackSha256 ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > 10 * 1024 * 1024
    ) throw new Error("Sandbox imported artifact readback evidence is invalid.");
  }
  if (
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isFinite(Date.parse(record.completedAt)) ||
    Date.parse(record.completedAt) < Date.parse(record.startedAt)
  ) throw new Error("Sandbox receipt timestamps are invalid.");
  const { fingerprint: _ignored, ...core } = record;
  if (await sha256Fingerprint(core) !== record.fingerprint) {
    throw new DurableValidationReceiptErrorV1(
      "sandbox_receipt_fingerprint_invalid",
      "Sandbox execution receipt failed canonical fingerprint verification.",
    );
  }
  return record;
}

function parseDiagnostics(input: SandboxValidationDiagnosticsV1): SandboxValidationDiagnosticsV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.version !== 1 ||
    !SHA256.test(input.stdoutSha256) ||
    !SHA256.test(input.stderrSha256) ||
    !Number.isSafeInteger(input.stdoutBytes) ||
    input.stdoutBytes < 0 ||
    !Number.isSafeInteger(input.stderrBytes) ||
    input.stderrBytes < 0 ||
    typeof input.truncated !== "boolean" ||
    !Number.isSafeInteger(input.redactedLines) ||
    input.redactedLines < 0
  ) throw new Error("Transient validation diagnostics are invalid.");
  return { ...input };
}

/**
 * Preserve only redacted, receipt-bound metadata for unchanged-failure loop
 * detection. Child-process output never crosses this boundary.
 */
function semanticFailureSignal(input: SandboxValidationDiagnosticsV1): string {
  return [
    `stdout=${input.stdoutSha256};bytes=${input.stdoutBytes}`,
    `stderr=${input.stderrSha256};bytes=${input.stderrBytes}`,
    `truncated=${input.truncated}`,
    `redactedLines=${input.redactedLines}`,
  ].join("\n");
}

async function parseNamespace(
  input: DurableValidationReceiptNamespaceV1 | null | undefined,
): Promise<DurableValidationReceiptNamespaceV1> {
  if (input === null || input === undefined) {
    return { version: REGISTRY_VERSION, revision: 0, receipts: {} };
  }
  const namespace = cloneJson(input);
  if (
    namespace.version !== REGISTRY_VERSION ||
    !Number.isSafeInteger(namespace.revision) ||
    namespace.revision < 0 ||
    !namespace.receipts ||
    typeof namespace.receipts !== "object" ||
    Array.isArray(namespace.receipts) ||
    Object.keys(namespace.receipts).length > MAX_RECEIPTS
  ) throw new Error("Validation receipt namespace is invalid.");
  for (const [id, record] of Object.entries(namespace.receipts)) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([
        "capturedAt", "commandId", "profileKey", "projectId", "sandboxActionFingerprint",
        "sandboxReceiptFingerprint", "scope", "validation", "version",
        "workspaceManifestFingerprint",
      ])
    ) throw new Error("Stored validation receipt record has unknown or missing fields.");
    if (id !== identifier(record.validation.id, "stored validation receipt id")) {
      throw new Error("Validation receipt registry key mismatch.");
    }
    parseScope(record.scope);
    if (
      record.version !== 1 ||
      !Number.isFinite(Date.parse(record.capturedAt)) ||
      !SHA256.test(record.workspaceManifestFingerprint) ||
      !SHA256.test(record.sandboxActionFingerprint) ||
      !SHA256.test(record.sandboxReceiptFingerprint) ||
      !SHA256.test(record.validation.fingerprint)
    ) throw new Error("Stored validation receipt record is invalid.");
    identifier(record.profileKey, "stored validation profile key");
    identifier(record.projectId, "stored validation project id");
    identifier(record.commandId, "stored validation command id");
    await parseBoundCodeValidationReceiptV1(record.validation, {
      requestId: record.scope.requestId,
      workspaceId: record.scope.workspaceId,
      profileKey: record.profileKey,
    });
  }
  return namespace;
}

function validationKind(
  purpose: PreparedSandboxActionV2["purpose"],
): ValidationKindV1 {
  if (purpose === "validation_fast") return "fast";
  if (purpose === "validation_targeted") return "targeted";
  if (purpose === "validation_full") return "full";
  throw new DurableValidationReceiptErrorV1(
    "sandbox_receipt_not_validation",
    `Sandbox purpose ${purpose} cannot become validation proof.`,
  );
}

function parseScope(input: {
  runId: unknown;
  workspaceId: unknown;
  requestId: unknown;
}): ValidationReceiptScopeV1 {
  return {
    runId: identifier(input.runId, "runId"),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    requestId: identifier(input.requestId, "requestId"),
  };
}

function sameScope(left: ValidationReceiptScopeV1, right: ValidationReceiptScopeV1): boolean {
  return left.runId === right.runId &&
    left.workspaceId === right.workspaceId &&
    left.requestId === right.requestId;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} is not a bounded durable identifier.`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not a canonical sha256 fingerprint.`);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
