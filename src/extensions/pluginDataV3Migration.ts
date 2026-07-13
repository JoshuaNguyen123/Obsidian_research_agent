import {
  parseSupportedSettingsSchemaVersion,
  SETTINGS_SCHEMA_VERSION,
  type SupportedSettingsSchemaVersion,
} from "../agent/settingsNormalize";
import {
  canonicalJsonStringify,
  fingerprintCanonicalJson,
} from "../agent/queue/fingerprint";
import {
  parseExtensionStateMigrationPlan,
  type ExtensionStateMigrationPlanV1,
} from "./legacyExtensionMigration";

export const PLUGIN_DATA_MIGRATION_RECORD_VERSION = 1 as const;
export const MISSION_LEDGER_CONTRACT_VERSION = 2 as const;
export const MISSION_RUNTIME_SNAPSHOT_CONTRACT_VERSION = 2 as const;
export const REPOSITORY_PROFILE_CONTRACT_VERSION = 1 as const;

export {
  parseSupportedSettingsSchemaVersion,
  type SupportedSettingsSchemaVersion,
} from "../agent/settingsNormalize";

export interface PluginDataV3MigrationRecord {
  recordVersion: typeof PLUGIN_DATA_MIGRATION_RECORD_VERSION;
  pluginDataSchemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  sourceSettingsSchemaVersion: SupportedSettingsSchemaVersion;
  migratedAt: string;
  dispositions: {
    settings: {
      owner: "core";
      strategy: "eager";
      fromVersion: SupportedSettingsSchemaVersion;
      toVersion: typeof SETTINGS_SCHEMA_VERSION;
      verification: "normalized_target_hashed";
      targetHash: string;
    };
    missionLedger: {
      owner: "core";
      strategy: "lazy_verified_read_write";
      version: typeof MISSION_LEDGER_CONTRACT_VERSION;
    };
    runtimeSnapshot: {
      owner: "core";
      strategy: "lazy_verified_read_write";
      version: typeof MISSION_RUNTIME_SNAPSHOT_CONTRACT_VERSION;
    };
    repositoryProfile: {
      owner: "agentic-researcher-code";
      strategy: "hash_copied";
      version: typeof REPOSITORY_PROFILE_CONTRACT_VERSION;
      source: "legacy_core" | "canonical_default";
      sourceHash: string;
      copiedHash: string;
      verification: "verified";
    };
    extensionState: {
      owner: "extension_namespaces";
      strategy: "transactional";
      version: 1;
      migrationId: string;
    };
  };
  integrityHash: string;
}

export interface LoadOrPreparePluginDataV3MigrationInput {
  rawData: unknown;
  normalizedSettings: unknown;
  extensionStateMigration: ExtensionStateMigrationPlanV1;
  migratedAt: string;
}

export interface LoadedPluginDataV3Migration {
  record: PluginDataV3MigrationRecord;
  needsPersistence: boolean;
}

/**
 * Validate the settings boundary before any persisted migration shortcut is
 * trusted. A missing version is the original schema-1 representation.
 */
export function loadOrPreparePluginDataV3Migration(
  input: LoadOrPreparePluginDataV3MigrationInput,
): LoadedPluginDataV3Migration {
  const inputRecord = expectRecord(input, "Plugin data migration input");
  assertExactKeys(inputRecord, [
    "rawData",
    "normalizedSettings",
    "extensionStateMigration",
    "migratedAt",
  ]);
  const rawData = expectRecord(input.rawData, "Plugin data");

  // This check intentionally precedes parsing either persisted migration.
  const observedSettingsSchema = parseSupportedSettingsSchemaVersion(
    rawData.settingsSchemaVersion,
  );
  const extensionMigration = parseExtensionStateMigrationPlan(
    input.extensionStateMigration,
  );

  if (hasOwn(rawData, "pluginDataV3Migration")) {
    if (observedSettingsSchema !== SETTINGS_SCHEMA_VERSION) {
      throw new Error(
        "Persisted plugin data migration requires settingsSchemaVersion 3.",
      );
    }
    const record = parsePluginDataV3MigrationRecord(
      rawData.pluginDataV3Migration,
    );
    if (
      record.dispositions.extensionState.migrationId !==
      extensionMigration.migrationId
    ) {
      throw new Error(
        "Plugin data and extension-state migration identifiers do not match.",
      );
    }
    return { record, needsPersistence: false };
  }

  const migratedAt = expectIsoTimestamp(input.migratedAt, "migration time");
  const normalizedSettings = expectRecord(
    canonicalClone(omitUndefinedObjectProperties(input.normalizedSettings)),
    "Normalized settings",
  );
  if (
    parseSupportedSettingsSchemaVersion(
      normalizedSettings.settingsSchemaVersion,
    ) !== SETTINGS_SCHEMA_VERSION
  ) {
    throw new Error("Normalized settings must target settings schema 3.");
  }

  const copiedRepositoryProfiles =
    extensionMigration.namespaces.code.snapshot.repositoryProfiles;
  const hasRepositorySource =
    hasOwn(rawData, "repositoryProfileRegistry") &&
    rawData.repositoryProfileRegistry !== null &&
    rawData.repositoryProfileRegistry !== undefined;
  const repositorySource = hasRepositorySource
    ? rawData.repositoryProfileRegistry
    : copiedRepositoryProfiles;
  const sourceHash = fingerprintCanonicalJson(repositorySource);
  const copiedHash = fingerprintCanonicalJson(copiedRepositoryProfiles);
  if (sourceHash !== copiedHash) {
    throw new Error(
      "Repository profile copy does not match the legacy core source hash.",
    );
  }

  const payload: Omit<PluginDataV3MigrationRecord, "integrityHash"> = {
    recordVersion: PLUGIN_DATA_MIGRATION_RECORD_VERSION,
    pluginDataSchemaVersion: SETTINGS_SCHEMA_VERSION,
    sourceSettingsSchemaVersion: observedSettingsSchema,
    migratedAt,
    dispositions: {
      settings: {
        owner: "core",
        strategy: "eager",
        fromVersion: observedSettingsSchema,
        toVersion: SETTINGS_SCHEMA_VERSION,
        verification: "normalized_target_hashed",
        // A migration proof must not become a stable credential oracle. Hash
        // only the recursively redacted settings projection; raw secrets stay
        // in their legacy owner until SecretStoreV1 readback succeeds.
        targetHash: fingerprintCanonicalJson(
          redactCredentialFields(normalizedSettings),
        ),
      },
      missionLedger: {
        owner: "core",
        strategy: "lazy_verified_read_write",
        version: MISSION_LEDGER_CONTRACT_VERSION,
      },
      runtimeSnapshot: {
        owner: "core",
        strategy: "lazy_verified_read_write",
        version: MISSION_RUNTIME_SNAPSHOT_CONTRACT_VERSION,
      },
      repositoryProfile: {
        owner: "agentic-researcher-code",
        strategy: "hash_copied",
        version: REPOSITORY_PROFILE_CONTRACT_VERSION,
        source: hasRepositorySource
          ? "legacy_core"
          : "canonical_default",
        sourceHash,
        copiedHash,
        verification: "verified",
      },
      extensionState: {
        owner: "extension_namespaces",
        strategy: "transactional",
        version: 1,
        migrationId: extensionMigration.migrationId,
      },
    },
  };
  const record: PluginDataV3MigrationRecord = {
    ...payload,
    integrityHash: fingerprintCanonicalJson(payload),
  };
  return {
    record: parsePluginDataV3MigrationRecord(record),
    needsPersistence: true,
  };
}

export function parsePluginDataV3MigrationRecord(
  value: unknown,
): PluginDataV3MigrationRecord {
  const record = expectRecord(
    canonicalClone(value),
    "Plugin data v3 migration record",
  );
  assertExactKeys(record, [
    "recordVersion",
    "pluginDataSchemaVersion",
    "sourceSettingsSchemaVersion",
    "migratedAt",
    "dispositions",
    "integrityHash",
  ]);
  if (record.recordVersion !== PLUGIN_DATA_MIGRATION_RECORD_VERSION) {
    throw new Error("Unsupported plugin data migration record version.");
  }
  if (record.pluginDataSchemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new Error("Plugin data migration record must target schema 3.");
  }
  const sourceSettingsSchemaVersion = parseSupportedSettingsSchemaVersion(
    record.sourceSettingsSchemaVersion,
  );
  const migratedAt = expectIsoTimestamp(record.migratedAt, "migration time");
  const dispositions = parseDispositions(
    record.dispositions,
    sourceSettingsSchemaVersion,
  );
  const integrityHash = expectFingerprint(
    record.integrityHash,
    "migration integrity hash",
  );
  const parsed: PluginDataV3MigrationRecord = {
    recordVersion: PLUGIN_DATA_MIGRATION_RECORD_VERSION,
    pluginDataSchemaVersion: SETTINGS_SCHEMA_VERSION,
    sourceSettingsSchemaVersion,
    migratedAt,
    dispositions,
    integrityHash,
  };
  const { integrityHash: _ignored, ...payload } = parsed;
  if (fingerprintCanonicalJson(payload) !== integrityHash) {
    throw new Error("Plugin data migration integrity hash does not match.");
  }
  return immutableClone(parsed);
}

function parseDispositions(
  value: unknown,
  sourceSettingsSchemaVersion: SupportedSettingsSchemaVersion,
): PluginDataV3MigrationRecord["dispositions"] {
  const dispositions = expectRecord(value, "Migration dispositions");
  assertExactKeys(dispositions, [
    "settings",
    "missionLedger",
    "runtimeSnapshot",
    "repositoryProfile",
    "extensionState",
  ]);

  const settings = expectRecord(dispositions.settings, "Settings disposition");
  assertExactKeys(settings, [
    "owner",
    "strategy",
    "fromVersion",
    "toVersion",
    "verification",
    "targetHash",
  ]);
  if (
    settings.owner !== "core" ||
    settings.strategy !== "eager" ||
    settings.fromVersion !== sourceSettingsSchemaVersion ||
    settings.toVersion !== SETTINGS_SCHEMA_VERSION ||
    settings.verification !== "normalized_target_hashed"
  ) {
    throw new Error("Settings migration disposition is invalid.");
  }

  const missionLedger = parseLazyCoreDisposition(
    dispositions.missionLedger,
    "Mission ledger",
    MISSION_LEDGER_CONTRACT_VERSION,
  );
  const runtimeSnapshot = parseLazyCoreDisposition(
    dispositions.runtimeSnapshot,
    "Runtime snapshot",
    MISSION_RUNTIME_SNAPSHOT_CONTRACT_VERSION,
  );

  const repositoryProfile = expectRecord(
    dispositions.repositoryProfile,
    "Repository profile disposition",
  );
  assertExactKeys(repositoryProfile, [
    "owner",
    "strategy",
    "version",
    "source",
    "sourceHash",
    "copiedHash",
    "verification",
  ]);
  if (
    repositoryProfile.owner !== "agentic-researcher-code" ||
    repositoryProfile.strategy !== "hash_copied" ||
    repositoryProfile.version !== REPOSITORY_PROFILE_CONTRACT_VERSION ||
    (repositoryProfile.source !== "legacy_core" &&
      repositoryProfile.source !== "canonical_default") ||
    repositoryProfile.verification !== "verified"
  ) {
    throw new Error("Repository profile migration disposition is invalid.");
  }
  const repositorySourceHash = expectFingerprint(
    repositoryProfile.sourceHash,
    "repository source hash",
  );
  const repositoryCopiedHash = expectFingerprint(
    repositoryProfile.copiedHash,
    "repository copy hash",
  );
  if (repositorySourceHash !== repositoryCopiedHash) {
    throw new Error("Repository profile source and copy hashes do not match.");
  }

  const extensionState = expectRecord(
    dispositions.extensionState,
    "Extension-state disposition",
  );
  assertExactKeys(extensionState, [
    "owner",
    "strategy",
    "version",
    "migrationId",
  ]);
  if (
    extensionState.owner !== "extension_namespaces" ||
    extensionState.strategy !== "transactional" ||
    extensionState.version !== 1
  ) {
    throw new Error("Extension-state migration disposition is invalid.");
  }

  return {
    settings: {
      owner: "core",
      strategy: "eager",
      fromVersion: sourceSettingsSchemaVersion,
      toVersion: SETTINGS_SCHEMA_VERSION,
      verification: "normalized_target_hashed",
      targetHash: expectFingerprint(settings.targetHash, "settings target hash"),
    },
    missionLedger,
    runtimeSnapshot,
    repositoryProfile: {
      owner: "agentic-researcher-code",
      strategy: "hash_copied",
      version: REPOSITORY_PROFILE_CONTRACT_VERSION,
      source: repositoryProfile.source as "legacy_core" | "canonical_default",
      sourceHash: repositorySourceHash,
      copiedHash: repositoryCopiedHash,
      verification: "verified",
    },
    extensionState: {
      owner: "extension_namespaces",
      strategy: "transactional",
      version: 1,
      migrationId: expectFingerprint(
        extensionState.migrationId,
        "extension-state migration id",
      ),
    },
  };
}

function parseLazyCoreDisposition<TVersion extends 2>(
  value: unknown,
  label: string,
  version: TVersion,
): {
  owner: "core";
  strategy: "lazy_verified_read_write";
  version: TVersion;
} {
  const record = expectRecord(value, `${label} disposition`);
  assertExactKeys(record, ["owner", "strategy", "version"]);
  if (
    record.owner !== "core" ||
    record.strategy !== "lazy_verified_read_write" ||
    record.version !== version
  ) {
    throw new Error(`${label} migration disposition is invalid.`);
  }
  return { owner: "core", strategy: "lazy_verified_read_write", version };
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
  expected: readonly string[],
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !hasOwn(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Persisted migration keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}

function expectFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
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

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

/**
 * Plugin settings are persisted as JSON, where undefined object properties are
 * omitted. Project that exact behavior before canonical hashing while keeping
 * every other unsupported value fail-closed in canonicalJsonStringify.
 */
function omitUndefinedObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry === undefined ? null : omitUndefinedObjectProperties(entry),
    );
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedObjectProperties(entry)]),
  );
}

function redactCredentialFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCredentialFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /(?:api[_-]?key|token|secret|password|credential)/iu.test(key)
        ? "[redacted]"
        : redactCredentialFields(child),
    ]),
  );
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

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
