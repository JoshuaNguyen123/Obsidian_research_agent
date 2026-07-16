import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadOrPrepareExtensionStateMigration,
  prepareLegacyExtensionMigration,
  prepareNewInstallExtensionState,
} from "../src/extensions/legacyExtensionMigration";
import {
  loadOrPreparePluginDataV3Migration,
  parsePluginDataV3MigrationRecord,
  parseSupportedSettingsSchemaVersion,
} from "../src/extensions/pluginDataV3Migration";
import { createRepositoryProfileRegistry } from "../src/agent/repositories/RepositoryProfile";

const MIGRATED_AT = "2026-07-11T22:30:00.000Z";

describe("pluginDataV3Migration", () => {
  it("accepts only known schemas, treating a missing version as schema 1", () => {
    assert.equal(parseSupportedSettingsSchemaVersion(undefined), 1);
    assert.equal(parseSupportedSettingsSchemaVersion(1), 1);
    assert.equal(parseSupportedSettingsSchemaVersion(2), 2);
    assert.equal(parseSupportedSettingsSchemaVersion(3), 3);
    assert.equal(parseSupportedSettingsSchemaVersion(4), 4);

    for (const malformed of [null, "3", 0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => parseSupportedSettingsSchemaVersion(malformed),
        /supported integer schemas/i,
      );
    }
    assert.throws(
      () => parseSupportedSettingsSchemaVersion(5),
      /unsupported future settings schema 5/i,
    );
  });

  it("upgrades explicit and implicit schema-1 data through the extension handoff", async () => {
    for (const rawData of [
      { settingsSchemaVersion: 1, companionBaseUrl: "http://127.0.0.1:8765" },
      { companionBaseUrl: "http://127.0.0.1:8765" },
    ]) {
      const extension = await loadOrPrepareExtensionStateMigration({
        rawData,
        preparedAt: MIGRATED_AT,
        retainedReleaseIds: ["0.3.0", "0.4.0"],
      });
      const pluginData = loadOrPreparePluginDataV3Migration({
        rawData,
        normalizedSettings: normalizedSettings(),
        extensionStateMigration: extension.plan,
        migratedAt: MIGRATED_AT,
      });
      assert.equal(pluginData.record.sourceSettingsSchemaVersion, 1);
      assert.equal(pluginData.record.pluginDataSchemaVersion, 3);
      assert.equal(extension.plan.mode, "legacy_v2");
    }
  });

  it("persists strict, tamper-evident dispositions without copying secrets or unrelated data", async () => {
    const repositoryProfiles = createRepositoryProfileRegistry();
    const rawData = {
      settingsSchemaVersion: 2,
      repositoryProfileRegistry: repositoryProfiles,
      linearApiKey: "lin_api_secret-do-not-copy",
      unrelatedDurableState: { keep: true },
    };
    const before = structuredClone(rawData);
    const extensionStateMigration = await prepareLegacyExtensionMigration({
      sourceData: rawData,
      preparedAt: MIGRATED_AT,
      retainedReleaseIds: ["0.3.0", "0.4.0"],
    });

    const loaded = loadOrPreparePluginDataV3Migration({
      rawData,
      normalizedSettings: normalizedSettings({
        ollamaApiKey: "ollama-secret-do-not-copy",
      }),
      extensionStateMigration,
      migratedAt: MIGRATED_AT,
    });

    assert.equal(loaded.needsPersistence, true);
    assert.equal(loaded.record.sourceSettingsSchemaVersion, 2);
    assert.deepEqual(loaded.record.dispositions.settings, {
      owner: "core",
      strategy: "eager",
      fromVersion: 2,
      toVersion: 4,
      verification: "normalized_target_hashed",
      targetHash: loaded.record.dispositions.settings.targetHash,
    });
    assert.deepEqual(loaded.record.dispositions.missionLedger, {
      owner: "core",
      strategy: "lazy_verified_read_write",
      version: 2,
    });
    assert.deepEqual(loaded.record.dispositions.runtimeSnapshot, {
      owner: "core",
      strategy: "lazy_verified_read_write",
      version: 2,
    });
    assert.equal(
      loaded.record.dispositions.repositoryProfile.owner,
      "agentic-researcher-code",
    );
    assert.equal(
      loaded.record.dispositions.repositoryProfile.strategy,
      "hash_copied",
    );
    assert.equal(
      loaded.record.dispositions.repositoryProfile.sourceHash,
      loaded.record.dispositions.repositoryProfile.copiedHash,
    );
    assert.deepEqual(loaded.record.dispositions.extensionState, {
      owner: "extension_namespaces",
      strategy: "transactional",
      version: 1,
      migrationId: extensionStateMigration.migrationId,
    });
    assert.deepEqual(rawData, before, "migration must not mutate source data");
    const persisted = JSON.stringify(loaded.record);
    assert.doesNotMatch(persisted, /lin_api_secret|ollama-secret|unrelatedDurableState/);
    assert.ok(Object.isFrozen(loaded.record));
    assert.ok(Object.isFrozen(loaded.record.dispositions));
    assert.deepEqual(parsePluginDataV3MigrationRecord(loaded.record), loaded.record);

    const differentSecrets = loadOrPreparePluginDataV3Migration({
      rawData,
      normalizedSettings: normalizedSettings({
        ollamaApiKey: "a-completely-different-secret",
      }),
      extensionStateMigration,
      migratedAt: MIGRATED_AT,
    });
    assert.equal(
      differentSecrets.record.dispositions.settings.targetHash,
      loaded.record.dispositions.settings.targetHash,
      "migration proof must not fingerprint credential values",
    );
  });

  it("hashes the JSON-persistable settings projection when optional fields are undefined", async () => {
    const extensionStateMigration = await prepareNewInstallExtensionState({
      preparedAt: MIGRATED_AT,
    });
    const withUndefined = loadOrPreparePluginDataV3Migration({
      rawData: {},
      normalizedSettings: normalizedSettings({
        optionalScalar: undefined,
        nested: { retained: true, omitted: undefined },
        list: ["kept", undefined],
      }),
      extensionStateMigration,
      migratedAt: MIGRATED_AT,
    });
    const persistedProjection = loadOrPreparePluginDataV3Migration({
      rawData: {},
      normalizedSettings: normalizedSettings({
        nested: { retained: true },
        list: ["kept", null],
      }),
      extensionStateMigration,
      migratedAt: MIGRATED_AT,
    });

    assert.equal(
      withUndefined.record.dispositions.settings.targetHash,
      persistedProjection.record.dispositions.settings.targetHash,
    );
  });

  it("is idempotent on restart and rejects future schema before trusting existing migrations", async () => {
    const extensionStateMigration = await prepareNewInstallExtensionState({
      preparedAt: MIGRATED_AT,
    });
    const first = loadOrPreparePluginDataV3Migration({
      rawData: { settingsSchemaVersion: 3 },
      normalizedSettings: normalizedSettings(),
      extensionStateMigration,
      migratedAt: MIGRATED_AT,
    });

    const resumed = loadOrPreparePluginDataV3Migration({
      rawData: {
        settingsSchemaVersion: 3,
        pluginDataV3Migration: first.record,
        extensionStateMigration,
        unrelatedDurableState: { changedSinceMigration: true },
      },
      normalizedSettings: normalizedSettings({ ollamaApiKey: "later-value" }),
      extensionStateMigration,
      migratedAt: "2026-07-12T00:00:00.000Z",
    });
    assert.equal(resumed.needsPersistence, false);
    assert.deepEqual(resumed.record, first.record);

    assert.throws(
      () =>
        loadOrPreparePluginDataV3Migration({
          rawData: {
            settingsSchemaVersion: 5,
            pluginDataV3Migration: first.record,
            extensionStateMigration,
          },
          normalizedSettings: normalizedSettings(),
          extensionStateMigration,
          migratedAt: "2026-07-12T00:00:00.000Z",
        }),
      /unsupported future settings schema 5/i,
    );
    assert.throws(
      () =>
        loadOrPreparePluginDataV3Migration({
          rawData: {
            settingsSchemaVersion: "3",
            pluginDataV3Migration: first.record,
            extensionStateMigration,
          },
          normalizedSettings: normalizedSettings(),
          extensionStateMigration,
          migratedAt: "2026-07-12T00:00:00.000Z",
        }),
      /supported integer schemas/i,
    );
  });

  it("rejects disposition tampering, unknown persisted fields, and repository copy drift", async () => {
    const extensionStateMigration = await prepareNewInstallExtensionState({
      preparedAt: MIGRATED_AT,
    });
    const loaded = loadOrPreparePluginDataV3Migration({
      rawData: {},
      normalizedSettings: normalizedSettings(),
      extensionStateMigration,
      migratedAt: MIGRATED_AT,
    });
    const tampered = structuredClone(loaded.record) as Record<string, any>;
    tampered.dispositions.missionLedger.owner = "extension";
    assert.throws(
      () => parsePluginDataV3MigrationRecord(tampered),
      /mission ledger migration disposition is invalid/i,
    );

    const unknown = structuredClone(loaded.record) as Record<string, any>;
    unknown.untrusted = true;
    assert.throws(
      () => parsePluginDataV3MigrationRecord(unknown),
      /persisted migration keys are invalid/i,
    );

    assert.throws(
      () =>
        loadOrPreparePluginDataV3Migration({
          rawData: {
            settingsSchemaVersion: 2,
            repositoryProfileRegistry: {
              schemaVersion: 1,
              profiles: {},
              injected: true,
            },
          },
          normalizedSettings: normalizedSettings(),
          extensionStateMigration,
          migratedAt: MIGRATED_AT,
        }),
      /repository profile copy does not match/i,
    );
  });
});

function normalizedSettings(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    settingsSchemaVersion: 4,
    modelProvider: "ollama",
    ollamaApiKey: "",
    ...extra,
  };
}
