import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";
import { parseRepositoryProfileV2, type RepositoryProfileV2 } from "../repositories";
import {
  parsePreparedSandboxActionV2,
  parseSandboxProviderConfigV2,
  type PreparedSandboxActionV2,
  type SandboxAuthorizationV2,
  type SandboxCapabilityStatusV2,
  type SandboxProviderConfigV2,
} from "../sandbox";
import {
  CODE_REPAIR_CHECKPOINT_VERSION,
  codeRepairCheckpointIdV1,
  type ArtifactHashReadbackV1,
  type CodeRepairCheckpointV1,
} from "../repair";
import { classifyProtectedControlChanges } from "../repair/protectedControls";

export const PREPARED_BACKGROUND_CODE_EXECUTION_PLAN_VERSION = 1 as const;
export const PREPARED_BACKGROUND_CODE_OBJECTIVE_V1 =
  "Host-prepared exact change; validate, read back, and commit only." as const;
export const PREPARED_BACKGROUND_CODE_EDIT_SUMMARY_V1 =
  "Host-prepared exact change." as const;
export const PREPARED_BACKGROUND_CODE_COMMIT_MESSAGE_V1 =
  "Validate and commit the exact host-prepared change." as const;

const DIRECTORY = "prepared-background-code-execution-v1";
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const MAX_PLAN_BYTES = 12 * 1024 * 1024;

export interface PreparedSandboxValidationStepV1 {
  action: PreparedSandboxActionV2;
  authorization: SandboxAuthorizationV2;
}

/**
 * Local-only deterministic executable state. Trusted host paths and fixed argv
 * live here, never in CompanionJobV1 or the remote coordinator database.
 */
export interface PreparedBackgroundCodeExecutionPlanV1 {
  version: typeof PREPARED_BACKGROUND_CODE_EXECUTION_PLAN_VERSION;
  kind: "prepared_background_code_execution_plan";
  id: string;
  jobId: string;
  handoffFingerprint: string;
  checkpoint: CodeRepairCheckpointV1;
  repositoryProfile: RepositoryProfileV2;
  sandboxCapabilityStatus: SandboxCapabilityStatusV2;
  sandboxProviders: SandboxProviderConfigV2[];
  targetedValidation: PreparedSandboxValidationStepV1;
  fullValidation: PreparedSandboxValidationStepV1;
  approvedArtifacts: ArtifactHashReadbackV1[];
  preparedAt: string;
  expiresAt: string;
  fingerprint: string;
}

export type PreparedBackgroundCodeExecutionPlanDraftV1 = Omit<
  PreparedBackgroundCodeExecutionPlanV1,
  "version" | "kind" | "id" | "fingerprint"
>;

export class PreparedBackgroundCodeExecutionPlanErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PreparedBackgroundCodeExecutionPlanErrorV1";
  }
}

export function createPreparedBackgroundCodeExecutionPlanV1(
  draft: PreparedBackgroundCodeExecutionPlanDraftV1,
): PreparedBackgroundCodeExecutionPlanV1 {
  const identity = fingerprintOf({
    version: 1,
    jobId: draft.jobId,
    handoffFingerprint: draft.handoffFingerprint,
    checkpointId: draft.checkpoint.id,
  });
  const evidence = normalizePlan({
    version: 1,
    kind: "prepared_background_code_execution_plan",
    id: `background-code-execution-${identity.slice(7, 39)}`,
    ...draft,
  });
  return { ...evidence, fingerprint: fingerprintOf(evidence) };
}

export function parsePreparedBackgroundCodeExecutionPlanV1(
  value: unknown,
): PreparedBackgroundCodeExecutionPlanV1 {
  const record = exactRecord(value, [
    "version", "kind", "id", "jobId", "handoffFingerprint", "checkpoint",
    "repositoryProfile", "sandboxCapabilityStatus", "sandboxProviders",
    "targetedValidation", "fullValidation", "approvedArtifacts",
    "preparedAt", "expiresAt", "fingerprint",
  ], "prepared background Code execution plan");
  const observed = sha(record.fingerprint, "execution plan fingerprint");
  const { fingerprint: _ignored, ...evidenceRecord } = record;
  const evidence = normalizePlan(evidenceRecord);
  if (observed !== fingerprintOf(evidence)) {
    fail("plan_fingerprint_invalid", "Prepared background Code execution plan fingerprint does not match its evidence.");
  }
  return { ...evidence, fingerprint: observed };
}

function normalizePlan(
  value: unknown,
): Omit<PreparedBackgroundCodeExecutionPlanV1, "fingerprint"> {
  const record = exactRecord(value, [
    "version", "kind", "id", "jobId", "handoffFingerprint", "checkpoint",
    "repositoryProfile", "sandboxCapabilityStatus", "sandboxProviders",
    "targetedValidation", "fullValidation", "approvedArtifacts",
    "preparedAt", "expiresAt",
  ], "prepared background Code execution plan evidence");
  if (record.version !== 1 || record.kind !== "prepared_background_code_execution_plan") {
    fail("plan_contract_invalid", "Unsupported prepared background Code execution plan contract.");
  }
  const checkpoint = clone(record.checkpoint as CodeRepairCheckpointV1);
  const latestAttempt = checkpoint.attempts.at(-1);
  if (
    checkpoint.version !== CODE_REPAIR_CHECKPOINT_VERSION ||
    checkpoint.id !== codeRepairCheckpointIdV1(checkpoint.request) ||
    checkpoint.requestFingerprint !== fingerprintOf(checkpoint.request) ||
    checkpoint.request.objective !== PREPARED_BACKGROUND_CODE_OBJECTIVE_V1 ||
    checkpoint.request.commitMessage !== PREPARED_BACKGROUND_CODE_COMMIT_MESSAGE_V1 ||
    checkpoint.request.maxCycles !== 1 ||
    checkpoint.request.expectedArtifacts.length !== 0 ||
    checkpoint.request.protectedControlPaths.length !== 0 ||
    !checkpoint.initialEdit ||
    checkpoint.initialEdit.summary !== PREPARED_BACKGROUND_CODE_EDIT_SUMMARY_V1 ||
    checkpoint.initialEdit.expectedArtifacts.length !== 0 ||
    checkpoint.attempts.length !== 1 ||
    checkpoint.attempts[0].cycle !== 1 ||
    !checkpoint.attempts[0].fastValidation ||
    checkpoint.attempts[0].diagnosis !== undefined ||
    checkpoint.attempts[0].repair !== undefined ||
    checkpoint.attempts[0].cycleReceipt !== undefined ||
    latestAttempt?.fastValidation?.status !== "passed" ||
    checkpoint.validationHistory.length !== 1 ||
    checkpoint.validationHistory[0].fingerprint !==
      latestAttempt.fastValidation.fingerprint ||
    checkpoint.failureHistory.length !== 0 ||
    checkpoint.approvalHistory.length !== 0 ||
    !checkpoint.previewDiff ||
    checkpoint.stage !== "diff_preview" ||
    checkpoint.targetedValidation !== undefined ||
    checkpoint.fullValidation !== undefined ||
    checkpoint.finalDiff !== undefined ||
    checkpoint.artifactReadback !== undefined ||
    checkpoint.commit !== undefined ||
    checkpoint.commitReadback !== undefined ||
    checkpoint.verifiedCommitReceipt !== undefined ||
    checkpoint.terminal !== undefined ||
    checkpoint.blocker !== undefined
  ) {
    fail(
      "plan_checkpoint_not_deterministic",
      "Background Code plans must start from a host-owned non-terminal checkpoint whose latest fast validation passed and whose exact preview diff is stable.",
    );
  }
  assertNoRawValidationOutput(checkpoint);
  const repositoryProfile = parseRepositoryProfileV2(record.repositoryProfile);
  if (
    repositoryProfile.key !== checkpoint.request.worktree.profileId ||
    !samePath(repositoryProfile.repositoryRoot, checkpoint.request.worktree.repositoryRoot)
  ) {
    fail("plan_profile_drift", "Prepared Code profile does not match the trusted checkpoint.");
  }
  const protectedDiff = classifyProtectedControlChanges(
    checkpoint.previewDiff.changedPaths,
    [
      ...checkpoint.request.protectedControlPaths,
      ...repositoryProfile.protectedControls.map((control) => control.path),
    ],
  );
  if (protectedDiff.level !== "none") {
    fail(
      "plan_protected_diff_forbidden",
      "Background Code validation/commit cannot include manifests, lockfiles, workflows, hooks, or other protected controls.",
    );
  }
  assertNoVaultPath(checkpoint.request.worktree.path);
  assertNoVaultPath(checkpoint.request.worktree.repositoryRoot);
  assertNoVaultPath(repositoryProfile.repositoryRoot);
  const sandboxCapabilityStatus = normalizeSandboxStatus(record.sandboxCapabilityStatus);
  const sandboxProviders = array(record.sandboxProviders, "sandbox providers", 1, 4)
    .map(parseSandboxProviderConfigV2);
  if (
    sandboxCapabilityStatus.mode !== "sandbox_verified" ||
    !sandboxCapabilityStatus.executionAvailable ||
    !sandboxCapabilityStatus.selectedProvider ||
    sandboxCapabilityStatus.blocker !== null ||
    !sandboxProviders.some((provider) => provider.kind === sandboxCapabilityStatus.selectedProvider)
  ) {
    fail("plan_sandbox_not_verified", "Prepared Code plan lacks a host-verified sandbox capability.");
  }
  const targetedValidation = validationStep(record.targetedValidation, "targeted");
  const fullValidation = validationStep(record.fullValidation, "full");
  for (const [step, purpose] of [[targetedValidation, "validation_targeted"], [fullValidation, "validation_full"]] as const) {
    if (
      step.action.purpose !== purpose ||
      step.action.workspaceId !== checkpoint.request.worktree.id ||
      step.action.repairRequestId !== checkpoint.request.id ||
      step.action.profileKey !== repositoryProfile.key ||
      step.action.provider !== sandboxCapabilityStatus.selectedProvider ||
      step.action.network.mode !== "disabled" ||
      step.action.expectedArtifacts.length !== 0
    ) {
      fail("plan_validation_scope_drift", "Prepared validation action escaped the deterministic Code plan scope.");
    }
  }
  if (
    fingerprintOf(targetedValidation.action.stagingManifest) !==
      fingerprintOf(fullValidation.action.stagingManifest)
  ) {
    fail("plan_staging_drift", "Targeted and full validation must use the same exact staged bytes.");
  }
  const approvedArtifacts = array(record.approvedArtifacts, "approved artifacts", 1, 100)
    .map((artifact) => normalizeArtifact(artifact));
  if (
    approvedArtifacts.length !== checkpoint.previewDiff.files.filter((file) => file.afterSha256 !== null).length ||
    checkpoint.previewDiff.files.some((file) =>
      file.afterSha256 !== null &&
      !approvedArtifacts.some((artifact) => artifact.path === file.path && artifact.sha256 === file.afterSha256)
    )
  ) {
    fail("plan_artifact_drift", "Approved artifact hashes do not cover the exact prepared diff.");
  }
  const preparedAt = timestamp(record.preparedAt, "preparedAt");
  const expiresAt = timestamp(record.expiresAt, "expiresAt");
  if (
    Date.parse(expiresAt) <= Date.parse(preparedAt) ||
    Date.parse(targetedValidation.action.expiresAt) < Date.parse(expiresAt) ||
    Date.parse(fullValidation.action.expiresAt) < Date.parse(expiresAt)
  ) {
    fail("plan_expiry_invalid", "Prepared Code plan expiry exceeds its exact sandbox action authority.");
  }
  return {
    version: 1,
    kind: "prepared_background_code_execution_plan",
    id: identifier(record.id, "execution plan id"),
    jobId: identifier(record.jobId, "job id"),
    handoffFingerprint: sha(record.handoffFingerprint, "handoff fingerprint"),
    checkpoint,
    repositoryProfile,
    sandboxCapabilityStatus,
    sandboxProviders,
    targetedValidation,
    fullValidation,
    approvedArtifacts,
    preparedAt,
    expiresAt,
  };
}

export class PreparedBackgroundCodeExecutionPlanStoreV1 {
  readonly root: string;

  constructor(readonly applicationDataRoot: string) {
    if (!path.isAbsolute(applicationDataRoot)) fail("unsafe_application_root", "Execution-plan storage requires an absolute application-data root.");
    const resolved = path.resolve(applicationDataRoot);
    if (resolved === path.parse(resolved).root || hasVaultSegment(resolved)) fail("unsafe_application_root", "Execution plans cannot use a root or vault path.");
    this.applicationDataRoot = resolved;
    this.root = path.join(resolved, DIRECTORY);
  }

  async persist(value: PreparedBackgroundCodeExecutionPlanV1): Promise<PreparedBackgroundCodeExecutionPlanV1> {
    const plan = parsePreparedBackgroundCodeExecutionPlanV1(value);
    if (Date.parse(plan.expiresAt) <= Date.now()) fail("plan_expired", "Prepared Code execution plan is expired.");
    await this.ensureRoot();
    const finalPath = this.file(plan.fingerprint);
    await this.assertStorageBoundary(finalPath, true);
    const existing = await this.read(finalPath, true);
    if (existing) {
      if (existing.fingerprint !== plan.fingerprint) fail("plan_conflict", "Prepared Code execution plan identity is already bound to different evidence.");
      return existing;
    }
    const bytes = Buffer.from(canonicalJson(plan), "utf8");
    if (bytes.byteLength > MAX_PLAN_BYTES) fail("plan_too_large", "Prepared Code execution plan exceeds 12 MiB.");
    const temporary = `${finalPath}.${randomUUID()}.tmp`;
    await this.assertStorageBoundary(temporary, true);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.assertStorageBoundary(finalPath, true);
      await fs.rename(temporary, finalPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    const readback = await this.read(finalPath, false);
    if (!readback || readback.fingerprint !== plan.fingerprint) fail("plan_readback_failed", "Prepared Code execution plan failed exact readback.");
    return readback;
  }

  async load(
    fingerprint: string,
    options: { allowExpiredForReconciliation?: boolean } = {},
  ): Promise<PreparedBackgroundCodeExecutionPlanV1> {
    const expected = sha(fingerprint, "execution plan fingerprint");
    await this.ensureRoot();
    const plan = await this.read(this.file(expected), true);
    if (!plan) fail("plan_not_found", "Prepared Code execution plan is unavailable from local application data.");
    if (plan.fingerprint !== expected) fail("plan_fingerprint_invalid", "Prepared Code execution plan path and fingerprint disagree.");
    if (!options.allowExpiredForReconciliation && Date.parse(plan.expiresAt) <= Date.now()) fail("plan_expired", "Prepared Code execution plan is expired.");
    return plan;
  }

  private file(fingerprint: string): string {
    return path.join(this.root, `${sha(fingerprint, "execution plan fingerprint").slice(7)}.json`);
  }

  private async read(file: string, missingOkay: boolean): Promise<PreparedBackgroundCodeExecutionPlanV1 | null> {
    await this.assertStorageBoundary(file, missingOkay);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && missingOkay) return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_PLAN_BYTES) fail("plan_file_invalid", "Prepared Code execution plan storage is linked, unsafe, or oversized.");
    return parsePreparedBackgroundCodeExecutionPlanV1(JSON.parse(await fs.readFile(file, "utf8")));
  }

  private async ensureRoot(): Promise<void> {
    await this.assertParentChain(this.applicationDataRoot);
    await fs.mkdir(this.applicationDataRoot, { recursive: true, mode: 0o700 });
    await this.assertStorageBoundary(this.applicationDataRoot, false);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertStorageBoundary(this.root, false);
  }

  private async assertParentChain(candidate: string): Promise<void> {
    let cursor = path.resolve(candidate);
    while (true) {
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) fail("plan_reparse_path", "Prepared Code execution-plan storage rejects symlinks, junctions, and reparse points.");
      if (stat?.isFile() && stat.nlink !== 1) fail("plan_reparse_path", "Prepared Code execution-plan storage rejects hard-linked files.");
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  private async assertStorageBoundary(candidate: string, allowMissing: boolean): Promise<void> {
    const resolved = path.resolve(candidate);
    if (!isWithin(this.applicationDataRoot, resolved)) fail("plan_path_escape", "Prepared Code execution-plan path escaped application data.");
    let cursor = resolved;
    while (true) {
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (allowMissing && error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) fail("plan_reparse_path", "Prepared Code execution-plan storage rejects symlinks, junctions, and reparse points.");
      if (cursor === this.applicationDataRoot) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || !isWithin(this.applicationDataRoot, parent)) break;
      cursor = parent;
      allowMissing = true;
    }
  }
}

function validationStep(value: unknown, label: string): PreparedSandboxValidationStepV1 {
  const record = exactRecord(value, ["action", "authorization"], `${label} validation step`);
  const action = parsePreparedSandboxActionV2(record.action);
  const authorization = exactRecord(record.authorization, ["preparedActionId", "payloadFingerprint", "grantId"], `${label} validation authorization`);
  if (
    authorization.preparedActionId !== action.id ||
    authorization.payloadFingerprint !== action.payloadFingerprint ||
    typeof authorization.grantId !== "string" ||
    !IDENTIFIER.test(authorization.grantId)
  ) fail("plan_validation_authority_drift", `${label} validation authorization is not bound to its action.`);
  return { action, authorization: authorization as unknown as SandboxAuthorizationV2 };
}

function normalizeSandboxStatus(value: unknown): SandboxCapabilityStatusV2 {
  const status = clone(value as SandboxCapabilityStatusV2);
  if (!status || status.version !== 1 || status.editingAvailable !== true || !Array.isArray(status.providers)) fail("plan_sandbox_status_invalid", "Sandbox capability status is invalid.");
  return status;
}

function normalizeArtifact(value: unknown): ArtifactHashReadbackV1 {
  const record = exactRecord(value, ["path", "sha256", "bytes"], "approved artifact");
  if (typeof record.path !== "string" || !record.path || record.path.includes("\\") || record.path.startsWith("/") || record.path.split("/").some((part) => !part || part === "." || part === "..")) fail("plan_artifact_invalid", "Approved artifact path is unsafe.");
  if (!Number.isSafeInteger(record.bytes) || Number(record.bytes) < 0 || Number(record.bytes) > 10 * 1024 * 1024) fail("plan_artifact_invalid", "Approved artifact byte count is invalid.");
  return { path: record.path, sha256: sha(record.sha256, "approved artifact hash"), bytes: Number(record.bytes) };
}

function assertNoRawValidationOutput(checkpoint: CodeRepairCheckpointV1): void {
  for (const receipt of checkpoint.validationHistory) {
    for (const check of receipt.checks) {
      if (!/^sha256=sha256:[0-9a-f]{64};bytes=\d+$/u.test(check.stdout) || !/^sha256=sha256:[0-9a-f]{64};bytes=\d+$/u.test(check.stderr)) fail("raw_validation_output_forbidden", "Local background plans may persist validation hashes only, not raw diagnostics.");
    }
  }
}

function assertNoVaultPath(value: string): void {
  if (!path.isAbsolute(value) || hasVaultSegment(value)) fail("vault_path_forbidden", "Prepared background Code plans cannot reference an Obsidian vault path.");
}

function hasVaultSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((part) => part.toLowerCase() === ".obsidian" || /(?:^|[_ -])vault(?:$|[_ -])/iu.test(part));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/u, "").toLowerCase() === path.resolve(right).replace(/[\\/]+$/u, "").toLowerCase();
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function array(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("plan_contract_invalid", `${label} is invalid.`);
  return value;
}

function exactRecord<const T extends readonly string[]>(value: unknown, keys: T, label: string): Record<T[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("plan_contract_invalid", `${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("plan_contract_invalid", `${label} does not match its closed contract.`);
  return record as Record<T[number], unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("plan_contract_invalid", `${label} is invalid.`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("plan_contract_invalid", `${label} is not a SHA-256 fingerprint.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail("plan_contract_invalid", `${label} is not a canonical timestamp.`);
  return value;
}

function fingerprintOf(value: unknown): string {
  return `sha256:${portableSha256Text(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail("plan_contract_invalid", "Execution plan contains an unsafe number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") fail("plan_contract_invalid", "Execution plan contains an unsupported value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fail(code: string, message: string): never {
  throw new PreparedBackgroundCodeExecutionPlanErrorV1(code, message);
}
