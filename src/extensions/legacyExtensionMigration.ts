import type { JsonValue, ResourceAction, ResourceSystem } from "../agent/actions";
import type {
  ExtensionStateMigrationOfferV1,
  ExtensionStateMigrationReadbackV1,
  ExtensionStateMigrationResultV1,
  JsonValueV1,
} from "../../packages/core-api/src";
import {
  createAuthorityGrantStoreState,
  normalizeAuthorityGrantStoreState,
  type AuthorityGrantStoreStateV1,
} from "../agent/authority/AuthorityGrantStore";
import { verifyAuthorityGrantFingerprint } from "../agent/authority/grants";
import type { AuthorityGrantV1 } from "../agent/authority/types";
import {
  canonicalJsonStringify,
  fingerprintCanonicalJson,
} from "../agent/queue/fingerprint";
import {
  createQueueDailyStartBudgetState,
  normalizeQueueDailyStartBudgetState,
  type QueueDailyStartBudgetStateV1,
} from "../agent/queue/dailyStartBudget";
import {
  createLinearQueueState,
  normalizeLinearQueueState,
} from "../agent/queue/linearQueue";
import {
  createResourceLockState,
  normalizeResourceLockState,
  type ResourceLockStateV1,
} from "../agent/queue/resourceLocks";
import type { LinearQueueStateV1 } from "../agent/queue/types";
import {
  createRepositoryProfileRegistry,
  parseRepositoryProfileRegistry,
  type RepositoryProfileRegistryV1,
} from "../agent/repositories/RepositoryProfile";
import { MAX_CODE_RUNS_PER_MISSION } from "../tools/constants";
import {
  createExternalActionReceiptLedgerState,
  parseExternalActionReceiptLedgerState,
  type ExternalActionReceiptLedgerStateV1,
} from "../integrations/linear/ExternalActionReceiptLedger";
import {
  createLinearIntegrationState,
  parseLinearIntegrationState,
  type LinearIntegrationStateV1,
} from "../integrations/linear/LinearIntegrationState";
import {
  createPendingLinearReconciliationState,
  parsePendingLinearReconciliationState,
  type PendingLinearReconciliationStateV1,
} from "../integrations/linear/PendingLinearReconciliationState";
import {
  assertNoCredentialKeys,
  assertNoCredentialMaterial,
} from "../integrations/linear/linearDurabilityValidation";

export const EXTENSION_STATE_MIGRATION_VERSION = 1 as const;
export const EXTENSION_SNAPSHOT_VERSION = 1 as const;
export const LEGACY_SETTINGS_SCHEMA_VERSION = 2 as const;
export const LEGACY_RETENTION_RELEASE_COUNT = 2 as const;

export type ExtensionNamespace = "code" | "integrations" | "companion";
export type ExtensionNamespaceMigrationStatus = "pending" | "verified";
export type LegacySecretKind = "linear_personal_api_key";

export interface CodeExtensionSnapshotV1 {
  schemaVersion: typeof EXTENSION_SNAPSHOT_VERSION;
  repositoryProfiles: RepositoryProfileRegistryV1;
  codeBudgets: {
    maxCodeRunsPerMission: number;
    workerMaxSteps: number;
    workerMaxToolCalls: number;
    workerMaxMinutes: number;
    autoMergeGreen: boolean;
  };
}

export interface IntegrationsExtensionSnapshotV1 {
  schemaVersion: typeof EXTENSION_SNAPSHOT_VERSION;
  linearSettings: {
    enabled: boolean;
    capabilityGate: 0 | 1 | 2 | 3 | 4 | 5;
    defaultTeamId: string;
    queueEnabled: boolean;
    queueProjectId: string;
    startedStateId: string;
    completedStateId: string;
    blockedStateId: string;
    scanIntervalMinutes: 15;
  };
  linearIntegrationState: LinearIntegrationStateV1;
  pendingLinearReconciliationState: PendingLinearReconciliationStateV1;
  externalActionReceiptLedger: ExternalActionReceiptLedgerStateV1;
  linearQueueState: LinearQueueStateV1 | null;
  queueResourceLockState: ResourceLockStateV1;
  queueDailyStartBudgetState: QueueDailyStartBudgetStateV1;
}

export interface CompanionExtensionSnapshotV1 {
  schemaVersion: typeof EXTENSION_SNAPSHOT_VERSION;
  baseUrl: string;
  browserToolsEnabled: boolean;
  experienceMemoryEnabled: boolean;
  defaultBrowserMissionMode: "supervised" | "extract_only";
}

export interface LegacyExtensionSourceSnapshotV1 {
  schemaVersion: typeof EXTENSION_STATE_MIGRATION_VERSION;
  legacySettingsSchemaVersion: typeof LEGACY_SETTINGS_SCHEMA_VERSION;
  code: CodeExtensionSnapshotV1;
  integrations: IntegrationsExtensionSnapshotV1;
  companion: CompanionExtensionSnapshotV1;
  /** Capability grants remain core-owned; this copy is retained read-only only. */
  retainedCoreAuthority: AuthorityGrantStoreStateV1;
  pendingSecretKinds: LegacySecretKind[];
}

export interface LegacyRetentionMetadataV1 {
  policy: "legacy_source_read_only_two_releases";
  releaseIds: [string, string];
  retainedReleaseCount: typeof LEGACY_RETENTION_RELEASE_COUNT;
  eligibleForRemovalAfterRelease: string;
  sourceSnapshotHash: string;
}

export interface ExtensionMigrationAcknowledgementV1 {
  version: typeof EXTENSION_STATE_MIGRATION_VERSION;
  migrationId: string;
  namespace: ExtensionNamespace;
  sourceSnapshotHash: string | null;
  observedSnapshotHash: string;
  acknowledgedAt: string;
}

export interface ExtensionNamespaceMigrationV1<TSnapshot> {
  namespace: ExtensionNamespace;
  status: ExtensionNamespaceMigrationStatus;
  snapshot: TSnapshot;
  snapshotHash: string;
  acknowledgement: ExtensionMigrationAcknowledgementV1 | null;
}

export interface ExtensionStateMigrationPlanV1 {
  version: typeof EXTENSION_STATE_MIGRATION_VERSION;
  mode: "legacy_v2" | "new_install";
  migrationId: string;
  preparedAt: string;
  sourceSnapshot: LegacyExtensionSourceSnapshotV1 | null;
  sourceSnapshotHash: string | null;
  retention: LegacyRetentionMetadataV1 | null;
  pendingSecretKinds: LegacySecretKind[];
  namespaces: {
    code: ExtensionNamespaceMigrationV1<CodeExtensionSnapshotV1>;
    integrations: ExtensionNamespaceMigrationV1<IntegrationsExtensionSnapshotV1>;
    companion: ExtensionNamespaceMigrationV1<CompanionExtensionSnapshotV1>;
  };
}

export interface PrepareLegacyExtensionMigrationInput {
  sourceData: unknown;
  preparedAt: string;
  /** The exact two releases for which the source remains available read-only. */
  retainedReleaseIds: readonly [string, string];
}

export interface PrepareNewInstallExtensionStateInput {
  preparedAt: string;
}

export interface LoadOrPrepareExtensionStateMigrationInput {
  rawData: unknown;
  preparedAt: string;
  retainedReleaseIds: readonly [string, string];
}

export interface SecretImportRequestV1 {
  source: "legacy_core_v2";
  kind: LegacySecretKind;
  expectedSourceSnapshotHash: string;
}

export interface SecretImportReceiptV1 {
  version: 1;
  kind: LegacySecretKind;
  secretRef: string;
  backend: string;
  readbackFingerprint: string;
  importedAt: string;
}

/**
 * Secure-store implementations live outside this pure migration module. The
 * interface deliberately contains no plaintext secret field or return value.
 */
export interface SecretImporterV1 {
  readonly version: 1;
  importLegacySecret(
    request: SecretImportRequestV1,
  ): Promise<SecretImportReceiptV1>;
}

export async function prepareLegacyExtensionMigration(
  input: PrepareLegacyExtensionMigrationInput,
): Promise<ExtensionStateMigrationPlanV1> {
  const inputRecord = expectRecord(input, "Legacy extension migration input");
  assertExactKeys(inputRecord, ["sourceData", "preparedAt", "retainedReleaseIds"]);
  const preparedAt = expectIsoTimestamp(input.preparedAt, "migration preparation time");
  const retainedReleaseIds = parseRetainedReleaseIds(input.retainedReleaseIds);
  const source = canonicalCloneRecord(input.sourceData, "legacy v2 plugin data");
  if (source.settingsSchemaVersion !== LEGACY_SETTINGS_SCHEMA_VERSION) {
    throw new Error(
      `Legacy extension migration requires settings schema ${LEGACY_SETTINGS_SCHEMA_VERSION}.`,
    );
  }

  const snapshots = await buildSnapshots(source, preparedAt);
  const retainedCoreAuthority = await parseRetainedCoreAuthority(
    source.authorityGrantStoreState,
    preparedAt,
  );
  const pendingSecretKinds = detectPendingSecretKinds(source);
  const sourceSnapshot: LegacyExtensionSourceSnapshotV1 = {
    schemaVersion: EXTENSION_STATE_MIGRATION_VERSION,
    legacySettingsSchemaVersion: LEGACY_SETTINGS_SCHEMA_VERSION,
    ...snapshots,
    retainedCoreAuthority,
    pendingSecretKinds,
  };
  assertSecretFree(sourceSnapshot, "Legacy extension source snapshot");
  const sourceSnapshotHash = fingerprintCanonicalJson(sourceSnapshot);
  const retention: LegacyRetentionMetadataV1 = {
    policy: "legacy_source_read_only_two_releases",
    releaseIds: retainedReleaseIds,
    retainedReleaseCount: LEGACY_RETENTION_RELEASE_COUNT,
    eligibleForRemovalAfterRelease: retainedReleaseIds[1],
    sourceSnapshotHash,
  };

  return createPlan({
    mode: "legacy_v2",
    preparedAt,
    sourceSnapshot,
    sourceSnapshotHash,
    retention,
    pendingSecretKinds,
    snapshots,
  });
}

/**
 * New installs have a separate entry point with no legacy-data parameter.
 * Runtime key checks reject a casted/sourceData fallback attempt as well.
 */
export async function prepareNewInstallExtensionState(
  input: PrepareNewInstallExtensionStateInput,
): Promise<ExtensionStateMigrationPlanV1> {
  const inputRecord = expectRecord(input, "New-install extension state input");
  assertExactKeys(inputRecord, ["preparedAt"]);
  const preparedAt = expectIsoTimestamp(input.preparedAt, "bootstrap preparation time");
  const snapshots = await buildSnapshots({}, preparedAt);
  return createPlan({
    mode: "new_install",
    preparedAt,
    sourceSnapshot: null,
    sourceSnapshotHash: null,
    retention: null,
    pendingSecretKinds: [],
    snapshots,
  });
}

/**
 * Runtime entry point. It accepts the one boundary-build compatibility case
 * (schema 3 persisted before the migration plan shipped) by projecting the
 * unchanged legacy-owned fields through the strict schema-2 parser. A
 * credential-only data file is also legacy state, never a new install.
 */
export async function loadOrPrepareExtensionStateMigration(
  input: LoadOrPrepareExtensionStateMigrationInput,
): Promise<{ plan: ExtensionStateMigrationPlanV1; needsPersistence: boolean }> {
  const inputRecord = expectRecord(input, "Runtime extension migration input");
  assertExactKeys(inputRecord, ["rawData", "preparedAt", "retainedReleaseIds"]);
  const preparedAt = expectIsoTimestamp(input.preparedAt, "migration preparation time");
  const retainedReleaseIds = parseRetainedReleaseIds(input.retainedReleaseIds);
  const source = canonicalCloneRecord(input.rawData, "plugin data");
  if (hasOwn(source, "extensionStateMigration")) {
    const plan = parseExtensionStateMigrationPlan(source.extensionStateMigration);
    if (
      plan.mode === "legacy_v2" &&
      canonicalJsonStringify(plan.retention?.releaseIds) !==
        canonicalJsonStringify(retainedReleaseIds)
    ) {
      throw new Error("Persisted legacy retention releases do not match this core release policy.");
    }
    return {
      plan,
      needsPersistence: false,
    };
  }

  const hasLegacyCredential =
    typeof source.linearApiKey === "string" && source.linearApiKey.trim().length > 0;
  const durableKeys = Object.keys(source).filter(
    (key) =>
      key !== "conversationHistory" &&
      key !== "linearApiKey" &&
      !key.startsWith("_"),
  );
  if (durableKeys.length === 0 && !hasLegacyCredential) {
    return {
      plan: await prepareNewInstallExtensionState({ preparedAt }),
      needsPersistence: true,
    };
  }

  const schema = source.settingsSchemaVersion;
  if (
    schema !== undefined &&
    schema !== 1 &&
    schema !== LEGACY_SETTINGS_SCHEMA_VERSION &&
    schema !== 3
  ) {
    throw new Error(
      "Existing plugin data without an extension migration plan must be schema 1, schema 2, the boundary schema 3, or credential-only legacy data.",
    );
  }
  return {
    plan: await prepareLegacyExtensionMigration({
      sourceData: {
        ...source,
        settingsSchemaVersion: LEGACY_SETTINGS_SCHEMA_VERSION,
      },
      preparedAt,
      retainedReleaseIds,
    }),
    needsPersistence: true,
  };
}

export function verifyExtensionMigrationAcknowledgement(
  planValue: ExtensionStateMigrationPlanV1,
  acknowledgementValue: ExtensionMigrationAcknowledgementV1,
): ExtensionStateMigrationPlanV1 {
  const plan = canonicalClone(planValue) as ExtensionStateMigrationPlanV1;
  assertPlanIntegrity(plan);
  const acknowledgement = parseAcknowledgement(acknowledgementValue);
  if (acknowledgement.migrationId !== plan.migrationId) {
    throw new Error("Extension migration acknowledgement belongs to another migration.");
  }
  if (acknowledgement.sourceSnapshotHash !== plan.sourceSnapshotHash) {
    throw new Error("Extension migration acknowledgement source hash does not match.");
  }
  if (Date.parse(acknowledgement.acknowledgedAt) < Date.parse(plan.preparedAt)) {
    throw new Error("Extension migration acknowledgement predates preparation.");
  }
  const namespaceState = plan.namespaces[acknowledgement.namespace];
  if (acknowledgement.observedSnapshotHash !== namespaceState.snapshotHash) {
    throw new Error("Extension migration acknowledgement snapshot hash does not match.");
  }
  if (namespaceState.status === "verified") {
    if (
      !namespaceState.acknowledgement ||
      canonicalJsonStringify(namespaceState.acknowledgement) !==
        canonicalJsonStringify(acknowledgement)
    ) {
      throw new Error(
        `Extension namespace ${acknowledgement.namespace} was already verified with a different acknowledgement.`,
      );
    }
    return immutableClone(plan);
  }

  const namespaces = canonicalClone(plan.namespaces) as ExtensionStateMigrationPlanV1["namespaces"];
  switch (acknowledgement.namespace) {
    case "code":
      namespaces.code = {
        ...namespaces.code,
        status: "verified",
        acknowledgement,
      };
      break;
    case "integrations":
      namespaces.integrations = {
        ...namespaces.integrations,
        status: "verified",
        acknowledgement,
      };
      break;
    case "companion":
      namespaces.companion = {
        ...namespaces.companion,
        status: "verified",
        acknowledgement,
      };
      break;
  }
  return immutableClone({ ...plan, namespaces });
}

export function isExtensionStateMigrationVerified(
  planValue: ExtensionStateMigrationPlanV1,
): boolean {
  const plan = canonicalClone(planValue) as ExtensionStateMigrationPlanV1;
  assertPlanIntegrity(plan);
  return Object.values(plan.namespaces).every(
    (namespace) => namespace.status === "verified",
  );
}

/** Strict parser for the plan persisted in core data.json. */
export function parseExtensionStateMigrationPlan(
  value: unknown,
): ExtensionStateMigrationPlanV1 {
  const plan = canonicalClone(value) as ExtensionStateMigrationPlanV1;
  assertPlanIntegrity(plan);
  return immutableClone(plan);
}

export function createExtensionStateMigrationOffer(
  planValue: ExtensionStateMigrationPlanV1,
  namespace: ExtensionNamespace,
): ExtensionStateMigrationOfferV1 {
  const plan = parseExtensionStateMigrationPlan(planValue);
  const state = plan.namespaces[namespace];
  return immutableClone({
    version: EXTENSION_STATE_MIGRATION_VERSION,
    migrationId: plan.migrationId,
    namespace,
    mode: plan.mode,
    preparedAt: plan.preparedAt,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    snapshotHash: state.snapshotHash,
    snapshot: canonicalClone(state.snapshot) as unknown as JsonValueV1,
    alreadyVerified: state.status === "verified",
    acknowledgedAt: state.acknowledgement?.acknowledgedAt ?? null,
    retainedReleaseIds: plan.retention
      ? ([...plan.retention.releaseIds] as [string, string])
      : null,
    pendingSecureImportKinds:
      namespace === "integrations" ? [...plan.pendingSecretKinds] : [],
  });
}

export function acceptExtensionStateMigrationReadback(
  planValue: ExtensionStateMigrationPlanV1,
  expectedNamespace: ExtensionNamespace,
  readbackValue: ExtensionStateMigrationReadbackV1,
): {
  plan: ExtensionStateMigrationPlanV1;
  result: ExtensionStateMigrationResultV1;
} {
  const plan = parseExtensionStateMigrationPlan(planValue);
  const record = expectRecord(readbackValue, "Extension migration readback");
  assertExactKeys(record, [
    "version",
    "migrationId",
    "namespace",
    "snapshot",
    "acknowledgedAt",
  ]);
  if (record.version !== EXTENSION_STATE_MIGRATION_VERSION) {
    throw new Error("Unsupported extension migration readback version.");
  }
  if (record.namespace !== expectedNamespace) {
    throw new Error("Extension cannot acknowledge another namespace.");
  }
  if (record.migrationId !== plan.migrationId) {
    throw new Error("Extension migration readback belongs to another migration.");
  }
  const acknowledgedAt = expectIsoTimestamp(
    record.acknowledgedAt,
    "extension migration readback time",
  );
  assertSecretFree(record.snapshot, "Extension migration readback snapshot");
  const observedSnapshotHash = fingerprintCanonicalJson(record.snapshot);
  const next = verifyExtensionMigrationAcknowledgement(plan, {
    version: EXTENSION_STATE_MIGRATION_VERSION,
    migrationId: plan.migrationId,
    namespace: expectedNamespace,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    observedSnapshotHash,
    acknowledgedAt,
  });
  return immutableClone({
    plan: next,
    result: {
      version: EXTENSION_STATE_MIGRATION_VERSION,
      migrationId: plan.migrationId,
      namespace: expectedNamespace,
      snapshotHash: observedSnapshotHash,
      verified: true,
      pendingSecureImportKinds:
        expectedNamespace === "integrations" ? [...plan.pendingSecretKinds] : [],
    },
  });
}

function createPlan(input: {
  mode: ExtensionStateMigrationPlanV1["mode"];
  preparedAt: string;
  sourceSnapshot: LegacyExtensionSourceSnapshotV1 | null;
  sourceSnapshotHash: string | null;
  retention: LegacyRetentionMetadataV1 | null;
  pendingSecretKinds: LegacySecretKind[];
  snapshots: {
    code: CodeExtensionSnapshotV1;
    integrations: IntegrationsExtensionSnapshotV1;
    companion: CompanionExtensionSnapshotV1;
  };
}): ExtensionStateMigrationPlanV1 {
  assertSecretFree(input.snapshots.code, "Code extension snapshot");
  assertSecretFree(input.snapshots.integrations, "Integrations extension snapshot");
  assertSecretFree(input.snapshots.companion, "Companion extension snapshot");
  const namespaces: ExtensionStateMigrationPlanV1["namespaces"] = {
    code: pendingNamespace("code", input.snapshots.code),
    integrations: pendingNamespace("integrations", input.snapshots.integrations),
    companion: pendingNamespace("companion", input.snapshots.companion),
  };
  const migrationId = fingerprintCanonicalJson({
    version: EXTENSION_STATE_MIGRATION_VERSION,
    mode: input.mode,
    preparedAt: input.preparedAt,
    sourceSnapshotHash: input.sourceSnapshotHash,
    retention: input.retention,
    namespaceHashes: namespaceHashes(namespaces),
  });
  const plan: ExtensionStateMigrationPlanV1 = {
    version: EXTENSION_STATE_MIGRATION_VERSION,
    mode: input.mode,
    migrationId,
    preparedAt: input.preparedAt,
    sourceSnapshot: input.sourceSnapshot,
    sourceSnapshotHash: input.sourceSnapshotHash,
    retention: input.retention,
    pendingSecretKinds: [...input.pendingSecretKinds],
    namespaces,
  };
  assertPlanIntegrity(plan);
  return immutableClone(plan);
}

async function buildSnapshots(
  source: Record<string, unknown>,
  preparedAt: string,
): Promise<{
  code: CodeExtensionSnapshotV1;
  integrations: IntegrationsExtensionSnapshotV1;
  companion: CompanionExtensionSnapshotV1;
}> {
  const repositoryProfiles = hasNonNull(source, "repositoryProfileRegistry")
    ? parseRepositoryProfileRegistry(source.repositoryProfileRegistry)
    : createRepositoryProfileRegistry();
  const code: CodeExtensionSnapshotV1 = {
    schemaVersion: EXTENSION_SNAPSHOT_VERSION,
    repositoryProfiles,
    codeBudgets: {
      maxCodeRunsPerMission: optionalInteger(
        source,
        "maxCodeRunsPerMission",
        1,
        64,
        MAX_CODE_RUNS_PER_MISSION,
      ),
      workerMaxSteps: optionalInteger(
        source,
        "orchestratorWorkerMaxSteps",
        4,
        30,
        20,
      ),
      workerMaxToolCalls: optionalInteger(
        source,
        "orchestratorWorkerMaxToolCalls",
        4,
        40,
        24,
      ),
      workerMaxMinutes: optionalInteger(
        source,
        "orchestratorWorkerMaxMinutes",
        1,
        30,
        15,
      ),
      autoMergeGreen: optionalBoolean(
        source,
        "orchestratorAutoMergeGreen",
        true,
      ),
    },
  };

  const integrations: IntegrationsExtensionSnapshotV1 = {
    schemaVersion: EXTENSION_SNAPSHOT_VERSION,
    linearSettings: {
      enabled: optionalBoolean(source, "linearEnabled", false),
      capabilityGate: optionalLinearGate(source.linearCapabilityGate),
      defaultTeamId: optionalOpaqueId(source, "linearDefaultTeamId"),
      queueEnabled: optionalBoolean(source, "linearQueueEnabled", false),
      queueProjectId: optionalOpaqueId(source, "linearQueueProjectId"),
      startedStateId: optionalOpaqueId(source, "linearStartedStateId"),
      completedStateId: optionalOpaqueId(source, "linearCompletedStateId"),
      blockedStateId: optionalOpaqueId(source, "linearBlockedStateId"),
      scanIntervalMinutes: optionalFixedFifteen(
        source.linearScanIntervalMinutes,
      ),
    },
    linearIntegrationState: hasNonNull(source, "linearIntegrationState")
      ? parseLinearIntegrationState(source.linearIntegrationState)
      : createLinearIntegrationState({ at: preparedAt }),
    pendingLinearReconciliationState: hasNonNull(
      source,
      "pendingLinearReconciliationState",
    )
      ? await parsePendingLinearReconciliationState(
          source.pendingLinearReconciliationState,
        )
      : createPendingLinearReconciliationState(new Date(preparedAt)),
    externalActionReceiptLedger: hasNonNull(source, "externalActionReceiptLedger")
      ? parseExternalActionReceiptLedgerState(
          source.externalActionReceiptLedger,
        )
      : createExternalActionReceiptLedgerState(new Date(preparedAt)),
    linearQueueState:
      source.linearQueueState === null ||
      !hasNonNull(source, "linearQueueState")
        ? null
        : normalizeLinearQueueState(source.linearQueueState),
    queueResourceLockState: hasNonNull(source, "queueResourceLockState")
      ? normalizeResourceLockState(source.queueResourceLockState)
      : createResourceLockState(preparedAt),
    queueDailyStartBudgetState: hasNonNull(source, "queueDailyStartBudgetState")
      ? normalizeQueueDailyStartBudgetState(source.queueDailyStartBudgetState)
      : createQueueDailyStartBudgetState({ at: preparedAt }),
  };

  const companion: CompanionExtensionSnapshotV1 = {
    schemaVersion: EXTENSION_SNAPSHOT_VERSION,
    baseUrl: optionalBaseUrl(
      source,
      "companionBaseUrl",
      "http://127.0.0.1:8765",
    ),
    browserToolsEnabled: optionalBoolean(
      source,
      "browserToolsEnabled",
      false,
    ),
    experienceMemoryEnabled: optionalBoolean(
      source,
      "experienceMemoryEnabled",
      false,
    ),
    defaultBrowserMissionMode: optionalBrowserMode(
      source.defaultBrowserMissionMode,
    ),
  };
  return { code, integrations, companion };
}

async function parseRetainedCoreAuthority(
  value: unknown,
  preparedAt: string,
): Promise<AuthorityGrantStoreStateV1> {
  if (value === undefined || value === null) {
    return createAuthorityGrantStoreState(new Date(preparedAt));
  }
  const record = expectRecord(value, "Persisted authority grant store");
  assertExactKeys(record, ["version", "revision", "grants", "updatedAt"]);
  if (!Array.isArray(record.grants)) {
    throw new Error("Persisted authority grants must be an array.");
  }
  for (const grant of record.grants) {
    assertStrictAuthorityGrant(grant);
  }
  const normalized = normalizeAuthorityGrantStoreState(record);
  if (!normalized) {
    throw new Error("Persisted authority grant store is malformed.");
  }
  for (const grant of normalized.grants) {
    if (!(await verifyAuthorityGrantFingerprint(grant))) {
      throw new Error(`Persisted authority grant ${grant.id} has an invalid fingerprint.`);
    }
  }
  return normalized;
}

function assertStrictAuthorityGrant(value: unknown): void {
  const grant = expectRecord(value, "Persisted authority grant");
  assertKeys(
    grant,
    [
      "version",
      "id",
      "kind",
      "issuer",
      "subject",
      "rules",
      "limits",
      "usage",
      "state",
      "issuedAt",
      "expiresAt",
      "authorityFingerprint",
    ],
    ["actionFingerprint", "revokedAt"],
  );
  if (grant.version !== 1) throw new Error("Persisted authority version is unsupported.");
  expectIdentifier(grant.id, "authority grant id");
  expectEnum(grant.kind, "authority kind", [
    "prompt_bound",
    "one_shot",
    "run_bounded",
    "scheduled_bounded",
  ]);
  expectEnum(grant.issuer, "authority issuer", ["user_prompt", "user_approval"]);
  expectEnum(grant.state, "authority state", [
    "active",
    "revoked",
    "expired",
    "exhausted",
  ]);
  expectFingerprint(grant.authorityFingerprint, "authority fingerprint");
  if (grant.actionFingerprint !== undefined) {
    expectFingerprint(grant.actionFingerprint, "authority action fingerprint");
  }
  const issuedAt = expectIsoTimestamp(grant.issuedAt, "authority issue time");
  const expiresAt = expectIsoTimestamp(grant.expiresAt, "authority expiry time");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new Error("Persisted authority expiry must follow issuance.");
  }
  if (grant.revokedAt !== undefined) {
    expectIsoTimestamp(grant.revokedAt, "authority revocation time");
  }

  const subject = expectRecord(grant.subject, "authority subject");
  assertExactKeys(subject, ["type", "id"]);
  expectEnum(subject.type, "authority subject type", ["run", "schedule"]);
  expectIdentifier(subject.id, "authority subject id");

  const limits = parseAuthorityCounters(grant.limits, "authority limits", false);
  const usage = parseAuthorityCounters(grant.usage, "authority usage", true);
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    if (usage[key] > limits[key]) {
      throw new Error(`Persisted authority ${key} usage exceeds its limit.`);
    }
  }
  if (
    !Array.isArray(grant.rules) ||
    grant.rules.length === 0 ||
    grant.rules.length > 64
  ) {
    throw new Error("Persisted authority grant requires 1-64 rules.");
  }
  for (const rawRule of grant.rules) {
    const rule = expectRecord(rawRule, "authority rule");
    assertExactKeys(rule, ["system", "resourceTypes", "actions", "selector"]);
    expectEnum<ResourceSystem>(rule.system, "authority system", [
      "vault",
      "web",
      "browser",
      "workspace",
      "git",
      "linear",
      "github",
    ]);
    expectUniqueStringArray(rule.resourceTypes, "authority resource types", 1);
    const actions = expectUniqueStringArray(rule.actions, "authority actions", 1);
    for (const action of actions) {
      expectEnum<ResourceAction>(action, "authority action", RESOURCE_ACTION_VALUES);
    }
    const selector = expectRecord(rule.selector, "authority selector");
    assertKeys(selector, [], AUTHORITY_SELECTOR_KEYS);
    for (const selected of Object.values(selector)) {
      expectUniqueTextArray(selected, "authority selector values", 1);
    }
  }
}

function parseAuthorityCounters(
  value: unknown,
  label: string,
  usage: boolean,
): { actions: number; externalMutations: number; creates: number; deletes: number; outboundBytes: number } {
  const record = expectRecord(value, label);
  const keys = usage
    ? ["actions", "externalMutations", "creates", "deletes", "outboundBytes"]
    : ["maxActions", "maxExternalMutations", "maxCreates", "maxDeletes", "maxOutboundBytes"];
  assertKeys(record, keys, usage ? ["lastUsedAt"] : []);
  if (usage && record.lastUsedAt !== undefined) {
    expectIsoTimestamp(record.lastUsedAt, "authority last-used time");
  }
  return {
    actions: expectSafeInteger(record[keys[0]], `${label} actions`, 0),
    externalMutations: expectSafeInteger(record[keys[1]], `${label} external mutations`, 0),
    creates: expectSafeInteger(record[keys[2]], `${label} creates`, 0),
    deletes: expectSafeInteger(record[keys[3]], `${label} deletes`, 0),
    outboundBytes: expectSafeInteger(record[keys[4]], `${label} outbound bytes`, 0),
  };
}

function detectPendingSecretKinds(
  source: Record<string, unknown>,
): LegacySecretKind[] {
  if (!hasOwn(source, "linearApiKey")) return [];
  if (typeof source.linearApiKey !== "string") {
    throw new Error("Legacy Linear credential field is malformed.");
  }
  return source.linearApiKey.trim() ? ["linear_personal_api_key"] : [];
}

function pendingNamespace<TSnapshot>(
  namespace: ExtensionNamespace,
  snapshot: TSnapshot,
): ExtensionNamespaceMigrationV1<TSnapshot> {
  return {
    namespace,
    status: "pending",
    snapshot: canonicalClone(snapshot),
    snapshotHash: fingerprintCanonicalJson(snapshot),
    acknowledgement: null,
  };
}

function assertPlanIntegrity(plan: ExtensionStateMigrationPlanV1): void {
  const record = expectRecord(plan, "Extension migration plan");
  assertExactKeys(record, [
    "version",
    "mode",
    "migrationId",
    "preparedAt",
    "sourceSnapshot",
    "sourceSnapshotHash",
    "retention",
    "pendingSecretKinds",
    "namespaces",
  ]);
  if (plan.version !== EXTENSION_STATE_MIGRATION_VERSION) {
    throw new Error("Unsupported extension migration plan version.");
  }
  expectEnum(plan.mode, "extension migration mode", ["legacy_v2", "new_install"]);
  expectIsoTimestamp(plan.preparedAt, "migration preparation time");
  expectFingerprint(plan.migrationId, "migration id");
  const namespaces = expectRecord(plan.namespaces, "extension namespaces");
  assertExactKeys(namespaces, ["code", "integrations", "companion"]);
  for (const namespace of ["code", "integrations", "companion"] as const) {
    assertNamespaceIntegrity(plan, namespace);
  }
  if (plan.mode === "legacy_v2") {
    if (!plan.sourceSnapshot || !plan.sourceSnapshotHash || !plan.retention) {
      throw new Error("Legacy migration requires source and retention metadata.");
    }
    assertSecretFree(plan.sourceSnapshot, "Legacy source snapshot");
    if (fingerprintCanonicalJson(plan.sourceSnapshot) !== plan.sourceSnapshotHash) {
      throw new Error("Legacy source snapshot hash does not match.");
    }
    if (
      plan.retention.retainedReleaseCount !== LEGACY_RETENTION_RELEASE_COUNT ||
      plan.retention.releaseIds.length !== LEGACY_RETENTION_RELEASE_COUNT ||
      plan.retention.sourceSnapshotHash !== plan.sourceSnapshotHash ||
      plan.retention.eligibleForRemovalAfterRelease !==
        plan.retention.releaseIds[1]
    ) {
      throw new Error("Legacy retention metadata is invalid.");
    }
  } else if (
    plan.sourceSnapshot !== null ||
    plan.sourceSnapshotHash !== null ||
    plan.retention !== null ||
    plan.pendingSecretKinds.length !== 0
  ) {
    throw new Error("New-install extension state cannot fall back to legacy data.");
  }
  const expectedMigrationId = fingerprintCanonicalJson({
    version: EXTENSION_STATE_MIGRATION_VERSION,
    mode: plan.mode,
    preparedAt: plan.preparedAt,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    retention: plan.retention,
    namespaceHashes: namespaceHashes(plan.namespaces),
  });
  if (expectedMigrationId !== plan.migrationId) {
    throw new Error("Extension migration id does not match its canonical payload.");
  }
}

function assertNamespaceIntegrity(
  plan: ExtensionStateMigrationPlanV1,
  namespace: ExtensionNamespace,
): void {
  const state = plan.namespaces[namespace];
  const record = expectRecord(state, `Extension namespace ${namespace}`);
  assertExactKeys(record, [
    "namespace",
    "status",
    "snapshot",
    "snapshotHash",
    "acknowledgement",
  ]);
  if (state.namespace !== namespace) {
    throw new Error(`Extension namespace ${namespace} identity does not match.`);
  }
  expectEnum(state.status, "extension namespace status", ["pending", "verified"]);
  expectFingerprint(state.snapshotHash, "extension snapshot hash");
  assertSecretFree(state.snapshot, `Extension namespace ${namespace} snapshot`);
  if (fingerprintCanonicalJson(state.snapshot) !== state.snapshotHash) {
    throw new Error(`Extension namespace ${namespace} snapshot hash does not match.`);
  }
  if (state.status === "pending" && state.acknowledgement !== null) {
    throw new Error(`Pending extension namespace ${namespace} has an acknowledgement.`);
  }
  if (state.status === "verified") {
    if (!state.acknowledgement) {
      throw new Error(`Verified extension namespace ${namespace} lacks an acknowledgement.`);
    }
    const acknowledgement = parseAcknowledgement(state.acknowledgement);
    if (
      acknowledgement.namespace !== namespace ||
      acknowledgement.migrationId !== plan.migrationId ||
      acknowledgement.sourceSnapshotHash !== plan.sourceSnapshotHash ||
      acknowledgement.observedSnapshotHash !== state.snapshotHash
    ) {
      throw new Error(`Extension namespace ${namespace} acknowledgement does not match.`);
    }
  }
}

function parseAcknowledgement(
  value: unknown,
): ExtensionMigrationAcknowledgementV1 {
  const record = expectRecord(value, "Extension migration acknowledgement");
  assertExactKeys(record, [
    "version",
    "migrationId",
    "namespace",
    "sourceSnapshotHash",
    "observedSnapshotHash",
    "acknowledgedAt",
  ]);
  if (record.version !== EXTENSION_STATE_MIGRATION_VERSION) {
    throw new Error("Unsupported extension migration acknowledgement version.");
  }
  return {
    version: EXTENSION_STATE_MIGRATION_VERSION,
    migrationId: expectFingerprint(record.migrationId, "acknowledgement migration id"),
    namespace: expectEnum<ExtensionNamespace>(
      record.namespace,
      "acknowledgement namespace",
      ["code", "integrations", "companion"],
    ),
    sourceSnapshotHash:
      record.sourceSnapshotHash === null
        ? null
        : expectFingerprint(record.sourceSnapshotHash, "acknowledgement source hash"),
    observedSnapshotHash: expectFingerprint(
      record.observedSnapshotHash,
      "acknowledgement snapshot hash",
    ),
    acknowledgedAt: expectIsoTimestamp(
      record.acknowledgedAt,
      "acknowledgement time",
    ),
  };
}

function namespaceHashes(
  namespaces: ExtensionStateMigrationPlanV1["namespaces"],
): Record<ExtensionNamespace, string> {
  return {
    code: namespaces.code.snapshotHash,
    integrations: namespaces.integrations.snapshotHash,
    companion: namespaces.companion.snapshotHash,
  };
}

function parseRetainedReleaseIds(
  value: readonly [string, string],
): [string, string] {
  if (!Array.isArray(value) || value.length !== LEGACY_RETENTION_RELEASE_COUNT) {
    throw new Error("Legacy source must be retained for exactly two release ids.");
  }
  const releaseIds = value.map((item, index) =>
    expectReleaseId(item, `retained release ${index + 1}`),
  ) as [string, string];
  if (releaseIds[0] === releaseIds[1]) {
    throw new Error("Legacy retention release ids must be distinct.");
  }
  return releaseIds;
}

function optionalInteger(
  source: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return hasOwn(source, key)
    ? expectSafeInteger(source[key], key, minimum, maximum)
    : fallback;
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  if (!hasOwn(source, key)) return fallback;
  if (typeof source[key] !== "boolean") {
    throw new Error(`${key} must be a boolean.`);
  }
  return source[key] as boolean;
}

function optionalLinearGate(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 {
  if (value === undefined) return 0;
  return expectSafeInteger(value, "linear capability gate", 0, 5) as
    | 0
    | 1
    | 2
    | 3
    | 4
    | 5;
}

function optionalOpaqueId(source: Record<string, unknown>, key: string): string {
  if (!hasOwn(source, key)) return "";
  const value = source[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(normalized)) {
    throw new Error(`${key} is invalid.`);
  }
  return normalized;
}

function optionalFixedFifteen(value: unknown): 15 {
  if (value === undefined || value === 15) return 15;
  throw new Error("Linear scan interval must be the fixed 15 minutes.");
}

function optionalBrowserMode(
  value: unknown,
): "supervised" | "extract_only" {
  if (value === undefined) return "supervised";
  return expectEnum(value, "default browser mission mode", [
    "supervised",
    "extract_only",
  ]);
}

function optionalBaseUrl(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  if (!hasOwn(source, key)) return fallback;
  if (typeof source[key] !== "string") throw new Error(`${key} must be a string.`);
  const trimmed = (source[key] as string).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`${key} must be a credential-free HTTP(S) URL.`);
  }
}

function assertSecretFree(value: unknown, label: string): void {
  const json = canonicalClone(value) as JsonValue;
  assertNoCredentialKeys(json, label);
  assertNoCredentialMaterial(json, label);
}

function canonicalCloneRecord(value: unknown, label: string): Record<string, unknown> {
  return expectRecord(canonicalClone(value), label);
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(canonicalClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
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
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  assertKeys(record, keys, []);
}

function assertKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !hasOwn(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Persisted keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}

function expectEnum<T extends string>(
  value: unknown,
  label: string,
  values: readonly T[],
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function expectUniqueStringArray(
  value: unknown,
  label: string,
  minimum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) {
    throw new Error(`${label} must contain ${minimum}-64 strings.`);
  }
  const parsed = value.map((item) => expectIdentifier(item, label));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
  return parsed;
}

function expectUniqueTextArray(
  value: unknown,
  label: string,
  minimum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 64) {
    throw new Error(`${label} must contain ${minimum}-64 strings.`);
  }
  const parsed = value.map((item) => {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(item)
    ) {
      throw new Error(`${label} contains an invalid value.`);
    }
    return item;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
  return parsed;
}

function expectIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function expectReleaseId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function expectFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function expectSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function expectIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasNonNull(record: Record<string, unknown>, key: string): boolean {
  return hasOwn(record, key) && record[key] !== null && record[key] !== undefined;
}

const AUTHORITY_SELECTOR_KEYS = [
  "accountIds",
  "workspaceIds",
  "teamIds",
  "projectIds",
  "repositoryIds",
  "repositoryProfileIds",
  "containerIds",
  "resourceIds",
  "pathPrefixes",
] as const;

const RESOURCE_ACTION_VALUES: readonly ResourceAction[] = [
  "read",
  "list",
  "search",
  "create",
  "append",
  "update",
  "replace",
  "move",
  "archive",
  "unarchive",
  "trash",
  "delete",
  "restore",
  "link",
  "unlink",
  "validate",
  "promote",
  "merge",
  "execute",
  "install",
  "commit",
  "integrate",
  "publish",
];
