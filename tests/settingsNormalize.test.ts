import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRecommendedAutomaticDefaults,
  detectInstallKind,
  normalizeAgentSettings,
  normalizeGitHubOAuthClientIdSetting,
  parseSupportedSettingsSchemaVersion,
  SETTINGS_SCHEMA_VERSION,
} from "../src/agent/settingsNormalize";
import {
  allocateUniqueMarkdownPath,
} from "../src/agent/placeholderNoteTitle";
import {
  resolveAutonomousNoteTarget,
} from "../src/agent/autonomousNoteTarget";

describe("settingsNormalize", () => {
  it("new installs resolve to Automatic and active_or_new_note", () => {
    assert.equal(detectInstallKind({}), "new_install");
    const settings = normalizeAgentSettings({}, "new_install");
    assert.equal(settings.autonomyProfile, "automatic");
    assert.equal(settings.outputProfile, "active_or_new_note");
    assert.equal(settings.thinkingMode, "auto");
    assert.equal(settings.enableStreaming, true);
    assert.equal(settings.streamWritebackMode, "all_current_note_content_writes");
    assert.equal(settings.autoTitleOnWrite, true);
    assert.equal(settings.agenticReflexEnabled, true);
    assert.equal(settings.modelRouterMode, "authority");
    assert.equal(settings.modelRouterEnabled, true);
    assert.equal(settings.settingsSchemaVersion, SETTINGS_SCHEMA_VERSION);
  });

  it("legacy explicit false values resolve to Custom and remain false", () => {
    const settings = normalizeAgentSettings(
      {
        enableStreaming: false,
        streamWritebackMode: "off",
        autoTitleOnWrite: false,
        ollamaApiKey: "secret-key",
      },
      "existing_install",
    );
    assert.equal(settings.autonomyProfile, "custom");
    assert.equal(settings.enableStreaming, false);
    assert.equal(settings.streamWritebackMode, "off");
    assert.equal(settings.autoTitleOnWrite, false);
    assert.equal(settings.ollamaApiKey, "secret-key");
  });

  it("malformed streaming flags normalize without losing credentials", () => {
    const settings = normalizeAgentSettings(
      {
        enableStreaming: "yes",
        streamWritebackMode: "bogus",
        autoTitleOnWrite: "nope",
        openAiCompatibleApiKey: "sk-test",
        linearDefaultTeamId: "team-1",
      },
      "existing_install",
    );
    assert.equal(typeof settings.enableStreaming, "boolean");
    assert.ok(
      settings.streamWritebackMode === "off" ||
        settings.streamWritebackMode === "all_current_note_content_writes",
    );
    assert.equal(settings.openAiCompatibleApiKey, "sk-test");
    assert.equal(settings.linearDefaultTeamId, "team-1");
  });

  it("recommended defaults action moves Custom to Automatic", () => {
    const custom = normalizeAgentSettings(
      {
        enableStreaming: false,
        streamWritebackMode: "off",
        autoTitleOnWrite: false,
        thinkingMode: "high",
        agenticReflexEnabled: false,
        ollamaApiKey: "keep-me",
      },
      "existing_install",
    );
    const recommended = applyRecommendedAutomaticDefaults(custom);
    assert.equal(recommended.autonomyProfile, "automatic");
    assert.equal(recommended.outputProfile, "active_or_new_note");
    assert.equal(recommended.thinkingMode, "auto");
    assert.equal(recommended.enableStreaming, true);
    assert.equal(recommended.streamWritebackMode, "all_current_note_content_writes");
    assert.equal(recommended.autoTitleOnWrite, true);
    assert.equal(recommended.agenticReflexEnabled, true);
    assert.equal(recommended.modelRouterMode, "authority");
    assert.equal(recommended.modelRouterEnabled, true);
    assert.equal(recommended.ollamaApiKey, "keep-me");
  });

  it("automatic profile normalizes thinking mode, streaming, and reflex defaults", () => {
    const settings = normalizeAgentSettings(
      {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        autonomyProfile: "automatic",
        outputProfile: "active_or_new_note",
        thinkingMode: "off",
        enableStreaming: false,
        streamWritebackMode: "off",
        autoTitleOnWrite: false,
        agenticReflexEnabled: false,
      },
      "existing_install",
    );
    assert.equal(settings.autonomyProfile, "automatic");
    assert.equal(settings.outputProfile, "active_or_new_note");
    assert.equal(settings.thinkingMode, "auto");
    assert.equal(settings.enableStreaming, true);
    assert.equal(settings.streamWritebackMode, "all_current_note_content_writes");
    assert.equal(settings.autoTitleOnWrite, true);
    assert.equal(settings.agenticReflexEnabled, true);
    assert.equal(settings.modelRouterMode, "authority");
    assert.equal(settings.modelRouterEnabled, true);
  });

  it("companion endpoint normalization accepts only loopback origins", () => {
    assert.equal(
      normalizeAgentSettings(
        { companionBaseUrl: "https://attacker.example" },
        "existing_install",
      ).companionBaseUrl,
      "http://127.0.0.1:8765",
    );
    assert.equal(
      normalizeAgentSettings(
        { companionBaseUrl: "http://localhost:9876/" },
        "existing_install",
      ).companionBaseUrl,
      "http://localhost:9876",
    );
    assert.equal(
      normalizeAgentSettings(
        { companionBaseUrl: "http://127.0.0.2:8765" },
        "existing_install",
      ).companionBaseUrl,
      "http://127.0.0.2:8765",
    );
    assert.equal(
      normalizeAgentSettings(
        { companionBaseUrl: "http://[::1]:8765/" },
        "existing_install",
      ).companionBaseUrl,
      "http://[::1]:8765",
    );
  });

  it("keeps GitHub defaults disabled and persists only a sanitized public OAuth client ID", () => {
    const defaults = normalizeAgentSettings({}, "new_install");
    assert.equal(defaults.githubEnabled, false);
    assert.equal(defaults.githubOAuthClientId, "");

    const configured = normalizeAgentSettings(
      {
        githubEnabled: true,
        githubOAuthClientId: "  github-client_123  ",
        githubFineGrainedPat: "github_pat_must_not_become_a_setting",
      },
      "existing_install",
    );
    assert.equal(configured.githubEnabled, true);
    assert.equal(configured.githubOAuthClientId, "github-client_123");
    assert.equal("githubFineGrainedPat" in configured, false);
    assert.equal(normalizeGitHubOAuthClientIdSetting("bad client id"), "");
    assert.equal(normalizeGitHubOAuthClientIdSetting("ab"), "");
  });

  it("Conservative keeps deterministic routing authoritative", () => {
    const settings = normalizeAgentSettings(
      {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        autonomyProfile: "conservative",
        outputProfile: "chat_first",
        modelRouterMode: "authority",
        modelRouterEnabled: true,
      },
      "existing_install",
    );
    assert.equal(settings.autonomyProfile, "conservative");
    assert.equal(settings.modelRouterMode, "off");
    assert.equal(settings.modelRouterEnabled, false);
  });

  it("Custom preserves an explicit structured-router mode", () => {
    const settings = normalizeAgentSettings(
      {
        settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
        autonomyProfile: "custom",
        outputProfile: "chat_first",
        modelRouterMode: "shadow",
        modelRouterEnabled: true,
      },
      "existing_install",
    );
    assert.equal(settings.autonomyProfile, "custom");
    assert.equal(settings.modelRouterMode, "shadow");
    assert.equal(settings.modelRouterEnabled, true);
  });

  it("accepts schemas 1 through 3 and rejects malformed or future schemas", () => {
    for (const schema of [1, 2, 3] as const) {
      const settings = normalizeAgentSettings(
        { settingsSchemaVersion: schema, ollamaApiKey: "keep-me" },
        "existing_install",
      );
      assert.equal(settings.settingsSchemaVersion, SETTINGS_SCHEMA_VERSION);
      assert.equal(settings.ollamaApiKey, "keep-me");
      assert.equal(parseSupportedSettingsSchemaVersion(schema), schema);
    }
    assert.throws(
      () =>
        normalizeAgentSettings(
          { settingsSchemaVersion: 4 },
          "existing_install",
        ),
      /unsupported future settings schema 4/i,
    );
    assert.throws(
      () =>
        normalizeAgentSettings(
          { settingsSchemaVersion: "3" },
          "existing_install",
        ),
      /supported integer schemas/i,
    );
  });
});

describe("autonomousNoteTarget path allocation", () => {
  it("allocates unique markdown paths without overwrite", () => {
    const existing = new Set(["Notes/Untitled.md"]);
    const path = allocateUniqueMarkdownPath(
      "Notes/Untitled.md",
      (candidate) => existing.has(candidate),
    );
    assert.equal(path, "Notes/Untitled 2.md");
  });

  it("prefers explicit folder then vault root", () => {
    const fakeApp = {
      vault: {
        getAbstractFileByPath: () => null,
      },
      fileManager: {},
    } as never;
    const target = resolveAutonomousNoteTarget({
      app: fakeApp,
      explicitFolderOrPath: "Research",
      preferredBasename: "Untitled",
      exists: () => false,
    });
    assert.equal(target.path, "Research/Untitled.md");
    assert.equal(target.reason, "explicit_folder");
  });
});
